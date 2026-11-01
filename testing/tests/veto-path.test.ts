/**
 * The veto call path: a row that mechanical proof passes can still be refused
 * by the verifier, and removing the veto leaves the pipe green with the row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyVetoBatch } from '../../fanfable/src/gates/veto-batch.ts';
import { vetoEnabled } from '../../fanfable/src/gates/veto-bridge.ts';
import { VETO_THRESHOLD } from '../../fanfable/src/gates/veto.ts';

const row = {
  fromName: 'Asha',
  toName: 'Bram',
  kind: 'sister of',
  sentence: "Asha was Bram's sister.",
  chunkText: "Asha was Bram's sister.",
};

test('a mechanically proven row the verifier refuses is parked with the veto reason', async () => {
  const scorer = { scoreBatch: async () => [0.41] };
  const out = await applyVetoBatch([row], scorer);
  assert.equal(out.kept.length, 0);
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0]!.score, 0.41);
  assert.ok(out.rejected[0]!.score < VETO_THRESHOLD);
});

test('a mechanically proven row the verifier supports is kept', async () => {
  const scorer = { scoreBatch: async () => [0.83] };
  const out = await applyVetoBatch([row], scorer);
  assert.equal(out.kept.length, 1);
  assert.equal(out.rejected.length, 0);
});

test('pulling the veto leaves the pipe green with the row', async () => {
  const out = await applyVetoBatch([row], undefined);
  assert.equal(out.kept.length, 1);
  assert.equal(out.rejected.length, 0);
  assert.equal(out.unscored.length, 0);
});

test('an unscorable row stays in review, never promoted', async () => {
  const scorer = { scoreBatch: async () => [null] };
  const out = await applyVetoBatch([row], scorer);
  assert.equal(out.kept.length, 0);
  assert.equal(out.unscored.length, 1);
});

test('the veto switch is explicit', () => {
  assert.equal(vetoEnabled({} as NodeJS.ProcessEnv), true);
  assert.equal(vetoEnabled({ FANFABLE_VETO: 'off' } as NodeJS.ProcessEnv), false);
});
