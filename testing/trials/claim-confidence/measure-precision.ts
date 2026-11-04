/**
 * Bank-level keeper precision (trials only; offline measurement).
 *
 * Keeper  = canon_relation with review_status IN ('accepted','user_confirmed').
 * True    = a blind local verdict of `supported` on the id+pair+sentence sheet.
 *
 * The sampler is deterministic for a given seed and writes only sheet.csv and
 * manifest.json; it never writes to the source bank and never records a claim
 * status, confidence or kind on the sheet. Verdicts stay local. Scoring joins
 * a local verdicts.csv and reports counts, precision and a Wilson 95% interval.
 *
 * usage:
 *   node testing/trials/claim-confidence/measure-precision.ts \
 *     sample --db <copy.db> --out <dir> --seed 42 --n 120 [--project <name>]
 *   node testing/trials/claim-confidence/measure-precision.ts score --dir <dir>
 *
 * No model calls, no network, no extraction. `sample` opens the database
 * read-only; `<copy.db>` must already be a disposable copy of the bank.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

export const KEEPER_PREDICATE = "review_status IN ('accepted','user_confirmed')";
export const SHEET_COLUMNS = ['id', 'relId', 'pair', 'sentence', 'locator'] as const;
export const VERDICT_VALUES = ['supported', 'not_supported'] as const;
export const MANIFEST_SCHEMA = 'fanfable-precision-sheet/1';
const REASON_MAX_WORDS = 12;
const REPO_ROOT = resolve(import.meta.dirname, '../../..');

export interface SampleOptions {
  seed?: number;
  n?: number;
  project?: string;
  /** Fixed for tests; production uses the current clock. */
  now?: string;
  /** Fixed for tests; production reads HEAD. */
  commit?: string;
}

export interface SampledRow {
  id: number;
  relId: number;
  pair: string;
  sentence: string;
  locator: string;
}

export interface SampleResult {
  sheetPath: string;
  manifestPath: string;
  keepers: number;
  sampled: number;
  commit: string;
}

export interface ScoreResult {
  keepers: number;
  supported: number;
  pending: number;
  precision: number | 'PENDING';
  wilsonLow: number | 'PENDING';
  wilsonHigh: number | 'PENDING';
  integrityExit: number;
  commit: string;
  status: 'OK' | 'PENDING';
}

function readOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
  } catch {
    /* a read-only connection may refuse PRAGMA writes; the default timeout is enough */
  }
  return db;
}

/** Deterministic PRNG (mulberry32) so a seed pins the sample. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates over a relId-ordered copy: same seed and rows give the same order. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const next = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Wilson score interval for a binomial proportion, z = 1.96 (95%). */
export function wilson95(supported: number, keepers: number): { low: number; high: number } | null {
  if (!Number.isFinite(keepers) || keepers <= 0 || supported < 0 || supported > keepers) return null;
  const z = 1.959963984540054;
  const p = supported / keepers;
  const z2 = z * z;
  const denom = 1 + z2 / keepers;
  const center = (p + z2 / (2 * keepers)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / keepers + z2 / (4 * keepers * keepers))) / denom;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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

function readCsv(path: string): { header: string[]; rows: string[][] } {
  const table = parseCsv(readFileSync(path, 'utf8'));
  const header = table[0] ?? [];
  return { header, rows: table.slice(1) };
}

function gitHead(): string {
  try {
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    return hash || 'unknown';
  } catch {
    return 'unknown';
  }
}

function locatorOf(sourceRefs: string): string {
  try {
    const refs = JSON.parse(sourceRefs || '[]') as { locator?: unknown }[];
    if (!Array.isArray(refs)) return '';
    const ref = refs.find((item) => String(item?.locator ?? '').trim() !== '');
    return String(ref?.locator ?? '').trim();
  } catch {
    return '';
  }
}

function chooseProject(db: DatabaseSync, wanted?: string): { id: number; name: string } {
  const projects = db.prepare('SELECT id, name FROM project ORDER BY id').all() as { id: number; name: string }[];
  if (!projects.length) throw new Error('database has no project');
  if (wanted) {
    const hit = projects.find((project) => project.name === wanted);
    if (!hit) throw new Error(`project not found: ${wanted}`);
    return hit;
  }
  if (projects.length > 1) throw new Error('multiple projects; pass --project <name>');
  return projects[0]!;
}

export function sampleKeepers(dbPath: string, outDir: string, opts: SampleOptions = {}): SampleResult {
  if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  const seed = opts.seed ?? 42;
  const n = opts.n ?? 120;
  if (!Number.isInteger(seed) || seed < 0) throw new Error('--seed must be a non-negative integer');
  if (!Number.isInteger(n) || n <= 0) throw new Error('--n must be a positive integer');

  const db = readOnly(dbPath);
  let project: { id: number; name: string };
  let keepers: {
    relId: number;
    fromName: string;
    toName: string;
    sentence: string;
    sourceRefs: string;
  }[];
  try {
    project = chooseProject(db, opts.project);
    keepers = db
      .prepare(
        `SELECT r.id AS relId, a.name AS fromName, b.name AS toName,
                r.evidence AS sentence, coalesce(r.source_refs, '[]') AS sourceRefs
           FROM canon_relation r
           JOIN canon_entity a ON a.id = r.from_entity
           JOIN canon_entity b ON b.id = r.to_entity
          WHERE r.project_id = ? AND r.review_status IN ('accepted','user_confirmed')
          ORDER BY r.id`,
      )
      .all(project.id) as typeof keepers;
  } finally {
    db.close();
  }

  const ordered = [...keepers].sort((a, b) => a.relId - b.relId);
  const chosen = seededShuffle(ordered, seed).slice(0, Math.min(n, ordered.length));
  const rows: SampledRow[] = chosen.map((row, index) => {
    if (!Number.isInteger(row.relId) || row.relId <= 0) {
      throw new Error(`keeper row ${index + 1} has no relation id`);
    }
    return {
      id: index + 1,
      relId: row.relId,
      pair: `${row.fromName} / ${row.toName}`,
      sentence: String(row.sentence ?? '').trim(),
      locator: locatorOf(row.sourceRefs),
    };
  });

  mkdirSync(outDir, { recursive: true });
  const sheetPath = join(outDir, 'sheet.csv');
  const manifestPath = join(outDir, 'manifest.json');
  const csv = [SHEET_COLUMNS.join(','), ...rows.map((row) => SHEET_COLUMNS.map((column) => csvCell(row[column])).join(','))];
  writeFileSync(sheetPath, `${csv.join('\n')}\n`);

  const commit = opts.commit ?? gitHead();
  const manifest = {
    schema: MANIFEST_SCHEMA,
    model: null,
    seed,
    commit,
    keeperPredicate: KEEPER_PREDICATE,
    verdictValues: [...VERDICT_VALUES],
    project: { id: project.id, name: project.name },
    db: dbPath,
    sampledAt: opts.now ?? new Date().toISOString(),
    counts: { keepers: ordered.length, sampled: rows.length },
    columns: [...SHEET_COLUMNS],
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { sheetPath, manifestPath, keepers: ordered.length, sampled: rows.length, commit };
}

interface SheetRow extends SampledRow {}

function readSheet(dir: string): { rows: SheetRow[]; manifest: Record<string, unknown> } {
  const sheetPath = join(dir, 'sheet.csv');
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(sheetPath)) throw new Error(`sheet not found: ${sheetPath}`);
  if (!existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`);
  const { header, rows } = readCsv(sheetPath);
  if (header.join(',') !== SHEET_COLUMNS.join(',')) {
    throw new Error(`sheet header must be exactly ${SHEET_COLUMNS.join(',')}`);
  }
  const parsed = rows.map((cells, index) => {
    const [id, relId, pair, sentence, locator] = cells;
    const rel = Number(relId);
    if (!Number.isInteger(rel) || rel <= 0) throw new Error(`sheet row ${index + 1} has no relId`);
    return { id: Number(id), relId: rel, pair: pair ?? '', sentence: sentence ?? '', locator: locator ?? '' };
  });
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  return { rows: parsed, manifest };
}

interface VerdictRow {
  id: number;
  verdict: (typeof VERDICT_VALUES)[number];
  reason: string;
}

function readVerdicts(dir: string): VerdictRow[] {
  const path = join(dir, 'verdicts.csv');
  if (!existsSync(path)) return [];
  const { header, rows } = readCsv(path);
  if (header.join(',') !== 'id,verdict,reason') {
    throw new Error('verdicts header must be exactly id,verdict,reason');
  }
  return rows.map((cells, index) => {
    const [rawId, rawVerdict, rawReason] = cells;
    const id = Number(rawId);
    const verdict = String(rawVerdict ?? '').trim();
    const reason = String(rawReason ?? '').trim();
    if (!Number.isInteger(id) || id <= 0) throw new Error(`verdict row ${index + 1} has no valid id`);
    if (!(VERDICT_VALUES as readonly string[]).includes(verdict)) {
      throw new Error(`verdict row ${index + 1} must be one of ${VERDICT_VALUES.join(', ')}`);
    }
    const words = reason ? reason.split(/\s+/).filter(Boolean).length : 0;
    if (words < 1 || words > REASON_MAX_WORDS) {
      throw new Error(`verdict row ${index + 1} reason must be 1-${REASON_MAX_WORDS} words`);
    }
    return { id, verdict: verdict as VerdictRow['verdict'], reason };
  });
}

/** Run `lore integrity` on a throwaway byte copy so the sampled bank is never written. */
export function runIntegrity(dbPath: string, projectName: string): number {
  if (!existsSync(dbPath)) return -1;
  let tempDir: string;
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'fanfable-integrity-'));
    const copy = join(tempDir, 'copy.db');
    copyFileSync(dbPath, copy);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${dbPath}${suffix}`)) copyFileSync(`${dbPath}${suffix}`, `${copy}${suffix}`);
    }
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', 'fanfable/src/cli.ts', '--db', copy, '--project', projectName, 'lore', 'integrity'],
      { cwd: REPO_ROOT, env: process.env, encoding: 'utf8' },
    );
    return typeof result.status === 'number' ? result.status : 1;
  } catch {
    return -1;
  }
}

export function scorePrecision(
  dir: string,
  opts: { integrity?: (dbPath: string, projectName: string) => number } = {},
): ScoreResult {
  const { rows, manifest } = readSheet(dir);
  const verdicts = readVerdicts(dir);
  const byId = new Map<number, VerdictRow>();
  for (const verdict of verdicts) {
    if (byId.has(verdict.id)) throw new Error(`duplicate verdict id ${verdict.id}`);
    byId.set(verdict.id, verdict);
  }
  for (const id of byId.keys()) {
    if (!rows.some((row) => row.id === id)) throw new Error(`verdict id ${id} is not on the sheet`);
  }

  const keepers = rows.length;
  const matched = rows.filter((row) => byId.has(row.id));
  const supported = matched.filter((row) => byId.get(row.id)!.verdict === 'supported').length;
  const pending = keepers - matched.length;
  const complete = keepers > 0 && pending === 0;
  const interval = complete && wilson95(supported, keepers);
  const manifestDb = String(manifest.db ?? '');
  const project = (manifest.project ?? {}) as { name?: unknown };
  const projectName = String(project.name ?? '');
  const integrityExit = opts.integrity
    ? opts.integrity(manifestDb, projectName)
    : runIntegrity(manifestDb, projectName);
  const commit = String(manifest.commit ?? gitHead());

  return {
    keepers,
    supported,
    pending,
    precision: interval ? Number((supported / keepers).toFixed(6)) : 'PENDING',
    wilsonLow: interval ? Number(interval.low.toFixed(6)) : 'PENDING',
    wilsonHigh: interval ? Number(interval.high.toFixed(6)) : 'PENDING',
    integrityExit,
    commit,
    status: complete ? 'OK' : 'PENDING',
  };
}

/* ---------------------------------------------------------------------- cli */

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
}

function usage(): never {
  process.stderr.write(
    'usage:\n' +
      '  measure-precision.ts sample --db <copy.db> --out <dir> [--seed 42] [--n 120] [--project <name>]\n' +
      '  measure-precision.ts score --dir <dir>\n',
  );
  process.exit(2);
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === 'sample') {
    const db = flag(args, 'db');
    const out = flag(args, 'out');
    if (!db || !out) usage();
    const result = sampleKeepers(db, out, {
      seed: Number(flag(args, 'seed') ?? 42),
      n: Number(flag(args, 'n') ?? 120),
      project: flag(args, 'project'),
    });
    process.stderr.write(`keepers=${result.keepers} sampled=${result.sampled} commit=${result.commit}\n`);
    return;
  }
  if (command === 'score') {
    const dir = flag(args, 'dir');
    if (!dir) usage();
    const result = scorePrecision(dir);
    process.stderr.write(
      `keepers=${result.keepers} supported=${result.supported} pending=${result.pending} status=${result.status}\n`,
    );
    console.log(
      JSON.stringify({
        keepers: result.keepers,
        supported: result.supported,
        precision: result.precision,
        wilsonLow: result.wilsonLow,
        wilsonHigh: result.wilsonHigh,
        integrityExit: result.integrityExit,
        commit: result.commit,
      }),
    );
    process.exitCode = result.integrityExit === 0 ? 0 : 1;
    return;
  }
  usage();
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) main();
