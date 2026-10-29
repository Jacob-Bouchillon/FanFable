/**
 * Judge name-anchored windows (trials only).
 *
 * Window: start at a mention of one character, read forward until that name
 * comes back (max N sentences). If another known character appears with a
 * relationship word, ask the model whether the window states a lasting tie.
 *
 * usage: node judge-windows.ts <db> <model> [maxWindows] [maxSentences]
 */
import { Db } from '../../../fanfable/src/db.ts';
import { canonicalName } from '../../../fanfable/src/names.ts';
import { CLOSED_ROLE_KINDS, KIND_GLOSSES, isClosedRoleKind } from '../../../fanfable/src/lorebook.ts';
import { splitSentences } from '../../../fanfable/src/text.ts';

const dbPath = process.argv[2];
const model = process.argv[3];
const maxWindows = Number(process.argv[4] ?? 80);
const maxSentences = Number(process.argv[5] ?? 4);
if (!dbPath || !model) {
  console.error('usage: judge-windows.ts <db> <model> [maxWindows] [maxSentences]');
  process.exit(2);
}
const db = new Db(dbPath);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'ab');
const projectId = proj!.id;

const entities = db
  .all<{ id: number; name: string }>(
    "SELECT id, name FROM canon_entity WHERE project_id = ? AND kind = 'character'",
    projectId,
  )
  .map((e) => ({ id: e.id, name: e.name, tokens: canonicalName(e.name).split(' ').filter(Boolean) }))
  .filter((e) => e.tokens.length);

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const phrases = new Set<string>();
for (const kind of CLOSED_ROLE_KINDS) {
  phrases.add(norm(kind));
  for (const p of (KIND_GLOSSES[kind]?.reads ?? '').split(',')) {
    const c = norm(p.replace(/\([^)]*\)/g, '').replace(/"/g, ''));
    if (c.length > 2) phrases.add(c);
  }
}

const mentions = (text: string): number[] => {
  const tokens = norm(text).split(' ').filter(Boolean);
  return entities
    .map((e) => ({ id: e.id, at: tokens.findIndex((_, i) => e.tokens.every((w, k) => tokens[i + k] === w)) }))
    .filter((m) => m.at >= 0)
    .map((m) => m.id);
};

const chunks = db.all<{ id: number; text: string }>(
  'SELECT id, text FROM canon_chunk WHERE project_id = ? ORDER BY seq',
  projectId,
);
const sentences: { text: string; chunkId: number; who: number[] }[] = [];
for (const chunk of chunks) {
  for (const s of splitSentences(chunk.text)) {
    sentences.push({ text: s.trim(), chunkId: chunk.id, who: mentions(s) });
  }
}

interface Window {
  fromId: number;
  fromName: string;
  toId: number;
  toName: string;
  text: string;
  chunkId: number;
  size: number;
}

const windows: Window[] = [];
const seen = new Set<string>();
for (let i = 0; i < sentences.length; i++) {
  const anchor = sentences[i]!.who[0];
  if (anchor === undefined) continue;
  let end = i;
  const limit = Math.min(sentences.length - 1, i + maxSentences);
  for (let j = i + 1; j <= limit; j++) {
    end = j;
    if (sentences[j]!.who.includes(anchor)) break;
  }
  const block = sentences.slice(i, end + 1);
  const text = block.map((s) => s.text).join(' ');
  if (![...phrases].some((p) => norm(text).includes(p))) continue;
  const others = new Set<number>();
  for (const s of block) for (const id of s.who) if (id !== anchor) others.add(id);
  for (const other of others) {
    const key = `${Math.min(anchor, other)}|${Math.max(anchor, other)}|${norm(text).slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const a = entities.find((e) => e.id === anchor)!;
    const b = entities.find((e) => e.id === other)!;
    windows.push({
      fromId: anchor,
      fromName: a.name,
      toId: other,
      toName: b.name,
      text,
      chunkId: block[0]!.chunkId,
      size: block.length,
    });
  }
}

const sample = windows.slice(0, maxWindows);
let yes = 0;
let no = 0;
let failed = 0;
const kinds = new Map<string, number>();

for (const w of sample) {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: 'json',
        messages: [
          {
            role: 'system',
            content:
              'You judge one short passage from a novel. Reply with JSON only: ' +
              `{"tie": true or false, "kind": one of [${CLOSED_ROLE_KINDS.join(', ')}]}.`,
          },
          {
            role: 'user',
            content:
              `Passage: ${w.text}\n` +
              `Question: does this passage say that ${w.fromName} and ${w.toName} ` +
              'have a lasting relationship (family, lasting role, friend or enemy)? ' +
              'Answer true or false, and give the kind.',
          },
        ],
        options: { temperature: 0.1, num_ctx: 4096, num_predict: 120 },
      }),
    });
    const data = (await res.json()) as { message?: { content?: string } };
    const raw = data.message?.content ?? '';
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
      tie?: unknown;
      kind?: unknown;
    };
    if (parsed.tie === true) {
      yes++;
      const kind = String(parsed.kind ?? '').trim().toLowerCase();
      const key = isClosedRoleKind(kind) ? kind : 'open';
      kinds.set(key, (kinds.get(key) ?? 0) + 1);
    } else no++;
  } catch {
    failed++;
  }
}

console.log(
  JSON.stringify({
    db: dbPath,
    windows: windows.length,
    sampled: sample.length,
    yes,
    no,
    failed,
    kinds: Object.fromEntries([...kinds.entries()].sort((a, b) => b[1] - a[1])),
  }),
);
db.close();
