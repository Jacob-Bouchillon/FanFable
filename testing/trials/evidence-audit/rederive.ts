/** Dry run or apply deterministic evidence re-derivation. */
import { readFileSync, writeFileSync } from 'node:fs';
import { Db } from '../../../fanfable/src/db.ts';
import { applyPlan, loadChunks, loadRows, planRow } from './rederive-lib.ts';

const APPLY = process.argv.includes('--apply');
const db = new Db('testing/trials/halfbook-run/plagueis-half.db');
const projectId = 1;
const quarantine = JSON.parse(readFileSync('testing/trials/evidence-audit/quarantine.json', 'utf8')) as { id: number; reason: string }[];
const ids = quarantine.filter((row) => row.reason === 'evidence-unverified').map((row) => row.id);
const rows = loadRows(db, projectId, ids);
const chunks = loadChunks(db, projectId);
const plan = rows.map((row) => planRow(row, chunks));
const counts = {
  target: ids.length,
  loaded: rows.length,
  restore: plan.filter((row) => row.outcome === 'restore').length,
  manualReview: plan.filter((row) => row.outcome === 'manual-review').length,
  remainProvisional: plan.filter((row) => row.outcome === 'remain-provisional').length,
};
writeFileSync(
  `testing/trials/evidence-audit/${APPLY ? 'rederive-plan.json' : 'rederive-dry.json'}`,
  JSON.stringify(plan, null, 2) + '\n',
);
let applied = [];
if (APPLY) {
  applied = applyPlan(db, projectId, plan, rows, chunks);
  writeFileSync('testing/trials/evidence-audit/rederive-applied.json', JSON.stringify(applied, null, 2) + '\n');
}
console.log(JSON.stringify({ apply: APPLY, counts, applied }, null, 2));
db.close();
