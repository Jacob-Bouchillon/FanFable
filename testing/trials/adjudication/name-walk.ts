/**
 * Name-walk probe (trials only).
 *
 * For each character, gather every sentence that mentions the name or an
 * alias, in reading order, and ask the model once: what lasting relationships
 * does this person have, with a verbatim quote from these sentences?
 *
 * usage: node name-walk.ts <db> [model] [maxNames]
 */
import { Db } from '../../../fanfable/src/db.ts';
import { canonicalName } from '../../../fanfable/src/names.ts';
import { CLOSED_ROLE_KINDS } from '../../../fanfable/src/lorebook.ts';

const dbPath = process.argv[2];
const model = process.argv[3] ?? 'qwen3.5:9b';
const maxNames = Number(process.argv[4] ?? 5);
if (!dbPath) {
  console.error('usage: name-walk.ts <db> [model] [maxNames]');
  process.exit(2);
}
const db = new Db(dbPath);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'ab');
const projectId = proj!.id;

const characters = db.all<{ id: number; name: string; aliases: string; mentions: number }>(
  "SELECT id, name, aliases, mentions FROM canon_entity WHERE project_id = ? AND kind = 'character' AND review_status != 'quarantined' ORDER BY mentions DESC LIMIT ?",
  projectId,
  maxNames,
);

const chunks = db.all<{ id: number; locator: string; text: string }>(
  'SELECT id, locator, text FROM canon_chunk WHERE project_id = ? ORDER BY seq',
  projectId,
);

const sentencesOf = (text: string): string[] => text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

const ask = async (name: string, body: string): Promise<{ to: string; kind: string; quote: string }[]> => {
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
            'You read a character\'s mentions in a novel and list their lasting relationships. ' +
            'Reply with JSON only: {"ties":[{"to":"name","kind":"short phrase","quote":"verbatim sentence from the list"}]}.'
        },
        {
          role: 'user',
          content:
            `Character: ${name}\n` +
            'Below are every sentence in which this character is mentioned, in reading order.\n' +
            'List the lasting relationships this character has with other named people: family, marriage, lasting role, lasting friendship or enmity. ' +
            'Ignore one-off meetings, orders and conversations. Give one entry per relationship, with a sentence copied exactly from the list.\n\n' +
            body,
        },
      ],
      options: { temperature: 0.1, num_ctx: 16384, num_predict: 1200 },
    }),
  });
  const data = (await res.json()) as { message?: { content?: string } };
  const raw = data.message?.content ?? '';
  try {
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
      ties?: { to?: unknown; kind?: unknown; quote?: unknown }[];
    };
    return (parsed.ties ?? [])
      .map((t) => ({ to: String(t.to ?? '').trim(), kind: String(t.kind ?? '').trim(), quote: String(t.quote ?? '').trim() }))
      .filter((t) => t.to && t.quote);
  } catch {
    console.error('PARSE-FAIL', JSON.stringify(raw).slice(0, 300));
    return [];
  }
};

const results: { name: string; ties: number; verbatim: number; sample: string[] }[] = [];
for (const character of characters) {
  const names = [character.name, ...(JSON.parse(character.aliases || '[]') as string[])].map(norm).filter(Boolean);
  const lines: string[] = [];
  for (const chunk of chunks) {
    for (const sentence of sentencesOf(chunk.text)) {
      const n = norm(sentence);
      if (names.some((v) => n.includes(v))) lines.push(`[${chunk.locator}] ${sentence}`);
    }
  }
  const step = Math.max(1, Math.ceil(lines.length / 150));
  const body = lines.filter((_, i) => i % step === 0).slice(0, 150).join('\n');
  const ties = await ask(character.name, body);
  const text = chunks.map((c) => norm(c.text)).join(' \n ');
  const verbatim = ties.filter((t) => text.includes(norm(t.quote))).length;
  results.push({ name: character.name, ties: ties.length, verbatim, sample: ties.slice(0, 3).map((t) => `${t.to} (${t.kind})`) });
  console.log(JSON.stringify(results[results.length - 1]));
}
db.close();
