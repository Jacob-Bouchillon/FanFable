/**
 * Verifier comparison (trials only).
 *
 * Freezes the accepted rows from the two books and asks three verifiers the
 * same question, blind to acceptance status and to the claimed kind:
 *
 *   A  one question, qwen2.5            (the judge used in the blind pass)
 *   B  two questions, qwen2.5           (relationship first, kind second)
 *   C  one question, llama3.1           (an independent model)
 *
 * usage: node verify-compare.ts <db...>
 */
import { Db } from '../../../fanfable/src/db.ts';

const dbs = process.argv.slice(2);
if (!dbs.length) {
  console.error('usage: verify-compare.ts <db...>');
  process.exit(2);
}

interface Row {
  pair: string;
  inText: string;
  sentence: string;
}

const rows: Row[] = [];
for (const path of dbs) {
  const db = new Db(path);
  const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'ab');
  if (!proj) {
    db.close();
    continue;
  }
  for (const r of db.all<{ fn: string; tn: string; evidence: string }>(
    `SELECT a.name fn, b.name tn, r.evidence FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ? AND r.review_status = 'accepted'`,
    proj.id,
  )) {
    rows.push({ pair: `${r.fn} / ${r.tn}`, inText: `${r.fn} and ${r.tn}`, sentence: r.evidence });
  }
  db.close();
}

const call = async (model: string, system: string, user: string): Promise<string> => {
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
        { role: 'user', content: user },
      ],
      options: { temperature: 0, num_ctx: 4096, num_predict: 160 },
    }),
  });
  const data = (await res.json()) as { message?: { content?: string } };
  const raw = data.message?.content ?? '';
  try {
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as Record<string, unknown>;
    return JSON.stringify(parsed);
  } catch {
    return '';
  }
};

const oneQuestion = async (model: string, row: Row): Promise<boolean | null> => {
  const raw = await call(
    model,
    'You judge one sentence from a novel. Reply with JSON only: {"supported": true or false}.',
    `Sentence: ${row.sentence}\nQuestion: does this sentence establish a lasting relationship between ${row.inText}? ` +
      'A single meeting, gift, order or conversation is not a lasting relationship.',
  );
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { supported?: unknown };
  return typeof parsed.supported === 'boolean' ? parsed.supported : null;
};

const twoQuestion = async (row: Row): Promise<{ relation: boolean | null; kind: boolean | null }> => {
  const raw = await call(
    'qwen2.5:7b',
    'You judge one sentence from a novel. Reply with JSON only: {"relation": true or false, "kind": true or false}.',
    `Sentence: ${row.sentence}\n` +
      `Question 1: does this sentence establish that ${row.inText} have a lasting relationship? ` +
      'A title such as Aunt or Uncle, or two names in one sentence, is not by itself a relationship.\n' +
      'Question 2: does the sentence also establish the specific kind of relationship (not merely that some relationship exists)?',
  );
  if (!raw) return { relation: null, kind: null };
  const parsed = JSON.parse(raw) as { relation?: unknown; kind?: unknown };
  return {
    relation: typeof parsed.relation === 'boolean' ? parsed.relation : null,
    kind: typeof parsed.kind === 'boolean' ? parsed.kind : null,
  };
};

const run = async () => {
  let a = 0;
  let b = 0;
  let c = 0;
  let agreeAB = 0;
  let agreeAC = 0;
  let total = 0;
  for (const row of rows) {
    const [av, bv, cv] = await Promise.all([oneQuestion('qwen2.5:7b', row), twoQuestion(row), oneQuestion('llama3.1:8b', row)]);
    total++;
    if (av === true) a++;
    if (bv.relation === true) b++;
    if (cv === true) c++;
    if (av !== null && av === bv.relation) agreeAB++;
    if (av !== null && av === cv) agreeAC++;
  }
  console.log(
    JSON.stringify({
      rows: total,
      A_singleQuestion_qwen25: a,
      B_twoQuestion_qwen25: b,
      C_singleQuestion_llama31: c,
      agree_A_B: agreeAB,
      agree_A_C: agreeAC,
    }),
  );
};

await run();
