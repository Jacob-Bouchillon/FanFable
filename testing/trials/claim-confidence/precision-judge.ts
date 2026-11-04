/**
 * Automated blind judge for a precision sheet (trials only, not in npm test).
 *
 * Reads a Phase 0 sheet.csv (id,relId,pair,sentence,locator), asks a local
 * model three times per row whether the sentence itself states the pair's tie
 * as fact, and writes verdicts.csv for measure-precision.ts score.
 *
 * This run is explicitly a Spark judge (spark-x2-q8), not the judge named in
 * docs/WHATS-NEXT.md. Majority of three; ties fail closed to not_supported.
 * Empty sentences are not sent to the model.
 *
 * usage:
 *   node testing/trials/claim-confidence/precision-judge.ts --dir <sheet dir>
 *     [--model spark-x2-q8:latest] [--host http://127.0.0.1:11434]
 *     [--out <verdicts.csv>] [--votes-out <votes.csv>]
 *
 * Counts only on stdout. Never prints sentences, reasons, or per-row verdicts.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED = ['supported', 'not_supported'] as const;
type Verdict = (typeof ALLOWED)[number];

interface SheetRow {
  id: number;
  relId: number;
  pair: string;
  sentence: string;
  quote?: string;
  passage?: string;
}

const SYSTEM = [
  'You judge one sentence from a book for a relationship claim.',
  'Two named people and one sentence are given.',
  'Answer supported only when the sentence itself states that these two people have a lasting tie',
  '(family, marriage, a lasting role, lasting friendship or lasting enmity) as fact.',
  'If the sentence merely places them together, describes an event or a moment, leaves the tie implied by context,',
  'or is unclear, answer not_supported. Never use knowledge from outside the sentence.',
  'Reply with JSON only: {"verdict":"supported|not_supported","reason":"at most twelve words"}.',
].join(' ');

const LOOSE_SYSTEM = [
  'You judge one sentence from a book for a relationship claim.',
  'Two named people and one sentence are given.',
  'Answer supported iff the sentence SUPPORTS or SUGGESTS a tie between exactly these two people:',
  'a verb of feeling or action toward the other, a stated role, coordination as a pair,',
  'or any implication a careful reader would draw.',
  'Pure co-presence with no connective tissue, list membership, or scene-sharing must be not_supported.',
  'Never use knowledge from outside the sentence.',
  'Reply with JSON only: {"verdict":"supported|not_supported","reason":"at most twelve words"}.',
].join(' ');

const PASSAGE_SYSTEM = [
  'You judge one passage from a book for a relationship claim.',
  'Two named people, a quoted line, and the passage it cites are given.',
  'Answer supported iff the PASSAGE establishes the pair’s lasting tie as fact anywhere within it,',
  'possibly across sentences. Both names need not share one sentence, but both must appear in the passage.',
  'Co-presence without a stated tie, contradiction-only, implication from outside knowledge, or unclear',
  'must be not_supported. Never use knowledge from outside the passage.',
  'Reply with JSON only: {"verdict":"supported|not_supported","reason":"at most twelve words"}.',
].join(' ');

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = args[at + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((line) => line.some((value) => value !== ''));
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function reasonOf(value: string): string {
  const words = String(value ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 12);
  return words.length ? words.join(' ') : 'model verdict';
}

function readSheet(dir: string): SheetRow[] {
  const path = join(dir, 'sheet.csv');
  if (!existsSync(path)) throw new Error(`sheet not found: ${path}`);
  const table = parseCsv(readFileSync(path, 'utf8'));
  const header = table[0]?.join(',') ?? '';
  const wide = header === 'id,relId,pair,quote,passage,locator';
  if (header !== 'id,relId,pair,sentence,locator' && !wide) {
    throw new Error('sheet header must be id,relId,pair,sentence,locator or id,relId,pair,quote,passage,locator');
  }
  return table.slice(1).map((cells, index) => {
    const [id, relId, pair] = cells;
    const rowId = Number(id);
    const rel = Number(relId);
    if (!Number.isInteger(rowId) || rowId <= 0) throw new Error(`sheet row ${index + 1} has no id`);
    if (!Number.isInteger(rel) || rel <= 0) throw new Error(`sheet row ${index + 1} has no relId`);
    if (wide) {
      return {
        id: rowId,
        relId: rel,
        pair: pair ?? '',
        sentence: '',
        quote: cells[3] ?? '',
        passage: cells[4] ?? '',
      };
    }
    return { id: rowId, relId: rel, pair: pair ?? '', sentence: cells[3] ?? '' };
  });
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function judgeOnce(
  host: string,
  model: string,
  row: SheetRow,
  seed: number,
  mode: 'sentence' | 'loose' | 'passage',
): Promise<Verdict> {
  const content = mode === 'passage'
    ? `People: ${row.pair}\nQuote: ${row.quote ?? ''}\nPassage: ${row.passage ?? ''}`
    : `People: ${row.pair}\nSentence: ${row.sentence}`;
  const body = {
    model,
    messages: [
      { role: 'system', content: mode === 'passage' ? PASSAGE_SYSTEM : mode === 'loose' ? LOOSE_SYSTEM : SYSTEM },
      { role: 'user', content },
    ],
    stream: false,
    think: false,
    format: 'json',
    options: { temperature: 0, seed, num_predict: 96 },
  };
  const res = await fetch(`${host.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data = await res.json() as { message?: { content?: unknown }; response?: unknown };
  const text = String(data.message?.content ?? data.response ?? '');
  const parsed = extractJson(text);
  const verdict = String(parsed?.verdict ?? '').trim().toLowerCase();
  if (!(ALLOWED as readonly string[]).includes(verdict)) throw new Error(`bad verdict: ${verdict.slice(0, 24)}`);
  return verdict as Verdict;
}

/** Up to two retries after the first failure. */
async function judgeWithRetry(
  host: string,
  model: string,
  row: SheetRow,
  run: number,
  mode: 'sentence' | 'loose' | 'passage',
): Promise<{ ok: true; verdict: Verdict } | { ok: false; error: string }> {
  let last = 'unknown';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return { ok: true, verdict: await judgeOnce(host, model, row, 42 + run, mode) };
    } catch (error) {
      last = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  }
  return { ok: false, error: last };
}

async function assertModelAvailable(host: string, model: string): Promise<void> {
  const res = await fetch(`${host.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ollama unreachable: ${res.status}`);
  const data = await res.json() as { models?: { name?: string }[] };
  const names = (data.models ?? []).map((entry) => String(entry.name ?? ''));
  if (!names.includes(model)) throw new Error(`model not cached: ${model}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = flag(args, 'dir');
  if (!dir) {
    process.stderr.write('usage: precision-judge.ts --dir <sheet dir> [--model spark-x2-q8:latest] [--prompt sentence|loose|passage]\n');
    process.exit(2);
  }
  const model = flag(args, 'model') ?? 'spark-x2-q8:latest';
  const host = flag(args, 'host') ?? process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  const promptArg = flag(args, 'prompt');
  const mode: 'sentence' | 'loose' | 'passage' =
    promptArg === 'passage' ? 'passage' : promptArg === 'loose' ? 'loose' : 'sentence';
  const runs = 3;
  const rows = readSheet(dir);
  if (!rows.length) throw new Error('sheet has no rows');
  await assertModelAvailable(host, model);

  const verdicts: { id: number; verdict: Verdict; reason: string }[] = [];
  const voteRows: { id: number; votes: Verdict[] }[] = [];
  let judged = 0;
  let empty = 0;
  let unanimous = 0;
  let split = 0;
  let failedCalls = 0;
  let failedRows = 0;
  const errors = new Map<string, number>();

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const emptyRow = mode === 'passage'
      ? !String(row.quote ?? '').trim() || !String(row.passage ?? '').trim()
      : !row.sentence.trim();
    if (emptyRow) {
      empty++;
      verdicts.push({ id: row.id, verdict: 'not_supported', reason: 'no evidence' });
      voteRows.push({ id: row.id, votes: ['not_supported', 'not_supported', 'not_supported'] });
      continue;
    }
    const votes: Verdict[] = [];
    let rowFailures = 0;
    for (let run = 0; run < runs; run++) {
      const result = await judgeWithRetry(host, model, row, run, mode);
      if (!result.ok) {
        rowFailures++;
        failedCalls++;
        errors.set(result.error, (errors.get(result.error) ?? 0) + 1);
        votes.push('not_supported');
      } else {
        votes.push(result.verdict);
      }
    }
    if (votes.every((vote) => vote === votes[0])) unanimous++;
    else split++;
    const supported = votes.filter((vote) => vote === 'supported').length;
    const verdict: Verdict = supported > runs / 2 ? 'supported' : 'not_supported';
    if (rowFailures > 0) {
      failedRows++;
      verdicts.push({ id: row.id, verdict: 'not_supported', reason: `call-failed-${rowFailures}` });
    } else {
      verdicts.push({
        id: row.id,
        verdict,
        reason: reasonOf(verdict === 'supported' ? 'sentence states the tie' : 'sentence does not state the tie'),
      });
    }
    voteRows.push({ id: row.id, votes });
    judged++;
    process.stderr.write(`judged ${index + 1}/${rows.length}\n`);
  }
  const out = flag(args, 'out') ?? join(dir, 'verdicts.csv');
  const lines = [
    'id,verdict,reason',
    ...verdicts.map((row) => [row.id, row.verdict, csvCell(row.reason)].join(',')),
  ];
  writeFileSync(out, `${lines.join('\n')}\n`);
  const votesOut = flag(args, 'votes-out') ?? `${out}.votes.csv`;
  writeFileSync(votesOut, [
    'id,run1,run2,run3',
    ...voteRows.map((row) => [row.id, ...row.votes].join(',')),
  ].join('\n') + '\n');
  console.log(JSON.stringify({
    model,
    rows: rows.length,
    judged,
    empty,
    unanimous,
    split,
    failedCalls,
    failedRows,
    errors: Object.fromEntries(errors),
    out,
    votesOut,
  }));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
