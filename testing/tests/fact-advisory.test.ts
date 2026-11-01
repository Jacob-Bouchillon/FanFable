/**
 * Facts are advisory context, never proof. A fact's review_status gates
 * nothing: facts stay visible in retrieval context and the lore brief with
 * their certainty label, and they never authorise a relationship claim.
 * Invented names only; no model calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import * as graph from '../../fanfable/src/support/graph.ts';
import { enforceStatusTieGuard } from '../../fanfable/src/answer/lore-ask.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function entity(db: Db, projectId: number, name: string): number {
  return Number(
    db.run(
      'INSERT INTO canon_entity (project_id, kind, name, aliases, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      projectId,
      'character',
      name,
      '[]',
      'accepted',
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function fact(
  db: Db,
  projectId: number,
  opts: {
    statement: string;
    subject: string;
    subjectEntityId: number;
    certainty?: string;
    evidence?: string;
    reviewStatus?: string;
  },
): number {
  return Number(
    db.run(
      `INSERT INTO canon_fact
         (project_id, topic, statement, kind, certainty, subject, evidence, source_refs,
          subject_entity_id, modality, review_status, created_at)
       VALUES (?, '', ?, 'fact', ?, ?, ?, '[]', ?, 'asserted', ?, ?)`,
      projectId,
      opts.statement,
      opts.certainty ?? 'confirmed',
      opts.subject,
      opts.evidence ?? opts.statement,
      opts.subjectEntityId,
      opts.reviewStatus ?? 'needs_review',
      AT,
    ).lastInsertRowid,
  );
}

test('a needs_review fact stays available as advisory context', () => {
  const { db } = tempDb();
  const project = createProject(db, 'fact-advisory-context');
  const asha = entity(db, project.id, 'Asha');
  const statement = 'Asha keeps the ledger at the mill.';
  const factId = fact(db, project.id, { statement, subject: 'Asha', subjectEntityId: asha });

  const ctx = graph.buildGraphContext(db, project.id, { focus: ['Asha'], hops: 1 });
  const node = ctx.nodes.find((n) => n.id === graph.canonFactId(factId));
  assert.ok(node, 'the fact node reaches the context');
  assert.equal(node!.kind, 'canon-fact');
  assert.equal(node!.summary, statement, 'the node carries the statement');
  assert.ok(ctx.text.includes(statement), 'the rendered context carries the statement');

  const brief = lorebook.buildLoreBrief(db, project.id, { names: ['Asha'] });
  assert.ok(brief.facts.includes(statement), 'the brief carries the statement');
  const text = lorebook.formatLoreBrief(brief);
  assert.ok(text.includes('SOURCE-DERIVED FACTS (VERIFY BEFORE ASSERTING):'));
  assert.ok(text.includes(statement));
  db.close();
});

test('an inferred fact is labelled inferred in context and in the brief', () => {
  const { db } = tempDb();
  const project = createProject(db, 'fact-advisory-inferred');
  const asha = entity(db, project.id, 'Asha');
  const statement = 'Asha may have burned the ledger.';
  fact(db, project.id, {
    statement,
    subject: 'Asha',
    subjectEntityId: asha,
    certainty: 'inferred',
  });

  const ctx = graph.buildGraphContext(db, project.id, { focus: ['Asha'], hops: 1 });
  assert.ok(ctx.text.includes(statement));
  assert.ok(ctx.text.includes('[inferred]'), 'the context labels the inference');

  const brief = lorebook.buildLoreBrief(db, project.id, { names: ['Asha'] });
  const text = lorebook.formatLoreBrief(brief);
  assert.ok(text.includes(statement));
  assert.ok(text.includes('[inferred]'), 'the brief labels the inference');
  db.close();
});

test('a fact cannot authorise a relationship claim without a keeper', () => {
  const { db } = tempDb();
  const project = createProject(db, 'fact-advisory-gate');
  const asha = entity(db, project.id, 'Asha');
  entity(db, project.id, 'Bram');
  // The fact states the tie, but no canon_relation row proves it.
  fact(db, project.id, {
    statement: "Asha is Bram's sister.",
    subject: 'Asha',
    subjectEntityId: asha,
  });

  assert.deepEqual(lorebook.lookupKeeperPair(db, project.id, 'Asha', 'Bram'), []);
  const draft = "Asha is Bram's sister.";
  const output = enforceStatusTieGuard(db, project.id, "Is Asha Bram's sister?", draft, []);
  assert.notEqual(output, draft, 'the guard does not pass the draft through');
  assert.match(output, /Tie not established/);
  db.close();
});
