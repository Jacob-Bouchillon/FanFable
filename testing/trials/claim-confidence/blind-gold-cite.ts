/**
 * Citation check (trials, read-only, 42 labelled rows).
 *
 * usage: node blind-gold-cite.ts [out.json]
 *
 * Same passages, same pairs, same model as the blind run. One extra question:
 * quote the sentence that establishes the relationship, or return none. A
 * quoted sentence proves it exists in the passage; whether it supports the
 * claim is measured separately.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Db } from '../../../fanfable/src/db.ts';
import { clientFrom } from '../../../fanfable/src/llm.ts';
import { extractJson } from '../../../fanfable/src/json.ts';
import { canonicalName } from '../../../fanfable/src/names.ts';

const outPath = process.argv[2] ?? 'testing/trials/claim-confidence/blind-gold-cite.json';

const verdicts = new Map<number, string>();
for (const line of readFileSync('testing/trials/adjudication/gold-verdicts-v2.txt', 'utf8').split('\n')) {
  for (const part of line.split(',')) {
    if (!part.includes(':')) continue;
    const [k, v] = part.split(':');
    verdicts.set(Number(k), v.trim());
  }
}
const goldMap = JSON.parse(readFileSync('testing/trials/adjudication/gold-map.json', 'utf8')) as {
  gold: number;
  db: string;
  relId: number;
  kind: string;
}[];

const SYSTEM =
  'You read a short passage from a book. Two people are named for you. ' +
  'Decide whether the passage establishes a lasting relationship between them — family, marriage, a lasting role, ' +
  'lasting friendship or lasting enmity. Then quote the exact sentence from the passage that establishes it. ' +
  'Reply with JSON only: {"lasting": true|false, "support": "one sentence copied verbatim from the passage, or empty"}. ' +
  'If no sentence in the passage establishes the relationship, set lasting false and support empty. ' +
  'Do not use knowledge from outside the passage.';

const dbCache = new Map<string, Db>();
const chunkCache = new Map<string, Map<number, string>>();
let llm: ReturnType<typeof clientFrom> | null = null;

const rows: {
  gold: number;
  actual: string;
  kind: string;
  lasting: boolean;
  support: string;
  verbatim: boolean;
  namesBoth: boolean;
}[] = [];

for (const [i, entry] of goldMap.entries()) {
  const path = `testing/trials/model-ab/${entry.db}.db`;
  let db = dbCache.get(path);
  if (!db) {
    db = new Db(path);
    dbCache.set(path, db);
    const project = db.get<{ id: number; settings: string }>('SELECT id, settings FROM project LIMIT 1');
    if (!llm) {
      llm = clientFrom({
        ...JSON.parse(project?.settings || '{}'),
        ...(process.env.FANFABLE_MODEL ? { model: process.env.FANFABLE_MODEL } : {}),
      });
    }
    const chunks = new Map<number, string>();
    if (project) {
      for (const c of db.all<{ id: number; text: string }>('SELECT id, text FROM canon_chunk WHERE project_id = ?', project.id)) {
        chunks.set(c.id, c.text);
      }
    }
    chunkCache.set(path, chunks);
  }
  const row = db.get<{ a: string; b: string; refs: string; evidence: string }>(
    `SELECT a.name AS a, b.name AS b, coalesce(r.source_refs,'[]') AS refs, r.evidence
       FROM canon_relation r JOIN canon_entity a ON a.id=r.from_entity JOIN canon_entity b ON b.id=r.to_entity
      WHERE r.id = ?`,
    entry.relId,
  );
  if (!row) continue;
  let passage = '';
  const chunks = chunkCache.get(path);
  try {
    const refs = JSON.parse(row.refs) as { chunk?: unknown }[];
    if (typeof refs[0]?.chunk === 'number') {
      const text = chunks?.get(refs[0]!.chunk as number);
      if (text) {
        const sentences = text.split(/(?<=[.!?])\s+/);
        const indeed = row.evidence.trim().slice(0, 80);
        const at = sentences.findIndex((x) => x.includes(indeed));
        passage =
          at >= 0
            ? sentences.slice(Math.max(0, at - 1), Math.min(sentences.length, at + 2)).join(' ').replace(/\s+/g, ' ').trim()
            : row.evidence.trim();
      }
    }
  } catch {
    /* none */
  }
  if (!passage) continue;

  const res = await llm!.chat({
    system: SYSTEM,
    messages: [{ role: 'user', content: `Passage: ${passage}\nPeople: ${row.a} and ${row.b}` }],
    temperature: 0,
    maxTokens: Number(process.env.FANFABLE_MAX_TOKENS ?? 2000),
  });
  const parsed = extractJson<Record<string, unknown>>(res.text) ?? {};
  const lasting = parsed.lasting === true || String(parsed.lasting).toLowerCase() === 'true';
  const support = String(parsed.support ?? '').trim();
  const normPassage = canonicalName(passage);
  const verbatim = support.length > 0 && normPassage.includes(canonicalName(support));
  const namesBoth =
    canonicalName(support).includes(canonicalName(row.a).split(' ')[0] ?? '') &&
    canonicalName(support).includes(canonicalName(row.b).split(' ')[0] ?? '');
  rows.push({
    gold: entry.gold,
    actual: verdicts.get(entry.gold) === 'S' ? 'supported' : 'unsupported',
    kind: entry.kind,
    lasting,
    support,
    verbatim,
    namesBoth,
  });
  process.stderr.write(`cite ${i + 1}/${goldMap.length}\n`);
}

const cell = (actual: string, pred: boolean) => rows.filter((r) => r.actual === actual && r.lasting === pred);
const summary = {
  rows: rows.length,
  positives: rows.filter((r) => r.lasting).length,
  tp: cell('supported', true).length,
  fp: cell('unsupported', true).length,
  fn: cell('supported', false).length,
  tn: cell('unsupported', false).length,
  fpWithoutCitation: cell('unsupported', true).filter((r) => !r.verbatim).length,
  tpWithCitation: cell('supported', true).filter((r) => r.verbatim).length,
  tpWithBothNames: cell('supported', true).filter((r) => r.namesBoth).length,
  citationsVerbatim: rows.filter((r) => r.support && r.verbatim).length,
  citationsNotVerbatim: rows.filter((r) => r.support && !r.verbatim).length,
};
writeFileSync(outPath, JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify({ ...summary, out: outPath }, null, 1));
