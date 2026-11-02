/**
 * Trace CLI read-only access.
 *
 * These tests hash the database and every SQLite sidecar byte-for-byte before
 * and after each command. They also exercise pending migrations, missing
 * schema, permission-only access, missing paths and invalid files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Db } from '../../fanfable/src/core/db.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import {
  finishTrace,
  recordTraceEvent,
  startTrace,
} from '../../fanfable/src/trace/trace.ts';
import { tempDb } from './helpers.ts';

const CLI = resolve(import.meta.dirname, '../../fanfable/src/cli.ts');

interface TraceFixture {
  db: Db;
  path: string;
  traceId: string;
  projectId: number;
}

function makeTraceDatabase(): TraceFixture {
  const { db, path } = tempDb();
  const project = controller.createProject(db, `trace-ro-${Math.random().toString(36).slice(2, 7)}`);
  const trace = startTrace(db, { projectId: project.id });
  recordTraceEvent(db, {
    traceId: trace.id,
    projectId: project.id,
    spanId: 'sp-readonly',
    stage: 'test',
    event: 'test.event',
    eventClass: 'diagnostic',
    decision: 'noop',
    reasonCode: 'test',
    committed: false,
  });
  finishTrace(db, trace.id);
  return { db, path, traceId: trace.id, projectId: project.id };
}

function hashes(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [label, suffix] of [
    ['main', ''],
    ['wal', '-wal'],
    ['shm', '-shm'],
    ['journal', '-journal'],
  ] as const) {
    const file = `${path}${suffix}`;
    if (existsSync(file)) {
      out[label] = createHash('sha256').update(readFileSync(file)).digest('hex');
    }
  }
  return out;
}

function runCli(path: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', CLI, '--db', path, ...args],
    { encoding: 'utf8' },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function readOnlyGet<T>(path: string, sql: string): T | undefined {
  const db = new DatabaseSync(`${pathToFileURL(path).href}?mode=ro&immutable=1`, { readOnly: true });
  try {
    return db.prepare(sql).get() as T | undefined;
  } finally {
    db.close();
  }
}

function readOnlyAll<T>(path: string, sql: string): T[] {
  const db = new DatabaseSync(`${pathToFileURL(path).href}?mode=ro&immutable=1`, { readOnly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

test('show and audit leave a closed database byte-identical and create no sidecars', () => {
  const fixture = makeTraceDatabase();
  fixture.db.close();
  const before = hashes(fixture.path);
  assert.deepEqual(Object.keys(before), ['main'], 'closed database has no sidecars');

  const show = runCli(fixture.path, ['trace', 'show', fixture.traceId, '--json']);
  assert.equal(show.status, 0, show.stderr);
  const shown = JSON.parse(show.stdout) as {
    trace: { completeness: string };
    events: { eventClass: string }[];
  };
  assert.equal(shown.trace.completeness, 'complete');
  assert.equal(shown.events.length, 1);
  assert.equal(shown.events[0]!.eventClass, 'diagnostic');
  assert.deepEqual(hashes(fixture.path), before, 'show changed the database or a sidecar');

  const audit = runCli(fixture.path, ['trace', 'audit', fixture.traceId, '--json']);
  assert.equal(audit.status, 0, audit.stderr);
  const audited = JSON.parse(audit.stdout) as {
    completeness: string;
    exhaustive: boolean;
    violations: unknown[];
  };
  assert.equal(audited.completeness, 'complete');
  assert.equal(audited.exhaustive, true);
  assert.deepEqual(audited.violations, []);
  assert.deepEqual(hashes(fixture.path), before, 'audit changed the database or a sidecar');
  assert.equal(existsSync(`${fixture.path}-wal`), false);
  assert.equal(existsSync(`${fixture.path}-shm`), false);
});

test('show and audit leave an active WAL database and both sidecars byte-identical', () => {
  const fixture = makeTraceDatabase();
  const before = hashes(fixture.path);
  assert.ok(before.main, 'main database exists');
  assert.ok(before.wal, 'WAL sidecar exists while the writer is open');
  assert.ok(before.shm, 'SHM sidecar exists while the writer is open');

  const show = runCli(fixture.path, ['trace', 'show', fixture.traceId, '--json']);
  assert.equal(show.status, 0, show.stderr);
  const shown = JSON.parse(show.stdout) as { events: unknown[] };
  assert.equal(shown.events.length, 1, 'the WAL snapshot must see the committed event');
  assert.deepEqual(hashes(fixture.path), before, 'show changed the main file or a WAL/SHM sidecar');

  const audit = runCli(fixture.path, ['trace', 'audit', fixture.traceId, '--json']);
  assert.equal(audit.status, 0, audit.stderr);
  assert.deepEqual(hashes(fixture.path), before, 'audit changed the main file or a WAL/SHM sidecar');
  fixture.db.close();
});

test('show and audit work on a compatible trace schema with pending migrations and do not migrate', () => {
  const fixture = makeTraceDatabase();
  fixture.db.raw.exec('PRAGMA user_version = 29');
  fixture.db.close();
  const before = hashes(fixture.path);
  assert.deepEqual(Object.keys(before), ['main']);

  const show = runCli(fixture.path, ['trace', 'show', fixture.traceId, '--json']);
  assert.equal(show.status, 0, show.stderr);
  assert.deepEqual(hashes(fixture.path), before);

  const audit = runCli(fixture.path, ['trace', 'audit', fixture.traceId, '--json']);
  assert.equal(audit.status, 0, audit.stderr);
  assert.deepEqual(hashes(fixture.path), before);

  const version = readOnlyGet<{ user_version: number }>(fixture.path, 'PRAGMA user_version');
  assert.equal(version?.user_version, 29, 'read-only inspection must not advance the schema version');
  const tables = readOnlyAll<{ name: string }>(
    fixture.path,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('trace','trace_event') ORDER BY name",
  ).map((row) => row.name);
  assert.deepEqual(tables, ['trace', 'trace_event']);
});

test('missing trace schema is a clear error, does not migrate and leaves the file unchanged', () => {
  const fixture = makeTraceDatabase();
  fixture.db.exec('DROP TABLE trace_event');
  fixture.db.exec('DROP TABLE trace');
  fixture.db.raw.exec('PRAGMA user_version = 29');
  fixture.db.close();
  const before = hashes(fixture.path);

  const result = runCli(fixture.path, ['trace', 'show', fixture.traceId, '--json']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /trace schema is missing/);
  assert.match(result.stderr, /does not migrate or write/);
  assert.deepEqual(hashes(fixture.path), before, 'missing-schema inspection wrote to the database');

  const version = readOnlyGet<{ user_version: number }>(fixture.path, 'PRAGMA user_version');
  assert.equal(version?.user_version, 29);
  const tables = readOnlyAll<{ name: string }>(
    fixture.path,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('trace','trace_event')",
  );
  assert.deepEqual(tables, [], 'the read-only inspector must not recreate trace tables');
});

test('show and audit work without write permission on the database directory', () => {
  const fixture = makeTraceDatabase();
  fixture.db.close();
  const directory = dirname(fixture.path);
  const before = hashes(fixture.path);
  chmodSync(fixture.path, 0o444);
  chmodSync(directory, 0o555);
  try {
    const show = runCli(fixture.path, ['trace', 'show', fixture.traceId, '--json']);
    assert.equal(show.status, 0, show.stderr);
    const audit = runCli(fixture.path, ['trace', 'audit', fixture.traceId, '--json']);
    assert.equal(audit.status, 0, audit.stderr);
    assert.deepEqual(hashes(fixture.path), before);
  } finally {
    chmodSync(directory, 0o755);
    chmodSync(fixture.path, 0o644);
  }
});

test('a missing database path is rejected without creating a file or sidecar', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fanfable-trace-missing-'));
  const path = join(directory, 'missing.db');
  try {
    const result = runCli(path, ['trace', 'show', 'tr-missing', '--json']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /database not found/);
    assert.match(result.stderr, /never create a database/);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(`${path}-wal`), false);
    assert.equal(existsSync(`${path}-shm`), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an invalid database fails cleanly without writing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fanfable-trace-invalid-'));
  const path = join(directory, 'broken.db');
  writeFileSync(path, 'this is not a sqlite database\n');
  const before = hashes(path);
  try {
    const result = runCli(path, ['trace', 'show', 'tr-broken', '--json']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot inspect trace database/);
    assert.match(result.stderr, /file is not a database|not a database/i);
    assert.deepEqual(hashes(path), before);
    assert.equal(existsSync(`${path}-wal`), false);
    assert.equal(existsSync(`${path}-shm`), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an unsupported trace schema fails cleanly without migrating', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fanfable-trace-unsupported-'));
  const path = join(directory, 'old-trace.db');
  const raw = new DatabaseSync(path);
  raw.exec('CREATE TABLE trace (id TEXT PRIMARY KEY)');
  raw.exec('CREATE TABLE trace_event (id INTEGER PRIMARY KEY)');
  raw.close();
  const before = hashes(path);
  try {
    const result = runCli(path, ['trace', 'audit', 'tr-old', '--json']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported trace schema/);
    assert.match(result.stderr, /missing/);
    assert.match(result.stderr, /does not migrate or write/);
    assert.deepEqual(hashes(path), before);
    assert.equal(existsSync(`${path}-wal`), false);
    assert.equal(existsSync(`${path}-shm`), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
