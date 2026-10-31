import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';
import * as names from '/home/jacob/Documents/FanFable/fanfable/src/identity/names.ts';
import * as lb from '/home/jacob/Documents/FanFable/fanfable/src/lorebook.ts';
import { mkdirSync, writeFileSync } from 'node:fs';

const DB = '/home/jacob/Documents/FanFable/testing/trials/halfbook-run/plagueis-half.db';
const OUT = '/home/jacob/Documents/FanFable/testing/trials/bucketing';
const SEED = 42;
mkdirSync(OUT, { recursive: true });

const db = new Db(DB);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'halfbook')!;

type Row = {
  id: number; kind: string; evidence: string; source_refs: string;
  fn: string; fa: string; tn: string; ta: string; status: string;
};

const rels = db.all<Row>(
  `SELECT r.id, r.kind, r.evidence, r.source_refs, r.review_status AS status,
          a.name AS fn, a.aliases AS fa, b.name AS tn, b.aliases AS ta
     FROM canon_relation r
     JOIN canon_entity a ON a.id = r.from_entity
     JOIN canon_entity b ON b.id = r.to_entity
    WHERE r.project_id = ? AND r.review_status = 'needs_review'
    ORDER BY r.id`,
  proj.id,
);

const chunks = new Map<number, { seq: number; text: string; locator: string }>();
for (const c of db.all<{ id: number; seq: number; text: string; locator: string }>(
  'SELECT id, seq, text, locator FROM canon_chunk WHERE project_id = ? ORDER BY seq',
  proj.id,
)) chunks.set(c.id, c);
const bySeq = [...chunks.values()].sort((a, b) => a.seq - b.seq);
const chars = db.all<{ id: number; name: string; aliases: string }>(
  "SELECT id, name, aliases FROM canon_entity WHERE project_id = ? AND kind = 'character'",
  proj.id,
);

const norm = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim();
const low = (s: string) => norm(s).toLowerCase();
const vars = (n: string, a: string) => {
  let out = [n];
  try { const p = JSON.parse(a || '[]'); if (Array.isArray(p)) out = out.concat(p.map(String)); } catch {}
  return out;
};
const named = (v: string[], text: string) => v.some((x) => names.nameMentionedExact(x, text));

let b = 0, a = 0, d = 0, ind = 0;
const inventory: string[] = ['id,pair,kind,reason,bucket,has_chunk,quote_len'];
const records: { id: number; pair: string; kind: string; bucket: string; reason: string; quote: string; chunk?: { seq: number; text: string; locator: string }; chunkId?: number }[] = [];

for (const r of rels) {
  let chunkId: number | undefined;
  try {
    const refs = JSON.parse(r.source_refs || '[]');
    if (Array.isArray(refs)) {
      const cand = refs.map((x: { chunk?: unknown }) => Number(x?.chunk)).find((n: number) => Number.isFinite(n) && chunks.has(n));
      if (cand) chunkId = cand;
    }
  } catch {}
  const kind = low(r.kind);
  const pair = `${r.fn} -> ${r.tn}`;
  let bucket: string; let reason: string;

  if (!chunkId) { bucket = 'B'; reason = 'no-chunk'; }
  else {
    const chunk = chunks.get(chunkId)!;
    const quote = norm(r.evidence);
    const closed = lb.CLOSED_ROLE_KINDS.includes(kind);
    const grade = lb.RELATIONSHIP_GRADE_KINDS.has(kind);
    const moment = lb.isMomentKind(kind);
    if (moment || !closed || !grade) { bucket = 'D'; reason = moment ? 'moment' : 'open-vocab'; }
    else if (!low(chunk.text).includes(low(quote))) { bucket = 'I'; reason = 'quote-not-in-chunk'; }
    else if (lb.isUnsupportedKind(kind, quote)) { bucket = 'D'; reason = 'tie-word-absent'; }
    else {
      const aNamed = named(vars(r.fn, r.fa), quote);
      const bNamed = named(vars(r.tn, r.ta), quote);
      if (aNamed && bNamed) { bucket = 'A'; reason = 'both-named-in-quote'; }
      else if (aNamed || bNamed) {
        // unique referent: the unnamed side appears exactly once among characters in the chunk
        const otherVars = aNamed ? vars(r.tn, r.ta) : vars(r.fn, r.fa);
        const hits = chars.filter((c) => otherVars.some((v) => names.nameMentionedExact(v, chunk.text)));
        if (hits.length === 1) { bucket = 'A'; reason = 'unique-referent'; }
        else { bucket = 'D'; reason = 'attribution-ambiguous'; }
      } else { bucket = 'D'; reason = 'neither-named'; }
    }
  }
  if (bucket === 'A') a++; else if (bucket === 'B') b++; else if (bucket === 'D') d++; else ind++;
  inventory.push([r.id, JSON.stringify(pair), JSON.stringify(r.kind), reason, bucket, chunkId ? 1 : 0, norm(r.evidence).length].join(','));
  records.push({ id: r.id, pair, kind: r.kind, bucket, reason, quote: norm(r.evidence), chunk: chunkId ? chunks.get(chunkId) : undefined, chunkId });
}

writeFileSync(`${OUT}/inventory.csv`, inventory.join('\n') + '\n');

// Deterministic PRNG
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const rnd = rng(SEED);
const shuffle = <T>(arr: T[]): T[] => { const out = arr.slice(); for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; } return out; };

// Stratify by bucket and reason; proportional allocation with minimum where available.
const strata = new Map<string, typeof records>();
for (const r of records) {
  const key = `${r.bucket}:${r.reason}`;
  const list = strata.get(key) ?? [];
  list.push(r);
  strata.set(key, list);
}
const target = 40;
const total = records.length;
const picked: typeof records = [];
for (const [key, list] of [...strata.entries()].sort((x, y) => y[1].length - x[1].length)) {
  const want = Math.max(1, Math.min(list.length, Math.round((list.length / total) * target)));
  picked.push(...shuffle(list).slice(0, want));
  if (picked.length >= target) break;
}
// top up if short
if (picked.length < target) {
  const seen = new Set(picked.map((r) => r.id));
  for (const r of shuffle(records)) { if (picked.length >= target) break; if (!seen.has(r.id)) picked.push(r); }
}
picked.sort((x, y) => x.id - y.id);

// Packets for an independent judge: no park reason, no prior ruling.
const lines: string[] = [];
lines.push('# Blind packet — rejected relationship candidates');
lines.push('');
lines.push('For each item decide one verdict:');
lines.push('- A — the passage states a lasting relationship between the two named people (or a uniquely identifiable referent), in a relationship sense.');
lines.push('- D — a moment, co-occurrence, suspicion, title/rank, wrong pair, or someone else’s relationship.');
lines.push('- I — cannot decide from the passage.');
lines.push('');
lines.push('Judge only the passage. Do not use outside knowledge of any book.');
lines.push('Reply as CSV: id,verdict,reason (reason ≤ 10 words).');
for (const r of picked) {
  const idx = r.chunk ? bySeq.findIndex((c) => c === r.chunk) : -1;
  const context = idx >= 0 ? bySeq.slice(Math.max(0, idx - 1), idx + 2) : [];
  lines.push('');
  lines.push(`## ${r.id} — ${r.pair} — attempted kind: ${r.kind}`);
  lines.push(`QUOTE: "${r.quote}"`);
  lines.push(`LOCATOR: ${r.chunk?.locator ?? '(none)'}`);
  if (context.length) {
    lines.push('CONTEXT:');
    for (const c of context) lines.push(`--- ${c.locator} ---\n${c.text}`);
  }
}
writeFileSync(`${OUT}/sample-40.md`, lines.join('\n') + '\n');

const csv = ['id,pair,kind,locator,machine_bucket,judge_verdict'];
for (const r of picked) {
  csv.push([r.id, JSON.stringify(r.pair), JSON.stringify(r.kind), JSON.stringify(r.chunk?.locator ?? ''), r.bucket, ''].join(','));
}
writeFileSync(`${OUT}/sample-40.csv`, csv.join('\n') + '\n');

// Bucket C: character pairs sharing a passage vs pairs with a relation row.
const appears = new Map<number, Set<number>>();
for (const c of chars) {
  const set = new Set<number>();
  for (const ch of chunks.values()) if (named(vars(c.name, c.aliases), ch.text)) set.add(ch.seq);
  appears.set(c.id, set);
}
const ids = [...appears.keys()];
let sharedPairs = 0;
for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
  const A = appears.get(ids[i]!)!, B = appears.get(ids[j]!)!;
  let hit = false;
  for (const s of A) if (B.has(s)) { hit = true; break; }
  if (hit) sharedPairs++;
}
const relPairs = new Set<string>();
for (const r of db.all<{ from_entity: number; to_entity: number }>('SELECT from_entity, to_entity FROM canon_relation WHERE project_id = ?', proj.id)) {
  const k = [r.from_entity, r.to_entity].sort((x, y) => x - y).join('-');
  relPairs.add(k);
}
const withClaim = ids.reduce((n, ida, i) => n + ids.slice(i + 1).filter((idb) => relPairs.has([ida, idb].sort((x, y) => x - y).join('-'))).length, 0);

const summary = {
  records: records.length,
  bucketB: b, bucketA: a, bucketD: d, indeterminate: ind,
  sample: picked.length,
  strata: [...strata.entries()].map(([k, v]) => `${k}:${v.length}`).sort(),
  characterPairs: ids.length * (ids.length - 1) / 2,
  pairsSharingPassage: sharedPairs,
  pairsWithClaim: withClaim,
  pairsWithoutClaim: sharedPairs - withClaim,
};
writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
db.close();
