/**
 * Unresolved-endpoint tie hints: additive storage, dedupe, diagnostics and CLI.
 * Invented names only; no model calls beyond the extraction mock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Db } from '../../fanfable/src/db.ts';
import { runMigrations, tableExists } from '../../fanfable/src/migrations.ts';
import * as controller from '../../fanfable/src/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import * as loreDiag from '../../fanfable/src/lore-diagnostics.ts';
import { mockProvider, tempDb } from './helpers.ts';

const REFS = [{ source: 'Probe', locator: 'p. 3', chunk: 7 }];

test('migrations bring a v12 bank to v15 with hints and provenance', () => {
  const { db, path } = tempDb();
  assert.equal((db.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 17);
  assert.ok(tableExists(db.raw, 'canon_tie_hint'), 'fresh bank has the hint table');
  const project = controller.createProject(db, 'hint-migrate');

  db.raw.exec('DROP TABLE canon_tie_hint');
  db.raw.exec('PRAGMA user_version = 12');
  assert.equal(runMigrations(db.raw), 17, 'v12 bank moves to 16');
  assert.ok(tableExists(db.raw, 'canon_tie_hint'), 'hint table is recreated');
  assert.equal(runMigrations(db.raw), 17, 'second run is a no-op');
  assert.ok(
    controller.listProjects(db).some((p) => p.id === project.id),
    'existing project rows survive',
  );
  db.close();

  const reopened = new Db(path);
  assert.equal((reopened.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 17);
  assert.ok(tableExists(reopened.raw, 'canon_tie_hint'));
  reopened.close();
});

test('captureTieHint stores a pending hint and keeps the longer quote', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'hint-capture');
  const short = 'Mara called him kin.';
  const long = 'Mara Vell called Tovan Rell her sister before the whole yard.';

  assert.equal(
    lorebook.captureTieHint(db, project.id, {
      fromName: 'Mara Vell',
      toName: 'Tovan Rell',
      kind: 'sister of',
      quote: short,
      refs: REFS,
    }),
    true,
  );
  const first = db.get<{ status: string; evidence: string; source_refs: string; note: string }>(
    'SELECT status, evidence, source_refs, note FROM canon_tie_hint WHERE project_id = ?',
    project.id,
  )!;
  assert.equal(first.status, 'pending');
  assert.equal(first.evidence, short);
  assert.equal(first.note, '');
  assert.deepEqual(JSON.parse(first.source_refs), REFS);

  assert.equal(
    lorebook.captureTieHint(db, project.id, {
      fromName: 'Mara Vell',
      toName: 'Tovan Rell',
      kind: 'sister of',
      quote: 'shorter',
      refs: REFS,
    }),
    false,
    'shorter duplicate is ignored',
  );
  assert.equal(
    lorebook.captureTieHint(db, project.id, {
      fromName: 'Mara Vell',
      toName: 'Tovan Rell',
      kind: 'sister of',
      quote: long,
      refs: [{ source: 'Probe', locator: 'p. 9', chunk: 9 }],
    }),
    true,
    'longer duplicate replaces the quote',
  );
  const updated = db.get<{ evidence: string; source_refs: string }>(
    'SELECT evidence, source_refs FROM canon_tie_hint WHERE project_id = ?',
    project.id,
  )!;
  assert.equal(updated.evidence, long);
  assert.equal(JSON.parse(updated.source_refs)[0].locator, 'p. 9');
  assert.equal(lorebook.countTieHints(db, project.id, 'pending'), 1);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', project.id)!.n, 0);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project.id)!.n, 0);
  db.close();
});

test('captureTieHint rejects self-pairs, stopwords, non-names and empty fields', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'hint-rules');
  const base = { fromName: 'Mara Vell', toName: 'Tovan Rell', kind: 'sister of', quote: 'quote', refs: REFS };
  const check = (patch: Partial<typeof base>) =>
    lorebook.captureTieHint(db, project.id, { ...base, ...patch });

  assert.equal(check({ toName: 'mara vell' }), false, 'self-pair');
  assert.equal(check({ fromName: 'the and of' }), false, 'stopword-only name');
  assert.equal(check({ fromName: 'one two three four five six seven' }), false, 'too many words');
  assert.equal(check({ fromName: '1234' }), false, 'no letter');
  assert.equal(check({ kind: '' }), false, 'empty kind');
  assert.equal(check({ quote: '   ' }), false, 'empty quote');
  assert.equal(check({ fromName: '' }), false, 'empty name');
  assert.equal(lorebook.countTieHints(db, project.id), 0);
  db.close();
});

test('the relation path stores a hint for an unknown endpoint and writes nothing else', async () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'hint-apply');
  const text = 'Asha called Tovan Rell her sister at the gate before noon.';
  const now = '2026-01-01T00:00:00.000Z';
  const sourceId = db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    project.id,
    '/probe-hint',
    'Probe',
    'sha-hint',
    now,
  ).lastInsertRowid;
  const chunkId = db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId,
    project.id,
    1,
    'p. 1',
    '',
    text,
    11,
  ).lastInsertRowid;
  const chunk = { id: chunkId, text, locator: 'p. 1' };
  const quote = text;
  const entity = {
    kind: 'character', name: 'Asha', aliases: [], summary: 'a witness', attributes: {},
    role: '', status: '', chunk_index: 0, evidence: quote,
  };
  const relation = {
    from: 'Asha', to: 'Tovan Rell', kind: 'sister of', description: 'x', chunk_index: 0, evidence: quote,
  };
  const llm = mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [relation] });
    if (system.includes('"entities"')) return JSON.stringify({ entities: [entity], facts: [] });
    return JSON.stringify({ timeline: [] });
  });
  const stats = await lorebook.extractLore(db, llm as never, project.id, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
  } as never);

  const hint = db.get<{
    from_name: string; to_name: string; kind: string; evidence: string; source_refs: string; status: string;
  }>('SELECT from_name, to_name, kind, evidence, source_refs, status FROM canon_tie_hint WHERE project_id = ?', project.id);
  assert.ok(hint, 'the unresolved relation is kept');
  assert.equal(hint!.from_name, 'Asha');
  assert.equal(hint!.to_name, 'Tovan Rell');
  assert.equal(hint!.kind, 'sister of');
  assert.equal(hint!.status, 'pending');
  assert.equal(hint!.evidence, quote);
  assert.equal(JSON.parse(hint!.source_refs)[0].chunk, chunk.id);
  assert.equal(stats.verification.unresolved, 1);
  assert.equal(stats.verification.hinted, 1);
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ? AND name = ?', project.id, 'Tovan Rell')!.n,
    0,
    'no entity is created',
  );
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project.id)!.n, 0);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = ?', project.id)!.n, 0);
  db.close();
});

test('diagnostics reports the pending hint count with no suggestions', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'hint-diagnose');
  lorebook.captureTieHint(db, project.id, {
    fromName: 'Mara Vell', toName: 'Tovan Rell', kind: 'sister of', quote: 'q1', refs: REFS,
  });
  lorebook.captureTieHint(db, project.id, {
    fromName: 'Elin Rook', toName: 'Sera Holt', kind: 'aunt of', quote: 'q2', refs: REFS,
  });
  const gap = loreDiag.diagnose(db, project.id).find((g) => g.kind === 'tie-hint');
  assert.ok(gap, 'hint count is reported');
  assert.equal(gap!.message, '2 unresolved-endpoint hints waiting');
  assert.equal(gap!.suggestion, '');
  db.close();
});

test('lore hints prints pending rows and exits cleanly on an empty table', () => {
  const { db, path } = tempDb();
  const project = controller.createProject(db, 'hint-cli');
  const cli = resolve(import.meta.dirname, '../../fanfable/src/cli.ts');
  const run = (...extra: string[]) =>
    execFileSync(process.execPath, ['--no-warnings', cli, '--db', path, '--project', project.name, 'lore', 'hints', ...extra], {
      cwd: resolve(import.meta.dirname, '../..'),
      encoding: 'utf8',
    });

  const empty = run();
  assert.match(empty, /\(none\)/);
  assert.match(empty, /0 pending/);

  lorebook.captureTieHint(db, project.id, {
    fromName: 'Mara Vell', toName: 'Tovan Rell', kind: 'sister of', quote: 'a quote', refs: REFS,
  });
  db.close();
  const listed = run('--limit', '5');
  assert.match(listed, /Mara Vell/);
  assert.match(listed, /Tovan Rell/);
  assert.match(listed, /sister of/);
  assert.match(listed, /p\. 3/);
  assert.match(listed, /1 pending/);
});
