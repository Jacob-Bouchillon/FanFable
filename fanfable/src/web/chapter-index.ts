/**
 * Chapter and passage index for character appearances.
 *
 * Pure reads: scans canon_chunk text with word-boundary name/alias matches.
 * No model, no writes, no caching table.
 */
import { Db, fromJson } from '../core/db.ts';
import { splitSentences } from '../core/text.ts';

export interface ChapterAppearance {
  chunkId: number;
  seq: number;
  locator: string;
  heading: string;
  quote: string;
}

export interface ChapterFace {
  entityId: number;
  name: string;
  kind: string;
}

function collapseWhitespace(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchForms(name: string, aliases: string[]): string[] {
  const seen = new Set<string>();
  const forms: string[] = [];
  for (const value of [name, ...aliases]) {
    const form = collapseWhitespace(value);
    if (!form || seen.has(form.toLowerCase())) continue;
    seen.add(form.toLowerCase());
    forms.push(form);
  }
  return forms;
}

function formPattern(form: string): RegExp {
  const escaped = escapeRegExp(form);
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');
}

function patternsFor(name: string, aliases: string[]): RegExp[] {
  return matchForms(name, aliases).map(formPattern);
}

function firstMatchingSentence(text: string, patterns: RegExp[]): string | null {
  const sentences = splitSentences(String(text ?? ''));
  for (let index = 0; index < sentences.length; index++) {
    const normalised = collapseWhitespace(sentences[index]);
    if (!normalised) continue;
    if (!patterns.some((pattern) => pattern.test(normalised))) continue;
    let quote = normalised;
    let next = index + 1;
    while (quote.length < 20 && next < sentences.length) {
      const addition = collapseWhitespace(sentences[next]);
      if (addition) quote = `${quote} ${addition}`;
      next++;
    }
    if (quote.length < 20 && index > 0) {
      const previous = collapseWhitespace(sentences[index - 1]);
      if (previous) quote = `${previous} ${quote}`;
    }
    return quote;
  }
  return null;
}

export function characterChapters(
  db: Db,
  projectId: number,
  entityId: number,
  limit = 200,
): ChapterAppearance[] {
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 200;
  if (cap === 0) return [];
  const entity = db.get<{ name: string; aliases: string }>(
    'SELECT name, aliases FROM canon_entity WHERE id = ? AND project_id = ?',
    entityId,
    projectId,
  );
  if (!entity) return [];
  const patterns = patternsFor(entity.name, fromJson<string[]>(entity.aliases, []));
  if (!patterns.length) return [];

  const chunks = db.all<{
    id: number;
    seq: number;
    locator: string;
    heading: string;
    text: string;
  }>(
    'SELECT id, seq, locator, heading, text FROM canon_chunk WHERE project_id = ? ORDER BY seq, id',
    projectId,
  );

  const appearances: ChapterAppearance[] = [];
  for (const chunk of chunks) {
    const quote = firstMatchingSentence(String(chunk.text ?? ''), patterns);
    if (quote === null) continue;
    appearances.push({
      chunkId: Number(chunk.id),
      seq: Number(chunk.seq),
      locator: String(chunk.locator ?? ''),
      heading: String(chunk.heading ?? ''),
      quote,
    });
    if (appearances.length >= cap) break;
  }
  return appearances;
}

export function chapterCharacters(db: Db, projectId: number, chunkId: number): ChapterFace[] {
  const chunk = db.get<{ text: string }>(
    'SELECT text FROM canon_chunk WHERE id = ? AND project_id = ?',
    chunkId,
    projectId,
  );
  if (!chunk) return [];
  const text = collapseWhitespace(chunk.text);
  if (!text) return [];

  const entities = db.all<{ id: number; name: string; aliases: string; kind: string }>(
    `SELECT id, name, aliases, kind FROM canon_entity
      WHERE project_id = ? AND kind = 'character'
      ORDER BY lower(name), id`,
    projectId,
  );
  const faces: ChapterFace[] = [];
  for (const entity of entities) {
    const patterns = patternsFor(entity.name, fromJson<string[]>(entity.aliases, []));
    if (patterns.some((pattern) => pattern.test(text))) {
      faces.push({
        entityId: Number(entity.id),
        name: String(entity.name ?? ''),
        kind: String(entity.kind ?? ''),
      });
    }
  }
  return faces.sort((left, right) =>
    left.name.toLowerCase().localeCompare(right.name.toLowerCase()) || left.entityId - right.entityId);
}
