import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.ts';
import { runMigrations, hasColumn, tableExists } from '../src/migrations.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a new database gets the whole schema', () => {
  const db = new Db(':memory:');
  const version = db.raw.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.ok(version.user_version >= 2, 'the schema is at the current version');
  for (const table of [
    'canon_entity',
    'canon_relation',
    'canon_fact',
    'canon_event',
    'canon_timeline',
    'canon_event_participant',
    'au_event_participant',
    'au_event_link',
    'secret',
    'motivation',
    'graph_write',
  ]) {
    assert.ok(tableExists(db.raw, table), `${table} exists`);
  }
  db.close();
});

test('the graph columns are there', () => {
  const db = new Db(':memory:');
  for (const [table, column] of [
    ['canon_entity', 'confidence'],
    ['canon_entity', 'review_status'],
    ['canon_relation', 'valid_from_event_id'],
    ['canon_fact', 'subject_entity_id'],
    ['character', 'canon_entity_id'],
    ['character_knowledge', 'fact_id'],
    ['character_knowledge', 'chapter_id'],
    ['relationship', 'closed'],
    ['motivation', 'chapter_id'],
    ['au_event', 'confidence'],
  ]) {
    assert.ok(hasColumn(db.raw, table, column), `${table}.${column} exists`);
  }
  db.close();
});

test('an old database is migrated forward without losing data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fanforge-migrate-'));
  const path = join(dir, 'old.db');

  // A database as it looked before the graph existed.
  const old = new Db(path);
  old.raw.exec('PRAGMA user_version = 1');
  old.run(
    `INSERT INTO project (id, name, created_at, updated_at) VALUES (1, 'old', '2024-01-01', '2024-01-01')`,
  );
  old.run(
    `INSERT INTO canon_entity (project_id, kind, name, aliases, summary, attributes, role, status, first_chunk, evidence, source_refs, mentions, created_at, updated_at)
     VALUES (1, 'character', 'Serena', '[]', 'a watcher', '{}', '', 'alive', NULL, '', '[]', 1, '2024', '2024')`,
  );
  old.close();

  const migrated = new Db(path);
  const version = migrated.raw.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.ok(version.user_version >= 2, 'the old database was moved forward');
  const names = migrated.all<{ name: string }>('SELECT name FROM canon_entity');
  assert.equal(names.length, 1, 'the data is still there');
  assert.equal(names[0].name, 'Serena');
  assert.ok(hasColumn(migrated.raw, 'canon_entity', 'confidence'), 'the new columns were added');
  migrated.close();
});

test('migrations are safe to run twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fanforge-migrate2-'));
  const path = join(dir, 'twice.db');
  const db = new Db(path);
  const first = (db.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  runMigrations(db.raw);
  const second = (db.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  assert.equal(second, first, 'the version does not move again');
  db.close();

  const reopened = new Db(path);
  const third = (reopened.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  assert.equal(third, first);
  reopened.close();
});
