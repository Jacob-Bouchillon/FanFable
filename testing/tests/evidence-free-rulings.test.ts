/**
 * Evidence-free user confirmations, answer attribution and short-name
 * retrieval. Invented names only; no book data, one mock model call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { answerLoreQuestion } from '../../fanfable/src/answer/lore-ask.ts';
import type { Passage } from '../../fanfable/src/answer/lore.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

type Db = ReturnType<typeof tempDb>['db'];

function addEntity(db: Db, projectId: number, name: string, aliases: string[] = [], mentions = 1): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, 'character', ?, ?, '', '', ?, '', '[]', 'accepted', ?, ?)`,
      projectId,
      name,
      JSON.stringify(aliases),
      mentions,
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function addChunk(db: Db, projectId: number, text: string): number {
  const sourceId = db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    projectId,
    '/probe-source',
    'Probe',
    'sha-probe',
    AT,
  ).lastInsertRowid;
  return Number(
    db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sourceId,
      projectId,
      1,
      'p. 1',
      '',
      text,
      text.split(/\s+/).length,
    ).lastInsertRowid,
  );
}

function addRelation(
  db: Db,
  projectId: number,
  from: number,
  to: number,
  kind: string,
  opts: {
    status?: string;
    evidence?: string;
    sourceRefs?: string;
    confirmedByUser?: boolean;
  } = {},
): number {
  return Number(
    db.run(
      `INSERT INTO canon_relation
         (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
          confidence, review_status, confirmed_by_user, created_at)
       VALUES (?, ?, ?, ?, '', ?, ?, 1.0, ?, ?, ?)`,
      projectId,
      from,
      to,
      kind,
      opts.evidence ?? '',
      opts.sourceRefs ?? '[]',
      opts.status ?? 'user_confirmed',
      opts.confirmedByUser === false ? 0 : 1,
      AT,
    ).lastInsertRowid,
  );
}

function exportKeeper(
  fromName: string,
  toName: string,
  kind: string,
  reviewStatus: string,
  evidence = '',
): lorebook.RulingsExportKeeper {
  return {
    from_name: fromName,
    from_aliases: [],
    to_name: toName,
    to_aliases: [],
    kind,
    review_status: reviewStatus,
    evidence,
    locator: '',
    exported_at: AT,
  };
}

function payload(keepers: lorebook.RulingsExportKeeper[]): lorebook.RulingsExport {
  return {
    version: 1,
    counters: { project: 'probe', keepers: keepers.length, note_rulings: 0, identities: 0 },
    keepers,
    note_rulings: [],
    identities: [],
  };
}

function passage(text: string): Passage {
  return {
    chunkId: 1,
    sourceId: 1,
    sourceTitle: 'Probe',
    path: '/probe',
    locator: 'p. 1',
    heading: '',
    text,
    score: 0,
  };
}

/* ---------------------------------------------------------------- replay */

test('an evidence-free user confirmation inserts a new row', () => {
  const { db } = tempDb();
  const project = createProject(db, 'confirm-insert');
  addEntity(db, project.id, 'Asha');
  addEntity(db, project.id, 'Corin');
  const result = lorebook.replayRulings(
    db,
    project.id,
    payload([exportKeeper('Asha', 'Corin', 'friend of', 'user_confirmed')]),
    { write: true },
  );
  assert.equal(result.keepers.total, 1);
  assert.equal(result.keepers.resolved, 1);
  assert.equal(result.keepers.applied, 1);
  assert.equal(result.keepers.unresolved, 0);

  const row = db.get<{
    review_status: string;
    evidence: string;
    source_refs: string;
    confirmed_by_user: number;
  }>('SELECT review_status, evidence, source_refs, confirmed_by_user FROM canon_relation WHERE project_id = ?', project.id)!;
  assert.equal(row.review_status, 'user_confirmed');
  assert.equal(row.evidence, '');
  assert.equal(row.source_refs, '[]');
  assert.equal(row.confirmed_by_user, 1);
  db.close();
});

test('an existing row is still promoted to user_confirmed', () => {
  const { db } = tempDb();
  const project = createProject(db, 'confirm-promote');
  const asha = addEntity(db, project.id, 'Asha');
  const corin = addEntity(db, project.id, 'Corin');
  const relation = addRelation(db, project.id, asha, corin, 'friend of', {
    status: 'needs_review',
    evidence: 'not used by replay',
    sourceRefs: '[]',
    confirmedByUser: false,
  });
  const result = lorebook.replayRulings(
    db,
    project.id,
    payload([exportKeeper('Asha', 'Corin', 'friend of', 'user_confirmed')]),
    { write: true },
  );
  assert.equal(result.keepers.applied, 1);
  const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project.id)!;
  assert.equal(count.n, 1, 'no second row created');
  const row = db.get<{ review_status: string; confirmed_by_user: number }>(
    'SELECT review_status, confirmed_by_user FROM canon_relation WHERE id = ?',
    relation,
  )!;
  assert.equal(row.review_status, 'user_confirmed');
  assert.equal(row.confirmed_by_user, 1);
  db.close();
});

test('an evidence-free accepted entry is refused explicitly', () => {
  const { db } = tempDb();
  const project = createProject(db, 'confirm-accepted');
  addEntity(db, project.id, 'Asha');
  addEntity(db, project.id, 'Corin');
  const result = lorebook.replayRulings(
    db,
    project.id,
    payload([exportKeeper('Asha', 'Corin', 'friend of', 'accepted')]),
    { write: true },
  );
  assert.equal(result.keepers.resolved, 1);
  assert.equal(result.keepers.applied, 0);
  assert.equal(result.keepers.unresolved, 1);
  assert.deepEqual(result.issues.map((issue) => issue.reason), ['evidence-required']);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project.id)!.n, 0);
  db.close();
});

test('an accepted entry whose quote is not in the book is still refused', () => {
  const { db } = tempDb();
  const project = createProject(db, 'confirm-accepted-quote');
  addChunk(db, project.id, 'Asha counted the lantern before dawn.');
  addEntity(db, project.id, 'Asha');
  addEntity(db, project.id, 'Corin');
  const result = lorebook.replayRulings(
    db,
    project.id,
    payload([exportKeeper('Asha', 'Corin', 'friend of', 'accepted', 'This sentence is not in the book.')]),
    { write: true },
  );
  assert.equal(result.keepers.unresolved, 1);
  assert.deepEqual(result.issues.map((issue) => issue.reason), ['quote not found']);
  db.close();
});

/* ------------------------------------------------------------ attribution */

test('a user-confirmed tie is stated as such and carries no citation', async () => {
  const { db } = tempDb();
  const project = createProject(db, 'confirm-attribution');
  const asha = addEntity(db, project.id, 'Asha');
  const bram = addEntity(db, project.id, 'Bram');
  addRelation(db, project.id, asha, bram, 'friend of', {
    status: 'user_confirmed',
    evidence: '',
    sourceRefs: '[]',
    confirmedByUser: true,
  });
  const llm = mockProvider(() => {
    throw new Error('the model must not be called for a user confirmation');
  });
  const answer = await answerLoreQuestion(db, llm, project.id, 'status of Asha to Bram', {
    search: [passage('A passage that does not state the tie.')],
  });
  assert.match(answer.answer, /confirmed by the user/i);
  assert.match(answer.answer, /Asha — friend of Bram/);
  assert.equal(answer.passages.length, 0, 'no passage is presented as support');
  assert.ok(!/\[S\d+\]/.test(answer.answer), 'no passage citation');
  db.close();
});

test('an evidence-backed tie still cites its passage', async () => {
  const { db } = tempDb();
  const project = createProject(db, 'confirm-evidence');
  const asha = addEntity(db, project.id, 'Asha');
  const bram = addEntity(db, project.id, 'Bram');
  const text = 'Asha is the apprentice of Bram.';
  const chunk = addChunk(db, project.id, text);
  addRelation(db, project.id, asha, bram, 'apprentice of', {
    status: 'user_confirmed',
    evidence: text,
    sourceRefs: JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk }]),
    confirmedByUser: true,
  });
  const llm = mockProvider((req) =>
    (req.system ?? '').includes('Lore Researcher')
      ? 'CONFIRMED: Asha is the apprentice of Bram. [S1]'
      : '{"terms":[]}',
  );
  const answer = await answerLoreQuestion(db, llm, project.id, 'status of Asha to Bram', {
    search: [passage(text)],
  });
  assert.match(answer.answer, /\[S1\]/);
  assert.equal(answer.passages.length, 1);
  assert.ok(!/confirmed by the user/i.test(answer.answer), 'not described as a user confirmation');
  db.close();
});

/* ------------------------------------------------------- bank answer pick */

test('a confirmed row outranks an accepted row with a weaker kind', () => {
  const { db } = tempDb();
  const project = createProject(db, 'pick-confirmed');
  const mara = addEntity(db, project.id, 'Mara');
  const tor = addEntity(db, project.id, 'Tor');
  // Older accepted row first, so id order alone would pick the wrong kind.
  addRelation(db, project.id, mara, tor, 'relative of', {
    status: 'accepted',
    evidence: 'They were in the same room.',
    confirmedByUser: false,
  });
  addRelation(db, project.id, mara, tor, 'father of', {
    status: 'user_confirmed',
    evidence: '',
    confirmedByUser: true,
  });
  const answer = lorebook.bankAnswerForQuestion(db, project.id, 'status of Mara to Tor');
  assert.deepEqual(answer, { status: 'keeper', line: 'Mara — father of Tor', quote: '' });
  db.close();
});

test('without any confirmation the directed pick is unchanged', () => {
  const { db } = tempDb();
  const project = createProject(db, 'pick-accepted');
  const mara = addEntity(db, project.id, 'Mara');
  const tor = addEntity(db, project.id, 'Tor');
  addRelation(db, project.id, mara, tor, 'relative of', {
    status: 'accepted',
    evidence: 'They were in the same room.',
    confirmedByUser: false,
  });
  addRelation(db, project.id, mara, tor, 'father of', {
    status: 'accepted',
    evidence: 'He raised the child.',
    confirmedByUser: false,
  });
  // Pinned current behaviour: the later asserted row is the directed pick.
  const answer = lorebook.bankAnswerForQuestion(db, project.id, 'status of Mara to Tor');
  assert.deepEqual(answer, { status: 'keeper', line: 'Mara — father of Tor', quote: 'He raised the child.' });
  db.close();
});

test('a confirmation stored in the reverse direction renders as stored', () => {
  const { db } = tempDb();
  const project = createProject(db, 'pick-reverse');
  const mara = addEntity(db, project.id, 'Mara');
  const tor = addEntity(db, project.id, 'Tor');
  addRelation(db, project.id, mara, tor, 'relative of', {
    status: 'accepted',
    evidence: 'They were in the same room.',
    confirmedByUser: false,
  });
  addRelation(db, project.id, tor, mara, 'father of', {
    status: 'user_confirmed',
    evidence: '',
    confirmedByUser: true,
  });
  const answer = lorebook.bankAnswerForQuestion(db, project.id, 'status of Mara to Tor');
  assert.deepEqual(answer, { status: 'keeper', line: 'Tor — father of Mara', quote: '' });
  db.close();
});

test('a confirmed row with empty evidence has a line but no quotation', () => {
  const { db } = tempDb();
  const project = createProject(db, 'pick-empty-evidence');
  const mara = addEntity(db, project.id, 'Mara');
  const tor = addEntity(db, project.id, 'Tor');
  addRelation(db, project.id, mara, tor, 'friend of', {
    status: 'user_confirmed',
    evidence: '',
    sourceRefs: '[]',
    confirmedByUser: true,
  });
  const answer = lorebook.bankAnswerForQuestion(db, project.id, 'status of Mara to Tor');
  assert.equal(answer.status, 'keeper');
  assert.equal(answer.line, 'Mara — friend of Tor');
  assert.equal(answer.quote, '');
  assert.equal(answer.locator, undefined);
  assert.ok(!/\[S\d+\]/.test(answer.line ?? ''), 'no passage citation');
  db.close();
});


test('a short-name query reaches a tie stored on the full-name row', () => {
  const { db } = tempDb();
  const project = createProject(db, 'confirm-retrieval');
  addEntity(db, project.id, 'Mara', [], 2);
  const full = addEntity(db, project.id, 'Mara Vell', [], 21);
  const tor = addEntity(db, project.id, 'Tor', [], 5);
  addRelation(db, project.id, full, tor, 'friend of', {
    status: 'user_confirmed',
    evidence: '',
    sourceRefs: '[]',
    confirmedByUser: true,
  });
  const rows = lorebook.lookupKeeperPair(db, project.id, 'Mara', 'Tor');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.fromName, 'Mara Vell');
  const answer = lorebook.bankAnswerForQuestion(db, project.id, 'status of Mara to Tor');
  assert.equal(answer.status, 'keeper');
  assert.match(answer.line ?? '', /^Mara Vell — friend of Tor$/);
  db.close();
});

test('a full-name query reaches a tie stored on the short-name row', () => {
  const { db } = tempDb();
  const project = createProject(db, 'confirm-retrieval-reverse');
  const short = addEntity(db, project.id, 'Mara', [], 9);
  addEntity(db, project.id, 'Mara Vell', [], 3);
  const tor = addEntity(db, project.id, 'Tor', [], 5);
  addRelation(db, project.id, short, tor, 'friend of', {
    status: 'user_confirmed',
    evidence: '',
    sourceRefs: '[]',
    confirmedByUser: true,
  });
  const rows = lorebook.lookupKeeperPair(db, project.id, 'Mara Vell', 'Tor');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.fromName, 'Mara');
  db.close();
});
