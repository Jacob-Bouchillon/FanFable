/**
 * Names that only ever occur inside a hedge ("might have been", "perhaps",
 * "or X") are not people in the story.
 *
 *   node --no-warnings testing/scripts/check-hypothetical.ts --db <path> --project hp1 [--write]
 *
 * Only entities with no ties, no facts and no summary are considered, and only
 * when *every* occurrence sits in a hedged sentence.
 */
import { Db } from '../../fanfable/src/core/db.ts';
import { quarantineEntity } from '../../fanfable/src/lorebook.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const dbPath = flag('db');
const projectName = flag('project');
const write = args.includes('--write');
if (!dbPath || !projectName) {
  console.error('usage: check-hypothetical.ts --db <path> --project <name> [--write]');
  process.exit(2);
}

const db = new Db(dbPath);
const project = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName);
if (!project) throw new Error(`project not found: ${projectName}`);

const HEDGE = /\b(might have been|may have been|could have been)\b/i;
/** A bare alternative fragment, e.g. "Or Harold." */
const ALTERNATIVE = /^\s*Or\s+[A-Z]/;

const entities = db.all<{ id: number; name: string; summary: string; evidence: string }>(
  "SELECT id, name, summary, evidence FROM canon_entity WHERE project_id = ? AND review_status <> 'quarantined' ORDER BY name",
  project.id,
);
const text = db.all<{ text: string }>('SELECT text FROM canon_chunk WHERE project_id = ? ORDER BY seq', project.id)
  .map((chunk) => String(chunk.text ?? '')).join('\n\n');

const candidates: Array<{ id: number; name: string; quote: string }> = [];
for (const entity of entities) {
  const evidence = String(entity.evidence ?? '').trim();
  if (!evidence) continue;
  const alternative = ALTERNATIVE.test(evidence);
  const hedged = HEDGE.test(evidence);
  if (!alternative && !hedged) continue;
  // A bare alternative is never a person. A hedge is only decisive when the
  // name appears nowhere else.
  if (!alternative) {
    const pattern = new RegExp(`(?<![A-Za-z0-9])${escape(entity.name)}(?![A-Za-z0-9])`, 'gi');
    const occurrences = (text.match(pattern) ?? []).length;
    if (occurrences > 1) continue;
  }
  candidates.push({ id: Number(entity.id), name: entity.name, quote: evidence });
}

console.log(`${candidates.length} hypothetical-only name(s)${write ? '' : ' (dry run)'}`);
for (const candidate of candidates) {
  console.log(`  ${candidate.id} ${candidate.name} <- ${JSON.stringify(candidate.quote?.slice(0, 90))}`);
  if (write) {
    quarantineEntity(
      db, project.id, candidate.id,
      'only ever named as a hypothetical or alternative, not a person in the story',
      'every occurrence sits in a hedged sentence',
      candidate.quote ?? '',
    );
  }
}
db.close();
