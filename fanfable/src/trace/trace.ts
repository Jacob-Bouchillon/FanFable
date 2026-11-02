/**
 * Local trace ledger.
 *
 * A trace is an accounting record, not a prompt log: events carry identifiers,
 * decisions, reason codes, hashes and references. Required events are written
 * in the transaction that owns the decision. Diagnostic events are best-effort:
 * sampling, caps or retention can drop them, and the trace says so through
 * dropped_events and completeness. Nothing here should ever be read as an
 * exhaustive account after a drop.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Db, nowIso } from '../core/db.ts';

export type TraceCompleteness = 'complete' | 'sampled' | 'truncated' | 'interrupted';
export type TraceEventClass = 'required' | 'diagnostic';

export const TRACE_STAGE_COURT_TRANSITION = 'court.transition';
export const TRACE_EVENT_APPLIED = 'claim.transition.applied';
export const TRACE_EVENT_NOOP = 'claim.transition.noop';
export const TRACE_EVENT_STALE = 'claim.transition.stale';
export const TRACE_EVENT_CONFLICT = 'claim.transition.conflict';
export const TRACE_EVENT_REJECTED = 'claim.transition.rejected';

export const DIAGNOSTIC_MAX_EVENTS_PER_TRACE = 200;
export const DIAGNOSTIC_RETENTION_DAYS = 30;

export interface TraceRefs {
  claim_uid?: string;
  proof_id?: number;
  run_id?: number;
  note_id?: number;
  thread_id?: number;
  chunk_id?: number;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  stage?: string;
  model?: string;
  promptHash?: string;
  refs?: TraceRefs;
}

/** The read surface used by show/audit. A writable Db and a read-only opener both fit. */
export interface TraceReadDb {
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
}

export interface StartTraceInput {
  projectId: number;
  traceId?: string;
  sampledRate?: number;
  /** Small facts/counts only. Never put prompts, responses or passages here. */
  metadata?: Record<string, unknown>;
  startedAt?: string;
}

export interface RecordTraceEventInput {
  traceId: string;
  projectId?: number;
  spanId?: string;
  parentSpanId?: string | null;
  stage: string;
  event: string;
  eventClass: TraceEventClass;
  subject?: string;
  decision?: string;
  reasonCode?: string;
  refs?: TraceRefs;
  model?: string;
  promptHash?: string;
  durationMs?: number | null;
  /** Short error text only; never a prompt, response or book passage. */
  error?: string;
  committed?: boolean;
  createdAt?: string;
}

export interface RecordTraceEventResult {
  recorded: boolean;
  dropped: boolean;
  reason?: 'sampled' | 'cap' | 'retention' | 'unavailable';
  pruned?: number;
  eventId?: number;
}

export interface TraceRecord {
  id: string;
  projectId: number;
  startedAt: string;
  finishedAt: string | null;
  completeness: TraceCompleteness;
  sampledRate: number;
  droppedEvents: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface TraceEventRecord {
  id: number;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  projectId: number;
  stage: string;
  event: string;
  eventClass: TraceEventClass;
  subject: string;
  decision: string;
  reasonCode: string;
  refs: TraceRefs;
  model: string;
  promptHash: string;
  durationMs: number | null;
  error: string;
  committed: boolean;
  createdAt: string;
}

export interface TraceShowResult {
  trace: TraceRecord;
  events: TraceEventRecord[];
}

export interface TraceViolation {
  code: string;
  eventId?: number;
  claimUid?: string;
  detail: string;
}

export interface TraceSuspicion {
  code: string;
  eventId?: number;
  detail: string;
}

export interface TraceAuditResult {
  traceId: string;
  completeness: TraceCompleteness;
  exhaustive: boolean;
  droppedEvents: number;
  sampledRate: number;
  finishedAt: string | null;
  violations: TraceViolation[];
  suspicious: TraceSuspicion[];
  checks: string[];
  limitations: string[];
}

interface TraceRow {
  id: string;
  project_id: number;
  started_at: string;
  finished_at: string | null;
  completeness: string;
  sampled_rate: number;
  dropped_events: number;
  metadata: string;
  created_at: string;
}

interface TraceEventRow {
  id: number;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  project_id: number;
  stage: string;
  event: string;
  event_class: string;
  subject: string;
  decision: string;
  reason_code: string;
  refs: string;
  model: string;
  prompt_hash: string;
  duration_ms: number | null;
  error: string;
  committed: number;
  created_at: string;
}

const REF_KEYS = ['claim_uid', 'proof_id', 'run_id', 'note_id', 'thread_id', 'chunk_id'] as const;
const TERMINAL_DECISIONS = new Set(['applied', 'noop', 'stale', 'conflict', 'rejected']);

export function newTraceId(): string {
  return `tr-${randomUUID()}`;
}

export function newSpanId(): string {
  return `sp-${randomUUID()}`;
}

function completenessOf(value: string): TraceCompleteness {
  return value === 'sampled' || value === 'truncated' || value === 'interrupted' ? value : 'complete';
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseRefs(text: string): TraceRefs {
  const raw = parseObject(text);
  const refs: TraceRefs = {};
  for (const key of REF_KEYS) {
    const value = raw[key];
    if (key === 'claim_uid' && typeof value === 'string' && value) refs.claim_uid = value;
    else if (key !== 'claim_uid' && Number.isFinite(Number(value)) && Number(value) > 0) {
      (refs as Record<string, string | number>)[key] = Number(value);
    }
  }
  return refs;
}

function refsJson(refs: TraceRefs | undefined): string {
  if (!refs) return '{}';
  const out: Record<string, string | number> = {};
  for (const key of REF_KEYS) {
    const value = refs[key];
    if (value === undefined || value === null) continue;
    if (key === 'claim_uid' && typeof value === 'string' && value) out[key] = value;
    else if (key !== 'claim_uid' && Number.isFinite(Number(value)) && Number(value) > 0) {
      out[key] = Number(value);
    }
  }
  return JSON.stringify(out);
}

function traceRecord(row: TraceRow): TraceRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    completeness: completenessOf(row.completeness),
    sampledRate: Number(row.sampled_rate),
    droppedEvents: Number(row.dropped_events),
    metadata: parseObject(row.metadata),
    createdAt: row.created_at,
  };
}

function eventRecord(row: TraceEventRow): TraceEventRecord {
  return {
    id: Number(row.id),
    traceId: row.trace_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    projectId: row.project_id,
    stage: row.stage,
    event: row.event,
    eventClass: row.event_class === 'required' ? 'required' : 'diagnostic',
    subject: row.subject,
    decision: row.decision,
    reasonCode: row.reason_code,
    refs: parseRefs(row.refs),
    model: row.model,
    promptHash: row.prompt_hash,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    error: row.error,
    committed: Number(row.committed) === 1,
    createdAt: row.created_at,
  };
}

function loadTrace(db: TraceReadDb, traceId: string): TraceRecord | null {
  const row = db.get<TraceRow>('SELECT * FROM trace WHERE id = ?', traceId);
  return row ? traceRecord(row) : null;
}

/** Start a trace. The row itself is the completeness record for later events. */
export function startTrace(db: Db, input: StartTraceInput): TraceRecord {
  const sampledRate = input.sampledRate ?? 1;
  if (!Number.isFinite(sampledRate) || sampledRate < 0 || sampledRate > 1) {
    throw new Error('sampledRate must be between 0 and 1');
  }
  const traceId = input.traceId?.trim() || newTraceId();
  const startedAt = input.startedAt ?? nowIso();
  const createdAt = nowIso();
  db.transaction(() => {
    db.run(
      `INSERT INTO trace
         (id, project_id, started_at, finished_at, completeness, sampled_rate,
          dropped_events, metadata, created_at)
       VALUES (?, ?, ?, NULL, 'complete', ?, 0, ?, ?)`,
      traceId,
      input.projectId,
      startedAt,
      sampledRate,
      JSON.stringify(input.metadata ?? {}),
      createdAt,
    );
  }, { immediate: true });
  const trace = loadTrace(db, traceId);
  if (!trace) throw new Error(`trace not found after start: ${traceId}`);
  return trace;
}

function insertEvent(db: Db, input: RecordTraceEventInput, projectId: number, createdAt: string): number {
  const spanId = input.spanId?.trim() || newSpanId();
  const duration = input.durationMs === null || input.durationMs === undefined || !Number.isFinite(input.durationMs)
    ? null
    : Number(input.durationMs);
  return Number(
    db.run(
      `INSERT INTO trace_event
         (trace_id, span_id, parent_span_id, project_id, stage, event, event_class,
          subject, decision, reason_code, refs, model, prompt_hash, duration_ms,
          error, committed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.traceId,
      spanId,
      input.parentSpanId ?? null,
      projectId,
      input.stage,
      input.event,
      input.eventClass,
      String(input.subject ?? ''),
      String(input.decision ?? ''),
      String(input.reasonCode ?? ''),
      refsJson(input.refs),
      String(input.model ?? ''),
      String(input.promptHash ?? ''),
      duration,
      String(input.error ?? '').slice(0, 1000),
      input.committed ? 1 : 0,
      createdAt,
    ).lastInsertRowid,
  );
}

function bumpDropped(db: Db, traceId: string, count: number, kind: 'sampled' | 'truncated'): void {
  if (count <= 0) return;
  db.run(
    `UPDATE trace
        SET dropped_events = dropped_events + ?,
            completeness = CASE
              WHEN completeness = 'interrupted' THEN 'interrupted'
              WHEN completeness = 'truncated' THEN 'truncated'
              WHEN ? = 'truncated' THEN 'truncated'
              WHEN ? = 'sampled' THEN 'sampled'
              ELSE completeness
            END
      WHERE id = ?`,
    count,
    kind,
    kind,
    traceId,
  );
}

function sampledIn(traceId: string, rate: number, spanId: string, event: string, subject: string): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const digest = createHash('sha256').update(`${traceId}\0${spanId}\0${event}\0${subject}`).digest();
  return digest.readUInt32BE(0) / 0x100000000 < rate;
}

function recordDiagnostic(db: Db, input: RecordTraceEventInput): RecordTraceEventResult {
  const createdAt = input.createdAt ?? nowIso();
  try {
    return db.transaction(() => {
      const trace = db.get<{
        id: string;
        project_id: number;
        sampled_rate: number;
      }>('SELECT id, project_id, sampled_rate FROM trace WHERE id = ?', input.traceId);
      if (!trace) return { recorded: false, dropped: true, reason: 'unavailable' };
      if (input.projectId !== undefined && input.projectId !== trace.project_id) {
        return { recorded: false, dropped: true, reason: 'unavailable' };
      }
      const spanId = input.spanId?.trim() || newSpanId();
      if (!sampledIn(trace.id, Number(trace.sampled_rate), spanId, input.event, String(input.subject ?? ''))) {
        bumpDropped(db, trace.id, 1, 'sampled');
        return { recorded: false, dropped: true, reason: 'sampled' };
      }
      const parsed = Date.parse(createdAt);
      const cutoff = new Date(
        (Number.isFinite(parsed) ? parsed : Date.now()) - DIAGNOSTIC_RETENTION_DAYS * 86400000,
      ).toISOString();
      const pruned = db.run(
        `DELETE FROM trace_event
          WHERE trace_id = ? AND event_class = 'diagnostic' AND created_at < ?`,
        trace.id,
        cutoff,
      ).changes;
      if (pruned > 0) bumpDropped(db, trace.id, pruned, 'truncated');
      const count = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM trace_event
          WHERE trace_id = ? AND event_class = 'diagnostic'`,
        trace.id,
      )?.n ?? 0;
      if (count >= DIAGNOSTIC_MAX_EVENTS_PER_TRACE) {
        bumpDropped(db, trace.id, 1, 'truncated');
        return { recorded: false, dropped: true, reason: 'cap', pruned };
      }
      const eventId = insertEvent(db, { ...input, spanId, createdAt }, trace.project_id, createdAt);
      return { recorded: true, dropped: false, eventId, pruned };
    }, { immediate: true });
  } catch {
    // A trace must never fail the canon operation that tried to describe it.
    try {
      bumpDropped(db, input.traceId, 1, 'truncated');
    } catch {
      /* the trace itself is unavailable */
    }
    return { recorded: false, dropped: true, reason: 'unavailable' };
  }
}

/**
 * Record one event.
 *
 * Required events throw on failure and are written inside the caller's
 * transaction (or their own immediate transaction when called alone).
 * Diagnostic events return a drop result instead of throwing.
 */
export function recordTraceEvent(db: Db, input: RecordTraceEventInput): RecordTraceEventResult {
  if (input.eventClass === 'required') {
    const createdAt = input.createdAt ?? nowIso();
    const eventId = db.transaction(() => {
      const trace = db.get<{ project_id: number }>('SELECT project_id FROM trace WHERE id = ?', input.traceId);
      if (!trace) throw new Error(`trace not found: ${input.traceId}`);
      if (input.projectId !== undefined && input.projectId !== trace.project_id) {
        throw new Error(`trace ${input.traceId} belongs to project ${trace.project_id}`);
      }
      return insertEvent(db, input, trace.project_id, createdAt);
    }, { immediate: true });
    return { recorded: true, dropped: false, eventId };
  }
  return recordDiagnostic(db, input);
}

/** Finish a trace without ever pretending a sampled/truncated trace is complete. */
export function finishTrace(
  db: Db,
  traceId: string,
  opts: { interrupted?: boolean; completeness?: TraceCompleteness; finishedAt?: string } = {},
): TraceRecord | null {
  const row = db.get<TraceRow>('SELECT id FROM trace WHERE id = ?', traceId);
  if (!row) return null;
  const requested = opts.interrupted ? 'interrupted' : opts.completeness ?? null;
  // Monotonic in SQL: a concurrent diagnostic drop cannot be overwritten by a
  // later finish call that only asks for "complete".
  db.run(
    `UPDATE trace
        SET finished_at = COALESCE(finished_at, ?),
            completeness = CASE
              WHEN completeness = 'interrupted' THEN 'interrupted'
              WHEN ? = 'interrupted' THEN 'interrupted'
              WHEN completeness = 'truncated' THEN 'truncated'
              WHEN ? = 'truncated' THEN 'truncated'
              WHEN completeness = 'sampled' THEN 'sampled'
              WHEN ? = 'sampled' THEN 'sampled'
              ELSE 'complete'
            END
      WHERE id = ?`,
    opts.finishedAt ?? nowIso(),
    requested,
    requested,
    requested,
    traceId,
  );
  return loadTrace(db, traceId);
}

/** Read a trace and its event chain. Read-only. */
export function showTrace(db: TraceReadDb, traceId: string): TraceShowResult | null {
  const trace = loadTrace(db, traceId);
  if (!trace) return null;
  const events = db.all<TraceEventRow>(
    'SELECT * FROM trace_event WHERE trace_id = ? ORDER BY id',
    traceId,
  ).map(eventRecord);
  return { trace, events };
}

/**
 * Audit a trace. Violations are claims the trace itself proves. Suspicious
 * patterns are weaker signals and are reported separately.
 */
export function auditTrace(db: TraceReadDb, traceId: string): TraceAuditResult | null {
  const view = showTrace(db, traceId);
  if (!view) return null;
  const { trace, events } = view;
  const violations: TraceViolation[] = [];
  const suspicious: TraceSuspicion[] = [];
  const checks = [
    'required events are committed',
    'diagnostic events are not committed',
    'applied events are required events',
    'applied events reference an existing relation claim',
    'promotion events reference a verified proof',
    'owner attempt events carry a terminal decision',
    'verified proofs created during the trace window have a required event',
  ];
  const limitations = [
    'the audit reads current rows; it does not replay the full historical transition',
    'ruling linkage is enforced by the owner transaction but is not reconstructed from trace refs',
    'a complete trace with zero drops is the only exhaustive accounting',
  ];

  const appliedProofIds = new Set<number>();
  for (const event of events) {
    const committed = event.committed;
    const ownerAttempt =
      event.event.startsWith('claim.transition.') || event.stage === TRACE_STAGE_COURT_TRANSITION;
    if (event.eventClass === 'required' && !committed) {
      violations.push({
        code: 'required_event_not_committed',
        eventId: event.id,
        detail: 'a required event must commit with its decision',
      });
    }
    if (event.eventClass === 'diagnostic' && committed) {
      violations.push({
        code: 'diagnostic_event_committed',
        eventId: event.id,
        detail: 'a diagnostic event must not claim a committed canon change',
      });
    }
    if (event.decision === 'applied' && !committed) {
      violations.push({
        code: 'applied_without_commit',
        eventId: event.id,
        detail: 'an applied event must be committed',
      });
    }
    if (event.decision !== 'applied' && committed) {
      violations.push({
        code: 'non_applied_committed',
        eventId: event.id,
        detail: `decision ${event.decision || '(empty)'} must not be committed`,
      });
    }
    if (event.decision === 'applied' && event.eventClass !== 'required') {
      violations.push({
        code: 'applied_event_not_required',
        eventId: event.id,
        detail: 'the applied audit event must be required',
      });
    }
    if (ownerAttempt && !TERMINAL_DECISIONS.has(event.decision)) {
      violations.push({
        code: 'missing_terminal_outcome',
        eventId: event.id,
        detail: 'an owner attempt must end in applied, noop, stale, conflict or rejected',
      });
    }
    if (ownerAttempt && event.decision !== 'applied' && !event.reasonCode) {
      suspicious.push({
        code: 'diagnostic_without_reason',
        eventId: event.id,
        detail: 'a non-applied owner outcome should carry a reason code',
      });
    }
    if (event.error) {
      suspicious.push({
        code: 'event_error_present',
        eventId: event.id,
        detail: event.error.slice(0, 200),
      });
    }

    if (event.decision === 'applied') {
      const claimUid = event.refs.claim_uid;
      if (!claimUid) {
        violations.push({
          code: 'applied_without_claim_ref',
          eventId: event.id,
          detail: 'an applied event must name its claim_uid',
        });
      } else {
        const relation = db.get<{ id: number; review_status: string }>(
          `SELECT id, review_status FROM canon_relation
            WHERE project_id = ? AND claim_uid = ?`,
          trace.projectId,
          claimUid,
        );
        if (!relation) {
          violations.push({
            code: 'applied_claim_missing',
            eventId: event.id,
            claimUid,
            detail: 'the applied claim is not present in canon_relation',
          });
        }
        const proofId = Number(event.refs.proof_id);
        if (Number.isFinite(proofId) && proofId > 0) appliedProofIds.add(proofId);
        if (event.reasonCode.startsWith('promotion_')) {
          if (!Number.isFinite(proofId) || proofId <= 0) {
            violations.push({
              code: 'promotion_without_verified_proof',
              eventId: event.id,
              claimUid,
              detail: 'a promotion applied event must reference its proof_id',
            });
          } else {
            const proof = db.get<{ outcome: string; claim_uid: string }>(
              `SELECT outcome, claim_uid FROM claim_proof
                WHERE id = ? AND project_id = ? AND claim_type = 'relation'`,
              proofId,
              trace.projectId,
            );
            if (!proof || proof.outcome !== 'verified' || proof.claim_uid !== claimUid) {
              violations.push({
                code: 'promotion_without_verified_proof',
                eventId: event.id,
                claimUid,
                detail: `proof ${proofId} is not a verified proof for this claim`,
              });
            }
          }
          if (relation && relation.review_status !== 'accepted' && relation.review_status !== 'attested') {
            suspicious.push({
              code: 'promoted_claim_not_current',
              eventId: event.id,
              detail: `claim is now ${relation.review_status}, not accepted or attested`,
            });
          }
        }
      }
    }
  }

  const windowEnd = trace.finishedAt ?? nowIso();
  const proofs = db.all<{ id: number; claim_uid: string; outcome: string }>(
    `SELECT id, claim_uid, outcome FROM claim_proof
      WHERE project_id = ? AND claim_type = 'relation'
        AND created_at >= ? AND created_at <= ?`,
    trace.projectId,
    trace.startedAt,
    windowEnd,
  );
  for (const proof of proofs) {
    if (proof.outcome === 'verified' && !appliedProofIds.has(Number(proof.id))) {
      violations.push({
        code: 'missing_required_event',
        claimUid: proof.claim_uid,
        detail: `verified proof ${proof.id} was created during the trace window without a required applied event`,
      });
    }
  }

  if (trace.completeness !== 'complete' || trace.droppedEvents > 0) {
    suspicious.push({
      code: 'trace_not_exhaustive',
      detail: `completeness=${trace.completeness}, dropped_events=${trace.droppedEvents}`,
    });
  }
  if (!trace.finishedAt) {
    suspicious.push({ code: 'trace_unfinished', detail: 'trace has no finished_at' });
  }
  if (trace.sampledRate < 1) {
    suspicious.push({
      code: 'trace_sampled',
      detail: `diagnostic sampling rate is ${trace.sampledRate}`,
    });
  }

  return {
    traceId: trace.id,
    completeness: trace.completeness,
    exhaustive: trace.completeness === 'complete' && trace.droppedEvents === 0,
    droppedEvents: trace.droppedEvents,
    sampledRate: trace.sampledRate,
    finishedAt: trace.finishedAt,
    violations,
    suspicious,
    checks,
    limitations,
  };
}
