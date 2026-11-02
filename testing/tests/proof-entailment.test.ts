/**
 * The entailment floor: a verbatim quote that names both endpoints is not
 * enough. The sentence must express the claimed family and direction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function prove(row: {
  fromName: string; toName: string; fromAliases?: string[]; toAliases?: string[];
  kind: string; evidence: string; anchorEvidence?: string; kindSource?: string;
}) {
  return lorebook.provenRelation(
    { fromId: 1, toId: 2, confidence: 1, ...row },
    { chunkText: row.evidence + (row.anchorEvidence ? ` ${row.anchorEvidence}` : ''), minConfidence: 0 },
  );
}

test('p4: Jobal/Ruwee marriage through a definite description passes', () => {
  assert.deepEqual(prove({
    fromName: 'Ruwee', toName: 'Jobal', kind: 'married',
    evidence: 'Married to Ruwee by arrangement, she was every bit as serious as he was, and equally committed to the refugee movement.',
    anchorEvidence: 'You remember Jobal?',
  }), { ok: true });
});


test('p4 passes because the anchor supplies Jobal, not because of a co-mention', () => {
  assert.deepEqual(prove({
    fromName: 'Ruwee', toName: 'Jobal', kind: 'married',
    evidence: 'Married to Ruwee by arrangement, she was every bit as serious as he was, and equally committed to the refugee movement.',
  }), { ok: false, reason: 'endpoint-unnamed' });
  assert.deepEqual(prove({
    fromName: 'Ruwee', toName: 'Jobal', kind: 'married',
    evidence: 'Married to Ruwee by arrangement, she was every bit as serious as he was, and equally committed to the refugee movement.',
    anchorEvidence: 'You remember Jobal?',
  }), { ok: true });
});

test('p4: the unrelated Jobal/Ruwee co-mention fails', () => {
  assert.deepEqual(prove({
    fromName: 'Ruwee', toName: 'Jobal', kind: 'married',
    evidence: 'The two Naboo were close in age, but Ruwee was a product of public education rather than the series of private institutions young Palpatine had attended. “You remember Jobal?',
  }), { ok: false, reason: 'relationship-not-entailed' });
});

test('k1: Tenebrous/Plagueis dialogue establishes apprenticeship in the right direction', () => {
  assert.deepEqual(prove({
    fromName: 'Darth Plagueis', toName: 'Darth Tenebrous', fromAliases: ['Plagueis'], toAliases: ['Tenebrous'],
    kind: 'apprentice',
    evidence: '“Stop, apprentice,” Tenebrous strained to say.',
    anchorEvidence: '“I’m dying, Darth Plagueis. There’s time only for that.”',
  }), { ok: true });
});

test('k4: the funeral co-mention does not prove an alliance', () => {
  assert.deepEqual(prove({
    fromName: 'Kinman Doriana', toName: 'Sate Pestage', fromAliases: ['Kinman', 'Doriana'], toAliases: ['Sate', 'Pestage'],
    kind: 'ally of',
    evidence: 'Dressed in a high-collared cape and purple robes, Palpatine arrived at the ornate monad in the company of Kinman Doriana, Sate Pestage, and Janus Greejatus, who had been dispatched to Coruscant by Tapalo.',
  }), { ok: false, reason: 'relationship-not-entailed' });
});

test('k4: a bare "instant bond" is not the ally family by itself', () => {
  assert.deepEqual(prove({
    fromName: 'Kinman Doriana', toName: 'Sate Pestage', fromAliases: ['Kinman', 'Doriana'], toAliases: ['Sate', 'Pestage'],
    kind: 'ally of',
    evidence: 'Kinman and Sate had forged an instant bond.',
  }), { ok: false, reason: 'relationship-not-entailed' });
});

test('p5: evidence naming the wrong endpoints fails', () => {
  const decision = prove({
    fromName: 'Narro Sienar', toName: 'Darth Tenebrous', fromAliases: ['Narro', 'Sienar'], toAliases: ['Tenebrous'],
    kind: 'partnership',
    evidence: 'You need now to hear about the first mission I performed for Darth Tenebrous.',
  });
  assert.equal(decision.ok, false);
  assert.ok(['endpoint-unnamed', 'relationship-not-entailed'].includes(String(decision.reason)));
});

test('generic co-mention fails', () => {
  assert.deepEqual(prove({
    fromName: 'Mara', toName: 'Tor', kind: 'aunt of',
    evidence: 'Mara and Tor came in together.',
  }), { ok: false, reason: 'relationship-not-entailed' });
});

test('negation and hedging are refused before entailment', () => {
  assert.deepEqual(prove({
    fromName: 'Mara', toName: 'Tor', kind: 'trusted', kindSource: 'trust',
    evidence: 'Mara did not trust Tor.',
  }), { ok: false, reason: 'assertion-missing' });
  assert.deepEqual(prove({
    fromName: 'Mara', toName: 'Tor', kind: 'feared',
    evidence: 'Perhaps Mara feared Tor.',
  }), { ok: false, reason: 'assertion-missing' });
});

test('reversed direction is refused; the same possessive forward passes', () => {
  assert.deepEqual(prove({
    fromName: 'Mara', toName: 'Tor', kind: 'mentor of',
    evidence: "Tor was Mara's mentor.",
  }), { ok: false, reason: 'direction-mismatch' });
  assert.deepEqual(prove({
    fromName: 'Mara', toName: 'Tor', kind: 'mentor of',
    evidence: "Mara was Tor's mentor.",
  }), { ok: true });
});

test('coordinated symmetric wording still passes', () => {
  assert.deepEqual(prove({
    fromName: 'Mara', toName: 'Tor', kind: 'friend of',
    evidence: 'Mara and Tor are friends.',
  }), { ok: true });
});

test('canPromoteRelation fails closed on the funeral co-mention', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'proof-entailment-db');
  const sourceId = db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    project.id, '/probe', 'Probe', 'sha-proof', AT,
  ).lastInsertRowid;
  const chunkId = db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId, project.id, 1, 'p. 1', '',
    'Dressed in a high-collared cape and purple robes, Palpatine arrived at the ornate monad in the company of Kinman Doriana, Sate Pestage, and Janus Greejatus.',
    24,
  ).lastInsertRowid;
  const mk = (name: string, aliases: string[]) => db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id, 'character', name, JSON.stringify(aliases), AT, AT,
  ).lastInsertRowid;
  const kinman = mk('Kinman Doriana', ['Kinman', 'Doriana']);
  const sate = mk('Sate Pestage', ['Sate', 'Pestage']);
  const relationId = Number(db.run(
    `INSERT INTO canon_relation
       (project_id, from_entity, to_entity, kind, evidence, source_refs, confidence, review_status, created_at)
     VALUES (?, ?, ?, 'ally of', ?, ?, 0.9, 'provisional', ?)`,
    project.id, kinman, sate,
    'Dressed in a high-collared cape and purple robes, Palpatine arrived at the ornate monad in the company of Kinman Doriana, Sate Pestage, and Janus Greejatus.',
    JSON.stringify([{ chunk: chunkId }]), AT,
  ).lastInsertRowid);
  const decision = lorebook.canPromoteRelation(db, project.id, relationId);
  assert.deepEqual(decision, { ok: false, reason: 'relationship-not-entailed' });
  const row = db.get<{ review_status: string; evidence: string }>(
    'SELECT review_status, evidence FROM canon_relation WHERE id = ?',
    relationId,
  )!;
  assert.equal(row.review_status, 'provisional', 'the failed claim stays provisional');
  assert.equal(row.evidence.length > 0, true, 'the quote is preserved');
  db.close();
});
