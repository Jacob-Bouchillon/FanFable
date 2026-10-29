/**
 * The promotion guard is mechanical: quote in the source, both roster
 * entities, not the same person, the author's PARK, and the confidence
 * threshold. Grammar, concept membership and direction are not verdicts.
 *
 * The old adjudication fixtures are kept as data: they now pass the mechanical
 * guard, which is the point of the claim-confidence change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function setup(
  fromName: string,
  toName: string,
  prior?: { evidence: string; ruling: string; kind?: string },
) {
  const { db } = tempDb();
  const project = controller.createProject(db, `promote-${fromName}-${toName}`.slice(0, 60));
  const fromId = Number(db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id,
    'character',
    fromName,
    '[]',
    AT,
    AT,
  ).lastInsertRowid);
  const toId = Number(db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id,
    'character',
    toName,
    '[]',
    AT,
    AT,
  ).lastInsertRowid);
  if (prior) {
    db.run(
      `INSERT INTO canon_tie_note
         (project_id, from_entity, to_entity, attempted_kind, reason, evidence, source_refs, status, ruling, ruled_at, created_at)
       VALUES (?, ?, ?, ?, 'evaluation', ?, '[]', 'resolved', ?, ?, ?)`,
      project.id,
      fromId,
      toId,
      prior.kind ?? '',
      prior.evidence,
      prior.ruling,
      AT,
      AT,
    );
  }
  return { db, project, fromId, toId };
}

interface Fixture {
  from: string;
  to: string;
  kind: string;
  evidence: string;
  confidence?: number;
  prior?: { evidence: string; ruling: string; kind?: string };
}

function decide(fixture: Fixture, chunkText = fixture.evidence) {
  const { db, project, fromId, toId } = setup(fixture.from, fixture.to, fixture.prior);
  const decision = lorebook.canPromote(
    {
      fromId,
      toId,
      fromName: fixture.from,
      toName: fixture.to,
      kind: fixture.kind,
      evidence: fixture.evidence,
      confidence: fixture.confidence,
    },
    { db, projectId: project.id, chunkText },
  );
  db.close();
  return decision;
}

const RULED_PARK = 'PARK (user: he only had 1; 2026-10-27)';

const OLD_REFUSALS: Fixture[] = [
  {
    from: 'Maa Kaap', to: 'Doo Zuto', kind: 'appears_with',
    evidence: 'love the work, or perhaps be on the run—from the law, yourself, or whoever else.',
  },
  {
    from: 'Alderaanian Senator Bail Antilles', to: 'Senator Eelen Li', kind: 'appears_with',
    evidence: 'Servants hurried over to take Valorum’s and Taria’s veda cloth cloaks.',
  },
  {
    from: 'Darth Plagueis', to: 'Palpatine', kind: 'contacting',
    evidence: 'No. The young human—Palpatine. A deep-space transmission.',
  },
  {
    from: 'Ronhar Kim', to: 'Jedi Knights', kind: 'family of',
    evidence: 'But that he considers the Temple to be his home and the Jedi to be his family.',
  },
  {
    from: 'Darth Plagueis', to: 'Darth Sidious', kind: 'challenged',
    evidence: 'This being who had survived assassinations and killed countless opponents merely gazed at Sidious, until it struck him that Plagueis was challenging him!',
  },
];

for (const fixture of OLD_REFUSALS) {
  test(`no longer refuses ${fixture.kind}: ${fixture.from} / ${fixture.to}`, () => {
    assert.deepEqual(decide(fixture), { ok: true });
  });
}

test('a PARK binds a different quote for the same pair and kind', () => {
  const decision = decide({
    from: 'Darth Plagueis', to: 'Darth Venamis', kind: 'master of',
    evidence: 'Plagueis had been instructed to be on the lookout for suitable beings.',
    prior: {
      evidence: 'A completely different sentence from the one offered now.',
      ruling: RULED_PARK,
      kind: 'master of',
    },
  });
  assert.deepEqual(decision, { ok: false, reason: 'ruled-park' });
});

test('a PARK binds the inverse kind for the same pair', () => {
  const decision = decide({
    from: 'Darth Plagueis', to: 'Darth Venamis', kind: 'master of',
    evidence: 'Plagueis had been instructed to be on the lookout for suitable beings.',
    prior: {
      evidence: 'A completely different sentence from the one offered now.',
      ruling: RULED_PARK,
      kind: 'apprentice of',
    },
  });
  assert.deepEqual(decision, { ok: false, reason: 'ruled-park' });
});

test('a PARK on an unrelated kind does not block the pair', () => {
  const { db, project, fromId, toId } = setup('Asha', 'Bram', {
    evidence: 'They were enemies.',
    ruling: RULED_PARK,
    kind: 'enemy of',
  });
  const quote = "Asha is Bram's master.";
  const decision = lorebook.canPromote(
    { fromId, toId, fromName: 'Asha', toName: 'Bram', kind: 'master of', evidence: quote },
    { db, projectId: project.id, chunkText: quote },
  );
  assert.deepEqual(decision, { ok: true });
  db.close();
});

test('a closed-kind, quote-verified, unruled pair passes', () => {
  const decision = decide({
    from: 'Asha', to: 'Bram', kind: 'sister of', evidence: "Asha is Bram's sister.",
  });
  assert.deepEqual(decision, { ok: true });
});

test('direction is not judged', () => {
  const { db, project, fromId, toId } = setup('Bram', 'Asha');
  const quote = "Asha is Bram's sister.";
  const decision = lorebook.canPromote(
    { fromId, toId, fromName: 'Bram', toName: 'Asha', kind: 'sister of', evidence: quote },
    { db, projectId: project.id, chunkText: quote },
  );
  assert.deepEqual(decision, { ok: true });
  db.close();
});

test('the guard refuses a quote that is not in the cited chunk, whatever the score', () => {
  const decision = decide({
    from: 'Asha', to: 'Bram', kind: 'sister of', evidence: "Asha is Bram's sister.", confidence: 1,
  }, 'Asha waited by the gate.');
  assert.deepEqual(decision, { ok: false, reason: 'quote-not-verbatim' });
});

test('one endpoint in the quote is not a promotion requirement', () => {
  const decision = decide({
    from: 'Asha', to: 'Bram', kind: 'sister of', evidence: 'Asha waited by the gate.',
  });
  assert.deepEqual(decision, { ok: true });
});

test('a missing tie word is not a promotion requirement', () => {
  const decision = decide({
    from: 'Asha', to: 'Bram', kind: 'apprentice of', evidence: "Asha and Bram's lanterns met at the gate.",
  });
  assert.deepEqual(decision, { ok: true });
});

test('a moment label is not a guard veto', () => {
  const decision = decide({
    from: 'Asha', to: 'Bram', kind: 'met', evidence: 'Asha met Bram at the gate.',
  });
  assert.deepEqual(decision, { ok: true });
});

test('a claim below the threshold stays provisional', () => {
  const decision = decide({
    from: 'Asha', to: 'Bram', kind: 'friend of', evidence: 'Asha and Bram came in together.', confidence: 0.6,
  });
  assert.deepEqual(decision, { ok: false, reason: 'below-threshold' });
});

test('a claim at or above the threshold passes', () => {
  const decision = decide({
    from: 'Asha', to: 'Bram', kind: 'friend of', evidence: 'Asha and Bram came in together.', confidence: 0.7,
  });
  assert.deepEqual(decision, { ok: true });
});

test('a label outside the concept set can bank but stays unqueryable as a concept', () => {
  const decision = decide({
    from: 'Asha', to: 'Bram', kind: 'contacting', evidence: 'Asha contacted Bram by radio.', confidence: 0.9,
  });
  assert.deepEqual(decision, { ok: true });
  assert.equal(lorebook.isClosedRoleKind('contacting'), false);
});

test('an entity outside the roster is refused', () => {
  const { db, project } = setup('Asha', 'Bram');
  const decision = lorebook.canPromote(
    { fromId: 9991, toId: 9992, fromName: 'Asha', toName: 'Bram', kind: 'friend of', evidence: 'Asha met Bram.', confidence: 1 },
    { db, projectId: project.id, chunkText: 'Asha met Bram.' },
  );
  assert.deepEqual(decision, { ok: false, reason: 'endpoint-unnamed' });
  db.close();
});
