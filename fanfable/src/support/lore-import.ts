/**
 * Canon import.
 *
 * Moved mechanically from lore.ts; imports only, no logic change.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { Db, nowIso, strList } from '../core/db.ts';
import { chunkText, titleFromPath, trimFrontBackMatter, wordCount } from '../core/text.ts';
import { importFile, readTextFile, type ImportedText } from '../support/importer.ts';
import type { SourceInfo } from '../answer/lore.ts';

/* --------------------------------------------------------------- importing */

/**
 * Import a source file.
 *
 * Plain text and Markdown are read synchronously. PDF, EPUB and DOCX need
 * external tools or archive parsing, so use `importSourceAsync` for those.
 */
export function importSource(
  db: Db,
  projectId: number,
  filePath: string,
  opts: { title?: string; author?: string; maxWords?: number; overwrite?: boolean } = {},
): { source: SourceInfo; chunks: number; replaced: boolean; trimmed?: { headPages: number; tailPages: number } } {
  return storeSource(db, projectId, filePath, readTextFile(filePath), opts);
}

/** Import any supported format, including PDF, EPUB and DOCX. */
export async function importSourceAsync(
  db: Db,
  projectId: number,
  filePath: string,
  opts: { title?: string; author?: string; maxWords?: number; overwrite?: boolean } = {},
): Promise<{ source: SourceInfo; chunks: number; replaced: boolean; trimmed?: { headPages: number; tailPages: number } }> {
  const imported = await importFile(filePath);
  return storeSource(db, projectId, filePath, imported, opts);
}

function storeSource(
  db: Db,
  projectId: number,
  filePath: string,
  imported: ImportedText,
  opts: { title?: string; author?: string; maxWords?: number; overwrite?: boolean },
): { source: SourceInfo; chunks: number; replaced: boolean; trimmed?: { headPages: number; tailPages: number } } {
  const raw = imported.text;
  const sha = createHash('sha256').update(raw).digest('hex');
  const title = opts.title ?? imported.title ?? titleFromPath(filePath);

  const existing = db.get<{ id: number }>(
    'SELECT id FROM canon_source WHERE project_id = ? AND path = ?',
    projectId,
    filePath,
  );
  if (existing && !opts.overwrite) {
    const row = db.get<RowSource>('SELECT * FROM canon_source WHERE id = ?', existing.id)!;
    return {
      source: {
        id: row.id,
        path: row.path,
        title: row.title,
        author: row.author,
        format: row.format,
        sha256: row.sha256,
        byteSize: row.byte_size,
        pageCount: row.page_count,
        importedAt: row.imported_at,
      },
      chunks: 0,
      replaced: false,
    };
  }

  let sourceId = 0;
  let replaced = false;
  // Front/back matter (copyright, ads, other-book excerpts) never becomes
  // passages: the trim blanks those pages, keeping page numbers stable.
  const trimmed = trimFrontBackMatter(raw);
  const chunks = chunkText(trimmed.text, { maxWords: opts.maxWords ?? 220 });
  const byteSize = statSync(filePath).size;
  const importedAt = nowIso();
  db.transaction(() => {
    if (existing) {
      replaced = true;
      db.run('DELETE FROM canon_source WHERE id = ?', existing.id);
    }
    const res = db.run(
      `INSERT INTO canon_source (project_id, path, title, author, format, sha256, byte_size, page_count, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      filePath,
      title,
      opts.author ?? imported.author,
      imported.format,
      sha,
      byteSize,
      imported.pageCount,
      importedAt,
    );
    sourceId = res.lastInsertRowid;
    for (const c of chunks) {
      const page = c.pageStart ? (c.pageEnd > c.pageStart ? `p. ${c.pageStart}-${c.pageEnd}` : `p. ${c.pageStart}`) : '';
      const locator = c.heading ? (page ? `${c.heading} (${page})` : c.heading) : page || `passage ${c.seq + 1}`;
      db.run(
        `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, char_start, char_end, words, page_start, page_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sourceId,
        projectId,
        c.seq,
        locator,
        c.heading,
        c.text,
        c.charStart,
        c.charEnd,
        wordCount(c.text),
        c.pageStart,
        c.pageEnd,
      );
    }
  });

  return {
    source: {
      id: sourceId,
      path: filePath,
      title,
      author: opts.author ?? imported.author,
      format: imported.format,
      sha256: sha,
      byteSize,
      pageCount: imported.pageCount,
      importedAt,
    },
    chunks: chunks.length,
    replaced,
    trimmed:
      trimmed.headPages || trimmed.tailPages
        ? { headPages: trimmed.headPages, tailPages: trimmed.tailPages }
        : undefined,
  };
}

interface RowSource {
  id: number;
  path: string;
  title: string;
  author: string;
  format: string;
  sha256: string;
  byte_size: number;
  page_count: number;
  imported_at: string;
}

export function listSources(db: Db, projectId: number): SourceInfo[] {
  const rows = db.all<RowSource>(
    'SELECT * FROM canon_source WHERE project_id = ? ORDER BY title',
    projectId,
  );
  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    title: r.title,
    author: r.author,
    format: r.format,
    sha256: r.sha256,
    byteSize: r.byte_size,
    pageCount: r.page_count,
    importedAt: r.imported_at,
  }));
}
