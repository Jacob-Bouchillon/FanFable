/**
 * The veto call path: product -> bench-venv verifier, one batch per process.
 *
 * The model is not imported into the product. A child process loads the
 * pinned checkpoint (repo branch feature/relation-verifier @ ff4ae39), scores
 * the batch, and exits. CPU only: the CUDA path raises a device-side assert
 * (recorded in testing/trials/valve-bench/manifest.json).
 *
 * Removing this module, or setting `FANFABLE_VETO=off`, leaves the pipeline
 * with every mechanically-proved row kept: fewer rows are refused, none added.
 */
import { spawn } from 'node:child_process';
import type { VetoBatchScorer } from './veto-batch.ts';
import type { VetoInput } from './veto.ts';

export interface VetoBridgeOptions {
  /** Interpreter of the bench venv (has gliner2 + torch). */
  python: string;
  /** veto_runtime.py shipped beside this file. */
  script: string;
  /** Working directory for the child (bench venv root). */
  cwd?: string;
  timeoutMs?: number;
  threshold?: number;
  /** 'cuda' for the adopted lite runtime; 'cpu' only for the fallback. */
  device?: 'cpu' | 'cuda';
}

export function vetoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.FANFABLE_VETO ?? 'on').toLowerCase() !== 'off';
}

export function createPythonVetoScorer(opts: VetoBridgeOptions): VetoBatchScorer {
  return {
    async scoreBatch(inputs: VetoInput[]): Promise<(number | null)[]> {
      if (!inputs.length) return [];
      const payload = JSON.stringify(inputs.map((row) => ({
        fromName: row.fromName,
        toName: row.toName,
        kind: row.kind,
        sentence: row.sentence,
        chunkText: row.chunkText,
      })));
      const out = await run({ ...opts, payload });
      return inputs.map((_, i) => {
        const value = out[i]?.score;
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
      });
    },
  };
}

function run(opts: VetoBridgeOptions & { payload: string }): Promise<{ score?: number; error?: string }[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.python, [opts.script], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // The adopted runtime is GPU-only; the verifier fallback is CPU-only.
        ...(opts.device === 'cuda' ? {} : { CUDA_VISIBLE_DEVICES: '' }),
        FANFABLE_VETO_THRESHOLD: String(opts.threshold ?? 0.6),
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`veto bridge timed out after ${opts.timeoutMs ?? 600000}ms`));
    }, opts.timeoutMs ?? 600000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`veto runtime exited ${code}: ${stderr.slice(-400)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.slice(stdout.indexOf('['), stdout.lastIndexOf(']') + 1));
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch (err) {
        reject(new Error(`veto runtime returned no JSON: ${(err as Error).message}`));
      }
    });
    child.stdin.write(opts.payload);
    child.stdin.end();
  });
}
