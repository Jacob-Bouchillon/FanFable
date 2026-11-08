/**
 * Claim identity and proof history.
 *
 * The proof ledger records gate decisions; it does not decide them. These
 * tests cover stable claim instances, append-only attempts, the latest-attempt
 * resolver, fingerprint/policy binding, deletion/recreation and import order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { Db as SqliteDb } from '../../fanfable/src/core/db.ts';
import {
  CURRENT_PROOF_POLICY_VERSION,
  appendClaimProof,
  computeClaimFingerprints,
  exportClaimProofs,
  importClaimProofs,
  newClaimUid,
  resolveClaimProof,
  type ClaimProofExportRow,
  type ClaimType,
} from '../../fanfable/src/court/claim-proof.ts';
import { mockProvider, seedProject, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function addChunk(db: Db, projectId: number, text: string, seq = 0): number {
  const source = db.run(
    `INSERT INTO canon_source (project_id, path, title, sha256, imported_at)
     VALUES (?, ?, ?, ?, ?)`,
    projectId,
    `p-${seq}.txt`,
    `Probe ${seq}`,
    `sha-${seq}`,
    AT,
  ).lastInsertRowid;
  return db.run(
    `INSERT INTO canon_chunk
       (source_id, project_id, seq, locator, heading, text, char_start, char_end, words)
     VALUES (?, ?, ?, ?, '', ?, 0, ?, ?)`,
    source,
    projectId,
    seq,
    `p. ${seq + 1}`,
    text,
    text.length,
    text.split(/\s+/).filter(Boolean).length,
  ).lastInsertRowid;
}

function addEntity(db: Db, projectId: number, name: string): { id: number; uid: string } {
  const uid = newClaimUid('entity');
  const id = db.run(
    `INSERT INTO canon_entity
       (project_id, claim_uid, kind, name, aliases, created_at, updated_at)
     VALUES (?, ?, 'character', ?, '[]', ?, ?)`,
    projectId,
    uid,
    name,
    AT,
    AT,
  ).lastInsertRowid;
  return { id, uid };
}

interface RelationOptions {
  id?: number;
  uid?: string;
  kind?: string;
  evidence?: string;
  anchor?: string;
  kindSource?: string;
  modality?: string;
  scope?: string;
  ledgerState?: string;
  sourceRefs?: string;
  reviewStatus?: string;
  confirmedByUser?: number;
}

function addRelation(
  db: Db,
  projectId: number,
  from: number,
  to: number,
  chunk: number,
  opts: RelationOptions = {},
): { id: number; uid: string } {
  const uid = opts.uid ?? newClaimUid('relation');
  const evidence = opts.evidence ?? 'Asha trusted Bram.';
  const sourceRefs = opts.sourceRefs ?? JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk }]);
  const columns = `project_id, claim_uid, from_entity, to_entity, kind, description, evidence,
                   source_refs, confidence, modality, review_status, kind_source, anchor_evidence,
                   supporting_evidence, relation_status, scope, ledger_state, created_at`;
  const values = `?, ?, ?, ?, ?, '', ?, ?, 1.0, ?, ?, ?, ?, '[]', 'current', ?, ?, ?`;
  const params = [
    projectId,
    uid,
    from,
    to,
    opts.kind ?? 'ally of',
    evidence,
    sourceRefs,
    opts.modality ?? 'asserted',
    opts.reviewStatus ?? 'accepted',
    opts.kindSource ?? '',
    opts.anchor ?? '',
    opts.scope ?? '',
    opts.ledgerState ?? 'verified',
    AT,
  ];
  if (opts.id !== undefined) {
    const id = db.run(
      `INSERT INTO canon_relation (id, ${columns}) VALUES (?, ${values})`,
      opts.id,
      ...params,
    ).lastInsertRowid;
    return { id, uid };
  }
  return {
    id: db.run(`INSERT INTO canon_relation (${columns}) VALUES (${values})`, ...params).lastInsertRowid,
    uid,
  };
}

function addFact(db: Db, projectId: number, chunk: number, statement: string): { id: number; uid: string } {
  const uid = newClaimUid('fact');
  const id = db.run(
    `INSERT INTO canon_fact
       (project_id, claim_uid, topic, statement, kind, certainty, subject, evidence, source_refs, created_at)
     VALUES (?, ?, 'topic', ?, 'fact', 'confirmed', 'subject', ?, ?, ?)`,
    projectId,
    uid,
    statement,
    statement,
    JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk }]),
    AT,
  ).lastInsertRowid;
  return { id, uid };
}

function appendVerified(
  db: Db,
  projectId: number,
  claimType: ClaimType,
  claimUid: string,
  policyVersion = CURRENT_PROOF_POLICY_VERSION,
): number {
  const fingerprints = computeClaimFingerprints(db, projectId, claimType, claimUid);
  assert.ok(fingerprints);
  const result = appendClaimProof(db, projectId, {
    claimType,
    claimUid,
    standard: claimType === 'relation' ? 'sentence' : claimType === 'entity' ? 'identity' : 'none',
    outcome: 'verified',
    policyVersion,
    fingerprints,
    detail: 'test proof',
  });
  return result.id;
}

function freshClaim(db: Db, projectId: number, index: number): {
  from: number;
  to: number;
  chunk: number;
  claim: { id: number; uid: string };
} {
  const from = addEntity(db, projectId, `Asha ${index}`);
  const to = addEntity(db, projectId, `Bram ${index}`);
  const chunk = addChunk(db, projectId, `Asha ${index} trusted Bram ${index}.`, index);
  return {
    from: from.id,
    to: to.id,
    chunk,
    claim: addRelation(db, projectId, from.id, to.id, chunk, {
      evidence: `Asha ${index} trusted Bram ${index}.`,
    }),
  };
}

test('migration 29 creates claim UIDs and the append-only proof table', () => {
  const { db } = tempDb();
  assert.equal(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 33);
  for (const table of ['canon_relation', 'canon_entity', 'canon_fact']) {
    const columns = db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name);
    assert.ok(columns.includes('claim_uid'), `${table}.claim_uid`);
  }
  const indexes = db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('canon_relation_claim_uid', 'canon_entity_claim_uid', 'canon_fact_claim_uid', 'claim_proof_attempt', 'claim_proof_latest', 'claim_proof_outcome')",
    )
    .map((row) => row.name);
  for (const name of [
    'canon_relation_claim_uid', 'canon_entity_claim_uid', 'canon_fact_claim_uid',
    'claim_proof_attempt', 'claim_proof_latest', 'claim_proof_outcome',
  ]) {
    assert.ok(indexes.includes(name), name);
  }
  const proofColumns = db.all<{ name: string }>('PRAGMA table_info(claim_proof)').map((row) => row.name);
  for (const name of [
    'id', 'project_id', 'claim_type', 'claim_uid', 'claim_id_at_eval', 'standard', 'outcome',
    'claim_fingerprint', 'evidence_fingerprint', 'input_fingerprint', 'fingerprint_version',
    'policy_version', 'gate_version', 'attempt_seq', 'checked_at', 'proof_run_id', 'quote_hash',
    'detail', 'created_at',
  ]) {
    assert.ok(proofColumns.includes(name), `claim_proof.${name}`);
  }
  db.close();
});

test('new claim inserts receive prefixed UIDs', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'claim-uid-insert');
  const from = addEntity(db, project.id, 'Asha');
  const to = addEntity(db, project.id, 'Bram');
  const chunk = addChunk(db, project.id, 'Asha trusted Bram.');
  const relationId = lorebook.insertRelation(db, project.id, {
    fromEntity: from.id,
    toEntity: to.id,
    kind: 'ally of',
    evidence: 'Asha trusted Bram.',
    sourceRefs: JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk }]),
  });
  const row = db.get<{ claim_uid: string }>('SELECT claim_uid FROM canon_relation WHERE id = ?', relationId)!;
  assert.match(row.claim_uid, /^rel-/);
  db.close();
});

test('extraction inserts claim UIDs for new entities and facts', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'claim-uid-extract');
  const llm = mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({
      entities: [{
        kind: 'character', name: 'Serena Marsh', aliases: [],
        summary: 'A woman who watches the bridge.', attributes: {},
        role: '', status: '', chunk_index: 0,
        evidence: 'Serena Marsh watched it from the ridge',
      }],
      facts: [{
        topic: 'bridge', statement: 'The bridge at Ardenne still stood.',
        kind: 'fact', certainty: 'confirmed', subject: 'Serena Marsh',
        chunk_index: 0, evidence: 'the bridge at Ardenne still stood',
      }],
    });
  });
  await lorebook.extractLore(db, llm, project.id, { windowSize: 8, concurrency: 1 });
  const entity = db.get<{ claim_uid: string }>(
    'SELECT claim_uid FROM canon_entity WHERE project_id = ?',
    project.id,
  );
  const fact = db.get<{ claim_uid: string }>(
    'SELECT claim_uid FROM canon_fact WHERE project_id = ?',
    project.id,
  );
  assert.match(entity?.claim_uid ?? '', /^ent-/);
  assert.match(fact?.claim_uid ?? '', /^fact-/);
  db.close();
});

test('migration backfills every legacy claim before proof evaluation', async () => {
  const { db, path } = tempDb();
  const project = controller.createProject(db, 'claim-uid-backfill');
  const chunk = addChunk(db, project.id, 'Asha trusted Bram.');
  const from = addEntity(db, project.id, 'Asha');
  const to = addEntity(db, project.id, 'Bram');
  // Simulate pre-29 rows: the columns exist on this test DB, but are empty.
  addRelation(db, project.id, from.id, to.id, chunk, {
    reviewStatus: 'user_confirmed',
    confirmedByUser: 1,
  });
  db.run("INSERT INTO canon_fact (project_id, topic, statement, created_at) VALUES (?, 't', 's', ?)", project.id, AT);
  const before = {
    chunks: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?', project.id)?.n,
    entities: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', project.id)?.n,
    relations: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project.id)?.n,
    status: db.get<{ review_status: string; confirmed_by_user: number }>(
      'SELECT review_status, confirmed_by_user FROM canon_relation WHERE project_id = ?',
      project.id,
    ),
  };
  db.exec(`
    DROP TABLE claim_proof;
    DROP INDEX IF EXISTS canon_relation_claim_uid;
    DROP INDEX IF EXISTS canon_entity_claim_uid;
    DROP INDEX IF EXISTS canon_fact_claim_uid;
    ALTER TABLE canon_relation DROP COLUMN claim_uid;
    ALTER TABLE canon_entity DROP COLUMN claim_uid;
    ALTER TABLE canon_fact DROP COLUMN claim_uid;
    PRAGMA user_version = 28;
  `);
  db.close();

  const copy = new SqliteDb(path);
  assert.equal(copy.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 33);
  assert.ok(copy.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'claim_proof'"));
  for (const name of ['canon_relation_claim_uid', 'canon_entity_claim_uid', 'canon_fact_claim_uid']) {
    assert.ok(
      copy.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", name),
      name,
    );
  }
  assert.equal(
    copy.get<{ n: number }>("SELECT COUNT(*) AS n FROM canon_relation WHERE claim_uid IS NULL OR claim_uid = ''")?.n,
    0,
  );
  assert.equal(
    copy.get<{ n: number }>("SELECT COUNT(*) AS n FROM canon_entity WHERE claim_uid IS NULL OR claim_uid = ''")?.n,
    0,
  );
  assert.equal(
    copy.get<{ n: number }>("SELECT COUNT(*) AS n FROM canon_fact WHERE claim_uid IS NULL OR claim_uid = ''")?.n,
    0,
  );
  assert.deepEqual(
    {
      chunks: copy.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?', project.id)?.n,
      entities: copy.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', project.id)?.n,
      relations: copy.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project.id)?.n,
      status: copy.get('SELECT review_status, confirmed_by_user FROM canon_relation WHERE project_id = ?', project.id),
    },
    before,
  );
  copy.close();
});

test('deleting and recreating a claim with the same rowid does not inherit proof', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'claim-recreate');
  const from = addEntity(db, project.id, 'Asha');
  const to = addEntity(db, project.id, 'Bram');
  const chunk = addChunk(db, project.id, 'Asha trusted Bram.');
  const claim = addRelation(db, project.id, from.id, to.id, chunk);
  appendVerified(db, project.id, 'relation', claim.uid);
  assert.equal(resolveClaimProof(db, project.id, 'relation', claim.uid).effective, 'verified');

  db.run('DELETE FROM canon_relation WHERE id = ?', claim.id);
  const recreated = addRelation(db, project.id, from.id, to.id, chunk, {
    id: claim.id,
    kind: 'enemy of',
    evidence: 'Asha opposed Bram.',
  });
  assert.notEqual(recreated.uid, claim.uid);
  assert.equal(resolveClaimProof(db, project.id, 'relation', claim.uid).effective, 'unavailable');
  const current = resolveClaimProof(db, project.id, 'relation', recreated.uid);
  assert.notEqual(current.effective, 'verified');
  assert.equal(current.effective, 'not_evaluated');
  assert.equal(current.reason, 'no_proof');
  assert.equal(exportClaimProofs(db, project.id).length, 1, 'proof history survives the deletion');
  db.close();
});

test('recreating a claim with the same UID and different content is stale', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'claim-recreate-uid');
  const from = addEntity(db, project.id, 'Asha');
  const to = addEntity(db, project.id, 'Bram');
  const chunk = addChunk(db, project.id, 'Asha trusted Bram.');
  const claim = addRelation(db, project.id, from.id, to.id, chunk);
  appendVerified(db, project.id, 'relation', claim.uid);
  db.run('DELETE FROM canon_relation WHERE id = ?', claim.id);
  addRelation(db, project.id, from.id, to.id, chunk, {
    id: claim.id,
    uid: claim.uid,
    kind: 'enemy of',
    evidence: 'Asha opposed Bram.',
  });
  const result = resolveClaimProof(db, project.id, 'relation', claim.uid);
  assert.equal(result.effective, 'stale');
  assert.equal(result.reason, 'fingerprint_mismatch');
  db.close();
});

test('the same UID with changed content is stale by fingerprint', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'claim-same-uid');
  const { claim } = freshClaim(db, project.id, 0);
  appendVerified(db, project.id, 'relation', claim.uid);
  db.run("UPDATE canon_relation SET kind = 'enemy of' WHERE id = ?", claim.id);
  const result = resolveClaimProof(db, project.id, 'relation', claim.uid);
  assert.equal(result.effective, 'stale');
  assert.equal(result.reason, 'fingerprint_mismatch');
  db.close();
});

test('each proof-relevant mutation makes the prior verified attempt stale', () => {
  const scenarios: Array<{ name: string; mutate: (db: Db, project: number, claim: { id: number; uid: string }, ctx: { from: number; to: number; chunk: number; extra: number }) => void }> = [
    {
      name: 'endpoints',
      mutate: (db, _p, claim, ctx) => db.run('UPDATE canon_relation SET to_entity = ? WHERE id = ?', ctx.extra, claim.id),
    },
    {
      name: 'direction',
      mutate: (db, _p, claim, ctx) => db.run('UPDATE canon_relation SET from_entity = ?, to_entity = ? WHERE id = ?', ctx.to, ctx.from, claim.id),
    },
    {
      name: 'kind',
      mutate: (db, _p, claim) => db.run("UPDATE canon_relation SET kind = 'enemy of' WHERE id = ?", claim.id),
    },
    {
      name: 'quote',
      mutate: (db, _p, claim) => db.run("UPDATE canon_relation SET evidence = 'different quote' WHERE id = ?", claim.id),
    },
    {
      name: 'anchor',
      mutate: (db, _p, claim) => db.run("UPDATE canon_relation SET anchor_evidence = 'different anchor' WHERE id = ?", claim.id),
    },
    {
      name: 'kind_source',
      mutate: (db, _p, claim) => db.run("UPDATE canon_relation SET kind_source = 'different source words' WHERE id = ?", claim.id),
    },
    {
      name: 'modality',
      mutate: (db, _p, claim) => db.run("UPDATE canon_relation SET modality = 'denied' WHERE id = ?", claim.id),
    },
    {
      name: 'scope',
      mutate: (db, _p, claim) => db.run("UPDATE canon_relation SET scope = 'different scope' WHERE id = ?", claim.id),
    },
    {
      name: 'ledger_state',
      mutate: (db, _p, claim) => db.run("UPDATE canon_relation SET ledger_state = 'superseded' WHERE id = ?", claim.id),
    },
    {
      name: 'cited chunk id',
      mutate: (db, _p, claim, ctx) =>
        db.run(
          'UPDATE canon_relation SET source_refs = ? WHERE id = ?',
          JSON.stringify([{ source: 'Probe', locator: 'p. 2', chunk: ctx.extra }]),
          claim.id,
        ),
    },
    {
      name: 'cited passage text',
      mutate: (db, _p, _claim, ctx) => db.run("UPDATE canon_chunk SET text = 'rewritten passage' WHERE id = ?", ctx.chunk),
    },
    {
      name: 'source identity',
      mutate: (db, _p, claim) =>
        db.run(
          'UPDATE canon_relation SET source_refs = ? WHERE id = ?',
          JSON.stringify([{ source: 'Other source', locator: 'p. 1', chunk: 1 }]),
          claim.id,
        ),
    },
  ];
  const { db } = tempDb();
  const project = controller.createProject(db, 'claim-mutations');
  scenarios.forEach((scenario, index) => {
    const from = addEntity(db, project.id, `Mut From ${index}`);
    const to = addEntity(db, project.id, `Mut To ${index}`);
    const extra = addEntity(db, project.id, `Mut Extra ${index}`);
    const chunk = addChunk(db, project.id, `Mut From ${index} trusted Mut To ${index}.`, index * 2);
    const otherChunk = addChunk(db, project.id, `Mut Extra ${index} watched.`, index * 2 + 1);
    const claim = addRelation(db, project.id, from.id, to.id, chunk, {
      evidence: `Mut From ${index} trusted Mut To ${index}.`,
    });
    appendVerified(db, project.id, 'relation', claim.uid);
    scenario.mutate(db, project.id, claim, {
      from: from.id,
      to: to.id,
      chunk,
      extra: scenario.name === 'endpoints' ? extra.id : scenario.name === 'cited chunk id' ? otherChunk : extra.id,
    });
    const result = resolveClaimProof(db, project.id, 'relation', claim.uid);
    assert.equal(result.effective, 'stale', scenario.name);
    assert.equal(result.reason, 'fingerprint_mismatch', scenario.name);
  });
  db.close();
});

test('entity identity proofs use identity fields and go stale on identity change', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'claim-entity');
  const entity = addEntity(db, project.id, 'Asha');
  const fingerprints = computeClaimFingerprints(db, project.id, 'entity', entity.uid)!;
  appendClaimProof(db, project.id, {
    claimType: 'entity', claimUid: entity.uid, standard: 'identity',
    outcome: 'verified', fingerprints,
  });
  assert.equal(resolveClaimProof(db, project.id, 'entity', entity.uid).effective, 'verified');
  db.run("UPDATE canon_entity SET aliases = '[\"Ash\"]' WHERE id = ?", entity.id);
  const result = resolveClaimProof(db, project.id, 'entity', entity.uid);
  assert.equal(result.effective, 'stale');
  assert.equal(result.reason, 'fingerprint_mismatch');
  db.close();
});

test('fact claims use fact fields and remain advisory', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'claim-fact');
  const chunk = addChunk(db, project.id, 'The bridge stood.');
  const fact = addFact(db, project.id, chunk, 'The bridge stood.');
  const before = computeClaimFingerprints(db, project.id, 'fact', fact.uid)!;
  db.run("UPDATE canon_fact SET statement = 'The bridge fell.' WHERE id = ?", fact.id);
  const after = computeClaimFingerprints(db, project.id, 'fact', fact.uid)!;
  assert.notEqual(after.inputFingerprint, before.inputFingerprint);
  assert.throws(
    () => appendClaimProof(db, project.id, {
      claimType: 'fact', claimUid: fact.uid, standard: 'sentence', outcome: 'verified',
    }),
    /standard sentence is not valid for fact/,
  );
  appendClaimProof(db, project.id, {
    claimType: 'fact', claimUid: fact.uid, standard: 'none', outcome: 'not_evaluated', fingerprints: after,
  });
  assert.equal(resolveClaimProof(db, project.id, 'fact', fact.uid).effective, 'not_evaluated');
  db.close();
});

test('unrelated metadata changes do not invalidate a proof', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'claim-unrelated');
  const { claim } = freshClaim(db, project.id, 0);
  appendVerified(db, project.id, 'relation', claim.uid);
  db.run("UPDATE canon_relation SET description = 'display only', confidence = 0.4 WHERE id = ?", claim.id);
  assert.equal(resolveClaimProof(db, project.id, 'relation', claim.uid).effective, 'verified');
  db.close();
});

test('the resolver never falls back past a newer failed or non-verified attempt', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'claim-latest');
  const { claim } = freshClaim(db, project.id, 0);
  appendVerified(db, project.id, 'relation', claim.uid);
  const fingerprints = computeClaimFingerprints(db, project.id, 'relation', claim.uid)!;
  appendClaimProof(db, project.id, {
    claimType: 'relation', claimUid: claim.uid, standard: 'sentence',
    outcome: 'failed', fingerprints,
  });
  let result = resolveClaimProof(db, project.id, 'relation', claim.uid);
  assert.equal(result.effective, 'failed');
  assert.equal(result.attemptSeq, 2);
  appendClaimProof(db, project.id, {
    claimType: 'relation', claimUid: claim.uid, standard: 'sentence',
    outcome: 'not_evaluated', fingerprints,
  });
  result = resolveClaimProof(db, project.id, 'relation', claim.uid);
  assert.equal(result.effective, 'not_evaluated');
  appendClaimProof(db, project.id, {
    claimType: 'relation', claimUid: claim.uid, standard: 'sentence',
    outcome: 'legacy_unknown', fingerprints,
  });
  result = resolveClaimProof(db, project.id, 'relation', claim.uid);
  assert.equal(result.effective, 'legacy_unknown');
  db.close();
});

test('policy mismatch is stale; re-evaluation appends a new verified attempt', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'claim-policy');
  const { claim } = freshClaim(db, project.id, 0);
  appendVerified(db, project.id, 'relation', claim.uid);
  let result = resolveClaimProof(db, project.id, 'relation', claim.uid, 'claim-proof-v2');
  assert.equal(result.effective, 'stale');
  assert.equal(result.reason, 'policy_mismatch');
  appendVerified(db, project.id, 'relation', claim.uid, 'claim-proof-v2');
  result = resolveClaimProof(db, project.id, 'relation', claim.uid, 'claim-proof-v2');
  assert.equal(result.effective, 'verified');
  assert.equal(result.attemptSeq, 2);
  db.close();
});

test('a semantic gate-policy mismatch is stale', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'claim-gate-policy');
  const { claim } = freshClaim(db, project.id, 0);
  appendVerified(db, project.id, 'relation', claim.uid);
  let result = resolveClaimProof(
    db,
    project.id,
    'relation',
    claim.uid,
    CURRENT_PROOF_POLICY_VERSION,
    'gate-semantics-v2',
  );
  assert.equal(result.effective, 'stale');
  assert.equal(result.reason, 'gate_policy_mismatch');
  const fingerprints = computeClaimFingerprints(db, project.id, 'relation', claim.uid)!;
  appendClaimProof(db, project.id, {
    claimType: 'relation', claimUid: claim.uid, standard: 'sentence',
    outcome: 'verified', fingerprints, gateVersion: 'gate-semantics-v2',
  });
  result = resolveClaimProof(
    db,
    project.id,
    'relation',
    claim.uid,
    CURRENT_PROOF_POLICY_VERSION,
    'gate-semantics-v2',
  );
  assert.equal(result.effective, 'verified');
  db.close();
});

test('import preserves attempt_seq and resolves by it, not insertion order', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'claim-import');
  const { claim } = freshClaim(db, project.id, 0);
  appendVerified(db, project.id, 'relation', claim.uid);
  const fingerprints = computeClaimFingerprints(db, project.id, 'relation', claim.uid)!;
  appendClaimProof(db, project.id, {
    claimType: 'relation', claimUid: claim.uid, standard: 'sentence',
    outcome: 'failed', fingerprints,
  });
  const exported = exportClaimProofs(db, project.id);
  assert.equal(exported.length, 2);
  assert.equal(exported[0]!.claim_uid, claim.uid);
  db.run('DELETE FROM claim_proof WHERE project_id = ?', project.id);
  const reversed = [...exported].reverse();
  const imported = importClaimProofs(db, project.id, reversed);
  assert.deepEqual(imported, { inserted: 2, skipped: 0 });
  const result = resolveClaimProof(db, project.id, 'relation', claim.uid);
  assert.equal(result.effective, 'failed');
  assert.equal(result.attemptSeq, 2);

  db.run('DELETE FROM claim_proof WHERE project_id = ?', project.id);
  const fiveFailed: ClaimProofExportRow = { ...exported[1]!, attempt_seq: 5, outcome: 'failed' };
  const twoVerified: ClaimProofExportRow = { ...exported[0]!, attempt_seq: 2, outcome: 'verified' };
  importClaimProofs(db, project.id, [fiveFailed, twoVerified]);
  const highest = resolveClaimProof(db, project.id, 'relation', claim.uid);
  assert.equal(highest.effective, 'failed');
  assert.equal(highest.attemptSeq, 5);
  db.close();
});

test('an interrupted proof append leaves no partial row or claim edit', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'claim-interrupt');
  const { claim } = freshClaim(db, project.id, 0);
  db.exec(`CREATE TRIGGER stop_proof BEFORE INSERT ON claim_proof
           BEGIN SELECT RAISE(ABORT, 'proof interrupted'); END;`);
  const fingerprints = computeClaimFingerprints(db, project.id, 'relation', claim.uid)!;
  assert.throws(
    () => appendClaimProof(db, project.id, {
      claimType: 'relation', claimUid: claim.uid, standard: 'sentence',
      outcome: 'verified', fingerprints,
    }),
    /proof interrupted/,
  );
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM claim_proof WHERE project_id = ?', project.id)?.n, 0);

  assert.throws(() => {
    db.transaction(() => {
      db.run("UPDATE canon_relation SET kind = 'enemy of' WHERE id = ?", claim.id);
      appendClaimProof(db, project.id, {
        claimType: 'relation', claimUid: claim.uid, standard: 'sentence',
        outcome: 'verified',
      });
    });
  }, /proof interrupted/);
  assert.equal(
    db.get<{ kind: string }>('SELECT kind FROM canon_relation WHERE id = ?', claim.id)?.kind,
    'ally of',
  );
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM claim_proof WHERE project_id = ?', project.id)?.n, 0);
  db.close();
});
