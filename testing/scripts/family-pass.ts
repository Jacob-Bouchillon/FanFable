/**
 * Kinship from family statements.
 *
 * A paragraph can state a family without one sentence naming both people
 * ("I'm the sixth in our family... five brothers... Bill and Charlie have
 * already left"). The relation extractor needs a single sentence, so those
 * edges were never written. This pass reads the paragraph with the local
 * roster and emits the kinship edges the passage supports.
 *
 *   node --no-warnings testing/scripts/family-pass.ts --db <path> --project hp1 [--limit n] [--write]
 */
import { Db } from '../../fanfable/src/core/db.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import { insertRelation, listRelations } from '../../fanfable/src/lorebook.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const dbPath = flag('db');
const projectName = flag('project');
const model = flag('model') ?? 'qwen3.5:9b';
const limit = Number(flag('limit') ?? 0) || 0;
const write = args.includes('--write');
if (!dbPath || !projectName) {
  console.error('usage: family-pass.ts --db <path> --project <name> [--limit n] [--model m] [--write]');
  process.exit(2);
}

const KINDS = new Set([
  'brother of', 'sister of', 'son of', 'daughter of', 'mother of', 'father of',
  'husband of', 'wife of', 'uncle of', 'aunt of', 'nephew of', 'niece of', 'cousin of',
]);

const db = new Db(dbPath);
const project = db.get<{ id: number; settings: unknown }>('SELECT id, settings FROM project WHERE name = ?', projectName);
if (!project) throw new Error(`project not found: ${projectName}`);
const settings = typeof project.settings === 'string' ? JSON.parse(project.settings) : project.settings;
const llm = controller.createClient({ ...(settings as object), model } as never);

const entities = db.all<{ id: number; name: string; aliases: string }>(
  "SELECT id, name, aliases FROM canon_entity WHERE project_id = ? AND kind = 'character' AND review_status <> 'quarantined'",
  project.id,
);
const formsOf = (entity: { name: string; aliases: string }): string[] => {
  let aliases: string[] = [];
  try { aliases = JSON.parse(entity.aliases || '[]'); } catch { /* none */ }
  return [entity.name, ...aliases].filter((form) => form.length > 2);
};
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentioned = (text: string, forms: string[]) =>
  new RegExp(`(?<![A-Za-z0-9])(?:${forms.map(escape).join('|')})(?![A-Za-z0-9])`, 'i').test(text);

const cue = /\b(brother|sister|brothers|sisters|family|sons?|parents?|nephew|niece|uncle|aunt|cousin)\b/i;
const chunks = db.all<{ id: number; seq: number; locator: string; text: string }>(
  'SELECT id, seq, locator, text FROM canon_chunk WHERE project_id = ? ORDER BY seq',
  project.id,
).filter((chunk) => {
  if (!cue.test(chunk.text)) return false;
  const roster = entities.filter((entity) => mentioned(chunk.text, formsOf(entity)));
  return roster.length >= 2;
}).slice(0, limit || undefined);

const existing = new Set(listRelations(db, project.id).map((relation) =>
  `${relation.fromId}:${relation.toId}:${relation.kind.toLowerCase()}`));

let added = 0;
for (const chunk of chunks) {
  const roster = entities.filter((entity) => mentioned(chunk.text, formsOf(entity)));
  const names = roster.map((entity) => entity.name);
  const system = 'You read one passage from a novel and list family relationships between the named people. '
    + 'Use only the passage. A family can be stated across several sentences ("I am the sixth in our family", "five brothers", "Bill and Charlie have already left"). '
    + 'Reply JSON only: {"ties":[{"from":"name from the list","to":"name from the list","kind":"brother of|sister of|son of|daughter of|mother of|father of|husband of|wife of|uncle of|aunt of|nephew of|niece of|cousin of","quote":"one contiguous sentence copied verbatim from the passage"}]}. '
    + 'from is the relative, to is the person they are related to. If the passage does not state or clearly imply the tie, omit it.';
  const user = `PEOPLE: ${names.join(', ')}\n\nPASSAGE:\n${chunk.text}`;
  let parsed: { ties?: Array<{ from?: string; to?: string; kind?: string; quote?: string }> } = {};
  try {
    const response = await fetch(`${String((settings as { baseUrl?: string }).baseUrl ?? 'http://127.0.0.1:11434')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        options: { temperature: 0, seed: 42 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    const data = await response.json() as { message?: { content?: string } };
    parsed = JSON.parse(String(data.message?.content ?? '{}'));
  } catch {
    console.log(`${chunk.seq}: model call failed`);
    continue;
  }
  for (const tie of parsed.ties ?? []) {
    const from = roster.find((entity) => entity.name === String(tie.from ?? '').trim());
    const to = roster.find((entity) => entity.name === String(tie.to ?? '').trim());
    const kind = String(tie.kind ?? '').toLowerCase().trim();
    const quote = String(tie.quote ?? '').trim();
    if (!from || !to || from.id === to.id || !KINDS.has(kind)) continue;
    if (!quote || !chunk.text.toLowerCase().includes(quote.toLowerCase())) continue;
    const key = `${from.id}:${to.id}:${kind}`;
    if (existing.has(key)) continue;
    existing.add(key);
    if (write) {
      insertRelation(db, project.id, {
        fromEntity: from.id,
        toEntity: to.id,
        kind,
        evidence: quote,
        sourceRefs: JSON.stringify([{ source: 'Harry Potter, Book 1; The Sorcerer\'s Stone', locator: chunk.locator, chunk: chunk.id }]),
        reviewStatus: 'needs_review',
      });
    }
    added++;
    console.log(`${chunk.seq} ${from.name} --${kind}--> ${to.name}`);
  }
}
console.log(`${chunks.length} passages read, ${added} kinship edge(s)${write ? '' : ' (dry run)'}`);
db.close();
