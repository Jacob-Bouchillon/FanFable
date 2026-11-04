/**
 * Agreement between two blind judges on one precision sheet (trials only).
 *
 * Reads the Phase 0 sheet and two verdicts.csv files, prints counts only:
 * support totals, agreement, per-judge reason diversity, and 3-0 unanimity
 * where a votes sidecar exists. Never prints sentences, reasons or row ids.
 *
 * usage:
 *   node testing/trials/claim-confidence/precision-agreement.ts --dir <sheet dir>
 *     [--spark verdicts.csv] [--second verdicts-smollm3.csv]
 *     [--second-votes verdicts-smollm3.votes.csv]
 *     [--spark-unanimous <n>] [--spark-model <name>] [--second-model <name>]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

function readVerdicts(path: string): Map<number, string> {
  if (!existsSync(path)) throw new Error(`verdicts not found: ${path}`);
  const table = parseCsv(readFileSync(path, 'utf8'));
  if (table[0]?.join(',') !== 'id,verdict,reason') throw new Error(`bad verdicts header: ${path}`);
  const out = new Map<number, string>();
  for (const [rawId, verdict] of table.slice(1)) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`bad verdict id in ${path}`);
    out.set(id, String(verdict ?? '').trim());
  }
  return out;
}

function readReasons(path: string): string[] {
  const table = parseCsv(readFileSync(path, 'utf8'));
  return table.slice(1).map((cells) => String(cells[2] ?? '').trim()).filter(Boolean);
}

function readVotes(path: string): Map<number, string[]> | null {
  if (!existsSync(path)) return null;
  const table = parseCsv(readFileSync(path, 'utf8'));
  if (table[0]?.join(',') !== 'id,run1,run2,run3') return null;
  const out = new Map<number, string[]>();
  for (const [rawId, a, b, c] of table.slice(1)) {
    const id = Number(rawId);
    out.set(id, [String(a ?? '').trim(), String(b ?? '').trim(), String(c ?? '').trim()]);
  }
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const dir = flag(args, 'dir');
  if (!dir) {
    process.stderr.write('usage: precision-agreement.ts --dir <sheet dir> [--spark file] [--second file]\n');
    process.exit(2);
  }
  const sparkPath = join(dir, flag(args, 'spark') ?? 'verdicts.csv');
  const secondPath = join(dir, flag(args, 'second') ?? 'verdicts-smollm3.csv');
  const votesPath = join(dir, flag(args, 'second-votes') ?? 'verdicts-smollm3.votes.csv');
  const sheet = parseCsv(readFileSync(join(dir, 'sheet.csv'), 'utf8')).slice(1);
  const sheetIds = new Set(sheet.map((cells) => Number(cells[0])));
  const spark = readVerdicts(sparkPath);
  const second = readVerdicts(secondPath);
  if (sheetIds.size !== spark.size || sheetIds.size !== second.size) {
    throw new Error(`row count mismatch: sheet=${sheetIds.size} spark=${spark.size} second=${second.size}`);
  }
  for (const id of sheetIds) {
    if (!spark.has(id) || !second.has(id)) throw new Error(`id ${id} missing from a verdict file`);
  }

  let sparkSupported = 0;
  let secondSupported = 0;
  let agree = 0;
  let bothSupported = 0;
  let bothRejected = 0;
  let sparkOnly = 0;
  let secondOnly = 0;
  for (const id of sheetIds) {
    const a = spark.get(id) === 'supported';
    const b = second.get(id) === 'supported';
    if (a) sparkSupported++;
    if (b) secondSupported++;
    if (a === b) agree++;
    if (a && b) bothSupported++;
    if (!a && !b) bothRejected++;
    if (a && !b) sparkOnly++;
    if (!a && b) secondOnly++;
  }

  const votes = readVotes(votesPath);
  const secondUnanimous = votes
    ? [...votes.values()].filter((row) => row.length === 3 && row.every((vote) => vote === row[0])).length
    : null;
  const sparkUnanimousFlag = flag(args, 'spark-unanimous');

  console.log(JSON.stringify({
    n: sheetIds.size,
    sparkSupported,
    secondSupported,
    agree,
    disagree: sheetIds.size - agree,
    bothSupported,
    bothRejected,
    sparkOnly,
    secondOnly,
    uniqueReasonsPerJudge: {
      spark: new Set(readReasons(sparkPath)).size,
      second: new Set(readReasons(secondPath)).size,
    },
    unanimous3to0PerJudge: {
      spark: sparkUnanimousFlag === undefined ? null : Number(sparkUnanimousFlag),
      second: secondUnanimous,
    },
    sparkModel: flag(args, 'spark-model') ?? null,
    secondModel: flag(args, 'second-model') ?? null,
  }));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
