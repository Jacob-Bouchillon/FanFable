/**
 * Read-only chapter index report.
 *
 * --entity "Harry" prints that character's appearances.
 * --chunk 12 prints the character names in that chunk.
 */
import { DatabaseSync } from 'node:sqlite';
import { fromJson, type Db } from '../../fanfable/src/core/db.ts';
import {
  chapterCharacters,
  characterChapters,
  type ChapterAppearance,
} from '../../fanfable/src/web/chapter-index.ts';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function chapterKey(appearance: ChapterAppearance): string {
  const heading = appearance.heading.trim();
  if (heading) return heading.toLowerCase();
  const locator = appearance.locator;
  const chapter = locator
    .replace(/\s*\(p\.[^)]*\).*$/i, '')
    .replace(/\s*#\d+$/, '')
    .trim();
  return (chapter || locator).toLowerCase();
}

const dbPath = flag('db') ?? process.argv[2];
const projectName = flag('project') ?? process.argv[3] ?? 'hp1';
const entityArg = flag('entity');
const chunkArg = flag('chunk');
if (!dbPath || (!entityArg && !chunkArg)) {
  console.error('usage: node --no-warnings testing/scripts/chapter-index-report.ts --db <path> --project <name> --entity "Name" | --chunk <id>');
  process.exit(2);
}

const raw = new DatabaseSync(dbPath, { readOnly: true });
const db = {
  get: <T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined =>
    raw.prepare(sql).get(...(params as never[])) as T | undefined,
  all: <T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] =>
    raw.prepare(sql).all(...(params as never[])) as T[],
} as unknown as Db;

try {
  const project = db.get<{ id: number; name: string }>(
    'SELECT id, name FROM project WHERE name = ?',
    projectName,
  );
  if (!project) {
    console.error(`no project named "${projectName}" in ${dbPath}`);
    process.exit(1);
  }

  if (chunkArg !== undefined) {
    const chunkId = Number(chunkArg);
    if (!Number.isInteger(chunkId) || chunkId <= 0) {
      console.error(`bad chunk id: ${chunkArg}`);
      process.exit(1);
    }
    const chunk = db.get<{ id: number; seq: number; locator: string }>(
      'SELECT id, seq, locator FROM canon_chunk WHERE id = ? AND project_id = ?',
      chunkId,
      project.id,
    );
    if (!chunk) {
      console.error(`no chunk ${chunkId} in project ${projectName}`);
      process.exit(1);
    }
    const faces = chapterCharacters(db, project.id, chunkId);
    console.log(`chunk ${chunk.id} | ${chunk.locator} | seq ${chunk.seq}`);
    if (!faces.length) {
      console.log('no character names found');
    } else {
      for (const face of faces) console.log(`${face.name} (${face.entityId})`);
    }
    process.exitCode = 0;
  } else {
    const selector = String(entityArg).trim();
    let entity = db.get<{ id: number; name: string }>(
      'SELECT id, name FROM canon_entity WHERE project_id = ? AND lower(name) = lower(?) ORDER BY id LIMIT 1',
      project.id,
      selector,
    );
    if (!entity) {
      const target = selector.toLowerCase();
      const rows = db.all<{ id: number; name: string; aliases: string }>(
        'SELECT id, name, aliases FROM canon_entity WHERE project_id = ? ORDER BY id',
        project.id,
      );
      for (const row of rows) {
        const aliases = fromJson<string[]>(row.aliases, []).map((alias) => String(alias).trim().toLowerCase());
        if (aliases.includes(target)) {
          entity = { id: row.id, name: row.name };
          break;
        }
      }
    }
    if (!entity) {
      console.error(`no entity named or aliased "${selector}" in project ${projectName}`);
      process.exit(1);
    }

    const appearances = characterChapters(db, project.id, entity.id, 10_000);
    console.log(`entity ${entity.name} (${entity.id})`);
    for (const appearance of appearances) {
      console.log(`${appearance.locator} | ${appearance.seq} | ${appearance.quote}`);
    }
    console.log(`appearances: ${appearances.length}`);
    console.log(`distinct chapters: ${new Set(appearances.map(chapterKey)).size}`);
  }
} finally {
  raw.close();
}
