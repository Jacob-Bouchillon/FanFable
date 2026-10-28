/**
 * Local progress state for a long benchmark run.
 *
 * A run writes two files in its own directory:
 *
 *   progress.json   the current state, replaced atomically
 *   progress.jsonl  append-only stage events
 *
 * The state holds counts, timestamps and short errors. It never holds prompts,
 * generated prose, answer-key data or rating values. The watcher only reads
 * these files (and the two rating sheets when they exist), so watching a run
 * cannot change it or unblind it.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type StageStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed';

export interface StageDefinition {
  key: string;
  label: string;
}

/** The lifecycle of the paired extractor test, in display order. */
export const LIFECYCLE_STAGES: StageDefinition[] = [
  { key: 'corpus-source', label: 'corpus/source preparation' },
  { key: 'extract-qwen', label: 'Qwen extraction + canon-event indexing' },
  { key: 'extract-gemma', label: 'Gemma extraction + canon-event indexing' },
  { key: 'writing-paired', label: 'paired Gemma writer samples' },
  { key: 'blind-packet', label: 'blind packet creation' },
  { key: 'ratings-human', label: 'waiting for human ratings' },
  { key: 'ratings-ai', label: 'waiting for independent AI ratings' },
  { key: 'comparison', label: 'rating comparison + final unblinding' },
];

export type StageKey = (typeof LIFECYCLE_STAGES)[number]['key'];

/** The extraction arm a corpus belongs to, by baseline model name. */
export function extractionStageFor(model: string): StageKey {
  return model.toLowerCase().includes('gemma') ? 'extract-gemma' : 'extract-qwen';
}

export interface ProgressStage {
  key: string;
  label: string;
  status: StageStatus;
  completed: number;
  total: number | null;
  unit: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
  detail: string | null;
  error: string | null;
}

export interface ProgressError {
  at: string;
  stage: string;
  message: string;
}

export interface ProgressState {
  version: 1;
  runId: string;
  createdAt: string;
  updatedAt: string;
  status: 'running' | 'waiting' | 'done' | 'failed';
  currentStage: string | null;
  stages: ProgressStage[];
  errors: ProgressError[];
}

export interface ProgressOptions {
  /** Parent directory; progress lives in <root>/<run-id>/. */
  root?: string;
  now?: () => Date;
  stages?: StageDefinition[];
}

export const DEFAULT_PROGRESS_ROOT = 'testing/benchmarks/runs';

function iso(now: () => Date): string {
  return now().toISOString();
}

function blankStage(definition: StageDefinition): ProgressStage {
  return {
    key: definition.key,
    label: definition.label,
    status: 'pending',
    completed: 0,
    total: null,
    unit: 'items',
    startedAt: null,
    finishedAt: null,
    updatedAt: null,
    detail: null,
    error: null,
  };
}

function clip(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function progressDir(runId: string, root = DEFAULT_PROGRESS_ROOT): string {
  return join(root, runId);
}

export function progressPath(runId: string, root = DEFAULT_PROGRESS_ROOT): string {
  return join(progressDir(runId, root), 'progress.json');
}

function parseState(text: string, runId: string, path: string): ProgressState {
  let parsed: ProgressState;
  try {
    parsed = JSON.parse(text) as ProgressState;
  } catch (err) {
    throw new Error(`cannot parse progress state at ${path}: ${(err as Error).message}`);
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.stages)) {
    throw new Error(`progress state at ${path} has an unsupported shape`);
  }
  if (parsed.runId !== runId) {
    throw new Error(`progress state at ${path} belongs to run "${parsed.runId}", not "${runId}"`);
  }
  return parsed;
}

/** Read the current state, or null when the run has not written one yet. */
export function readProgress(runId: string, root = DEFAULT_PROGRESS_ROOT): ProgressState | null {
  const path = progressPath(runId, root);
  if (!existsSync(path)) return null;
  return parseState(readFileSync(path, 'utf8'), runId, path);
}

function deriveStatus(stages: ProgressStage[]): ProgressState['status'] {
  if (stages.some((stage) => stage.status === 'failed')) return 'failed';
  if (stages.every((stage) => stage.status === 'done')) return 'done';
  if (stages.some((stage) => stage.status === 'waiting')) return 'waiting';
  return 'running';
}

function deriveCurrent(stages: ProgressStage[]): string | null {
  const running = stages.find((stage) => stage.status === 'running');
  if (running) return running.key;
  const waiting = stages.find((stage) => stage.status === 'waiting');
  if (waiting) return waiting.key;
  const unfinished = stages.find((stage) => stage.status !== 'done');
  return unfinished?.key ?? null;
}

interface StartOptions {
  total?: number | null;
  unit?: string;
  detail?: string;
  /** Add this arm's work to an existing total instead of replacing it. */
  addTotal?: boolean;
}

export class ProgressStore {
  readonly runId: string;
  readonly dir: string;
  readonly statePath: string;
  readonly eventsPath: string;
  private readonly now: () => Date;
  private state: ProgressState;

  constructor(runId: string, opts: ProgressOptions = {}) {
    if (!runId.trim()) throw new Error('a progress run id is required');
    this.runId = runId;
    this.dir = progressDir(runId, opts.root);
    this.statePath = join(this.dir, 'progress.json');
    this.eventsPath = join(this.dir, 'progress.jsonl');
    this.now = opts.now ?? (() => new Date());
    mkdirSync(this.dir, { recursive: true });

    if (existsSync(this.statePath)) {
      this.state = parseState(readFileSync(this.statePath, 'utf8'), runId, this.statePath);
    } else {
      const at = iso(this.now);
      this.state = {
        version: 1,
        runId,
        createdAt: at,
        updatedAt: at,
        status: 'running',
        currentStage: null,
        stages: (opts.stages ?? LIFECYCLE_STAGES).map(blankStage),
        errors: [],
      };
      this.state.currentStage = deriveCurrent(this.state.stages);
      this.save({ type: 'run-created' });
    }
  }

  static open(runId: string, opts: ProgressOptions = {}): ProgressStore {
    return new ProgressStore(runId, opts);
  }

  get current(): ProgressState {
    return this.state;
  }

  private stage(key: string): ProgressStage {
    let stage = this.state.stages.find((row) => row.key === key);
    if (!stage) {
      stage = blankStage({ key, label: key });
      this.state.stages.push(stage);
    }
    return stage;
  }

  private touch(stage?: ProgressStage): void {
    const at = iso(this.now);
    this.state.updatedAt = at;
    this.state.status = deriveStatus(this.state.stages);
    this.state.currentStage = deriveCurrent(this.state.stages);
    if (stage) stage.updatedAt = at;
  }

  private save(event: Record<string, unknown>): void {
    this.touch();
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n');
    renameSync(tmp, this.statePath);
    appendFileSync(this.eventsPath, JSON.stringify({ at: this.state.updatedAt, ...event }) + '\n');
  }

  startStage(key: string, opts: StartOptions = {}): ProgressStage {
    const stage = this.stage(key);
    const at = iso(this.now);
    if (opts.addTotal && opts.total !== undefined && opts.total !== null) {
      stage.total = (stage.total ?? 0) + opts.total;
    } else if (opts.total !== undefined) {
      stage.total = opts.total;
    }
    if (opts.unit) stage.unit = opts.unit;
    if (opts.detail !== undefined) stage.detail = clip(opts.detail);
    stage.error = null;
    if (stage.status !== 'done' || (stage.total !== null && stage.completed < stage.total)) {
      stage.status = 'running';
    }
    stage.startedAt ??= at;
    stage.finishedAt = null;
    this.save({
      type: 'stage-started',
      stage: key,
      completed: stage.completed,
      total: stage.total,
      detail: stage.detail,
    });
    return stage;
  }

  setCounts(
    key: string,
    counts: { completed?: number; total?: number | null; detail?: string; unit?: string },
  ): ProgressStage {
    const stage = this.stage(key);
    if (counts.completed !== undefined) stage.completed = Math.max(0, counts.completed);
    if (counts.total !== undefined) stage.total = counts.total;
    if (counts.unit) stage.unit = counts.unit;
    if (counts.detail !== undefined) stage.detail = clip(counts.detail);
    if (stage.status === 'pending') stage.status = 'running';
    stage.startedAt ??= iso(this.now);
    this.save({
      type: 'stage-progress',
      stage: key,
      completed: stage.completed,
      total: stage.total,
      detail: stage.detail,
    });
    return stage;
  }

  advance(key: string, by = 1, detail?: string): ProgressStage {
    const stage = this.stage(key);
    stage.completed += by;
    if (stage.total !== null && stage.completed > stage.total) stage.total = stage.completed;
    if (detail !== undefined) stage.detail = clip(detail);
    stage.startedAt ??= iso(this.now);
    this.save({
      type: 'stage-progress',
      stage: key,
      completed: stage.completed,
      total: stage.total,
      detail: stage.detail,
    });
    return stage;
  }

  setWaiting(
    key: string,
    opts: { total?: number | null; completed?: number; unit?: string; detail?: string } = {},
  ): ProgressStage {
    const stage = this.stage(key);
    if (opts.total !== undefined) stage.total = opts.total;
    if (opts.completed !== undefined) stage.completed = opts.completed;
    if (opts.unit) stage.unit = opts.unit;
    if (opts.detail !== undefined) stage.detail = clip(opts.detail);
    stage.status = 'waiting';
    stage.startedAt ??= iso(this.now);
    stage.finishedAt = null;
    this.save({
      type: 'stage-waiting',
      stage: key,
      completed: stage.completed,
      total: stage.total,
      detail: stage.detail,
    });
    return stage;
  }

  completeStage(key: string, detail?: string): ProgressStage {
    const stage = this.stage(key);
    if (detail !== undefined) stage.detail = clip(detail);
    if (stage.total !== null) stage.completed = stage.total;
    stage.status = 'done';
    stage.finishedAt = iso(this.now);
    stage.error = null;
    this.save({
      type: 'stage-completed',
      stage: key,
      completed: stage.completed,
      total: stage.total,
      detail: stage.detail,
    });
    return stage;
  }

  recordError(key: string, message: string): void {
    const stage = this.stage(key);
    const text = clip(message);
    stage.error = text;
    this.state.errors.push({ at: iso(this.now), stage: key, message: text });
    this.save({ type: 'error', stage: key, message: text });
  }

  failStage(key: string, message: string): ProgressStage {
    const stage = this.stage(key);
    const text = clip(message);
    stage.status = 'failed';
    stage.error = text;
    stage.finishedAt = iso(this.now);
    this.state.errors.push({ at: iso(this.now), stage: key, message: text });
    this.save({ type: 'stage-failed', stage: key, message: text });
    return stage;
  }

  /** Fail the stage that is currently running; used by a top-level CLI catch. */
  failActive(message: string): ProgressStage | null {
    const key = this.state.currentStage;
    if (!key) return null;
    return this.failStage(key, message);
  }
}

/* --------------------------------------------------------------- estimates */

export interface EtaEstimate {
  stage: string;
  label: string;
  seconds: number;
  completed: number;
  total: number;
}

/**
 * ETA for the active stage, only once there is measured progress to stand on:
 * at least two completed items, a known total, and at least ten seconds spent.
 */
export function estimateEta(state: ProgressState, now = Date.now()): EtaEstimate | null {
  const stage = state.stages.find((row) => row.status === 'running' && row.total !== null);
  if (!stage || stage.startedAt === null || stage.total === null) return null;
  if (stage.completed < 2 || stage.total <= stage.completed) return null;
  const elapsedMs = now - Date.parse(stage.startedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 10_000) return null;
  const perItem = elapsedMs / stage.completed;
  return {
    stage: stage.key,
    label: stage.label,
    seconds: (perItem * (stage.total - stage.completed)) / 1000,
    completed: stage.completed,
    total: stage.total,
  };
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatEta(seconds: number): string {
  return `~${formatDuration(seconds * 1000)}`;
}

/* ----------------------------------------------------------- rating counts */

export interface RatingCellProgress {
  completed: number;
  total: number;
  status: 'pending' | 'waiting' | 'done';
}

export interface RatingProgress {
  human: RatingCellProgress;
  ai: RatingCellProgress;
}

function countPassages(packetPath: string): number {
  if (!existsSync(packetPath)) return 0;
  const text = readFileSync(packetPath, 'utf8');
  return [...text.matchAll(/^## Passage [A-Z]+\s*$/gm)].length;
}

function countCells(path: string, expectedRows: number): { completed: number; total: number } {
  if (!existsSync(path)) return { completed: 0, total: expectedRows * 10 };
  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return { completed: 0, total: expectedRows * 10 };
  const header = lines[0]!.split(',').map((cell) => cell.trim());
  const criteria = Math.max(0, header.length - 1);
  const rows = expectedRows || Math.max(0, lines.length - 1);
  let completed = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    for (let i = 1; i < cells.length; i++) {
      if (cells[i]!.trim() !== '') completed++;
    }
  }
  return { completed, total: rows * criteria };
}

function ratingStatus(completed: number, total: number): RatingCellProgress['status'] {
  if (total <= 0) return 'pending';
  if (completed >= total) return 'done';
  return 'waiting';
}

/**
 * Count nonblank rating cells without looking at the answer key. The packet is
 * used only for its passage count; the sheets are never interpreted as values.
 */
export function countRatingCells(blindDir: string): RatingProgress {
  const passages = countPassages(join(blindDir, 'packet.md'));
  const human = countCells(join(blindDir, 'ratings.csv'), passages);
  const ai = countCells(join(blindDir, 'ai-ratings.csv'), passages);
  return {
    human: { ...human, status: ratingStatus(human.completed, human.total) },
    ai: { ...ai, status: ratingStatus(ai.completed, ai.total) },
  };
}

/* -------------------------------------------------------------- ollama ps */

export interface OllamaProcess {
  name: string;
  processor: string;
}

/**
 * Parse the PROCESSOR column of `ollama ps`. It describes CPU/GPU placement,
 * not GPU utilization: "100% GPU" means the model is wholly resident on the
 * GPU, not that the GPU is 100% busy.
 */
export function parseOllamaPs(output: string): OllamaProcess[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0]!.split(/\s{2,}/).map((cell) => cell.trim());
  const processorAt = header.findIndex((cell) => cell.toUpperCase() === 'PROCESSOR');
  const out: OllamaProcess[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(/\s{2,}/).map((cell) => cell.trim());
    let name = cells[0] ?? '';
    let processor = processorAt >= 0 ? (cells[processorAt] ?? '') : '';
    if (!processor) {
      const match = line.match(/(\d+%(?:\/\d+%)?\s+(?:CPU|GPU|CPU\/GPU))/i);
      if (match) processor = match[1]!;
      name = line.split(/\s+/)[0] ?? name;
    }
    if (!name) continue;
    out.push({ name, processor: processor || 'unknown' });
  }
  return out;
}
