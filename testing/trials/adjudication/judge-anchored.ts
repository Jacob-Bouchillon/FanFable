/**
 * Judge anchored candidates (trials only).
 *
 * The generator already supplies the sentence (one name + pronoun + relation
 * word) and the anchor (the neighbouring sentence naming the other person).
 * The model only decides whether the sentence states a lasting relationship.
 *
 * usage: node judge-anchored.ts <db> [model] [max]
 */
import { Db } from '../../../fanfable/src/core/db.ts';
import { scanAnchoredCandidates, CLOSED_ROLE_KINDS } from '../../../fanfable/src/lorebook.ts';
import { writeFileSync } from 'node:fs';

const dbPath = process.argv[2];
const model = process.argv[3] ?? 'qwen3.5:9b';
const max = Number(process.argv[4] ?? 200);
if (!dbPath) {
  console.error('usage: judge-anchored.ts <db> [model] [max]');
  process.exit(2);
}
const db = new Db(dbPath);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'ab');
const candidates = scanAnchoredCandidates(db, proj!.id).slice(0, max);

const accepted: { pair: string; sentence: string; anchor: string; kind: string }[] = [];
let yes = 0;
let no = 0;
let failed = 0;
const kinds = new Map<string, number>();
for (const c of candidates) {
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
              'You judge a relationship. Reply with JSON only: ' +
              `{"tie": true or false, "kind": one of [${CLOSED_ROLE_KINDS.join(', ')}], "from": "<name>", "to": "<name>"}.`,
          },
          {
            role: 'user',
            content:
              `Sentence: ${c.sentence}\n` +
              `Context sentence: ${c.anchor}\n` +
              `Candidates: ${c.fromName} and ${c.toName}\n` +
              'Does the sentence state a lasting relationship between these two people, using the context sentence to resolve any pronoun? ' +
              'A single meeting, order, gift or conversation is not a lasting relationship.',
          },
        ],
        options: { temperature: 0.1, num_ctx: 4096, num_predict: 160 },
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
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      accepted.push({ pair: `${c.fromName} / ${c.toName}`, sentence: c.sentence, anchor: c.anchor, kind });
    } else no++;
  } catch {
    failed++;
  }
}
writeFileSync(
  `testing/trials/adjudication/anchored-accepted-${dbPath.includes('hp3') ? 'hp3' : 'n'}.json`,
  JSON.stringify(accepted, null, 1),
);
console.log(
  JSON.stringify({
    model,
    candidates: candidates.length,
    yes,
    no,
    failed,
    kinds: Object.fromEntries([...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)),
  }),
);
db.close();
