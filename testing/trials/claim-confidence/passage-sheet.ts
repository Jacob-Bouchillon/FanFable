/**
 * Passage-proof sheet (trials only, not in npm test).
 *
 * Reads keepers from a disposable copy and emits one row per keeper with the
 * cited chunk text, so a judge can answer the passage question rather than the
 * sentence question. Read-only; no bank writes.
 *
 * usage:
 *   node testing/trials/claim-confidence/passage-sheet.ts --db <copy.db> \
 *     [--out /tmp/opencode/precision-passage] [--project <name>] [--cap 2000]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seededShuffle } from './measure-precision.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const CAP = 2000;

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = args[at + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function main(): void {
  const args = process.argv.slice(2);
  const dbPath = flag(args, 'db');
  if (!dbPath) {
    process.stderr.write('usage: passage-sheet.ts --db <copy.db> [--out <dir>] [--project <name>]\n');
    process.exit(2);
  }
  if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  const outDir = flag(args, 'out') ?? '/tmp/opencode/precision-passage';
  const cap = Math.max(1, Number(flag(args, 'cap') ?? CAP));
  const seed = Number(flag(args, 'seed') ?? 42);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows: {
    id: number;
    relId: number;
    pair: string;
    quote: string;
    passage: string;
    locator: string;
  }[];
  let skippedNoChunk = 0;
  let truncated = 0;
  let keepers = 0;
  let projectName = '';
  try {
    const projects = db.prepare('SELECT id, name FROM project ORDER BY id').all() as { id: number; name: string }[];
    const wanted = flag(args, 'project');
    const project = wanted
      ? projects.find((entry) => entry.name === wanted)
      : projects.length === 1
        ? projects[0]
        : undefined;
    if (!project) throw new Error('project not found or ambiguous; pass --project <name>');
    projectName = project.name;
    const keepersRows = db
      .prepare(
        `SELECT r.id AS relId, r.evidence AS quote, r.source_refs AS refs,
                a.name AS fromName, b.name AS toName
           FROM canon_relation r
           JOIN canon_entity a ON a.id = r.from_entity
           JOIN canon_entity b ON b.id = r.to_entity
          WHERE r.project_id = ? AND r.review_status IN ('accepted','user_confirmed')
          ORDER BY r.id`,
      )
      .all(project.id) as { relId: number; quote: string; refs: string; fromName: string; toName: string }[];
    keepers = keepersRows.length;
    const chunkOf = (refs: string): { text: string; locator: string } | null => {
      let parsed: unknown = [];
      try {
        parsed = JSON.parse(refs || '[]');
      } catch {
        parsed = [];
      }
      if (!Array.isArray(parsed)) return null;
      for (const ref of parsed) {
        const id = Number((ref as { chunk?: unknown })?.chunk);
        if (!Number.isFinite(id) || id <= 0) continue;
        const chunk = db.prepare(
          `SELECT c.text, c.locator FROM canon_chunk c WHERE c.id = ? AND c.project_id = ?`,
        ).get(id, project.id) as { text: string; locator: string } | undefined;
        if (chunk) return chunk;
      }
      return null;
    };
    const mapped: typeof rows = [];
    for (const row of keepersRows) {
      const chunk = chunkOf(row.refs);
      if (!chunk) {
        skippedNoChunk++;
        continue;
      }
      const text = String(chunk.text ?? '');
      let passage = text;
      if (text.length > cap) {
        passage = `${text.slice(0, cap)} ...truncated`;
        truncated++;
      }
      mapped.push({
        id: 0,
        relId: Number(row.relId),
        pair: `${row.fromName} / ${row.toName}`,
        quote: String(row.quote ?? '').trim(),
        passage,
        locator: String(chunk.locator ?? ''),
      });
    }
    rows = seededShuffle(mapped, seed);
    rows.forEach((row, index) => {
      row.id = index + 1;
    });
  } finally {
    db.close();
  }

  mkdirSync(outDir, { recursive: true });
  const header = 'id,relId,pair,quote,passage,locator';
  writeFileSync(
    join(outDir, 'sheet.csv'),
    `${header}\n${rows
      .map((row) => [row.id, row.relId, csvCell(row.pair), csvCell(row.quote), csvCell(row.passage), csvCell(row.locator)].join(','))
      .join('\n')}\n`,
  );
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  writeFileSync(
    join(outDir, 'manifest.json'),
    `${JSON.stringify({
      schema: 'fanfable-passage-sheet/1',
      model: null,
      seed,
      commit,
      keeperPredicate: "review_status IN ('accepted','user_confirmed')",
      cap,
      db: dbPath,
      project: { name: projectName },
      composition: { keepers, skippedNoChunk, truncated },
      columns: ['id', 'relId', 'pair', 'quote', 'passage', 'locator'],
    }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ keepers, rows: rows.length, skippedNoChunk, truncated, out: outDir }));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
