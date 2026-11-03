/**
 * Dialogue attribution regressions. A speaker and addressee come from an
 * explicit tag or an action beat plus the quote's own vocative. Alternating
 * speakers, proximity, an intervening quote, a shared alias and an ambiguous
 * tag all fail closed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { buildRosterIndex } from '../../fanfable/src/identity/names.ts';

function decide(
  row: {
    fromName: string; toName: string; fromAliases?: string[]; toAliases?: string[];
    kind: string; evidence: string; anchorEvidence?: string;
  },
  chunkText: string,
  index?: ReturnType<typeof buildRosterIndex>,
) {
  return lorebook.provenRelation(
    { fromId: 1, toId: 2, confidence: 1, ...row },
    { chunkText, index, minConfidence: 0 },
  );
}

test('an explicit tag before the quote supplies the speaker and addressee', () => {
  const chunk =
    '“Thank you for coming on such short notice, Palpatine,” Kim said in a rush, ushering him into an office. ' +
    'Tall windows overlooked the palace. ' +
    '“What I have to say will place you at some risk, but there’s no one I trust more than you.”';
  assert.deepEqual(
    decide(
      {
        fromName: 'Ronhar Kim', fromAliases: ['Kim'], toName: 'Palpatine',
        kind: 'ally of',
        evidence: 'What I have to say will place you at some risk, but there’s no one I trust more than you.',
      },
      chunk,
    ),
    { ok: true },
  );
});

test('an action beat and the quote vocative supply a symmetric tie', () => {
  assert.deepEqual(
    decide(
      {
        fromName: 'Mara', toName: 'Tor', kind: 'friend of',
        evidence: 'Tor, I trust you.',
      },
      'Mara stepped forward. “Tor, I trust you.”',
    ),
    { ok: true },
  );
});

test('an action beat and the quote vocative preserve asymmetric direction', () => {
  assert.deepEqual(
    decide(
      {
        fromName: 'Mara', toName: 'Tor', kind: 'master of',
        evidence: 'Tor, I am your master.',
      },
      'Mara stepped forward. “Tor, I am your master.”',
    ),
    { ok: true },
  );
});

test('the same dialogue with reversed endpoints is refused', () => {
  assert.deepEqual(
    decide(
      {
        fromName: 'Tor', toName: 'Mara', kind: 'master of',
        evidence: 'Tor, I am your master.',
      },
      'Mara stepped forward. “Tor, I am your master.”',
    ),
    { ok: false, reason: 'direction-mismatch' },
  );
});

test('a wrong addressee in the quote fails closed', () => {
  assert.deepEqual(
    decide(
      {
        fromName: 'Mara', toName: 'Tor', kind: 'friend of',
        evidence: 'Asha, I trust you.',
      },
      'Mara stepped forward. “Asha, I trust you.”',
    ),
    { ok: false, reason: 'endpoint-unnamed' },
  );
});

test('an incorrect speaker identity fails closed', () => {
  assert.deepEqual(
    decide(
      {
        fromName: 'Mara', toName: 'Tor', kind: 'friend of',
        evidence: 'I trust you.',
      },
      'Asha said to Tor. “I trust you.”',
    ),
    { ok: false, reason: 'endpoint-unnamed' },
  );
});

test('two speakers in the same tag are ambiguous and fail closed', () => {
  assert.deepEqual(
    decide(
      {
        fromName: 'Mara', toName: 'Tor', kind: 'friend of',
        evidence: 'We trust each other.',
      },
      'Mara said; Tor said; “We trust each other.”',
    ),
    { ok: false, reason: 'endpoint-unnamed' },
  );
});

test('a tag whose speaker alias is shared by two rows fails closed', () => {
  const index = buildRosterIndex(
    [
      { name: 'Ronhar Kim', aliases: ['Kim'] },
      { name: 'Senator Vidar Kim', aliases: ['Vidar Kim', 'Kim'] },
      { name: 'Palpatine', aliases: [] },
    ],
    'Kim',
  );
  const chunk =
    '“Thank you for coming on such short notice, Palpatine,” Kim said in a rush. ' +
    '“What I have to say will place you at some risk, but there’s no one I trust more than you.”';
  assert.deepEqual(
    decide(
      {
        fromName: 'Ronhar Kim', fromAliases: ['Kim'], toName: 'Palpatine',
        kind: 'ally of',
        evidence: 'What I have to say will place you at some risk, but there’s no one I trust more than you.',
      },
      chunk,
      index,
    ),
    { ok: false, reason: 'endpoint-unnamed' },
  );
});

test('an action beat needs a vocative addressee; proximity is not enough', () => {
  assert.deepEqual(
    decide(
      {
        fromName: '11-4D', toName: 'Darth Plagueis',
        toAliases: ['Magister Damask', 'Plagueis'],
        kind: 'aide of', evidence: 'I can be of service.',
      },
      '11-4D walked stiffly across the room. “I can be of service.”',
    ),
    { ok: false, reason: 'endpoint-unnamed' },
  );
});

test('a tag beyond another speaker’s quote is not used', () => {
  const chunk =
    '“The group will not be re-formed. And I will tutor San Hill personally.” ' +
    '“Why do we need them?” ' +
    'In a harsh whisper, Plagueis said, “Because war is now on the agenda.”';
  assert.deepEqual(
    decide(
      {
        fromName: 'Darth Plagueis', fromAliases: ['Plagueis'],
        toName: 'San Hill', toAliases: ['San'],
        kind: 'master of', evidence: 'And I will tutor San Hill personally.',
      },
      chunk,
    ),
    { ok: false, reason: 'endpoint-unnamed' },
  );
});
