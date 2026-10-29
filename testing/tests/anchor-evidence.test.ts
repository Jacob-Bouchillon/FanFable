/**
 * Anchor evidence: the quote may be context (a pronoun, a neighbouring name),
 * but the anchor sentence must carry the assertion itself. Invented names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

type Db = ReturnType<typeof tempDb>['db'];

function entity(db: Db, projectId: number, name: string): number {
  return Number(
    db.run(
      'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      projectId,
      'character',
      name,
      '[]',
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function setup(name: string, text: string) {
  const { db } = tempDb();
  const project = controller.createProject(db, name);
  const sourceId = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      project.id,
      `s-${Math.random().toString(36).slice(2)}.txt`,
      'source',
      'sha',
      AT,
    ).lastInsertRowid,
  );
  db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, text, locator) VALUES (?, ?, ?, ?, ?)',
    sourceId,
    project.id,
    0,
    text,
    'p. 1',
  );
  const mara = entity(db, project.id, 'Mara');
  const tor = entity(db, project.id, 'Tor');
  return { db, project, mara, tor };
}

const text = "Tor walked in with him. Mara was Tor's aunt, and had raised him.";

test('an anchor that asserts the tie carries it', () => {
  const { db, project, mara, tor } = setup('anchor-pass', text);
  const decision = lorebook.canPromote(
    {
      fromId: mara,
      toId: tor,
      fromName: 'Mara',
      toName: 'Tor',
      kind: 'aunt of',
      evidence: 'Tor walked in with him.',
      anchorEvidence: "Mara was Tor's aunt, and had raised him.",
    },
    { db, projectId: project.id, chunkText: text },
  );
  assert.equal(decision.ok, true);
  db.close();
});

test('an anchor that only names both people is still a valid citation', () => {
  const { db, project, mara, tor } = setup('anchor-citation', 'Tor walked in with him. Mara and Tor went to town.');
  const decision = lorebook.canPromote(
    {
      fromId: mara,
      toId: tor,
      fromName: 'Mara',
      toName: 'Tor',
      kind: 'aunt of',
      evidence: 'Tor walked in with him.',
      anchorEvidence: 'Mara and Tor went to town.',
    },
    { db, projectId: project.id, chunkText: 'Tor walked in with him. Mara and Tor went to town.' },
  );
  assert.equal(decision.ok, true, 'the anchor is checked for existence, not for asserting the tie');
  db.close();
});

test('an anchor that is not in the passage is refused', () => {
  const { db, project, mara, tor } = setup('anchor-unverbatim', text);
  const decision = lorebook.canPromote(
    {
      fromId: mara,
      toId: tor,
      fromName: 'Mara',
      toName: 'Tor',
      kind: 'aunt of',
      evidence: 'Tor walked in with him.',
      anchorEvidence: "Mara was Tor's mother, and had raised him.",
    },
    { db, projectId: project.id, chunkText: text },
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'quote-not-verbatim');
  db.close();
});
