/**
 * Liberal discovery is opt-in, and arm C's name list is the cleaned roster.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

const EMPTY_DIAGNOSTICS: lorebook.NameRosterDiagnostics = {
  sentenceInitialCandidates: 0,
  accepted: 0,
  rejected: 0,
  topRejected: [],
  quotedStarts: 0,
  rejectedInvalid: 0,
  rejectedContraction: 0,
  rejectedFunctionWord: 0,
  rejectedTitleOnly: 0,
  rejectedCommonWord: 0,
  rejectedStoplist: 0,
  rejectedNoMidSentence: 0,
};

test('liberal discovery is off by default and byte-identical when off', () => {
  const before = process.env.FANFABLE_REL_LIBERAL;
  try {
    delete process.env.FANFABLE_REL_LIBERAL;
    assert.equal(lorebook.relationsSystemPrompt(), lorebook.EXTRACT_RELATIONS_SYSTEM);

    process.env.FANFABLE_REL_LIBERAL = '1';
    const prompted = lorebook.relationsSystemPrompt();
    assert.ok(prompted.startsWith(lorebook.EXTRACT_RELATIONS_SYSTEM));
    assert.ok(prompted.includes('Liberal discovery mode'));
    assert.ok(prompted.includes('Use your own short wording'));
    assert.ok(prompted.includes('Direction still matters'));
    assert.ok(prompted.includes('Never use outside knowledge.'));
    assert.ok(prompted.includes('need not name both endpoints'));
  } finally {
    if (before === undefined) delete process.env.FANFABLE_REL_LIBERAL;
    else process.env.FANFABLE_REL_LIBERAL = before;
  }
});

test('the roster-only window list excludes bank names the roster never harvested', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'roster-only-list');
  db.run(
    `INSERT INTO canon_entity
       (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
     VALUES (?, 'character', 'Banked', '[]', '', '', 1, '', '[]', 'accepted', ?, ?)`,
    project.id,
    AT,
    AT,
  );
  const sourceId = db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    project.id,
    '/probe',
    'Probe',
    'sha',
    AT,
  ).lastInsertRowid;
  const chunkId = db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId,
    project.id,
    1,
    'p. 1',
    '',
    'Banked met Rostered at the gate.',
    7,
  ).lastInsertRowid;
  const window = db.all<lorebook.ChunkRow>(
    `SELECT c.id, c.seq, c.heading, c.locator, c.text, s.title AS source_title, s.path, c.source_id
       FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id WHERE c.id = ?`,
    chunkId,
  );
  const roster: lorebook.NameRoster = {
    entries: [{
      surface: 'Rostered',
      surfaces: ['Rostered'],
      tokens: ['rostered'],
      count: 1,
      trustedSource: 'mid-sentence',
    }],
    diagnostics: EMPTY_DIAGNOSTICS,
  };
  assert.deepEqual(lorebook.windowRosterNames(window, roster), ['Rostered']);
  const union = lorebook.windowEntityNames(db, project.id, window, roster);
  assert.ok(union.includes('Banked'));
  assert.ok(union.includes('Rostered'));
  db.close();
});
