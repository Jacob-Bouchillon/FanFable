/**
 * Relation claim status owner, first slice.
 *
 * This module owns the compare-and-set transition for an existing relation
 * claim: stored review status, derived user authorization, the latest proof
 * attempt sequence and the current claim fingerprint. A real transition is one
 * immediate SQLite transaction covering the status/authorization update, an
 * optional proof append and the court ruling.
 *
 * The owner does not evaluate evidence. A promotion needs an explicit target
 * and an explicit verified gate result whose fingerprints still match the
 * claim. A proof row alone never causes a promotion. Legacy accepted rows with
 * no proof remain accepted stored state; they are reported as not evaluated,
 * never as source-attested.
 *
 * Shadow mode uses the same validation and planning code without opening a
 * write transaction, without appending proof and without recording a ruling.
 * It must remain strictly read-only.
 */
import { Db } from '../core/db.ts';
import {
  CURRENT_PROOF_POLICY_VERSION,
  SEMANTIC_GATE_POLICY_VERSION,
  STORED_PROOF_OUTCOMES,
  appendClaimProof,
  computeClaimFingerprints,
  resolveClaimProof,
  type ClaimFingerprints,
  type ClaimType,
  type ProofStandard,
  type StoredProofOutcome,
} from './claim-proof.ts';
import { recordRuling, type RulingActor, type RulingRole } from './ruling.ts';
import {
  TRACE_EVENT_APPLIED,
  TRACE_EVENT_CONFLICT,
  TRACE_EVENT_NOOP,
  TRACE_EVENT_REJECTED,
  TRACE_EVENT_STALE,
  TRACE_STAGE_COURT_TRANSITION,
  recordTraceEvent,
  type TraceContext,
} from '../trace/trace.ts';

export type TransitionIntent = 'initial' | 'promotion' | 'demotion' | 'administrative';
export type Authorization = 'none' | 'user_confirmed';

export interface ClaimRef {
  type: ClaimType;
  uid: string;
}

/** The exact state a caller read before asking for a transition. */
export interface ExpectedClaimState {
  reviewStatus: string;
  authorization: Authorization;
  /** Latest stored attempt_seq, or null when the claim has no proof rows. */
  proofAttemptSeq: number | null;
  /** Policy version on the latest proof row, or null when there is no proof. */
  policyVersion: string | null;
  fingerprints: ClaimFingerprints;
}

export interface TransitionTarget {
  /** Omit for an authorization-only or proof-only transition. */
  reviewStatus?: string;
  /** Only none -> user_confirmed is allowed. */
  authorization?: Authorization;
  /** Removal is deliberately outside this slice; passing true is rejected. */
  remove?: boolean;
}

/** The gate's decision, passed explicitly by the caller. It is not evidence. */
export interface RelationGateResult {
  outcome: StoredProofOutcome;
  standard: ProofStandard;
  policyVersion: string;
  gateVersion: string;
  fingerprints: ClaimFingerprints;
  checkedAt?: string | null;
  proofRunId?: number | null;
  quoteHash?: string;
  detail?: string;
}

export interface TransitionClaimInput {
  claim: ClaimRef;
  intent: TransitionIntent;
  expect: ExpectedClaimState;
  target: TransitionTarget;
  gateResult?: RelationGateResult;
  actor: RulingActor;
  role: RulingRole;
  /** The ruling standard, e.g. sentence-proof, strict-verbatim, manual. */
  standard: string;
  basis: string;
  quote?: string;
  /**
   * Optional trace/span. A real applied transition writes a required event in
   * the same transaction. Shadow evaluation ignores this context entirely.
   */
  trace?: TraceContext;
}

export interface ClaimStateSnapshot {
  reviewStatus: string;
  authorization: Authorization;
  confirmedByUser: boolean;
  proofAttemptSeq: number | null;
  policyVersion: string | null;
}

export interface RelationClaimState extends ClaimStateSnapshot {
  claimType: 'relation';
  claimUid: string;
  claimId: number;
  fingerprints: ClaimFingerprints;
  /** Effective proof after fingerprint/policy checks; never inferred from status. */
  sourceProof: 'verified' | 'failed' | 'not_evaluated' | 'legacy_unknown' | 'stale' | 'unavailable';
  sourceProofReason: string;
}

export type StaleReason =
  | 'status'
  | 'authorization'
  | 'proof_version'
  | 'fingerprint'
  | 'claim_missing';

export type TransitionRejectionReason =
  | 'unsupported_claim_type'
  | 'unsupported_authorization'
  | 'removal_out_of_scope'
  | 'invalid_target'
  | 'authorization_regression'
  | 'authorization_would_be_lost'
  | 'gate_required'
  | 'gate_not_verified'
  | 'gate_standard_mismatch'
  | 'gate_fingerprint_mismatch'
  | 'gate_policy_mismatch'
  | 'invalid_proof_standard'
  | 'invalid_proof_outcome'
  | 'verified_without_promotion'
  | 'proof_rejected';

export interface AppliedTransition {
  kind: 'applied';
  claim: ClaimRef;
  from: ClaimStateSnapshot;
  to: ClaimStateSnapshot;
  statusChanged: boolean;
  authorizationChanged: boolean;
  proofAppended: boolean;
  proofAttemptSeq: number | null;
  rulingId: number;
}

export interface NoopTransition {
  kind: 'noop';
  reason: 'already_in_target';
  current: RelationClaimState;
}

export interface StaleTransition {
  kind: 'stale';
  reason: StaleReason;
  current?: RelationClaimState;
  targetAlreadyCurrent: boolean;
}

export interface ConflictTransition {
  kind: 'conflict';
  reason: 'attempt_seq_taken' | 'write_race';
  current: RelationClaimState;
  retryable: true;
}

export interface RejectedTransition {
  kind: 'rejected';
  reason: TransitionRejectionReason;
  detail: string;
  current?: RelationClaimState;
}

export type TransitionResult =
  | AppliedTransition
  | NoopTransition
  | StaleTransition
  | ConflictTransition
  | RejectedTransition;

export interface ShadowDifference<T> {
  from: T;
  to: T;
}

export interface ShadowTransitionResult {
  mode: 'shadow';
  claim: ClaimRef;
  current: RelationClaimState | null;
  proposed: {
    intent: TransitionIntent;
    reviewStatus: string;
    authorization: Authorization;
    proofAppend: {
      attemptSeq: number;
      standard: ProofStandard;
      outcome: StoredProofOutcome;
      policyVersion: string;
    } | null;
    ruling: {
      role: RulingRole;
      actor: RulingActor;
      standard: string;
      fromStatus: string;
      toStatus: string;
    } | null;
  };
  wouldApply: boolean;
  resultKind: 'applied' | 'noop' | 'stale' | 'rejected';
  resultReason?: string;
  policyViolations: string[];
  policyNotes: string[];
  differences: {
    status: ShadowDifference<string> | null;
    authorization: ShadowDifference<Authorization> | null;
    proof: { fromSeq: number | null; toSeq: number; outcome: StoredProofOutcome } | null;
    ruling: boolean;
  };
  note: 'shadow mode performed no writes';
}

const RELATION_STATUSES = new Set(['accepted', 'provisional', 'attested', 'needs_review', 'user_confirmed']);
const RELATION_STANDARDS = new Set<ProofStandard>(['sentence', 'passage', 'none']);
const STORED_OUTCOMES = new Set<string>(STORED_PROOF_OUTCOMES);
const RANK: Record<string, number> = {
  needs_review: 0,
  provisional: 1,
  attested: 2,
  accepted: 3,
  user_confirmed: 3,
  rejected: 0,
  quarantined: 0,
};

interface RelationRow {
  id: number;
  claim_uid: string | null;
  review_status: string | null;
  confirmed_by_user: number | null;
}

interface Rejection {
  kind: 'rejected';
  reason: TransitionRejectionReason;
  detail: string;
  current?: RelationClaimState;
}

interface Noop {
  kind: 'noop';
  reason: 'already_in_target';
  current: RelationClaimState;
}

interface Plan {
  kind: 'apply';
  nextStatus: string;
  nextConfirmedByUser: boolean;
  statusChanged: boolean;
  authChanged: boolean;
  gate: RelationGateResult | null;
}

type PlanOutcome = Plan | Noop | Rejection;

class AttemptConflictError extends Error {}
class ProofRejectedError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.detail = detail;
  }
}
class WriteRaceError extends Error {}

function reject(
  reason: TransitionRejectionReason,
  detail: string,
  current?: RelationClaimState,
): Rejection {
  return current ? { kind: 'rejected', reason, detail, current } : { kind: 'rejected', reason, detail };
}

function authorizationOf(status: string, confirmedByUser: boolean): Authorization {
  return confirmedByUser || status === 'user_confirmed' ? 'user_confirmed' : 'none';
}

function snapshot(state: RelationClaimState): ClaimStateSnapshot {
  return {
    reviewStatus: state.reviewStatus,
    authorization: state.authorization,
    confirmedByUser: state.confirmedByUser,
    proofAttemptSeq: state.proofAttemptSeq,
    policyVersion: state.policyVersion,
  };
}

function sameFingerprints(a: ClaimFingerprints | undefined, b: ClaimFingerprints | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.fingerprintVersion === b.fingerprintVersion &&
    a.claimFingerprint === b.claimFingerprint &&
    a.evidenceFingerprint === b.evidenceFingerprint &&
    a.inputFingerprint === b.inputFingerprint
  );
}

function targetAlreadyCurrent(current: RelationClaimState, target: TransitionTarget): boolean {
  const statusOk = target.reviewStatus === undefined || target.reviewStatus === current.reviewStatus;
  const authOk = target.authorization === undefined || target.authorization === current.authorization;
  return statusOk && authOk;
}

/** Read the current relation state. Strictly read-only. */
export function readRelationClaimState(
  db: Db,
  projectId: number,
  claimUid: string,
): RelationClaimState | null {
  const row = db.get<RelationRow>(
    `SELECT id, claim_uid, review_status, confirmed_by_user
       FROM canon_relation
      WHERE project_id = ? AND claim_uid = ?`,
    projectId,
    claimUid,
  );
  if (!row) return null;
  const fingerprints = computeClaimFingerprints(db, projectId, 'relation', claimUid);
  if (!fingerprints) return null;
  const latest = db.get<{ attempt_seq: number; policy_version: string }>(
    `SELECT attempt_seq, policy_version
       FROM claim_proof
      WHERE project_id = ? AND claim_type = 'relation' AND claim_uid = ?
      ORDER BY attempt_seq DESC, id DESC
      LIMIT 1`,
    projectId,
    claimUid,
  );
  const proof = resolveClaimProof(db, projectId, 'relation', claimUid);
  const reviewStatus = String(row.review_status ?? '');
  const confirmedByUser = Number(row.confirmed_by_user ?? 0) === 1;
  return {
    claimType: 'relation',
    claimUid,
    claimId: row.id,
    reviewStatus,
    confirmedByUser,
    authorization: authorizationOf(reviewStatus, confirmedByUser),
    proofAttemptSeq: latest ? Number(latest.attempt_seq) : null,
    policyVersion: latest ? String(latest.policy_version) : null,
    fingerprints,
    sourceProof: proof.effective,
    sourceProofReason: proof.reason,
  };
}

function staleReason(
  current: RelationClaimState,
  expected: ExpectedClaimState,
): StaleReason | null {
  if (current.reviewStatus !== expected.reviewStatus) return 'status';
  if (current.authorization !== expected.authorization) return 'authorization';
  if (current.proofAttemptSeq !== (expected.proofAttemptSeq ?? null)) return 'proof_version';
  if (current.policyVersion !== (expected.policyVersion ?? null)) return 'proof_version';
  if (!sameFingerprints(current.fingerprints, expected.fingerprints)) return 'fingerprint';
  return null;
}

function preValidate(input: TransitionClaimInput): Rejection | null {
  if (input.claim.type !== 'relation') {
    if (input.target.authorization !== undefined) {
      return reject(
        'unsupported_authorization',
        `${input.claim.type} authorization is not stored; confirmed_by_user exists only on canon_relation`,
      );
    }
    return reject('unsupported_claim_type', `status owner supports relation claims in this slice, not ${input.claim.type}`);
  }
  if (!input.target || typeof input.target !== 'object') {
    return reject('invalid_target', 'target is required');
  }
  if (input.target.remove === true) {
    return reject('removal_out_of_scope', 'removal is outside the first relation-owner slice');
  }
  if (input.target.authorization === 'none') {
    return reject('authorization_regression', 'authorization can only move from none to user_confirmed');
  }
  if (input.target.authorization !== undefined && input.target.authorization !== 'user_confirmed') {
    return reject('invalid_target', `unknown authorization target: ${String(input.target.authorization)}`);
  }
  if (input.target.reviewStatus === undefined && input.target.authorization === undefined) {
    return reject('invalid_target', 'target must name a status, an authorization, or both');
  }
  if (input.target.reviewStatus !== undefined) {
    if (input.target.reviewStatus === 'user_confirmed') {
      return reject('invalid_target', 'user_confirmed is an authorization state; new writes use confirmed_by_user');
    }
    if (!RELATION_STATUSES.has(input.target.reviewStatus)) {
      return reject('invalid_target', `unsupported relation review status: ${input.target.reviewStatus}`);
    }
  }

  switch (input.intent) {
    case 'initial':
      if (input.target.reviewStatus !== 'needs_review' || input.target.authorization !== undefined || input.gateResult) {
        return reject('invalid_target', 'initial intent may only target needs_review with no authorization or gate result');
      }
      break;
    case 'promotion':
      if (input.target.reviewStatus !== 'accepted' && input.target.reviewStatus !== 'attested') {
        return reject('invalid_target', 'promotion must explicitly target accepted or attested');
      }
      if (input.target.authorization !== undefined) {
        return reject('invalid_target', 'promotion is a source-proof decision, not an authorization decision');
      }
      break;
    case 'demotion':
      if (input.target.reviewStatus !== 'provisional' && input.target.reviewStatus !== 'needs_review') {
        return reject('invalid_target', 'demotion must target provisional or needs_review');
      }
      if (input.target.authorization !== undefined) {
        return reject('invalid_target', 'demotion is a source-proof decision, not an authorization decision');
      }
      break;
    case 'administrative':
      if (
        input.target.reviewStatus !== undefined &&
        input.target.reviewStatus !== 'needs_review' &&
        input.target.reviewStatus !== 'provisional'
      ) {
        return reject('invalid_target', 'administrative changes may not target accepted or attested');
      }
      break;
    default:
      return reject('invalid_target', `unknown transition intent: ${String(input.intent)}`);
  }
  return null;
}

function validateGate(
  gate: RelationGateResult,
  current: RelationClaimState,
  input: TransitionClaimInput,
): Rejection | null {
  if (!RELATION_STANDARDS.has(gate.standard)) {
    return reject('invalid_proof_standard', `standard ${gate.standard} is not valid for a relation claim`);
  }
  if (!STORED_OUTCOMES.has(gate.outcome)) {
    return reject('invalid_proof_outcome', `unknown proof outcome: ${String(gate.outcome)}`);
  }
  if (gate.policyVersion !== CURRENT_PROOF_POLICY_VERSION) {
    return reject('gate_policy_mismatch', `gate policy ${gate.policyVersion} is not ${CURRENT_PROOF_POLICY_VERSION}`);
  }
  if (gate.gateVersion !== SEMANTIC_GATE_POLICY_VERSION) {
    return reject('gate_policy_mismatch', `gate version ${gate.gateVersion} is not ${SEMANTIC_GATE_POLICY_VERSION}`);
  }
  if (!sameFingerprints(gate.fingerprints, current.fingerprints)) {
    return reject('gate_fingerprint_mismatch', 'gate fingerprints do not match the current claim');
  }
  if (input.intent !== 'promotion' && gate.outcome === 'verified') {
    return reject('verified_without_promotion', 'a verified gate result must be paired with an explicit promotion target');
  }
  if (input.intent === 'promotion') {
    if (gate.outcome !== 'verified') {
      return reject('gate_not_verified', `promotion requires a verified gate result, not ${gate.outcome}`);
    }
    const required: ProofStandard = input.target.reviewStatus === 'attested' ? 'passage' : 'sentence';
    if (gate.standard !== required) {
      return reject(
        'gate_standard_mismatch',
        `${String(input.target.reviewStatus)} promotion requires ${required} proof, not ${gate.standard}`,
      );
    }
  }
  return null;
}

function planTransition(current: RelationClaimState, input: TransitionClaimInput): PlanOutcome {
  const targetStatus = input.target.reviewStatus;
  const nextStatus = targetStatus ?? current.reviewStatus;
  const nextConfirmedByUser = input.target.authorization === 'user_confirmed' ? true : current.confirmedByUser;
  const statusChanged = targetStatus !== undefined && targetStatus !== current.reviewStatus;
  const authChanged = input.target.authorization === 'user_confirmed' && !current.confirmedByUser;
  const gate = input.gateResult ?? null;

  if (statusChanged && current.reviewStatus === 'user_confirmed' && !current.confirmedByUser && !authChanged) {
    return reject(
      'authorization_would_be_lost',
      'moving a legacy user_confirmed row without confirming it would erase the only authorization record',
      current,
    );
  }

  if (gate) {
    const invalid = validateGate(gate, current, input);
    if (invalid) return { ...invalid, current };
  }

  const currentRank = RANK[current.reviewStatus] ?? 0;
  const nextRank = RANK[nextStatus] ?? 0;

  if (input.intent === 'promotion') {
    if (current.reviewStatus === 'user_confirmed') {
      return reject('invalid_target', 'user_confirmed is an authorization state, not a promotion tier', current);
    }
    if (nextRank < currentRank) {
      return reject('invalid_target', `promotion may not lower ${current.reviewStatus} to ${nextStatus}`, current);
    }
    if (!gate) {
      return reject('gate_required', 'promotion requires an explicit verified gate result', current);
    }
  } else if (input.intent === 'demotion') {
    if (nextRank > currentRank) {
      return reject('invalid_target', `demotion may not raise ${current.reviewStatus} to ${nextStatus}`, current);
    }
  } else if (input.intent === 'administrative') {
    if (nextRank > currentRank) {
      return reject('invalid_target', `administrative change may not raise ${current.reviewStatus} to ${nextStatus}`, current);
    }
  }

  if (!statusChanged && !authChanged && !gate) {
    return { kind: 'noop', reason: 'already_in_target', current };
  }

  return {
    kind: 'apply',
    nextStatus,
    nextConfirmedByUser,
    statusChanged,
    authChanged,
    gate,
  };
}

function isAttemptConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed: claim_proof\./.test(message);
}

function appendGateProof(
  db: Db,
  projectId: number,
  uid: string,
  gate: RelationGateResult,
): { id: number; attemptSeq: number } {
  try {
    const appended = appendClaimProof(db, projectId, {
      claimType: 'relation',
      claimUid: uid,
      standard: gate.standard,
      outcome: gate.outcome,
      policyVersion: gate.policyVersion,
      gateVersion: gate.gateVersion,
      checkedAt: gate.checkedAt,
      proofRunId: gate.proofRunId,
      quoteHash: gate.quoteHash,
      detail: gate.detail,
      fingerprints: gate.fingerprints,
    });
    return { id: appended.id, attemptSeq: appended.attemptSeq };
  } catch (error) {
    if (isAttemptConflict(error)) throw new AttemptConflictError();
    throw new ProofRejectedError(error instanceof Error ? error.message : String(error));
  }
}

function runTransition(
  db: Db,
  projectId: number,
  input: TransitionClaimInput,
): TransitionResult {
  const current = readRelationClaimState(db, projectId, input.claim.uid);
  if (!current) {
    return { kind: 'stale', reason: 'claim_missing', targetAlreadyCurrent: false };
  }
  const stale = staleReason(current, input.expect);
  if (stale) {
    return {
      kind: 'stale',
      reason: stale,
      current,
      targetAlreadyCurrent: targetAlreadyCurrent(current, input.target),
    };
  }
  const plan = planTransition(current, input);
  if (plan.kind === 'noop' || plan.kind === 'rejected') return plan;

  const result = db.run(
    `UPDATE canon_relation
        SET review_status = ?, confirmed_by_user = ?
      WHERE project_id = ? AND id = ?
        AND review_status = ?
        AND COALESCE(confirmed_by_user, 0) = ?
        AND COALESCE((
              SELECT MAX(attempt_seq) FROM claim_proof
               WHERE project_id = ? AND claim_type = 'relation' AND claim_uid = ?
            ), 0) = ?`,
    plan.nextStatus,
    plan.nextConfirmedByUser ? 1 : 0,
    projectId,
    current.claimId,
    current.reviewStatus,
    current.confirmedByUser ? 1 : 0,
    projectId,
    input.claim.uid,
    current.proofAttemptSeq ?? 0,
  );
  if (result.changes === 0) throw new WriteRaceError();

  const proof = plan.gate ? appendGateProof(db, projectId, input.claim.uid, plan.gate) : null;
  const rulingId = recordRuling(db, projectId, {
    relationId: current.claimId,
    role: input.role,
    actor: input.actor,
    standard: input.standard,
    fromStatus: current.reviewStatus,
    toStatus: plan.nextStatus,
    basis: input.basis,
    quote: input.quote,
  });

  if (input.trace) {
    // Required and in the same transaction: if this fails, status, proof and
    // ruling roll back together.
    recordTraceEvent(db, {
      traceId: input.trace.traceId,
      spanId: input.trace.spanId,
      parentSpanId: input.trace.parentSpanId,
      projectId,
      stage: input.trace.stage ?? TRACE_STAGE_COURT_TRANSITION,
      event: TRACE_EVENT_APPLIED,
      eventClass: 'required',
      subject: claimTraceSubject(input.claim),
      decision: 'applied',
      reasonCode: appliedTraceReason(input, plan),
      refs: {
        ...input.trace.refs,
        claim_uid: input.claim.uid,
        ...(proof ? { proof_id: proof.id } : {}),
      },
      model: input.trace.model,
      promptHash: input.trace.promptHash,
      committed: true,
    });
  }

  const to: ClaimStateSnapshot = {
    reviewStatus: plan.nextStatus,
    authorization: authorizationOf(plan.nextStatus, plan.nextConfirmedByUser),
    confirmedByUser: plan.nextConfirmedByUser,
    proofAttemptSeq: proof?.attemptSeq ?? current.proofAttemptSeq,
    policyVersion: plan.gate?.policyVersion ?? current.policyVersion,
  };
  return {
    kind: 'applied',
    claim: input.claim,
    from: snapshot(current),
    to,
    statusChanged: plan.statusChanged,
    authorizationChanged: plan.authChanged,
    proofAppended: proof !== null,
    proofAttemptSeq: proof?.attemptSeq ?? current.proofAttemptSeq,
    rulingId,
  };
}

function claimTraceSubject(claim: ClaimRef): string {
  return `claim:${claim.type}:${claim.uid}`;
}

function appliedTraceReason(input: TransitionClaimInput, plan: Plan): string {
  if (input.intent === 'promotion') return 'promotion_applied';
  if (input.intent === 'demotion') return 'demotion_applied';
  if (input.intent === 'initial') return 'initial_applied';
  return plan.authChanged && !plan.statusChanged ? 'authorization_applied' : 'administrative_applied';
}

function recordOutcomeTrace(
  db: Db,
  projectId: number,
  input: TransitionClaimInput,
  result: Exclude<TransitionResult, { kind: 'applied' }>,
): void {
  if (!input.trace) return;
  const event = result.kind === 'noop'
    ? TRACE_EVENT_NOOP
    : result.kind === 'stale'
      ? TRACE_EVENT_STALE
      : result.kind === 'conflict'
        ? TRACE_EVENT_CONFLICT
        : TRACE_EVENT_REJECTED;
  const reasonCode = result.kind === 'noop'
    ? 'already_in_target'
    : result.kind === 'stale'
      ? `stale_${result.reason}`
      : result.kind === 'conflict'
        ? `conflict_${result.reason}`
        : result.reason;
  try {
    recordTraceEvent(db, {
      traceId: input.trace.traceId,
      spanId: input.trace.spanId,
      parentSpanId: input.trace.parentSpanId,
      projectId,
      stage: input.trace.stage ?? TRACE_STAGE_COURT_TRANSITION,
      event,
      eventClass: 'diagnostic',
      subject: claimTraceSubject(input.claim),
      decision: result.kind,
      reasonCode,
      refs: {
        ...input.trace.refs,
        claim_uid: input.claim.uid,
      },
      model: input.trace.model,
      promptHash: input.trace.promptHash,
      error: result.kind === 'rejected' ? result.detail : '',
      committed: false,
    });
  } catch {
    // Diagnostic trace recording is best-effort by contract.
  }
}

/**
 * Apply one relation transition. The only function in this module that writes.
 *
 * At top level it opens a BEGIN IMMEDIATE transaction. Nested calls join the
 * surrounding transaction through Db.transaction's existing re-entrant rule.
 */
export function transitionClaim(
  db: Db,
  projectId: number,
  input: TransitionClaimInput,
): TransitionResult {
  const invalid = preValidate(input);
  if (invalid) {
    recordOutcomeTrace(db, projectId, input, invalid);
    return invalid;
  }

  try {
    const result = db.transaction(() => runTransition(db, projectId, input), { immediate: true });
    if (result.kind !== 'applied') recordOutcomeTrace(db, projectId, input, result);
    return result;
  } catch (error) {
    if (error instanceof AttemptConflictError) {
      const current = readRelationClaimState(db, projectId, input.claim.uid);
      const result: TransitionResult = current
        ? { kind: 'conflict', reason: 'attempt_seq_taken', current, retryable: true }
        : { kind: 'stale', reason: 'claim_missing', targetAlreadyCurrent: false };
      recordOutcomeTrace(db, projectId, input, result);
      return result;
    }
    if (error instanceof ProofRejectedError) {
      const current = readRelationClaimState(db, projectId, input.claim.uid);
      const result: TransitionResult = current
        ? { kind: 'rejected', reason: 'proof_rejected', detail: error.detail, current }
        : { kind: 'rejected', reason: 'proof_rejected', detail: error.detail };
      recordOutcomeTrace(db, projectId, input, result);
      return result;
    }
    if (error instanceof WriteRaceError) {
      const current = readRelationClaimState(db, projectId, input.claim.uid);
      if (!current) {
        const result: TransitionResult = { kind: 'stale', reason: 'claim_missing', targetAlreadyCurrent: false };
        recordOutcomeTrace(db, projectId, input, result);
        return result;
      }
      const stale = staleReason(current, input.expect);
      const result: TransitionResult = stale
        ? {
            kind: 'stale',
            reason: stale,
            current,
            targetAlreadyCurrent: targetAlreadyCurrent(current, input.target),
          }
        : { kind: 'conflict', reason: 'write_race', current, retryable: true };
      recordOutcomeTrace(db, projectId, input, result);
      return result;
    }
    throw error;
  }
}

/**
 * Compute what transitionClaim would do, without writing anything.
 *
 * This function never calls appendClaimProof, recordRuling or a write
 * transaction. It reads the claim, proof ledger and fingerprints only.
 */
export function shadowTransitionClaim(
  db: Db,
  projectId: number,
  input: TransitionClaimInput,
): ShadowTransitionResult {
  const invalid = preValidate(input);
  if (invalid) {
    return shadowResult(input, null, invalid.reason, [invalid.detail]);
  }
  const current = readRelationClaimState(db, projectId, input.claim.uid);
  if (!current) {
    return shadowResult(input, null, 'claim_missing', ['claim_missing: no relation with that claim_uid']);
  }
  const stale = staleReason(current, input.expect);
  if (stale) {
    return shadowResult(input, current, stale, [`stale ${stale}: expected state is no longer current`]);
  }
  const plan = planTransition(current, input);
  if (plan.kind === 'rejected') {
    return shadowResult(input, current, plan.reason, [plan.detail]);
  }
  if (plan.kind === 'noop') {
    return shadowResult(input, current, 'already_in_target', []);
  }

  const notes: string[] = [];
  if (current.reviewStatus === 'accepted' && current.sourceProof !== 'verified') {
    notes.push('legacy accepted row has no current source proof; stored status is not source-attested');
  }
  if (plan.authChanged && !plan.statusChanged) {
    notes.push('authorization-only change: no source proof is implied');
  }
  if (plan.authChanged && plan.statusChanged) {
    notes.push('authorization is preserved, but the status change still needs its own proof or policy basis');
  }
  if (plan.gate && plan.gate.outcome !== 'verified') {
    notes.push(`non-verified proof attempt would be recorded: ${plan.gate.outcome}`);
  }
  if (current.authorization === 'user_confirmed' && plan.statusChanged) {
    notes.push('authorization remains user_confirmed across this status change');
  }

  const statusDifference = plan.statusChanged
    ? { from: current.reviewStatus, to: plan.nextStatus }
    : null;
  const authDifference = plan.authChanged
    ? { from: current.authorization, to: authorizationOf(plan.nextStatus, plan.nextConfirmedByUser) }
    : null;
  const nextSeq = (current.proofAttemptSeq ?? 0) + 1;
  const proof = plan.gate
    ? { attemptSeq: nextSeq, standard: plan.gate.standard, outcome: plan.gate.outcome, policyVersion: plan.gate.policyVersion }
    : null;

  return {
    mode: 'shadow',
    claim: input.claim,
    current,
    proposed: {
      intent: input.intent,
      reviewStatus: plan.nextStatus,
      authorization: authorizationOf(plan.nextStatus, plan.nextConfirmedByUser),
      proofAppend: proof,
      ruling: {
        role: input.role,
        actor: input.actor,
        standard: input.standard,
        fromStatus: current.reviewStatus,
        toStatus: plan.nextStatus,
      },
    },
    wouldApply: true,
    resultKind: 'applied',
    policyViolations: [],
    policyNotes: notes,
    differences: {
      status: statusDifference,
      authorization: authDifference,
      proof: plan.gate
        ? { fromSeq: current.proofAttemptSeq, toSeq: nextSeq, outcome: plan.gate.outcome }
        : null,
      ruling: true,
    },
    note: 'shadow mode performed no writes',
  };
}

const STALE_REASONS = new Set<string>([
  'status',
  'authorization',
  'proof_version',
  'fingerprint',
  'claim_missing',
]);

function shadowResult(
  input: TransitionClaimInput,
  current: RelationClaimState | null,
  reason: string,
  violations: string[],
): ShadowTransitionResult {
  const reviewStatus = current?.reviewStatus ?? input.target.reviewStatus ?? '';
  const authorization = current?.authorization ?? 'none';
  const resultKind = reason === 'already_in_target'
    ? 'noop'
    : STALE_REASONS.has(reason)
      ? 'stale'
      : 'rejected';
  return {
    mode: 'shadow',
    claim: input.claim,
    current,
    proposed: {
      intent: input.intent,
      reviewStatus,
      authorization,
      proofAppend: null,
      ruling: null,
    },
    wouldApply: false,
    resultKind,
    resultReason: reason,
    policyViolations: violations,
    policyNotes: [],
    differences: { status: null, authorization: null, proof: null, ruling: false },
    note: 'shadow mode performed no writes',
  };
}
