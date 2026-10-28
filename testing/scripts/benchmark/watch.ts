/**
 * Live, local progress watcher.
 *
 *   npm run bench:watch -- <run-id>
 *
 * Reads testing/benchmarks/runs/<run-id>/progress.json and progress.jsonl, counts
 * nonblank cells in the two rating sheets, and samples `ollama ps` at a slower
 * cadence. It writes nothing and never reads the blind answer key.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { isMain } from './harness.ts';
import {
  countRatingCells,
  DEFAULT_PROGRESS_ROOT,
  estimateEta,
  formatDuration,
  formatEta,
  parseOllamaPs,
  progressPath,
  readProgress,
  type OllamaProcess,
  type ProgressStage,
  type ProgressState,
  type RatingProgress,
} from './progress.ts';

export interface OllamaSnapshot {
  processes: OllamaProcess[];
  error: string | null;
  sampledAt: number | null;
}

export class OllamaPsSampler {
  private lastAt = Number.NEGATIVE_INFINITY;
  private processes: OllamaProcess[] = [];
  private error: string | null = null;
  private sampledAt: number | null = null;

  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly run: () => string;

  constructor(
    intervalMs = 15_000,
    now: () => number = () => Date.now(),
    run: () => string = () => execFileSync('ollama', ['ps'], { encoding: 'utf8', timeout: 5_000 }),
  ) {
    this.intervalMs = intervalMs;
    this.now = now;
    this.run = run;
  }

  maybeSample(): OllamaSnapshot & { sampled: boolean } {
    const now = this.now();
    if (now - this.lastAt < this.intervalMs) {
      return { processes: this.processes, error: this.error, sampledAt: this.sampledAt, sampled: false };
    }
    this.lastAt = now;
    this.sampledAt = now;
    try {
      this.processes = parseOllamaPs(this.run());
      this.error = null;
    } catch (err) {
      this.processes = [];
      this.error = (err as Error).message.split(/\r?\n/)[0]!.slice(0, 160);
    }
    return { processes: this.processes, error: this.error, sampledAt: this.sampledAt, sampled: true };
  }
}

export interface WatchView {
  runId: string;
  state: ProgressState | null;
  statePath: string;
  error?: string;
  ratings?: RatingProgress;
  ollama?: OllamaSnapshot;
  now?: number;
}

function statusText(status: ProgressStage['status']): string {
  return status === 'done' ? 'done' : status;
}

function stageCounts(stage: ProgressStage, ratings?: RatingProgress): string {
  if (stage.key === 'ratings-human' && ratings) {
    return `${ratings.human.completed}/${ratings.human.total} cells`;
  }
  if (stage.key === 'ratings-ai' && ratings) {
    return `${ratings.ai.completed}/${ratings.ai.total} cells`;
  }
  if (stage.total !== null) return `${stage.completed}/${stage.total} ${stage.unit}`;
  return stage.completed ? `${stage.completed} ${stage.unit}` : '-';
}

function ratingStatus(stage: ProgressStage, ratings?: RatingProgress): ProgressStage['status'] {
  if (stage.key === 'ratings-human' && ratings) return ratings.human.status;
  if (stage.key === 'ratings-ai' && ratings) return ratings.ai.status;
  return stage.status;
}

function stageElapsed(stage: ProgressStage, now: number): string {
  if (!stage.startedAt) return '-';
  const end = stage.finishedAt ? Date.parse(stage.finishedAt) : now;
  return formatDuration(end - Date.parse(stage.startedAt));
}

export function renderWatch(view: WatchView): string {
  const now = view.now ?? Date.now();
  const out: string[] = [];
  const title = view.error ? 'progress unreadable' : 'paired extractor progress';
  out.push(`${title} — ${view.runId}`);

  if (!view.state) {
    out.push('');
    if (view.error) out.push(`Cannot read progress state: ${view.error}`);
    else out.push(`No progress state yet for "${view.runId}".`);
    out.push(`Looked for: ${view.statePath}`);
    out.push('Waiting for the experiment to start...');
    return out.join('\n');
  }

  const state = view.state;
  const age = Math.max(0, now - Date.parse(state.updatedAt));
  out.push(
    `updated ${new Date(state.updatedAt).toLocaleString()} (${formatDuration(age)} ago)   ` +
      `elapsed ${formatDuration(now - Date.parse(state.createdAt))}   status ${state.status}`,
  );
  out.push('');

  const labelWidth = Math.max(5, ...state.stages.map((stage) => stage.label.length));
  out.push(
    `${'stage'.padEnd(labelWidth)}  ${'status'.padEnd(8)}  ${'progress'.padEnd(18)}  ${'elapsed'.padStart(8)}`,
  );
  out.push(`${'-'.repeat(labelWidth)}  ${'-'.repeat(8)}  ${'-'.repeat(18)}  ${'-'.repeat(8)}`);
  for (const stage of state.stages) {
    const status = ratingStatus(stage, view.ratings);
    out.push(
      `${stage.label.padEnd(labelWidth)}  ${statusText(status).padEnd(8)}  ` +
        `${stageCounts(stage, view.ratings).padEnd(18)}  ${stageElapsed(stage, now).padStart(8)}`,
    );
  }

  const eta = estimateEta(state, now);
  out.push('');
  if (eta) {
    out.push(`ETA (approx.): ${formatEta(eta.seconds)} — ${eta.label}, ${eta.total - eta.completed} left`);
  } else if (state.status === 'waiting') {
    out.push('ETA: not estimated while waiting for ratings.');
  } else if (state.status === 'failed') {
    out.push('ETA: unavailable while a stage has failed.');
  } else if (state.status === 'done') {
    out.push('ETA: run complete.');
  } else {
    out.push('ETA (approx.): not enough measured progress yet.');
  }
  out.push(`Current stage: ${state.currentStage ?? '-'}`);

  if (state.errors.length) {
    out.push('Errors:');
    for (const error of state.errors.slice(-3)) out.push(`  ${error.stage}: ${error.message}`);
  } else {
    out.push('Errors: none');
  }

  if (view.ollama) {
    const { processes, error } = view.ollama;
    if (error) out.push(`ollama ps: unavailable (${error})`);
    else if (!processes.length) out.push('ollama ps: no models loaded');
    else {
      out.push(`ollama ps: ${processes.map((p) => `${p.name} ${p.processor}`).join(' | ')}`);
    }
    out.push('  (PROCESSOR is CPU/GPU placement, not GPU utilization.)');
  }

  return out.join('\n');
}

interface CliOptions {
  runId: string;
  runsDir: string;
  blindDir: string;
  intervalMs: number;
  ollamaEveryMs: number;
  once: boolean;
  noOllama: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    runId: '',
    runsDir: DEFAULT_PROGRESS_ROOT,
    blindDir: 'testing/benchmarks/blind',
    intervalMs: 2_000,
    ollamaEveryMs: 15_000,
    once: false,
    noOllama: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--runs-dir') opts.runsDir = argv[++i] ?? opts.runsDir;
    else if (arg === '--blind-dir') opts.blindDir = argv[++i] ?? opts.blindDir;
    else if (arg === '--interval') opts.intervalMs = Number(argv[++i]);
    else if (arg === '--ollama-every') opts.ollamaEveryMs = Number(argv[++i]);
    else if (arg === '--once') opts.once = true;
    else if (arg === '--no-ollama') opts.noOllama = true;
    else if (!arg.startsWith('--') && !opts.runId) opts.runId = arg;
  }
  return opts;
}

export function watchSnapshot(opts: CliOptions, sampler?: OllamaPsSampler): WatchView {
  let state: ProgressState | null = null;
  let error: string | undefined;
  try {
    state = readProgress(opts.runId, opts.runsDir);
  } catch (err) {
    error = (err as Error).message;
  }
  const view: WatchView = {
    runId: opts.runId,
    state,
    statePath: progressPath(opts.runId, opts.runsDir),
    ...(error ? { error } : {}),
  };
  if (state) {
    try {
      view.ratings = countRatingCells(join(opts.blindDir, opts.runId));
    } catch {
      // A missing or half-written sheet simply shows as no progress.
    }
  }
  if (!opts.noOllama && sampler) view.ollama = sampler.maybeSample();
  return view;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.runId) {
    console.log('usage: npm run bench:watch -- <run-id> [--runs-dir <dir>] [--blind-dir <dir>] [--once] [--no-ollama]');
    return;
  }
  const sampler = new OllamaPsSampler(opts.ollamaEveryMs);
  const tick = (): WatchView => {
    const view = watchSnapshot(opts, sampler);
    if (!opts.once && process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
    console.log(renderWatch(view));
    if (!opts.once) console.log('\nCtrl-C to stop watching. This command writes nothing.');
    return view;
  };

  if (opts.once) {
    const view = tick();
    if (!view.state) process.exitCode = 1;
    return;
  }

  tick();
  const timer = setInterval(tick, opts.intervalMs);
  process.on('SIGINT', () => {
    clearInterval(timer);
    process.exit(0);
  });
}

if (isMain(import.meta.url)) main();
