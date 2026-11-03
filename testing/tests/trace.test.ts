/**
 * Trace ledger and owner instrumentation.
 *
 * All writes are isolated to temp databases. Required events must ride the
 * owner transaction; diagnostics may drop but must never fail canon work.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
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
  type ExpectedClaimState,
  type RelationClaimState,
  type RelationGateResult,
  type TransitionClaimInput,
  type TransitionResult,
} from '../../fanfable/src/court/claim-transition.ts';
import {
  DIAGNOSTIC_MAX_EVENTS_CEILING,
  DIAGNOSTIC_MAX_EVENTS_PER_TRACE,
  TRACE_EVENT_APPLIED,
  TRACE_STAGE_COURT_TRANSITION,
  auditTrace,
  finishTrace,
  recordTraceEvent,
  showTrace,
  startTrace,
  type TraceContext,
  type TraceEventRecord,
} from '../../fanfable/src/trace/trace.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

interface SetupOptions {
  status?: string;
  confirmedByUser?: number;
}

function setup(options: SetupOptions = {}) {
  const { db, path } = tempDb();
  const project = controller.createProject(db, `trace-${Math.random().toString(36).slice(2, 7)}`);
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
  return { db, path, project, uid, id, chunkId };
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
  trace: TraceContext,
): TransitionClaimInput {
  const state = stateOf(db, projectId, uid);
  return {
    claim: { type: 'relation', uid },
    intent: 'promotion',
    expect: expectedOf(state),
    target: { reviewStatus: 'accepted' },
    gateResult: gateFor(db, projectId, uid),
    actor: 'guard',
    role: 'appeal',
    standard: 'sentence-proof',
    basis: 'trace test promotion',
    quote: 'Asha trusted Bram.',
    trace,
  };
}

function traceContext(traceId: string, spanId = 'sp-test'): TraceContext {
  return {
    traceId,
    spanId,
    parentSpanId: 'sp-parent',
    model: 'test-model',
    promptHash: 'hash-only',
    refs: { run_id: 7 },
  };
}

function applied(result: TransitionResult): Extract<TransitionResult, { kind: 'applied' }> {
  assert.equal(result.kind, 'applied', JSON.stringify(result));
  return result as Extract<TransitionResult, { kind: 'applied' }>;
}

function eventOf(db: Db, traceId: string, index = 0): TraceEventRecord {
  const view = showTrace(db, traceId);
  assert.ok(view, 'trace view');
  assert.ok(view.events[index], `event ${index}`);
  return view.events[index]!;
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

test('migration 30 adds the trace ledger and indexes', () => {
  const { db } = tempDb();
  assert.equal(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 30);
  const tables = db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('trace','trace_event')",
  ).map((row) => row.name);
  assert.deepEqual(tables.sort(), ['trace', 'trace_event']);
  const indexes = db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'trace%'",
  ).map((row) => row.name);
  for (const name of [
    'trace_project_started',
    'trace_event_trace_span',
    'trace_event_project_stage',
    'trace_event_subject',
    'trace_event_class',
    'trace_event_created',
  ]) {
    assert.ok(indexes.includes(name), name);
  }
  const columns = db.all<{ name: string }>('PRAGMA table_info(trace_event)').map((row) => row.name);
  for (const name of [
    'trace_id', 'span_id', 'parent_span_id', 'project_id', 'stage', 'event',
    'event_class', 'subject', 'decision', 'reason_code', 'refs', 'model',
    'prompt_hash', 'duration_ms', 'error', 'committed', 'created_at',
  ]) {
    assert.ok(columns.includes(name), `trace_event.${name}`);
  }
  db.close();
});

test('a required applied event commits with status, proof and ruling', () => {
  const { db, project, uid } = setup();
  const trace = startTrace(db, { projectId: project.id });
  const input = promotionInput(db, project.id, uid, traceContext(trace.id));
  const result = applied(transitionClaim(db, project.id, input));
  assert.equal(result.proofAppended, true);

  const event = eventOf(db, trace.id);
  assert.equal(event.eventClass, 'required');
  assert.equal(event.event, TRACE_EVENT_APPLIED);
  assert.equal(event.decision, 'applied');
  assert.equal(event.reasonCode, 'promotion_applied');
  assert.equal(event.committed, true);
  assert.equal(event.refs.claim_uid, uid);
  assert.ok(Number(event.refs.proof_id) > 0);
  assert.equal(event.refs.run_id, 7);
  assert.equal(proofCount(db, project.id, uid), 1);
  assert.equal(rulingCount(db, project.id), 1);

  finishTrace(db, trace.id);
  const view = showTrace(db, trace.id);
  assert.ok(view);
  assert.equal(view.trace.completeness, 'complete');
  assert.equal(view.trace.droppedEvents, 0);
  const audit = auditTrace(db, trace.id);
  assert.ok(audit);
  assert.equal(audit.completeness, 'complete');
  assert.equal(audit.exhaustive, true);
  assert.deepEqual(audit.violations, []);
  db.close();
});

test('a ruling failure rolls back status, proof and the required trace event', () => {
  const { db, project, uid } = setup();
  const trace = startTrace(db, { projectId: project.id });
  db.exec(`CREATE TRIGGER fail_ruling BEFORE INSERT ON canon_ruling
           BEGIN SELECT RAISE(ABORT, 'ruling blocked'); END`);
  assert.throws(
    () => transitionClaim(db, project.id, promotionInput(db, project.id, uid, traceContext(trace.id))),
    /ruling blocked/,
  );
  assert.equal(stateOf(db, project.id, uid).reviewStatus, 'provisional');
  assert.equal(proofCount(db, project.id, uid), 0);
  assert.equal(rulingCount(db, project.id), 0);
  const view = showTrace(db, trace.id);
  assert.ok(view);
  assert.equal(view.events.length, 0);
  db.exec('DROP TRIGGER fail_ruling');
  db.close();
});

test('a proof append failure rolls back status/ruling and records only a diagnostic rejection', () => {
  const { db, project, uid } = setup();
  const trace = startTrace(db, { projectId: project.id });
  db.exec(`CREATE TRIGGER fail_proof BEFORE INSERT ON claim_proof
           BEGIN SELECT RAISE(ABORT, 'proof blocked'); END`);
  const result = transitionClaim(db, project.id, promotionInput(db, project.id, uid, traceContext(trace.id)));
  assert.equal(result.kind, 'rejected');
  if (result.kind !== 'rejected') return;
  assert.equal(result.reason, 'proof_rejected');

  const event = eventOf(db, trace.id);
  assert.equal(event.eventClass, 'diagnostic');
  assert.equal(event.decision, 'rejected');
  assert.equal(event.reasonCode, 'proof_rejected');
  assert.equal(event.committed, false);
  assert.match(event.error, /proof blocked/);
  assert.equal(stateOf(db, project.id, uid).reviewStatus, 'provisional');
  assert.equal(proofCount(db, project.id, uid), 0);
  assert.equal(rulingCount(db, project.id), 0);
  db.exec('DROP TRIGGER fail_proof');
  db.close();
});

test('diagnostic sampling drops the event and marks the trace sampled', () => {
  const { db, project } = setup();
  const trace = startTrace(db, { projectId: project.id, sampledRate: 0 });
  const result = recordTraceEvent(db, {
    traceId: trace.id,
    projectId: project.id,
    spanId: 'sp-sampled',
    stage: 'test',
    event: 'test.diagnostic',
    eventClass: 'diagnostic',
  });
  assert.equal(result.recorded, false);
  assert.equal(result.dropped, true);
  assert.equal(result.reason, 'sampled');
  const view = showTrace(db, trace.id);
  assert.ok(view);
  assert.equal(view.trace.droppedEvents, 1);
  assert.equal(view.trace.completeness, 'sampled');
  finishTrace(db, trace.id);
  const audit = auditTrace(db, trace.id);
  assert.ok(audit);
  assert.equal(audit.completeness, 'sampled');
  assert.equal(audit.exhaustive, false);
  assert.ok(audit.suspicious.some((item) => item.code === 'trace_not_exhaustive'));
  db.close();
});

test('the diagnostic cap drops excess events and marks the trace truncated', () => {
  const { db, project } = setup();
  const trace = startTrace(db, { projectId: project.id });
  for (let i = 0; i < DIAGNOSTIC_MAX_EVENTS_PER_TRACE; i++) {
    const result = recordTraceEvent(db, {
      traceId: trace.id,
      projectId: project.id,
      spanId: `sp-cap-${i}`,
      stage: 'test',
      event: 'test.diagnostic',
      eventClass: 'diagnostic',
      subject: `subject-${i}`,
    });
    assert.equal(result.recorded, true, `event ${i}`);
  }
  const dropped = recordTraceEvent(db, {
    traceId: trace.id,
    projectId: project.id,
    spanId: 'sp-cap-overflow',
    stage: 'test',
    event: 'test.diagnostic',
    eventClass: 'diagnostic',
  });
  assert.equal(dropped.recorded, false);
  assert.equal(dropped.reason, 'cap');
  const view = showTrace(db, trace.id);
  assert.ok(view);
  assert.equal(view.events.length, DIAGNOSTIC_MAX_EVENTS_PER_TRACE);
  assert.equal(view.trace.droppedEvents, 1);
  assert.equal(view.trace.completeness, 'truncated');
  finishTrace(db, trace.id);
  const audit = auditTrace(db, trace.id);
  assert.ok(audit);
  assert.equal(audit.completeness, 'truncated');
  assert.equal(audit.exhaustive, false);
  db.close();
});

test('per-trace diagnostic caps are explicit, bounded and private', () => {
  const { db, project } = setup();
  const record = (traceId: string, index: number) =>
    recordTraceEvent(db, {
      traceId,
      projectId: project.id,
      spanId: `sp-cap-${index}`,
      stage: 'test',
      event: 'test.diagnostic',
      eventClass: 'diagnostic',
    });

  // Ordinary metadata cannot raise the cap.
  const metadataBypass = startTrace(db, {
    projectId: project.id,
    metadata: { diagnostic_max_events: 1 },
  });
  assert.equal(record(metadataBypass.id, 1).recorded, true);
  assert.equal(record(metadataBypass.id, 2).recorded, true);
  const bypassView = showTrace(db, metadataBypass.id);
  assert.equal(bypassView?.trace.metadata.diagnostic_max_events, undefined);

  // An explicit per-trace cap is honored.
  const capped = startTrace(db, { projectId: project.id, maxEvents: 3 });
  assert.equal(record(capped.id, 1).recorded, true);
  assert.equal(record(capped.id, 2).recorded, true);
  assert.equal(record(capped.id, 3).recorded, true);
  const dropped = record(capped.id, 4);
  assert.equal(dropped.recorded, false);
  assert.equal(dropped.reason, 'cap');
  assert.equal(showTrace(db, capped.id)?.trace.metadata.diagnostic_max_events, 3);

  // An oversized explicit request is clamped to the hard ceiling.
  const huge = startTrace(db, {
    projectId: project.id,
    maxEvents: DIAGNOSTIC_MAX_EVENTS_CEILING + 100,
  });
  assert.equal(
    showTrace(db, huge.id)?.trace.metadata.diagnostic_max_events,
    DIAGNOSTIC_MAX_EVENTS_CEILING,
  );
  db.close();
});

test('diagnostic retention prunes old events and records the drop', () => {
  const { db, project } = setup();
  const trace = startTrace(db, { projectId: project.id });
  const old = new Date(Date.now() - 31 * 86400000).toISOString();
  const first = recordTraceEvent(db, {
    traceId: trace.id,
    projectId: project.id,
    spanId: 'sp-old',
    stage: 'test',
    event: 'test.old',
    eventClass: 'diagnostic',
    createdAt: old,
  });
  assert.equal(first.recorded, true);
  const second = recordTraceEvent(db, {
    traceId: trace.id,
    projectId: project.id,
    spanId: 'sp-new',
    stage: 'test',
    event: 'test.new',
    eventClass: 'diagnostic',
  });
  assert.equal(second.recorded, true);
  assert.equal(second.pruned, 1);
  const view = showTrace(db, trace.id);
  assert.ok(view);
  assert.equal(view.events.length, 1);
  assert.equal(view.trace.droppedEvents, 1);
  assert.equal(view.trace.completeness, 'truncated');
  db.close();
});

test('shadow mode writes no trace rows even with a trace context', () => {
  const { db, project, uid } = setup();
  const trace = startTrace(db, { projectId: project.id });
  const result = shadowTransitionClaim(db, project.id, promotionInput(db, project.id, uid, traceContext(trace.id)));
  assert.equal(result.wouldApply, true);
  const view = showTrace(db, trace.id);
  assert.ok(view);
  assert.equal(view.events.length, 0);
  assert.equal(view.trace.droppedEvents, 0);
  assert.equal(view.trace.completeness, 'complete');
  db.close();
});

test('owner outcomes carry the right class, reason and committed flag', () => {
  const cases: {
    name: string;
    status: string;
    run: (db: Db, projectId: number, uid: string, trace: TraceContext) => TransitionResult;
    decision: string;
    reason: string;
    eventClass: 'required' | 'diagnostic';
    committed: boolean;
  }[] = [
    {
      name: 'noop',
      status: 'needs_review',
      run: (db, projectId, uid, trace) => {
        const state = stateOf(db, projectId, uid);
        return transitionClaim(db, projectId, {
          claim: { type: 'relation', uid },
          intent: 'administrative',
          expect: expectedOf(state),
          target: { reviewStatus: 'needs_review' },
          actor: 'guard',
          role: 'appeal',
          standard: 'manual',
          basis: 'no change',
          trace,
        });
      },
      decision: 'noop',
      reason: 'already_in_target',
      eventClass: 'diagnostic',
      committed: false,
    },
    {
      name: 'stale',
      status: 'provisional',
      run: (db, projectId, uid, trace) => {
        const state = stateOf(db, projectId, uid);
        const input: TransitionClaimInput = {
          claim: { type: 'relation', uid },
          intent: 'administrative',
          expect: expectedOf(state),
          target: { reviewStatus: 'needs_review' },
          actor: 'guard',
          role: 'appeal',
          standard: 'manual',
          basis: 'park',
          trace,
        };
        db.run("UPDATE canon_relation SET review_status = 'accepted' WHERE project_id = ? AND claim_uid = ?", projectId, uid);
        return transitionClaim(db, projectId, input);
      },
      decision: 'stale',
      reason: 'stale_status',
      eventClass: 'diagnostic',
      committed: false,
    },
    {
      name: 'conflict',
      status: 'provisional',
      run: (db, projectId, uid, trace) => {
        db.exec(`CREATE TRIGGER collide_trace_proof BEFORE INSERT ON claim_proof
                 BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: claim_proof.project_id, claim_proof.claim_type, claim_proof.claim_uid, claim_proof.attempt_seq'); END`);
        const result = transitionClaim(db, projectId, promotionInput(db, projectId, uid, trace));
        db.exec('DROP TRIGGER collide_trace_proof');
        return result;
      },
      decision: 'conflict',
      reason: 'conflict_attempt_seq_taken',
      eventClass: 'diagnostic',
      committed: false,
    },
    {
      name: 'rejected',
      status: 'provisional',
      run: (db, projectId, uid, trace) => {
        const input = promotionInput(db, projectId, uid, trace);
        delete input.gateResult;
        return transitionClaim(db, projectId, input);
      },
      decision: 'rejected',
      reason: 'gate_required',
      eventClass: 'diagnostic',
      committed: false,
    },
  ];

  for (const entry of cases) {
    const { db, project, uid } = setup({ status: entry.status });
    const trace = startTrace(db, { projectId: project.id });
    const result = entry.run(db, project.id, uid, traceContext(trace.id));
    assert.equal(result.kind, entry.decision, entry.name);
    const event = eventOf(db, trace.id);
    assert.equal(event.eventClass, entry.eventClass, entry.name);
    assert.equal(event.decision, entry.decision, entry.name);
    assert.equal(event.reasonCode, entry.reason, entry.name);
    assert.equal(event.committed, entry.committed, entry.name);
    db.close();
  }
});

test('an applied authorization-only event is required but has no proof reference', () => {
  const { db, project, uid } = setup({ status: 'needs_review' });
  const trace = startTrace(db, { projectId: project.id });
  const state = stateOf(db, project.id, uid);
  const result = applied(transitionClaim(db, project.id, {
    claim: { type: 'relation', uid },
    intent: 'administrative',
    expect: expectedOf(state),
    target: { authorization: 'user_confirmed' },
    actor: 'human',
    role: 'appeal',
    standard: 'manual',
    basis: 'user confirmed',
    trace: traceContext(trace.id),
  }));
  assert.equal(result.proofAppended, false);
  const event = eventOf(db, trace.id);
  assert.equal(event.eventClass, 'required');
  assert.equal(event.reasonCode, 'authorization_applied');
  assert.equal(event.refs.claim_uid, uid);
  assert.equal(event.refs.proof_id, undefined);
  db.close();
});

test('trace completeness survives show and audit for interrupted and sampled traces', () => {
  const { db, project } = setup();
  const interrupted = startTrace(db, { projectId: project.id });
  finishTrace(db, interrupted.id, { interrupted: true });
  const interruptedShow = showTrace(db, interrupted.id);
  assert.ok(interruptedShow);
  assert.equal(interruptedShow.trace.completeness, 'interrupted');
  const interruptedAudit = auditTrace(db, interrupted.id);
  assert.ok(interruptedAudit);
  assert.equal(interruptedAudit.completeness, 'interrupted');
  assert.equal(interruptedAudit.exhaustive, false);
  db.close();
});

test('audit detects a promotion event without a verified proof', () => {
  const { db, project, uid } = setup({ status: 'accepted' });
  const trace = startTrace(db, { projectId: project.id });
  recordTraceEvent(db, {
    traceId: trace.id,
    projectId: project.id,
    spanId: 'sp-promotion',
    stage: TRACE_STAGE_COURT_TRANSITION,
    event: TRACE_EVENT_APPLIED,
    eventClass: 'required',
    subject: `claim:relation:${uid}`,
    decision: 'applied',
    reasonCode: 'promotion_applied',
    refs: { claim_uid: uid },
    committed: true,
  });
  finishTrace(db, trace.id);
  const audit = auditTrace(db, trace.id);
  assert.ok(audit);
  assert.equal(audit.completeness, 'complete');
  assert.ok(audit.violations.some((item) => item.code === 'promotion_without_verified_proof'));
  db.close();
});

test('audit detects a verified proof with no required event in the trace window', () => {
  const { db, project, uid } = setup({ status: 'accepted' });
  const trace = startTrace(db, { projectId: project.id });
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
  finishTrace(db, trace.id);
  const audit = auditTrace(db, trace.id);
  assert.ok(audit);
  assert.equal(audit.completeness, 'complete');
  assert.ok(audit.violations.some((item) => item.code === 'missing_required_event' && item.claimUid === uid));
  db.close();
});

test('audit detects an owner attempt with no terminal outcome', () => {
  const { db, project } = setup();
  const trace = startTrace(db, { projectId: project.id });
  recordTraceEvent(db, {
    traceId: trace.id,
    projectId: project.id,
    spanId: 'sp-unterminated',
    stage: TRACE_STAGE_COURT_TRANSITION,
    event: 'claim.transition.stale',
    eventClass: 'diagnostic',
    decision: '',
    reasonCode: '',
    committed: false,
  });
  finishTrace(db, trace.id);
  const audit = auditTrace(db, trace.id);
  assert.ok(audit);
  assert.ok(audit.violations.some((item) => item.code === 'missing_terminal_outcome'));
  assert.ok(audit.suspicious.some((item) => item.code === 'diagnostic_without_reason'));
  db.close();
});

test('diagnostic recorder failure does not fail the owner decision', () => {
  const { db, project, uid } = setup({ status: 'needs_review' });
  const trace = startTrace(db, { projectId: project.id });
  db.exec(`CREATE TRIGGER fail_trace_event BEFORE INSERT ON trace_event
           BEGIN SELECT RAISE(ABORT, 'trace blocked'); END`);
  const state = stateOf(db, project.id, uid);
  const result = transitionClaim(db, project.id, {
    claim: { type: 'relation', uid },
    intent: 'administrative',
    expect: expectedOf(state),
    target: { reviewStatus: 'needs_review' },
    actor: 'guard',
    role: 'appeal',
    standard: 'manual',
    basis: 'noop',
    trace: traceContext(trace.id),
  });
  assert.equal(result.kind, 'noop');
  const view = showTrace(db, trace.id);
  assert.ok(view);
  assert.equal(view.events.length, 0);
  assert.equal(view.trace.droppedEvents, 1);
  assert.equal(view.trace.completeness, 'truncated');
  db.exec('DROP TRIGGER fail_trace_event');
  db.close();
});

test('required recorder failure rolls back an applied owner transition', () => {
  const { db, project, uid } = setup();
  const trace = startTrace(db, { projectId: project.id });
  db.exec(`CREATE TRIGGER fail_trace_event_required BEFORE INSERT ON trace_event
           BEGIN SELECT RAISE(ABORT, 'trace blocked'); END`);
  assert.throws(
    () => transitionClaim(db, project.id, promotionInput(db, project.id, uid, traceContext(trace.id))),
    /trace blocked/,
  );
  assert.equal(stateOf(db, project.id, uid).reviewStatus, 'provisional');
  assert.equal(proofCount(db, project.id, uid), 0);
  assert.equal(rulingCount(db, project.id), 0);
  db.exec('DROP TRIGGER fail_trace_event_required');
  db.close();
});

test('trace show and audit work through the CLI on a temp database', () => {
  const { db, path, project, uid } = setup();
  const trace = startTrace(db, { projectId: project.id });
  applied(transitionClaim(db, project.id, promotionInput(db, project.id, uid, traceContext(trace.id))));
  finishTrace(db, trace.id);
  db.close();

  const cli = resolve(import.meta.dirname, '../../fanfable/src/cli.ts');
  const showJson = execFileSync(
    process.execPath,
    ['--no-warnings', cli, '--db', path, 'trace', 'show', trace.id, '--json'],
    { encoding: 'utf8' },
  );
  const show = JSON.parse(showJson) as {
    trace: { completeness: string; droppedEvents: number };
    events: { eventClass: string; committed: boolean }[];
  };
  assert.equal(show.trace.completeness, 'complete');
  assert.equal(show.trace.droppedEvents, 0);
  assert.equal(show.events.length, 1);
  assert.equal(show.events[0]!.eventClass, 'required');
  assert.equal(show.events[0]!.committed, true);

  const showText = execFileSync(
    process.execPath,
    ['--no-warnings', cli, '--db', path, 'trace', 'show', trace.id],
    { encoding: 'utf8' },
  );
  assert.match(showText, /completeness: complete/);
  assert.match(showText, /\[required\]/);

  const auditJson = execFileSync(
    process.execPath,
    ['--no-warnings', cli, '--db', path, 'trace', 'audit', trace.id, '--json'],
    { encoding: 'utf8' },
  );
  const audit = JSON.parse(auditJson) as {
    completeness: string;
    exhaustive: boolean;
    violations: unknown[];
    checks: string[];
  };
  assert.equal(audit.completeness, 'complete');
  assert.equal(audit.exhaustive, true);
  assert.deepEqual(audit.violations, []);
  assert.ok(audit.checks.length > 0);

  const auditText = execFileSync(
    process.execPath,
    ['--no-warnings', cli, '--db', path, 'trace', 'audit', trace.id],
    { encoding: 'utf8' },
  );
  assert.match(auditText, /Provable violations/);
  assert.match(auditText, /completeness: complete/);
});
