/**
 * Mention-window probe (trials only).
 *
 * The user's idea: anchor on a name, read forward until the same name comes
 * back, and treat that stretch as the window. Inside it, if a second known
 * character appears with a relationship word, that is a candidate pair.
 *
 * Counts candidates only — no model calls. Compare with the sentence scan.
 *
 * usage: node scan-windows.ts <db> [maxSentences]
 */
import { Db } from '../../../fanfable/src/db.ts';
import { canonicalName } from '../../../fanfable/src/names.ts';
import { CLOSED_ROLE_KINDS, KIND_GLOSSES, isUnsupportedKind } from '../../../fanfable/src/lorebook.ts';
import { splitSentences } from '../../../fanfable/src/text.ts';

const dbPath = process.argv[2];
const maxSentences = Number(process.argv[3] ?? 4);
if (!dbPath) {
  console.error('usage: scan-windows.ts <db> [maxSentences]');
  process.exit(2);
}
const db = new Db(dbPath);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'ab');

const entities = db
  .all<{ id: number; name: string }>(
    "SELECT id, name FROM canon_entity WHERE project_id = ? AND kind = 'character'",
    proj!.id,
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
    .map((e) => ({
      id: e.id,
      at: tokens.findIndex((_, i) => e.tokens.every((w, k) => tokens[i + k] === w)),
    }))
    .filter((m) => m.at >= 0)
    .map((m) => m.id);
};

const chunks = db.all<{ id: number; text: string }>(
  'SELECT id, text FROM canon_chunk WHERE project_id = ? ORDER BY seq',
  proj!.id,
);
const sentences: { text: string; chunkId: number; who: number[] }[] = [];
for (const chunk of chunks) {
  for (const s of splitSentences(chunk.text)) {
    sentences.push({ text: s.trim(), chunkId: chunk.id, who: mentions(s) });
  }
}

const pairs = new Set<string>();
const spans: { pair: string; text: string }[] = [];
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
    const key = `${Math.min(anchor, other)}|${Math.max(anchor, other)}`;
    pairs.add(key);
    if (spans.length < 500) spans.push({ pair: key, text: text.slice(0, 160) });
  }
}

console.log(
  JSON.stringify({
    sentences: sentences.length,
    candidatePairs: pairs.size,
    spanSamples: spans.length,
    maxSentences,
  }),
);
db.close();
