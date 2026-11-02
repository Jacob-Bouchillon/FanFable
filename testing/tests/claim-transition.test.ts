/**
 * Relation status owner, first slice.
 *
 * Real transitions run only on isolated temp databases. Shadow evaluation is
 * expected to leave every user table untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import * as controller from '../../fanfable/src/plan/controller.ts';
import { Db } from '../../fanfable/src/core/db.ts';
import {
  CURRENT_PROOF_POLICY_VERSION,
  SEMANTIC_GATE_POLICY_VERSION,
  appendClaimProof,
  newClaimUid,
  type ClaimFingerprints,
  type ProofStandard,
} from '../../fanfable/src/court/claim-proof.ts';
import {
  readRelationClaimState,
  shadowTransitionClaim,
  transitionClaim,
  type AppliedTransition,
  type ClaimRef,
  type ExpectedClaimState,
  type RelationClaimState,
  type RelationGateResult,
  type TransitionClaimInput,
  type TransitionResult,
} from '../../fanfable/src/court/claim-transition.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

interface SetupOptions {
  status?: string;
  confirmedByUser?: number;
}

function setup(options: SetupOptions = {}) {
  const { db, path } = tempDb();
  const project = controller.createProject(db, `transition-${Math.random().toString(36).slice(2, 7)}`);
  const sourceId = db.run(
    `INSERT INTO canon_source (project_id, path, title, sha256, imported_at)
     VALUES (?, ?, ?, ?, ?)`,
    project.id,
    '/probe',
    'Probe',
    'sha',
    AT,
  ).lastInsertRowid;
  const chunkId = db.run(
    `INSERT INTO canon_chunk
       (source_id, project_id, seq, locator, heading, text, char_start, char_end, words)
     VALUES (?, ?, 1, 'p. 1', '', 'Asha trusted Bram.', 0, 18, 3)`,
    sourceId,
    project.id,
  ).lastInsertRowid;
  const addEntity = (name: string): number => db.run(
    `INSERT INTO canon_entity
       (project_id, claim_uid, kind, name, aliases, created_at, updated_at)
     VALUES (?, ?, 'character', ?, '[]', ?, ?)`,
    project.id,
    newClaimUid('entity'),
    name,
    AT,
    AT,
  ).lastInsertRowid;
  const from = addEntity('Asha');
  const to = addEntity('Bram');
  const uid = newClaimUid('relation');
  const id = db.run(
    `INSERT INTO canon_relation
       (project_id, claim_uid, from_entity, to_entity, kind, description, evidence,
        source_refs, confidence, modality, review_status, kind_source, anchor_evidence,
        supporting_evidence, relation_status, scope, ledger_state, confirmed_by_user, created_at)
     VALUES (?, ?, ?, ?, 'ally of', '', 'Asha trusted Bram.', ?, 1.0, 'asserted',
             ?, '', '', '[]', 'current', '', 'verified', ?, ?)`,
    project.id,
    uid,
    from,
    to,
    JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk: chunkId }]),
    options.status ?? 'provisional',
    options.confirmedByUser ?? 0,
    AT,
  ).lastInsertRowid;
  return { db, path, project, uid, id, chunkId, from, to };
}

function stateOf(db: Db, projectId: number, uid: string): RelationClaimState {
  const state = readRelationClaimState(db, projectId, uid);
  assert.ok(state, 'relation claim state');
  return state;
}

function expectedOf(state: RelationClaimState): ExpectedClaimState {
  return {
    reviewStatus: state.reviewStatus,
    authorization: state.authorization,
    proofAttemptSeq: state.proofAttemptSeq,
    policyVersion: state.policyVersion,
    fingerprints: state.fingerprints,
  };
}

function gateFor(
  db: Db,
  projectId: number,
  uid: string,
  standard: ProofStandard = 'sentence',
): RelationGateResult {
  return {
    outcome: 'verified',
    standard,
    policyVersion: CURRENT_PROOF_POLICY_VERSION,
    gateVersion: SEMANTIC_GATE_POLICY_VERSION,
    fingerprints: stateOf(db, projectId, uid).fingerprints,
    detail: 'test gate',
  };
}

function promotionInput(
  db: Db,
  projectId: number,
  uid: string,
  target: 'accepted' | 'attested' = 'accepted',
): TransitionClaimInput {
  const state = stateOf(db, projectId, uid);
  const standard: ProofStandard = target === 'attested' ? 'passage' : 'sentence';
  return {
    claim: { type: 'relation', uid },
    intent: 'promotion',
    expect: expectedOf(state),
    target: { reviewStatus: target },
    gateResult: gateFor(db, projectId, uid, standard),
    actor: 'guard',
    role: 'appeal',
    standard: target === 'attested' ? 'passage-proof' : 'sentence-proof',
    basis: 'test promotion',
    quote: 'Asha trusted Bram.',
  };
}

function applied(result: TransitionResult): AppliedTransition {
  assert.equal(result.kind, 'applied', JSON.stringify(result));
  return result as AppliedTransition;
}

function rejected(result: TransitionResult): Extract<TransitionResult, { kind: 'rejected' }> {
  assert.equal(result.kind, 'rejected', JSON.stringify(result));
  return result as Extract<TransitionResult, { kind: 'rejected' }>;
}

function proofCount(db: Db, projectId: number, uid: string): number {
  return db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM claim_proof
      WHERE project_id = ? AND claim_type = 'relation' AND claim_uid = ?`,
    projectId,
    uid,
  )?.n ?? 0;
}

function rulingCount(db: Db, projectId: number): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_ruling WHERE project_id = ?', projectId)?.n ?? 0;
}

function relationRow(db: Db, projectId: number, uid: string) {
  const row = db.get<{ review_status: string; confirmed_by_user: number }>(
    'SELECT review_status, confirmed_by_user FROM canon_relation WHERE project_id = ? AND claim_uid = ?',
    projectId,
    uid,
  );
  assert.ok(row, 'relation row');
  return { review_status: row.review_status, confirmed_by_user: row.confirmed_by_user };
}

test('a promotion appends proof and ruling in one transaction', () => {
  const { db, project, uid } = setup();
  const result = applied(transitionClaim(db, project.id, promotionInput(db, project.id, uid)));
  assert.equal(result.statusChanged, true);
  assert.equal(result.proofAppended, true);
  assert.equal(result.proofAttemptSeq, 1);

  assert.deepEqual(relationRow(db, project.id, uid), {
    review_status: 'accepted',
    confirmed_by_user: 0,
  });
  const proofs = db.all<{ attempt_seq: number; outcome: string; standard: string }>(
    'SELECT attempt_seq, outcome, standard FROM claim_proof WHERE project_id = ? AND claim_uid = ? ORDER BY attempt_seq',
    project.id,
    uid,
  );
  assert.equal(proofs.length, 1);
  assert.equal(proofs[0]!.attempt_seq, 1);
  assert.equal(proofs[0]!.outcome, 'verified');
  assert.equal(proofs[0]!.standard, 'sentence');

  const rulings = db.all<{ relation_id: number; from_status: string; to_status: string }>(
    'SELECT relation_id, from_status, to_status FROM canon_ruling WHERE project_id = ?',
    project.id,
  );
  assert.equal(rulings.length, 1);
  assert.equal(rulings[0]!.relation_id, result.claim.type === 'relation' ? stateOf(db, project.id, uid).claimId : 0);
  assert.equal(rulings[0]!.from_status, 'provisional');
  assert.equal(rulings[0]!.to_status, 'accepted');

  assert.equal(stateOf(db, project.id, uid).sourceProof, 'verified');
  db.close();
});

test('promotion without a gate result is rejected and writes nothing', () => {
  const { db, project, uid } = setup();
  const input = promotionInput(db, project.id, uid);
  delete input.gateResult;
  const result = rejected(transitionClaim(db, project.id, input));
  assert.equal(result.reason, 'gate_required');
  assert.equal(relationRow(db, project.id, uid).review_status, 'provisional');
  assert.equal(proofCount(db, project.id, uid), 0);
  assert.equal(rulingCount(db, project.id), 0);
  db.close();
});

test('an existing verified proof row does not promote without an explicit gate result and target', () => {
  const { db, project, uid } = setup();
  const state = stateOf(db, project.id, uid);
  appendClaimProof(db, project.id, {
    claimType: 'relation',
    claimUid: uid,
    standard: 'sentence',
    outcome: 'verified',
    policyVersion: CURRENT_PROOF_POLICY_VERSION,
    gateVersion: SEMANTIC_GATE_POLICY_VERSION,
    fingerprints: state.fingerprints,
  });
  const input = promotionInput(db, project.id, uid);
  delete input.gateResult;
  const result = rejected(transitionClaim(db, project.id, input));
  assert.equal(result.reason, 'gate_required');
  assert.equal(relationRow(db, project.id, uid).review_status, 'provisional');
  assert.equal(proofCount(db, project.id, uid), 1);
  assert.equal(rulingCount(db, project.id), 0);
  db.close();
});

test('a verified gate without an explicit promotion target does not promote', () => {
  const { db, project, uid } = setup();
  const state = stateOf(db, project.id, uid);
  const result = rejected(transitionClaim(db, project.id, {
    claim: { type: 'relation', uid },
    intent: 'administrative',
    expect: expectedOf(state),
    target: { authorization: 'user_confirmed' },
    gateResult: gateFor(db, project.id, uid),
    actor: 'guard',
    role: 'appeal',
    standard: 'sentence-proof',
    basis: 'verified but no target',
  }));
  assert.equal(result.reason, 'verified_without_promotion');
  assert.equal(relationRow(db, project.id, uid).review_status, 'provisional');
  assert.equal(relationRow(db, project.id, uid).confirmed_by_user, 0);
  assert.equal(proofCount(db, project.id, uid), 0);
  assert.equal(rulingCount(db, project.id), 0);
  db.close();
});

test('gate fingerprints that do not match the current claim are rejected', () => {
  const { db, project, uid } = setup();
  const input = promotionInput(db, project.id, uid);
  input.gateResult = {
    ...input.gateResult!,
    fingerprints: {
      ...input.gateResult!.fingerprints,
      claimFingerprint: '0'.repeat(64),
    },
  };
  const result = rejected(transitionClaim(db, project.id, input));
  assert.equal(result.reason, 'gate_fingerprint_mismatch');
  assert.equal(relationRow(db, project.id, uid).review_status, 'provisional');
  assert.equal(proofCount(db, project.id, uid), 0);
  assert.equal(rulingCount(db, project.id), 0);
  db.close();
});

test('stale expected status returns stale and writes nothing', () => {
  const { db, project, uid } = setup();
  const input: TransitionClaimInput = {
    claim: { type: 'relation', uid },
    intent: 'administrative',
    expect: expectedOf(stateOf(db, project.id, uid)),
    target: { reviewStatus: 'needs_review' },
    actor: 'guard',
    role: 'appeal',
    standard: 'manual',
    basis: 'park',
  };
  db.run("UPDATE canon_relation SET review_status = 'accepted' WHERE project_id = ? AND claim_uid = ?", project.id, uid);
  const result = transitionClaim(db, project.id, input);
  assert.equal(result.kind, 'stale');
  if (result.kind !== 'stale') return;
  assert.equal(result.reason, 'status');
  assert.equal(result.targetAlreadyCurrent, false);
  assert.equal(relationRow(db, project.id, uid).review_status, 'accepted');
  assert.equal(proofCount(db, project.id, uid), 0);
  assert.equal(rulingCount(db, project.id), 0);
  db.close();
});

test('stale expected proof version returns stale and writes nothing', () => {
  const { db, project, uid } = setup();
  const input: TransitionClaimInput = {
    claim: { type: 'relation', uid },
    intent: 'demotion',
    expect: expectedOf(stateOf(db, project.id, uid)),
    target: { reviewStatus: 'needs_review' },
    actor: 'guard',
    role: 'appeal',
    standard: 'strict-verbatim',
    basis: 'audit',
  };
  appendClaimProof(db, project.id, {
    claimType: 'relation',
    claimUid: uid,
    standard: 'sentence',
    outcome: 'verified',
    policyVersion: CURRENT_PROOF_POLICY_VERSION,
    gateVersion: SEMANTIC_GATE_POLICY_VERSION,
    fingerprints: stateOf(db, project.id, uid).fingerprints,
  });
  const result = transitionClaim(db, project.id, input);
  assert.equal(result.kind, 'stale');
  if (result.kind !== 'stale') return;
  assert.equal(result.reason, 'proof_version');
  assert.equal(relationRow(db, project.id, uid).review_status, 'provisional');
  assert.equal(proofCount(db, project.id, uid), 1);
  assert.equal(rulingCount(db, project.id), 0);
  db.close();
});

test('stale expected fingerprint returns stale and writes nothing', () => {
  const { db, project, uid } = setup();
  const input: TransitionClaimInput = {
    claim: { type: 'relation', uid },
    intent: 'administrative',
    expect: expectedOf(stateOf(db, project.id, uid)),
    target: { reviewStatus: 'needs_review' },
    actor: 'guard',
    role: 'appeal',
    standard: 'manual',
    basis: 'park',
  };
  db.run(
    "UPDATE canon_relation SET evidence = 'Asha distrusted Bram.' WHERE project_id = ? AND claim_uid = ?",
    project.id,
    uid,
  );
  const result = transitionClaim(db, project.id, input);
  assert.equal(result.kind, 'stale');
  if (result.kind !== 'stale') return;
  assert.equal(result.reason, 'fingerprint');
  assert.equal(relationRow(db, project.id, uid).review_status, 'provisional');
  assert.equal(proofCount(db, project.id, uid), 0);
  assert.equal(rulingCount(db, project.id), 0);
  db.close();
});

test('ruling insert failure rolls back status, authorization and proof', () => {
  const { db, project, uid } = setup();
  db.exec(`CREATE TRIGGER fail_ruling BEFORE INSERT ON canon_ruling
           BEGIN SELECT RAISE(ABORT, 'ruling blocked'); END`);
  assert.throws(
    () => transitionClaim(db, project.id, promotionInput(db, project.id, uid)),
    /ruling blocked/,
  );
  assert.deepEqual(relationRow(db, project.id, uid), {
    review_status: 'provisional',
    confirmed_by_user: 0,
  });
  assert.equal(proofCount(db, project.id, uid), 0);
  assert.equal(rulingCount(db, project.id), 0);
  db.exec('DROP TRIGGER fail_ruling');
  db.close();
});

test('proof append failure rolls back status and ruling', () => {
  const { db, project, uid } = setup();
  db.exec(`CREATE TRIGGER fail_proof BEFORE INSERT ON claim_proof
           BEGIN SELECT RAISE(ABORT, 'proof blocked'); END`);
  const result = rejected(transitionClaim(db, project.id, promotionInput(db, project.id, uid)));
  assert.equal(result.reason, 'proof_rejected');
  assert.match(result.detail, /proof blocked/);
  assert.deepEqual(relationRow(db, project.id, uid), {
    review_status: 'provisional',
    confirmed_by_user: 0,
  });
  assert.equal(proofCount(db, project.id, uid), 0);
  assert.equal(rulingCount(db, project.id), 0);
  db.exec('DROP TRIGGER fail_proof');
  db.close();
});

test('an attempt_seq collision is a typed conflict and rolls back the whole transition', () => {
  const { db, project, uid } = setup();
  db.exec(`CREATE TRIGGER collide_proof BEFORE INSERT ON claim_proof
           BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: claim_proof.project_id, claim_proof.claim_type, claim_proof.claim_uid, claim_proof.attempt_seq'); END`);
  const result = transitionClaim(db, project.id, promotionInput(db, project.id, uid));
  assert.equal(result.kind, 'conflict');
  if (result.kind !== 'conflict') return;
  assert.equal(result.reason, 'attempt_seq_taken');
  assert.equal(result.retryable, true);
  assert.deepEqual(relationRow(db, project.id, uid), {
    review_status: 'provisional',
    confirmed_by_user: 0,
  });
  assert.equal(proofCount(db, project.id, uid), 0);
  assert.equal(rulingCount(db, project.id), 0);
  db.exec('DROP TRIGGER collide_proof');
  db.close();
});

test('legacy accepted without proof remains accepted stored state, not source-attested', () => {
  const { db, project, uid } = setup({ status: 'accepted' });
  const state = stateOf(db, project.id, uid);
  assert.equal(state.reviewStatus, 'accepted');
  assert.equal(state.proofAttemptSeq, null);
  assert.equal(state.policyVersion, null);
  assert.equal(state.sourceProof, 'not_evaluated');
  assert.notEqual(state.sourceProof, 'verified');
  assert.equal(proofCount(db, project.id, uid), 0);
  db.close();
});

test('authorized-row demotion preserves authorization', () => {
  const { db, project, uid } = setup({ status: 'accepted', confirmedByUser: 1 });
  const state = stateOf(db, project.id, uid);
  assert.equal(state.authorization, 'user_confirmed');
  const result = applied(transitionClaim(db, project.id, {
    claim: { type: 'relation', uid },
    intent: 'demotion',
    expect: expectedOf(state),
    target: { reviewStatus: 'provisional' },
    actor: 'guard',
    role: 'appeal',
    standard: 'strict-verbatim',
    basis: 'failed audit',
  }));
  assert.equal(result.statusChanged, true);
  assert.equal(result.authorizationChanged, false);
  assert.deepEqual(relationRow(db, project.id, uid), {
    review_status: 'provisional',
    confirmed_by_user: 1,
  });
  const after = stateOf(db, project.id, uid);
  assert.equal(after.authorization, 'user_confirmed');
  assert.equal(after.sourceProof, 'not_evaluated');
  db.close();
});

test('a legacy user_confirmed row without the flag cannot lose authorization silently', () => {
  const { db, project, uid } = setup({ status: 'user_confirmed', confirmedByUser: 0 });
  const result = rejected(transitionClaim(db, project.id, {
    claim: { type: 'relation', uid },
    intent: 'demotion',
    expect: expectedOf(stateOf(db, project.id, uid)),
    target: { reviewStatus: 'needs_review' },
    actor: 'guard',
    role: 'appeal',
    standard: 'strict-verbatim',
    basis: 'audit',
  }));
  assert.equal(result.reason, 'authorization_would_be_lost');
  assert.deepEqual(relationRow(db, project.id, uid), {
    review_status: 'user_confirmed',
    confirmed_by_user: 0,
  });
  assert.equal(rulingCount(db, project.id), 0);
  db.close();
});

test('authorization-only confirmation never appends source proof', () => {
  const { db, project, uid } = setup({ status: 'needs_review' });
  const result = applied(transitionClaim(db, project.id, {
    claim: { type: 'relation', uid },
    intent: 'administrative',
    expect: expectedOf(stateOf(db, project.id, uid)),
    target: { authorization: 'user_confirmed' },
    actor: 'human',
    role: 'appeal',
    standard: 'manual',
    basis: 'user confirmed',
  }));
  assert.equal(result.statusChanged, false);
  assert.equal(result.authorizationChanged, true);
  assert.equal(result.proofAppended, false);
  assert.deepEqual(relationRow(db, project.id, uid), {
    review_status: 'needs_review',
    confirmed_by_user: 1,
  });
  assert.equal(proofCount(db, project.id, uid), 0);
  assert.equal(rulingCount(db, project.id), 1);
  assert.equal(stateOf(db, project.id, uid).sourceProof, 'not_evaluated');
  db.close();
});

test('entity and fact authorization requests are explicitly unsupported', () => {
  const { db, project } = setup();
  const entityUid = newClaimUid('entity');
  const entityId = db.run(
    `INSERT INTO canon_entity
       (project_id, claim_uid, kind, name, aliases, created_at, updated_at)
     VALUES (?, ?, 'character', 'Cora', '[]', ?, ?)`,
    project.id,
    entityUid,
    AT,
    AT,
  ).lastInsertRowid;
  const factUid = newClaimUid('fact');
  const factId = db.run(
    `INSERT INTO canon_fact
       (project_id, claim_uid, topic, statement, kind, certainty, subject, evidence, source_refs, created_at)
     VALUES (?, ?, 'topic', 'A fact.', 'fact', 'confirmed', 'Asha', '', '[]', ?)`,
    project.id,
    factUid,
    AT,
  ).lastInsertRowid;
  const dummy: ExpectedClaimState = {
    reviewStatus: 'accepted',
    authorization: 'none',
    proofAttemptSeq: null,
    policyVersion: null,
    fingerprints: {
      claimFingerprint: '',
      evidenceFingerprint: '',
      inputFingerprint: '',
      fingerprintVersion: '',
    },
  };
  for (const claim of [
    { type: 'entity', uid: entityUid } as ClaimRef,
    { type: 'fact', uid: factUid } as ClaimRef,
  ]) {
    const result = rejected(transitionClaim(db, project.id, {
      claim,
      intent: 'administrative',
      expect: dummy,
      target: { authorization: 'user_confirmed' },
      actor: 'human',
      role: 'appeal',
      standard: 'manual',
      basis: 'confirm',
    }));
    assert.equal(result.reason, 'unsupported_authorization');
  }
  for (const table of ['canon_entity', 'canon_fact']) {
    const columns = db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name);
    assert.equal(columns.includes('confirmed_by_user'), false, `${table} must not invent confirmed_by_user`);
  }
  assert.equal(db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', entityId)?.review_status, 'accepted');
  assert.equal(db.get<{ review_status: string }>('SELECT review_status FROM canon_fact WHERE id = ?', factId)?.review_status, 'accepted');
  assert.equal(rulingCount(db, project.id), 0);
  db.close();
});

test('shadow mode reports the proposed promotion and leaves every table unchanged', () => {
  const { db, project, uid } = setup();
  const changesBefore = db.get<{ n: number }>('SELECT total_changes() AS n')?.n ?? 0;
  const before = snapshotTables(db);
  const result = shadowTransitionClaim(db, project.id, promotionInput(db, project.id, uid));
  const after = snapshotTables(db);
  const changesAfter = db.get<{ n: number }>('SELECT total_changes() AS n')?.n ?? 0;

  assert.equal(changesAfter, changesBefore);
  assert.equal(result.mode, 'shadow');
  assert.equal(result.wouldApply, true);
  assert.equal(result.resultKind, 'applied');
  assert.deepEqual(result.differences.status, { from: 'provisional', to: 'accepted' });
  assert.equal(result.proposed.proofAppend?.attemptSeq, 1);
  assert.equal(result.proposed.proofAppend?.standard, 'sentence');
  assert.equal(result.proposed.ruling?.toStatus, 'accepted');
  assert.deepEqual(after, before);
  assert.equal(proofCount(db, project.id, uid), 0);
  assert.equal(rulingCount(db, project.id), 0);
  db.close();
});

test('shadow mode reports gate-required without writing', () => {
  const { db, project, uid } = setup();
  const before = snapshotTables(db);
  const input = promotionInput(db, project.id, uid);
  delete input.gateResult;
  const result = shadowTransitionClaim(db, project.id, input);
  const after = snapshotTables(db);
  assert.equal(result.wouldApply, false);
  assert.equal(result.resultKind, 'rejected');
  assert.match(result.policyViolations.join('\n'), /gate_required|verified gate result/);
  assert.deepEqual(after, before);
  db.close();
});

test('noop when the requested state is already current and no proof is supplied', () => {
  const { db, project, uid } = setup({ status: 'needs_review' });
  const result = transitionClaim(db, project.id, {
    claim: { type: 'relation', uid },
    intent: 'administrative',
    expect: expectedOf(stateOf(db, project.id, uid)),
    target: { reviewStatus: 'needs_review' },
    actor: 'guard',
    role: 'appeal',
    standard: 'manual',
    basis: 'no change',
  });
  assert.equal(result.kind, 'noop');
  assert.equal(proofCount(db, project.id, uid), 0);
  assert.equal(rulingCount(db, project.id), 0);
  db.close();
});

test('initial intent normalises to needs_review and cannot target accepted', () => {
  const { db, project, uid } = setup({ status: 'accepted' });
  const result = applied(transitionClaim(db, project.id, {
    claim: { type: 'relation', uid },
    intent: 'initial',
    expect: expectedOf(stateOf(db, project.id, uid)),
    target: { reviewStatus: 'needs_review' },
    actor: 'guard',
    role: 'appeal',
    standard: 'manual',
    basis: 'return to initial review',
  }));
  assert.equal(result.to.reviewStatus, 'needs_review');
  const invalid = rejected(transitionClaim(db, project.id, {
    claim: { type: 'relation', uid },
    intent: 'initial',
    expect: expectedOf(stateOf(db, project.id, uid)),
    target: { reviewStatus: 'accepted' },
    actor: 'guard',
    role: 'appeal',
    standard: 'manual',
    basis: 'bad initial target',
  }));
  assert.equal(invalid.reason, 'invalid_target');
  db.close();
});

test('two simultaneous promotions on separate connections: one applies, one is stale, one proof attempt', async () => {
  const { db, path, project, uid } = setup();
  const input = promotionInput(db, project.id, uid);
  db.close();

  const ready = new SharedArrayBuffer(4);
  const go = new SharedArrayBuffer(4);
  const results = [
    runTransitionWorker(path, project.id, input, ready, go),
    runTransitionWorker(path, project.id, input, ready, go),
  ];
  await waitForWorkers(ready, 2);
  Atomics.store(new Int32Array(go), 0, 1);
  Atomics.notify(new Int32Array(go), 0, 2);
  const settled = await Promise.all(results);

  const kinds = settled.map((entry) => entry.result.kind).sort();
  assert.deepEqual(kinds, ['applied', 'stale']);
  const stale = settled.find((entry) => entry.result.kind === 'stale')?.result;
  assert.equal(stale?.kind === 'stale' ? stale.targetAlreadyCurrent : false, true);

  const reopened = new Db(path);
  assert.equal(relationRow(reopened, project.id, uid).review_status, 'accepted');
  assert.equal(proofCount(reopened, project.id, uid), 1);
  const seq = reopened.get<{ attempt_seq: number }>(
    'SELECT attempt_seq FROM claim_proof WHERE project_id = ? AND claim_uid = ?',
    project.id,
    uid,
  );
  assert.equal(seq?.attempt_seq, 1);
  assert.equal(rulingCount(reopened, project.id), 1);
  reopened.close();
});

function snapshotTables(db: Db): Record<string, unknown[]> {
  const tables = db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const out: Record<string, unknown[]> = {};
  for (const table of tables) {
    out[table.name] = db.all(`SELECT * FROM "${table.name}"`);
  }
  return out;
}

interface WorkerMessage {
  ok: boolean;
  result?: TransitionResult;
  error?: string;
}

function runTransitionWorker(
  path: string,
  projectId: number,
  input: TransitionClaimInput,
  ready: SharedArrayBuffer,
  go: SharedArrayBuffer,
): Promise<WorkerMessage & { result: TransitionResult }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./helpers/transition-worker.ts', import.meta.url), {
      workerData: { path, projectId, input, ready, go },
    });
    worker.once('message', (message: WorkerMessage) => {
      if (!message.ok || !message.result) {
        reject(new Error(message.error ?? 'worker failed'));
        return;
      }
      resolve(message as WorkerMessage & { result: TransitionResult });
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`));
    });
  });
}

async function waitForWorkers(ready: SharedArrayBuffer, count: number): Promise<void> {
  const view = new Int32Array(ready);
  const started = Date.now();
  while (Atomics.load(view, 0) < count) {
    if (Date.now() - started > 5000) throw new Error('workers did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
