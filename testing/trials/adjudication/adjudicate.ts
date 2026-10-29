/**
 * Blind adjudication packet (trials only).
 *
 * Builds two groups from the current banks: rows the system accepted, and
 * sentence-scan candidates it never banked. Strips acceptance status and model
 * identity from the judge's view, asks an independent model one question per
 * row, then scores the verdicts against the key.
 *
 * usage: node adjudicate.ts <db...> [perGroup]
 */
import { Db } from '../../../fanfable/src/db.ts';
import { scanSentenceCandidates } from '../../../fanfable/src/lorebook.ts';

const args = process.argv.slice(2);
const perGroup = Number(args.pop() ?? 50);
const dbPaths = args;
if (!dbPaths.length) {
  console.error('usage: adjudicate.ts <db...> [perGroup]');
  process.exit(2);
}

interface Item {
  id: number;
  group: 'accepted' | 'rejected';
  pair: string;
  inText: string;
  kind: string;
  sentence: string;
  source: string;
}

const items: Item[] = [];
let nextId = 1;

for (const path of dbPaths) {
  const db = new Db(path);
  const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'ab');
  if (!proj) {
    db.close();
    continue;
  }
  const accepted = db.all<{ fn: string; tn: string; kind: string; evidence: string }>(
    `SELECT a.name fn, b.name tn, r.kind, r.evidence
       FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ? AND r.review_status = 'accepted'`,
    proj.id,
  );
  for (const row of accepted) {
    items.push({
      id: nextId++,
      group: 'accepted',
      pair: `${row.fn} / ${row.tn}`,
      inText: `${row.fn} and ${row.tn}`,
      kind: row.kind,
      sentence: row.evidence,
      source: path,
    });
  }

  const banked = new Set<string>(
    db
      .all<{ fn: string; tn: string }>(
        `SELECT a.name fn, b.name tn FROM canon_relation r
           JOIN canon_entity a ON a.id = r.from_entity
           JOIN canon_entity b ON b.id = r.to_entity WHERE r.project_id = ?`,
        proj.id,
      )
      .flatMap((row) => [`${row.fn}|${row.tn}`, `${row.tn}|${row.fn}`]),
  );
  for (const candidate of scanSentenceCandidates(db, proj.id)) {
    const key = `${candidate.fromName}|${candidate.toName}`;
    if (banked.has(key)) continue;
    items.push({
      id: nextId++,
      group: 'rejected',
      pair: `${candidate.fromName} / ${candidate.toName}`,
      inText: `${candidate.fromName} and ${candidate.toName}`,
      kind: '',
      sentence: candidate.sentence,
      source: path,
    });
  }
  db.close();
}

const shuffle = <T>(list: T[]): T[] => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

const accepted = shuffle(items.filter((item) => item.group === 'accepted')).slice(0, perGroup);
const rejected = shuffle(items.filter((item) => item.group === 'rejected')).slice(0, perGroup);
const sheet = shuffle([...accepted, ...rejected]);

const ask = async (item: Item): Promise<{ supported: boolean | null; kind: string; direction: string }> => {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.JUDGE_MODEL ?? 'qwen2.5:7b',
      stream: false,
      think: false,
      format: 'json',
      messages: [
        {
          role: 'system',
          content:
            'You judge one sentence from a novel. Reply with JSON only: ' +
            '{"supported": true or false, "kind": "short phrase", "direction": "clear|unclear|symmetric"}.',
        },
        {
          role: 'user',
          content:
            `Sentence: ${item.sentence}\n` +
            `Question: does this sentence establish a lasting relationship between ${item.inText}? ` +
            'A single meeting, gift, order or conversation is not a lasting relationship. ' +
            'If yes, give the relationship in a short phrase and say whether the direction is clear from the sentence.',
        },
      ],
      options: { temperature: 0, num_ctx: 4096, num_predict: 120 },
    }),
  });
  const data = (await res.json()) as { message?: { content?: string } };
  const raw = data.message?.content ?? '';
  try {
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
      supported?: unknown;
      kind?: unknown;
      direction?: unknown;
    };
    return {
      supported: typeof parsed.supported === 'boolean' ? parsed.supported : null,
      kind: String(parsed.kind ?? ''),
      direction: String(parsed.direction ?? ''),
    };
  } catch {
    return { supported: null, kind: '', direction: '' };
  }
};

const verdicts: { id: number; group: string; supported: boolean | null; kind: string; direction: string }[] = [];
for (const item of sheet) {
  const verdict = await ask(item);
  verdicts.push({ id: item.id, group: item.group, ...verdict });
  process.stdout.write(`.${verdict.supported === true ? 'y' : verdict.supported === false ? 'n' : '?'}`);
}
process.stdout.write('\n');

const score = (group: string) => {
  const rows = verdicts.filter((v) => v.group === group);
  const yes = rows.filter((v) => v.supported === true).length;
  const no = rows.filter((v) => v.supported === false).length;
  const unclear = rows.filter((v) => v.supported === null).length;
  return { group, n: rows.length, supported: yes, refused: no, unclear, rate: rows.length ? yes / rows.length : 0 };
};

console.log(
  JSON.stringify(
    {
      judge: process.env.JUDGE_MODEL ?? 'qwen2.5:7b',
      accepted: score('accepted'),
      rejected: score('rejected'),
      sheet: sheet.map((item) => ({ id: item.id, group: item.group, pair: item.pair, kind: item.kind })),
    },
    null,
    0,
  ),
);
