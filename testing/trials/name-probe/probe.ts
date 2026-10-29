/**
 * Name-finding probe (trials only, book data allowed here).
 *
 * Takes the passages that mention thin entities in a bank — names with no
 * banked ties — and asks a model to list the names in each passage, with the
 * sentence that carries them. Scores verbatim presence, overlap with the
 * bank's own names, and fragments.
 *
 * usage: node probe.ts <db> <model> [maxPassages]
 */
import { Db } from '../../../fanfable/src/db.ts';
import { buildNameRoster } from '../../../fanfable/src/lorebook.ts';

const dbPath = process.argv[2];
const model = process.argv[3];
const maxPassages = Number(process.argv[4] ?? 8);
if (!dbPath || !model) {
  console.error('usage: probe.ts <db> <model> [maxPassages]');
  process.exit(2);
}

const db = new Db(dbPath);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'ab');
if (!proj) {
  console.error('no project ab');
  process.exit(2);
}

// Thin names: banked entities with no relation on either end.
const thin = db.all<{ name: string; aliases: string }>(
  `SELECT e.name, e.aliases FROM canon_entity e
    WHERE e.project_id = ?
      AND NOT EXISTS (SELECT 1 FROM canon_relation r
                       WHERE r.from_entity = e.id OR r.to_entity = e.id)`,
  proj.id,
);

const all = db.all<{ name: string; aliases: string }>(
  'SELECT name, aliases FROM canon_entity WHERE project_id = ?',
  proj.id,
);

const chunks = db.all<{ id: number; seq: number; text: string }>(
  'SELECT id, seq, text FROM canon_chunk WHERE project_id = ? ORDER BY seq',
  proj.id,
);

const variants = (name: string, aliases: string): string[] => {
  let out = [name];
  try {
    const a = JSON.parse(aliases || '[]');
    if (Array.isArray(a)) out = out.concat(a.map(String));
  } catch {}
  return out.filter((v) => v.trim().length >= 2);
};

const picked: { seq: number; text: string; want: string }[] = [];
const used = new Set<number>();
for (const t of thin) {
  for (const v of variants(t.name, t.aliases)) {
    const hit = chunks.find((c) => !used.has(c.id) && c.text.toLowerCase().includes(v.toLowerCase()));
    if (hit) {
      used.add(hit.id);
      picked.push({ seq: hit.seq, text: hit.text, want: t.name });
      break;
    }
    if (picked.length >= maxPassages) break;
  }
  if (picked.length >= maxPassages) break;
}
picked.sort((a, b) => a.seq - b.seq);
const passages = picked.slice(0, maxPassages);

const known = new Set<string>();
for (const e of all) for (const v of variants(e.name, e.aliases)) known.add(v.toLowerCase());

const roster = buildNameRoster(db, proj.id);
const rosterSet = new Set<string>();
for (const entry of roster.entries) for (const s of entry.surfaces) rosterSet.add(s.toLowerCase());

const system =
  'You list the names that appear in a passage of a novel. Names are people, places, ' +
  'organizations, ships, titles and species. Copy each name exactly as written. ' +
  'Copy one sentence verbatim from the passage for each name. Reply with JSON only.';
const shape = '{"names":[{"name":"...","sentence":"..."}]}';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

async function ask(text: string): Promise<{ names: { name: string; sentence: string }[] }> {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: 'json',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Passage:\n${text}\n\nReply with JSON only: ${shape}` },
      ],
      options: { temperature: 0, num_ctx: 8192, num_predict: 900 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { message?: { content?: string } };
  const raw = data.message?.content ?? '';
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { names?: { name?: unknown; sentence?: unknown }[] };
    const names = (parsed.names ?? [])
      .map((n) => ({ name: String(n.name ?? '').trim(), sentence: String(n.sentence ?? '').trim() }))
      .filter((n) => n.name.length > 0);
    return { names };
  } catch {
    return { names: [] };
  }
}

let returned = 0;
let verbatim = 0;
let knownHit = 0;
let fresh = 0;
let inRoster = 0;
let freshNew = 0;
let withSentence = 0;
let fragments = 0;
let empty = 0;
const freshNames: string[] = [];
const freshNewNames: string[] = [];

for (const p of passages) {
  const out = await ask(p.text);
  if (!out.names.length) {
    empty++;
    continue;
  }
  const seen = new Set<string>();
  for (const n of out.names) {
    returned++;
    const nameOk = p.text.includes(n.name);
    if (nameOk) verbatim++;
    if (n.sentence && norm(p.text).includes(norm(n.sentence).slice(0, 60))) withSentence++;
    const lower = n.name.toLowerCase();
    const onRoster = rosterSet.has(lower);
    if (onRoster) inRoster++;
    if (known.has(lower)) knownHit++;
    else if (nameOk && !seen.has(lower)) {
      fresh++;
      freshNames.push(n.name);
      if (!onRoster) {
        freshNew++;
        freshNewNames.push(n.name);
      }
    }
    seen.add(lower);
  }
  // fragment: a returned name that is a strict substring of another returned name
  const names = out.names.map((n) => n.name);
  for (const a of names) {
    if (names.some((b) => b !== a && b.toLowerCase().includes(a.toLowerCase()) && b.length > a.length)) fragments++;
  }
}

console.log(
  JSON.stringify({
    model,
    passages: passages.length,
    emptyPassages: empty,
    returned,
    verbatim,
    withSentence,
    knownHit,
    inRoster,
    fresh,
    freshNew,
    fragments,
    freshSample: freshNames.slice(0, 12),
    freshNewSample: [...new Set(freshNewNames)].slice(0, 20),
  }),
);
db.close();
