/** The test-only no-guard switch is inert unless FANFABLE_NO_GUARD=1. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/plan/controller.ts';
import { enforceStatusTieGuard } from '../../fanfable/src/lore-ask.ts';
import { tempDb } from './helpers.ts';

const QUESTION = 'What is the status of Asha to Bram?';
const DRAFT = 'It is confirmed that Asha is Bram\'s sister.';
const passage = {
  chunkId: 1, sourceId: 1, sourceTitle: 'Probe', path: '/probe', locator: 'p. 1',
  heading: '', text: 'Asha waited by the gate.', score: 1,
};

test('the no-guard switch is inert by default and bypasses only when set', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'guard-bypass');
  const before = process.env.FANFABLE_NO_GUARD;
  try {
    delete process.env.FANFABLE_NO_GUARD;
    assert.match(enforceStatusTieGuard(db, project.id, QUESTION, DRAFT, [passage]), /Tie not established/);

    process.env.FANFABLE_NO_GUARD = '0';
    assert.match(enforceStatusTieGuard(db, project.id, QUESTION, DRAFT, [passage]), /Tie not established/);

    process.env.FANFABLE_NO_GUARD = '1';
    assert.equal(enforceStatusTieGuard(db, project.id, QUESTION, DRAFT, [passage]), DRAFT);
  } finally {
    if (before === undefined) delete process.env.FANFABLE_NO_GUARD;
    else process.env.FANFABLE_NO_GUARD = before;
  }
  db.close();
});
