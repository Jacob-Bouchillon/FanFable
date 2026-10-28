/**
 * Benchmark harness.
 *
 * The point of this file is that two models are compared under identical
 * conditions, or the comparison is worthless. So:
 *
 *   - one scenario definition, executed once per model, with the same inputs
 *   - the same source passages, the same lore index, the same approved outline
 *   - a fixed seed, so the same prompt gives the same result where the
 *     runtime honours it
 *   - every prompt, output, token count and duration recorded, so a reader can
 *     check that the two models really were given the same thing
 *
 * The context that a model writes *against* is assembled once, by the baseline
 * model, and reused for every candidate. Otherwise a slow model would look
 * worse simply because it spent longer building its own context, and a model
 * with a good context builder would look better for reasons that have nothing
 * to do with prose.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type ChatRequest, type ChatResponse, type LlmClient, type LlmSettings } from '../../../fanfable/src/llm.ts';

/**
 * True when this file is the one that was run.
 *
 * The comparison cannot be done with a plain string match: a path with a space
 * in it is percent-encoded in import.meta.url and not in process.argv[1].
 */
export function isMain(importMetaUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    return resolve(process.argv[1]) === resolve(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------- models */

export interface ModelSpec {
  key: string;
  label: string;
  provider: 'ollama' | 'llamacpp' | 'openai';
  model: string;
  seed?: number;
  contextTokens?: number;
  maxTokens?: number;
  temperature?: number;
  /** 'separate' sends a system message; 'merged' folds it into the first user turn. */
  system?: 'separate' | 'merged';
  /** Turn the model's thinking off. Needed for models that think out loud. */
  think?: boolean;
  notes?: string;
  /** Set when the model could not be evaluated here. */
  unavailable?: string;
}

export interface ModelRegistry {
  note?: string;
  models: ModelSpec[];
  unavailable?: ModelSpec[];
}

export function registryPath(): string {
  return resolve(import.meta.dirname, '../../../testing/benchmarks/fixtures/models.json');
}

export function loadModels(includeUnavailable = false): ModelSpec[] {
  const raw = JSON.parse(readFileSync(registryPath(), 'utf8')) as ModelRegistry;
  const all = [...raw.models, ...(includeUnavailable ? raw.unavailable ?? [] : [])];
  return all;
}

export function findModel(key: string): ModelSpec {
  const all = loadModels(true);
  const found = all.find((m) => m.key === key);
  if (!found) throw new Error(`unknown model "${key}"`);
  return found;
}

/* ------------------------------------------------------------------ clients */

/**
 * A client that records every call: the prompt, the output, the tokens and
 * the time. Wrapping the client rather than instrumenting each scenario means
 * no call can slip past the record.
 */
export class RecordingClient implements LlmClient {
  readonly settings: LlmSettings;
  readonly calls: CallRecord[] = [];
  private readonly inner: LlmClient;

  constructor(inner: LlmClient) {
    this.inner = inner;
    this.settings = inner.settings;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    try {
      const res = await this.inner.chat(req);
      this.calls.push({
        system: req.system ?? '',
        prompt: req.messages.map((m) => `${m.role}: ${m.content}`).join('\n\n'),
        output: res.text,
        durationMs: res.durationMs ?? Date.now() - started,
        promptTokens: res.usage?.promptTokens,
        completionTokens: res.usage?.completionTokens,
      });
      return res;
    } catch (err) {
      this.calls.push({
        system: req.system ?? '',
        prompt: req.messages.map((m) => `${m.role}: ${m.content}`).join('\n\n'),
        output: '',
        durationMs: Date.now() - started,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  async available(): Promise<boolean> {
    return this.inner.available();
  }

  get totalMs(): number {
    return this.calls.reduce((a, c) => a + c.durationMs, 0);
  }

  get promptTokens(): number {
    return this.calls.reduce((a, c) => a + (c.promptTokens ?? 0), 0);
  }

  get completionTokens(): number {
    return this.calls.reduce((a, c) => a + (c.completionTokens ?? 0), 0);
  }
}

export interface CallRecord {
  system: string;
  prompt: string;
  output: string;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
}

/**
 * For models whose chat template has no system role: the system prompt is
 * folded into the first user turn. The text the model reads is the same; only
 * the framing differs, which is the only way to run those models at all
 * without changing the shared prompts.
 */
export class MergedSystemClient implements LlmClient {
  readonly settings: LlmSettings;
  private readonly inner: LlmClient;

  constructor(inner: LlmClient) {
    this.inner = inner;
    this.settings = inner.settings;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!req.system) return this.inner.chat(req);
    const [first, ...rest] = req.messages;
    const merged = {
      ...first,
      content: `${req.system}\n\n${first.content}`,
    };
    return this.inner.chat({ ...req, system: undefined, messages: [merged, ...rest] });
  }

  async available(): Promise<boolean> {
    return this.inner.available();
  }
}

/** Build a client for a model spec, with the recording wrapper on top. */
export function makeClient(spec: ModelSpec, overrides: Partial<LlmSettings> = {}): RecordingClient {
  const base = createClient({
    provider: spec.provider,
    model: spec.model,
    seed: spec.seed,
    contextTokens: spec.contextTokens,
    maxTokens: spec.maxTokens,
    temperature: spec.temperature,
    think: spec.think,
    ...overrides,
  });
  const client = spec.system === 'merged' ? new MergedSystemClient(base) : base;
  return new RecordingClient(client);
}

/* --------------------------------------------------------------- run store */

export interface RunMeta {
  runId: string;
  startedAt: string;
  models: string[];
  roles: string[];
  corpus: string;
  notes?: string;
  /** Reproduction metadata captured for this run; older runs may not have it. */
  details?: Record<string, unknown>;
}

export interface ScenarioResult {
  role: string;
  scenario: string;
  model: string;
  modelLabel: string;
  seed: number;
  repetition: number;
  ok: boolean;
  error?: string;
  /** Measurements, in whatever units the scenario defines. */
  metrics: Record<string, number | string | boolean | null | string[]>;
  /** The artefact a human reads (a chapter, an outline). */
  artefact?: string;
  calls: CallRecord[];
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
}

export class RunStore {
  readonly dir: string;
  readonly meta: RunMeta;

  constructor(runId: string, meta: Omit<RunMeta, 'runId' | 'startedAt'>, baseDir = 'testing/benchmarks/runs') {
    this.dir = join(baseDir, runId);
    this.meta = { runId, startedAt: new Date().toISOString(), ...meta };
    // A run id names one experiment. Reusing it would mix two runs' outputs,
    // and would overwrite the first run's metadata without warning.
    mkdirSync(baseDir, { recursive: true });
    try {
      mkdirSync(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        // A progress monitor may create the run directory before the run
        // itself starts. Only those monitor files may already be there.
        const names = readdirSync(this.dir);
        const progressOnly =
          names.length > 0 &&
          names.every(
            (name) =>
              name === 'progress.json' ||
              name === 'progress.jsonl' ||
              (name.startsWith('progress.json.') && name.endsWith('.tmp')),
          );
        if (!progressOnly) {
          throw new Error(
            `run "${runId}" already exists at ${this.dir}; choose a new run id (existing runs are never overwritten)`,
          );
        }
      } else {
        throw err;
      }
    }
  }

  save(result: ScenarioResult): void {
    const file = join(
      this.dir,
      result.role,
      `${result.model}__seed${result.seed}__rep${result.repetition}.json`,
    );
    if (existsSync(file)) {
      throw new Error(`result for ${result.model} (${result.role}) already recorded in ${this.dir}`);
    }
    mkdirSync(join(this.dir, result.role), { recursive: true });
    writeFileSync(file, JSON.stringify(result, null, 2));
  }

  finish(): void {
    writeFileSync(join(this.dir, 'run.json'), JSON.stringify(this.meta, null, 2));
  }

  static load(runId: string, baseDir = 'testing/benchmarks/runs'): { meta: RunMeta; results: ScenarioResult[] } {
    const dir = join(baseDir, runId);
    const metaPath = join(dir, 'run.json');
    if (!existsSync(metaPath)) {
      throw new Error(`no run "${runId}" at ${dir} (missing run.json); pass an explicit run id`);
    }
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as RunMeta;
    const results: ScenarioResult[] = [];
    for (const role of listDirs(dir)) {
      for (const file of listFiles(join(dir, role))) {
        results.push(JSON.parse(readFileSync(join(dir, role, file), 'utf8')));
      }
    }
    return { meta, results };
  }
}

function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name);
}

/* ------------------------------------------------------------------ helpers */

/**
 * A run id that names one experiment: readable prefix, date and time, and a
 * short nonce so two runs started in the same second still differ.
 */
export function runId(prefix = 'run', at = new Date(), nonce?: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const ms = String(at.getMilliseconds()).padStart(3, '0');
  const suffix = nonce ?? randomBytes(2).toString('hex');
  return `${prefix}-${stamp}-${ms}-${suffix}`;
}

/** A run id whose directory does not exist yet, so a new run never reuses an old one. */
export function uniqueRunId(prefix = 'run', baseDir = 'testing/benchmarks/runs'): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = runId(prefix);
    if (!existsSync(join(baseDir, id))) return id;
  }
  throw new Error(`could not find an unused run id for prefix "${prefix}" in ${baseDir}`);
}

/** Use deterministic but distinct seeds for repetitions of the same model. */
export function repetitionSeed(baseSeed: number | undefined, repetition: number): number | undefined {
  if (!Number.isInteger(repetition) || repetition < 0) {
    throw new Error(`repetition must be a non-negative integer; got ${repetition}`);
  }
  return baseSeed === undefined ? undefined : baseSeed + repetition;
}

/** SHA-256 of a file, used to identify the exact benchmark inputs. */
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Mean of a numeric list; null when the list is empty. */
export function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Standard deviation, for the spread across repetitions. */
export function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values)!;
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Format a metric for a table cell. */
export function fmt(value: number | string | boolean | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value;
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

export function pct(value: number | null, digits = 0): string {
  if (value === null) return '-';
  return `${(value * 100).toFixed(digits)}%`;
}

/** Print a table with a header row. */
export function table(headers: string[], rows: string[][], indent = ''): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    indent + cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  console.log(line(headers));
  console.log(indent + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(row));
}
