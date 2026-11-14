/**
 * Shared plumbing for the command line: argument parsing, terminal colours,
 * the data path, and the lookups every command needs.
 *
 * The database is passed in rather than held as a module-level singleton. A
 * shared mutable handle was the reason the commands could not be moved out of
 * one file: every one of them reached for the same global. Taking it as a
 * parameter makes each command a plain function of its inputs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../core/db.ts';
import { configPath, saveGlobalConfig } from '../core/llm.ts';
import type { LlmSettings } from '../core/llm.ts';
import { clientFrom } from '../core/llm.ts';
import * as controller from '../plan/controller.ts';

/* ------------------------------------------------------------------- args */

export interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args.flags[name] = next;
        i++;
      } else {
        args.flags[name] = true;
      }
    } else if (token.startsWith('-') && token.length > 1) {
      const name = token.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        args.flags[name] = next;
        i++;
      } else {
        args.flags[name] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

/* ----------------------------------------------------------------- output */

export const C = {
  bold: (s: string) => `\u001b[1m${s}\u001b[0m`,
  dim: (s: string) => `\u001b[2m${s}\u001b[0m`,
  red: (s: string) => `\u001b[31m${s}\u001b[0m`,
  yellow: (s: string) => `\u001b[33m${s}\u001b[0m`,
  green: (s: string) => `\u001b[32m${s}\u001b[0m`,
  cyan: (s: string) => `\u001b[36m${s}\u001b[0m`,
};

export function heading(text: string): void {
  console.log(`\n${C.bold(text)}\n${C.dim('-'.repeat(Math.min(text.length, 70)))}`);
}

/* ------------------------------------------------------------------ paths */

export function defaultDbPath(): string {
  if (process.env.FANFABLE_DB) return process.env.FANFABLE_DB;
  const base =
    process.env.FANFABLE_DATA_DIR || join(homedir(), '.local', 'share', 'fanfable');
  return join(base, 'fanfable.db');
}

export function globalState(): Record<string, unknown> {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function setGlobalState(patch: Record<string, unknown>): void {
  // Every config write goes through saveGlobalConfig so permissions and merge
  // semantics stay in one place.
  saveGlobalConfig(patch as Partial<LlmSettings>);
}

/* ------------------------------------------------------------------ flags */

export function flagString(args: Args, name: string, fallback = ''): string {
  const v = args.flags[name];
  return typeof v === 'string' ? v : fallback;
}

export function flagNumber(args: Args, name: string, fallback: number): number {
  const v = args.flags[name];
  const n = typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** An optional numeric flag: absent (or unparsable) means "no budget". */
export function budgetFlag(args: Args, name: string): number | undefined {
  const n = flagNumber(args, name, NaN);
  return Number.isFinite(n) ? n : undefined;
}

/** Whole days since an ISO timestamp, for thread listings. */
export function ageLabel(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '?';
  return `${Math.max(0, Math.floor((Date.now() - at) / 86400000))}d`;
}

/* --------------------------------------------------------------- lookups */

export function requireProject(db: Db, args: Args): controller.Project {
  const name = (args.flags.project as string) ?? (globalState().lastProject as string);
  if (!name) {
    throw new Error(
      'No project selected. Use --project <name>, or run "fanfable project use <name>".',
    );
  }
  const project = controller.getProjectByName(db, name);
  if (!project) throw new Error(`no project named "${name}"`);
  return project;
}

/** A controller bound to the selected project, with any `--model` override. */
export function app(db: Db, args: Args): controller.App {
  const project = requireProject(db, args);
  // A --model flag wins everywhere, same as the extract command's override.
  // Without it the project (then global, then built-in) default applies.
  const m = flagString(args, 'model');
  const settings = m ? { ...(project.settings as object), model: m } : project.settings;
  return new controller.App(db, project.id, clientFrom(settings));
}

/* -------------------------------------------------------------- prompting */

export async function prompt(label: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(label);
  rl.close();
  return answer;
}
