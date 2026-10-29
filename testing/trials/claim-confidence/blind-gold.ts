/**
 * Blind read over the labelled gold rows that still have a database identity
 * (trials, read-only).
 *
 * usage: node blind-gold.ts [out.json]
 *
 * The gold key keeps 226 ids but only the 42-row map keeps relId, so those are
 * the rows that can be joined back. Each is read with one sentence of context
 * either side, no claim supplied, against the same lasting-relationship
 * standard the human adjudicator used.
 */
import { writeFileSync } from 'node:fs';
import { Db } from '../../../fanfable/src/db.ts';
import { clientFrom } from '../../../fanfable/src/llm.ts';
import { extractJson } from '../../../fanfable/src/json.ts';

const outPath = process.argv[2] ?? 'testing/trials/claim-confidence/blind-gold.json';

const verdicts = new Map<number, string>();
for (const line of (await import('node:fs')).readFileSync('testing/trials/adjudication/gold-verdicts.txt', 'utf8').split('\n')) {
  for (const part of line.split(',')) {
    if (!part.includes(':')) continue;
    const [k, v] = part.split(':');
    verdicts.set(Number(k), v.trim());
  }
}
const map = JSON.parse(
  (await import('node:fs')).readFileSync('testing/trials/adjudication/gold-map.json', 'utf8'),
) as { gold: number; db: string; relId: number; kind: string }[];

const SYSTEM =
  'You read a short passage from a book. Two people are named for you. ' +
  'Decide whether the passage establishes a lasting relationship between them — family, marriage, ' +
  'a lasting role, lasting friendship or lasting enmity — as opposed to describing an event, a scene, or a moment. ' +
  'Reply with JSON only: {"lasting": true, "why": "one sentence"} or {"lasting": false, "why": "one sentence"}. ' +
  'Do not use knowledge from outside the passage.';

const rows: { gold: number; verdict: string; kind: string; relationship: string; why: string }[] = [];
const dbCache = new Map<string, Db>();
const chunkCache = new Map<string, Map<number, string>>();
let llm: ReturnType<typeof clientFrom> | null = null;

for (const [i, entry] of map.entries()) {
  const path = `testing/trials/model-ab/${entry.db}.db`;
  let db = dbCache.get(path);
  if (!db) {
    db = new Db(path);
    dbCache.set(path, db);
    const p = db.get<{ id: number }>("SELECT id FROM project WHERE name = 'ab'") ?? db.get<{ id: number }>('SELECT id FROM project LIMIT 1');
    if (!llm) {
      const project = db.get<{ settings: string }>('SELECT settings FROM project LIMIT 1');
      const base = JSON.parse(project?.settings || '{}');
      llm = clientFrom({ ...base, ...(process.env.FANFABLE_MODEL ? { model: process.env.FANFABLE_MODEL } : {}) });
    }
    const chunks = new Map<number, string>();
    if (p) {
      for (const c of db.all<{ id: number; text: string }>('SELECT id, text FROM canon_chunk WHERE project_id = ?', p.id)) {
        chunks.set(c.id, c.text);
      }
    }
    chunkCache.set(path, chunks);
  }
  const row = db.get<{ from_name: string; to_name: string; kind: string; evidence: string; source_refs: string }>(
    `SELECT a.name AS from_name, b.name AS to_name, r.kind, r.evidence, coalesce(r.source_refs,'[]') AS source_refs
       FROM canon_relation r JOIN canon_entity a ON a.id=r.from_entity JOIN canon_entity b ON b.id=r.to_entity
      WHERE r.id = ?`,
    entry.relId,
  );
  if (!row || !row.evidence.trim()) continue;

  let chunkId: number | null = null;
  try {
    const refs = JSON.parse(row.source_refs) as { chunk?: unknown }[];
    if (typeof refs[0]?.chunk === 'number') chunkId = refs[0]!.chunk as number;
  } catch {
    /* none */
  }
  const text = chunkId === null ? undefined : chunkCache.get(path)?.get(chunkId);
  let passage = row.evidence;
  if (text) {
    const sentences = text.split(/(?<=[.!?])\s+/);
    const needle = row.evidence.trim().slice(0, 80);
    const at = sentences.findIndex((s) => s.includes(needle));
    if (at >= 0) {
      passage = sentences
        .slice(Math.max(0, at - 1), Math.min(sentences.length, at + 2))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  const mask = process.env.FANFABLE_MASK_NAMES === '1';
  const strip = (text: string): string => {
    if (!mask) return text;
    let out = text;
    for (const [name, label] of [[row.from_name, 'Person A'], [row.to_name, 'Person B']] as const) {
      const parts = [name, ...name.split(/\s+/)].filter((part) => part.length >= 3);
      for (const part of parts) {
        out = out.replace(new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), label);
      }
    }
    return out;
  };
  const res = await llm!.chat({
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: mask
          ? `Passage: ${strip(passage)}\nPeople: Person A and Person B`
          : `Passage: ${passage}\nPeople: ${row.from_name} and ${row.to_name}`,
      },
    ],
    temperature: 0,
    maxTokens: Number(process.env.FANFABLE_MAX_TOKENS ?? 200),
  });
  const parsed = extractJson<Record<string, unknown>>(res.text) ?? {};
  rows.push({
    gold: entry.gold,
    verdict: verdicts.get(entry.gold) ?? '?',
    kind: entry.kind,
    relationship: parsed.lasting === true || String(parsed.lasting).toLowerCase() === 'true' ? 'lasting' : 'not-lasting',
    why: String(parsed.why ?? ''),
  });
  process.stderr.write(`gold ${i + 1}/${map.length}\n`);
}

const tp = rows.filter((r) => r.verdict === 'S' && r.relationship === 'lasting').length;
const fp = rows.filter((r) => r.verdict !== 'S' && r.relationship === 'lasting').length;
const fn = rows.filter((r) => r.verdict === 'S' && r.relationship !== 'lasting').length;
const tn = rows.filter((r) => r.verdict !== 'S' && r.relationship !== 'lasting').length;

writeFileSync(outPath, JSON.stringify({ rows }, null, 1));
console.log(
  JSON.stringify(
    {
      rows: rows.length,
      positives: rows.filter((r) => r.verdict === 'S').length,
      distribution: rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.relationship] = (acc[r.relationship] ?? 0) + 1;
        return acc;
      }, {}),
      confusion: { tp, fp, fn, tn },
      precision: Number((tp / Math.max(tp + fp, 1)).toFixed(2)),
      recall: Number((tp / Math.max(tp + fn, 1)).toFixed(2)),
      out: outPath,
    },
    null,
    1,
  ),
);
