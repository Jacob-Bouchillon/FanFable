/**
 * Build a blind adjudication sheet for person-pairs both sweep runs found.
 *
 * usage: node shared-pairs.ts <db> <run1.json> <run2.json> [sheet] [key]
 *
 * The sheet shows only what a judge needs: the two people, verbatim excerpts
 * with a sentence of context, and blank fields. It carries no run membership,
 * no agreement status, no model-written kind, and no direction.
 *
 * The key holds all of that, separately, and must not be opened until every
 * judgment is written.
 */
import { Db } from '../../../fanfable/src/core/db.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { foldPeople } from './person-fold.ts';

const dbPath = process.argv[2];
const run1Path = process.argv[3];
const run2Path = process.argv[4];
const sheetPath = process.argv[5] ?? 'testing/trials/adjudication/shared-pairs-sheet.md';
const keyPath = process.argv[6] ?? 'testing/trials/adjudication/shared-pairs-key.json';
if (!dbPath || !run1Path || !run2Path) {
  console.error('usage: shared-pairs.ts <db> <run1.json> <run2.json> [sheet] [key]');
  process.exit(2);
}

const db = new Db(dbPath);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'ab');
const entities = db.all<{ id: number; name: string; aliases: string; kind: string }>(
  'SELECT id, name, aliases, kind FROM canon_entity WHERE project_id = ?',
  proj!.id,
);
const chunks = db.all<{ text: string }>('SELECT text FROM canon_chunk WHERE project_id = ? ORDER BY seq', proj!.id);
db.close();

const { idOf, displayName } = foldPeople(entities);

interface Claim {
  from: number;
  to: number;
  a: number;
  b: number;
  kind: string;
  quote: string;
  character: string;
}
interface Run {
  characters: { character: string; ties: { to: string; kind: string; quote: string; character?: string }[] }[];
}

const load = (path: string): Claim[] => {
  const run = JSON.parse(readFileSync(path, 'utf8')) as Run;
  const out: Claim[] = [];
  for (const c of run.characters) {
    for (const t of c.ties) {
      const from = idOf(t.character ?? c.character);
      const to = idOf(t.to);
      if (from === null || to === null) continue;
      out.push({
        from,
        to,
        a: Math.min(from, to),
        b: Math.max(from, to),
        kind: t.kind,
        quote: t.quote,
        character: t.character ?? c.character,
      });
    }
  }
  return out;
};

const r1 = load(run1Path);
const r2 = load(run2Path);
const pairKey = (c: Claim) => `${c.a}|${c.b}`;
const p1 = new Set(r1.map(pairKey));
const p2 = new Set(r2.map(pairKey));
const shared = [...p1].filter((k) => p2.has(k));

// --- context index --------------------------------------------------------
// Quote -> the sentence window around it. One sentence either side is enough
// to resolve a pronoun or a title, and short enough that the judge reads
// evidence rather than a page.
const split = (text: string) => text.split(/(?<=[.!?])\s+/);
const windows = new Map<string, string>();
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const byNorm = new Map<string, string>();
for (const chunk of chunks) {
  const sentences = split(chunk.text);
  for (let i = 0; i < sentences.length; i++) {
    const from = Math.max(0, i - 1);
    const to = Math.min(sentences.length - 1, i + 1);
    const window = sentences
      .slice(from, to + 1)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(' ');
    byNorm.set(norm(sentences[i]!.trim()), window);
  }
}

let unlocated = 0;
const excerpt = (quote: string): string => {
  const direct = byNorm.get(norm(quote.trim()));
  if (!direct) unlocated++;
  return (direct ?? quote.trim()).replace(/\s+/g, ' ').trim();
};

// --- assemble -------------------------------------------------------------
const claimsByPair = new Map<string, Claim[]>();
for (const c of [...r1, ...r2]) {
  claimsByPair.set(pairKey(c), [...(claimsByPair.get(pairKey(c)) ?? []), c]);
}

interface Item {
  id: string;
  a: number;
  b: number;
  excerpts: string[];
  run1: { kinds: string[]; dirs: string[] };
  run2: { kinds: string[]; dirs: string[] };
  sameSentence: boolean;
}
const dirOf = (c: Claim): string => (c.from === c.a ? 'A>B' : 'B>A');

const items: Item[] = shared.map((key) => {
  const claims = claimsByPair.get(key) ?? [];
  const [aStr, bStr] = key.split('|');
  const a = Number(aStr);
  const b = Number(bStr);
  const run1 = claims.filter((c) => r1.includes(c));
  const run2 = claims.filter((c) => r2.includes(c));
  // At most one excerpt from each run, so the judge sees the evidence a run
  // actually had rather than a pile that makes a weak pair look established.
  const q1 = run1[0]?.quote ?? '';
  const q2 = run2.find((c) => c.quote !== q1)?.quote ?? '';
  const selected = [q1, q2].filter(Boolean);
  const quotes1 = [...new Set(run1.map((c) => c.quote))];
  const quotes2 = [...new Set(run2.map((c) => c.quote))];
  return {
    id: '',
    a,
    b,
    excerpts: selected.map(excerpt),
    run1: { kinds: [...new Set(run1.map((c) => c.kind))], dirs: [...new Set(run1.map(dirOf))] },
    run2: { kinds: [...new Set(run2.map((c) => c.kind))], dirs: [...new Set(run2.map(dirOf))] },
    sameSentence: quotes1.some((q) => quotes2.includes(q)),
  };
});

// Deterministic shuffle: stable across reruns, but not alphabetical, so
// adjacent items do not share a character and invite pattern-matching.
const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
items.sort((x, y) => hash(`${x.a}|${x.b}`) - hash(`${y.a}|${y.b}`));
items.forEach((item, i) => {
  item.id = `S${String(i + 1).padStart(2, '0')}`;
});

// --- sheet ----------------------------------------------------------------
const lines: string[] = [
  '# Shared person-pairs — blind adjudication',
  '',
  'Each item names two people and shows verbatim excerpts from the source, with one sentence of context either side. Judge only what the excerpts establish.',
  '',
  '**support** — pick one:',
  '- `supported` — the excerpts state a lasting relationship between these two people, and the words do so for these two, not for somebody else.',
  '- `context` — the two are connected in the scene, but no lasting relationship is stated (they merely appear together, speak, or are present).',
  '- `unsupported` — nothing in the excerpts connects them.',
  '- `identity` — the excerpts cannot tell which person one of the names refers to.',
  '',
  '**kind** — the relationship in a few words, as the excerpts state it (e.g. brother, teacher, rival). Write `none` when support is not `supported`.',
  '',
  '**direction** — write `A` when the first-named person is the one the kind describes ("A is the brother"), `B` when the second-named is, `both` when the relation is symmetric, `none` when it is not stated.',
  '',
  'Do not consult any other file. Do not infer from outside knowledge of the source.',
  '',
  '---',
  '',
];

for (const item of items) {
  const nameA = displayName(item.a);
  const nameB = displayName(item.b);
  lines.push(`## ${item.id} · ${nameA} — ${nameB}`);
  lines.push('');
  item.excerpts.forEach((text, i) => {
    lines.push(`**Excerpt ${String.fromCharCode(65 + i)}**`);
    lines.push('');
    lines.push(`> ${text}`);
    lines.push('');
  });
  lines.push('```');
  lines.push('support    :');
  lines.push('kind       :');
  lines.push('direction  :');
  lines.push('note       :');
  lines.push('```');
  lines.push('');
}

writeFileSync(sheetPath, `${lines.join('\n')}\n`);

// --- key ------------------------------------------------------------------
writeFileSync(
  keyPath,
  JSON.stringify(
    {
      built: { run1: run1Path, run2: run2Path, at: new Date().toISOString() },
      items: items.map((item) => ({
        id: item.id,
        pair: [displayName(item.a), displayName(item.b)],
        run1: item.run1,
        run2: item.run2,
        sameSentence: item.sameSentence,
        excerpts: item.excerpts.length,
      })),
    },
    null,
    1,
  ),
);

const withTwo = items.filter((i) => i.excerpts.length > 1).length;

console.log(
  JSON.stringify(
    {
      items: items.length,
      distinctExcerpts: items.reduce((n, i) => n + i.excerpts.length, 0),
      pairsWithOneExcerpt: items.length - withTwo,
      pairsWithTwoOrMore: withTwo,
      sameSentenceInBothRuns: items.filter((i) => i.sameSentence).length,
      sheet: sheetPath,
      key: keyPath,
      excerptsWithoutContext: unlocated,
    },
    null,
    1,
  ),
);
