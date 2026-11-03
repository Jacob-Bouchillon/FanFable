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

/**
 * Extraction tracing starts at the parsed JSON candidates. It never claims to
 * observe what the model did not emit, and every event is diagnostic: the
 * extraction transaction never depends on a trace write.
 */
export const EXTRACTION_TRACE_STAGE = 'extraction';
export const EXTRACTION_EVENT_STARTED = 'extraction.started';
export const EXTRACTION_EVENT_WINDOW_STARTED = 'extraction.window.started';
export const EXTRACTION_EVENT_WINDOW_FINISHED = 'extraction.window.finished';
export const EXTRACTION_EVENT_SECTION = 'extraction.section';
export const EXTRACTION_EVENT_CANDIDATE = 'extraction.relation.candidate';
export const EXTRACTION_EVENT_ENDPOINT = 'extraction.relation.endpoint';
export const EXTRACTION_EVENT_RETRY = 'extraction.relation.retry';
export const EXTRACTION_EVENT_CITATION = 'extraction.relation.citation';
export const EXTRACTION_EVENT_DIRECTION = 'extraction.relation.direction';
export const EXTRACTION_EVENT_CLAIM = 'extraction.relation.claim';
export const EXTRACTION_EVENT_DISPOSITION = 'extraction.relation.disposition';
export const EXTRACTION_EVENT_RUN_FINALIZED = 'extraction.run.finalized';

export type ExtractionTerminalDecision =
  | 'inserted'
  | 'merged'
  | 'mixed'
  | 'hinted'
  | 'noted'
  | 'dropped'
  | 'error';

export const DIAGNOSTIC_MAX_EVENTS_PER_TRACE = 200;
/** Hard ceiling for an explicit per-trace diagnostic cap. */
export const DIAGNOSTIC_MAX_EVENTS_CEILING = 1024;
const DIAGNOSTIC_MAX_EVENTS_KEY = 'diagnostic_max_events';
export const DIAGNOSTIC_RETENTION_DAYS = 30;

/** A retrieval event buffered until the ask path's mode is known. */
export interface RetrievalTraceEvent {
  event: string;
  subject?: string;
  decision?: string;
  reasonCode?: string;
  refs?: TraceRefs;
  error?: string;
  createdAt?: string;
  stage?: string;
  spanId?: string;
  parentSpanId?: string | null;
}

export interface RetrievalTraceSink {
  emit(event: RetrievalTraceEvent): void;
  /** Set by withRetrievalTraceSpan; absent on a plain buffer. */
  readonly spanId?: string;
  readonly parentSpanId?: string | null;
}

export interface BufferedRetrievalTrace extends RetrievalTraceSink {
  readonly events: RetrievalTraceEvent[];
  /** Cap on enumerated seed/candidate detail; summaries and final selections always survive. */
  candidateDetailLimit?: number;
  sampled?: boolean;
  candidateDetailSkipped?: number;
}

/** Buffer retrieval events without writing; the caller starts the trace later. */
export function createRetrievalTraceBuffer(opts: { candidateDetailLimit?: number } = {}): BufferedRetrievalTrace {
  const events: RetrievalTraceEvent[] = [];
  return {
    events,
    candidateDetailLimit: opts.candidateDetailLimit,
    emit(event: RetrievalTraceEvent): void {
      events.push({ ...event, createdAt: event.createdAt ?? nowIso() });
    },
  };
}

/**
 * Raise a trace's dropped count to at least `minimumDropped` and mark it
 * truncated. This is the safety net for a diagnostic write that could not
 * update the trace itself; it never changes the retrieval result.
 */
function ensureTraceTruncated(db: Db, traceId: string, minimumDropped: number): void {
  try {
    db.run(
      `UPDATE trace
          SET dropped_events = CASE
                WHEN dropped_events < ? THEN ?
                ELSE dropped_events
              END,
              completeness = CASE
                WHEN completeness = 'interrupted' THEN 'interrupted'
                ELSE 'truncated'
              END
        WHERE id = ?`,
      minimumDropped,
      minimumDropped,
      traceId,
    );
  } catch {
    // If even the trace row cannot be updated, the command still succeeds.
  }
}

/** Bind a trace sink to a distinct span for one retrieval layer. */
export function withRetrievalTraceSpan(
  sink: RetrievalTraceSink,
  spanId: string,
  parentSpanId?: string | null,
): RetrievalTraceSink {
  return {
    spanId,
    parentSpanId: parentSpanId ?? null,
    emit(event: RetrievalTraceEvent): void {
      // Inner wrappers own their events. An outer wrapper must not pull a
      // hop or child event back onto itself.
      if (event.spanId) {
        sink.emit({
          ...event,
          spanId: event.spanId,
          parentSpanId: event.parentSpanId ?? null,
        });
      } else {
        sink.emit({ ...event, spanId, parentSpanId: parentSpanId ?? null });
      }
    },
  };
}

/** Flush buffered events as diagnostic trace events, never failing retrieval. */
export function flushRetrievalTrace(
  db: Db,
  projectId: number,
  traceId: string,
  buffer: BufferedRetrievalTrace,
): { sampled: boolean; candidateDetailSkipped: number } {
  let initialDropped = 0;
  try {
    const before = db.get<{ dropped_events: number }>(
      'SELECT dropped_events FROM trace WHERE id = ?',
      traceId,
    );
    initialDropped = Number(before?.dropped_events ?? 0);
  } catch {
    return { sampled: false, candidateDetailSkipped: 0 };
  }
  const finalSubjects = new Set(
    buffer.events
      .filter(
        (event) =>
          (event.event === 'retrieval.candidate.disposition' &&
            event.decision === 'selected' &&
            event.refs?.stage === 'final-bank-rank' &&
            event.subject) ||
          (event.event === 'context.item.disposition' &&
            (event.decision === 'included' || event.decision === 'truncated') &&
            event.subject),
      )
      .map((event) => String(event.subject)),
  );
  const detailSubjects = new Set<string>();
  let candidateDetailSkipped = 0;
  const eventsToWrite: RetrievalTraceEvent[] = [];
  for (const event of buffer.events) {
    const detail =
      event.event.startsWith('retrieval.seed.') ||
      event.event === 'retrieval.candidate.generated' ||
      event.event === 'retrieval.candidate.disposition';
    if (!detail || !event.subject) {
      eventsToWrite.push(event);
      continue;
    }
    if (finalSubjects.has(event.subject)) {
      eventsToWrite.push(event);
      continue;
    }
    const limit = buffer.candidateDetailLimit;
    if (limit === undefined) {
      eventsToWrite.push(event);
      continue;
    }
    if (detailSubjects.has(event.subject)) {
      eventsToWrite.push(event);
      continue;
    }
    if (detailSubjects.size < limit) {
      detailSubjects.add(event.subject);
      eventsToWrite.push(event);
    } else {
      candidateDetailSkipped++;
    }
  }
  const sampled = candidateDetailSkipped > 0;
  if (sampled) {
    buffer.sampled = true;
    buffer.candidateDetailSkipped = candidateDetailSkipped;
    eventsToWrite.push({
      event: 'retrieval.coverage',
      subject: 'retrieval:coverage',
      decision: 'completed',
      reasonCode: 'sampled',
      refs: { count: candidateDetailSkipped, selected_count: finalSubjects.size, stage: 'coverage' },
      createdAt: nowIso(),
    });
  }
  // Context accounting comes first when a trace contains both ledgers.
  // Candidate detail may be sampled, but summaries, final dispositions and
  // coverage must not be pushed out by older retrieval detail.
  if (eventsToWrite.some((event) => event.stage === 'context')) {
    const priority = (event: RetrievalTraceEvent): number => {
      if (
        event.event === 'context.summary' ||
        event.event === 'context.coverage' ||
        event.event === 'context.completed' ||
        event.event === 'context.child.completed'
      ) return 0;
      if (event.event === 'context.item.disposition') return 1;
      if (event.event === 'context.item.generated') return 2;
      return 3;
    };
    eventsToWrite.sort((a, b) => priority(a) - priority(b));
  }
  let failedWrites = 0;
  for (const event of eventsToWrite) {
    try {
      const result = recordTraceEvent(db, {
        traceId,
        projectId,
        stage: event.stage ?? 'retrieval',
        event: event.event,
        eventClass: 'diagnostic',
        subject: event.subject,
        decision: event.decision,
        reasonCode: event.reasonCode,
        refs: event.refs,
        error: event.error,
        createdAt: event.createdAt,
        spanId: event.spanId ?? 'sp-retrieval',
        parentSpanId: event.parentSpanId,
      });
      // Sampling is already accounted for by recordTraceEvent as 'sampled';
      // cap/unavailable are lost diagnostic writes and must make this trace
      // non-exhaustive.
      if (result.dropped && result.reason !== 'sampled') failedWrites++;
    } catch {
      failedWrites++;
    }
  }
  if (failedWrites > 0) ensureTraceTruncated(db, traceId, initialDropped + failedWrites);
  return { sampled, candidateDetailSkipped };
}

export interface TraceRefs {
  claim_uid?: string;
  candidate_id?: string;
  proof_id?: number;
  run_id?: number;
  note_id?: number;
  thread_id?: number;
  chunk_id?: number;
  chunk_ids?: number[];
  relation_id?: number;
  entity_id?: number;
  event_id?: number;
  fact_id?: number;
  entity_ids?: number[];
  hint_id?: number;
  open_end_id?: number;
  window_index?: number;
  seq?: number | null;
  period_label?: string;
  /** Retrieval rank (1-based) within its scoring stage. */
  rank?: number;
  /** Retrieval score. Scores are comparable only within the same stage. */
  score?: number;
  /** Count for a compact retrieval summary. */
  count?: number;
  /** Raw retrieval candidates before deduplication. */
  raw_count?: number;
  /** Unique retrieval candidates after merging duplicate origins. */
  dedup_count?: number;
  /** Candidates that entered ranking. */
  ranked_count?: number;
  /** Candidates selected into the result. */
  selected_count?: number;
  /** Valid candidates cut by a limit. */
  budgeted_count?: number;
  /** Candidates rejected for a named reason. */
  excluded_count?: number;
  /** Graph node count. */
  node_count?: number;
  /** Graph edge count. */
  edge_count?: number;
  /** PPR iterations. */
  iteration_count?: number;
  /** Trail step count. */
  step_count?: number;
  /** Items partially included by a context budget. */
  truncated_count?: number;
  /** Context-child coverage counts. */
  required_count?: number;
  contributing_count?: number;
  optional_count?: number;
  incomplete_count?: number;
  required_incomplete_count?: number;
  contributing_incomplete_count?: number;
  optional_incomplete_count?: number;
  /** Model/prompt coordination identifiers and hashes. */
  response_hash?: string;
  body_hash?: string;
  content_hash?: string;
  system_hash?: string;
  /** Hashes of model-emitted labels and quotes; the text itself is not stored. */
  kind_hash?: string;
  evidence_hash?: string;
  anchor_hash?: string;
  /** Safe parser-route code for an extraction section; never raw JSON. */
  parse_route?: string;
  evidence_chars?: number;
  anchor_chars?: number;
  raw_entries?: number;
  accepted_entries?: number;
  filtered_entries?: number;
  salvaged_entries?: number;
  /** IDs are recorded when the decision is made; later cleanup may replace them. */
  lineage?: 'at-decision';
  context_trace_id?: string;
  model_provider?: string;
  message_role?: string;
  request_kind?: string;
  status?: string;
  /** Write execution counters. */
  part?: number;
  round?: number;
  attempt?: number;
  message_index?: number;
  prompt_chars?: number;
  response_chars?: number;
  answer_chars?: number;
  section_chars?: number;
  section_words?: number;
  previous_chars?: number;
  beat_count?: number;
  system_chars?: number;
  message_count?: number;
  max_tokens?: number;
  temperature?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  body_chars?: number;
  body_words?: number;
  chapter_number?: number;
  chapter_id?: number;
  request_row_id?: number;
  revision_row_id?: number;
  call_count?: number;
  continuation_count?: number;
  dropped_paragraphs?: number;
  /** Extraction candidate and terminal accounting. */
  kind_count?: number;
  claim_count?: number;
  inserted_count?: number;
  merged_count?: number;
  hinted_count?: number;
  noted_count?: number;
  dropped_count?: number;
  completed_count?: number;
  partial_count?: number;
  failed_count?: number;
  skipped_count?: number;
  contributed_chars?: number;
  contributed_words?: number;
  overlap_chars?: number;
  deduped_chars?: number;
  ambiguous_chars?: number;
  unanswered_requests?: number;
  /** Short scoring/processing stage code, never prose. */
  stage?: string;
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
  /** Optional per-trace diagnostic cap; other traces keep the global cap. */
  maxEvents?: number;
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

export interface NoteAccounting {
  generated: number;
  admitted: number;
  deduplicated: number;
  rejected: number;
  parked: number;
  verified: boolean;
}

/** Parsed relationship candidates and their terminal dispositions. */
export interface ExtractionAccounting {
  parsedCandidates: number;
  terminalDispositions: number;
  /**
   * Counts of candidate terminal dispositions, not individual claim events.
   * A mixed candidate may contain several claims of different decisions.
   */
  candidateOutcomes: {
    inserted: number;
    merged: number;
    hinted: number;
    noted: number;
    dropped: number;
    mixed: number;
    errors: number;
  };
  /** Recorded claim events by decision; null when the trace is not complete. */
  claimEvents: {
    inserted: number;
    merged: number;
    hinted: number;
    noted: number;
    dropped: number;
  } | null;
  /** Distinct hint ids referenced by hinted claim events; null when incomplete. */
  uniqueHints: number | null;
  /** Candidate accounting covers parsed extraction windows only. */
  pipelineScope: 'window-candidates-only';
  /** Inline close-the-loop enrichment is not candidate-traced. */
  pipelineLineage: 'non-exhaustive';
  runStatus: string;
  windows: number;
  incompleteWindows: number;
  failedSections: number;
  missingSections: number;
  partialSections: number;
  unparsedSections: number;
  skippedSections: number;
  abortedCandidates: number;
  candidateAccountingVerified: boolean;
  verified: boolean;
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
  noteAccounting: NoteAccounting | null;
  extractionAccounting: ExtractionAccounting | null;
}

const NOTE_DISPOSITION_REASONS = new Set([
  'inserted',
  'dedupe-key-match',
  'not-verbatim',
  'empty-claim',
  'no-assertable-claim',
  'no-identity-evidence',
  'no-quote',
  'no-chunk',
  'no-thread',
  'no-character-endpoint',
  'verb-kind',
  'endpoint-not-mentioned',
  'context-no-both-names',
  'context-cap',
]);

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

const REF_STRING_KEYS = [
  'claim_uid', 'candidate_id', 'period_label', 'stage',
  'response_hash', 'body_hash', 'content_hash', 'system_hash', 'context_trace_id',
  'kind_hash', 'evidence_hash', 'anchor_hash', 'parse_route',
  'model_provider', 'message_role', 'request_kind', 'status',
] as const;
const REF_NUMBER_KEYS = [
  'proof_id',
  'run_id',
  'note_id',
  'thread_id',
  'chunk_id',
  'relation_id',
  'entity_id',
  'event_id',
  'fact_id',
  'hint_id',
  'open_end_id',
] as const;
const REF_NONNEGATIVE_KEYS = [
  'rank', 'score', 'count', 'raw_count', 'dedup_count', 'ranked_count',
  'selected_count', 'budgeted_count', 'excluded_count', 'truncated_count',
  'node_count', 'edge_count', 'iteration_count', 'step_count',
  'required_count', 'contributing_count', 'optional_count', 'incomplete_count',
  'required_incomplete_count', 'contributing_incomplete_count',
  'optional_incomplete_count',
  'part', 'round', 'attempt', 'message_index', 'window_index', 'prompt_chars', 'response_chars',
  'answer_chars', 'section_chars', 'section_words', 'previous_chars', 'beat_count', 'system_chars',
  'message_count', 'max_tokens', 'temperature', 'prompt_tokens', 'completion_tokens',
  'body_chars', 'body_words', 'chapter_number', 'chapter_id', 'request_row_id',
  'revision_row_id', 'call_count', 'continuation_count', 'dropped_paragraphs',
  'kind_count', 'claim_count', 'inserted_count', 'merged_count', 'hinted_count', 'noted_count',
  'dropped_count', 'completed_count', 'partial_count', 'failed_count', 'skipped_count',
  'evidence_chars', 'anchor_chars', 'raw_entries', 'accepted_entries', 'filtered_entries', 'salvaged_entries',
  'contributed_chars', 'contributed_words', 'overlap_chars', 'deduped_chars', 'ambiguous_chars', 'unanswered_requests',
] as const;
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
  for (const key of REF_STRING_KEYS) {
    const value = raw[key];
    if (typeof value === 'string' && value) refs[key] = value;
  }
  for (const key of REF_NUMBER_KEYS) {
    const value = Number(raw[key]);
    if (raw[key] !== null && raw[key] !== undefined && Number.isFinite(value) && value > 0) {
      refs[key] = value;
    }
  }
  for (const key of REF_NONNEGATIVE_KEYS) {
    const value = Number(raw[key]);
    if (raw[key] !== null && raw[key] !== undefined && Number.isFinite(value) && value >= 0) {
      refs[key] = value;
    }
  }
  if (raw.lineage === 'at-decision') refs.lineage = 'at-decision';
  const seq = Number(raw.seq);
  if (raw.seq !== null && raw.seq !== undefined && Number.isFinite(seq) && seq >= 0) refs.seq = seq;
  if (Array.isArray(raw.entity_ids)) {
    const ids = raw.entity_ids
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (ids.length) refs.entity_ids = [...new Set(ids)];
  }
  if (Array.isArray(raw.chunk_ids)) {
    const ids = raw.chunk_ids
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (ids.length) refs.chunk_ids = [...new Set(ids)];
  }
  return refs;
}

function refsJson(refs: TraceRefs | undefined): string {
  if (!refs) return '{}';
  const out: Record<string, unknown> = {};
  for (const key of REF_STRING_KEYS) {
    const value = refs[key];
    if (typeof value === 'string' && value) out[key] = value;
  }
  for (const key of REF_NUMBER_KEYS) {
    const value = refs[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = value;
  }
  for (const key of REF_NONNEGATIVE_KEYS) {
    const value = refs[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  if (refs.lineage === 'at-decision') out.lineage = 'at-decision';
  if (typeof refs.seq === 'number' && Number.isFinite(refs.seq) && refs.seq >= 0) out.seq = refs.seq;
  if (refs.entity_ids?.length) {
    const ids = [...new Set(refs.entity_ids.filter((value) => Number.isFinite(value) && value > 0))];
    if (ids.length) out.entity_ids = ids;
  }
  if (refs.chunk_ids?.length) {
    const ids = [...new Set(refs.chunk_ids.filter((value) => Number.isFinite(value) && value > 0))];
    if (ids.length) out.chunk_ids = ids;
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
  const metadata = { ...(input.metadata ?? {}) };
  // The cap is an explicit trace option only. Ordinary caller metadata must
  // not be able to raise it.
  delete metadata[DIAGNOSTIC_MAX_EVENTS_KEY];
  if (input.maxEvents !== undefined && Number.isFinite(input.maxEvents)) {
    metadata[DIAGNOSTIC_MAX_EVENTS_KEY] = Math.min(
      DIAGNOSTIC_MAX_EVENTS_CEILING,
      Math.max(1, Math.floor(input.maxEvents)),
    );
  }
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
      JSON.stringify(metadata),
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
        metadata: string;
      }>('SELECT id, project_id, sampled_rate, metadata FROM trace WHERE id = ?', input.traceId);
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
      let cap = DIAGNOSTIC_MAX_EVENTS_PER_TRACE;
      try {
        const requested = Number(JSON.parse(trace.metadata)?.[DIAGNOSTIC_MAX_EVENTS_KEY]);
        if (Number.isFinite(requested) && requested > 0) {
          cap = Math.min(DIAGNOSTIC_MAX_EVENTS_CEILING, Math.max(1, Math.floor(requested)));
        }
      } catch {
        // A malformed metadata object keeps the global cap.
      }
      if (count >= cap) {
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

/**
 * Account for diagnostic events a producer suppressed locally after the cap was
 * reached. Best-effort: never fails the producing operation.
 */
export function markDroppedTraceEvents(db: Db, traceId: string, count: number): void {
  if (!Number.isFinite(count) || count <= 0) return;
  try {
    bumpDropped(db, traceId, Math.floor(count), 'truncated');
  } catch {
    // A trace that cannot record its own drops stays unavailable/truncated.
  }
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
    'every generated note candidate has one terminal disposition',
    'every note disposition carries a recognised reason code',
    'note candidate accounting balances when the trace is exhaustive',
    'every admitted note has a required note.admitted event and stored note row',
    'retrieval selected evidence has a valid passage citation',
    'complete retrieval traces give every enumerated candidate one terminal disposition',
  ];
  const limitations = [
    'the audit reads current rows; it does not replay the full historical transition',
    'ruling linkage is enforced by the owner transaction but is not reconstructed from trace refs',
    'a complete trace with zero drops is the only exhaustive accounting',
    'note accounting covers only candidates inside the traced window/scope',
    'retrieval candidate accounting covers enumerated candidates; bulk FTS pools are summaries',
    'retrieval excluded_count is zero when filtering happens in SQL before candidates are enumerated',
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

    if (ownerAttempt && event.decision === 'applied') {
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

  const noteEvents = events.filter((event) => event.event.startsWith('note.'));
  let noteAccounting: NoteAccounting | null = null;
  let extractionAccounting: ExtractionAccounting | null = null;
  let extractionExhaustive = true;
  if (noteEvents.length) {
    const generated = new Set<string>();
    const dispositions = new Map<string, TraceEventRecord[]>();
    const admissions = noteEvents.filter((event) => event.event === 'note.admitted');
    for (const event of noteEvents) {
      if (event.event === 'note.candidate.generated') generated.add(event.subject);
      if (event.event === 'note.candidate.disposition') {
        const list = dispositions.get(event.subject) ?? [];
        list.push(event);
        dispositions.set(event.subject, list);
      }
    }
    let admitted = 0;
    let deduplicated = 0;
    let rejected = 0;
    let parked = 0;
    for (const list of dispositions.values()) {
      for (const event of list) {
        if (event.decision === 'admitted') admitted++;
        else if (event.decision === 'deduplicated') deduplicated++;
        else if (event.decision === 'rejected') rejected++;
        else if (event.decision === 'parked') parked++;
      }
    }

    const unfinished = !trace.finishedAt;
    const notExhaustive = trace.completeness !== 'complete' || trace.droppedEvents > 0;
    if (unfinished) {
      suspicious.push({
        code: 'note_trace_unfinished',
        detail: 'note candidate accounting cannot be verified because the trace is unfinished',
      });
    }
    if (notExhaustive) {
      suspicious.push({
        code: 'note_trace_not_exhaustive',
        detail:
          `note candidate accounting cannot be verified: completeness=${trace.completeness}, ` +
          `dropped_events=${trace.droppedEvents}`,
      });
    }

    let verified = false;
    if (!unfinished && !notExhaustive) {
      const before = violations.length;
      for (const subject of generated) {
        const list = dispositions.get(subject) ?? [];
        if (!list.length) {
          violations.push({
            code: 'note_candidate_missing_disposition',
            detail: `candidate ${subject} has no terminal disposition`,
          });
        } else if (list.length > 1) {
          violations.push({
            code: 'note_candidate_multiple_dispositions',
            detail: `candidate ${subject} has ${list.length} terminal dispositions`,
          });
        }
      }
      for (const list of dispositions.values()) {
        for (const event of list) {
          if (!['admitted', 'deduplicated', 'rejected', 'parked'].includes(event.decision)) {
            violations.push({
              code: 'note_candidate_unexplained',
              eventId: event.id,
              detail: `candidate ${event.subject} has unknown disposition ${event.decision || '(empty)'}`,
            });
          }
          if (!NOTE_DISPOSITION_REASONS.has(event.reasonCode)) {
            violations.push({
              code: 'note_candidate_unexplained',
              eventId: event.id,
              detail: `candidate ${event.subject} has unrecognised reason ${event.reasonCode || '(empty)'}`,
            });
          }
        }
      }
      const sum = admitted + deduplicated + rejected + parked;
      if (generated.size !== sum) {
        violations.push({
          code: 'note_candidate_accounting_mismatch',
          detail: `generated=${generated.size} but dispositions=${sum} ` +
            `(admitted=${admitted}, deduplicated=${deduplicated}, rejected=${rejected}, parked=${parked})`,
        });
      }
      for (const [subject, list] of dispositions) {
        if (!list.some((event) => event.decision === 'admitted')) continue;
        if (!admissions.some((event) => event.refs.candidate_id === subject)) {
          violations.push({
            code: 'note_admission_missing_required_event',
            detail: `admitted candidate ${subject} has no required note.admitted event`,
          });
        }
      }
      for (const event of admissions) {
        const noteId = Number(event.refs.note_id);
        const stored = Number.isFinite(noteId) && noteId > 0
          ? db.get<{ id: number }>(
              'SELECT id FROM canon_thread_note WHERE id = ? AND project_id = ?',
              noteId,
              trace.projectId,
            )
          : undefined;
        if (!stored) {
          violations.push({
            code: 'note_admission_missing_note',
            eventId: event.id,
            detail: `note.admitted references missing note ${event.refs.note_id ?? '(none)'}`,
          });
        }
      }
      verified = violations.length === before;
    }

    noteAccounting = {
      generated: generated.size,
      admitted,
      deduplicated,
      rejected,
      parked,
      verified,
    };
  }

  const retrievalEvents = events.filter((event) => event.stage === 'retrieval');
  if (retrievalEvents.length) {
    const exhaustive = trace.completeness === 'complete' && trace.droppedEvents === 0;
    const sampledCoverage = trace.completeness === 'sampled' && trace.droppedEvents === 0;
    if (!exhaustive && !sampledCoverage) {
      checks.push('retrieval exhaustive accounting skipped: trace is truncated, interrupted or has dropped events');
    } else {
      if (sampledCoverage) {
        checks.push('retrieval candidate detail is sampled; summary, citation, trail and PPR checks remain observable');
      }
      const generated = new Map<string, TraceEventRecord[]>();
      const terminals = new Map<string, TraceEventRecord[]>();
      const summaries = new Map<string, TraceEventRecord>();
      const generatedReasons = new Set([
        'fts', 'bank-linked', 'supplied', 'index', 'shortcut', 'ppr', 'graph-reference',
        'dense-passage', 'fts-trail-source', 'package', 'graph',
      ]);
      const terminalReasons = new Set([
        'selected', 'duplicate', 'no-citation', 'passage-limit', 'source-filter', 'empty-index',
        'ppr-top-k', 'trail-cap',
      ]);
      const searchReasons = new Set(['ok', 'empty', 'error']);
      const completionReasons = new Set(['ok', 'empty', 'index-only', 'shortcut', 'ppr-fallback']);
      const budgetReasons = new Set([
        'passage-limit', 'index-limit', 'seed-cap', 'graph-node-cap', 'graph-edge-cap',
        'graph-word-budget', 'word-budget', 'trail-cap', 'ppr-top-k', 'dense-top-k',
      ]);
      for (const event of retrievalEvents) {
        if (event.event === 'retrieval.summary' && event.subject) {
          summaries.set(event.subject, event);
          if (!['ok', 'empty', 'error'].includes(event.reasonCode)) {
            violations.push({
              code: 'retrieval_summary_reason',
              eventId: event.id,
              detail: `retrieval summary ${event.subject} has unrecognised reason ${event.reasonCode || '(empty)'}`,
            });
          }
          const raw = event.refs.raw_count;
          const dedup = event.refs.dedup_count;
          const ranked = event.refs.ranked_count;
          const selected = event.refs.selected_count;
          const budgeted = event.refs.budgeted_count;
          const excluded = event.refs.excluded_count;
          if ([raw, dedup, ranked, selected, budgeted, excluded].some((value) => typeof value !== 'number' || value < 0)) {
            violations.push({
              code: 'retrieval_summary_counts',
              eventId: event.id,
              detail: `retrieval summary ${event.subject} is missing a non-negative count`,
            });
          } else if (
            dedup! > raw! ||
            ranked! > dedup! ||
            selected! > ranked! ||
            selected! + budgeted! > ranked! ||
            selected! + budgeted! + excluded! > raw!
          ) {
            violations.push({
              code: 'retrieval_summary_counts',
              eventId: event.id,
              detail: `retrieval summary ${event.subject} has inconsistent counts`,
            });
          }
        }
        if (event.event === 'retrieval.candidate.generated' && event.subject) {
          const key = `${event.spanId ?? ''}:${event.refs.stage ?? ''}:${event.subject}`;
          generated.set(key, [...(generated.get(key) ?? []), event]);
          if (!generatedReasons.has(event.reasonCode)) {
            violations.push({
              code: 'retrieval_candidate_reason',
              eventId: event.id,
              detail: `generated candidate ${event.subject} has unrecognised reason ${event.reasonCode || '(empty)'}`,
            });
          }
        }
        if (
          event.event === 'retrieval.candidate.disposition' &&
          ['selected', 'excluded', 'budgeted'].includes(event.decision) &&
          event.subject
        ) {
          const key = `${event.spanId ?? ''}:${event.refs.stage ?? ''}:${event.subject}`;
          terminals.set(key, [...(terminals.get(key) ?? []), event]);
          if (!terminalReasons.has(event.reasonCode)) {
            violations.push({
              code: 'retrieval_candidate_reason',
              eventId: event.id,
              detail: `candidate ${event.subject} has unrecognised disposition reason ${event.reasonCode || '(empty)'}`,
            });
          }
        }
        if (event.event === 'retrieval.search.completed' && !searchReasons.has(event.reasonCode)) {
          violations.push({
            code: 'retrieval_search_reason',
            eventId: event.id,
            detail: `search ${event.subject} has unrecognised reason ${event.reasonCode || '(empty)'}`,
          });
        }
        if (event.event === 'retrieval.completed' && !completionReasons.has(event.reasonCode)) {
          violations.push({
            code: 'retrieval_completion_reason',
            eventId: event.id,
            detail: `retrieval completion has unrecognised reason ${event.reasonCode || '(empty)'}`,
          });
        }
        if (event.event === 'retrieval.budget.cutoff') {
          const count = event.refs.count;
          if (!budgetReasons.has(event.reasonCode) ||
              typeof count !== 'number' || count < 0) {
            violations.push({
              code: 'retrieval_budget_cutoff',
              eventId: event.id,
              detail: `budget cutoff ${event.subject} has an unrecognised reason or count`,
            });
          }
        }
        if (event.event === 'retrieval.query.expanded' && !['model', 'fallback-empty'].includes(event.reasonCode)) {
          violations.push({
            code: 'retrieval_expansion_reason',
            eventId: event.id,
            detail: `query expansion has unrecognised reason ${event.reasonCode || '(empty)'}`,
          });
        }
      }
      if (exhaustive) {
        for (const [subject, list] of generated) {
          const terminal = terminals.get(subject) ?? [];
          if (!terminal.length) {
            violations.push({
              code: 'retrieval_candidate_missing_disposition',
              detail: `candidate ${subject} has no terminal disposition`,
            });
          } else if (terminal.length > 1) {
            violations.push({
              code: 'retrieval_candidate_multiple_dispositions',
              detail: `candidate ${subject} has ${terminal.length} terminal dispositions`,
            });
          }
        }
      }
      for (const [subject, list] of terminals) {
        if (exhaustive && !generated.has(subject)) {
          violations.push({
            code: 'retrieval_disposition_without_candidate',
            detail: `disposition ${subject} has no generated candidate`,
          });
        }
        for (const event of list) {
          if (event.decision !== 'selected' || !event.subject.startsWith('chunk:')) continue;
          const chunkId = Number(event.refs.chunk_id);
          if (!Number.isInteger(chunkId) || chunkId <= 0) {
            violations.push({
              code: 'retrieval_selected_without_chunk',
              eventId: event.id,
              detail: `selected passage ${subject} has no chunk_id`,
            });
            continue;
          }
          const row = db.get<{ locator: string; title: string; path: string }>(
            `SELECT c.locator, s.title, s.path
               FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id
              WHERE c.id = ? AND c.project_id = ?`,
            chunkId,
            trace.projectId,
          );
          if (!row) {
            violations.push({
              code: 'retrieval_selected_chunk_missing',
              eventId: event.id,
              detail: `selected passage ${subject} does not exist in project ${trace.projectId}`,
            });
          } else if (!row.locator && !row.title && !row.path) {
            violations.push({
              code: 'retrieval_selected_without_citation',
              eventId: event.id,
              detail: `selected passage ${subject} has no citation or locator`,
            });
          }
        }
      }
      const trailByChunk = new Set(
        retrievalEvents
          .filter((event) => event.event === 'retrieval.trail.recorded')
          .map((event) => event.subject),
      );
      for (const event of retrievalEvents) {
        if (
          event.event === 'retrieval.candidate.disposition' &&
          event.decision === 'selected' &&
          event.refs.stage === 'final-bank-rank' &&
          !trailByChunk.has(event.subject)
        ) {
          violations.push({
            code: 'retrieval_trail_missing',
            eventId: event.id,
            detail: `final selected trail ${event.subject} has no trail or word-only record`,
          });
        }
      }
      const pprCompleted = retrievalEvents.some((event) => event.event === 'retrieval.ppr.completed');
      const pprFallback = retrievalEvents.some((event) => event.event === 'retrieval.ppr.fallback');
      if (pprCompleted && pprFallback) {
        violations.push({
          code: 'retrieval_ppr_state',
          detail: 'trace records both PPR completion and PPR fallback',
        });
      }
      if (sampledCoverage) {
        const coverage = retrievalEvents.find((event) => event.event === 'retrieval.coverage');
        if (!coverage || coverage.reasonCode !== 'sampled') {
          violations.push({
            code: 'retrieval_coverage_missing',
            detail: 'sampled retrieval trace has no sampled coverage marker',
          });
        }
      }
      for (const event of retrievalEvents) {
        if (event.event !== 'retrieval.budget.cutoff') continue;
        const summarySubject = event.subject === 'budget:passages'
          ? 'search:fts'
          : event.subject === 'budget:passages:trail-source'
            ? 'search:fts:trail-source'
            : event.subject === 'budget:trails'
              ? 'trails:final'
              : event.subject === 'budget:package'
                ? 'passages:package'
                : event.subject.startsWith('budget:index:')
                  ? `search:index:${event.subject.slice('budget:index:'.length)}`
                  : '';
        if (!summarySubject) continue;
        const summary = summaries.get(summarySubject);
        if (!summary) {
          violations.push({
            code: 'retrieval_budget_summary_missing',
            eventId: event.id,
            detail: `budget cutoff ${event.subject} has no matching summary`,
          });
          continue;
        }
        if (summary.refs.budgeted_count !== event.refs.count) {
          violations.push({
            code: 'retrieval_budget_summary_mismatch',
            eventId: event.id,
            detail: `budget cutoff ${event.subject} does not match summary budgeted_count`,
          });
        }
      }
      const hasSearch = retrievalEvents.some((event) => event.event === 'retrieval.search.completed');
      if (hasSearch && !summaries.size) {
        violations.push({
          code: 'retrieval_summary_missing',
          detail: 'complete retrieval trace has search events but no retrieval.summary',
        });
      }
      if (!retrievalEvents.some((event) => event.event === 'retrieval.completed')) {
        violations.push({
          code: 'retrieval_completion_missing',
          detail: 'complete retrieval trace has no retrieval.completed event',
        });
      }
      if (Object.prototype.hasOwnProperty.call(trace.metadata, 'query') ||
          Object.prototype.hasOwnProperty.call(trace.metadata, 'question')) {
        violations.push({
          code: 'retrieval_raw_query',
          detail: 'retrieval trace metadata must not contain raw query text',
        });
      }
    }
  }

  const contextEvents = events.filter((event) => event.stage === 'context');
  let contextExhaustive = true;
  if (contextEvents.length) {
    checks.push(
      'context items have one terminal disposition per unique key when the trace is exhaustive',
      'context child summaries reconcile with the final context summary',
      'selected context citations resolve by item class',
      'required and contributing context children are complete',
      'brief citation slots map to source chunks; source association is not sentence entailment',
    );
    const contextComplete = trace.completeness === 'complete' && trace.droppedEvents === 0;
    const generated = new Map<string, TraceEventRecord[]>();
    const dispositions = new Map<string, TraceEventRecord[]>();
    const childStarted = new Map<string, TraceEventRecord>();
    const childCompleted = new Map<string, TraceEventRecord>();
    const contextSummaries = new Map<string, TraceEventRecord>();
    let coverageEvent: TraceEventRecord | undefined;
    const itemDecisions = new Set(['included', 'excluded', 'budgeted', 'truncated', 'failed', 'superseded']);
    const childStatuses = new Set(['complete', 'empty', 'failed', 'skipped', 'sampled', 'truncated', 'interrupted', 'superseded']);
    for (const event of contextEvents) {
      if (event.event === 'context.item.generated' && event.subject) {
        generated.set(event.subject, [...(generated.get(event.subject) ?? []), event]);
      }
      if (event.event === 'context.item.disposition' && event.subject) {
        dispositions.set(event.subject, [...(dispositions.get(event.subject) ?? []), event]);
        if (!itemDecisions.has(event.decision)) {
          violations.push({
            code: 'context_item_decision',
            eventId: event.id,
            detail: `context item ${event.subject} has unrecognised decision ${event.decision || '(empty)'}`,
          });
        }
      }
      if (event.event === 'context.child.started' && event.subject) {
        childStarted.set(event.subject, event);
      }
      if (event.event === 'context.child.completed' && event.subject) {
        childCompleted.set(event.subject, event);
        if (!childStatuses.has(event.reasonCode)) {
          violations.push({
            code: 'context_child_status',
            eventId: event.id,
            detail: `context child ${event.subject} has unrecognised status ${event.reasonCode || '(empty)'}`,
          });
        }
      }
      if (event.event === 'context.summary' && event.subject) {
        contextSummaries.set(event.subject, event);
      }
      if (event.event === 'context.coverage') coverageEvent = event;
    }

    if (contextComplete) {
      for (const [key, list] of generated) {
        const terminal = dispositions.get(key) ?? [];
        if (terminal.length === 0) {
          violations.push({
            code: 'context_item_missing_disposition',
            detail: `context item ${key} has no terminal disposition`,
          });
        } else if (terminal.length > 1) {
          violations.push({
            code: 'context_item_multiple_dispositions',
            detail: `context item ${key} has ${terminal.length} terminal dispositions`,
          });
        }
      }
      for (const [key] of dispositions) {
        if (!generated.has(key)) {
          violations.push({
            code: 'context_disposition_without_origin',
            detail: `context disposition ${key} has no generated origin`,
          });
        }
      }
      for (const [key, list] of generated) {
        if (list.some((event) => !event.spanId || !event.parentSpanId)) {
          violations.push({
            code: 'context_origin_without_parent',
            detail: `context item ${key} has an origin outside the parent span tree`,
          });
        }
      }
      if (!contextSummaries.has('context:final')) {
        violations.push({
          code: 'context_summary_missing',
          detail: 'complete context trace has no context:final summary',
        });
      }
      if (!contextEvents.some((event) => event.event === 'context.completed')) {
        violations.push({
          code: 'context_completion_missing',
          detail: 'complete context trace has no context.completed event',
        });
      }
      if (!coverageEvent) {
        violations.push({
          code: 'context_coverage_missing',
          detail: 'complete context trace has no context.coverage event',
        });
      }
    }

    for (const [subject, summary] of contextSummaries) {
      const raw = summary.refs.raw_count;
      const dedup = summary.refs.dedup_count;
      const ranked = summary.refs.ranked_count;
      const selected = summary.refs.selected_count;
      const budgeted = summary.refs.budgeted_count;
      const excluded = summary.refs.excluded_count;
      const truncated = summary.refs.truncated_count ?? 0;
      if ([raw, dedup, ranked, selected, budgeted, excluded].some((value) => typeof value !== 'number' || value < 0)) {
        violations.push({
          code: 'context_summary_counts',
          eventId: summary.id,
          detail: `context summary ${subject} is missing a non-negative count`,
        });
        continue;
      }
      if (dedup! > raw! || ranked! > dedup! || selected! + budgeted! + excluded! !== dedup! || truncated! > selected!) {
        violations.push({
          code: 'context_summary_counts',
          eventId: summary.id,
          detail: `context summary ${subject} has inconsistent counts`,
        });
      }
    }

    if (coverageEvent) {
      const required = Number(coverageEvent.refs.required_count ?? 0);
      const contributing = Number(coverageEvent.refs.contributing_count ?? 0);
      const optional = Number(coverageEvent.refs.optional_count ?? 0);
      const incomplete = Number(coverageEvent.refs.incomplete_count ?? 0);
      if (required < 0 || contributing < 0 || optional < 0 || incomplete < 0) {
        violations.push({
          code: 'context_coverage_counts',
          eventId: coverageEvent.id,
          detail: 'context coverage has a negative count',
        });
      }
    }

    const childNames = new Set([...childStarted.keys(), ...childCompleted.keys()]);
    let requiredIncomplete = 0;
    let contributingIncomplete = 0;
    let optionalIncomplete = 0;
    for (const subject of childNames) {
      const started = childStarted.get(subject);
      const completed = childCompleted.get(subject);
      const className = String(completed?.refs.stage ?? started?.refs.stage ?? '');
      const status = completed?.reasonCode ?? 'missing';
      const selected = Number(completed?.refs.selected_count ?? completed?.refs.count ?? 0);
      const isRequired = className === 'required';
      const isOptional = className === 'best-effort';
      const childSpan = started?.spanId ?? completed?.spanId;
      const hasOrigins = [...generated.values()].some((list) =>
        list.some((event) => childSpan && event.spanId === childSpan),
      );
      const isContributing = selected > 0 || hasOrigins;
      const isIncomplete = !['complete', 'empty', 'superseded'].includes(status);
      if (!isIncomplete) continue;
      if (isRequired) {
        requiredIncomplete++;
        contextExhaustive = false;
        if (contextComplete) {
          violations.push({
            code: 'context_required_child_incomplete',
            eventId: completed?.id,
            detail: `required context child ${subject} is ${status}`,
          });
        }
      } else if (isOptional && isContributing) {
        contributingIncomplete++;
        contextExhaustive = false;
        if (contextComplete) {
          violations.push({
            code: 'context_contributing_child_incomplete',
            eventId: completed?.id,
            detail: `contributing context child ${subject} is ${status}`,
          });
        }
      } else if (isOptional) {
        optionalIncomplete++;
        limitations.push(
          `optional context child ${subject} is ${status}; it contributed no selected items, so the actual context lineage is unaffected`,
        );
      }
    }

    if (coverageEvent && contextComplete) {
      const overclaim = coverageEvent.reasonCode === 'complete' && (requiredIncomplete > 0 || contributingIncomplete > 0);
      if (overclaim) {
        contextExhaustive = false;
        violations.push({
          code: 'context_parent_overclaims_completeness',
          eventId: coverageEvent.id,
          detail: 'context coverage claims complete while a required or contributing child is incomplete',
        });
      }
      const expectedIncomplete = requiredIncomplete + contributingIncomplete;
      if (Number(coverageEvent.refs.incomplete_count ?? 0) !== expectedIncomplete) {
        violations.push({
          code: 'context_coverage_mismatch',
          eventId: coverageEvent.id,
          detail: `context coverage reports ${coverageEvent.refs.incomplete_count ?? 0} incomplete children; audit found ${expectedIncomplete}`,
        });
      }
    }

    // A retrieval-selected passage may legitimately be excluded during
    // context assembly. This check records that both decisions exist; it is
    // not a retrieval failure.
    const retrievalSelectedChunks = new Set(
      retrievalEvents
        .filter(
          (event) =>
            event.event === 'retrieval.candidate.disposition' &&
            event.decision === 'selected' &&
            event.subject.startsWith('chunk:'),
        )
        .map((event) => event.subject),
    );
    let assemblyExcludedRetrieved = 0;
    for (const [key, list] of dispositions) {
      if (!retrievalSelectedChunks.has(key)) continue;
      if (list.some((event) => event.decision === 'excluded' || event.decision === 'budgeted')) {
        assemblyExcludedRetrieved++;
      }
    }
    if (assemblyExcludedRetrieved) {
      checks.push(
        `retrieval-selected but assembly-excluded passages: ${assemblyExcludedRetrieved} (distinct decisions, not retrieval failures)`,
      );
    }

    const chunkCache = new Map<number, { locator: string; title: string; path: string } | undefined>();
    const chunkCitation = (chunkId: number): { locator: string; title: string; path: string } | undefined => {
      if (!chunkCache.has(chunkId)) {
        chunkCache.set(
          chunkId,
          db.get<{ locator: string; title: string; path: string }>(
            `SELECT c.locator, s.title, s.path
               FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id
              WHERE c.id = ? AND c.project_id = ?`,
            chunkId,
            trace.projectId,
          ),
        );
      }
      return chunkCache.get(chunkId);
    };
    const numericFrom = (key: string, re: RegExp): number | undefined => {
      const match = re.exec(key);
      const value = Number(match?.[1]);
      return Number.isFinite(value) && value > 0 ? value : undefined;
    };
    const checkChunk = (event: TraceEventRecord, key: string): void => {
      const chunkId = Number(event.refs.chunk_id ?? numericFrom(key, /^chunk:(\d+)$/) ?? 0);
      if (!Number.isInteger(chunkId) || chunkId <= 0) {
        violations.push({
          code: 'context_selected_without_chunk',
          eventId: event.id,
          detail: `selected context item ${key} has no chunk_id`,
        });
        return;
      }
      const row = chunkCitation(chunkId);
      if (!row) {
        violations.push({
          code: 'context_selected_chunk_missing',
          eventId: event.id,
          detail: `selected context item ${key} does not exist in project ${trace.projectId}`,
        });
      } else if (!row.locator && !row.title && !row.path) {
        violations.push({
          code: 'context_selected_without_citation',
          eventId: event.id,
          detail: `selected context item ${key} has no citation or locator`,
        });
      }
    };
    for (const [key, list] of dispositions) {
      for (const event of list) {
        if (event.decision !== 'included' && event.decision !== 'truncated') continue;
        if (key.startsWith('chunk:')) {
          checkChunk(event, key);
          continue;
        }
        if (key.startsWith('brief:canon:S')) {
          checkChunk(event, key);
          continue;
        }
        if (key.startsWith('event:canon:')) {
          const id = Number(event.refs.event_id ?? numericFrom(key, /^event:canon:(\d+)$/) ?? 0);
          const row = Number.isInteger(id) && id > 0
            ? db.get<{ locator: string }>(
                'SELECT locator FROM canon_event WHERE id = ? AND project_id = ?',
                id,
                trace.projectId,
              )
            : undefined;
          if (!row) {
            violations.push({
              code: 'context_selected_event_missing',
              eventId: event.id,
              detail: `selected context item ${key} has no canon event row`,
            });
          } else if (!row.locator) {
            violations.push({
              code: 'context_selected_without_citation',
              eventId: event.id,
              detail: `selected context item ${key} has no locator`,
            });
          }
          continue;
        }
        if (key.startsWith('event:au:')) {
          const id = Number(event.refs.event_id ?? numericFrom(key, /^event:au:(\d+)$/) ?? 0);
          const row = Number.isInteger(id) && id > 0
            ? db.get<{ story_time: string }>(
                'SELECT story_time FROM au_event WHERE id = ? AND project_id = ?',
                id,
                trace.projectId,
              )
            : undefined;
          if (!row) {
            violations.push({
              code: 'context_selected_event_missing',
              eventId: event.id,
              detail: `selected context item ${key} has no AU event row`,
            });
          } else if (!row.story_time) {
            violations.push({
              code: 'context_selected_without_citation',
              eventId: event.id,
              detail: `selected context item ${key} has no story time`,
            });
          }
          continue;
        }
        if (key.startsWith('entity:canon:') || key.startsWith('brief:lore:entity:')) {
          const id = Number(event.refs.entity_id ?? numericFrom(key, /:(\d+)$/) ?? 0);
          const row = Number.isInteger(id) && id > 0
            ? db.get<{ source_refs: string }>(
                'SELECT source_refs FROM canon_entity WHERE id = ? AND project_id = ?',
                id,
                trace.projectId,
              )
            : undefined;
          if (!row) {
            violations.push({
              code: 'context_selected_source_missing',
              eventId: event.id,
              detail: `selected context item ${key} has no canon entity row`,
            });
          } else if (event.reasonCode !== 'uncited-lore' && !String(row.source_refs ?? '').trim()) {
            violations.push({
              code: 'context_selected_without_citation',
              eventId: event.id,
              detail: `selected context item ${key} is not marked uncited-lore and has no source refs`,
            });
          }
          continue;
        }
        if (key.startsWith('fact:canon:') || key.startsWith('brief:lore:fact:')) {
          const id = Number(event.refs.fact_id ?? numericFrom(key, /:(\d+)$/) ?? 0);
          const row = Number.isInteger(id) && id > 0
            ? db.get<{ source_refs: string }>(
                'SELECT source_refs FROM canon_fact WHERE id = ? AND project_id = ?',
                id,
                trace.projectId,
              )
            : undefined;
          if (!row) {
            violations.push({
              code: 'context_selected_source_missing',
              eventId: event.id,
              detail: `selected context item ${key} has no canon fact row`,
            });
          } else if (event.reasonCode !== 'uncited-lore' && !String(row.source_refs ?? '').trim()) {
            violations.push({
              code: 'context_selected_without_citation',
              eventId: event.id,
              detail: `selected context item ${key} is not marked uncited-lore and has no source refs`,
            });
          }
          continue;
        }
        if (key.startsWith('brief:lore:relation:')) {
          const id = Number(event.refs.relation_id ?? numericFrom(key, /:(\d+)$/) ?? 0);
          const row = Number.isInteger(id) && id > 0
            ? db.get<{ id: number }>(
                'SELECT id FROM canon_relation WHERE id = ? AND project_id = ?',
                id,
                trace.projectId,
              )
            : undefined;
          if (!row) {
            violations.push({
              code: 'context_selected_source_missing',
              eventId: event.id,
              detail: `selected context item ${key} has no canon relation row`,
            });
          }
          continue;
        }
        if (key.startsWith('entity:story:')) {
          const id = Number(event.refs.entity_id ?? numericFrom(key, /:(\d+)$/) ?? 0);
          const row = Number.isInteger(id) && id > 0
            ? db.get<{ id: number }>('SELECT id FROM character WHERE id = ? AND project_id = ?', id, trace.projectId)
            : undefined;
          if (!row) {
            violations.push({
              code: 'context_selected_source_missing',
              eventId: event.id,
              detail: `selected context item ${key} has no story character row`,
            });
          }
          continue;
        }
        if (key.startsWith('fact:story:')) {
          const id = Number(event.refs.fact_id ?? numericFrom(key, /:(\d+)$/) ?? 0);
          const row = Number.isInteger(id) && id > 0
            ? db.get<{ id: number }>('SELECT id FROM story_fact WHERE id = ? AND project_id = ?', id, trace.projectId)
            : undefined;
          if (!row) {
            violations.push({
              code: 'context_selected_source_missing',
              eventId: event.id,
              detail: `selected context item ${key} has no story fact row`,
            });
          }
          continue;
        }
        if (key.startsWith('memory:')) {
          const match = /^memory:(character|state|knowledge|relationship|thread|event|fact|summary):(\d+)$/.exec(key);
          const table = match?.[1] === 'character' ? 'character'
            : match?.[1] === 'state' ? 'character_state'
              : match?.[1] === 'knowledge' ? 'character_knowledge'
                : match?.[1] === 'relationship' ? 'relationship'
                  : match?.[1] === 'thread' ? 'plot_thread'
                    : match?.[1] === 'event' ? 'au_event'
                      : match?.[1] === 'fact' ? 'story_fact'
                        : match?.[1] === 'summary' ? 'chapter_summary'
                          : '';
          const id = Number(match?.[2] ?? 0);
          const row = table && id > 0
            ? db.get<{ id: number }>(`SELECT id FROM ${table} WHERE id = ? AND project_id = ?`, id, trace.projectId)
            : undefined;
          if (!row) {
            violations.push({
              code: 'context_selected_source_missing',
              eventId: event.id,
              detail: `selected context item ${key} has no story-memory row`,
            });
          }
          continue;
        }
        if (key.startsWith('history:chapter:')) {
          const id = Number(numericFrom(key, /^history:chapter:(\d+)$/) ?? 0);
          const row = Number.isInteger(id) && id > 0
            ? db.get<{ id: number }>('SELECT id FROM chapter WHERE id = ? AND project_id = ?', id, trace.projectId)
            : undefined;
          if (!row) {
            violations.push({
              code: 'context_selected_source_missing',
              eventId: event.id,
              detail: `selected context item ${key} has no chapter row`,
            });
          }
          continue;
        }
        if (key.startsWith('verdict:')) continue;
        if (key.startsWith('edge:canon:relation:')) {
          const id = Number(numericFrom(key, /^edge:canon:relation:(\d+)$/) ?? 0);
          const row = Number.isInteger(id) && id > 0
            ? db.get<{ id: number }>('SELECT id FROM canon_relation WHERE id = ? AND project_id = ?', id, trace.projectId)
            : undefined;
          if (!row) {
            violations.push({
              code: 'context_selected_source_missing',
              eventId: event.id,
              detail: `selected context item ${key} has no canon relation row`,
            });
          }
          continue;
        }
        if (key.startsWith('edge:story:relationship:')) {
          const id = Number(numericFrom(key, /^edge:story:relationship:(\d+)$/) ?? 0);
          const row = Number.isInteger(id) && id > 0
            ? db.get<{ id: number }>('SELECT id FROM relationship WHERE id = ? AND project_id = ?', id, trace.projectId)
            : undefined;
          if (!row) {
            violations.push({
              code: 'context_selected_source_missing',
              eventId: event.id,
              detail: `selected context item ${key} has no story relationship row`,
            });
          }
          continue;
        }
      }
    }

    if ([...generated.keys()].some((key) => key.startsWith('brief:canon:S'))) {
      limitations.push(
        'canon-brief citation slots prove source association; they do not prove sentence-level entailment',
      );
    }
    if ([...dispositions.values()].some((list) => list.some((event) => event.reasonCode === 'uncited-lore'))) {
      limitations.push(
        'selected uncited-lore items are recorded without a canon citation; content and admission rules are unchanged',
      );
    }
  }

  const writeEvents = events.filter((event) => event.stage === 'write');
  let writeExhaustive = true;
  if (writeEvents.length) {
    checks.push(
      'write required lifecycle, prompt, model-call and storage events are present',
      'write model calls preserve actual request and response hashes',
      'write requests have terminal dispositions and answer consumption',
      'write requests arriving after the additional-call budget are recorded unanswered',
      'writer and continuation requests end with a user message and have no consecutive same-role messages',
      'write output dispositions reflect final-body survival or explicit ambiguity',
      'write dedupe counts agree between output and completion',
      'write parts are completed or explicitly skipped',
      'final stored body matches the write output hash',
      'write context links point at the originating context trace',
    );
    const writeComplete = trace.completeness === 'complete' && trace.droppedEvents === 0;
    const writeEvent = (name: string): TraceEventRecord[] =>
      writeEvents.filter((event) => event.event === name);
    const first = (name: string): TraceEventRecord | undefined => writeEvent(name)[0];
    const writeStarted = first('write.started');
    const writeFailed = first('write.failed');
    const writeCompleted = first('write.completed');
    const contextLinked = first('write.context.linked');
    const contextSupplied = first('write.context.supplied');
    const contextMissing = first('write.context.missing');
    const finalOutput = first('write.output.final');
    const stored = first('write.stored');

    if (!writeStarted) {
      violations.push({
        code: 'write_started_missing',
        detail: 'write trace has no write.started event',
      });
      writeExhaustive = false;
    }
    if (contextMissing) {
      violations.push({
        code: 'write_context_missing',
        eventId: contextMissing.id,
        detail: 'write claims an assembled context but has no context trace link',
      });
      writeExhaustive = false;
    }
    if (!contextLinked && !contextSupplied && writeComplete) {
      violations.push({
        code: 'write_context_link_missing',
        detail: 'write trace has neither a linked context trace nor a supplied-bundle marker',
      });
      writeExhaustive = false;
    }
    if (contextLinked && contextLinked.refs.context_trace_id) {
      const linked = db.get<{ completeness: string; dropped_events: number }>(
        'SELECT completeness, dropped_events FROM trace WHERE id = ?',
        contextLinked.refs.context_trace_id,
      );
      if (!linked) {
        violations.push({
          code: 'write_context_trace_missing',
          eventId: contextLinked.id,
          detail: `linked context trace ${contextLinked.refs.context_trace_id} does not exist`,
        });
        writeExhaustive = false;
      } else if (linked.completeness !== 'complete' || Number(linked.dropped_events) > 0) {
        limitations.push(
          `linked context trace ${contextLinked.refs.context_trace_id} is ${linked.completeness} with ${linked.dropped_events} dropped events`,
        );
      }
    }

    const partStarted = new Map<number, TraceEventRecord>();
    const partTerminal = new Map<number, TraceEventRecord>();
    for (const event of writeEvents) {
      if (event.event === 'write.part.started') {
        const part = Number(event.refs.part);
        if (Number.isInteger(part) && part > 0) partStarted.set(part, event);
      }
      if (event.event === 'write.part.completed' || event.event === 'write.part.skipped') {
        const part = Number(event.refs.part);
        if (Number.isInteger(part) && part > 0) partTerminal.set(part, event);
        if (event.event === 'write.part.skipped') {
          violations.push({
            code: 'write_part_skipped',
            eventId: event.id,
            detail: `part ${event.refs.part ?? '?'} received no model call: ${event.reasonCode || 'skipped'}`,
          });
          writeExhaustive = false;
        }
      }
    }
    for (const [part, event] of partStarted) {
      if (!partTerminal.has(part)) {
        violations.push({
          code: 'write_part_missing_terminal',
          eventId: event.id,
          detail: `part ${part} has no completed/skipped terminal event`,
        });
        writeExhaustive = false;
      }
    }

    const calls = new Map<string, {
      started: TraceEventRecord;
      completed?: TraceEventRecord;
      failed?: TraceEventRecord;
      role: string;
    }>();
    const promptByPart = new Set(
      writeEvents
        .filter((event) => event.event === 'write.prompt.built')
        .map((event) => Number(event.refs.part))
        .filter((part) => Number.isInteger(part) && part > 0),
    );
    for (const event of writeEvents) {
      if (event.event === 'write.model.started') {
        const id = event.subject;
        calls.set(id, { started: event, role: event.reasonCode });
        if (!event.promptHash) {
          violations.push({
            code: 'write_model_request_hash_missing',
            eventId: event.id,
            detail: `model call ${id} has no actual request hash`,
          });
          writeExhaustive = false;
        }
        if (!event.refs.system_hash || typeof event.refs.message_count !== 'number') {
          violations.push({
            code: 'write_model_provenance_missing',
            eventId: event.id,
            detail: `model call ${id} is missing system/message provenance`,
          });
          writeExhaustive = false;
        }
        const messageEvents = writeEvents.filter(
          (candidate) =>
            candidate.event === 'write.model.message' &&
            candidate.spanId === event.spanId,
        );
        if (Number(event.refs.message_count ?? -1) !== messageEvents.length) {
          violations.push({
            code: 'write_model_message_count',
            eventId: event.id,
            detail: `model call ${id} reports ${event.refs.message_count ?? '?'} messages; ${messageEvents.length} message events found`,
          });
          writeExhaustive = false;
        }
        if (event.reasonCode === 'writer' || event.reasonCode === 'continuation') {
          if (event.reasonCode === 'writer') {
            const part = Number(event.refs.part);
            if (!Number.isInteger(part) || !promptByPart.has(part)) {
              violations.push({
                code: 'write_prompt_missing',
                eventId: event.id,
                detail: `writer call ${id} has no prompt.built event for part ${event.refs.part ?? '?'}`,
              });
              writeExhaustive = false;
            }
          }
          if (Number(event.refs.message_count ?? -1) === messageEvents.length) {
            const roles = messageEvents.map((candidate) => String(candidate.refs.message_role ?? ''));
            if (roles.length && roles[roles.length - 1] !== 'user') {
              violations.push({
                code: 'write_history_last_role',
                eventId: event.id,
                detail: `model call ${id} does not end with a user message`,
              });
              writeExhaustive = false;
            }
            for (let i = 0; i + 1 < roles.length; i++) {
              if (
                roles[i] === roles[i + 1] &&
                (roles[i] === 'user' || roles[i] === 'assistant')
              ) {
                violations.push({
                  code: `write_history_consecutive_${roles[i]}`,
                  eventId: event.id,
                  detail: `model call ${id} has consecutive ${roles[i]} messages; the intervening turn is missing`,
                });
                writeExhaustive = false;
                break;
              }
            }
          }
        }
      }
      if (event.event === 'write.model.completed') {
        const call = calls.get(event.subject);
        if (call) call.completed = event;
        if (!event.refs.response_hash || typeof event.refs.response_chars !== 'number') {
          violations.push({
            code: 'write_model_response_missing',
            eventId: event.id,
            detail: `model call ${event.subject} has no response hash/length`,
          });
          writeExhaustive = false;
        }
      }
      if (event.event === 'write.model.failed') {
        const call = calls.get(event.subject);
        if (call) call.failed = event;
        if (event.refs.stage === 'best-effort') {
          limitations.push(`optional context model call ${event.subject} failed; the writer continued`);
        } else {
          writeExhaustive = false;
        }
      }
    }
    for (const [id, call] of calls) {
      if (!call.completed && !call.failed) {
        violations.push({
          code: 'write_model_call_missing_terminal',
          eventId: call.started.id,
          detail: `model call ${id} has no completed/failed terminal event`,
        });
        writeExhaustive = false;
      }
    }

    const outputDispositions = new Map<string, TraceEventRecord[]>();
    for (const event of writeEvents) {
      if (event.event === 'write.output.disposition') {
        const list = outputDispositions.get(event.subject) ?? [];
        list.push(event);
        outputDispositions.set(event.subject, list);
      }
    }
    for (const [id, call] of calls) {
      if (call.role !== 'writer' && call.role !== 'continuation') continue;
      if (!call.completed) continue;
      const list = outputDispositions.get(id) ?? [];
      if (list.length !== 1) {
        violations.push({
          code: 'write_output_disposition',
          eventId: call.completed.id,
          detail: `model call ${id} has ${list.length} output dispositions`,
        });
        writeExhaustive = false;
      }
    }

    if (writeFailed) {
      writeExhaustive = false;
    } else if (writeCompleted) {
      if (!finalOutput) {
        violations.push({
          code: 'write_output_missing',
          detail: 'successful write trace has no final output event',
        });
        writeExhaustive = false;
      }
      if (!stored) {
        violations.push({
          code: 'write_storage_missing',
          detail: 'successful write trace has no stored chapter event',
        });
        writeExhaustive = false;
      }
      if (finalOutput && stored) {
        if (finalOutput.refs.body_hash !== stored.refs.body_hash) {
          violations.push({
            code: 'write_storage_hash_mismatch',
            eventId: stored.id,
            detail: 'stored body hash does not match the write output hash',
          });
          writeExhaustive = false;
        }
        if (finalOutput.refs.body_words !== stored.refs.body_words) {
          violations.push({
            code: 'write_storage_word_mismatch',
            eventId: stored.id,
            detail: 'stored body word count does not match the write output',
          });
          writeExhaustive = false;
        }
        const chapterId = Number(stored.refs.chapter_id);
        const chapter = Number.isInteger(chapterId) && chapterId > 0
          ? db.get<{ body: string }>(
              'SELECT body FROM chapter WHERE id = ? AND project_id = ?',
              chapterId,
              trace.projectId,
            )
          : undefined;
        if (!chapter) {
          violations.push({
            code: 'write_storage_chapter_missing',
            eventId: stored.id,
            detail: `stored chapter ${stored.refs.chapter_id ?? '(none)'} does not exist`,
          });
          writeExhaustive = false;
        } else {
          const currentHash = createHash('sha256').update(chapter.body, 'utf8').digest('hex');
          if (currentHash !== String(stored.refs.body_hash ?? '')) {
            limitations.push('stored chapter body changed after the write trace; storage hash describes the trace-time body');
          }
        }
      }
    } else if (writeComplete) {
      violations.push({
        code: 'write_completion_missing',
        detail: 'complete write trace has neither write.completed nor write.failed',
      });
      writeExhaustive = false;
    }

    const dedupeEvents = writeEvents.filter((event) => event.event === 'write.output.dedupe');
    const dedupeCount = dedupeEvents.length
      ? Number(dedupeEvents[dedupeEvents.length - 1]!.refs.dropped_paragraphs ?? 0)
      : 0;
    if (
      writeCompleted &&
      typeof writeCompleted.refs.dropped_paragraphs === 'number' &&
      Number(writeCompleted.refs.dropped_paragraphs) !== dedupeCount
    ) {
      violations.push({
        code: 'write_dedupe_count_mismatch',
        eventId: writeCompleted.id,
        detail: `write.completed reports ${writeCompleted.refs.dropped_paragraphs} dropped paragraphs; output.dedupe reports ${dedupeCount}`,
      });
      writeExhaustive = false;
    }

    const parsedRequests = new Map<string, TraceEventRecord[]>();
    const requestTerminals = new Map<string, TraceEventRecord[]>();
    const consumedAnswers = new Set<string>();
    const notIncludedAnswers = new Set<string>();
    const requestEventNames = new Set([
      'write.request.resolved',
      'write.request.empty',
      'write.request.denied',
      'write.request.duplicate',
      'write.request.over-limit',
      'write.request.not-processed',
      'write.request.unanswered',
    ]);
    for (const event of writeEvents) {
      if (event.event === 'write.request.parsed') {
        const key = `${event.subject}:${event.refs.seq ?? ''}`;
        parsedRequests.set(key, [...(parsedRequests.get(key) ?? []), event]);
      }
      if (requestEventNames.has(event.event)) {
        const key = `${event.subject}:${event.refs.seq ?? ''}`;
        requestTerminals.set(key, [...(requestTerminals.get(key) ?? []), event]);
      }
      if (event.event === 'write.answer.consumed') {
        consumedAnswers.add(`${event.subject}:${event.refs.seq ?? ''}`);
      }
      if (event.event === 'write.answer.not-included') {
        notIncludedAnswers.add(`${event.subject}:${event.refs.seq ?? ''}`);
      }
    }
    for (const [key, parsed] of parsedRequests) {
      const terminal = requestTerminals.get(key) ?? [];
      if (terminal.length !== 1) {
        violations.push({
          code: 'write_request_terminal',
          eventId: parsed[0]?.id,
          detail: `request ${key} has ${terminal.length} terminal dispositions`,
        });
        writeExhaustive = false;
        continue;
      }
      const outcome = terminal[0]!;
      if (outcome.event === 'write.request.resolved') {
        if (consumedAnswers.has(key) === notIncludedAnswers.has(key)) {
          violations.push({
            code: 'write_answer_consumption',
            eventId: outcome.id,
            detail: `resolved request ${key} must be either consumed or explicitly not included`,
          });
          writeExhaustive = false;
        }
      }
      if (outcome.event === 'write.request.unanswered') {
        if (consumedAnswers.has(key) || notIncludedAnswers.has(key)) {
          violations.push({
            code: 'write_unanswered_request_consumed',
            eventId: outcome.id,
            detail: `unanswered request ${key} has an answer consumption event`,
          });
          writeExhaustive = false;
        }
      }
    }
    for (const [key, terminal] of requestTerminals) {
      if (!parsedRequests.has(key)) {
        violations.push({
          code: 'write_request_without_parse',
          eventId: terminal[0]?.id,
          detail: `request terminal ${key} has no parsed request`,
        });
        writeExhaustive = false;
      }
    }

    const unansweredEvents = writeEvents.filter((event) => event.event === 'write.request.unanswered');
    if (unansweredEvents.length) {
      limitations.push(
        `${unansweredEvents.length} context request(s) were recorded unanswered because the chapter-wide additional-call budget was exhausted`,
      );
    }
    const notProcessedEvents = writeEvents.filter((event) => event.event === 'write.request.not-processed');
    if (notProcessedEvents.length) {
      limitations.push(
        `${notProcessedEvents.length} context request(s) were not processed because the distinct-request slot limit was reached`,
      );
    }
    if (
      writeCompleted &&
      typeof writeCompleted.refs.unanswered_requests === 'number' &&
      Number(writeCompleted.refs.unanswered_requests) !== unansweredEvents.length
    ) {
      violations.push({
        code: 'write_unanswered_count_mismatch',
        eventId: writeCompleted.id,
        detail: `write.completed reports ${writeCompleted.refs.unanswered_requests} unanswered requests; ${unansweredEvents.length} unanswered events found`,
      });
      writeExhaustive = false;
    }

    const ambiguousOutputs = writeEvents.filter(
      (event) =>
        event.event === 'write.output.disposition' &&
        (event.decision === 'ambiguous' || Number(event.refs.ambiguous_chars ?? 0) > 0),
    );
    if (ambiguousOutputs.length) {
      limitations.push(
        `${ambiguousOutputs.length} output(s) have unproven final attribution; surviving/removed text could not be matched exactly`,
      );
    }

    const continuationStarted = new Map<number, TraceEventRecord>();
    const continuationTerminal = new Map<number, TraceEventRecord>();
    for (const event of writeEvents) {
      if (event.event === 'write.continuation.started') {
        const attempt = Number(event.refs.attempt);
        if (Number.isInteger(attempt)) continuationStarted.set(attempt, event);
      }
      if (event.event === 'write.continuation.completed' || event.event === 'write.continuation.empty') {
        const attempt = Number(event.refs.attempt);
        if (Number.isInteger(attempt)) continuationTerminal.set(attempt, event);
      }
    }
    for (const [attempt, event] of continuationStarted) {
      if (!continuationTerminal.has(attempt)) {
        violations.push({
          code: 'write_continuation_missing_terminal',
          eventId: event.id,
          detail: `continuation ${attempt} has no completed/empty terminal`,
        });
        writeExhaustive = false;
      }
    }

    if (writeComplete && !writeCompleted && !writeFailed) {
      writeExhaustive = false;
    }
  }

  const extractionEvents = events.filter((event) => event.stage === EXTRACTION_TRACE_STAGE);
  if (extractionEvents.length) {
    checks.push(
      'extraction relation candidates have one terminal disposition when the trace is exhaustive',
      'extraction parsed counts reconcile with candidate, claim and terminal events per window',
      'extraction claims carry the IDs required by their decision',
      'every finished extraction window has one relation-section report',
      'extraction events are diagnostic and never claim committed canon writes',
      'extraction coverage begins at parsed JSON candidates, not at the prompt',
      'extraction top-level exhaustive is false because the inline close-loop phase is not candidate-traced',
    );
    limitations.push(
      'extraction coverage begins at parsed JSON candidates; claims the model omitted are not observable and are never invented',
      'extraction relation/hint/note/event IDs are recorded at decision time; later kinship dedupe or entity merge may replace or delete them, and the audit checks presence/type in the trace rather than project ownership, claim provenance or final database lineage',
      'extraction hashes are unsalted SHA-256 fingerprints, not anonymisation; a short guessed label or quote can be confirmed by hashing it',
      'the extraction trace privacy contract covers trace events only; extraction_run and extraction_window_run may contain raw error text or settings',
      'dropped_events is a lower bound when the ledger itself cannot persist an event; completeness is then truncated or interrupted and audit never verifies the trace',
      'inline close-the-loop enrichment runs after extraction trace finalization; its model calls, candidates and final ties are untraced, so this is not full-pipeline or final-lineage coverage',
    );

    const sectionEvents = extractionEvents.filter((event) => event.event === EXTRACTION_EVENT_SECTION);
    const relationSections = sectionEvents.filter((event) => event.refs.request_kind === 'relations');
    const parsedCandidates = relationSections
      .filter((event) => event.decision === 'parsed' || event.decision === 'partial')
      .reduce((sum, event) => sum + Number(event.refs.count ?? 0), 0);
    const candidates = new Map<string, TraceEventRecord>();
    const candidateCountByWindow = new Map<number, number>();
    const claimsByCandidate = new Map<string, TraceEventRecord[]>();
    const dispositions = new Map<string, TraceEventRecord[]>();
    const terminalCounts = {
      inserted: 0,
      merged: 0,
      hinted: 0,
      noted: 0,
      dropped: 0,
      mixed: 0,
      errors: 0,
    };
    let terminalDispositions = 0;
    let abortedCandidates = 0;
    const claimDecisions = new Set(['inserted', 'merged', 'hinted', 'noted', 'dropped']);
    const terminalDecisions = new Set([
      'inserted', 'merged', 'mixed', 'hinted', 'noted', 'dropped', 'error',
    ]);

    for (const event of extractionEvents) {
      if (event.eventClass === 'required' || event.committed) {
        violations.push({
          code: 'extraction_event_durability',
          eventId: event.id,
          detail: 'extraction trace events are best-effort diagnostics and must not claim a committed canon write',
        });
        extractionExhaustive = false;
      }
      if (event.event === EXTRACTION_EVENT_CANDIDATE) {
        if (candidates.has(event.subject)) {
          violations.push({
            code: 'extraction_candidate_duplicate',
            eventId: event.id,
            detail: `candidate ${event.subject} was registered more than once`,
          });
          extractionExhaustive = false;
        }
        candidates.set(event.subject, event);
        const windowIndex = Number(event.refs.window_index);
        if (!Number.isInteger(windowIndex) || windowIndex < 0) {
          violations.push({
            code: 'extraction_candidate_window_missing',
            eventId: event.id,
            detail: `candidate ${event.subject} has no valid window_index`,
          });
          extractionExhaustive = false;
        } else {
          candidateCountByWindow.set(windowIndex, (candidateCountByWindow.get(windowIndex) ?? 0) + 1);
        }
        if (typeof event.refs.kind_hash !== 'string' || !event.refs.kind_hash) {
          violations.push({
            code: 'extraction_candidate_kind_missing',
            eventId: event.id,
            detail: `candidate ${event.subject} has no kind_hash`,
          });
          extractionExhaustive = false;
        }
      }
      if (event.event === EXTRACTION_EVENT_CLAIM) {
        if (!claimDecisions.has(event.decision)) {
          violations.push({
            code: 'extraction_claim_unexplained',
            eventId: event.id,
            detail: `extraction claim has unknown decision ${event.decision || '(empty)'}`,
          });
          extractionExhaustive = false;
        }
        if (!event.reasonCode) {
          violations.push({
            code: 'extraction_claim_unexplained',
            eventId: event.id,
            detail: `extraction claim for ${event.subject} has no reason code`,
          });
          extractionExhaustive = false;
        }
        const hasRelation = typeof event.refs.relation_id === 'number' && event.refs.relation_id > 0;
        const hasHint = typeof event.refs.hint_id === 'number' && event.refs.hint_id > 0;
        const hasNote = typeof event.refs.note_id === 'number' && event.refs.note_id > 0;
        if (
          (event.decision === 'inserted' && !hasRelation) ||
          (event.decision === 'merged' && (!hasRelation || (event.refs.status !== 'primary' && event.refs.status !== 'supporting'))) ||
          (event.decision === 'hinted' && !hasHint) ||
          (event.decision === 'noted' && !hasNote)
        ) {
          violations.push({
            code: 'extraction_claim_missing_reference',
            eventId: event.id,
            detail: `claim ${event.subject} (${event.decision}) does not carry its required downstream id/status`,
          });
          extractionExhaustive = false;
        }
        const list = claimsByCandidate.get(event.subject) ?? [];
        list.push(event);
        claimsByCandidate.set(event.subject, list);
      }
      if (event.event !== EXTRACTION_EVENT_DISPOSITION) continue;
      const list = dispositions.get(event.subject) ?? [];
      list.push(event);
      dispositions.set(event.subject, list);
      terminalDispositions++;
      if (event.reasonCode === 'candidate-aborted') abortedCandidates++;
      if (!terminalDecisions.has(event.decision)) {
        violations.push({
          code: 'extraction_candidate_unexplained',
          eventId: event.id,
          detail: `candidate ${event.subject} has unknown disposition ${event.decision || '(empty)'}`,
        });
        extractionExhaustive = false;
        continue;
      }
      if (!event.reasonCode) {
        violations.push({
          code: 'extraction_candidate_unexplained',
          eventId: event.id,
          detail: `candidate ${event.subject} has no reason code`,
        });
        extractionExhaustive = false;
      }
      if (event.decision === 'inserted') terminalCounts.inserted++;
      else if (event.decision === 'merged') terminalCounts.merged++;
      else if (event.decision === 'hinted') terminalCounts.hinted++;
      else if (event.decision === 'noted') terminalCounts.noted++;
      else if (event.decision === 'dropped') terminalCounts.dropped++;
      else if (event.decision === 'mixed') terminalCounts.mixed++;
      else if (event.decision === 'error') terminalCounts.errors++;
    }

    const runFinal = [...extractionEvents]
      .reverse()
      .find((event) => event.event === EXTRACTION_EVENT_RUN_FINALIZED);
    const runStatus = runFinal?.decision ?? 'unknown';
    const windowEvents = extractionEvents.filter((event) => event.event === EXTRACTION_EVENT_WINDOW_FINISHED);
    const windowIndices = new Set<number>();
    const incompleteWindows = windowEvents.filter(
      (event) => event.decision === 'partial' || event.decision === 'failed',
    ).length;
    for (const event of windowEvents) {
      const windowIndex = Number(event.refs.window_index);
      if (Number.isInteger(windowIndex) && windowIndex >= 0) windowIndices.add(windowIndex);
    }
    const relationSectionsByWindow = new Map<number, TraceEventRecord[]>();
    for (const event of relationSections) {
      const windowIndex = Number(event.refs.window_index);
      if (!Number.isInteger(windowIndex) || windowIndex < 0) {
        violations.push({
          code: 'extraction_section_window_missing',
          eventId: event.id,
          detail: 'relation-section event has no valid window_index',
        });
        extractionExhaustive = false;
        continue;
      }
      const list = relationSectionsByWindow.get(windowIndex) ?? [];
      list.push(event);
      relationSectionsByWindow.set(windowIndex, list);
    }
    const failedSectionEvents = sectionEvents.filter((event) => event.decision === 'failed');
    const missingSectionEvents = sectionEvents.filter((event) => event.decision === 'missing');
    const partialSectionEvents = sectionEvents.filter((event) => event.decision === 'partial');
    const unparsedSectionEvents = sectionEvents.filter((event) => event.decision === 'unparsed');
    const skippedSectionEvents = sectionEvents.filter((event) => event.decision === 'skipped');
    const traceComplete =
      trace.completeness === 'complete' &&
      trace.droppedEvents === 0 &&
      trace.sampledRate === 1 &&
      !!trace.finishedAt;

    if (!runFinal) {
      limitations.push('extraction run has no finalization event; its run status is unknown');
      extractionExhaustive = false;
    } else if (runStatus !== 'completed') {
      limitations.push(`extraction run finished with status ${runStatus}; the trace is not a complete extraction account`);
      extractionExhaustive = false;
    }
    if (failedSectionEvents.length) {
      limitations.push(
        `${failedSectionEvents.length} extraction section call(s) failed: ` +
          [...new Set(failedSectionEvents.map((event) => String(event.refs.request_kind ?? 'unknown')))].join(', '),
      );
      extractionExhaustive = false;
    }
    if (missingSectionEvents.length) {
      limitations.push(
        `${missingSectionEvents.length} extraction section key(s) were absent from a parsed answer; ` +
          'absence is not treated as a confident empty section',
      );
      extractionExhaustive = false;
    }
    if (partialSectionEvents.length) {
      limitations.push(
        `${partialSectionEvents.length} extraction section answer(s) were only partially parsed; ` +
          'salvaged candidates are accounted, but the answer is not treated as complete',
      );
      extractionExhaustive = false;
    }
    if (unparsedSectionEvents.length) {
      limitations.push(
        `${unparsedSectionEvents.length} extraction section answer(s) contained content but parsed no candidate; ` +
          'truncation and malformed JSON are not distinguishable at this layer',
      );
      extractionExhaustive = false;
    }
    if (skippedSectionEvents.length) {
      limitations.push(
        `${skippedSectionEvents.length} extraction section(s) were skipped; zero candidates there is not treated as a verified extraction`,
      );
      extractionExhaustive = false;
    }
    if (!relationSections.length) {
      limitations.push('no relation-section parse event was recorded; candidate coverage cannot be verified');
      extractionExhaustive = false;
    }
    const plannedWindows = Number(trace.metadata.planned_windows);
    if (
      Number.isInteger(plannedWindows) &&
      plannedWindows >= 0 &&
      windowEvents.length !== plannedWindows
    ) {
      limitations.push(
        `trace records ${windowEvents.length} finished window(s) but the extraction planned ${plannedWindows}`,
      );
      extractionExhaustive = false;
    }

    if (!traceComplete) {
      suspicious.push({
        code: 'extraction_accounting_unavailable',
        detail:
          `completeness=${trace.completeness}, dropped_events=${trace.droppedEvents}, ` +
          `sampled_rate=${trace.sampledRate}, finished=${!!trace.finishedAt}`,
      });
      extractionExhaustive = false;
    } else {
      const before = violations.length;
      for (const candidate of candidates.keys()) {
        const terminal = dispositions.get(candidate) ?? [];
        if (!terminal.length) {
          violations.push({
            code: 'extraction_candidate_missing_disposition',
            detail: `candidate ${candidate} has no terminal disposition`,
          });
        } else if (terminal.length > 1) {
          violations.push({
            code: 'extraction_candidate_multiple_dispositions',
            detail: `candidate ${candidate} has ${terminal.length} terminal dispositions`,
          });
        }
      }
      for (const [candidate, terminal] of dispositions) {
        if (!candidates.has(candidate)) {
          violations.push({
            code: 'extraction_disposition_without_candidate',
            eventId: terminal[0]?.id,
            detail: `disposition ${candidate} has no parsed candidate`,
          });
        }
        const claims = claimsByCandidate.get(candidate) ?? [];
        const claimCounts = {
          inserted: claims.filter((claim) => claim.decision === 'inserted').length,
          merged: claims.filter((claim) => claim.decision === 'merged').length,
          hinted: claims.filter((claim) => claim.decision === 'hinted').length,
          noted: claims.filter((claim) => claim.decision === 'noted').length,
          dropped: claims.filter((claim) => claim.decision === 'dropped').length,
        };
        for (const disposition of terminal) {
          const expected = {
            inserted: Number(disposition.refs.inserted_count ?? -1),
            merged: Number(disposition.refs.merged_count ?? -1),
            hinted: Number(disposition.refs.hinted_count ?? -1),
            noted: Number(disposition.refs.noted_count ?? -1),
            dropped: Number(disposition.refs.dropped_count ?? -1),
          };
          if (
            Object.entries(expected).some(([key, value]) =>
              !Number.isInteger(value) || value < 0 || claimCounts[key as keyof typeof claimCounts] !== value,
            ) ||
            Number(disposition.refs.claim_count ?? -1) !== claims.length
          ) {
            violations.push({
              code: 'extraction_claim_count_mismatch',
              eventId: disposition.id,
              detail: `candidate ${candidate} disposition counts do not match its claim events`,
            });
          }
          if (disposition.decision === 'inserted' && claimCounts.inserted === 0) {
            violations.push({
              code: 'extraction_claim_missing_for_disposition',
              eventId: disposition.id,
              detail: `candidate ${candidate} is inserted without an inserted claim`,
            });
          }
          if (disposition.decision === 'merged' && claimCounts.merged === 0) {
            violations.push({
              code: 'extraction_claim_missing_for_disposition',
              eventId: disposition.id,
              detail: `candidate ${candidate} is merged without a merged claim`,
            });
          }
          if (disposition.decision === 'hinted' && claimCounts.hinted === 0) {
            violations.push({
              code: 'extraction_claim_missing_for_disposition',
              eventId: disposition.id,
              detail: `candidate ${candidate} is hinted without a hinted claim`,
            });
          }
          if (disposition.decision === 'noted' && claimCounts.noted === 0) {
            violations.push({
              code: 'extraction_claim_missing_for_disposition',
              eventId: disposition.id,
              detail: `candidate ${candidate} is noted without a noted claim`,
            });
          }
          if (disposition.decision === 'dropped' && claimCounts.dropped === 0) {
            violations.push({
              code: 'extraction_claim_missing_for_disposition',
              eventId: disposition.id,
              detail: `candidate ${candidate} is dropped without a dropped claim`,
            });
          }
        }
      }
      for (const [candidate, claims] of claimsByCandidate) {
        if (!candidates.has(candidate)) {
          violations.push({
            code: 'extraction_claim_without_candidate',
            eventId: claims[0]?.id,
            detail: `claim ${candidate} has no parsed candidate`,
          });
        }
      }
      for (const windowIndex of windowIndices) {
        const sections = relationSectionsByWindow.get(windowIndex) ?? [];
        if (sections.length !== 1) {
          violations.push({
            code: 'extraction_window_section_missing',
            detail: `window ${windowIndex} has ${sections.length} relation-section report(s), expected one`,
          });
        }
      }
      for (const windowIndex of relationSectionsByWindow.keys()) {
        if (!windowIndices.has(windowIndex)) {
          violations.push({
            code: 'extraction_section_without_window',
            detail: `relation section ${windowIndex} has no finished window event`,
          });
        }
      }
      for (const windowIndex of candidateCountByWindow.keys()) {
        if (!windowIndices.has(windowIndex)) {
          violations.push({
            code: 'extraction_candidate_without_window',
            detail: `candidate window ${windowIndex} has no finished window event`,
          });
        }
      }
      for (const [windowIndex, sections] of relationSectionsByWindow) {
        for (const section of sections) {
          if (section.decision !== 'parsed' && section.decision !== 'partial') continue;
          const expected = Number(section.refs.count ?? -1);
          const observed = candidateCountByWindow.get(windowIndex) ?? 0;
          if (!Number.isInteger(expected) || expected < 0 || observed !== expected) {
            violations.push({
              code: 'extraction_window_candidate_mismatch',
              eventId: section.id,
              detail: `window ${windowIndex} parsed ${expected} candidate(s) but recorded ${observed}`,
            });
          }
        }
      }
      if (parsedCandidates !== candidates.size) {
        violations.push({
          code: 'extraction_candidate_accounting_mismatch',
          detail: `parsed ${parsedCandidates} relation candidate(s) but observed ${candidates.size} candidate event(s)`,
        });
      }
      if (violations.length > before) extractionExhaustive = false;
    }

    const claimEvents = traceComplete
      ? {
          inserted: extractionEvents.filter((event) => event.event === EXTRACTION_EVENT_CLAIM && event.decision === 'inserted').length,
          merged: extractionEvents.filter((event) => event.event === EXTRACTION_EVENT_CLAIM && event.decision === 'merged').length,
          hinted: extractionEvents.filter((event) => event.event === EXTRACTION_EVENT_CLAIM && event.decision === 'hinted').length,
          noted: extractionEvents.filter((event) => event.event === EXTRACTION_EVENT_CLAIM && event.decision === 'noted').length,
          dropped: extractionEvents.filter((event) => event.event === EXTRACTION_EVENT_CLAIM && event.decision === 'dropped').length,
        }
      : null;
    const uniqueHints = traceComplete
      ? new Set(
          extractionEvents
            .filter((event) => event.event === EXTRACTION_EVENT_CLAIM && event.decision === 'hinted')
            .map((event) => Number(event.refs.hint_id))
            .filter((id) => Number.isInteger(id) && id > 0),
        ).size
      : null;
    extractionAccounting = {
      parsedCandidates,
      terminalDispositions,
      candidateOutcomes: {
        inserted: terminalCounts.inserted,
        merged: terminalCounts.merged,
        hinted: terminalCounts.hinted,
        noted: terminalCounts.noted,
        dropped: terminalCounts.dropped,
        mixed: terminalCounts.mixed,
        errors: terminalCounts.errors,
      },
      claimEvents,
      uniqueHints,
      pipelineScope: 'window-candidates-only',
      pipelineLineage: 'non-exhaustive',
      runStatus,
      windows: windowEvents.length,
      incompleteWindows,
      failedSections: failedSectionEvents.length,
      missingSections: missingSectionEvents.length,
      partialSections: partialSectionEvents.length,
      unparsedSections: unparsedSectionEvents.length,
      skippedSections: skippedSectionEvents.length,
      abortedCandidates,
      candidateAccountingVerified: extractionExhaustive,
      verified: extractionExhaustive,
    };
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
    exhaustive:
      trace.completeness === 'complete' &&
      trace.droppedEvents === 0 &&
      contextExhaustive &&
      writeExhaustive &&
      extractionExhaustive &&
      extractionEvents.length === 0,
    droppedEvents: trace.droppedEvents,
    sampledRate: trace.sampledRate,
    finishedAt: trace.finishedAt,
    violations,
    suspicious,
    checks,
    limitations,
    noteAccounting,
    extractionAccounting,
  };
}
