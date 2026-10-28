/**
 * The relations few-shot examples are opt-in and invented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lorebook from '../../fanfable/src/lorebook.ts';

test('the few-shot block is off by default and only FANFABLE_REL_FEWSHOT=1 appends it', () => {
  const before = process.env.FANFABLE_REL_FEWSHOT;
  try {
    delete process.env.FANFABLE_REL_FEWSHOT;
    assert.equal(lorebook.relationsSystemPrompt(), lorebook.EXTRACT_RELATIONS_SYSTEM);

    process.env.FANFABLE_REL_FEWSHOT = '0';
    assert.equal(lorebook.relationsSystemPrompt(), lorebook.EXTRACT_RELATIONS_SYSTEM);

    process.env.FANFABLE_REL_FEWSHOT = '1';
    const prompted = lorebook.relationsSystemPrompt();
    assert.ok(prompted.startsWith(lorebook.EXTRACT_RELATIONS_SYSTEM));
    assert.ok(prompted.includes('Examples (invented names)'));
    assert.ok(prompted.includes("Asha is Bram's sister"));
    assert.ok(prompted.includes('Meeting once is a moment, not a lasting tie.'));
    assert.ok(prompted.includes('a tie needs both endpoints named.'));
  } finally {
    if (before === undefined) delete process.env.FANFABLE_REL_FEWSHOT;
    else process.env.FANFABLE_REL_FEWSHOT = before;
  }
});
