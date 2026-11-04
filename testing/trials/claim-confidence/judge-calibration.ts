/**
 * Judge calibration with positive controls (trials only, not in npm test).
 *
 * Builds a 30-row sheet mixing invented clear-statement controls, rows a
 * judge previously supported, and regathered keepers, runs both judges with
 * the locked prompt, and prints per-stratum rates. Counts only: no sentence,
 * reason or per-row output.
 *
 * usage: node testing/trials/claim-confidence/judge-calibration.ts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { seededShuffle, wilson95 } from './measure-precision.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const DIR = '/tmp/opencode/judge-calibration';
const HALF = '/tmp/opencode/precision-half';
const REGATHERED = '/tmp/opencode/precision-regathered';
const SPARK = 'spark-x2-q8:latest';
const SECOND = 'nuextract3-q8:latest';

type Stratum = 'synthetic' | 'previous' | 'regathered';

interface Row {
  id: number;
  relId: number;
  pair: string;
  sentence: string;
  locator: string;
  stratum: Stratum;
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

function readSheet(path: string): { id: number; relId: number; pair: string; sentence: string; locator: string }[] {
  const table = parseCsv(readFileSync(path, 'utf8'));
  if (table[0]?.join(',') !== 'id,relId,pair,sentence,locator') throw new Error(`bad sheet header: ${path}`);
  return table.slice(1).map((cells) => ({
    id: Number(cells[0]),
    relId: Number(cells[1]),
    pair: String(cells[2] ?? ''),
    sentence: String(cells[3] ?? ''),
    locator: String(cells[4] ?? ''),
  }));
}

function readVerdicts(path: string): Map<number, string> {
  const table = parseCsv(readFileSync(path, 'utf8'));
  return new Map(table.slice(1).map((cells) => [Number(cells[0]), String(cells[1] ?? '').trim()]));
}

const SYNTHETIC: [string, string][] = [
  ['Aster / Brin', 'Aster is the mentor of Brin.'],
  ['Calla / Dorn', 'Calla is the sister of Dorn.'],
  ['Elowen / Fenn', 'Elowen is the mother of Fenn.'],
  ['Gale / Hollis', 'Gale serves as the apprentice of Hollis.'],
  ['Ivo / Jora', 'Ivo is the employer of Jora.'],
  ['Kestrel / Lior', 'Kestrel is the friend of Lior.'],
  ['Mira / Neris', 'Mira is the aunt of Neris.'],
  ['Brin / Aster', 'Brin works for Aster.'],
  ['Dorn / Calla', 'Dorn is married to Calla.'],
  ['Fenn / Elowen', 'Fenn is the student of Elowen.'],
  ['Hollis / Ivo', 'Hollis is the captain of Ivo.'],
  ['Jora / Kestrel', 'Jora is the ally of Kestrel.'],
  ['Lior / Mira', 'Lior is the rival of Mira.'],
  ['Neris / Aster', 'Neris is the cousin of Aster.'],
  ['Aster / Brin', 'Aster trusts Brin.'],
  ['Brin / Calla', 'Brin is the bodyguard of Calla.'],
  ['Calla / Dorn', 'Calla serves Dorn.'],
  ['Dorn / Elowen', 'Dorn is the son of Elowen.'],
  ['Elowen / Gale', 'Elowen is the grandmother of Gale.'],
  ['Gale / Fenn', 'Gale is the partner of Fenn.'],
];

function assertServer(): void {
  const check = spawnSync('curl', ['-s', '--max-time', '5', 'http://127.0.0.1:11434/api/tags'], {
    encoding: 'utf8',
  });
  if (check.status !== 0) throw new Error('ollama-unavailable');
  const names = new Set<string>(
    (JSON.parse(check.stdout) as { models?: { name?: string }[] }).models?.map((m) => String(m.name ?? '')) ?? [],
  );
  if (!names.has(SPARK) || !names.has(SECOND)) throw new Error('ollama-model-missing');
}

function runJudge(model: string, out: string, votes: string): { failedCalls: number; unanimous: number; split: number; empty: number } {
  const judge = join(REPO_ROOT, 'testing/trials/claim-confidence/precision-judge.ts');
  const run = spawnSync(
    process.execPath,
    ['--no-warnings', judge, '--dir', DIR, '--model', model, '--out', out, '--votes-out', votes],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(`judge-failed-${model}`);
  const line = String(run.stdout).trim().split('\n').filter(Boolean).pop() ?? '{}';
  const parsed = JSON.parse(line) as { failedCalls?: number; unanimous?: number; split?: number; empty?: number };
  return {
    failedCalls: Number(parsed.failedCalls ?? 0),
    unanimous: Number(parsed.unanimous ?? 0),
    split: Number(parsed.split ?? 0),
    empty: Number(parsed.empty ?? 0),
  };
}

function main(): void {
  assertServer();
  mkdirSync(DIR, { recursive: true });

  const rows: Row[] = [];

  const halfSheet = readSheet(join(HALF, 'sheet.csv'));
  const sparkVerdicts = readVerdicts(join(HALF, 'verdicts.csv'));
  const secondVerdicts = readVerdicts(join(HALF, 'verdicts-nuextract3.csv'));
  const supported: Row[] = [];
  const seen = new Set<string>();
  const pushSupported = (row: typeof halfSheet[number]): void => {
    const key = `${row.relId}\u0000${row.pair}\u0000${row.sentence}`;
    if (seen.has(key)) return;
    seen.add(key);
    supported.push({ ...row, id: 0, stratum: 'previous' });
  };
  for (const row of halfSheet) if (sparkVerdicts.get(row.id) === 'supported') pushSupported(row);
  for (const row of halfSheet) if (secondVerdicts.get(row.id) === 'supported') pushSupported(row);
  const previous = supported.slice(0, 8);
  const syntheticCount = 18 - previous.length;
  if (syntheticCount > SYNTHETIC.length) throw new Error('not enough synthetic controls');
  for (let index = 0; index < syntheticCount; index++) {
    const [pair, sentence] = SYNTHETIC[index]!;
    rows.push({
      id: 0,
      relId: 900000 + index,
      pair,
      sentence,
      locator: `SYN-${index + 1}`,
      stratum: 'synthetic',
    });
  }
  rows.push(...previous);

  const regathered = readSheet(join(REGATHERED, 'sheet.csv')).sort((a, b) => a.id - b.id).slice(0, 12);
  if (regathered.length !== 12) throw new Error(`expected 12 regathered rows, got ${regathered.length}`);
  rows.push(...regathered.map((row) => ({ ...row, id: 0, stratum: 'regathered' as const })));

  if (rows.length !== 30) throw new Error(`expected 30 rows, got ${rows.length}`);
  const shuffled = seededShuffle(rows, 42);
  shuffled.forEach((row, index) => {
    row.id = index + 1;
  });

  writeFileSync(
    join(DIR, 'sheet.csv'),
    `id,relId,pair,sentence,locator\n${shuffled
      .map((row) => [row.id, row.relId, csvCell(row.pair), csvCell(row.sentence), csvCell(row.locator)].join(','))
      .join('\n')}\n`,
  );
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  writeFileSync(
    join(DIR, 'manifest.json'),
    `${JSON.stringify({
      schema: 'fanfable-judge-calibration/1',
      model: null,
      seed: 42,
      commit,
      n: 30,
      composition: {
        synthetic: shuffled.filter((row) => row.stratum === 'synthetic').length,
        previous: shuffled.filter((row) => row.stratum === 'previous').length,
        regathered: shuffled.filter((row) => row.stratum === 'regathered').length,
      },
    }, null, 2)}\n`,
  );

  const sparkOut = join(DIR, 'verdicts-spark.csv');
  const secondOut = join(DIR, 'verdicts-2nd.csv');
  const sparkRun = runJudge(SPARK, sparkOut, join(DIR, 'verdicts-spark.votes.csv'));
  const secondRun = runJudge(SECOND, secondOut, join(DIR, 'verdicts-2nd.votes.csv'));

  const spark = readVerdicts(sparkOut);
  const second = readVerdicts(secondOut);
  if (spark.size !== 30 || second.size !== 30) throw new Error('verdict rows not 30');

  const strata: Stratum[] = ['synthetic', 'previous', 'regathered'];
  const score = (verdicts: Map<number, string>) => Object.fromEntries(
    strata.map((stratum) => {
      const ids = shuffled.filter((row) => row.stratum === stratum).map((row) => row.id);
      const supportedCount = ids.filter((id) => verdicts.get(id) === 'supported').length;
      const interval = wilson95(supportedCount, ids.length);
      return [stratum, {
        n: ids.length,
        supported: supportedCount,
        precision: Number((supportedCount / Math.max(1, ids.length)).toFixed(6)),
        wilsonLow: interval ? Number(interval.low.toFixed(6)) : 'PENDING',
        wilsonHigh: interval ? Number(interval.high.toFixed(6)) : 'PENDING',
      }];
    }),
  );

  const reasons = (path: string): number => {
    const table = parseCsv(readFileSync(path, 'utf8'));
    return new Set(table.slice(1).map((cells) => String(cells[2] ?? '').trim()).filter(Boolean)).size;
  };

  const agreement = shuffled.filter((row) => spark.get(row.id) === second.get(row.id)).length;
  console.log(JSON.stringify({
    n: 30,
    composition: {
      synthetic: shuffled.filter((row) => row.stratum === 'synthetic').length,
      previous: shuffled.filter((row) => row.stratum === 'previous').length,
      regathered: shuffled.filter((row) => row.stratum === 'regathered').length,
    },
    syntheticSupportedPerJudge: { spark: score(spark).synthetic, second: score(second).synthetic },
    previousSupportedPerJudge: { spark: score(spark).previous, second: score(second).previous },
    regatheredSupportedPerJudge: { spark: score(spark).regathered, second: score(second).regathered },
    overallAgreement: { n: 30, agree: agreement, disagree: 30 - agreement },
    unanimityCounts: { spark: sparkRun, second: secondRun },
    uniqueReasonsPerJudge: { spark: reasons(sparkOut), second: reasons(secondOut) },
    models: { spark: SPARK, second: SECOND },
  }));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
