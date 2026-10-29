/**
 * Score the three verifiers against the human labels (trials only).
 *
 * Human verdicts: S supported, C context-dependent, U unsupported.
 * Positive = S. C is reported separately and excluded from the strict score.
 *
 * usage: node score-verifiers.ts <sheet.md> <key.json>
 */
import { readFileSync } from 'node:fs';

const sheetPath = process.argv[2] ?? 'testing/trials/adjudication/human-sheet.md';
const keyPath = process.argv[3] ?? 'testing/trials/adjudication/verifier-key.json';

const sheet = readFileSync(sheetPath, 'utf8');
const labels = JSON.parse(readFileSync('testing/trials/adjudication/labels.json', 'utf8')) as Record<
  string,
  { support: string; kind: string }
>;
const rows: { id: number; pair: string; sentence: string; support: string; kind: string }[] = [];
for (const line of sheet.split('\n')) {
  const cells = line.split('|').map((cell) => cell.trim());
  if (cells.length < 8) continue;
  const id = Number(cells[1]);
  if (!Number.isFinite(id)) continue;
  const label = labels[String(id)];
  if (!label) continue;
  rows.push({
    id,
    pair: cells[2] ?? '',
    sentence: cells[4] ?? '',
    support: label.support,
    kind: label.kind,
  });
}

const key = new Map<number, { a: boolean | null; b: boolean | null }>();
for (const row of JSON.parse(readFileSync(keyPath, 'utf8')) as { id: number; a: boolean | null; b: boolean | null }[]) {
  key.set(row.id, { a: row.a, b: row.b });
}

const askLlama = async (pair: string, sentence: string): Promise<boolean | null> => {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'llama3.1:8b',
      stream: false,
      think: false,
      format: 'json',
      messages: [
        { role: 'system', content: 'You judge one sentence from a novel. Reply with JSON only: {"supported": true or false}.' },
        {
          role: 'user',
          content:
            `Sentence: ${sentence}\nQuestion: does this sentence establish a lasting relationship between ${pair.replace(' / ', ' and ')}? ` +
            'A single meeting, gift, order or conversation is not a lasting relationship.',
        },
      ],
      options: { temperature: 0, num_ctx: 4096, num_predict: 60 },
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

const cVerdicts = new Map<number, boolean | null>();
for (const row of rows) {
  if (!key.has(row.id)) continue;
  cVerdicts.set(row.id, await askLlama(row.pair, row.sentence));
}

const score = (name: string, verdict: (id: number) => boolean | null) => {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let unclear = 0;
  let context = 0;
  for (const row of rows) {
    if (!key.has(row.id)) continue;
    const v = verdict(row.id);
    if (row.support === 'C') {
      context++;
      continue;
    }
    if (v === null) {
      unclear++;
      continue;
    }
    const truth = row.support === 'S';
    if (truth && v) tp++;
    else if (truth && !v) fn++;
    else if (!truth && v) fp++;
    else tn++;
  }
  const total = tp + fp + tn + fn;
  return { name, tp, fp, tn, fn, unclear, context, accuracy: total ? (tp + tn) / total : 0, precision: tp + fp ? tp / (tp + fp) : 0, recall: tp + fn ? tp / (tp + fn) : 0 };
};

const a = score('A_qwen25_single', (id) => key.get(id)?.a ?? null);
const b = score('B_qwen25_twoQuestion', (id) => key.get(id)?.b ?? null);
const c = score('C_llama31_single', (id) => cVerdicts.get(id) ?? null);

const human = {
  rows: rows.length,
  supported: rows.filter((r) => r.support === 'S').length,
  context: rows.filter((r) => r.support === 'C').length,
  unsupported: rows.filter((r) => r.support === 'U').length,
  kindRight: rows.filter((r) => r.kind === 'Y').length,
};

console.log(JSON.stringify({ human, a, b, c }, null, 0));
