/**
 * Entity capacity: park unproven names, funnel only quote-proven common nouns.
 * Invented names only; no model calls beyond the extraction mock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import * as controller from '../../fanfable/src/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function addEntity(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  name: string,
  opts: {
    kind?: string;
    aliases?: string[];
    role?: string;
    status?: string;
    mentions?: number;
    evidence?: string;
    chunk?: number;
    reviewStatus?: string;
  } = {},
): number {
  return db.run(
    `INSERT INTO canon_entity
       (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    projectId,
    opts.kind ?? 'character',
    name,
    JSON.stringify(opts.aliases ?? []),
    opts.role ?? '',
    opts.status ?? '',
    opts.mentions ?? 1,
    opts.evidence ?? '',
    JSON.stringify(opts.chunk ? [{ source: 'Probe', locator: 'p. 1', chunk: opts.chunk }] : []),
    opts.reviewStatus ?? 'accepted',
    AT,
    AT,
  ).lastInsertRowid;
}

function addChunk(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  text: string,
  seq = 1,
): number {
  const sourceId = db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    projectId,
    `/probe-${seq}`,
    'Probe',
    `sha-${seq}`,
    AT,
  ).lastInsertRowid;
  return db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId,
    projectId,
    seq,
    `p. ${seq}`,
    '',
    text,
    text.split(/\s+/).length,
  ).lastInsertRowid;
}

test('a no-tie single-mention lowercase noun parks', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'capacity-park');
  const id = addEntity(db, project.id, 'lantern');
  const result = lorebook.checkEntityCapacity(db, project.id, [id], { write: true });
  assert.deepEqual(
    { scanned: result.scanned, parked: result.parked, funneled: result.funneled, skipped: result.skipped, skippedReferenced: result.skippedReferenced },
    { scanned: 1, parked: 1, funneled: 0, skipped: 1, skippedReferenced: 0 },
  );
  assert.equal(db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', id)!.review_status, 'needs_review');
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = ?', project.id)!.n, 0);
  db.close();
});

test('proper names, roles and existing ties stay accepted', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'capacity-keep');
  const proper = addEntity(db, project.id, 'Mara Vell');
  const role = addEntity(db, project.id, 'lantern keeper', { role: 'keeper' });
  const tied = addEntity(db, project.id, 'wagon');
  const other = addEntity(db, project.id, 'Asha');
  db.run(
    "INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, created_at) VALUES (?, ?, ?, 'owns', ?)",
    project.id,
    other,
    tied,
    AT,
  );
  const result = lorebook.checkEntityCapacity(db, project.id, [proper, role, tied], { write: true });
  assert.equal(result.parked, 0);
  for (const id of [proper, role, tied]) {
    assert.equal(db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', id)!.review_status, 'accepted');
  }
  db.close();
});

test('a row used as a fact subject is spared', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'capacity-fact-ref');
  const id = addEntity(db, project.id, 'lantern');
  db.run(
    'INSERT INTO canon_fact (project_id, topic, statement, subject, subject_entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id,
    'lantern',
    'A fact about the lantern.',
    'lantern',
    id,
    AT,
  );
  const result = lorebook.checkEntityCapacity(db, project.id, [id], { write: true });
  assert.equal(result.parked, 0);
  assert.equal(result.skippedReferenced, 1);
  assert.equal(db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', id)!.review_status, 'accepted');
  db.close();
});

test('a row named in timeline participants is spared', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'capacity-timeline');
  const id = addEntity(db, project.id, 'lantern');
  db.run(
    'INSERT INTO canon_timeline (project_id, title, participants, location, created_at) VALUES (?, ?, ?, ?, ?)',
    project.id,
    'A crossing',
    JSON.stringify(['lantern']),
    '',
    AT,
  );
  const result = lorebook.checkEntityCapacity(db, project.id, [id], { write: true });
  assert.equal(result.parked, 0);
  assert.equal(result.skippedReferenced, 1);
  assert.equal(db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', id)!.review_status, 'accepted');
  db.close();
});

test('a timeline location containing the name as a phrase spares the row', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'capacity-timeline-location');
  const id = addEntity(db, project.id, 'signal deck');
  db.run(
    'INSERT INTO canon_timeline (project_id, title, participants, location, created_at) VALUES (?, ?, ?, ?, ?)',
    project.id,
    'A crossing',
    JSON.stringify([]),
    'Abandoned in the signal deck of the ship',
    AT,
  );
  const result = lorebook.checkEntityCapacity(db, project.id, [id], { write: true });
  assert.equal(result.parked, 0);
  assert.equal(result.skippedReferenced, 1);
  assert.equal(db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', id)!.review_status, 'accepted');
  db.close();
});

test('a timeline participant stored as a longer phrase spares the row', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'capacity-timeline-participant');
  const id = addEntity(db, project.id, 'signal deck');
  db.run(
    'INSERT INTO canon_timeline (project_id, title, participants, location, created_at) VALUES (?, ?, ?, ?, ?)',
    project.id,
    'A crossing',
    JSON.stringify(['Asha', 'the signal deck']),
    '',
    AT,
  );
  const result = lorebook.checkEntityCapacity(db, project.id, [id], { write: true });
  assert.equal(result.parked, 0);
  assert.equal(result.skippedReferenced, 1);
  assert.equal(db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', id)!.review_status, 'accepted');
  db.close();
});

test('an unrelated timeline location does not spare the row', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'capacity-timeline-unrelated');
  const id = addEntity(db, project.id, 'lantern');
  db.run(
    'INSERT INTO canon_timeline (project_id, title, participants, location, created_at) VALUES (?, ?, ?, ?, ?)',
    project.id,
    'A crossing',
    JSON.stringify(['Asha']),
    'the signal deck',
    AT,
  );
  const result = lorebook.checkEntityCapacity(db, project.id, [id], { write: true });
  assert.equal(result.parked, 1);
  assert.equal(result.skippedReferenced, 0);
  assert.equal(db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', id)!.review_status, 'needs_review');
  db.close();
});

test('malformed participants JSON falls back to phrase matching over the text', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'capacity-timeline-malformed');
  const id = addEntity(db, project.id, 'lantern');
  db.run(
    'INSERT INTO canon_timeline (project_id, title, participants, location, created_at) VALUES (?, ?, ?, ?, ?)',
    project.id,
    'A crossing',
    'Asha carried the lantern, unquoted',
    '',
    AT,
  );
  const result = lorebook.checkEntityCapacity(db, project.id, [id], { write: true });
  assert.equal(result.parked, 0);
  assert.equal(result.skippedReferenced, 1);
  assert.equal(db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', id)!.review_status, 'accepted');
  db.close();
});

test('species, faction and rule rows are always spared', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'capacity-taxonomy');
  const ids = [
    addEntity(db, project.id, 'indigenes', { kind: 'species' }),
    addEntity(db, project.id, 'guild', { kind: 'faction' }),
    addEntity(db, project.id, 'law', { kind: 'rule' }),
  ];
  const result = lorebook.checkEntityCapacity(db, project.id, ids, { write: true });
  assert.equal(result.scanned, 3);
  assert.equal(result.parked, 0);
  assert.equal(result.skippedReferenced, 3);
  for (const id of ids) {
    assert.equal(db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', id)!.review_status, 'accepted');
  }
  db.close();
});

test('a row referenced by a tie note is spared', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'capacity-tie-note');
  const id = addEntity(db, project.id, 'lantern');
  const other = addEntity(db, project.id, 'Asha');
  db.run(
    `INSERT INTO canon_tie_note
       (project_id, from_entity, to_entity, attempted_kind, reason, evidence, source_refs, status, created_at)
     VALUES (?, ?, ?, 'owns', 'open-vocab', 'quote', '[]', 'pending', ?)`,
    project.id,
    other,
    id,
    AT,
  );
  const result = lorebook.checkEntityCapacity(db, project.id, [id], { write: true });
  assert.equal(result.parked, 0);
  assert.equal(result.skippedReferenced, 1);
  assert.equal(db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', id)!.review_status, 'accepted');
  db.close();
});

function funnelProject(quote: string) {
  const { db } = tempDb();
  const project = controller.createProject(db, 'capacity-funnel');
  const chunk = addChunk(db, project.id, quote);
  const asha = addEntity(db, project.id, 'Asha');
  const candidate = addEntity(db, project.id, 'lantern', { evidence: quote, chunk });
  return { db, project, chunk, asha, candidate };
}

test('a quote naming the noun and one other entity funnels one fact and parks', () => {
  const quote = 'Asha counted the lantern before dawn.';
  const { db, project, chunk, asha, candidate } = funnelProject(quote);
  const result = lorebook.checkEntityCapacity(db, project.id, [candidate], { write: true });
  assert.deepEqual(
    { scanned: result.scanned, parked: result.parked, funneled: result.funneled, skipped: result.skipped, skippedReferenced: result.skippedReferenced },
    { scanned: 1, parked: 1, funneled: 1, skipped: 0, skippedReferenced: 0 },
  );
  assert.equal(db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', candidate)!.review_status, 'needs_review');
  const fact = db.get<{
    topic: string; subject: string; subject_entity_id: number; statement: string; evidence: string; source_refs: string;
  }>('SELECT topic, subject, subject_entity_id, statement, evidence, source_refs FROM canon_fact WHERE project_id = ?', project.id)!;
  assert.equal(fact.topic, 'lantern');
  assert.equal(fact.subject, 'Asha');
  assert.equal(fact.subject_entity_id, asha);
  assert.equal(fact.statement, quote);
  assert.equal(fact.evidence, quote);
  assert.equal(JSON.parse(fact.source_refs)[0].chunk, chunk);
  db.close();
});

test('two named entities in the quote parks without a fact', () => {
  const quote = 'Asha met Corin beside the lantern.';
  const { db, project, candidate } = funnelProject(quote);
  addEntity(db, project.id, 'Corin');
  const result = lorebook.checkEntityCapacity(db, project.id, [candidate], { write: true });
  assert.equal(result.parked, 1);
  assert.equal(result.funneled, 0);
  assert.equal(result.skipped, 1);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = ?', project.id)!.n, 0);
  db.close();
});

test('a second capacity run changes nothing', () => {
  const quote = 'Asha counted the lantern before dawn.';
  const { db, project, candidate } = funnelProject(quote);
  lorebook.checkEntityCapacity(db, project.id, [candidate], { write: true });
  const beforeFact = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = ?', project.id)!.n;
  const second = lorebook.checkEntityCapacity(db, project.id, [candidate], { write: true });
  assert.equal(second.parked, 0);
  assert.equal(second.funneled, 0);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = ?', project.id)!.n, beforeFact);
  db.close();
});

test('dry run reports a funnel but writes neither the fact nor the status', () => {
  const quote = 'Asha counted the lantern before dawn.';
  const { db, project, candidate } = funnelProject(quote);
  const result = lorebook.checkEntityCapacity(db, project.id, [candidate], { write: false });
  assert.equal(result.parked, 1);
  assert.equal(result.funneled, 1);
  assert.equal(db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', candidate)!.review_status, 'accepted');
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = ?', project.id)!.n, 0);
  db.close();
});

test('unverified evidence and a parked subject skip the funnel', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'capacity-skip');
  const chunk = addChunk(db, project.id, 'Asha crossed the yard. Asha carried the crate.');
  const unverified = addEntity(db, project.id, 'basket', { evidence: 'basket quote absent', chunk });
  const asha = addEntity(db, project.id, 'Asha', { reviewStatus: 'needs_review' });
  const parkedSubject = addEntity(db, project.id, 'crate', { evidence: 'Asha carried the crate.', chunk });
  const result = lorebook.checkEntityCapacity(db, project.id, [unverified, parkedSubject], { write: true });
  assert.equal(result.parked, 2);
  assert.equal(result.funneled, 0);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = ?', project.id)!.n, 0);
  db.close();
});

test('extraction parks a junk entity at the end of the run', async () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'capacity-extract');
  const text = 'the bats crossed the yard.';
  addChunk(db, project.id, text);
  const entity = {
    kind: 'creature', name: 'bats', aliases: [], summary: '', attributes: {},
    role: '', status: '', chunk_index: 0, evidence: text,
  };
  const llm = mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"entities"')) return JSON.stringify({ entities: [entity], facts: [] });
    return JSON.stringify({ timeline: [] });
  });
  await lorebook.extractLore(db, llm as never, project.id, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
  } as never);
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE project_id = ? AND name = ?', project.id, 'bats')!.review_status,
    'needs_review',
  );
  db.close();
});

test('lore capacity dry-run reports without writing; the real run parks', () => {
  const { db, path } = tempDb();
  const project = controller.createProject(db, 'capacity-cli');
  const id = addEntity(db, project.id, 'lantern');
  const cli = resolve(import.meta.dirname, '../../fanfable/src/cli.ts');
  const run = (...extra: string[]) =>
    execFileSync(process.execPath, ['--no-warnings', cli, '--db', path, '--project', project.name, 'lore', 'capacity', ...extra], {
      cwd: resolve(import.meta.dirname, '../..'),
      encoding: 'utf8',
    });

  const dry = run('--dry-run', '--limit', '1');
  assert.match(dry, /scanned 1, parked 1, funneled 0, skipped 1, skippedReferenced 0/);
  assert.equal(db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', id)!.review_status, 'accepted');

  const real = run('--limit', '1');
  assert.match(real, /scanned 1, parked 1, funneled 0, skipped 1, skippedReferenced 0/);
  assert.equal(db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', id)!.review_status, 'needs_review');

  const second = run('--limit', '1');
  assert.match(second, /scanned 1, parked 0, funneled 0, skipped 0, skippedReferenced 0/);
  db.close();
});
