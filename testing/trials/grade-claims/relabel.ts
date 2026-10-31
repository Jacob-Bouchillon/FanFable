/**
 * Relabel the claims the blind judge rejected as "right pair, wrong kind".
 *
 * Reads key.csv (claim_id) and verdicts.csv (verdict=C, reason=kind), then asks
 * the project's model for the relationship the passage states. Writes a
 * relabel ruling for each change. Dry run by default.
 *
 * Usage:
 *   node --no-warnings testing/trials/grade-claims/relabel.ts <db> <project> <key.csv> <verdicts.csv> [--write] [--limit n]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Db } from '../../../fanfable/src/db.ts';
import { clientFrom } from '../../../fanfable/src/llm.ts';
import { relabelRelations } from '../../../fanfable/src/lorebook.ts';

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cell = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const head = (rows.shift() ?? []).map((h) => h.trim());
  return rows
    .filter((r) => r.some((c) => c.trim().length > 0))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const args = process.argv.slice(2);
const write = args.includes('--write');
const limitFlag = args.findIndex((a) => a === '--limit');
const limit = limitFlag >= 0 ? Number(args[limitFlag + 1]) : undefined;
const [dbPath, projectName, keyPath, verdictsPath] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--limit');
if (!dbPath || !projectName || !keyPath || !verdictsPath) {
  throw new Error('usage: relabel.ts <db> <project> <key.csv> <verdicts.csv> [--write] [--limit n]');
}

const key = parseCsv(readFileSync(resolve(keyPath), 'utf8'));
const verdicts = new Map(
  parseCsv(readFileSync(resolve(verdictsPath), 'utf8')).map((row) => [row.id ?? '', row]),
);
const ids = key
  .filter((row) => (verdicts.get(row.id ?? '')?.verdict ?? '').toUpperCase() === 'C')
  .filter((row) => (verdicts.get(row.id ?? '')?.reason ?? '').toLowerCase().startsWith('kind'))
  .map((row) => Number(row.claim_id))
  .filter((id) => Number.isFinite(id) && id > 0)
  .slice(0, limit && limit > 0 ? limit : undefined);

const db = new Db(resolve(dbPath));
const project = db.get<{ id: number; settings: string }>(
  'SELECT id, settings FROM project WHERE name = ?',
  projectName,
);
if (!project) throw new Error(`no project named "${projectName}"`);
const settings = JSON.parse(project.settings || '{}') as Record<string, unknown>;
const llm = clientFrom(settings);

if (write) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${db.path}.relabel-backup-${stamp}.db`;
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  console.log('backup', backup);
}

console.log(`${write ? 'relabelling' : 'dry run'}: ${ids.length} claim(s) judged C/kind`);
const result = await relabelRelations(db, llm, project.id, {
  ids,
  write,
  onProgress: (message) => console.log(`  ${message}`),
});
console.log(
  `checked ${result.checked}, changed ${result.changed}, skipped: ` +
    Object.entries(result.skipped)
      .filter(([, n]) => n > 0)
      .map(([reason, n]) => `${reason} ${n}`)
      .join(', '),
);
if (!write) console.log('re-run with --write to apply the labels');
db.close();
