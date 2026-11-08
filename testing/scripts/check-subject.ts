/**
 * Subject grounding: a fact about X must come from a chunk that names X, or
 * whose evidence names X. Without this, enrichment attaches every sentence in
 * a passage to the entity it was asked about.
 *
 *   node --no-warnings testing/scripts/check-subject.ts --db <path> --project hp1 [--write]
 */
import { Db } from '../../fanfable/src/core/db.ts';
import { setFactProvenance } from '../../fanfable/src/lorebook.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const dbPath = flag('db');
const projectName = flag('project');
const write = args.includes('--write');
if (!dbPath || !projectName) {
  console.error('usage: check-subject.ts --db <path> --project <name> [--write]');
  process.exit(2);
}

const db = new Db(dbPath);
const project = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName);
if (!project) throw new Error(`project not found: ${projectName}`);

const norm = (value: string) => String(value ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const facts = db.all<{
  id: number; evidence: string; source_refs: string; name: string; aliases: string;
}>(
  `SELECT f.id, f.evidence, f.source_refs, e.name, e.aliases
     FROM canon_fact f JOIN canon_entity e ON e.id = f.subject_entity_id
    WHERE f.project_id = ? AND f.review_status <> 'rejected'
    ORDER BY f.id`,
  project.id,
);

let grounded = 0;
let ungrounded = 0;
const examples: Array<{ id: number; who: string; evidence: string }> = [];
for (const fact of facts) {
  let aliases: string[] = [];
  try { aliases = JSON.parse(fact.aliases || '[]'); } catch { /* none */ }
  // A person is also named by a distinctive token ("Harry", "Constrictor").
  const tokens = String(fact.name).split(/\s+/).filter((token) => token.length > 3);
  const forms = [fact.name, ...aliases, ...tokens].map(norm).filter(Boolean);
  const evidence = norm(fact.evidence);
  const namedInEvidence = forms.some((form) => evidence.includes(form));

  let chunkText = '';
  try {
    const ref = JSON.parse(fact.source_refs)[0] ?? {};
    const chunk = ref.chunk
      ? db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ?', Number(ref.chunk))
      : db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE project_id = ? AND locator = ? LIMIT 1', project.id, String(ref.locator ?? ''));
    chunkText = norm(chunk?.text ?? '');
  } catch {
    chunkText = '';
  }
  const namedInChunk = forms.some((form) => chunkText.includes(form));

  if (namedInEvidence || namedInChunk) {
    grounded++;
  } else {
    ungrounded++;
    if (examples.length < 10) examples.push({ id: Number(fact.id), who: fact.name, evidence: String(fact.evidence).slice(0, 80) });
    if (write) setFactProvenance(db, project.id, Number(fact.id), fact.source_refs, 'rejected', 'neither the evidence nor the cited chunk names the subject');
  }
}

console.log(`facts: ${facts.length} · subject grounded: ${grounded} · ungrounded: ${ungrounded}${write ? '' : ' (dry run)'}`);
for (const example of examples) console.log(`  #${example.id} ${example.who} <- ${JSON.stringify(example.evidence)}`);
db.close();
