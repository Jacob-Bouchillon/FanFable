/**
 * Claim confidence: the model assesses; code checks the quote, the roster and
 * identity, then applies the author's threshold. Generic names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function setup(name: string, text: string, settings: Record<string, unknown> = {}) {
  const { db } = tempDb();
  const project = controller.createProject(db, name, settings);
  const sourceId = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      project.id,
      '/confidence',
      'Probe',
      'sha-confidence',
      AT,
    ).lastInsertRowid,
  );
  const chunkId = Number(
    db.run(
      'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sourceId,
      project.id,
      1,
      'p. 1',
      '',
      text,
      text.split(/\s+/).length,
    ).lastInsertRowid,
  );
  for (const name of ['Mara', 'Tor']) {
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, 'character', ?, '[]', '', '', 2, '', '[]', 'accepted', ?, ?)`,
      project.id,
      name,
      AT,
      AT,
    );
  }
  return { db, project, chunkId };
}

function relation(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    from: 'Mara',
    to: 'Tor',
    kind: 'friend of',
    kind_source: 'friend',
    description: '',
    chunk_index: 0,
    evidence: 'Mara was a friend of Tor.',
    strength: 0.9,
    asserted: true,
    names_both: true,
    other_person: 'named',
    hedge: 'certain', kind_fit: 'yes',
    why: 'the sentence says so',
    ...overrides,
  };
}

function extractionMock(row: Record<string, unknown>) {
  return mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [row] });
    return JSON.stringify({ entities: [], facts: [], timeline: [], relations: [] });
  });
}

async function extract(name: string, text: string, row: Record<string, unknown>, settings: Record<string, unknown> = {}) {
  const { db, project, chunkId } = setup(name, text, settings);
  await lorebook.extractLore(db, extractionMock(row) as never, project.id, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
  } as never);
  return { db, project, chunkId };
}

test('a fabricated quote is never banked, whatever the confidence', async () => {
  const { db, project } = await extract(
    'confidence-fabricated',
    'Mara was a friend of Tor.',
    relation({ evidence: 'Zara was a friend of Quill.', strength: 1 }),
  );
  const rows = db.all<{ id: number }>('SELECT id FROM canon_relation WHERE project_id = ?', project.id);
  assert.deepEqual(rows, []);
  const note = db.get<{ reason: string }>('SELECT reason FROM canon_tie_note WHERE project_id = ?', project.id);
  assert.equal(note?.reason, 'unsupported-citation');
  db.close();
});

test('a pronoun-bound claim with a verbatim anchor banks and stores the anchor', async () => {
  const text = 'She feared him. Mara was afraid of Tor.';
  const { db, project } = await extract(
    'confidence-anchor',
    text,
    relation({
      kind: 'feared',
      kind_source: 'feared',
      evidence: 'She feared him.',
      anchor: 'Mara was afraid of Tor.',
      strength: 0.9,
      asserted: true,
      names_both: false,
      other_person: 'pronoun',
      hedge: 'certain', kind_fit: 'yes',
      why: 'the pronoun resolves to Mara in the next sentence',
    }),
  );
  const row = db.get<{
    review_status: string;
    confidence: number;
    anchor_evidence: string;
    supporting_evidence: string;
  }>('SELECT review_status, confidence, anchor_evidence, supporting_evidence FROM canon_relation WHERE project_id = ?', project.id)!;
  assert.equal(row.review_status, 'accepted');
  assert.equal(row.confidence, 0.9);
  assert.equal(row.anchor_evidence, 'Mara was afraid of Tor.');
  const supporting = JSON.parse(row.supporting_evidence) as { assessment: Record<string, unknown> }[];
  assert.equal(supporting[0]!.assessment.other_person, 'pronoun');
  assert.equal(supporting[0]!.assessment.hedge, 'certain');
  assert.equal(supporting[0]!.assessment.strength, 0.9);
  assert.equal(supporting[0]!.assessment.why, 'the pronoun resolves to Mara in the next sentence');
  db.close();
});

test('the same claim below the threshold stays provisional with its score', async () => {
  const { db, project } = await extract(
    'confidence-low',
    'Mara was a friend of Tor.',
    relation({ strength: 0.4 }),
  );
  const row = db.get<{ review_status: string; confidence: number }>(
    'SELECT review_status, confidence FROM canon_relation WHERE project_id = ?',
    project.id,
  )!;
  assert.equal(row.review_status, 'provisional');
  assert.equal(row.confidence, 0.4);
  db.close();
});

test('a user_confirmed row is unaffected by a low-confidence merge', async () => {
  const { db, project, chunkId } = await extract(
    'confidence-confirmed',
    'Mara was a friend of Tor.',
    relation({ strength: 0.1 }),
  );
  const row = db.get<{ id: number }>('SELECT id FROM canon_relation WHERE project_id = ?', project.id)!;
  db.run("UPDATE canon_relation SET review_status = 'user_confirmed', confirmed_by_user = 1 WHERE id = ?", row.id);
  // Re-run the same claim; the merge must not lower the author's tier.
  db.run('UPDATE canon_chunk SET lore_mined = 0 WHERE project_id = ?', project.id);
  await lorebook.extractLore(db, extractionMock(relationRow(0.1)) as never, project.id, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
  } as never);
  const merged = db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', row.id)!;
  assert.equal(merged.review_status, 'user_confirmed');
  assert.ok(chunkId > 0);
  db.close();
});

function relationRow(strength: number): Record<string, unknown> {
  return relation({ strength });
}

test('a quote that hides a preceding "perhaps" is refused', async () => {
  const { db, project } = await extract(
    'confidence-hedge',
    'Perhaps Mara feared Tor, though she never admitted it.',
    relation({
      kind: 'feared',
      kind_source: 'feared',
      evidence: 'Mara feared Tor',
      strength: 0.95,
      asserted: true,
      names_both: true,
      other_person: 'named',
      hedge: 'certain', kind_fit: 'yes',
    }),
  );
  const rows = db.all<{ id: number }>('SELECT id FROM canon_relation WHERE project_id = ?', project.id);
  assert.deepEqual(rows, []);
  const note = db.get<{ reason: string }>('SELECT reason FROM canon_tie_note WHERE project_id = ?', project.id);
  assert.equal(note?.reason, 'unsupported-citation');
  db.close();
});

test('no assertion-pattern rule can veto a claim that clears the threshold', async () => {
  const { db, project } = await extract(
    'confidence-grammar',
    'Mara and Tor came in together.',
    relation({ evidence: 'Mara and Tor came in together.', strength: 0.9 }),
  );
  const row = db.get<{ review_status: string; confidence: number }>(
    'SELECT review_status, confidence FROM canon_relation WHERE project_id = ?',
    project.id,
  )!;
  assert.equal(row.review_status, 'accepted', 'co-occurrence shape is not a veto');
  assert.equal(row.confidence, 0.9);
  db.close();
});

test('the project setting moves the threshold', async () => {
  const low = await extract('confidence-setting-low', 'Mara was a friend of Tor.', relation({ strength: 0.6 }), {
    minConfidence: 0.5,
  });
  const lowRow = low.db.get<{ review_status: string }>(
    'SELECT review_status FROM canon_relation WHERE project_id = ?',
    low.project.id,
  )!;
  assert.equal(lowRow.review_status, 'accepted');
  low.db.close();

  const high = await extract('confidence-setting-high', 'Mara was a friend of Tor.', relation({ strength: 0.6 }), {
    minConfidence: 0.8,
  });
  const highRow = high.db.get<{ review_status: string }>(
    'SELECT review_status FROM canon_relation WHERE project_id = ?',
    high.project.id,
  )!;
  assert.equal(highRow.review_status, 'provisional');
  high.db.close();
});
