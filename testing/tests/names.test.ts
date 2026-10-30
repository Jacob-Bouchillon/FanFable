/**
 * Apostrophe identity: the curly and straight forms are one name.
 * Invented names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRosterIndex, canonicalName, deriveNameVariants, nameRelation } from '../../fanfable/src/names.ts';

const STRAIGHT = "Shi'ido";
const CURLY = 'Shi\u2019ido';
const OPEN = 'Shi\u2018ido';

test('the two apostrophe forms canonicalise identically', () => {
  assert.equal(canonicalName(CURLY), canonicalName(STRAIGHT));
  assert.equal(canonicalName(OPEN), canonicalName(STRAIGHT));
  assert.equal(canonicalName(STRAIGHT), "shi'ido");
});

test('nameRelation treats the forms as the same name', () => {
  assert.equal(nameRelation(STRAIGHT, CURLY), 'same');
  assert.equal(nameRelation(CURLY, STRAIGHT), 'same');
});

test('possessives normalise the same way in both forms', () => {
  assert.equal(canonicalName("Shi'ido's"), canonicalName('Shi\u2019ido\u2019s'));
  assert.equal(canonicalName("Shi'ido's"), "shi'ido");
});

test('variants derived from one form include the other surface', () => {
  const index = buildRosterIndex([{ name: STRAIGHT, aliases: [] }], 'a passage about the order');
  const variants = deriveNameVariants({ name: STRAIGHT, aliases: [] }, index);
  const canonical = variants.map((v) => canonicalName(v));
  assert.ok(canonical.every((v) => v === "shi'ido"), canonical.join('|'));
});

test('a straight-form name is found inside curly-form text and the reverse', () => {
  const text = `The order of the ${CURLY} kept its own counsel.`;
  const index = buildRosterIndex([{ name: STRAIGHT, aliases: [] }], text);
  const forms = deriveNameVariants({ name: STRAIGHT, aliases: [] }, index).map((v) => canonicalName(v));
  const tokens = canonicalName(text).split(' ').filter(Boolean);
  const hit = forms.some((form) =>
    tokens.some((_, i) =>
      form.split(' ').every((word, k) => tokens[i + k] === word),
    ),
  );
  assert.equal(hit, true, 'the straight-form entity matches the curly-form passage');

  const reverseText = `The order of the ${STRAIGHT} kept its own counsel.`;
  const reverseIndex = buildRosterIndex([{ name: CURLY, aliases: [] }], reverseText);
  const reverseForms = deriveNameVariants({ name: CURLY, aliases: [] }, reverseIndex).map((v) =>
    canonicalName(v),
  );
  const reverseTokens = canonicalName(reverseText).split(' ').filter(Boolean);
  assert.equal(
    reverseForms.some((form) =>
      reverseTokens.some((_, i) => form.split(' ').every((word, k) => reverseTokens[i + k] === word)),
    ),
    true,
    'the curly-form entity matches the straight-form passage',
  );
});
