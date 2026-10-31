import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/core/db.ts';
import * as names from '/home/jacob/Documents/FanFable/fanfable/src/identity/names.ts';
import * as lb from '/home/jacob/Documents/FanFable/fanfable/src/lorebook.ts';
import { mkdirSync, writeFileSync } from 'node:fs';

const DB = '/home/jacob/Documents/FanFable/testing/trials/halfbook-run/plagueis-half.db';
const OUT = '/home/jacob/Documents/FanFable/testing/trials/bucketing';
const SEED = 42;
mkdirSync(OUT, { recursive: true });

const db = new Db(DB);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'halfbook')!;

const rels = db.all<{
  id: number; kind: string; evidence: string; source_refs: string;
  fn: string; fa: string; tn: string; ta: string;
}>(
  `SELECT r.id, r.kind, r.evidence, r.source_refs,
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
  'SELECT id, seq, text, locator FROM canon_chunk WHERE project_id = ? ORDER BY seq', proj.id,
)) chunks.set(c.id, c);
const bySeq = [...chunks.values()].sort((a, b) => a.seq - b.seq);
const chars = db.all<{ id: number; name: string; aliases: string }>(
  "SELECT id, name, aliases FROM canon_entity WHERE project_id = ? AND kind = 'character'", proj.id,
);
const norm = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim();
const low = (s: string) => norm(s).toLowerCase();
const vars = (n: string, a: string) => {
  let o = [n];
  try { const p = JSON.parse(a || '[]'); if (Array.isArray(p)) o = o.concat(p.map(String)); } catch {}
  return o;
};
const named = (v: string[], t: string) => v.some((x) => names.nameMentionedExact(x, t));

type Rec = { id: number; pair: string; kind: string; quote: string; bucket: string; reason: string; chunk?: { seq: number; text: string; locator: string } };
const recs: Rec[] = [];
let counts: Record<string, number> = { A: 0, "A'": 0, B: 0, D: 0, I: 0 };

for (const r of rels) {
  let chunkId: number | undefined;
  try {
    const refs = JSON.parse(r.source_refs || '[]');
    if (Array.isArray(refs)) {
      chunkId = refs.map((x: { chunk?: unknown }) => Number(x?.chunk)).find((n: number) => Number.isFinite(n) && chunks.has(n));
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
    const word = !lb.isUnsupportedKind(r.kind, quote);
    const aNamed = named(vars(r.fn, r.fa), quote);
    const bNamed = named(vars(r.tn, r.ta), quote);

    if (!low(chunk.text).includes(low(quote))) { bucket = 'I'; reason = 'quote-not-in-chunk'; }
    else if (moment) { bucket = 'D'; reason = 'moment'; }
    else if (!closed) {
      // Open vocabulary: a real relationship, expressed outside our list?
      if (word && aNamed && bNamed) { bucket = "A'"; reason = 'unmapped-vocab-both-named'; }
      else if (word) { bucket = "A'"; reason = 'unmapped-vocab-one-named'; }
      else { bucket = 'D'; reason = 'open-vocab-no-tie-word'; }
    }
    else if (!grade) { bucket = 'D'; reason = 'not-grade'; }
    else if (!word) { bucket = 'D'; reason = 'tie-word-absent'; }
    else if (aNamed && bNamed) { bucket = 'A'; reason = 'both-named-in-quote'; }
    else if (aNamed || bNamed) {
      const otherVars = aNamed ? vars(r.tn, r.ta) : vars(r.fn, r.fa);
      const hits = chars.filter((c) => otherVars.some((v) => names.nameMentionedExact(v, chunk.text)));
      if (hits.length === 1) { bucket = 'A'; reason = 'unique-referent'; }
      else { bucket = 'D'; reason = 'attribution-ambiguous'; }
    } else { bucket = 'D'; reason = 'neither-named'; }
  }
  counts[bucket] = (counts[bucket] ?? 0) + 1;
  recs.push({ id: r.id, pair, kind: r.kind, quote: norm(r.evidence), bucket, reason, chunk: chunkId ? chunks.get(chunkId) : undefined });
}

// Deterministic sample
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const rnd = rng(SEED);
const shuffle = <T>(arr: T[]): T[] => { const o = arr.slice(); for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [o[i], o[j]] = [o[j]!, o[i]!]; } return o; };
const strata = new Map<string, Rec[]>();
for (const r of recs) {
  const k = `${r.bucket}:${r.reason}`;
  const list = strata.get(k) ?? []; list.push(r); strata.set(k, list);
}
const target = 40;
const picked: Rec[] = [];
const total = recs.length;
for (const [, list] of [...strata.entries()].sort((x, y) => y[1].length - x[1].length)) {
  const want = Math.max(1, Math.min(list.length, Math.round((list.length / total) * target)));
  picked.push(...shuffle(list).slice(0, want));
}
const seen = new Set(picked.map((r) => r.id));
for (const r of shuffle(recs)) { if (picked.length >= target) break; if (!seen.has(r.id)) { picked.push(r); seen.add(r.id); } }
picked.sort((a, b) => a.id - b.id);

const lines: string[] = [];
lines.push('# Blind packet — rejected relationship candidates');
lines.push('');
lines.push('For each item give one verdict:');
lines.push('');
lines.push('- **A** — the passage states a lasting relationship between the two people, using a wording from our closed list (family, ally, enemy, master, apprentice, aide, teacher, member, friend, etc.).');
lines.push("- **A'** — the passage states a lasting relationship between the two people, but the wording is outside our closed list (e.g. \"receives orders from\", \"resident of\", \"served under\"). Say which wording in the reason.");
lines.push('- **D** — not a lasting relationship: a moment, an action, co-occurrence, a suspicion, a title or rank, a different pair, or a metaphor.');
lines.push('- **I** — cannot decide from the passage.');
lines.push('');
lines.push('Judge only the passage. Do not use outside knowledge of any book.');
lines.push('Reply as CSV: id,verdict,reason — reason at most 12 words, and for A\' include the wording used.');
lines.push('');
for (const r of picked) {
  const idx = r.chunk ? bySeq.findIndex((c) => c === r.chunk) : -1;
  const ctx = idx >= 0 ? bySeq.slice(Math.max(0, idx - 1), idx + 2) : [];
  lines.push(`## ${r.id} — ${r.pair} — attempted kind: ${r.kind}`);
  lines.push(`QUOTE: "${r.quote}"`);
  lines.push(`LOCATOR: ${r.chunk?.locator ?? '(none)'}`);
  for (const c of ctx) lines.push(`--- ${c.locator} ---\n${c.text}`);
  lines.push('');
}
writeFileSync(`${OUT}/sample-40.md`, lines.join('\n') + '\n');

const csv = ['id,pair,kind,locator,machine_bucket,judge_verdict'];
for (const r of picked) csv.push([r.id, JSON.stringify(r.pair), JSON.stringify(r.kind), JSON.stringify(r.chunk?.locator ?? ''), r.bucket, ''].join(','));
writeFileSync(`${OUT}/sample-40.csv`, csv.join('\n') + '\n');
writeFileSync(`${OUT}/summary-2.json`, JSON.stringify({ counts, sample: picked.length, strata: [...strata.entries()].map(([k, v]) => `${k}:${v.length}`) }, null, 2));
console.log(JSON.stringify({ counts, sample: picked.length, strata: [...strata.entries()].map(([k, v]) => `${k}:${v.length}`) }, null, 2));
db.close();
