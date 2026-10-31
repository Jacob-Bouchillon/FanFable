/** Quarantine the ten audited keepers. Data-only; evidence and endpoints untouched. */
import { writeFileSync } from 'node:fs';
import { Db } from '../../../fanfable/src/core/db.ts';

const IDS = [15, 24, 118, 247, 257, 299, 313, 321, 339, 372];
const db = new Db('testing/trials/halfbook-run/plagueis-half.db');
const projectId = 1;
const norm = (text: string): string => (text ?? '')
  .replace(/[“”«»]/g, '"')
  .replace(/[‘’]/g, "'")
  .replace(/[–—−]/g, '-')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

const audit: {
  id: number; pair: string; kind: string; previousStatus: string;
  reason: string; auditClass: 'invented' | 'spliced' | 'no-ref';
}[] = [];

for (const id of IDS) {
  const row = db.get<{
    id: number; kind: string; evidence: string; source_refs: string; review_status: string;
    from_name: string; to_name: string;
  }>(
    `SELECT r.id, r.kind, r.evidence, r.source_refs, r.review_status,
            a.name AS from_name, b.name AS to_name
       FROM canon_relation r JOIN canon_entity a ON a.id = r.from_entity JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ? AND r.id = ?`,
    projectId, id,
  );
  if (!row) throw new Error(`relation ${id} missing`);
  let refs: { chunk?: unknown }[] = [];
  try { refs = JSON.parse(row.source_refs || '[]') as { chunk?: unknown }[]; } catch { refs = []; }
  const chunkId = refs
    .map((ref) => Number(ref?.chunk))
    .find((value) => Number.isFinite(value) && value > 0);
  const chunk = chunkId ? db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ?', chunkId) : undefined;
  let auditClass: 'invented' | 'spliced' | 'no-ref';
  if (!chunk) {
    auditClass = 'no-ref';
  } else {
    const hay = norm(chunk.text);
    const quote = norm(row.evidence);
    const contained = !!quote && hay.includes(quote);
    if (contained) throw new Error(`relation ${id} unexpectedly verifies`);
    const sentences = row.evidence.split(/(?<=[.!?])\s+/).map((part) => norm(part)).filter(Boolean);
    auditClass = sentences.length > 1 && sentences.every((sentence) => hay.includes(sentence)) ? 'spliced' : 'invented';
  }
  db.run(
    `UPDATE canon_relation
        SET review_status = 'provisional',
            confirmed_by_user = CASE WHEN review_status = 'user_confirmed' THEN 1 ELSE confirmed_by_user END
      WHERE project_id = ? AND id = ?`,
    projectId, id,
  );
  audit.push({
    id,
    pair: `${row.from_name} — ${row.to_name}`,
    kind: row.kind,
    previousStatus: row.review_status,
    reason: 'evidence-unverified',
    auditClass,
  });
}

writeFileSync('testing/trials/evidence-audit/quarantine.json', JSON.stringify(audit, null, 2) + '\n');
const tiers = db.all<{ review_status: string; n: number }>(
  'SELECT review_status, COUNT(*) AS n FROM canon_relation WHERE project_id = ? GROUP BY review_status',
  projectId,
);
const keepers = db.get<{ n: number }>(
  "SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ? AND review_status IN ('accepted','user_confirmed')",
  projectId,
)!.n;
console.log(JSON.stringify({ audit, tiers, keepers }, null, 2));
db.close();
