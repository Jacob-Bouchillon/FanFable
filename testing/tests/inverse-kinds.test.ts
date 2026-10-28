/**
 * Inverse-kind map hygiene: one unordered pair list, both directions built at
 * load. Pure unit assertions on the builder output; no DB, no model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INVERSE_PAIRS, buildInverseMap } from '../../fanfable/src/lorebook.ts';

test('every inverse pair resolves in both directions', () => {
  const map = buildInverseMap(INVERSE_PAIRS);

  for (const [left, right] of INVERSE_PAIRS) {
    assert.ok(map.get(left)?.includes(right), `${left} should list ${right}`);
    assert.ok(map.get(right)?.includes(left), `${right} should list ${left}`);
  }

  // No value may point somewhere that does not point back.
  for (const [head, others] of map) {
    for (const other of others) {
      assert.ok(map.get(other)?.includes(head), `${other} should list ${head} back`);
    }
  }

  assert.deepEqual(map.get('parent'), ['child', 'son', 'daughter']);
  assert.deepEqual(map.get('child'), ['parent']);
  assert.deepEqual(map.get('son'), ['parent']);
  assert.deepEqual(map.get('daughter'), ['parent']);
});
