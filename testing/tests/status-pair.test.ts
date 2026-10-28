import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatusPair } from '../../fanfable/src/lorebook.ts';

test('trailing sentence punctuation is stripped from both names', () => {
  assert.deepEqual(parseStatusPair('What is the status of Asha to Bram?'), { a: 'Asha', b: 'Bram' });
  assert.deepEqual(parseStatusPair('What is the status of Asha! to Bram!!!'), { a: 'Asha', b: 'Bram' });
  assert.deepEqual(parseStatusPair('What is the status of Asha. to Bram.'), { a: 'Asha', b: 'Bram' });
  assert.deepEqual(parseStatusPair('What is the status of Asha, to Bram,,'), { a: 'Asha', b: 'Bram' });
  assert.deepEqual(parseStatusPair('What is the status of Asha; to Bram::'), { a: 'Asha', b: 'Bram' });
});

test('interior punctuation is preserved', () => {
  assert.deepEqual(parseStatusPair('What is the status of Asha-Ren to Bram?'), { a: 'Asha-Ren', b: 'Bram' });
});

test('quotes are stripped after punctuation', () => {
  assert.deepEqual(parseStatusPair('What is the status of "Asha?" to “Bram!”'), { a: 'Asha', b: 'Bram' });
});

test('an as-of suffix is still ignored', () => {
  assert.deepEqual(parseStatusPair('What is the status of Asha to Bram as of chapter 3?'), { a: 'Asha', b: 'Bram' });
});

test('an unknown pair keeps its trimmed names', () => {
  assert.deepEqual(parseStatusPair('What is the status of   Kestrel Vane   to   Orin Thal ?'), {
    a: 'Kestrel Vane',
    b: 'Orin Thal',
  });
});
