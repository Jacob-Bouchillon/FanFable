/**
 * Repair missing source refs on parked relations. Data-only: refs change;
 * status, kind, evidence, tiers and everything else stay as they are.
 *
 * Usage: node testing/trials/refs-backfill/run.ts [--apply]
 */
import { writeFileSync } from 'node:fs';
import { Db } from '../../../fanfable/src/core/db.ts';
import { nameMentionedExact } from '../../../fanfable/src/identity/names.ts';
import { strList } from '../../../fanfable/src/core/db.ts';

const APPLY = process.argv.includes('--apply');
const DB = 'testing/trials/halfbook-run/plagueis-half.db';
const DIR = 'testing/trials/refs-backfill';

interface Chunk {
  id: number;
  seq: number;
  locator: string;
  source_title: string;
  text: string;
}

interface Row {
  id: number;
  kind: string;
  evidence: string;
  source_refs: string;
  from_name: string;
  from_aliases: string;
  to_name: string;
  to_aliases: string;
}

const db = new Db(DB);
const projectId = db.get<{ id: number }>('SELECT id FROM project ORDER BY id LIMIT 1')!.id;
const chunks = db.all<Chunk>(
  `SELECT c.id, c.seq, c.locator, s.title AS source_title, c.text
     FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id
    WHERE c.project_id = ? ORDER BY c.seq, c.id`,
  projectId,
);
const chunkIds = new Set(chunks.map((chunk) => chunk.id));
const norm = (text: string): string => (text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

function usableChunk(refs: string): number | null {
  let parsed: { chunk?: unknown }[] = [];
  try { parsed = JSON.parse(refs || '[]') as { chunk?: unknown }[]; } catch { parsed = []; }
  for (const ref of parsed) {
    const id = Number(ref?.chunk);
    if (Number.isFinite(id) && chunkIds.has(id)) return id;
  }
  return null;
}

const rows = db.all<Row>(
  `SELECT r.id, r.kind, r.evidence, r.source_refs,
          a.name AS from_name, a.aliases AS from_aliases,
          b.name AS to_name, b.aliases AS to_aliases
     FROM canon_relation r
     JOIN canon_entity a ON a.id = r.from_entity
     JOIN canon_entity b ON b.id = r.to_entity
    WHERE r.project_id = ? AND r.review_status = 'needs_review'
    ORDER BY r.id`,
  projectId,
).filter((row) => usableChunk(row.source_refs) === null);

const audit: { id: number; pair: string; kind: string; action: string; chunkId: number | null; locator: string; reason: string }[] = [];
const beforeEvidence = new Map(rows.map((row) => [row.id, row.evidence]));
const statusBefore = db.all<{ review_status: string; n: number }>(
  'SELECT review_status, COUNT(*) AS n FROM canon_relation WHERE project_id = ? GROUP BY review_status',
  projectId,
);
const usableBefore = db.get<{ n: number }>(
  `SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ? AND review_status = 'needs_review'`,
  projectId,
)!.n - rows.length;

for (const row of rows) {
  const pair = `${row.from_name} — ${row.to_name}`;
  const evidence = norm(row.evidence);
  const quoteMatches = evidence
    ? chunks.filter((chunk) => norm(chunk.text).includes(evidence))
    : [];
  let chosen: Chunk | null = null;
  let action = 'unquotable';
  let reason = '';
  if (quoteMatches.length === 1) {
    chosen = quoteMatches[0]!;
    action = 'quote-match';
    reason = 'evidence verbatim in exactly one chunk';
  } else if (quoteMatches.length > 1) {
    chosen = quoteMatches.slice().sort((a, b) => a.seq - b.seq || a.id - b.id)[0]!;
    action = 'ambiguous';
    reason = `${quoteMatches.length} chunks contain the quote; attached earliest by seq`;
  } else {
    const both = chunks.filter((chunk) =>
      nameMentionedExact(row.from_name, chunk.text) && nameMentionedExact(row.to_name, chunk.text),
    );
    const aliasBoth = chunks.filter((chunk) => {
      const a = nameMentionedExact(row.from_name, chunk.text) ||
        strList(row.from_aliases).some((alias) => nameMentionedExact(alias, chunk.text));
      const b = nameMentionedExact(row.to_name, chunk.text) ||
        strList(row.to_aliases).some((alias) => nameMentionedExact(alias, chunk.text));
      return a && b;
    });
    if (both.length === 1 || aliasBoth.length === 1) {
      chosen = (both.length === 1 ? both : aliasBoth)[0]!;
      action = 'candidate';
      reason = 'no quote match; exactly one chunk names both endpoints (candidate, not proof)';
    } else {
      action = 'unquotable';
      reason = both.length || aliasBoth.length
        ? `${Math.max(both.length, aliasBoth.length)} chunks name both endpoints; not unique`
        : 'no chunk names both endpoints';
    }
  }
  if (chosen && APPLY) {
    db.run(
      'UPDATE canon_relation SET source_refs = ? WHERE id = ? AND project_id = ?',
      JSON.stringify([{ source: chosen.source_title, locator: chosen.locator, chunk: chosen.id }]),
      row.id,
      projectId,
    );
  }
  audit.push({
    id: row.id,
    pair,
    kind: row.kind,
    action,
    chunkId: chosen?.id ?? null,
    locator: chosen?.locator ?? '',
    reason,
  });
}

const count = (action: string): number => audit.filter((row) => row.action === action).length;
const usableAfter = db.get<{ n: number }>(
  `SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ? AND review_status = 'needs_review'`,
  projectId,
)!.n - db.all<{ source_refs: string }>(
  "SELECT source_refs FROM canon_relation WHERE project_id = ? AND review_status = 'needs_review'",
  projectId,
).filter((row) => usableChunk(row.source_refs) === null).length;
const statusAfter = db.all<{ review_status: string; n: number }>(
  'SELECT review_status, COUNT(*) AS n FROM canon_relation WHERE project_id = ? GROUP BY review_status',
  projectId,
);
const evidenceChanged = rows.filter((row) => db.get<{ evidence: string }>(
  'SELECT evidence FROM canon_relation WHERE id = ?', row.id,
)!.evidence !== beforeEvidence.get(row.id)).length;

writeFileSync(
  `${DIR}/${APPLY ? 'audit.json' : 'audit-dry.json'}`,
  JSON.stringify(audit, null, 2) + '\n',
);
console.log(JSON.stringify({
  apply: APPLY,
  population: rows.length,
  actions: {
    quoteMatch: count('quote-match'),
    candidate: count('candidate'),
    ambiguous: count('ambiguous'),
    unquotable: count('unquotable'),
  },
  usableRefsBefore: usableBefore,
  usableRefsAfter: usableAfter,
  statusBefore,
  statusAfter,
  evidenceChanged,
  spotCheck: audit.filter((row) => row.chunkId !== null).slice(0, 5).map((row) => ({
    id: row.id, chunkId: row.chunkId, locator: row.locator, action: row.action,
  })),
}, null, 2));
db.close();
