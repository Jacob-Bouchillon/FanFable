/**
 * Keeper precision: the gate must not bank inverted, third-party or denied
 * ties, must accept a correctly directed inverse form, must not let a missing
 * model score through, and must use one verbatim definition.
 *
 * Invented names and prose only; no book text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { enforceStatusTieGuard } from '../../fanfable/src/answer/lore-ask.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function decide(
  row: {
    fromName: string; toName: string; kind: string; evidence: string;
    kindSource?: string; anchorEvidence?: string; confidence?: number;
  },
  minConfidence = 0,
) {
  return lorebook.provenRelation(
    { fromId: 1, toId: 2, ...row },
    { chunkText: row.anchorEvidence ? `${row.evidence} ${row.anchorEvidence}` : row.evidence, minConfidence },
  );
}

/* ---------------------------------------------------------------- B1 direction */

test('B1: "trained by" does not make the subject the master', () => {
  assert.deepEqual(
    decide({ fromName: 'Mara', toName: 'Tor', kind: 'master of', evidence: 'Mara was trained by Tor.', confidence: 1 }),
    { ok: false, reason: 'direction-mismatch' },
  );
});

test('B1: "Tor\'s student" does not make Mara Tor\'s master', () => {
  assert.deepEqual(
    decide({ fromName: 'Mara', toName: 'Tor', kind: 'master of', evidence: "Mara was Tor's student.", confidence: 1 }),
    { ok: false, reason: 'direction-mismatch' },
  );
});

test('B1: "Tor\'s employee" does not make Mara Tor\'s employer', () => {
  assert.deepEqual(
    decide({ fromName: 'Mara', toName: 'Tor', kind: 'employer of', evidence: "Mara was Tor's employee.", confidence: 1 }),
    { ok: false, reason: 'direction-mismatch' },
  );
});

test('B1: "born to" does not make the child the parent', () => {
  assert.deepEqual(
    decide({ fromName: 'Mara', toName: 'Tor', kind: 'parent of', evidence: 'Mara was born to Tor.', confidence: 1 }),
    { ok: false, reason: 'direction-mismatch' },
  );
});

test('B1: the correctly directed inverse form still banks', () => {
  assert.deepEqual(
    decide({ fromName: 'Mara', toName: 'Tor', kind: 'servant of', evidence: "Mara was Tor's student.", confidence: 1 }),
    { ok: true },
  );
});

/* ------------------------------------------------------------- B2 third party */

test('B2: a third party\'s friend named in the clause is not the tie', () => {
  assert.deepEqual(
    decide({
      fromName: 'Mara', toName: 'Tor', kind: 'friend of',
      evidence: 'Mara told Tor that her friend had arrived.', confidence: 1,
    }),
    { ok: false, reason: 'relationship-not-entailed' },
  );
});

test('B2: a third party\'s enemy is not the tie', () => {
  assert.deepEqual(
    decide({
      fromName: 'Mara', toName: 'Tor', kind: 'enemy of',
      evidence: 'Mara protected Tor from his enemy.', confidence: 1,
    }),
    { ok: false, reason: 'relationship-not-entailed' },
  );
});

test('B2: an endpoint\'s enemy that the other endpoint merely admired is not the tie', () => {
  assert.deepEqual(
    decide({
      fromName: 'Mara', toName: 'Tor', kind: 'enemy of',
      evidence: "Mara admired Tor's enemy.", confidence: 1,
    }),
    { ok: false, reason: 'relationship-not-entailed' },
  );
});

test('B2-strict: coordinated partners still bank', () => {
  assert.deepEqual(
    decide({ fromName: 'Mara', toName: 'Tor', kind: 'friend of', evidence: 'Mara and Tor are partners.', confidence: 1 }),
    { ok: true },
  );
});

test('B2-strict: a possessive partner still banks', () => {
  assert.deepEqual(
    decide({ fromName: 'Mara', toName: 'Tor', kind: 'friend of', evidence: "Mara is Tor's partner.", confidence: 1 }),
    { ok: true },
  );
});

test('B2-strict: a title on the claim’s own endpoint banks when no third person is present', () => {
  assert.deepEqual(
    decide({ fromName: 'Mara', toName: 'Tor', kind: 'aunt of', evidence: 'Aunt Mara took Tor to the market.', confidence: 1 }),
    { ok: true },
  );
});

test('B2-strict: a pronoun pair parks even with an anchor naming both', () => {
  // Recall cost accepted: the sentence itself must name both sides for a
  // symmetric verb, so an anchored pronoun pair no longer proves the tie.
  assert.deepEqual(
    decide(
      {
        fromName: 'Mara', toName: 'Tor', kind: 'feared',
        evidence: 'She feared him.', anchorEvidence: 'Mara was afraid of Tor.', confidence: 1,
      },
      0,
    ),
    { ok: false, reason: 'relationship-not-entailed' },
  );
});

/* ------------------------------------------------------------------- B3 denial */

test('B3: a denial of a family verb is refused even when the kind head is absent', () => {
  assert.deepEqual(
    decide({
      fromName: 'Mara', toName: 'Tor', kind: 'friend of',
      evidence: 'Mara did not trust Tor.', confidence: 1,
    }),
    { ok: false, reason: 'assertion-missing' },
  );
});

test('B3: the same denial is refused when the model supplied the verb as the kind source', () => {
  assert.deepEqual(
    decide({
      fromName: 'Mara', toName: 'Tor', kind: 'ally of', kindSource: 'trusted',
      evidence: 'Mara did not trust Tor.', confidence: 1,
    }),
    { ok: false, reason: 'assertion-missing' },
  );
});

test('B3: "never" before an inflected family verb is a denial', () => {
  assert.deepEqual(
    decide({
      fromName: 'Mara', toName: 'Tor', kind: 'friend of',
      evidence: 'Mara never trusted Tor.', confidence: 1,
    }),
    { ok: false, reason: 'assertion-missing' },
  );
});

/* ----------------------------------------------------------------- B6 verbatim */

test('B6: curly apostrophes fold like the integrity audit', () => {
  assert.deepEqual(
    decide({
      fromName: 'Mara', toName: 'Tor', kind: 'mentor of',
      evidence: 'Mara was Tor’s mentor.', confidence: 1,
    }),
    { ok: true },
  );
});

test('B6: punctuation-spliced text does not pass the gate', () => {
  const row = {
    fromId: 1, toId: 2, fromName: 'Mara', toName: 'Tor',
    kind: 'mentor of', evidence: "Mara was Tor's mentor Tor left.", confidence: 1,
  };
  assert.deepEqual(
    lorebook.provenRelation(row, {
      chunkText: "Mara was Tor's mentor. Tor left.",
      minConfidence: 0,
    }),
    { ok: false, reason: 'quote-not-verbatim' },
  );
});

/* ------------------------------------------------------ B10 missing confidence */

test('B10: an omitted model confidence is below the threshold, not full marks', () => {
  assert.deepEqual(
    decide({
      fromName: 'Mara', toName: 'Tor', kind: 'mentor of',
      evidence: "Mara was Tor's mentor.",
    }, 0.7),
    { ok: false, reason: 'below-threshold' },
  );
});

/* --------------------------------------------------------------- A1 tie guard */

const PASSAGE = { chunkId: 1, sourceId: 1, sourceTitle: 'Probe', path: '/probe', locator: 'p. 1', heading: '', text: 'Asha waited by the gate.', score: 1 };
const QUESTION = "Is Asha Bram's sister?";

function guardSetup() {
  const { db } = tempDb();
  const project = controller.createProject(db, `precision-guard-${Math.random().toString(36).slice(2, 7)}`);
  const mk = (name: string) => db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id, 'character', name, '[]', AT, AT,
  ).lastInsertRowid;
  mk('Asha');
  mk('Bram');
  return { db, projectId: project.id };
}

test('A1: "No doubt" does not skip the whole sentence', () => {
  const { db, projectId } = guardSetup();
  const output = enforceStatusTieGuard(db, projectId, QUESTION, "No doubt, Asha is Bram's sister.", []);
  assert.match(output, /Tie not established/);
  db.close();
});

test('A1: a short quoted span is still checked against the passages', () => {
  const { db, projectId } = guardSetup();
  const draft = 'Asha is Bram\'s sister. Asha said, "moon is cheese."';
  const output = enforceStatusTieGuard(db, projectId, QUESTION, draft, [PASSAGE]);
  assert.match(output, /quote-not-in-passage/);
  db.close();
});

test('A1: a [Lore: ...] marker elsewhere on the line does not exempt a passage quote', () => {
  const { db, projectId } = guardSetup();
  const draft = '[Lore: Asha] Asha said "the moon is made of green cheese".';
  const output = enforceStatusTieGuard(db, projectId, QUESTION, draft, [PASSAGE]);
  assert.match(output, /quote-not-in-passage/);
  db.close();
});
