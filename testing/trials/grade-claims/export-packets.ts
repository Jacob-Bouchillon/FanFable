/**
 * Export citable claims as blind grading packets for an external model.
 *
 * Read-only on the database. Writes four files to the output directory:
 *   grade-packets.md  the prompt + every packet (give this to the model)
 *   packets.jsonl     the same packets as JSON, for API batching
 *   sample.csv        id,pair,stratum,pop_weight,locators (score-unproposed shape)
 *   key.csv           id -> relation ids and the clues the judge must NOT see
 *
 * The packet carries the pair, the claimed kind, the quote and the cited
 * passage. It deliberately carries no review status, confidence, assessment
 * or human flag: the judge grades the evidence, not our history.
 *
 * Usage:
 *   node --no-warnings testing/trials/grade-claims/export-packets.ts <db> <project> [outDir]
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isMomentKind, storedAssessment } from '../../../fanfable/src/lorebook.ts';

const [dbPath, projectName, outRaw] = process.argv.slice(2);
if (!dbPath || !projectName) {
  throw new Error('usage: export-packets.ts <db> <project> [outDir]');
}
const outDir = resolve(outRaw ?? 'testing/trials/grade-claims/out');
mkdirSync(outDir, { recursive: true });

/** Co-presence labels are not relationships; the concept set is not exported. */
const COVERAGE = new Set(['appears with', 'appears in', 'cooccurrence', 'co-occurrence']);
const canon = (kind: string): string =>
  String(kind ?? '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

const db = new DatabaseSync(resolve(dbPath), { readOnly: true });
const project = db
  .prepare('SELECT id FROM project WHERE name = ?')
  .get(projectName) as { id: number } | undefined;
if (!project) throw new Error(`no project named "${projectName}"`);
const projectId = project.id;

interface Row {
  id: number;
  f: number;
  t: number;
  kind: string;
  evidence: string;
  source_refs: string;
  confidence: number;
  review_status: string;
  supporting_evidence: string;
  confirmed_by_user: number;
  from_name: string;
  from_aliases: string;
  to_name: string;
  to_aliases: string;
}
const rows = db
  .prepare(
    `SELECT r.id, r.from_entity AS f, r.to_entity AS t, r.kind, r.evidence, r.source_refs,
            r.confidence, r.review_status, r.supporting_evidence, r.confirmed_by_user,
            a.name AS from_name, a.aliases AS from_aliases, b.name AS to_name, b.aliases AS to_aliases
       FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ?
        AND r.review_status IN ('accepted','attested','user_confirmed')
        AND a.kind = 'character' AND b.kind = 'character'
      ORDER BY r.id`,
  )
  .all(projectId) as unknown as Row[];

const chunks = new Map<number, { text: string; locator: string }>();
for (const chunk of db
  .prepare('SELECT id, text, locator FROM canon_chunk WHERE project_id = ?')
  .all(projectId) as unknown as { id: number; text: string; locator: string }[]) {
  chunks.set(chunk.id, { text: chunk.text, locator: chunk.locator });
}
db.close();

const aliasesOf = (json: string): string[] => {
  try {
    const list = JSON.parse(json || '[]') as unknown[];
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
};
const names = (row: Row): string[] => [row.from_name, ...aliasesOf(row.from_aliases)];
const namesTo = (row: Row): string[] => [row.to_name, ...aliasesOf(row.to_aliases)];
const quoteNamesBoth = (row: Row): boolean => {
  const q = row.evidence.toLowerCase();
  return names(row).some((n) => q.includes(n.toLowerCase())) && namesTo(row).some((n) => q.includes(n.toLowerCase()));
};
const positive = (row: Row): boolean => {
  const a = storedAssessment(row.supporting_evidence);
  return !!a && a.asserted !== false && a.kind_fit !== 'no';
};
const chunkIdOf = (row: Row): number | null => {
  try {
    for (const ref of JSON.parse(row.source_refs || '[]') as { chunk?: unknown }[]) {
      const n = Number(ref?.chunk);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    /* no refs */
  }
  return null;
};

// One packet per pair: the claim with the strongest evidence is the one a
// reviewer should see first. Other claims on the pair stay in key.csv.
const byPair = new Map<string, Row[]>();
for (const row of rows) {
  const kind = canon(row.kind);
  if (COVERAGE.has(kind) || isMomentKind(kind)) continue;
  const key = `${Math.min(row.f, row.t)}:${Math.max(row.f, row.t)}`;
  const list = byPair.get(key) ?? [];
  list.push(row);
  byPair.set(key, list);
}

const strength = (row: Row): number =>
  (quoteNamesBoth(row) ? 8 : 0) + (positive(row) ? 4 : 0) + (row.confidence >= 0.7 ? 2 : 0) + Math.min(2, row.evidence.length / 120);

interface Packet {
  id: string;
  pair: string;
  a: string;
  b: string;
  kind: string;
  quote: string;
  locator: string;
  passage: string;
  claimId: number;
  relationIds: number[];
  signal: 'human' | 'assessed' | 'sentence-proof' | 'none';
}
const packets: Packet[] = [];
for (const list of byPair.values()) {
  const best = [...list].sort((x, y) => strength(y) - strength(x) || x.id - y.id)[0]!;
  const chunkId = chunkIdOf(best);
  const chunk = chunkId === null ? undefined : chunks.get(chunkId);
  if (!chunk) continue;
  const human = list.some((r) => r.review_status === 'user_confirmed' || r.confirmed_by_user === 1);
  const assessed = list.some(positive);
  const sentence = list.some(quoteNamesBoth);
  packets.push({
    id: '',
    pair: `${best.from_name} / ${best.to_name}`,
    a: best.from_name,
    b: best.to_name,
    kind: canon(best.kind),
    quote: best.evidence.trim(),
    locator: chunk.locator,
    passage: chunk.text,
    claimId: best.id,
    relationIds: list.map((r) => r.id),
    signal: human ? 'human' : assessed ? 'assessed' : sentence ? 'sentence-proof' : 'none',
  });
}

// Deterministic shuffle so packet order carries no information.
const seed = 42;
let state = seed >>> 0;
const rand = (): number => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
for (let i = packets.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [packets[i], packets[j]] = [packets[j]!, packets[i]!];
}
packets.forEach((packet, i) => {
  packet.id = `P${String(i + 1).padStart(3, '0')}`;
});

const preamble = `# Relationship evidence grading

You are grading whether the supplied passage of a novel establishes the relationship
claimed between two named characters. Judge **only from the passage**. Do not use
outside knowledge of the book, the series or the characters.

Each packet gives a pair, the claimed relationship (read it as "from has this
relationship toward to"), the exact quote that was cited, and the passage the quote
was taken from. The quote may name one person, or neither (using a pronoun or an
epithet); the passage is where you resolve that.

## Verdicts

- **A** — one sentence states or clearly presupposes this relationship between these two people.
  A question, command or aside that uses the relationship ("your master", "his brother",
  "my apprentice") counts, as long as the passage makes the referent clear.
- **B** — the passage establishes the relationship, but it takes more than one sentence
  (a pronoun or epithet resolved elsewhere in the passage, or two sentences together).
- **C** — the passage does not establish it: mere co-presence, a one-off action or
  meeting, a different relationship than the one claimed, the same person twice, or
  someone else entirely.
- **D** — the passage does not let you decide.

The test is whether a careful reader would agree the tie is stated or assumed, not
whether the sentence is declarative. Naming a person, or asking whether they were
seen, is not a relationship. If the relationship exists but the claimed kind is
wrong, the verdict is **C**.

## Reply format

Reply with one CSV block and nothing else (a fenced \`csv\` block is fine):

\`\`\`
id,verdict,quote,locator,reason
P001,B,"exact sentence(s) copied from the passage",p. 12,ok
P002,C,,,cooccurrence
\`\`\`

- \`verdict\`: A, B, C or D.
- \`quote\`: for A and B, the exact sentence or sentences from the passage that
  establish it, copied character for character; empty for C and D.
- \`locator\`: copy the packet's locator.
- \`reason\`: one of \`ok\`, \`kind\`, \`identity\`, \`moment\`, \`cooccurrence\`, \`no-evidence\`,
  \`unclear\`, optionally followed by a few words.

Every packet must appear exactly once, in the order given. Do not add commentary.

`;

const body = packets
  .map(
    (packet) =>
      `### ${packet.id}\n` +
      `PAIR: ${packet.a} / ${packet.b}\n` +
      `CLAIM: ${packet.a} — ${packet.kind} — ${packet.b}\n` +
      `QUOTE: "${packet.quote}"\n` +
      `LOCATOR: ${packet.locator || '(none)'}\n` +
      `PASSAGE:\n${packet.passage}\n`,
  )
  .join('\n---\n\n');

writeFileSync(resolve(outDir, 'grade-packets.md'), `${preamble}${body}`, 'utf8');
writeFileSync(
  resolve(outDir, 'packets.jsonl'),
  `${packets
    .map((packet) =>
      JSON.stringify({ id: packet.id, pair: packet.pair, kind: packet.kind, quote: packet.quote, locator: packet.locator, passage: packet.passage }),
    )
    .join('\n')}\n`,
  'utf8',
);
writeFileSync(
  resolve(outDir, 'sample.csv'),
  `id,pair,stratum,pop_weight,locators\n${packets
    .map((packet) => `${packet.id},"${packet.pair.replace(/"/g, '""')}",census,1,"${packet.locator.replace(/"/g, '""')}"`)
    .join('\n')}\n`,
  'utf8',
);
writeFileSync(
  resolve(outDir, 'key.csv'),
  `id,pair,claim_id,relation_ids,signal\n${packets
    .map((packet) => `${packet.id},"${packet.pair.replace(/"/g, '""')}",${packet.claimId},"${packet.relationIds.join(' ')}",${packet.signal}`)
    .join('\n')}\n`,
  'utf8',
);

const words = packets.reduce((sum, packet) => sum + packet.passage.split(/\s+/).filter(Boolean).length, 0);
const signals = packets.reduce<Record<string, number>>((acc, packet) => {
  acc[packet.signal] = (acc[packet.signal] ?? 0) + 1;
  return acc;
}, {});
console.log(`packets ${packets.length} (from ${rows.length} citable rows, ${byPair.size} pairs)`);
console.log(`passage words ${words} (~${Math.round(words / 0.75)} tokens)`);
console.log(`signals (kept in key.csv, never in the packet): ${JSON.stringify(signals)}`);
console.log(`wrote ${outDir}`);
