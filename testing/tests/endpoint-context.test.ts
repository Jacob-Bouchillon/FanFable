/**
 * Endpoint-context regressions. Identity may bind through an explicit
 * introduction ("You remember Jobal?") and a pure description of that person;
 * it may not bind through a nearby name, a possessive whose antecedent is
 * someone else, an ambiguous alias, or a reversed arrow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { buildRosterIndex } from '../../fanfable/src/identity/names.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function decide(
  row: {
    fromName: string; toName: string; fromAliases?: string[]; toAliases?: string[];
    kind: string; evidence: string; anchorEvidence?: string;
  },
  chunkText: string,
  index?: ReturnType<typeof buildRosterIndex>,
) {
  return lorebook.provenRelation(
    { fromId: 1, toId: 2, confidence: 1, ...row },
    { chunkText, index, minConfidence: 0 },
  );
}

test('a definite description binds to the person introduced just before it', () => {
  const chunk =
    '“You remember Jobal? ” A tall woman with a triangular-shaped face and wide- spaced and compassionate eyes, ' +
    'she was allowing herself to age gracefully, though her long hair was still dark and\n\nluxuriant. ' +
    'Married to Ruwee by arrangement, she was every bit as serious as he was, and equally committed to the refugee movement.';
  assert.deepEqual(
    decide(
      { fromName: 'Ruwee', toName: 'Jobal', kind: 'married to', evidence: 'Married to Ruwee by arrangement' },
      chunk,
    ),
    { ok: true },
  );
});

test('without the introduction, the same definite description stays unnamed', () => {
  const chunk =
    'A tall woman with a triangular-shaped face and wide- spaced and compassionate eyes, she was allowing herself ' +
    'to age gracefully, though her long hair was still dark and luxuriant. ' +
    'Married to Ruwee by arrangement, she was every bit as serious as he was, and equally committed to the refugee movement.';
  assert.deepEqual(
    decide(
      { fromName: 'Ruwee', toName: 'Jobal', kind: 'married to', evidence: 'Married to Ruwee by arrangement' },
      chunk,
    ),
    { ok: false, reason: 'endpoint-unnamed' },
  );
});

test('a possessive introduction names a thing, not the person', () => {
  assert.deepEqual(
    decide(
      { fromName: 'Ruwee', toName: 'Jobal', kind: 'married to', evidence: 'She was married to Ruwee.' },
      "This is Jobal's house. She was married to Ruwee.",
    ),
    { ok: false, reason: 'endpoint-unnamed' },
  );
});

test('a named character in the next sentence is not a pronoun antecedent', () => {
  const chunk =
    'In the space of a standard year he had gone from leading two lives to managing almost half a dozen: ' +
    'apprentice to Plagueis; Master to Maul; distinguished Senator; ally of Supreme Chancellor Valorum; ' +
    'and leader of a growing cabal of conspirators that included Pestage, Doriana, Greejatus. ' +
    'And leading a double life of his own: Dooku.';
  assert.deepEqual(
    decide(
      {
        fromName: 'Master Dooku', toName: 'Sate Pestage', kind: 'ally of',
        evidence: 'and leader of a growing cabal of conspirators that included Pestage, Doriana, Greejatus',
      },
      chunk,
    ),
    { ok: false, reason: 'endpoint-unnamed' },
  );
});

test('a possessive whose antecedent is someone else does not bind the row endpoint', () => {
  const chunk =
    'Palpatine welcomed him at the door, while a contingent of cloaked and helmeted Republic guards took up ' +
    'positions in the corridor. The Supreme Chancellor’s round face looked drawn, and perspiration beaded his ' +
    'clean-shaven upper lip. Clinging to his arm like an adornment was Sei Taria, ostensibly his administrative ' +
    'aide but also his lover.';
  assert.deepEqual(
    decide(
      {
        fromName: 'Palpatine', toName: 'Sei Taria', kind: 'lover of',
        evidence: 'Clinging to his arm like an adornment was Sei Taria, ostensibly his administrative aide but also his lover.',
      },
      chunk,
    ),
    { ok: false, reason: 'endpoint-unnamed' },
  );
});

test('canPromoteRelation uses the introduced referent for the p4 marriage', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'endpoint-context-db');
  const sourceId = db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    project.id, '/probe', 'Probe', 'sha-endpoint-context', AT,
  ).lastInsertRowid;
  const chunkId = db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId, project.id, 1, 'p. 307', '',
    '“You remember Jobal? ” A tall woman with a triangular-shaped face, she was allowing herself to age gracefully, ' +
    'though her long hair was still dark and luxuriant. Married to Ruwee by arrangement, she was every bit as serious ' +
    'as he was, and equally committed to the refugee movement.',
    42,
  ).lastInsertRowid;
  const mk = (name: string) => db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id, 'character', name, JSON.stringify([]), AT, AT,
  ).lastInsertRowid;
  const ruwee = mk('Ruwee');
  const jobal = mk('Jobal');
  const relationId = Number(db.run(
    `INSERT INTO canon_relation
       (project_id, from_entity, to_entity, kind, evidence, source_refs, confidence, review_status, created_at)
     VALUES (?, ?, ?, 'married to', ?, ?, 0.9, 'provisional', ?)`,
    project.id, ruwee, jobal, 'Married to Ruwee by arrangement',
    JSON.stringify([{ chunk: chunkId }]), AT,
  ).lastInsertRowid);
  assert.deepEqual(lorebook.canPromoteRelation(db, project.id, relationId), { ok: true });
  const row = db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', relationId)!;
  assert.equal(row.review_status, 'provisional', 'the gate decides; it does not write the status');
  db.close();
});

test('an alias owned by two entities is not resolved to either one', () => {
  const index = buildRosterIndex(
    [
      { name: 'Darth Plagueis', aliases: ['Hego Damask', 'Magister Damask', 'Plagueis'] },
      { name: 'Magister Hego Damask', aliases: [] },
      { name: 'San Hill', aliases: ['San'] },
    ],
    'Hego Damask and Magister Hego Damask.',
  );
  assert.deepEqual(
    decide(
      {
        fromName: 'San Hill', toName: 'Darth Plagueis',
        fromAliases: ['San'], toAliases: ['Hego Damask', 'Magister Damask', 'Plagueis'],
        kind: 'aide of', evidence: "San would become Hego's right hand.",
      },
      "San would become Hego's right hand.",
      index,
    ),
    { ok: false, reason: 'endpoint-unnamed' },
  );
});

test('a reversed master/apprentice sentence is refused', () => {
  assert.deepEqual(
    decide(
      {
        fromName: 'Darth Maul', toName: 'Darth Sidious',
        fromAliases: ['Maul'], toAliases: ['Sidious'],
        kind: 'master of', evidence: "Sidious was Maul's master.",
      },
      "Sidious was Maul's master.",
    ),
    { ok: false, reason: 'direction-mismatch' },
  );
});

test('an explicit roster alias resolves the endpoint and proves the tie', () => {
  assert.deepEqual(
    decide(
      {
        fromName: 'Darth Plagueis', toName: 'San Hill',
        fromAliases: ['Hego Damask', 'Magister Damask', 'Plagueis'], toAliases: ['San'],
        kind: 'mentor of', evidence: "Magister Damask was San Hill's tutor.",
      },
      "Magister Damask was San Hill's tutor.",
    ),
    { ok: true },
  );
});

test('a pronoun-only dialogue is not attributed to a nearby name', () => {
  assert.deepEqual(
    decide(
      {
        fromName: 'Palpatine', toName: 'Darth Plagueis', toAliases: ['Plagueis'],
        kind: 'aide of', evidence: 'Only if I can report directly to you.',
      },
      'Only if I can report directly to you. Plagueis tried once more to see him in the Force.',
    ),
    { ok: false, reason: 'endpoint-unnamed' },
  );
});

test('a same-sentence co-mention does not supply the missing endpoint', () => {
  assert.deepEqual(
    decide(
      { fromName: 'Mara', toName: 'Jobal', kind: 'ally of', evidence: 'Mara trusted Tor.' },
      'Mara trusted Tor, and Jobal watched.',
    ),
    { ok: false, reason: 'endpoint-unnamed' },
  );
});

test('a shared surname does not resolve the missing parent', () => {
  assert.deepEqual(
    decide(
      {
        fromName: 'Cosinga Palpatine', toName: 'Palpatine', fromAliases: ['Cosinga'],
        kind: 'parent of', evidence: '"Cosinga!" his mother screamed.',
      },
      '"Cosinga!" his mother screamed. Palpatine pressed the palms of his hands to his head.',
    ),
    { ok: false, reason: 'endpoint-unnamed' },
  );
});
