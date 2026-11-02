/**
 * Vocabulary regressions. "Partnership" is the ally concept already carried
 * by "partner"; a lover is not a spouse, and a spouse is not made a lover by
 * romance. The gate must not use one to prove the other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { canonicalProofKind, familyOfKind } from '../../fanfable/src/identity/relation-proof.ts';

function decide(kind: string, evidence: string) {
  return lorebook.provenRelation(
    { fromId: 1, toId: 2, fromName: 'Mara', toName: 'Tor', kind, evidence, confidence: 1 },
    { chunkText: evidence, minConfidence: 0 },
  );
}

test('partnership and partner are the same ally kind', () => {
  assert.equal(familyOfKind('partnership'), 'ally');
  assert.equal(familyOfKind('partner'), 'ally');
  assert.equal(familyOfKind('partner of'), 'ally');
  assert.equal(canonicalProofKind('partnership'), 'ally_of');
  assert.equal(canonicalProofKind('partner of'), 'ally_of');
  assert.deepEqual(decide('ally of', 'Mara had a secret partnership with Tor.'), { ok: true });
  assert.deepEqual(decide('ally of', "Mara was Tor's partner."), { ok: true });
});

test('a lover is a lover, not a spouse', () => {
  assert.deepEqual(decide('lover of', "Mara was Tor's lover."), { ok: true });
  assert.deepEqual(decide('lover of', 'Mara and Tor were lovers.'), { ok: true });
  assert.deepEqual(decide('married to', "Mara was Tor's lover."), {
    ok: false,
    reason: 'relationship-not-entailed',
  });
  assert.deepEqual(decide('spouse of', "Mara was Tor's lover."), {
    ok: false,
    reason: 'relationship-not-entailed',
  });
});

test('a spouse is a spouse, not a lover', () => {
  assert.deepEqual(decide('married to', 'Mara was married to Tor.'), { ok: true });
  assert.deepEqual(decide('spouse of', "Mara was Tor's spouse."), { ok: true });
  assert.deepEqual(decide('lover of', 'Mara was married to Tor.'), {
    ok: false,
    reason: 'relationship-not-entailed',
  });
});

test('a partner is not a spouse, and a lover is not an ally partner', () => {
  assert.deepEqual(decide('partner of', "Mara was Tor's business partner."), { ok: true });
  assert.deepEqual(decide('partner of', "Mara was Tor's lover."), {
    ok: false,
    reason: 'relationship-not-entailed',
  });
  assert.deepEqual(decide('married to', "Mara was Tor's partner."), {
    ok: false,
    reason: 'relationship-not-entailed',
  });
});
