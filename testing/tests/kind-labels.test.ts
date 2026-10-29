/**
 * Kind labels §6: the guard checks a concept, a citation and a linkage.
 * Invented names and wording only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { tempDb, mockProvider } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function decide(
  fromName: string,
  toName: string,
  kind: string,
  evidence: string,
  kindSource: string,
  chunkText = evidence,
): lorebook.PromoteDecision {
  return lorebook.provenRelation(
    { fromId: 1, toId: 2, fromName, toName, kind, evidence, kindSource },
    { chunkText },
  );
}

/* --------------------------------------------------------------- citation */

test('disliked is proven by "loathed" when the citation is supplied', () => {
  assert.deepEqual(decide('Mara', 'Tor', 'disliked', 'Mara loathed Tor in a quiet way.', 'loathed'), { ok: true });
});

test('disliked with no citation and no label word fails', () => {
  assert.deepEqual(decide('Mara', 'Tor', 'disliked', 'Mara loathed Tor in a quiet way.', ''), {
    ok: false,
    reason: 'tie-word-absent',
  });
});

test('a citation that is not in the quote proves nothing', () => {
  assert.deepEqual(decide('Mara', 'Tor', 'disliked', 'Mara loathed Tor in a quiet way.', 'hated'), {
    ok: false,
    reason: 'tie-word-absent',
  });
});

test('enemy of with a "loathed" citation is refused when the direction is reversed', () => {
  // §4: the guard cannot see that "loathed" is semantically a poor fit for
  // enemy. It can see that the sentence makes Tor the subject and Mara the
  // object, so from=Mara/to=Tor is the reverse of what is said.
  assert.deepEqual(decide('Mara', 'Tor', 'enemy of', 'Tor loathed Mara.', 'loathed'), {
    ok: false,
    reason: 'direction-mismatch',
  });
});

test('the guard does not judge semantic fitness in the forward direction', () => {
  // Documented consequence of §4: a forward "enemy of" proved by "loathed"
  // passes, because the citation is real and binds the pair.
  assert.deepEqual(decide('Mara', 'Tor', 'enemy of', 'Mara loathed Tor.', 'loathed'), { ok: true });
});

/* ------------------------------------------------------------ three names */

test('a three-character passage binds exactly one pair', () => {
  const quote = 'Mara loathed Tor, and Corin watched from the doorway.';
  const pairs = [
    ['Mara', 'Tor'],
    ['Mara', 'Corin'],
    ['Tor', 'Corin'],
  ] as const;
  const accepted = pairs.filter(([from, to]) => decide(from, to, 'disliked', quote, 'loathed').ok);
  assert.deepEqual(accepted, [['Mara', 'Tor']]);
});

/* --------------------------------------------------------------- direction */

test('a symmetric concept accepts either order and extraction stores one pair', async () => {
  assert.equal(decide('Mara', 'Tor', 'friend of', 'Mara was a friend of Tor.', 'friend').ok, true);
  assert.equal(decide('Tor', 'Mara', 'friend of', 'Mara was a friend of Tor.', 'friend').ok, true);

  // Two emissions of the same symmetric tie, opposite orders, one row.
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
  const relation = { kind: 'friend of', kind_source: 'friend', evidence: 'Mara was a friend of Tor.', chunk_index: 0 };
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

test('a directional concept refuses the reverse', () => {
  assert.deepEqual(decide('Asha', 'Bram', 'sister of', "Asha is Bram's sister.", 'sister'), { ok: true });
  assert.deepEqual(decide('Bram', 'Asha', 'sister of', "Asha is Bram's sister.", 'sister'), {
    ok: false,
    reason: 'direction-mismatch',
  });
});

/* ------------------------------------------------------ denial / uncertainty */

test('negation is refused, never stored as the positive concept', () => {
  assert.deepEqual(decide('Mara', 'Tor', 'trusted', 'Mara did not trust Tor.', 'trust'), {
    ok: false,
    reason: 'assertion-missing',
  });
  assert.deepEqual(decide('Mara', 'Tor', 'trusted', 'Mara never trusted Tor.', 'trusted'), {
    ok: false,
    reason: 'assertion-missing',
  });
});

test('uncertainty is not stored as asserted', () => {
  assert.deepEqual(decide('Mara', 'Tor', 'feared', 'Perhaps Mara feared Tor.', 'feared'), {
    ok: false,
    reason: 'assertion-missing',
  });
  assert.deepEqual(decide('Mara', 'Tor', 'feared', 'Mara perhaps feared Tor.', 'feared'), {
    ok: false,
    reason: 'assertion-missing',
  });
});

/* ------------------------------------------------------------ concept set */

test('a label outside the concept set is refused as open vocabulary', () => {
  assert.deepEqual(decide('Mara', 'Tor', 'bff of', 'Mara was Tor\'s bff.', 'bff'), {
    ok: false,
    reason: 'open-vocab',
  });
});
