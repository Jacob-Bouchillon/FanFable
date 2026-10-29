/**
 * Compare two sweep runs (trials only).
 *
 * usage: node compare-runs.ts <db> <run1.json> <run2.json>
 *
 * Pairs are canonicalised twice:
 *   1. entity -> person, folding roster duplicates (a name nested in another,
 *      or a shared surname with a compatible given name: "Ron"/"Ronald").
 *   2. kind -> head, reduced to a relation word so "younger sister" and
 *      "sister of" compare equal.
 * Direction is reported separately rather than folded into the key, because a
 * reversed claim is a disagreement, not a miss.
 */
import { Db } from '../../../fanfable/src/db.ts';
import { readFileSync } from 'node:fs';
import { foldPeople } from './person-fold.ts';

const dbPath = process.argv[2];
const run1Path = process.argv[3];
const run2Path = process.argv[4];
if (!dbPath || !run1Path || !run2Path) {
  console.error('usage: compare-runs.ts <db> <run1.json> <run2.json>');
  process.exit(2);
}

const db = new Db(dbPath);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'ab');
const entities = db.all<{ id: number; name: string; aliases: string }>(
  'SELECT id, name, aliases FROM canon_entity WHERE project_id = ?',
  proj!.id,
);
db.close();

const { personOf, idOf, personCount } = foldPeople(entities);

// --- kind folding ---------------------------------------------------------
const RELATION_HEADS = [
  'wife', 'husband', 'spouse', 'mother', 'father', 'parent', 'son', 'daughter', 'child',
  'brother', 'sister', 'sibling', 'aunt', 'uncle', 'nephew', 'niece', 'cousin',
  'grandfather', 'grandmother', 'grandson', 'granddaughter', 'stepfather', 'stepmother',
  'friend', 'friendship', 'rival', 'rivalry', 'enemy', 'enmity', 'ally', 'mentor',
  'student', 'teacher', 'colleague', 'guardian', 'employer', 'servant', 'master',
  'fiance', 'fiancee', 'married', 'engaged', 'widow', 'widower',
];
const STOP = new Set(['of', 'to', 'with', 'for', 'a', 'an', 'the', 'in', 'on', 'as', 'his', 'her', 'their', "'s"]);
const headOf = (kind: string): string => {
  const words = kind.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const word of words) if (RELATION_HEADS.includes(word)) return word;
  return words.find((w) => !STOP.has(w)) ?? words[0] ?? '';
};

interface Claim {
  from: number;
  to: number;
  a: number;
  b: number;
  kind: string;
  key: string;
  quote: string;
  character: string;
}
interface Run {
  characters: { character: string; ties: { to: string; kind: string; quote: string; character?: string }[] }[];
}

let unresolved = 0;
const load = (path: string): Claim[] => {
  const run = JSON.parse(readFileSync(path, 'utf8')) as Run;
  const out: Claim[] = [];
  for (const c of run.characters) {
    for (const t of c.ties) {
      const from = idOf(t.character ?? c.character);
      const to = idOf(t.to);
      if (from === null || to === null) {
        unresolved++;
        continue;
      }
      const a = Math.min(from, to);
      const b = Math.max(from, to);
      out.push({
        from,
        to,
        a,
        b,
        kind: headOf(t.kind),
        key: `${a}|${b}|${headOf(t.kind)}`,
        quote: t.quote,
        character: t.character ?? c.character,
      });
    }
  }
  return out;
};

const r1 = load(run1Path);
const r2 = load(run2Path);

// Collapse duplicate claims inside a run before comparing (a character swept
// twice because the roster holds both "Harry" and "Harry Potter" produces two
// copies of the same claim).
const collapse = (claims: Claim[]): Map<string, Claim> => {
  const m = new Map<string, Claim>();
  for (const c of claims) {
    const prev = m.get(c.key);
    if (!prev || c.quote.length > prev.quote.length) m.set(c.key, c);
  }
  return m;
};
const m1 = collapse(r1);
const m2 = collapse(r2);

const shared = [...m1.keys()].filter((k) => m2.has(k));
const only1 = [...m1.keys()].filter((k) => !m2.has(k));
const only2 = [...m2.keys()].filter((k) => !m1.has(k));
const sameSentence = shared.filter((k) => m1.get(k)!.quote === m2.get(k)!.quote).length;
const sameDirection = shared.filter((k) => {
  const a = m1.get(k)!;
  const b = m2.get(k)!;
  return a.from === b.from && a.to === b.to;
}).length;
const reversed = shared.length - sameDirection;

// Pair-level: do the runs agree on *who* before they agree on the relation word?
const pairKey = (c: Claim) => `${c.a}|${c.b}`;
const p1 = new Set([...m1.values()].map(pairKey));
const p2 = new Set([...m2.values()].map(pairKey));
const sharedPairs = [...p1].filter((p) => p2.has(p));

const label = (claim: Claim | undefined): string => (claim ? `${claim.character} -> ${claim.kind}` : '');

console.log(
  JSON.stringify(
    {
      people: personCount,
      run1: { raw: r1.length, claims: m1.size },
      run2: { raw: r2.length, claims: m2.size },
      unresolved,
      shared: shared.length,
      only1: only1.length,
      only2: only2.length,
      sameSentence,
      differentSentence: shared.length - sameSentence,
      sameDirection,
      reversed,
      pairs: {
        run1: p1.size,
        run2: p2.size,
        shared: sharedPairs.length,
        only1: p1.size - sharedPairs.length,
        only2: p2.size - sharedPairs.length,
      },
      sharedSample: shared.slice(0, 15).map((k) => label(m1.get(k))),
      only1Sample: only1.slice(0, 15).map((k) => label(m1.get(k))),
      only2Sample: only2.slice(0, 15).map((k) => label(m2.get(k))),
    },
    null,
    1,
  ),
);
