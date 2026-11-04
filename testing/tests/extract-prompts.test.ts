/**
 * Extract-prompts module: single owner for every reader wording.
 * Bytes are locked — any rewording, reordering, or whitespace drift
 * fails these hashes on purpose. lorebook re-exports the surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as prompts from '../../fanfable/src/extract/extract-prompts.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

test('lorebook re-exports the prompts module identically', () => {
  assert.equal(lorebook.EXTRACT_ENTITIES_SYSTEM, prompts.EXTRACT_ENTITIES_SYSTEM);
  assert.equal(lorebook.EXTRACT_RELATIONS_SYSTEM, prompts.EXTRACT_RELATIONS_SYSTEM);
  assert.equal(lorebook.EXTRACT_EVENTS_SYSTEM, prompts.EXTRACT_EVENTS_SYSTEM);
  assert.equal(lorebook.ASSESSMENT_QUESTIONS, prompts.ASSESSMENT_QUESTIONS);
  assert.equal(lorebook.formatKnownEntities, prompts.formatKnownEntities);
});

test('no extraction prompt asks for a modality the schema cannot store', () => {
  for (const [name, prompt] of [
    ['entities', prompts.EXTRACT_ENTITIES_SYSTEM],
    ['relations', prompts.EXTRACT_RELATIONS_SYSTEM],
    ['events', prompts.EXTRACT_EVENTS_SYSTEM],
  ] as const) {
    assert.equal(/modality/i.test(prompt), false, `${name} prompt names modality`);
  }
});

test('prompt bytes are locked', () => {
  assert.equal(sha(prompts.EXTRACT_ENTITIES_SYSTEM), 'bec452aa82113ff98e42cf2a51ba52f5c6a618b707e5ecb783b57be51f391cec');
  assert.equal(sha(prompts.EXTRACT_RELATIONS_SYSTEM), '7b3f6702bc89c038e73a8fbbc4e71ab551eb058d80b9fc148bef7cf9b0e3b518');
  assert.equal(sha(prompts.EXTRACT_EVENTS_SYSTEM), '4f9ff6cc13acec76a3f93fb7db07a5e74bfc1f683bfde2a0d4f38d90675b4fa1');
  assert.equal(sha(prompts.ASSESSMENT_QUESTIONS), '1606c19e2b58a81c0a0d70bb91b4989cccd490e08e432136f80d70b5abb465f5');
  assert.equal(
    prompts.formatKnownEntities(['Asha', 'Bram']),
    'KNOWN ENTITIES:\nParenthetical aliases are alternate names for the entity on that line, not separate entities or relationship endpoints. Use them to resolve mentions; when writing a relationship endpoint, use the listed canonical entity name.\n- Asha\n- Bram',
  );
  assert.equal(
    prompts.formatKnownEntities(['Etta Vale'], [{ name: 'Etta Vale', aliases: ['Fox'] }]),
    'KNOWN ENTITIES:\nParenthetical aliases are alternate names for the entity on that line, not separate entities or relationship endpoints. Use them to resolve mentions; when writing a relationship endpoint, use the listed canonical entity name.\n- Etta Vale (also known as: Fox)',
  );
});
