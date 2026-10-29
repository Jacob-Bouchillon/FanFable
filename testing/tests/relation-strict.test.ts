/**
 * Strict relations mode: closed kinds, both-names quotes, one bounded retry.
 * Invented names and prose only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
const PASSAGE = "Asha is Bram's sister. Asha waited by the gate.";

function setup() {
  const { db } = tempDb();
  const project = controller.createProject(db, 'relation-strict');
  const sourceId = db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    project.id,
    '/probe-source',
    'Probe',
    'sha-probe',
    AT,
  ).lastInsertRowid;
  db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId,
    project.id,
    1,
    'p. 1',
    '',
    PASSAGE,
    PASSAGE.split(/\s+/).length,
  );
  return { db, project };
}

function entity(name: string) {
  return {
    kind: 'character',
    name,
    aliases: [],
    summary: '',
    attributes: {},
    role: '',
    status: '',
    chunk_index: 0,
    evidence: "Asha is Bram's sister.",
  };
}

function relation(evidence: string, kind = 'sister of') {
  return {
    from: 'Asha',
    to: 'Bram',
    kind,
    kind_source: 'sister',
    description: '',
    chunk_index: 0,
    evidence,
    strength: 0.9,
    asserted: true,
    names_both: true,
    other_person: 'named',
    hedge: 'certain', kind_fit: 'yes',
  };
}

async function withStrict<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.env.FANFABLE_REL_STRICT;
  process.env.FANFABLE_REL_STRICT = '1';
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.FANFABLE_REL_STRICT;
    else process.env.FANFABLE_REL_STRICT = before;
  }
}

function mock(relations: unknown[], retryReply: string, counter = { retries: 0 }) {
  return mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('You repair one relationship quote')) {
      counter.retries++;
      return retryReply;
    }
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations });
    if (system.includes('"entities"')) return JSON.stringify({ entities: [entity('Asha'), entity('Bram')], facts: [] });
    if (system.includes('timeline')) return JSON.stringify({ timeline: [] });
    return '{}';
  });
}

test('the strict prompt is opt-in and its kind mapping prefers closed kinds', () => {
  const before = process.env.FANFABLE_REL_STRICT;
  const fewshot = process.env.FANFABLE_REL_FEWSHOT;
  try {
    delete process.env.FANFABLE_REL_STRICT;
    delete process.env.FANFABLE_REL_FEWSHOT;
    // Flag off: the historical prompt plus the always-on kind glossary.
    const plain = lorebook.relationsSystemPrompt();
    assert.ok(plain.startsWith(lorebook.EXTRACT_RELATIONS_SYSTEM));
    assert.ok(!plain.includes('Strict mode:'));

    process.env.FANFABLE_REL_STRICT = '1';
    const strict = lorebook.relationsSystemPrompt();
    assert.ok(strict.startsWith(lorebook.EXTRACT_RELATIONS_SYSTEM));
    assert.ok(strict.includes('Strict mode:'));
    assert.ok(strict.includes('Choose the closest allowed kind'));
    assert.ok(strict.includes('ONE contiguous sentence'));
  } finally {
    if (before === undefined) delete process.env.FANFABLE_REL_STRICT;
    else process.env.FANFABLE_REL_STRICT = before;
    if (fewshot === undefined) delete process.env.FANFABLE_REL_FEWSHOT;
    else process.env.FANFABLE_REL_FEWSHOT = fewshot;
  }

  assert.equal(lorebook.strictRelationKind('sister of'), 'sister of');
  assert.equal(lorebook.strictRelationKind('bodyguard of'), 'bodyguard of');
  assert.equal(lorebook.strictRelationKind('bodyguard of; ally of'), 'ally of');
  assert.equal(lorebook.strictRelationKind('advisor of | ally of'), 'ally of');
});

test('one retry repairs a partly named quote and the relation banks accepted', async () => {
  const { db, project } = setup();
  const counter = { retries: 0 };
  const llm = mock([relation('Asha waited by the gate.')], JSON.stringify({ quote: "Asha is Bram's sister." }), counter);
  const stats = await withStrict(() =>
    lorebook.extractLore(db, llm as never, project.id, { windowSize: 8, concurrency: 1, maxWindows: 1 } as never),
  );
  assert.equal(counter.retries, 1);
  assert.equal(stats.verification.retried, 1);
  assert.equal(stats.verification.retriedFixed, 1);
  assert.equal(stats.verification.retriedFailed, 0);
  const row = db.get<{ evidence: string; review_status: string }>(
    "SELECT evidence, review_status FROM canon_relation WHERE project_id = ? AND kind = 'sister of'",
    project.id,
  )!;
  assert.equal(row.evidence, "Asha is Bram's sister.");
  assert.equal(row.review_status, 'accepted');
  db.close();
});

test('a failed retry leaves the original quote, which can bank on its own', async () => {
  const { db, project } = setup();
  const counter = { retries: 0 };
  const llm = mock([relation('Asha waited by the gate.')], JSON.stringify({ quote: 'Bram is Asha brother.' }), counter);
  const stats = await withStrict(() =>
    lorebook.extractLore(db, llm as never, project.id, { windowSize: 8, concurrency: 1, maxWindows: 1 } as never),
  );
  assert.equal(counter.retries, 1);
  assert.equal(stats.verification.retried, 1);
  assert.equal(stats.verification.retriedFixed, 0);
  assert.equal(stats.verification.retriedFailed, 1);
  const row = db.get<{ evidence: string; review_status: string }>(
    "SELECT evidence, review_status FROM canon_relation WHERE project_id = ? AND kind = 'sister of'",
    project.id,
  )!;
  assert.equal(row.evidence, 'Asha waited by the gate.');
  assert.equal(row.review_status, 'accepted', 'the original quote is verbatim and the model scored it; both names are no longer required');
  db.close();
});

test('retries stop at five per window', async () => {
  const { db, project } = setup();
  const counter = { retries: 0 };
  const llm = mock(
    Array.from({ length: 7 }, () => relation('Asha waited by the gate.')),
    JSON.stringify({ quote: 'NONE' }),
    counter,
  );
  const stats = await withStrict(() =>
    lorebook.extractLore(db, llm as never, project.id, { windowSize: 8, concurrency: 1, maxWindows: 1 } as never),
  );
  assert.equal(counter.retries, lorebook.MAX_RELATION_RETRIES_PER_WINDOW);
  assert.equal(stats.verification.retried, 5);
  assert.equal(stats.verification.retriedFailed, 5);
  db.close();
});

test('flag off makes no retry calls', async () => {
  const { db, project } = setup();
  const counter = { retries: 0 };
  const llm = mock([relation('Asha waited by the gate.')], JSON.stringify({ quote: "Asha is Bram's sister." }), counter);
  const stats = await lorebook.extractLore(db, llm as never, project.id, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
  } as never);
  assert.equal(counter.retries, 0);
  assert.equal(stats.verification.retried, 0);
  db.close();
});
