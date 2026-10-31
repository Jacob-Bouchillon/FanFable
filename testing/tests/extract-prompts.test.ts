/**
 * Extract-prompts module: single owner for every reader wording.
 * Bytes are locked — any rewording, reordering, or whitespace drift
 * fails these hashes on purpose. lorebook re-exports the surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as prompts from '../../fanfable/src/extract-prompts.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

test('lorebook re-exports the prompts module identically', () => {
  assert.equal(lorebook.EXTRACT_ENTITIES_SYSTEM, prompts.EXTRACT_ENTITIES_SYSTEM);
  assert.equal(lorebook.EXTRACT_RELATIONS_SYSTEM, prompts.EXTRACT_RELATIONS_SYSTEM);
  assert.equal(lorebook.EXTRACT_EVENTS_SYSTEM, prompts.EXTRACT_EVENTS_SYSTEM);
  assert.equal(lorebook.ASSESSMENT_QUESTIONS, prompts.ASSESSMENT_QUESTIONS);
  assert.equal(lorebook.formatKnownEntities, prompts.formatKnownEntities);
});

test('prompt bytes are locked', () => {
  assert.equal(sha(prompts.EXTRACT_ENTITIES_SYSTEM), '477e7d8a0243986b24f39ddcc032acb44f0c933974876dc2d6db53b18a8136fc');
  assert.equal(sha(prompts.EXTRACT_RELATIONS_SYSTEM), '2644f3de376bdc0420bae2f8d79fbbddf5251e2397bc927ad3b4edf2e0e896aa');
  assert.equal(sha(prompts.EXTRACT_EVENTS_SYSTEM), 'a37a771dcddac1611c12faa69e7b99b0c87c93a8554cf8f3c79bf23a2c272705');
  assert.equal(sha(prompts.ASSESSMENT_QUESTIONS), '1606c19e2b58a81c0a0d70bb91b4989cccd490e08e432136f80d70b5abb465f5');
  assert.equal(prompts.formatKnownEntities(['Asha', 'Bram']), 'KNOWN ENTITIES:\n- Asha\n- Bram');
});
