/**
 * Pair-level evidence experiment (trials, read-only).
 *
 * usage: node pair-evidence.ts <db> [out.json] [sheet.md]
 *
 * Aggregation needs several independent quotes for one pair, and the bank has
 * almost none. This collects them deterministically — every sentence in the
 * book that names both people — judges each with the configured model, and
 * writes a blind sheet so the pairs can be labelled independently.
 */
import { writeFileSync } from 'node:fs';
import { Db } from '../../../fanfable/src/core/db.ts';
import { clientFrom } from '../../../fanfable/src/core/llm.ts';
import { extractJson } from '../../../fanfable/src/core/json.ts';
import { buildRosterIndex, canonicalName, deriveNameVariants } from '../../../fanfable/src/identity/names.ts';
import { scanSentenceCandidates } from '../../../fanfable/src/lorebook.ts';

const dbPath = process.argv[2];
const outPath = process.argv[3] ?? 'testing/trials/claim-confidence/pair-evidence.json';
const sheetPath = process.argv[4] ?? 'testing/trials/claim-confidence/pair-sheet.md';
if (!dbPath) {
  console.error('usage: pair-evidence.ts <db> [out.json] [sheet.md]');
  process.exit(2);
}

const db = new Db(dbPath);
const project = db.get<{ id: number; settings: string }>("SELECT id, settings FROM project WHERE name = 'ab'")!;

const entities = db.all<{ id: number; name: string; aliases: string }>(
  'SELECT id, name, aliases FROM canon_entity WHERE project_id = ?',
  project.id,
);
const byId = new Map(entities.map((e) => [e.id, e]));
let roster: ReturnType<typeof buildRosterIndex> | null = null;
const forms = (id: number): string[] => {
  const e = byId.get(id);
  if (!e) return [];
  const explicit = [e.name, ...(JSON.parse(e.aliases || '[]') as string[])];
  const variants = roster
    ? deriveNameVariants({ name: e.name, aliases: JSON.parse(e.aliases || '[]') as string[] }, roster)
    : explicit;
  return [...new Set(variants.map(canonicalName).filter(Boolean))];
};

const chunks = db.all<{ id: number; text: string; locator: string }>(
  'SELECT id, text, locator FROM canon_chunk WHERE project_id = ? ORDER BY seq',
  project.id,
);

roster = buildRosterIndex(
  entities.map((e) => ({ name: e.name, aliases: JSON.parse(e.aliases || '[]') as string[] })),
  chunks.map((c) => c.text).join(' '),
);
const relations = db.all<{ id: number; from_entity: number; to_entity: number; kind: string; review_status: string }>(
  'SELECT id, from_entity, to_entity, kind, review_status FROM canon_relation WHERE project_id = ?',
  project.id,
);
db.close();

const pairKey = (a: number, b: number) => `${Math.min(a, b)}|${Math.max(a, b)}`;
const confirmed = new Map<string, { a: number; b: number }>();
const provisional = new Map<string, { a: number; b: number }>();
for (const r of relations) {
  const k = pairKey(r.from_entity, r.to_entity);
  if (r.review_status === 'user_confirmed') confirmed.set(k, { a: r.from_entity, b: r.to_entity });
  else if (r.review_status === 'provisional') provisional.set(k, { a: r.from_entity, b: r.to_entity });
}

const picked: { key: string; a: number; b: number; group: 'confirmed' | 'unknown' }[] = [];
for (const [k, p] of [...confirmed].slice(0, 10)) picked.push({ key: k, ...p, group: 'confirmed' });
let i = 0;
for (const [k, p] of provisional) {
  if (picked.length >= 30) break;
  if (confirmed.has(k)) continue;
  if (i++ % 3 !== 0) continue;
  picked.push({ key: k, ...p, group: 'unknown' });
  if (picked.length >= 30) break;
}

interface Quote {
  chunkId: number;
  locator: string;
  sentence: string;
  context: string;
}

const scanCandidates = scanSentenceCandidates(new Db(dbPath), project.id);
const collect = (a: number, b: number, max = 6): Quote[] => {
  const key = pairKey(a, b);
  const list = scanCandidates
    .filter((c) => pairKey(c.fromId, c.toId) === key)
    .map((c) => ({ chunkId: c.chunkId, locator: c.locator, sentence: c.sentence }));
  const seen = new Set<string>();
  const unique = list.filter((q) => {
    const k = q.sentence.trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const step = Math.max(1, Math.floor(unique.length / max));
  return unique.filter((_, idx) => idx % step === 0).slice(0, max).map((q) => {
    const chunk = chunks.find((c) => c.id === q.chunkId);
    let context = q.sentence;
    if (chunk) {
      const sentences = chunk.text.split(/(?<=[.!?])\s+/);
      const at = sentences.findIndex((x) => x.includes(q.sentence.slice(0, 60)));
      if (at >= 0) {
        context = sentences.slice(Math.max(0, at - 1), Math.min(sentences.length, at + 2)).join(' ').replace(/\s+/g, ' ').trim();
      }
    }
    return { chunkId: q.chunkId, locator: q.locator, sentence: q.sentence, context };
  });
};

const SYSTEM =
  'You read a short passage from a book. Two people are named for you. ' +
  'Decide whether the passage establishes a lasting relationship between them — family, marriage, ' +
  'a lasting role, lasting friendship or lasting enmity — as opposed to describing an event, a scene, or a moment. ' +
  'Reply with JSON only: {"lasting": true, "why": "one sentence"} or {"lasting": false, "why": "one sentence"}. ' +
  'Do not use knowledge from outside the passage.';

const llm = clientFrom({
  ...JSON.parse(project.settings || '{}'),
  ...(process.env.FANFABLE_MODEL ? { model: process.env.FANFABLE_MODEL } : {}),
});

const results: {
  key: string;
  group: string;
  from: string;
  to: string;
  quotes: { chunkId: number; lasting: boolean; why: string }[];
  positives: number;
  distinctChunks: number;
}[] = [];

for (const [n, pick] of picked.entries()) {
  const quotes = collect(pick.a, pick.b);
  const judged: { chunkId: number; lasting: boolean; why: string }[] = [];
  for (const q of quotes) {
    const res = await llm.chat({
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Passage: ${q.context}\nPeople: ${byId.get(pick.a)?.name ?? 'A'} and ${byId.get(pick.b)?.name ?? 'B'}`,
        },
      ],
      temperature: 0,
      maxTokens: Number(process.env.FANFABLE_MAX_TOKENS ?? 2000),
    });
    const parsed = extractJson<Record<string, unknown>>(res.text) ?? {};
    const lasting = parsed.lasting === true || String(parsed.lasting).toLowerCase() === 'true';
    judged.push({ chunkId: q.chunkId, lasting, why: String(parsed.why ?? '') });
  }
  const positives = judged.filter((j) => j.lasting).length;
  results.push({
    key: pick.key,
    group: pick.group,
    from: byId.get(pick.a)?.name ?? '?',
    to: byId.get(pick.b)?.name ?? '?',
    quotes: judged,
    positives,
    distinctChunks: new Set(judged.filter((j) => j.lasting).map((j) => j.chunkId)).size,
  });
  process.stderr.write(`pair ${n + 1}/${picked.length}: ${judged.length} quotes, ${positives} lasting\n`);
}

writeFileSync(outPath, JSON.stringify({ pairs: results }, null, 1));

const lines: string[] = [
  '# Pair evidence — blind sheet',
  '',
  'Each pair lists verbatim excerpts that name both people. Judge the pair, not the excerpts individually:',
  'does this book establish a lasting relationship between these two (family, marriage, lasting role, lasting friendship or enmity)?',
  '',
  '`label`: yes / no / unclear',
  '',
  '---',
  '',
];
for (const [n, pick] of picked.entries()) {
  if (pick.group !== 'unknown') continue;
  const r = results[n]!;
  lines.push(`## P${String(n + 1).padStart(2, '0')} · ${r.from} — ${r.to}`);
  lines.push('');
  const quotes = collect(pick.a, pick.b);
  quotes.forEach((q, idx) => {
    lines.push(`**${idx + 1}.** > ${q.context}`);
    lines.push('');
  });
  lines.push('```');
  lines.push('label      :');
  lines.push('note       :');
  lines.push('```');
  lines.push('');
}
writeFileSync(sheetPath, `${lines.join('\n')}\n`);

const summary = {
  pairs: results.length,
  confirmed: results.filter((r) => r.group === 'confirmed').length,
  unknown: results.filter((r) => r.group === 'unknown').length,
  quotes: results.reduce((s, r) => s + r.quotes.length, 0),
  confirmedPairsWithPositive: results.filter((r) => r.group === 'confirmed' && r.positives > 0).length,
  out: outPath,
  sheet: sheetPath,
};
console.log(JSON.stringify(summary, null, 1));
