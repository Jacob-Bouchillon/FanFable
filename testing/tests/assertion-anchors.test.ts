/**
 * Assertion anchors and coordination (generic names only).
 *
 * An anchor proves a tie only when it is a bankable role head ("married",
 * "friend", "partner") or a link-tailed phrase ("sided with", "member of").
 * A bare action verb ("joined", "backed", "leads") proves nothing, and an
 * "and"/"or" list between the endpoints is a scene, not an assertion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertsRelationship, classifyEvidence } from '../../fanfable/src/lorebook.ts';
import { buildRosterIndex } from '../../fanfable/src/names.ts';

const classify = (sentence: string, kind: string, kindSource = '') =>
  classifyEvidence(sentence, 'X', [], 'Y', [], kind, kindSource);

const check = (sentence: string, kind: string, kindSource = '') =>
  assertsRelationship(sentence, 'X', [], 'Y', [], kind, kindSource);

/* --------------------------------------------------------------- positive */

const POSITIVE: { sentence: string; kind: string; kindSource?: string }[] = [
  { sentence: "X's brother, Y", kind: 'brother of' },
  { sentence: 'Y, son of X', kind: 'son of' },
  { sentence: 'X was married to Y', kind: 'spouse of', kindSource: 'married to' },
  { sentence: 'X sided with Y', kind: 'ally of', kindSource: 'sided with' },
  { sentence: 'X worked for Y', kind: 'operative for', kindSource: 'worked for' },
  { sentence: "X's best friend, Y", kind: 'friend of' },
];

for (const fixture of POSITIVE) {
  test(`still asserted: ${fixture.sentence}`, () => {
    assert.equal(classify(fixture.sentence, fixture.kind, fixture.kindSource), 'asserted');
    assert.equal(check(fixture.sentence, fixture.kind, fixture.kindSource), true);
  });
}

test('link-tailed readings anchor without being the head word', () => {
  assert.equal(check('X belongs to Y', 'member of', 'belongs to'), true);
  assert.equal(check('X is sworn to Y', 'member of', 'sworn to'), true);
  assert.equal(check('X sided with Y', 'ally of', 'sided with'), true);
  assert.equal(classify('X belongs to Y', 'member of', 'belongs to'), 'asserted');
});

test('a noun built on the role head still anchors', () => {
  assert.equal(check("X's partnership with Y endured.", 'partner'), true);
  assert.equal(classify("X's partnership with Y endured.", 'partner'), 'asserted');
});

/* --------------------------------------------------------------- negative */

const NEGATIVE: { sentence: string; kind: string }[] = [
  { sentence: 'X and Y joined Z', kind: 'member of' },
  { sentence: 'X and Y backed away', kind: 'ally of' },
  { sentence: 'X and Y kept looking at each other', kind: 'friend of' },
  { sentence: 'X and Y sat in the same row', kind: 'peer of' },
  { sentence: "X's sister and Y", kind: 'sister of' },
];

for (const fixture of NEGATIVE) {
  test(`no longer asserted: ${fixture.sentence}`, () => {
    assert.equal(check(fixture.sentence, fixture.kind), false);
    const cls = classify(fixture.sentence, fixture.kind);
    assert.ok(cls === 'scene' || cls === 'none', `expected scene/none, got ${cls}`);
    assert.notEqual(cls, 'asserted');
  });
}

test('bare action verbs never anchor a tie', () => {
  const verbs: { sentence: string; kind: string }[] = [
    { sentence: 'X joined Y', kind: 'member of' },
    { sentence: 'X backed Y', kind: 'ally of' },
    { sentence: 'X fought Y', kind: 'enemy of' },
    { sentence: 'X leads Y', kind: 'leader of' },
    { sentence: 'X taught Y', kind: 'teacher of' },
    { sentence: 'X bore Y', kind: 'mother of' },
    { sentence: 'X counseled Y', kind: 'mentor of' },
  ];
  for (const fixture of verbs) {
    assert.equal(check(fixture.sentence, fixture.kind), false, fixture.sentence);
    assert.equal(classify(fixture.sentence, fixture.kind), 'none', fixture.sentence);
  }
});

test('a coordinated list is a scene even with the head word present', () => {
  assert.equal(check('X and Y are friends', 'friend of'), false);
  assert.equal(classify('X and Y are friends', 'friend of'), 'scene');
});

/* ---------------------------------------------------------- classification */

test('neither assertion nor scene is none', () => {
  assert.equal(classify('X walked past the gate.', 'ally of'), 'none');
  assert.equal(classify('The gate was closed.', 'ally of'), 'none');
});

test('an anchor inside an endpoint name proves nothing', () => {
  // "aunt" belongs to "Aunt Petunia" here; it says nothing about Mara.
  assert.equal(
    assertsRelationship('Mara asked Aunt Petunia for the key.', 'Aunt Petunia', ['Aunt Petunia'], 'Mara', [], 'aunt of'),
    false,
  );
  assert.equal(
    classifyEvidence('Mara asked Aunt Petunia for the key.', 'Aunt Petunia', ['Aunt Petunia'], 'Mara', [], 'aunt of'),
    'none',
  );
  // The same word outside the name still asserts.
  assert.equal(assertsRelationship("Mara's aunt, Petunia, waited.", 'Petunia', [], 'Mara', [], 'aunt of'), true);
  assert.equal(assertsRelationship('Petunia was the aunt of Mara.', 'Petunia', [], 'Mara', [], 'aunt of'), true);
  assert.equal(assertsRelationship("Petunia, Mara's aunt, waited.", 'Petunia', [], 'Mara', [], 'aunt of'), true);
});

test('a bare partner needs a qualifier', () => {
  assert.equal(assertsRelationship("Mara's partner was Tor.", 'Mara', [], 'Tor', [], 'partner'), false);
  assert.equal(classifyEvidence("Mara's partner was Tor.", 'Mara', [], 'Tor', [], 'partner'), 'scene');
  assert.equal(
    assertsRelationship("Mara's business partner, Tor, arrived.", 'Mara', [], 'Tor', [], 'partner'),
    true,
  );
  assert.equal(
    assertsRelationship("Mara's alchemy partner, Tor, arrived.", 'Mara', [], 'Tor', [], 'partner'),
    true,
  );
  assert.equal(
    assertsRelationship("Mara's partner in crime, Tor, arrived.", 'Mara', [], 'Tor', [], 'partner'),
    true,
  );
  assert.equal(assertsRelationship('Mara was a partner with Tor.', 'Mara', [], 'Tor', [], 'partner'), true);
  // A different word of the same kind is untouched.
  assert.equal(assertsRelationship("Mara's partnership with Tor endured.", 'Mara', [], 'Tor', [], 'partner'), true);
});

test('assertsRelationship is exactly the asserted classification', () => {
  const sentences: { sentence: string; kind: string; kindSource?: string }[] = [
    ...POSITIVE,
    ...NEGATIVE,
    { sentence: 'X walked past the gate.', kind: 'ally of' },
  ];
  for (const fixture of sentences) {
    const cls = classify(fixture.sentence, fixture.kind, fixture.kindSource);
    assert.equal(
      check(fixture.sentence, fixture.kind, fixture.kindSource),
      cls === 'asserted',
      fixture.sentence,
    );
  }
});

test('the derived-variant path still classifies as asserted', () => {
  const index = buildRosterIndex(
    [
      { name: 'Aunt Petunia Dursley', aliases: [] },
      { name: 'Lily Potter', aliases: [] },
    ],
    '',
  );
  const quote = 'Petunia was the sister of Lily.';
  assert.equal(
    classifyEvidence(quote, 'Aunt Petunia Dursley', [], 'Lily Potter', [], 'sister of'),
    'none',
  );
  assert.equal(
    classifyEvidence(quote, 'Aunt Petunia Dursley', [], 'Lily Potter', [], 'sister of', '', index),
    'asserted',
  );
});
