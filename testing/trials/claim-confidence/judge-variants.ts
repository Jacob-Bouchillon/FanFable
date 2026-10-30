/**
 * Judge prompt variants (trials, 42 labelled rows, no production changes).
 *
 * usage: node judge-variants.ts <variant> [out.json]
 *
 * All variants run on qwen3.5:9b (Q4) at temperature 0, seed 42 (override with
 * JUDGE_SEED). Scored against the three-way blind labels: "establishes" (plus
 * "reinforces" where the variant reports it) is the positive class.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Db } from '../../../fanfable/src/db.ts';
import { clientFrom } from '../../../fanfable/src/llm.ts';
import { extractJson } from '../../../fanfable/src/json.ts';

const variant = process.argv[2] ?? 'base';
const outPath = process.argv[3] ?? `testing/trials/claim-confidence/judge-${variant}.json`;

const labels = new Map<number, string>();
for (const line of readFileSync('testing/trials/adjudication/gold-three-way-labels.tsv', 'utf8').split('\n')) {
  const [sheet, label] = line.trim().split('\t');
  if (!sheet) continue;
  labels.set(Number(sheet.replace('T', '')), label);
}
const key = JSON.parse(readFileSync('testing/trials/adjudication/gold-three-way-key.json', 'utf8')) as {
  sheet: string;
  gold: number;
}[];
const labelOf = new Map<number, string>();
for (const k of key) labelOf.set(k.gold, labels.get(Number(k.sheet.replace('T', ''))) ?? 'unclear');

const goldMap = JSON.parse(readFileSync('testing/trials/adjudication/gold-map.json', 'utf8')) as {
  gold: number;
  db: string;
  relId: number;
}[];
const rowsById = new Map(goldMap.map((g) => [g.gold, g]));

const PROMPTS: Record<string, { system: string; positive: (parsed: Record<string, unknown>) => boolean }> = {
  base: {
    system:
      'You read a short passage from a book. Two people are named for you. ' +
      'Decide whether the passage establishes a lasting relationship between them — family, marriage, a lasting role, ' +
      'lasting friendship or lasting enmity — as opposed to describing an event, a scene, or a moment. ' +
      'Reply with JSON only: {"lasting": true|false, "why": "one sentence"}. ' +
      'Do not use knowledge from outside the passage.',
    positive: (p) => p.lasting === true || String(p.lasting).toLowerCase() === 'true',
  },
  categories: {
    system:
      'You read a short passage from a book. Two people are named for you. Decide what the passage does about their relationship. ' +
      'Reply with JSON only: {"relation":"establishes|reinforces|mentions|none","why":"one sentence"}. ' +
      'establishes: the passage itself provides the evidence from which the relationship can be identified. ' +
      'reinforces: the passage presupposes a relationship established elsewhere ("their partnership", "his wife"). ' +
      'mentions: both appear, but no relationship is stated or presupposed. ' +
      'Do not use knowledge from outside the passage.',
    positive: (p) => String(p.relation).toLowerCase() === 'establishes' || String(p.relation).toLowerCase() === 'reinforces',
  },
  bounded: {
    system:
      'You read a short passage from a book. Two people are named for you. ' +
      'Decide whether this passage states or presupposes a lasting relationship between them. ' +
      'The relationship may well be true in the book: judge only this passage. ' +
      'If the passage merely places them together, has them speak, or describes an action, answer false. ' +
      'Reply with JSON only: {"lasting": true|false, "why": "one sentence"}. ' +
      'Do not use knowledge from outside the passage.',
    positive: (p) => p.lasting === true || String(p.lasting).toLowerCase() === 'true',
  },
  fixed: {
    system:
      'You read a short passage from a book. Two people are named for you. ' +
      'Decide whether this passage states or presupposes a lasting relationship between them. ' +
      'Two names that refer to the same person are NOT a relationship — if the two names are one person, answer false. ' +
      'A family title used in the passage (aunt, uncle, nephew, parent, and so on) establishes what it names. ' +
      'The relationship may well be true in the book: judge only this passage. ' +
      'If the passage merely places them together, has them speak, or describes an action, answer false. ' +
      'Reply with JSON only: {"lasting": true|false, "why": "one sentence"}. ' +
      'Do not use knowledge from outside the passage.',
    positive: (p) => p.lasting === true || String(p.lasting).toLowerCase() === 'true',
  },
  fixed2: {
    system:
      'You read a short passage from a book. Two people are named for you. ' +
      'Decide whether this passage states or presupposes a lasting relationship between them. ' +
      'Two names that refer to the same person are NOT a relationship — if the two names are one person, answer false. ' +
      'An epithet or role noun used in the passage for one of the two named people is IDENTITY, not a second party: ' +
      'for example, a species or kind noun with "the" that refers to a named individual present in the passage. ' +
      'A tie between that named person and their own epithet is not a relationship — answer false. ' +
      'A family title plus surname used as a contiguous run in the passage (for example a kin-title such as "Aunt" ' +
      'followed by a surname) establishes what it names, even when the surrounding sentence action involves a third person. ' +
      'A title alone never proves a tie to whoever stands next to them, and direction stays unknown from a title alone. ' +
      'The relationship may well be true in the book: judge only this passage. ' +
      'If the passage merely places them together, has them speak, or describes an action, answer false. ' +
      'Reply with JSON only: {"lasting": true|false, "why": "one sentence"}. ' +
      'Do not use knowledge from outside the passage.',
    positive: (p) => p.lasting === true || String(p.lasting).toLowerCase() === 'true',
  },
  fixed3: {
    system:
      'You read a short passage from a book. Two people are named for you. ' +
      'Decide whether this passage states or presupposes a lasting relationship between them. ' +
      'Two names that refer to the same person are NOT a relationship — if the two names are one person, answer false. ' +
      'An epithet or role noun used in the passage for one of the two named people is IDENTITY, not a second party: ' +
      'for example, a species or kind noun with "the" that refers to a named individual present in the passage. ' +
      'A tie between that named person and their own epithet is not a relationship — answer false. ' +
      'A family title used in the passage (aunt, uncle, nephew, parent, and so on) establishes what it names. ' +
      'The relationship may well be true in the book: judge only this passage. ' +
      'If the passage merely places them together, has them speak, or describes an action, answer false. ' +
      'Reply with JSON only: {"lasting": true|false, "why": "one sentence"}. ' +
      'Do not use knowledge from outside the passage.',
    positive: (p) => p.lasting === true || String(p.lasting).toLowerCase() === 'true',
  },
};

const spec = PROMPTS[variant];
if (!spec) {
  console.error(`unknown variant ${variant}; use ${Object.keys(PROMPTS).join(', ')}`);
  process.exit(2);
}

const dbCache = new Map<string, Db>();
const chunkCache = new Map<string, Map<number, string>>();
let llm: ReturnType<typeof clientFrom> | null = null;

const out: { gold: number; label: string; predicted: boolean; why: string }[] = [];

for (const entry of goldMap) {
  const path = `testing/trials/model-ab/${entry.db}.db`;
  let db = dbCache.get(path);
  if (!db) {
    db = new Db(path);
    dbCache.set(path, db);
    const project = db.get<{ id: number; settings: string }>('SELECT id, settings FROM project LIMIT 1');
    if (!llm) {
      const base = JSON.parse(project?.settings || '{}');
      const seed = Number(process.env.JUDGE_SEED ?? 42);
      llm = clientFrom({ ...base, model: process.env.JUDGE_MODEL ?? 'qwen3.5:9b', temperature: 0, seed, maxTokens: 2048 });
    }
    const chunks = new Map<number, string>();
    if (project) {
      for (const c of db.all<{ id: number; text: string }>('SELECT id, text FROM canon_chunk WHERE project_id = ?', project.id)) {
        chunks.set(c.id, c.text);
      }
    }
    chunkCache.set(path, chunks);
  }
  const row = db.get<{ a: string; b: string; evidence: string; refs: string }>(
    `SELECT a.name AS a, b.name AS b, r.evidence, coalesce(r.source_refs,'[]') AS refs
       FROM canon_relation r JOIN canon_entity a ON a.id=r.from_entity JOIN canon_entity b ON b.id=r.to_entity
      WHERE r.id = ?`,
    entry.relId,
  );
  if (!row) continue;
  let passage = row.evidence.trim();
  try {
    const refs = JSON.parse(row.refs) as { chunk?: unknown }[];
    const chunkId = typeof refs[0]?.chunk === 'number' ? (refs[0]!.chunk as number) : null;
    const text = chunkId === null ? undefined : chunkCache.get(path)?.get(chunkId);
    if (text) {
      const sentences = text.split(/(?<=[.!?])\s+/);
      const at = sentences.findIndex((s) => s.includes(row.evidence.trim().slice(0, 80)));
      if (at >= 0) {
        passage = sentences
          .slice(Math.max(0, at - 1), Math.min(sentences.length, at + 2))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
    }
  } catch {
    /* keep the quote */
  }

  const res = await llm!.chat({
    system: spec.system,
    messages: [{ role: 'user', content: `Passage: ${passage}\nPeople: ${row.a} and ${row.b}` }],
    temperature: 0,
    maxTokens: 2048,
  });
  const parsed = extractJson<Record<string, unknown>>(res.text) ?? {};
  out.push({ gold: entry.gold, label: labelOf.get(entry.gold) ?? 'unclear', predicted: spec.positive(parsed), why: String(parsed.why ?? '') });
  process.stderr.write(`${variant} ${out.length}/${goldMap.length}\n`);
}

const tp = out.filter((r) => r.label === 'establishes' && r.predicted).length;
const fp = out.filter((r) => r.label !== 'establishes' && r.predicted).length;
const fn = out.filter((r) => r.label === 'establishes' && !r.predicted).length;
const tn = out.filter((r) => r.label !== 'establishes' && !r.predicted).length;
writeFileSync(outPath, JSON.stringify({ variant, rows: out }, null, 1));
console.log(
  JSON.stringify(
    { variant, tp, fp, fn, tn, precision: Number((tp / Math.max(tp + fp, 1)).toFixed(2)), recall: Number((tp / Math.max(tp + fn, 1)).toFixed(2)), out: outPath },
    null,
    1,
  ),
);
