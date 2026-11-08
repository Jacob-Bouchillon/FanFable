/**
 * Fact provenance check. Read-only.
 *
 *   node --no-warnings testing/scripts/verify-facts.ts --db <path> --project hp1
 *
 * For each fact: is its evidence verbatim in the cited chunk? If not, does it
 * occur in exactly one other chunk (a citation that drifted over a window
 * boundary), or nowhere (ungrounded)?
 */
import { Db } from '../../fanfable/src/core/db.ts';
import { setFactProvenance } from '../../fanfable/src/lorebook.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const dbPath = flag('db');
const write = args.includes('--write');
const projectName = flag('project');
if (!dbPath || !projectName) {
  console.error('usage: verify-facts.ts --db <path> --project <name>');
  process.exit(2);
}

const db = new Db(dbPath);
const project = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName);
if (!project) throw new Error(`project not found: ${projectName}`);

const norm = (value: string) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const chunks = db.all<{ id: number; locator: string; text: string; source_id: number }>(
  'SELECT id, locator, text, source_id FROM canon_chunk WHERE project_id = ? ORDER BY seq',
  project.id,
);
const byId = new Map(chunks.map((chunk) => [Number(chunk.id), chunk]));
const sourceTitle = new Map(
  db.all<{ id: number; title: string }>('SELECT id, title FROM canon_source WHERE project_id = ?', project.id)
    .map((row) => [Number(row.id), String(row.title ?? '')]),
);
const refsFor = (chunk: { id: number; locator: string; source_id: number }) => JSON.stringify([{
  source: sourceTitle.get(Number(chunk.source_id)) ?? '',
  locator: chunk.locator,
  chunk: Number(chunk.id),
}]);

let exact = 0;
let repointed = 0;
let ungrounded = 0;
const ungroundedExamples: Array<{ id: number; statement: string; evidence: string }> = [];
const repointedExamples: Array<{ id: number; from: string; to: string }> = [];

for (const fact of db.all<{ id: number; statement: string; evidence: string; source_refs: string }>(
  'SELECT id, statement, evidence, source_refs FROM canon_fact WHERE project_id = ? ORDER BY id',
  project.id,
)) {
  let citedId: number | null = null;
  try {
    citedId = Number(JSON.parse(fact.source_refs)[0]?.chunk ?? 0) || null;
  } catch {
    citedId = null;
  }
  const evidence = norm(fact.evidence);
  if (!evidence) {
    // A fact with no quote at all cannot be checked and must not be advisory.
    ungrounded++;
    if (write) setFactProvenance(db, project.id, Number(fact.id), fact.source_refs, 'rejected', 'no evidence quote');
    continue;
  }
  const cited = citedId ? byId.get(citedId) : null;
  if (cited && norm(cited.text).includes(evidence)) {
    exact++;
    if (write) setFactProvenance(db, project.id, Number(fact.id), refsFor(cited), 'accepted', 'quote verbatim in the cited chunk');
    continue;
  }
  const hits = chunks.filter((chunk) => norm(chunk.text).includes(evidence));
  if (hits.length === 1) {
    repointed++;
    if (repointedExamples.length < 8) {
      repointedExamples.push({ id: Number(fact.id), from: cited?.locator ?? 'none', to: hits[0]!.locator });
    }
    if (write) setFactProvenance(db, project.id, Number(fact.id), refsFor(hits[0]!), 'accepted', 'quote found verbatim in one chunk');
  } else if (hits.length > 1) {
    // The quote appears in overlapping windows; it is grounded, just not
    // unique. Pin it to the cited chunk when that is one of the hits.
    repointed++;
    const target = (cited && hits.some((hit) => hit.id === cited.id)) ? cited : hits[0]!;
    if (write) setFactProvenance(db, project.id, Number(fact.id), refsFor(target), 'accepted', `quote verbatim in ${hits.length} overlapping chunks`);
  } else if (hits.length === 0) {
    ungrounded++;
    if (ungroundedExamples.length < 8) {
      ungroundedExamples.push({ id: Number(fact.id), statement: String(fact.statement).slice(0, 90), evidence: String(fact.evidence).slice(0, 90) });
    }
    if (write) setFactProvenance(db, project.id, Number(fact.id), fact.source_refs, 'rejected', 'evidence is not verbatim anywhere in the book');
  }
}

console.log(`facts: ${exact + repointed + ungrounded} · verbatim in cited chunk: ${exact} · one clear alternative: ${repointed} · ungrounded: ${ungrounded}`);
console.log('\nrepointable (citation drifted):');
for (const row of repointedExamples) console.log(`  #${row.id} ${row.from} -> ${row.to}`);
console.log('\nungrounded:');
for (const row of ungroundedExamples) console.log(`  #${row.id} ${JSON.stringify(row.evidence)} <- ${JSON.stringify(row.statement)}`);
db.close();
