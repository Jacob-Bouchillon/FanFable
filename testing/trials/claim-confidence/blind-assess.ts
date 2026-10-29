/**
 * Blind assessment control (trials, read-only).
 *
 * usage: node blind-assess.ts <db> [limit] [out.json]
 *
 * The claim-aware assessment hands the model the pair AND the kind, then asks
 * how strongly the quote supports it. This asks only what the sentence
 * establishes between the two named people, with no kind supplied, so its
 * answer can be compared with the claim it was previously asked to endorse.
 */
import { writeFileSync } from 'node:fs';
import { Db } from '../../../fanfable/src/db.ts';
import { clientFrom } from '../../../fanfable/src/llm.ts';
import { extractJson } from '../../../fanfable/src/json.ts';

const dbPath = process.argv[2];
const limit = Number(process.argv[3] ?? 0);
const outPath = process.argv[4] ?? 'testing/trials/claim-confidence/blind-assess.json';
if (!dbPath) {
  console.error('usage: blind-assess.ts <db> [limit] [out.json]');
  process.exit(2);
}

const db = new Db(dbPath);
const project = db.get<{ id: number; settings: string }>("SELECT id, settings FROM project WHERE name = 'ab'")!;
const chunkText = new Map<number, string>();
for (const c of db.all<{ id: number; text: string }>('SELECT id, text FROM canon_chunk WHERE project_id = ?', project?.id ?? 0)) {
  chunkText.set(c.id, c.text);
}
const rows = db.all<{
  id: number;
  from_name: string;
  to_name: string;
  kind: string;
  evidence: string;
  confidence: number;
  source_refs: string;
}>(
  `SELECT r.id, a.name AS from_name, b.name AS to_name, r.kind, r.evidence, r.confidence,
          coalesce(r.source_refs, '[]') AS source_refs
     FROM canon_relation r
     JOIN canon_entity a ON a.id = r.from_entity
     JOIN canon_entity b ON b.id = r.to_entity
    WHERE r.project_id = ? AND trim(r.evidence) != ''
    ORDER BY r.id`,
  project.id,
);
db.close();
const list = limit > 0 ? rows.slice(0, limit) : rows;

const windowFor = (evidence: string, refs: string): string => {
  let chunk: number | null = null;
  try {
    const list = JSON.parse(refs) as { chunk?: unknown }[];
    const first = list[0]?.chunk;
    if (typeof first === 'number') chunk = first;
  } catch {
    /* no refs */
  }
  const text = chunk === null ? undefined : chunkText.get(chunk);
  if (!text) return evidence;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const needle = evidence.trim().slice(0, 80);
  const at = sentences.findIndex((sentence) => sentence.includes(needle));
  if (at < 0) return evidence;
  return sentences
    .slice(Math.max(0, at - 1), Math.min(sentences.length, at + 2))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const llm = clientFrom(JSON.parse(project.settings || '{}'));

const SYSTEM =
  'You read one sentence from a book. Two people are named for you. ' +
  'Decide whether the sentence establishes a lasting relationship between them — family, marriage, ' +
  'a lasting role, lasting friendship or lasting enmity — as opposed to describing an event, a scene, or a moment. ' +
  'Reply with JSON only: {"relationship":"lasting|moment|none","kind":"your own short description, or empty","why":"one sentence"}. ' +
  'A sentence that only places them together, has them speak, or describes an action establishes a moment, not a lasting relationship. ' +
  'Do not use knowledge from outside the sentence.';

const out: {
  id: number;
  pair: string;
  claimedKind: string;
  priorConfidence: number;
  relationship: string;
  kind: string;
  why: string;
}[] = [];

for (const [i, row] of list.entries()) {
  const res = await llm.chat({
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Passage: ${windowFor(row.evidence, row.source_refs)}\nPeople: ${row.from_name} and ${row.to_name}`,
      },
    ],
    temperature: 0,
    maxTokens: 200,
  });
  const parsed = extractJson<Record<string, unknown>>(res.text) ?? {};
  out.push({
    id: row.id,
    pair: `${row.from_name} -> ${row.to_name}`,
    claimedKind: row.kind,
    priorConfidence: row.confidence,
    relationship: String(parsed.relationship ?? 'none').toLowerCase(),
    kind: String(parsed.kind ?? ''),
    why: String(parsed.why ?? ''),
  });
  process.stderr.write(`blind ${i + 1}/${list.length}\n`);
}

const summary = (threshold: number) => {
  const band = out.filter((r) => r.priorConfidence >= threshold);
  return {
    n: band.length,
    none: band.filter((r) => r.relationship === 'none').length,
    stated: band.filter((r) => r.relationship === 'stated').length,
    implied: band.filter((r) => r.relationship === 'implied').length,
  };
};

writeFileSync(outPath, JSON.stringify({ rows: out }, null, 1));
console.log(
  JSON.stringify(
    {
      rows: out.length,
      none: out.filter((r) => r.relationship === 'none').length,
      lasting: out.filter((r) => r.relationship === 'lasting').length,
      moment: out.filter((r) => r.relationship === 'moment').length,
      priorHigh: summary(0.9),
      priorMid: summary(0.7),
      out: outPath,
    },
    null,
    1,
  ),
);
