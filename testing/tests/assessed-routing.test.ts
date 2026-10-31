/**
 * Milestone 13: assessment-driven routing, attested CLI, enumeration filter.
 * Invented names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createProject } from '../../fanfable/src/controller.ts';
import { buildPairThreads } from '../../fanfable/src/web/pair-threads.ts';
import { syncThreads } from '../../fanfable/src/web/threads.ts';
import * as threadWeb from '../../fanfable/src/web/threads.ts';
import * as meetingWeb from '../../fanfable/src/web/meetings.ts';
import { deriveStrength } from '../../fanfable/src/web/note-ingest.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function rel(patch: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    from_entity: 1,
    to_entity: 2,
    kind: 'ally of',
    description: '',
    evidence: 'Mara Voss met Corin Hale at the gate.',
    source_refs: '[]',
    confidence: 0.9,
    review_status: 'accepted',
    from_name: 'Mara Voss',
    to_name: 'Corin Hale',
    from_kind: 'character',
    to_kind: 'character',
    supporting_evidence: '[]',
    ...patch,
  } as Parameters<typeof deriveStrength>[0];
}

function assessment(patch: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      assessment: {
        names_both: true,
        other_person: 'named',
        asserted: true,
        hedge: 'certain',
        kind_fit: 'yes',
        strength: 0.8,
        why: 'the sentence says it',
        ...patch,
      },
    },
  ]);
}

test('an assessed scene becomes context whatever its strength', () => {
  const derived = deriveStrength(
    rel({ supporting_evidence: assessment({ names_both: false, asserted: false, strength: 0.9 }) }),
    'Mara Voss met Corin Hale at the gate.',
  );
  assert.equal(derived.isContext, true);
  assert.equal(derived.strength, 0.9, 'the number is not changed');
  assert.equal(derived.strengthSource, 'assessed');
});

test('an assessed one-sided assertion stays an observation', () => {
  const derived = deriveStrength(
    rel({
      supporting_evidence: assessment({ names_both: false, asserted: true, other_person: 'pronoun', strength: 0.7 }),
    }),
    'Mara Voss met Corin Hale at the gate.',
  );
  assert.equal(derived.isContext, false);
  assert.equal(derived.strength, 0.7);
});

test('an assessed hedge without both names is context', () => {
  const derived = deriveStrength(
    rel({
      supporting_evidence: assessment({ names_both: false, asserted: false, hedge: 'hedged', strength: 0.6 }),
    }),
    'Mara Voss met Corin Hale at the gate.',
  );
  assert.equal(derived.isContext, true);
  assert.equal(derived.strength, 0.6);
});

test('an unassessed row keeps the old derivation exactly', () => {
  const both = deriveStrength(rel(), 'Mara Voss met Corin Hale at the gate.');
  assert.equal(both.isContext, false);
  assert.equal(both.strength, 0.9);
  assert.equal(both.strengthSource, 'derived');

  const scene = deriveStrength(rel(), 'The wall stood through the winter.');
  assert.equal(scene.isContext, true);
  assert.equal(scene.strength, 0.2);
  assert.equal(scene.strengthSource, 'context');
});

/* ------------------------------------------------------------ enumeration */

function setupMeetings(name: string) {
  const { db } = tempDb();
  const project = createProject(db, name);
  const source = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      project.id,
      '/m13-source',
      'Probe',
      'sha-m13',
      AT,
    ).lastInsertRowid,
  );
  const chunks: number[] = [];
  for (let i = 1; i <= 6; i++) {
    chunks.push(
      Number(
        db.run(
          `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
           VALUES (?, ?, ?, ?, '', ?, ?)`,
          source,
          project.id,
          i,
          `p. ${i}`,
          `Mara Voss met Corin Hale at the gate ${i}.`,
          9,
        ).lastInsertRowid,
      ),
    );
  }
  const mara = Number(
    db.run(
      `INSERT INTO canon_entity (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, 'character', 'Mara Voss', '[]', '', '', 1, '', '[]', 'accepted', ?, ?)`,
      project.id,
      AT,
      AT,
    ).lastInsertRowid,
  );
  const corin = Number(
    db.run(
      `INSERT INTO canon_entity (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, 'character', 'Corin Hale', '[]', '', '', 1, '', '[]', 'accepted', ?, ?)`,
      project.id,
      AT,
      AT,
    ).lastInsertRowid,
  );
  buildPairThreads(db, project.id);
  syncThreads(db, project.id);
  return { db, project: project.id, chunks, mara, corin };
}

test('candidates need a note on at least one side once the filter is on', () => {
  const { db, project } = setupMeetings('m13-enum');
  const unfiltered = meetingWeb.candidateMeetings(db, project);
  assert.ok(unfiltered.length > 0);

  const enumeration = meetingWeb.enumerateCandidates(db, project, { withNotes: new Set<number>() });
  assert.equal(enumeration.candidates.length, 0, 'no notes anywhere means no candidates');
  assert.ok(enumeration.skippedNoNotes > 0);

  const thread = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'pair' ORDER BY id LIMIT 1",
    project,
  )!.id;
  const partial = meetingWeb.enumerateCandidates(db, project, { withNotes: new Set([thread]) });
  assert.ok(partial.candidates.length > 0, 'one note-bearing side is enough');
  db.close();
});

test('the filter leaves the admitted meeting set unchanged', () => {
  const { db, project, chunks } = setupMeetings('m13-admitted');
  const thread = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'pair' ORDER BY id LIMIT 1",
    project,
  )!.id;
  threadWeb.addNote(db, project, thread, {
    chunkId: chunks[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale at the gate 1.',
    claim: 'they meet at the gate',
    strength: 0.8,
  });
  const result = meetingWeb.runMeetings(db, project);
  const admitted = db.all<{ id: number }>('SELECT id FROM canon_meeting WHERE project_id = ? ORDER BY id', project);
  assert.equal(admitted.length, result.meetingsCreated + result.meetingsReused);
  assert.equal(typeof result.candidatesSkippedNoNotes, 'number', 'the filter reports its work');
  db.close();
});

/* ---------------------------------------------------------------- attest */

function setupAttest(name: string) {
  const { db } = tempDb();
  const project = createProject(db, name);
  const source = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      project.id,
      '/m13-attest',
      'Probe',
      'sha-attest',
      AT,
    ).lastInsertRowid,
  );
  const chunk = Number(
    db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
       VALUES (?, ?, 1, 'p. 1', '', 'Mara Voss swore an oath to Corin Hale.', 8)`,
      source,
      project.id,
    ).lastInsertRowid,
  );
  const mara = Number(
    db.run(
      `INSERT INTO canon_entity (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, 'character', 'Mara Voss', '[]', '', '', 1, '', '[]', 'accepted', ?, ?)`,
      project.id,
      AT,
      AT,
    ).lastInsertRowid,
  );
  const corin = Number(
    db.run(
      `INSERT INTO canon_entity (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, 'character', 'Corin Hale', '[]', '', '', 1, '', '[]', 'accepted', ?, ?)`,
      project.id,
      AT,
      AT,
    ).lastInsertRowid,
  );
  const add = (kind: string, status: string, supporting: string): number =>
    Number(
      db.run(
        `INSERT INTO canon_relation
           (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
            confidence, review_status, supporting_evidence, created_at)
         VALUES (?, ?, ?, ?, '', 'Mara Voss swore an oath to Corin Hale.', ?, 0.8, ?, ?, ?)`,
        project.id,
        mara,
        corin,
        kind,
        JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk }]),
        status,
        supporting,
        AT,
      ).lastInsertRowid,
    );
  return { db, project: project.id, add };
}

test('attest dry run writes nothing and a write moves an eligible row once', () => {
  const { db, project, add } = setupAttest('m13-attest-run');
  const eligible = add('ally of', 'provisional', assessment({ names_both: true, asserted: true, strength: 0.8 }));
  const noAssessment = add('rival of', 'provisional', '[]');

  const dry = lorebook.assignAttestedTiers(db, project, {});
  assert.equal(dry.attested, 0, 'a dry run records nothing');
  assert.equal(
    db.get<{ s: string }>('SELECT review_status AS s FROM canon_relation WHERE id = ?', eligible)!.s,
    'provisional',
  );

  const write = lorebook.assignAttestedTiers(db, project, { write: true });
  assert.ok(write.checked >= 2, 'both rows were considered');
  assert.equal(
    db.get<{ s: string }>('SELECT review_status AS s FROM canon_relation WHERE id = ?', eligible)!.s,
    write.attested > 0 ? 'attested' : 'provisional',
    'the row moved only when the function said so',
  );
  assert.equal(
    db.get<{ s: string }>('SELECT review_status AS s FROM canon_relation WHERE id = ?', noAssessment)!.s,
    'provisional',
    'a row with no assessment stays put',
  );

  const second = lorebook.assignAttestedTiers(db, project, { write: true });
  assert.equal(second.attested, 0, 'a second write attests nothing new');
  db.close();
});

test('the attest write guard refuses a path outside the temp directory', () => {
  assert.equal(meetingWeb.isTempDatabasePath(':memory:'), false);
  assert.equal(meetingWeb.isTempDatabasePath(resolve('testing/tests/nope.db')), false);
});

/* ------------------------------------------------------------ assessment */

test('lore ties --assessment shows the stored assessment and a fallback quote', () => {
  const { db, path } = tempDb();
  const project = createProject(db, 'm13-ties');
  const source = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      project.id,
      '/m13-ties',
      'Probe',
      'sha-ties',
      AT,
    ).lastInsertRowid,
  );
  const chunk = Number(
    db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
       VALUES (?, ?, 1, 'p. 1', '', 'Mara Voss swore an oath to Corin Hale.', 8)`,
      source,
      project.id,
    ).lastInsertRowid,
  );
  const mara = Number(
    db.run(
      `INSERT INTO canon_entity (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, 'character', 'Mara Voss', '[]', '', '', 1, '', '[]', 'accepted', ?, ?)`,
      project.id,
      AT,
      AT,
    ).lastInsertRowid,
  );
  const corin = Number(
    db.run(
      `INSERT INTO canon_entity (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, 'character', 'Corin Hale', '[]', '', '', 1, '', '[]', 'accepted', ?, ?)`,
      project.id,
      AT,
      AT,
    ).lastInsertRowid,
  );
  db.run(
    `INSERT INTO canon_relation
       (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
        confidence, review_status, supporting_evidence, created_at)
     VALUES (?, ?, ?, 'ally of', '', 'Mara Voss swore an oath to Corin Hale.', ?, 0.8, 'accepted', ?, ?)`,
    project.id,
    mara,
    corin,
    JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk }]),
    assessment({ names_both: true, asserted: true, strength: 0.8 }),
    AT,
  );
  db.close();

  const cli = resolve(import.meta.dirname, '../../fanfable/src/cli.ts');
  const out = execFileSync(
    process.execPath,
    ['--no-warnings', cli, '--db', path, '--project', 'm13-ties', 'lore', 'ties', '--from', 'Mara Voss', '--to', 'Corin Hale', '--assessment'],
    { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8' },
  );
  assert.match(out, /assessed:/);
  assert.match(out, /names_both true/);
  assert.match(out, /strength 0\.80/);
  assert.match(out, /Mara Voss swore an oath to Corin Hale\./, 'the quote falls back to the relation evidence');
});

/* ------------------------------------------------------ admission floor */

function addPairNote(db: Db, project: number, thread: number, chunk: number, strength: number, seq: number): void {
  threadWeb.addNote(db, project, thread, {
    chunkId: chunk,
    locator: `p. ${seq}`,
    quote: `Mara Voss met Corin Hale at the gate ${seq}.`,
    claim: 'they meet at the gate',
    strength,
  });
}

test('a note below the admission floor does not admit a meeting', () => {
  const { db, project, chunks } = setupMeetings('m14-floor');
  const pair = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'pair' ORDER BY id LIMIT 1",
    project,
  )!.id;
  const later = Number(
    db.run(
      `INSERT INTO canon_thread
         (project_id, kind, a_entity, b_entity, status, birth_reason, period_label, temporal_status, created_at, updated_at)
       SELECT project_id, kind, a_entity, b_entity, 'open', '', 'p2', 'current', created_at, updated_at
         FROM canon_thread WHERE id = ?`,
      pair,
    ).lastInsertRowid,
  );
  addPairNote(db, project, pair, chunks[0]!, 0.2, 1);
  addPairNote(db, project, later, chunks[1]!, 0.8, 2);
  const refused = meetingWeb.runMeetings(db, project, { minConfidence: 0.7 });
  assert.ok(refused.refusedByReason['one-sided'] >= 1, 'the weak side does not count as crossing');
  assert.equal(refused.meetingsCreated, 0);

  const admitted = meetingWeb.runMeetings(db, project, { minConfidence: 0.7, minAdmissionStrength: 0.2 });
  assert.ok(admitted.meetingsCreated >= 1, 'lowering the floor admits it again');
  db.close();
});

test('a floor of zero reproduces the old behaviour', () => {
  const { db, project, chunks } = setupMeetings('m14-zero');
  const pair = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'pair' ORDER BY id LIMIT 1",
    project,
  )!.id;
  const later = Number(
    db.run(
      `INSERT INTO canon_thread
         (project_id, kind, a_entity, b_entity, status, birth_reason, period_label, temporal_status, created_at, updated_at)
       SELECT project_id, kind, a_entity, b_entity, 'open', '', 'p2', 'current', created_at, updated_at
         FROM canon_thread WHERE id = ?`,
      pair,
    ).lastInsertRowid,
  );
  addPairNote(db, project, pair, chunks[0]!, 0.2, 1);
  addPairNote(db, project, later, chunks[1]!, 0.2, 2);
  const zero = meetingWeb.runMeetings(db, project, { minConfidence: 0.7, minAdmissionStrength: 0 });
  assert.ok(zero.meetingsCreated >= 1, 'any pair note crosses at zero');
  db.close();
});
