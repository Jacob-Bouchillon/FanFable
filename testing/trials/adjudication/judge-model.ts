/**
 * Run one judge model over the human-labelled rows (trials only).
 *
 * usage: node judge-model.ts <model>
 * Reads human-sheet.md for pair and sentence, labels.json for the truth.
 */
import { readFileSync } from 'node:fs';

const model = process.argv[2];
if (!model) {
  console.error('usage: judge-model.ts <model>');
  process.exit(2);
}

const sheet = readFileSync('testing/trials/adjudication/human-sheet.md', 'utf8');
const labels = JSON.parse(readFileSync('testing/trials/adjudication/labels.json', 'utf8')) as Record<
  string,
  { support: string; kind: string }
>;
const rows: { id: number; pair: string; sentence: string; support: string }[] = [];
for (const line of sheet.split('\n')) {
  const cells = line.split('|').map((cell) => cell.trim());
  if (cells.length < 6) continue;
  const id = Number(cells[1]);
  if (!Number.isFinite(id)) continue;
  const label = labels[String(id)];
  if (!label) continue;
  rows.push({ id, pair: cells[2] ?? '', sentence: cells[4] ?? '', support: label.support });
}

const ask = async (row: { pair: string; sentence: string }): Promise<boolean | null> => {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: 'json',
      messages: [
        { role: 'system', content: 'You judge one sentence from a novel. Reply with JSON only: {"supported": true or false}.' },
        {
          role: 'user',
          content:
            `Sentence: ${row.sentence}\nQuestion: does this sentence establish a lasting relationship between ${row.pair.replace(' / ', ' and ')}? ` +
            'A single meeting, gift, order or conversation is not a lasting relationship.',
        },
      ],
      options: { temperature: 0, num_ctx: 4096, num_predict: 80 },
    }),
  });
  const data = (await res.json()) as { message?: { content?: string } };
  const raw = data.message?.content ?? '';
  try {
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { supported?: unknown };
    return typeof parsed.supported === 'boolean' ? parsed.supported : null;
  } catch {
    return null;
  }
};

let tp = 0;
let fp = 0;
let tn = 0;
let fn = 0;
let unclear = 0;
const detail: { id: number; human: string; model: boolean | null }[] = [];
for (const row of rows) {
  const verdict = await ask(row);
  detail.push({ id: row.id, human: row.support, model: verdict });
  if (row.support === 'C') continue;
  if (verdict === null) {
    unclear++;
    continue;
  }
  const truth = row.support === 'S';
  if (truth && verdict) tp++;
  else if (truth && !verdict) fn++;
  else if (!truth && verdict) fp++;
  else tn++;
}
const total = tp + fp + tn + fn;
console.log(
  JSON.stringify({
    model,
    rows: rows.length,
    tp,
    fp,
    tn,
    fn,
    unclear,
    accuracy: total ? (tp + tn) / total : 0,
    precision: tp + fp ? tp / (tp + fp) : 0,
    recall: tp + fn ? tp / (tp + fn) : 0,
    falseAccepts: detail.filter((d) => d.model === true && d.human === 'U').map((d) => d.id),
    misses: detail.filter((d) => d.model === false && d.human === 'S').map((d) => d.id),
  }),
);
