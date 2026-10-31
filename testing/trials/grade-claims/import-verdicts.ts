/**
 * Import an external model's blind-grade verdicts into the court record.
 *
 * Reads the exporter's key.csv (id,pair,claim_id,relation_ids,signal) and the
 * judge's verdicts CSV (id,verdict,quote,locator,reason). Writes one
 * `verdict/external/blind-passage` ruling per graded claim. With
 * `--demote-c`, a C verdict also moves the claim to `needs_review` and records
 * the appeal. Dry run by default.
 *
 * Usage:
 *   node --no-warnings testing/trials/grade-claims/import-verdicts.ts <db> <project> <key.csv> <verdicts.csv> [--write] [--demote-c]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Db } from '../../../fanfable/src/db.ts';
import { recordRuling } from '../../../fanfable/src/ruling.ts';

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

function cleanVerdicts(raw: string): string {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*id\s*,\s*verdict/i.test(line));
  return (start >= 0 ? lines.slice(start) : lines)
    .filter((line) => !/^\s*```/.test(line))
    .join('\n');
}

const args = process.argv.slice(2);
const write = args.includes('--write');
const demoteC = args.includes('--demote-c');
const [dbPath, projectName, keyPath, verdictsPath] = args.filter((a) => !a.startsWith('--'));
if (!dbPath || !projectName || !keyPath || !verdictsPath) {
  throw new Error('usage: import-verdicts.ts <db> <project> <key.csv> <verdicts.csv> [--write] [--demote-c]');
}

const db = new Db(resolve(dbPath));
const project = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName);
if (!project) throw new Error(`no project named "${projectName}"`);

const key = parseCsv(readFileSync(resolve(keyPath), 'utf8'));
const verdicts = new Map(
  parseCsv(cleanVerdicts(readFileSync(resolve(verdictsPath), 'utf8'))).map((row) => [row.id ?? '', row]),
);

let graded = 0;
let imported = 0;
let skipped = 0;
let demoted = 0;
let heldForHuman = 0;
let missingVerdict = 0;
let missingClaim = 0;
const counts = { A: 0, B: 0, C: 0, D: 0 };
for (const row of key) {
  const verdict = (verdicts.get(row.id ?? '')?.verdict ?? '').toUpperCase();
  if (!['A', 'B', 'C', 'D'].includes(verdict)) {
    missingVerdict++;
    continue;
  }
  graded++;
  counts[verdict as 'A' | 'B' | 'C' | 'D']++;
  const claimId = Number(row.claim_id);
  const claim = Number.isFinite(claimId)
    ? db.get<{ id: number; review_status: string; evidence: string }>(
        'SELECT id, review_status, evidence FROM canon_relation WHERE id = ? AND project_id = ?',
        claimId,
        project.id,
      )
    : undefined;
  if (!claim) {
    missingClaim++;
    continue;
  }
  const reason = verdicts.get(row.id ?? '')?.reason ?? '';
  const basis = `${verdict}${reason ? `: ${reason}` : ''}`;
  const already = db.get<{ id: number }>(
    "SELECT id FROM canon_ruling WHERE project_id = ? AND relation_id = ? AND actor = 'external' AND role = 'verdict' AND basis = ? ORDER BY id DESC LIMIT 1",
    project.id,
    claim.id,
    basis,
  );
  if (already) {
    skipped++;
    continue;
  }
  const humanRuling = claim.review_status === 'user_confirmed';
  const demote = demoteC && verdict === 'C' && !humanRuling && claim.review_status !== 'needs_review';
  if (!write) {
    if (demote) demoted++;
    if (demoteC && verdict === 'C' && humanRuling) heldForHuman++;
    continue;
  }
  db.transaction(() => {
    recordRuling(db, project.id, {
      relationId: claim.id,
      role: 'verdict',
      actor: 'external',
      standard: 'blind-passage',
      fromStatus: claim.review_status,
      toStatus: demote ? 'needs_review' : claim.review_status,
      basis: `${verdict}${reason ? `: ${reason}` : ''}`,
      quote: claim.evidence,
    });
    if (demote) {
      db.run(
        "UPDATE canon_relation SET review_status = 'needs_review' WHERE id = ? AND project_id = ?",
        claim.id,
        project.id,
      );
      demoted++;
    }
    imported++;
  });
}

console.log(`${write ? 'imported' : 'dry run (nothing written)'}: graded ${graded}/${key.length}`);
console.log(`A ${counts.A}, B ${counts.B}, C ${counts.C}, D ${counts.D}`);
console.log(
  `missing verdict ${missingVerdict}, claim not found ${missingClaim}, imported ${imported}, ` +
    `already recorded ${skipped}, demoted ${demoted}, C on human-confirmed left ${heldForHuman}`,
);
if (!write) console.log('re-run with --write to record the verdicts');
db.close();

