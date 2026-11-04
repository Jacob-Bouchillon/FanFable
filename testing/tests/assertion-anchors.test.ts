/**
 * The old anchor/assertion rules no longer veto a claim. What remains is
 * citation honesty: quoted fragments and anchors must exist, and a fragment
 * may not hide a hedge in the sentence that holds it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lorebook from '../../fanfable/src/lorebook.ts';

const decide = (
  unit: {
    evidence: string;
    anchorEvidence?: string;
    kind?: string;
    kindSource?: string;
    confidence?: number;
  },
  chunkText: string,
) =>
  lorebook.provenRelation(
    {
      fromId: 1,
      toId: 2,
      fromName: 'Mara',
      toName: 'Tor',
      kind: unit.kind ?? 'friend of',
      evidence: unit.evidence,
      anchorEvidence: unit.anchorEvidence,
      kindSource: unit.kindSource,
      confidence: unit.confidence ?? 0.9,
    },
    { chunkText, minConfidence: 0.7 },
  );

test('a pronoun-bound claim parks under B2-strict', () => {
  // B2-strict accepts a symmetric verb only when the sentence names both
  // sides. An anchored pronoun pair no longer banks; the recall cost is
  // accepted to stop grammatical-but-unconvincing ties.
  const text = 'She feared him. Mara was afraid of Tor.';
  assert.deepEqual(
    decide({ evidence: 'She feared him.', anchorEvidence: 'Mara was afraid of Tor.', kind: 'feared' }, text),
    { ok: false, reason: 'relationship-not-entailed' },
  );
});

test('an anchor that is not in the passage is a citation failure', () => {
  const text = 'She feared him. Mara was afraid of Tor.';
  assert.deepEqual(
    decide({ evidence: 'She feared him.', anchorEvidence: 'Mara hated Tor.', kind: 'feared' }, text),
    { ok: false, reason: 'quote-not-verbatim' },
  );
});

test('a quoted sub-span may not hide a preceding hedge', () => {
  const text = 'Perhaps Mara feared Tor, though she never admitted it.';
  assert.deepEqual(decide({ evidence: 'Mara feared Tor', kind: 'feared' }, text), {
    ok: false,
    reason: 'assertion-missing',
  });
});

test('a coordinated list is not a grammar veto', () => {
  assert.deepEqual(decide({ evidence: 'Mara and Tor are friends.', kind: 'friend of' }, 'Mara and Tor are friends.'), {
    ok: true,
  });
});
