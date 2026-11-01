/**
 * Roster merge rules: one person under several names merges by rule; two
 * people who share a surname never do; a non-person never becomes a person.
 *
 * Pure rule tests — no database, no model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeVerdict,
  isPersonKind,
  sharedSurnameOnly,
} from '../../fanfable/src/identity/roster-rules.ts';

const person = (name: string) => ({ name, kind: 'character' });

test('the same name up to case, possessive and plural merges', () => {
  assert.equal(mergeVerdict(person('Dursley'), person('Dursleys')).action, 'merge');
  assert.equal(mergeVerdict(person("Harry's"), person('Harry')).action, 'merge');
  assert.equal(mergeVerdict(person('HARRY POTTER'), person('harry potter')).action, 'merge');
});

test('a contained name merges when the two never speak in one scene', () => {
  const verdict = mergeVerdict(person('Harry'), person('Harry Potter'), { sharedSpeakerScene: false });
  assert.equal(verdict.action, 'merge');
  assert.equal(verdict.reason, 'containment');
});

test('a title-stripped name merges with the full name', () => {
  assert.equal(mergeVerdict(person('Captain Rex'), person('Rex'), { sharedSpeakerScene: false }).action, 'merge');
});

test('two people in one scene keep their two rows', () => {
  const verdict = mergeVerdict(person('Harry'), person('Harry Potter'), { sharedSpeakerScene: true });
  assert.equal(verdict.action, 'quarantine');
  assert.match(verdict.reason, /same passage/);
});

test('distinct people sharing a surname never merge', () => {
  assert.equal(sharedSurnameOnly('Larsh Hill', 'San Hill'), true);
  const verdict = mergeVerdict(person('Larsh Hill'), person('San Hill'));
  assert.equal(verdict.action, 'separate');
  assert.equal(verdict.reason, 'surname shared, given names differ');
});

test('a bare title never merges into a named person', () => {
  const verdict = mergeVerdict(person('Captain'), person('Captain Rex'));
  assert.equal(verdict.action, 'separate');
  assert.equal(verdict.reason, 'title only');
});

test('species, factions, places and roles never merge into a character row', () => {
  for (const kind of ['species', 'faction', 'location', 'rule', 'creature', 'item']) {
    assert.equal(isPersonKind(kind), false, kind);
    const verdict = mergeVerdict(person('Hogwarts'), { name: 'Hogwarts School', kind });
    assert.equal(verdict.action, 'separate', `${kind} must not merge with a character`);
    assert.equal(verdict.reason, 'different kinds');
  }
  assert.equal(isPersonKind('character'), true);
});

test('unrelated names are left alone', () => {
  assert.equal(mergeVerdict(person('Harry Potter'), person('Ron Weasley')).action, 'separate');
});

test('duplicate places still merge under the same name rule', () => {
  const a = { name: 'Hogwarts', kind: 'location' };
  const b = { name: 'Hogwarts', kind: 'location' };
  assert.equal(mergeVerdict(a, b).action, 'merge');
});
