/**
 * Read-only trace inspector.
 *
 * This deliberately does not use Db: Db creates directories, sets WAL mode,
 * runs migrations, normalises rows and writes schema_meta. The CLI must be able
 * to inspect a trace without changing the database, even when migrations are
 * pending.
 *
 * A closed (non-WAL) database is opened through SQLite's immutable read-only
 * URI, so SQLite cannot create -shm or -wal sidecars. If a WAL sidecar is
 * present, the main file and WAL are copied to a private temp snapshot and the
 * snapshot is opened read-only; SQLite may create sidecars on the copy, never
 * on the original.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { TraceReadDb } from './trace.ts';

export type TraceReadMode = 'immutable' | 'wal-snapshot';

export interface TraceReadConnection extends TraceReadDb {
  readonly mode: TraceReadMode;
  readonly path: string;
  close(): void;
}

const REQUIRED_COLUMNS: Record<'trace' | 'trace_event', string[]> = {
  trace: [
    'id',
    'project_id',
    'started_at',
    'finished_at',
    'completeness',
    'sampled_rate',
    'dropped_events',
    'metadata',
    'created_at',
  ],
  trace_event: [
    'id',
    'trace_id',
    'span_id',
    'parent_span_id',
    'project_id',
    'stage',
    'event',
    'event_class',
    'subject',
    'decision',
    'reason_code',
    'refs',
    'model',
    'prompt_hash',
    'duration_ms',
    'error',
    'committed',
    'created_at',
  ],
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateTraceSchema(raw: DatabaseSync, path: string): void {
  const present = new Set(
    raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('trace','trace_event')")
      .all()
      .map((row) => String((row as { name?: unknown }).name ?? '')),
  );
  const missingTables = (['trace', 'trace_event'] as const).filter((table) => !present.has(table));
  if (missingTables.length) {
    throw new Error(
      `trace schema is missing ${missingTables.join(', ')} in "${path}". ` +
        'This read-only inspector does not migrate or write. Open the database once with a writable ' +
        'command that applies migration 30, then retry.',
    );
  }

  const missingColumns: string[] = [];
  for (const table of ['trace', 'trace_event'] as const) {
    const columns = new Set(
      raw
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => String((row as { name?: unknown }).name ?? '')),
    );
    for (const column of REQUIRED_COLUMNS[table]) {
      if (!columns.has(column)) missingColumns.push(`${table}.${column}`);
    }
  }
  if (missingColumns.length) {
    throw new Error(
      `unsupported trace schema in "${path}": missing ${missingColumns.join(', ')}. ` +
        'This read-only inspector does not migrate or write. Apply migration 30 with a writable ' +
        'command, then retry.',
    );
  }
}

class ReadOnlyTraceConnection implements TraceReadConnection {
  readonly mode: TraceReadMode;
  readonly path: string;
  private readonly raw: DatabaseSync;
  private readonly tempDir: string | null;
  private closed = false;

  constructor(raw: DatabaseSync, path: string, mode: TraceReadMode, tempDir: string | null) {
    this.raw = raw;
    this.path = path;
    this.mode = mode;
    this.tempDir = tempDir;
  }

  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.raw.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.raw.prepare(sql).all(...(params as never[])) as T[];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.raw.close();
    } finally {
      if (this.tempDir) rmSync(this.tempDir, { recursive: true, force: true });
    }
  }
}

/**
 * Open an existing trace database without any writable Db initialization.
 *
 * Missing paths and directories are rejected; this function never creates a
 * database or a sidecar on the original database.
 */
export function openTraceReadConnection(path: string): TraceReadConnection {
  if (!existsSync(path)) {
    throw new Error(
      `database not found: "${path}". trace show/audit open read-only and never create a database.`,
    );
  }
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch (error) {
    throw new Error(`cannot access database "${path}": ${errorMessage(error)}`);
  }
  if (!isFile) {
    throw new Error(`not a database file: "${path}". trace show/audit require an existing file.`);
  }
  if (existsSync(`${path}-journal`)) {
    throw new Error(
      `database "${path}" has a rollback journal sidecar (-journal). ` +
        'Close the writer/checkpoint it before running a read-only trace inspection.',
    );
  }

  const walPath = `${path}-wal`;
  const hasWal = existsSync(walPath);
  let tempDir: string | null = null;
  let openPath = path;
  let mode: TraceReadMode = 'immutable';
  let raw: DatabaseSync | null = null;

  try {
    if (hasWal) {
      mode = 'wal-snapshot';
      tempDir = mkdtempSync(join(tmpdir(), 'fanfable-trace-ro-'));
      const snapshot = join(tempDir, 'trace.db');
      copyFileSync(path, snapshot);
      copyFileSync(walPath, `${snapshot}-wal`);
      openPath = snapshot;
    } else {
      // `immutable=1` prevents SQLite from creating -shm/-wal sidecars for a
      // read-only WAL-mode database. The file must be closed/checkpointed.
      openPath = `${pathToFileURL(path).href}?mode=ro&immutable=1`;
    }

    raw = new DatabaseSync(openPath, { readOnly: true });
    // A WAL that appeared after the initial check contains newer commits than
    // the immutable main file. Refuse to report a stale trace silently.
    if (mode === 'immutable' && existsSync(walPath)) {
      throw new Error(
        'the database acquired a WAL sidecar while opening; retry after the writer pauses or closes',
      );
    }
    raw.exec('PRAGMA query_only = ON');
    validateTraceSchema(raw, path);
    return new ReadOnlyTraceConnection(raw, path, mode, tempDir);
  } catch (error) {
    try {
      raw?.close();
    } catch {
      /* ignore close failure while reporting the open/schema error */
    }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`cannot inspect trace database "${path}": ${errorMessage(error)}`);
  }
}
