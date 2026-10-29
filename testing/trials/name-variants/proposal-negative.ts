/**
 * Negative control for a pair-classifier proposal stage (trials, read-only).
 *
 * usage: node proposal-negative.ts [negatives] [positives]
 *
 * Takes chunks ARF annotated as containing no relationship, gives the model the
 * same relation prompt the extractor uses, and counts what it proposes. Fifty
 * positives run alongside so a quiet result can be told apart from a model that
 * simply never proposes anything.
 */
import { writeFileSync } from 'node:fs';
import { clientFrom } from '../../../fanfable/src/llm.ts';
import { relationsSystemPrompt } from '../../../fanfable/src/lorebook.ts';
import { extractJson } from '../../../fanfable/src/json.ts';
import { Db } from '../../../fanfable/src/db.ts';

const NEG = Number(process.argv[2] ?? 50);
const POS = Number(process.argv[3] ?? 50);
const DB = 'testing/trials/model-ab/hp3.db';
const OUT = 'testing/trials/name-variants/proposal-negative.json';

const base =
  'https://datasets-server.huggingface.co/rows?dataset=Despina%2Fproject_gutenberg' +
  '&config=synthetic_relations_in_fiction_books&split=train&offset={}&length=100';

const parseList = (v: unknown): Record<string, unknown>[] => {
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  if (typeof v !== 'string') return [];
  for (const parse of [JSON.parse, (s: string) => Function(`return (${s});`)()]) {
    try {
      const out = parse(v);
      if (Array.isArray(out)) return out as Record<string, unknown>[];
    } catch {
      /* next */
    }
  }
  return [];
};

const rows: { chunk: string; relations: Record<string, unknown>[] }[] = [];
for (let page = 0; page < 15; page++) {
  let got: { rows?: { row: Record<string, unknown> }[] } | null = null;
  for (let attempt = 0; attempt < 3 && !got; attempt++) {
    try {
      const res = await fetch(base.replace('{}', String(page * 100)), { signal: AbortSignal.timeout(60_000) });
      got = (await res.json()) as { rows?: { row: Record<string, unknown> }[] };
    } catch {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  for (const item of got?.rows ?? []) {
    const chunk = String(item.row.chunk ?? '');
    if (chunk.trim()) rows.push({ chunk, relations: parseList(item.row.relations) });
  }
}

const negatives = rows.filter((r) => r.relations.length === 0);
const positives = rows.filter((r) => r.relations.length > 0);
const spread = <T>(list: T[], n: number): T[] => {
  if (list.length <= n) return list;
  const step = list.length / n;
  return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)]!);
};

const db = new Db(DB);
const project = db.get<{ id: number; settings: string }>("SELECT id, settings FROM project WHERE name = 'ab'")!;
db.close();
const llm = clientFrom(JSON.parse(project.settings || '{}'));

const STOP = new Set(['the', 'a', 'an', 'and', 'but', 'or', 'i', 'he', 'she', 'they', 'it', 'we', 'you', 'his', 'her', 'their', 'my', 'our', 'your', 'when', 'then', 'there', 'this', 'that', 'what', 'who', 'how', 'why', 'if', 'so', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'to', 'with']);
const rosterOf = (text: string): string[] => {
  const names = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)\b/g)) {
    const name = m[1]!.trim();
    if (STOP.has(name.toLowerCase())) continue;
    names.add(name);
  }
  return [...names].slice(0, 40);
};

const ask = async (chunk: string): Promise<{ from: string; to: string; kind: string }[]> => {
  const names = rosterOf(chunk);
  const system = `${relationsSystemPrompt()}\n\nKNOWN ENTITIES:\n${names.map((n) => `- ${n}`).join('\n')}`;
  const res = await llm.chat({
    system,
    messages: [{ role: 'user', content: `PASSAGES:\n[#0] untitled | chunk\n${chunk.slice(0, 1800)}` }],
    temperature: 0.2,
    maxTokens: 1500,
  });
  const parsed = extractJson<Record<string, unknown>>(res.text) ?? {};
  const list = Array.isArray(parsed.relations) ? (parsed.relations as Record<string, unknown>[]) : [];
  return list
    .map((r) => ({ from: String(r.from ?? '').trim(), to: String(r.to ?? '').trim(), kind: String(r.kind ?? '').trim() }))
    .filter((r) => r.from && r.to);
};

const key = (s: string) => s.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();

const runSet = async (set: typeof rows, label: string) => {
  const results: { proposals: { from: string; to: string; kind: string }[]; matched: boolean }[] = [];
  for (const [i, row] of set.entries()) {
    const proposals = await ask(row.chunk);
    const annotated = new Set<string>();
    for (const rel of row.relations) {
      annotated.add(key(String(rel.entity1 ?? '')));
      annotated.add(key(String(rel.entity2 ?? '')));
    }
    const matched = proposals.some(
      (p) => annotated.has(key(p.from)) || annotated.has(key(p.to)),
    );
    results.push({ proposals, matched });
    process.stderr.write(`${label} ${i + 1}/${set.length}: ${proposals.length} proposals\n`);
  }
  return results;
};

const negResults = await runSet(spread(negatives, NEG), 'neg');
const posResults = await runSet(spread(positives, POS), 'pos');

const summary = (results: typeof negResults) => ({
  chunks: results.length,
  withProposal: results.filter((r) => r.proposals.length > 0).length,
  proposals: results.reduce((n, r) => n + r.proposals.length, 0),
});

writeFileSync(
  OUT,
  JSON.stringify(
    {
      sampled: { negativesAvailable: negatives.length, positivesAvailable: positives.length },
      negative: { ...summary(negResults), detail: negResults.map((r) => r.proposals) },
      positive: { ...summary(posResults), matched: posResults.filter((r) => r.matched).length, detail: posResults.map((r) => r.proposals) },
    },
    null,
    1,
  ),
);
console.log(JSON.stringify({
  negativesAvailable: negatives.length,
  positivesAvailable: positives.length,
  negative: summary(negResults),
  positive: { ...summary(posResults), matched: posResults.filter((r) => r.matched).length },
  out: OUT,
}));
