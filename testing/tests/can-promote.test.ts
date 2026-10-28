/**
 * The one promotion guard: closed relationship-grade kinds, no resolved PARK
 * ruling for the same evidence, and a verbatim both-endpoints quote whose
 * direction the sentence states.
 *
 * The seven refusal fixtures are the adjudication rows, passed as data; no
 * bank is read. Positive and rule-reason controls use invented names.
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
  const fromId = db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id,
    'character',
    fromName,
    '[]',
    AT,
    AT,
  ).lastInsertRowid;
  const toId = db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id,
    'character',
    toName,
    '[]',
    AT,
    AT,
  ).lastInsertRowid;
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

function decide(
  fixture: { from: string; to: string; kind: string; evidence: string; prior?: { evidence: string; ruling: string; kind?: string } },
  chunkText = fixture.evidence,
) {
  const { db, project, fromId, toId } = setup(fixture.from, fixture.to, fixture.prior);
  const decision = lorebook.canPromote(
    {
      fromId,
      toId,
      fromName: fixture.from,
      toName: fixture.to,
      kind: fixture.kind,
      evidence: fixture.evidence,
    },
    { db, projectId: project.id, chunkText },
  );
  db.close();
  return decision;
}

const RULED_PARK = 'PARK (user: he only had 1; 2026-10-27)';

const FIXTURES = [
  {
    name: 'coverage row',
    from: 'Maa Kaap',
    to: 'Doo Zuto',
    kind: 'appears_with',
    evidence: 'love the work, or perhaps be on the run—from the law, yourself, or whoever else.',
    reason: 'coverage-only' as const,
  },
  {
    name: 'coverage row, second pair',
    from: 'Alderaanian Senator Bail Antilles',
    to: 'Senator Eelen Li',
    kind: 'appears_with',
    evidence: 'Servants hurried over to take Valorum’s and Taria’s veda cloth cloaks.',
    reason: 'coverage-only' as const,
  },
  {
    name: 'resolved PARK, master direction',
    from: 'Darth Plagueis',
    to: 'Darth Venamis',
    kind: 'master of',
    evidence: 'Plagueis had been instructed to be on the lookout for suitable beings, just as Tenebrous had been when he had discovered Venamis.',
    prior: {
      evidence: 'Plagueis had been instructed to be on the lookout for suitable beings, just as Tenebrous had been when he had discovered Venamis.',
      ruling: RULED_PARK,
      kind: 'master of',
    },
    reason: 'ruled-park' as const,
  },
  {
    name: 'resolved PARK, apprentice direction',
    from: 'Darth Venamis',
    to: 'Darth Plagueis',
    kind: 'apprentice of',
    evidence: 'I accept that I must apprentice myself to you.',
    prior: { evidence: 'I accept that I must apprentice myself to you.', ruling: RULED_PARK, kind: 'apprentice of' },
    reason: 'ruled-park' as const,
  },
  {
    name: 'open vocabulary, contacting',
    from: 'Darth Plagueis',
    to: 'Palpatine',
    kind: 'contacting',
    evidence: 'No. The young human—Palpatine. A deep-space transmission.',
    reason: 'open-vocab' as const,
  },
  {
    name: 'open vocabulary, family',
    from: 'Ronhar Kim',
    to: 'Jedi Knights',
    kind: 'family of',
    evidence: 'But that he considers the Temple to be his home and the Jedi to be his family.',
    reason: 'open-vocab' as const,
  },
  {
    name: 'open vocabulary, challenged',
    from: 'Darth Plagueis',
    to: 'Darth Sidious',
    kind: 'challenged',
    evidence: 'This being who had survived assassinations and killed countless opponents merely gazed at Sidious, until it struck him that Plagueis was challenging him!',
    reason: 'open-vocab' as const,
  },
];

for (const fixture of FIXTURES) {
  test(`refuses ${fixture.name} with ${fixture.reason}`, () => {
    const decision = decide(fixture);
    assert.deepEqual(decision, { ok: false, reason: fixture.reason });
  });
}

test('a PARK binds a different quote for the same pair and kind', () => {
  const decision = decide({
    from: 'Darth Plagueis',
    to: 'Darth Venamis',
    kind: 'master of',
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
    from: 'Darth Plagueis',
    to: 'Darth Venamis',
    kind: 'master of',
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
    from: 'Asha',
    to: 'Bram',
    kind: 'sister of',
    evidence: "Asha is Bram's sister.",
  });
  assert.deepEqual(decision, { ok: true });
});

test('the guard refuses a reversed sentence', () => {
  const { db, project, fromId, toId } = setup('Bram', 'Asha');
  const quote = "Asha is Bram's sister.";
  const decision = lorebook.canPromote(
    { fromId, toId, fromName: 'Bram', toName: 'Asha', kind: 'sister of', evidence: quote },
    { db, projectId: project.id, chunkText: quote },
  );
  assert.deepEqual(decision, { ok: false, reason: 'direction-mismatch' });
  db.close();
});

test('the guard refuses a quote that is not in the cited chunk', () => {
  const decision = decide({
    from: 'Asha',
    to: 'Bram',
    kind: 'sister of',
    evidence: "Asha is Bram's sister.",
  }, 'Asha waited by the gate.');
  assert.deepEqual(decision, { ok: false, reason: 'quote-not-verbatim' });
});

test('the guard refuses a quote naming one endpoint', () => {
  const decision = decide({
    from: 'Asha',
    to: 'Bram',
    kind: 'sister of',
    evidence: 'Asha waited by the gate.',
  });
  assert.deepEqual(decision, { ok: false, reason: 'endpoint-unnamed' });
});

test('the guard refuses a quote that never speaks the tie word', () => {
  const decision = decide({
    from: 'Asha',
    to: 'Bram',
    kind: 'apprentice of',
    evidence: "Asha and Bram's lanterns met at the gate.",
  });
  assert.deepEqual(decision, { ok: false, reason: 'tie-word-absent' });
});

test('the guard refuses a moment kind', () => {
  const decision = decide({
    from: 'Asha',
    to: 'Bram',
    kind: 'met',
    evidence: 'Asha met Bram at the gate.',
  });
  assert.deepEqual(decision, { ok: false, reason: 'moment' });
});
