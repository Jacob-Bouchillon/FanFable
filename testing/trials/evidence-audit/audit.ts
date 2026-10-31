import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/core/db.ts';
import { writeFileSync, mkdirSync } from 'node:fs';

const DB = '/home/jacob/Documents/FanFable/testing/trials/halfbook-run/plagueis-half.db';
const OUT = '/home/jacob/Documents/FanFable/testing/trials/evidence-audit';
mkdirSync(OUT, { recursive: true });

const db = new Db(DB);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'halfbook')!;

const norm = (s: string) =>
  String(s ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\.\s*\.\s*\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const chunks = db.all<{ id: number; seq: number; text: string; locator: string; heading: string }>(
  'SELECT id, seq, text, locator, heading FROM canon_chunk WHERE project_id = ? ORDER BY seq',
  proj.id,
);
const byId = new Map(chunks.map((c) => [c.id, c]));

type Rec = {
  id: number; kind: string; evidence: string; source_refs: string;
  fn: string; tn: string;
};

const rels = db.all<Rec>(
  `SELECT r.id, r.kind, r.evidence, r.source_refs, a.name AS fn, b.name AS tn
     FROM canon_relation r
     JOIN canon_entity a ON a.id = r.from_entity
     JOIN canon_entity b ON b.id = r.to_entity
    WHERE r.project_id = ? AND r.review_status = 'needs_review'
    ORDER BY r.id`,
  proj.id,
);

type Class = 'in-ref-normalized' | 'stale-ref' | 'paraphrased' | 'absent' | 'no-ref';
const rows: { id: number; cls: Class; refChunk?: number; foundChunk?: number; loc?: string; quoteLen: number }[] = [];

for (const r of rels) {
  const q = norm(r.evidence);
  if (!q) continue;
  let refChunk: number | undefined;
  try {
    const refs = JSON.parse(r.source_refs || '[]');
    if (Array.isArray(refs)) {
      const c = refs.map((x: { chunk?: unknown }) => Number(x?.chunk)).find((n: number) => Number.isFinite(n) && byId.has(n));
      if (c) refChunk = c;
    }
  } catch {}
  const refText = refChunk ? norm(byId.get(refChunk)!.text) : '';
  const inRef = refText.includes(q);

  // full quote anywhere?
  const full = chunks.find((c) => norm(c.text).includes(q));
  // longest matching window as a paraphrase probe: first 40 normalized chars
  const probe = q.slice(0, Math.min(40, q.length));
  const partial = !full && probe.length >= 20 ? chunks.find((c) => norm(c.text).includes(probe)) : undefined;

  let cls: Class;
  if (!refChunk) cls = 'no-ref';
  else if (inRef) cls = 'in-ref-normalized';
  else if (full) cls = 'stale-ref';
  else if (partial) cls = 'paraphrased';
  else cls = 'absent';

  if (cls !== 'in-ref-normalized') {
    rows.push({
      id: r.id,
      cls,
      refChunk,
      foundChunk: full?.id ?? partial?.id,
      loc: (full ?? partial)?.locator,
      quoteLen: q.length,
    });
  }
}

const counts = rows.reduce<Record<string, number>>((m, r) => ((m[r.cls] = (m[r.cls] ?? 0) + 1), m), {});
writeFileSync(`${OUT}/audit.json`, JSON.stringify({ counts, rows }, null, 2));
console.log(JSON.stringify({ examined: rels.length, mismatches: rows.length, counts, sample: rows.slice(0, 12) }, null, 2));
db.close();
