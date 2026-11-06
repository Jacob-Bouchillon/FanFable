/** Deterministic alias-group proposals: no writes, no model. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeAliasGroups, type AliasEntityInput } from '../../fanfable/src/identity/alias-groups.ts';

function entities(
  ...defs: Array<[id: number, name: string, aliases?: string[], kind?: string]>
): AliasEntityInput[] {
  return defs.map(([id, name, aliases = [], kind = 'character']) => ({ id, name, aliases, kind }));
}

test('given-name containment merges a given name but not a surname or a second name', () => {
  const groups = proposeAliasGroups(entities(
    [1, 'Harry'],
    [2, 'Harry Potter'],
    [3, 'Dudley'],
    [4, 'Dudley Dursley'],
    [5, 'Potter'],
    [6, 'Dumbledore'],
    [7, 'Albus Dumbledore'],
  ));

  assert.deepEqual(groups.map((group) => group.memberIds), [[1, 2], [3, 4]]);
  assert.deepEqual(groups.map((group) => group.canonicalId), [2, 4]);
  assert.deepEqual(groups.map((group) => group.reason), ['given-name', 'given-name']);
  assert.deepEqual(groups[0]!.forms, ['Harry', 'Harry Potter']);
  assert.deepEqual(groups[1]!.forms, ['Dudley', 'Dudley Dursley']);
  assert.ok(!groups.some((group) => group.memberIds.includes(5)), 'Potter does not merge with Harry Potter');
  assert.ok(!groups.some((group) => group.memberIds.includes(6)), 'Dumbledore does not merge with Albus Dumbledore');
  assert.ok(!groups.some((group) => group.memberIds.includes(7)));
});

test('title-only equality merges compatible titles and refuses gendered pairs', () => {
  const groups = proposeAliasGroups(entities(
    [1, 'Snape'],
    [2, 'Professor Snape'],
    [3, 'Quirrell'],
    [4, 'Professor Quirrell'],
    [5, 'Mr. Dursley'],
    [6, 'Mrs. Dursley'],
    [7, 'Ron Weasley'],
    [8, 'Mrs. Weasley'],
  ));

  assert.deepEqual(groups.map((group) => group.memberIds), [[1, 2], [3, 4]]);
  assert.deepEqual(groups.map((group) => group.reason), ['title-only', 'title-only']);
  assert.deepEqual(groups[0]!.forms, ['Professor Snape', 'Snape']);
  assert.ok(!groups.some((group) => group.memberIds.includes(5) && group.memberIds.includes(6)));
  assert.ok(!groups.some((group) => group.memberIds.includes(7) && group.memberIds.includes(8)));
});

test('Harry, Harry Potter and Dumbledore are separate components', () => {
  const groups = proposeAliasGroups(entities(
    [1, 'Harry'],
    [2, 'Harry Potter'],
    [3, 'Dumbledore'],
  ));

  assert.equal(groups.length, 1, 'only the merged pair is reported');
  assert.deepEqual(groups[0]!.memberIds, [1, 2]);
  assert.ok(!groups[0]!.memberIds.includes(3), 'Dumbledore stays separate');
});

test('the Weasley family stays split and single-token aliases are ignored', () => {
  const groups = proposeAliasGroups(entities(
    [1, 'Fred Weasley'],
    [2, 'George Weasley'],
    [3, 'Ron Weasley', ['Weasley']],
  ));

  assert.deepEqual(groups, []);
});

test('multi-token aliases participate in the same rules', () => {
  const groups = proposeAliasGroups(entities(
    [1, 'Severus', ['Professor Snape']],
    [2, 'Snape'],
  ));

  assert.deepEqual(groups.map((group) => group.memberIds), [[1, 2]]);
  assert.equal(groups[0]!.reason, 'title-only');
  assert.deepEqual(groups[0]!.forms, ['Professor Snape', 'Snape']);
});

test('union-find makes groups transitive and the longest name is canonical', () => {
  const groups = proposeAliasGroups(entities(
    [1, 'Harry'],
    [2, 'Harry Potter'],
    [3, 'Harry Potter Junior'],
  ));

  assert.deepEqual(groups.map((group) => group.memberIds), [[1, 2, 3]]);
  assert.equal(groups[0]!.canonicalId, 3);
  assert.equal(groups[0]!.reason, 'given-name');
  assert.deepEqual(groups[0]!.forms, ['Harry', 'Harry Potter', 'Harry Potter Junior']);
});

test('possessive and role aliases do not group a parent with her child', () => {
  const groups = proposeAliasGroups(entities(
    [1, 'Petunia Dursley', ['Aunt Petunia', "Dudley's mother"]],
    [2, 'Dudley'],
  ));

  assert.deepEqual(groups, []);
});

test('non-character entities are never grouped here', () => {
  const groups = proposeAliasGroups(entities(
    [1, 'Hut-on-the-Rock', ['the hut'], 'location'],
    [2, 'Hagrid', ["Hagrid's hut"], 'character'],
  ));

  assert.deepEqual(groups, []);
});

