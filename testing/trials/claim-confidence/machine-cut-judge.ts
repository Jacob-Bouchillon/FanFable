/**
 * Blind sentence-proof sample of machine-cut candidates (trials only).
 *
 * Takes 60 of the 265 candidates (seed 42), judges each with the locked
 * sentence prompt via precision-judge.ts, and scores with Wilson 95%.
 * Candidate support rate, not keeper precision.
 *
 * usage: node testing/trials/claim-confidence/machine-cut-judge.ts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { seededShuffle, wilson95 } from './measure-precision.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const DIR = '/tmp/opencode/machine-cut';
const SOURCE = join(DIR, 'candidates.csv');
const SAMPLE_DIR = join(DIR, 'sample');
const MODEL = 'nuextract3-q8:latest';
const SAMPLE = 60;
const SEED = 42;

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

function main(): void {
  if (!existsSync(SOURCE)) throw new Error(`candidates not found: ${SOURCE}`);
  const table = parseCsv(readFileSync(SOURCE, 'utf8'));
  if (table[0]?.join(',') !== 'id,pair,sentence,locator,chunkId,start,end') {
    throw new Error('candidates header mismatch');
  }
  const pool = table.slice(1).map((cells) => ({
    id: Number(cells[0]),
    pair: String(cells[1] ?? ''),
    sentence: String(cells[2] ?? ''),
    locator: String(cells[3] ?? ''),
  }));
  const sample = seededShuffle(pool, SEED).slice(0, SAMPLE);
  mkdirSync(SAMPLE_DIR, { recursive: true });
  writeFileSync(
    join(SAMPLE_DIR, 'sheet.csv'),
    `id,relId,pair,sentence,locator\n${sample
      .map((row, index) => [index + 1, row.id, csvCell(row.pair), csvCell(row.sentence), csvCell(row.locator)].join(','))
      .join('\n')}\n`,
  );

  const verdictsPath = join(DIR, 'verdicts.csv');
  const votesPath = join(DIR, 'verdicts.votes.csv');
  const judge = join(REPO_ROOT, 'testing/trials/claim-confidence/precision-judge.ts');
  const run = spawnSync(
    process.execPath,
    ['--no-warnings', judge, '--dir', SAMPLE_DIR, '--model', MODEL, '--out', verdictsPath, '--votes-out', votesPath],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(`judge failed: ${run.stderr.split('\n').filter(Boolean).pop() ?? run.status}`);
  const health = JSON.parse(String(run.stdout).trim().split('\n').filter(Boolean).pop() ?? '{}') as {
    unanimous?: number;
    split?: number;
    empty?: number;
    failedCalls?: number;
    failedRows?: number;
  };

  const verdictTable = parseCsv(readFileSync(verdictsPath, 'utf8'));
  const verdicts = new Map<number, string>();
  const reasons = new Set<string>();
  for (const cells of verdictTable.slice(1)) {
    verdicts.set(Number(cells[0]), String(cells[1] ?? '').trim());
    if (String(cells[2] ?? '').trim()) reasons.add(String(cells[2]).trim());
  }
  if (verdicts.size !== sample.length) throw new Error(`verdict rows ${verdicts.size} != ${sample.length}`);
  for (let index = 1; index <= sample.length; index++) {
    if (!verdicts.has(index)) throw new Error(`missing verdict id ${index}`);
  }

  const supported = sample.filter((_, index) => verdicts.get(index + 1) === 'supported').length;
  const interval = wilson95(supported, sample.length);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const manifest = {
    schema: 'fanfable-machine-cut-sample/1',
    seed: SEED,
    commit,
    composition: {
      pool: pool.length,
      sampled: sample.length,
      judge: MODEL,
      prompt: 'sentence',
      subject: 'candidate support rate, not keeper precision',
    },
  };
  writeFileSync(join(DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(JSON.stringify({
    n: sample.length,
    supported,
    precision: Number((supported / sample.length).toFixed(6)),
    wilsonLow: interval ? Number(interval.low.toFixed(6)) : 'PENDING',
    wilsonHigh: interval ? Number(interval.high.toFixed(6)) : 'PENDING',
    health: {
      unanimous3to0: Number(health.unanimous ?? 0),
      split2to1: Number(health.split ?? 0),
      emptySkipped: Number(health.empty ?? 0),
      failedCalls: Number(health.failedCalls ?? 0),
      failedRows: Number(health.failedRows ?? 0),
      uniqueReasons: reasons.size,
    },
    manifest,
  }));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
