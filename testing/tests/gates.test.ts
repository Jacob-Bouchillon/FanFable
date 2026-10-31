/**
 * Gates module: single owner for every promotion rule; lorebook re-exports
 * the public surface so existing importers keep working.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as gates from '../../fanfable/src/gates/gates.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';

test('lorebook re-exports the gates surface identically (same function identity)', () => {
  assert.equal(lorebook.keeperQuoteReason, gates.keeperQuoteReason);
  assert.equal(lorebook.attestedQuoteReason, gates.attestedQuoteReason);
  assert.equal(lorebook.provenRelation, gates.provenRelation);
  assert.equal(lorebook.claimTier, gates.claimTier);
  assert.equal(lorebook.DEFAULT_MIN_CONFIDENCE, gates.DEFAULT_MIN_CONFIDENCE);
  assert.equal(gates.DEFAULT_MIN_CONFIDENCE, 0.7);
});
