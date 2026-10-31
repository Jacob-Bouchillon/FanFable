/**
 * Kind labels under the claim-confidence rule: the concept set is for
 * labelling and querying, not a promotion gate. The model's citation and
 * confidence decide; only citation honesty remains.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { tempDb, mockProvider } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function decide(
  fromName: string,
  toName: string,
  kind: string,
  evidence: string,
  kindSource = '',
  confidence = 1,
): lorebook.PromoteDecision {
  return lorebook.provenRelation(
    { fromId: 1, toId: 2, fromName, toName, kind, evidence, kindSource, confidence },
    { chunkText: evidence, minConfidence: 0.7 },
  );
}

test('a concept proved by other wording passes with its citation', () => {
  assert.deepEqual(decide('Mara', 'Tor', 'disliked', 'Mara loathed Tor in a quiet way.', 'loathed'), { ok: true });
});

test('a missing citation is no longer a promotion failure', () => {
  assert.deepEqual(decide('Mara', 'Tor', 'disliked', 'Mara loathed Tor in a quiet way.'), { ok: true });
});

test('direction is the model\'s, not a guard verdict', () => {
  assert.deepEqual(decide('Mara', 'Tor', 'enemy of', 'Tor loathed Mara.', 'loathed'), { ok: true });
  assert.deepEqual(decide('Bram', 'Asha', 'sister of', "Asha is Bram's sister.", 'sister'), { ok: true });
});

test('a three-character passage is not forced to one pair by the guard', () => {
  const quote = 'Mara loathed Tor, and Corin watched from the doorway.';
  for (const [from, to] of [['Mara', 'Tor'], ['Mara', 'Corin'], ['Tor', 'Corin']] as const) {
    assert.deepEqual(decide(from, to, 'disliked', quote, 'loathed'), { ok: true });
  }
});

test('a symmetric concept accepts either order and extraction stores one pair', async () => {
  assert.deepEqual(decide('Mara', 'Tor', 'friend of', 'Mara was a friend of Tor.', 'friend'), { ok: true });
  assert.deepEqual(decide('Tor', 'Mara', 'friend of', 'Mara was a friend of Tor.', 'friend'), { ok: true });

  const { db } = tempDb();
  const project = controller.createProject(db, 'kind-symmetric-store');
  const sourceId = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      project.id,
      'p.txt',
      'Probe',
      'sha-kind',
      AT,
    ).lastInsertRowid,
  );
  db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId,
    project.id,
    1,
    'p. 1',
    '',
    'Mara was a friend of Tor.',
    6,
  );
  for (const name of ['Mara', 'Tor']) {
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, 'character', ?, '[]', '', '', 2, '', '[]', 'accepted', ?, ?)`,
      project.id,
      name,
      AT,
      AT,
    );
  }
  const relation = {
    kind: 'friend of',
    kind_source: 'friend',
    evidence: 'Mara was a friend of Tor.',
    chunk_index: 0,
    strength: 0.9,
    asserted: true,
    names_both: true,
    other_person: 'named',
    hedge: 'certain', kind_fit: 'yes',
  };
  const llm = mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      return JSON.stringify({
        relations: [
          { ...relation, from: 'Mara', to: 'Tor', description: '' },
          { ...relation, from: 'Tor', to: 'Mara', description: '' },
        ],
      });
    }
    return JSON.stringify({ entities: [], facts: [], timeline: [], relations: [] });
  });
  await lorebook.extractLore(db, llm, project.id);
  const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project.id);
  assert.equal(count?.n, 1, 'the opposite-order emission merges instead of banking twice');
  db.close();
});

test('negation is refused, never stored as the positive concept', () => {
  assert.deepEqual(decide('Mara', 'Tor', 'trusted', 'Mara did not trust Tor.', 'trust', 0.9), {
    ok: false,
    reason: 'assertion-missing',
  });
  assert.deepEqual(decide('Mara', 'Tor', 'trusted', 'Mara never trusted Tor.', 'trusted', 0.9), {
    ok: false,
    reason: 'assertion-missing',
  });
});

test('uncertainty is not stored as asserted', () => {
  assert.deepEqual(decide('Mara', 'Tor', 'feared', 'Perhaps Mara feared Tor.', 'feared', 0.9), {
    ok: false,
    reason: 'assertion-missing',
  });
  assert.deepEqual(decide('Mara', 'Tor', 'feared', 'Mara perhaps feared Tor.', 'feared', 0.9), {
    ok: false,
    reason: 'assertion-missing',
  });
});

test('a label outside the concept set is not a promotion gate', () => {
  assert.deepEqual(decide('Mara', 'Tor', 'bff of', "Mara was Tor's bff.", 'bff', 0.9), { ok: true });
  assert.equal(lorebook.isClosedRoleKind('bff of'), false, 'the concept set still governs querying');
});
