/**
 * Discovery comparison metrics, read-only on the scratch arms.
 * Writes compare.md and sample-b.csv; no source or bank writes.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { nameMentionedExact } from '../../../fanfable/src/names.ts';

const DIR = '/home/jacob/Documents/FanFable/testing/trials/discovery-cmp';
const ARMS = [
  { key: 'a', label: 'A current' },
  { key: 'b', label: 'B liberal' },
  { key: 'c', label: 'C liberal + roster' },
  { key: 'b2', label: 'B repeat' },
  { key: 'a2', label: 'A repeat' },
];
const FILLER = new Set(['of', 'to', 'with', 'for', 'a', 'an', 'the', 'in', 'on', 'as', 'by', 'from']);

const normalise = (text) => String(text ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9' ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function mentions(name, aliases, text) {
  return nameMentionedExact(name, text) || JSON.parse(aliases || '[]').some((alias) => nameMentionedExact(alias, text));
}

function tieWordIn(kind, evidence) {
  const words = normalise(kind).split(' ').filter((word) => word && !FILLER.has(word));
  if (!words.length) return false;
  const quote = new Set(normalise(evidence).split(' ').filter(Boolean));
  return words.some((word) => quote.has(word) || quote.has(`${word}s`) || quote.has(`${word}es`));
}

function metrics(key) {
  const raw = new DatabaseSync(`${DIR}/${key}.db`, { readOnly: true });
  const project = raw.prepare('SELECT id FROM project LIMIT 1').get();
  const rows = raw.prepare(`SELECT r.id, r.kind, r.evidence, r.source_refs,
      a.name fn, a.aliases fa, b.name tn, b.aliases ta
    FROM canon_relation r JOIN canon_entity a ON a.id = r.from_entity JOIN canon_entity b ON b.id = r.to_entity
    WHERE r.project_id = ? ORDER BY r.id`).all(project.id);
  let locatable = 0, tieWord = 0, namesBanked = 0, sameChunkPair = 0, triageable = 0;
  for (const row of rows) {
    let refs = [];
    try { refs = JSON.parse(row.source_refs || '[]'); } catch {}
    const chunkId = refs.find((ref) => ref && ref.chunk)?.chunk;
    const chunk = chunkId ? raw.prepare('SELECT text FROM canon_chunk WHERE id = ?').get(chunkId) : null;
    const evidence = String(row.evidence ?? '');
    const isLocatable = !!chunk && !!normalise(evidence) && normalise(chunk.text).includes(normalise(evidence));
    const isTieWord = tieWordIn(row.kind, evidence);
    const isBanked = mentions(row.fn, row.fa, evidence) || mentions(row.tn, row.ta, evidence);
    const isSameChunk = !!chunk && mentions(row.fn, row.fa, chunk.text) && mentions(row.tn, row.ta, chunk.text);
    if (isLocatable) locatable++;
    if (isTieWord) tieWord++;
    if (isBanked) namesBanked++;
    if (isSameChunk) sameChunkPair++;
    if (isLocatable && isBanked && isSameChunk) triageable++;
  }
  const pairs = raw.prepare(`SELECT COUNT(*) n FROM (
      SELECT DISTINCT MIN(from_entity, to_entity) x, MAX(from_entity, to_entity) y
      FROM canon_relation WHERE project_id = ?)`).get(project.id).n;
  let report = null;
  try {
    report = JSON.parse(raw.prepare('SELECT value FROM schema_meta WHERE key = ?').get(`lore-extraction:${project.id}`).value);
  } catch {}
  const log = readFileSync(`${DIR}/${key}.log`, 'utf8');
  const minutes = Math.round((Number(/seconds=(\d+)/.exec(log)?.[1] ?? 0) / 6)) / 10;
  raw.close();
  return {
    key,
    claims: rows.length,
    pairs,
    locatable,
    tieWord,
    namesBanked,
    sameChunkPair,
    triageable,
    empty: report?.emptyWindows?.length ?? 0,
    minutes,
    triageablePerMinute: minutes ? +(triageable / minutes).toFixed(2) : 0,
  };
}

const results = ARMS.map((arm) => ({ ...arm, ...metrics(arm.key) }));
const byKey = Object.fromEntries(results.map((row) => [row.key, row]));
const ratio = (value, base) => (base ? +(value / base).toFixed(2) : 0);

const lines = [];
lines.push('# Discovery comparison — current vs liberal relations prompt', '');
lines.push('Same 10 windows, qwen2.5:7b, seed 42, one run per arm. All counts are stored relations after the unchanged gates.', '');
lines.push('| Arm | Claims | Distinct pairs | Locatable evidence | Tie word in evidence | Evidence names a banked endpoint | Same-chunk pair | Triageable | Empty windows | Minutes | Triageable/min |');
lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const row of results.filter((entry) => ['a', 'b', 'c'].includes(entry.key))) {
  lines.push(`| ${row.label} | ${row.claims} | ${row.pairs} | ${row.locatable} | ${row.tieWord} | ${row.namesBanked} | ${row.sameChunkPair} | **${row.triageable}** | ${row.empty} | ${row.minutes} | ${row.triageablePerMinute} |`);
}
lines.push('');
lines.push('Definitions: *locatable* = the stored quote appears in the cited chunk; *tie word* = a content word of the model kind appears in the quote; *names a banked endpoint* = the quote names at least one endpoint by name or alias; *same-chunk pair* = the cited chunk names both endpoints; *triageable* = locatable + banked endpoint + same-chunk pair.');
lines.push('');
if (byKey.b && byKey.a) {
  lines.push(`B/A claims ratio: **${ratio(byKey.b.claims, byKey.a.claims)}×**; B/A triageable ratio: **${ratio(byKey.b.triageable, byKey.a.triageable)}×**.`);
  lines.push(`C/A claims ratio: **${ratio(byKey.c.claims, byKey.a.claims)}×**; C/A triageable ratio: **${ratio(byKey.c.triageable, byKey.a.triageable)}×**.`);
  lines.push('');
}
const eligible = results.filter((row) => row.key !== 'b2');
const winner = eligible.slice().sort((x, y) => y.triageablePerMinute - x.triageablePerMinute)[0];
lines.push(`Repeat variance: arm A (a vs a2) — claims ${byKey.a.claims} vs ${byKey.a2.claims}, triageable ${byKey.a.triageable} vs ${byKey.a2.triageable}.`);
lines.push('');
lines.push(`Repeat variance: arm B (b vs b2) — claims ${byKey.b.claims} vs ${byKey.b2.claims}, triageable ${byKey.b.triageable} vs ${byKey.b2.triageable}.`);
lines.push('');
lines.push('Determinism check: **failed**. With seed 42 and concurrency 1, identical imports and window selection still produced different claim counts (A 37 vs 20; B 24 vs 18). The single-run arm differences are therefore not separable from run variance.');
lines.push('');
lines.push(`**Verdict:** ${winner.label} has the highest triageable claims per minute (${winner.triageablePerMinute}/min, ${winner.triageable} triageable from ${winner.claims} claims), but the determinism check failed: rerun variance is larger than the between-arm differences, so this is not a reliable winner.`);
lines.push('Do not adopt the liberal prompt on this evidence; re-run with repeated arms after making extraction state reproducible.');
writeFileSync(`${DIR}/compare.md`, lines.join('\n') + '\n');

// First 20 arm-B claims: pair, model wording, locator only.
const rawB = new DatabaseSync(`${DIR}/b.db`, { readOnly: true });
const pB = rawB.prepare('SELECT id FROM project LIMIT 1').get().id;
const claims = rawB.prepare(`SELECT r.kind, r.source_refs, a.name fn, b.name tn
  FROM canon_relation r JOIN canon_entity a ON a.id = r.from_entity JOIN canon_entity b ON b.id = r.to_entity
  WHERE r.project_id = ? ORDER BY r.id LIMIT 20`).all(pB);
const csv = (value) => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const sample = [['pair', 'model wording', 'locator']];
for (const claim of claims) {
  let refs = [];
  try { refs = JSON.parse(claim.source_refs || '[]'); } catch {}
  sample.push([`${claim.fn} — ${claim.tn}`, claim.kind, refs.find((ref) => ref && ref.locator)?.locator ?? '']);
}
writeFileSync(`${DIR}/sample-b.csv`, sample.map((row) => row.map(csv).join(',')).join('\n') + '\n');
rawB.close();

console.log(JSON.stringify({ results, winner: winner.key, b2: byKey.b2 }, null, 2));
