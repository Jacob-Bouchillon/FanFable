import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_VERSION } from './schema.ts';
import { runMigrations } from './migrations.ts';

export type Row = Record<string, unknown>;

export class Db {
  readonly raw: DatabaseSync;
  readonly path: string;
  private depth = 0;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA foreign_keys = ON');
    runMigrations(this.raw);
    // Keep enum-ish columns tidy when the model invents its own wording.
    this.raw.exec(
      "UPDATE plot_thread SET status = 'open' WHERE status IS NULL OR status NOT IN ('open','resolved','dropped')",
    );
    this.raw.exec(
      "UPDATE outline SET status = 'draft' WHERE status IS NULL OR status NOT IN ('draft','approved','superseded')",
    );
    this.raw
      .prepare('INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)')
      .run('version', String(SCHEMA_VERSION));
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  stmt(sql: string): StatementSync {
    return this.raw.prepare(sql);
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.stmt(sql).all(...(params as never[])) as T[];
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.stmt(sql).get(...(params as never[])) as T | undefined;
  }

  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...(params as never[]));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  transaction<T>(fn: () => T): T {
    // Re-entrant: a nested call joins the transaction already in progress.
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.depth = 1;
    this.raw.exec('BEGIN');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        /* ignore rollback failure */
      }
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  close(): void {
    this.raw.close();
  }
}

/* ------------------------------------------------------------------ json io */

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ helpers */

export function nowIso(): string {
  return new Date().toISOString();
}

export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [value];
    }
  }
  return [value];
}

export function strList(value: unknown): string[] {
  return asArray(value)
    .map((v) => (typeof v === 'string' ? v.trim() : v ? JSON.stringify(v) : ''))
    .filter((v) => v.length > 0);
}
