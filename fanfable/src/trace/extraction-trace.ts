/**
 * Diagnostic trace for relationship extraction.
 *
 * The trace starts at the parsed JSON candidates. It never invents a candidate
 * the model did not emit, never stores prompt/response/passage text, and never
 * fails the extraction: every write is best-effort and diagnostic. Names,
 * quotes and labels are represented only by IDs, lengths and unsalted SHA-256
 * fingerprints. These hashes are correlation handles, not anonymisation: a
 * short, guessed value can be confirmed by hashing it.
 *
 * The public surface accepts only closed enums and numeric IDs. Provider and
 * model strings are deliberately omitted from trace metadata/events; the
 * extraction_run row remains the authoritative place for those settings.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../core/db.ts';
import type { AttestedReason } from '../gates/gates.ts';
import * as traceLog from './trace.ts';
import {
  DIAGNOSTIC_MAX_EVENTS_CEILING,
  EXTRACTION_EVENT_CANDIDATE,
  EXTRACTION_EVENT_CITATION,
  EXTRACTION_EVENT_CLAIM,
  EXTRACTION_EVENT_DIRECTION,
  EXTRACTION_EVENT_DISPOSITION,
  EXTRACTION_EVENT_ENDPOINT,
  EXTRACTION_EVENT_RETRY,
  EXTRACTION_EVENT_RUN_FINALIZED,
  EXTRACTION_EVENT_SECTION,
  EXTRACTION_EVENT_STARTED,
  EXTRACTION_EVENT_WINDOW_FINISHED,
  EXTRACTION_EVENT_WINDOW_STARTED,
  EXTRACTION_TRACE_STAGE,
  type ExtractionTerminalDecision,
  type TraceRefs,
} from './trace.ts';

const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const positive = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
};
const nonNegative = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
};

export type ExtractionSectionName = 'entities-facts' | 'entities' | 'facts' | 'relations' | 'timeline' | 'legacy';
export type ExtractionSectionState = 'parsed' | 'empty' | 'missing' | 'partial' | 'unparsed' | 'failed' | 'skipped';
export type ExtractionParseRoute =
  | 'whole-section-array'
  | 'fenced-section-array'
  | 'embedded-section-array'
  | 'whole-bare-array'
  | 'fenced-bare-array'
  | 'embedded-bare-array'
  | 'salvaged-array'
  | 'empty-array'
  | 'missing-section'
  | 'wrong-shape'
  | 'filtered-array'
  | 'empty-response'
  | 'unparsed';

export interface ExtractionParseObservation {
  route: ExtractionParseRoute;
  /** Unknown when the extracted array is not proven to belong to this section. */
  rawEntries: number | null;
  acceptedEntries: number;
  filteredEntries: number | null;
  salvagedEntries: number;
  /** The parser used an embedded array that is not section-identified. */
  incomplete?: boolean;
}

export type ExtractionSectionReason =
  | 'parsed-array'
  | 'empty-array'
  | 'empty-answer'
  | 'empty-response'
  | 'section-missing'
  | 'partial-array'
  | 'mixed-entries'
  | 'schema-mismatch'
  | 'unparsed-answer'
  | 'call-error'
  | 'no-roster-names';

export type EndpointResolutionMethod =
  | 'direct-name'
  | 'direct-alias'
  | 'direct-mixed'
  | 'direct-collision'
  | 'short-name'
  | 'short-collision'
  | 'none'
  | 'empty';

export interface TracedEndpointResolution {
  id?: number;
  method: EndpointResolutionMethod;
  candidateIds: number[];
}

export interface ExtractionTraceOptions {
  enabled?: boolean;
  /** Extraction traces default to the ledger ceiling; explicit caps are honoured. */
  maxEvents?: number;
}

export interface ExtractionTraceStartInfo {
  runId: number;
  windowSize: number;
  plannedWindows: number;
  singlePrompt: boolean;
  maxEvents?: number;
}

export interface RelationOutcomeCounts {
  inserted: number;
  merged: number;
  hinted: number;
  noted: number;
  dropped: number;
}

export interface ExtractionClaimRefs {
  relation_id?: number;
  hint_id?: number;
  note_id?: number;
  event_id?: number;
  status?: 'primary' | 'supporting';
}

export type RetryReason =
  | 'verbatim-both-names'
  | 'located-verbatim'
  | 'no-usable-sentence'
  | 'not-verbatim'
  | 'missing-endpoint'
  | 'window-cap';

export type CitationReason =
  | 'quote-verified'
  | 'quote-repointed'
  | 'quote-not-found'
  | 'quote-not-verbatim'
  | 'anchor-not-verbatim'
  | 'hint-quote-verified'
  | 'hint-quote-repointed'
  | 'hint-quote-not-found';

export type ClaimReason =
  | 'banked'
  | 'primary-adopted'
  | 'supporting-preserved'
  | 'unresolved-endpoint'
  | 'hint-created'
  | 'hint-updated'
  | 'hint-existing'
  | 'hint-invalid-name'
  | 'hint-same-name'
  | 'hint-invalid-kind'
  | 'hint-no-quote'
  | 'hint-write-unavailable'
  | 'unsupported-citation'
  | 'anchor-not-verbatim'
  | 'kind-unsupported'
  | 'moment'
  | 'redundant-kind'
  | 'same-entity'
  | 'no-kind'
  | 'no-verified-hint'
  | 'candidate-error'
  | `citation-${AttestedReason}`;

export type DispositionReason =
  | 'candidate-inserted'
  | 'candidate-merged'
  | 'candidate-hinted'
  | 'candidate-noted'
  | 'candidate-dropped'
  | 'mixed-outcomes'
  | 'same-entity'
  | 'invalid-citation'
  | 'invalid-anchor'
  | 'unresolved-endpoint'
  | 'ambiguous-endpoint'
  | 'hint-refused'
  | 'no-verified-hint'
  | 'no-claim-outcome'
  | 'candidate-exception'
  | 'candidate-aborted';

export type ExtractionRunStatus = 'completed' | 'partial' | 'failed' | 'running' | 'unknown';
export type ExtractionIncompleteReason =
  | 'event-write'
  | 'preparation'
  | 'note-id-lookup'
  | 'hint-id-lookup'
  | 'run-finalization-read'
  | 'candidate-abort';

const PARSE_ROUTES = new Set<ExtractionParseRoute>([
  'whole-section-array', 'fenced-section-array', 'embedded-section-array',
  'whole-bare-array', 'fenced-bare-array', 'embedded-bare-array',
  'salvaged-array', 'empty-array', 'missing-section', 'wrong-shape',
  'filtered-array', 'empty-response', 'unparsed',
]);
const SECTION_STATES = new Set<ExtractionSectionState>([
  'parsed', 'empty', 'missing', 'partial', 'unparsed', 'failed', 'skipped',
]);
const SECTION_REASONS = new Set<ExtractionSectionReason>([
  'parsed-array', 'empty-array', 'empty-answer', 'empty-response', 'section-missing',
  'partial-array', 'mixed-entries', 'schema-mismatch', 'unparsed-answer',
  'call-error', 'no-roster-names',
]);
const ENDPOINT_METHODS = new Set<EndpointResolutionMethod>([
  'direct-name', 'direct-alias', 'direct-mixed', 'direct-collision',
  'short-name', 'short-collision', 'none', 'empty',
]);
const RETRY_REASONS = new Set<RetryReason>([
  'verbatim-both-names', 'located-verbatim', 'no-usable-sentence', 'not-verbatim', 'missing-endpoint', 'window-cap',
]);
const CITATION_REASONS = new Set<CitationReason>([
  'quote-verified', 'quote-repointed', 'quote-not-found', 'quote-not-verbatim',
  'anchor-not-verbatim', 'hint-quote-verified', 'hint-quote-repointed', 'hint-quote-not-found',
]);
const CLAIM_REASONS = new Set<string>([
  'banked', 'primary-adopted', 'supporting-preserved', 'unresolved-endpoint',
  'hint-created', 'hint-updated', 'hint-existing', 'hint-invalid-name', 'hint-same-name',
  'hint-invalid-kind', 'hint-no-quote', 'hint-write-unavailable',
  'unsupported-citation', 'anchor-not-verbatim', 'kind-unsupported', 'moment',
  'redundant-kind', 'same-entity', 'no-kind', 'no-verified-hint', 'candidate-error',
  'citation-open-vocab', 'citation-coverage-only', 'citation-ruled-park',
  'citation-quote-not-verbatim', 'citation-tie-word-absent', 'citation-endpoint-unnamed',
  'citation-direction-mismatch', 'citation-generic-kind', 'citation-non-person-endpoint',
  'citation-same-identity', 'citation-quarantined-entity', 'citation-assertion-missing',
  'citation-relationship-not-entailed', 'citation-below-threshold', 'citation-moment',
  'citation-keeper-track', 'citation-assessment-missing',
]);
const DISPOSITION_REASONS = new Set<DispositionReason>([
  'candidate-inserted', 'candidate-merged', 'candidate-hinted', 'candidate-noted',
  'candidate-dropped', 'mixed-outcomes', 'same-entity', 'invalid-citation',
  'invalid-anchor', 'unresolved-endpoint', 'ambiguous-endpoint', 'hint-refused', 'no-verified-hint',
  'no-claim-outcome', 'candidate-exception', 'candidate-aborted',
]);
const RUN_STATUSES = new Set<ExtractionRunStatus>([
  'completed', 'partial', 'failed', 'running', 'unknown',
]);
const SECTION_NAMES = new Set<ExtractionSectionName>([
  'entities-facts', 'entities', 'facts', 'relations', 'timeline', 'legacy',
]);
const CLAIM_DECISIONS = new Set(['inserted', 'merged', 'hinted', 'noted', 'dropped']);
const DISPOSITION_DECISIONS = new Set<ExtractionTerminalDecision>([
  'inserted', 'merged', 'mixed', 'hinted', 'noted', 'dropped', 'error',
]);
const CITATION_DECISIONS = new Set(['verified', 'repointed', 'dropped', 'rejected']);
const RETRY_DECISIONS = new Set(['fixed', 'failed']);
const WINDOW_STATES = new Set(['complete', 'partial', 'failed']);
const INCOMPLETE_REASONS = new Set<ExtractionIncompleteReason>([
  'event-write', 'preparation', 'note-id-lookup', 'hint-id-lookup',
  'run-finalization-read', 'candidate-abort',
]);

export class ExtractionTrace {
  readonly traceId: string;
  private readonly db: Db;
  private readonly projectId: number;
  private readonly runId: number;
  private readonly rootSpan = 'sp-extract';
  private readonly registered = new Map<string, { windowIndex: number; disposed: boolean }>();
  private finished = false;
  private loss = false;
  private exhausted = false;
  private suppressed = 0;

  private constructor(db: Db, projectId: number, traceId: string, runId: number) {
    this.db = db;
    this.projectId = projectId;
    this.traceId = traceId;
    this.runId = runId;
  }

  /** Start a trace, or return null when the ledger is unavailable. Never throws. */
  static start(
    db: Db,
    projectId: number,
    info: ExtractionTraceStartInfo,
  ): ExtractionTrace | null {
    try {
      const runId = positive(info.runId);
      const windowSize = nonNegative(info.windowSize);
      const plannedWindows = nonNegative(info.plannedWindows);
      if (runId === undefined || windowSize === undefined || plannedWindows === undefined) return null;
      const record = traceLog.startTrace(db, {
        projectId,
        maxEvents: Math.min(
          DIAGNOSTIC_MAX_EVENTS_CEILING,
          Math.max(1, Math.floor(info.maxEvents ?? DIAGNOSTIC_MAX_EVENTS_CEILING)),
        ),
        metadata: {
          kind: 'fanfable-extraction',
          version: 2,
          run_id: runId,
          window_size: windowSize,
          planned_windows: plannedWindows,
          single_prompt: info.singlePrompt === true,
          accounting: 'parsed-relations-only',
          lineage: 'at-decision',
          hash_mode: 'sha256-unsalted',
          privacy_scope: 'trace-events-only',
        },
      });
      const trace = new ExtractionTrace(db, projectId, record.id, runId);
      trace.event(trace.rootSpan, EXTRACTION_EVENT_STARTED, `run:${runId}`, 'started', 'extraction-start', {
        count: plannedWindows,
      });
      return trace;
    } catch {
      return null;
    }
  }

  /** Stable local id for a parsed relation candidate; no id exists for unseen text. */
  relationCandidateId(windowIndex: number, ordinal: number): string {
    return `candidate:w${windowIndex}:relations:${ordinal}`;
  }

  /**
   * Register every parsed relation candidate before strict rewrites or retries.
   * Returns ids aligned with the input array, even when diagnostics are lost.
   */
  registerRelationCandidates(
    windowIndex: number,
    candidates: Array<{ kind: string; kindCount: number }>,
  ): string[] {
    if (!this.validWindowIndex(windowIndex)) {
      this.markLoss('preparation');
      return [];
    }
    let ids: string[];
    try {
      ids = candidates.map((_, ordinal) => this.relationCandidateId(windowIndex, ordinal));
    } catch {
      this.markLoss('preparation');
      return [];
    }
    if (this.exhausted) {
      this.suppressed += candidates.length;
      return ids;
    }
    this.guard(() => {
      for (const [ordinal, candidate] of candidates.entries()) {
        const candidateId = ids[ordinal]!;
        const kindCount = nonNegative(candidate.kindCount);
        if (kindCount === undefined) {
          this.markLoss('preparation');
          continue;
        }
        this.registered.set(candidateId, { windowIndex, disposed: false });
        this.event(
          this.windowSpan(windowIndex),
          EXTRACTION_EVENT_CANDIDATE,
          candidateId,
          'parsed',
          'section-relations',
          {
            seq: ordinal,
            window_index: windowIndex,
            kind_hash: sha(candidate.kind),
            kind_count: kindCount,
            count: 1,
          },
        );
      }
    });
    return ids;
  }

  section(
    windowIndex: number,
    section: ExtractionSectionName,
    state: ExtractionSectionState,
    count: number,
    opts: {
      responseText?: string | null;
      reason: ExtractionSectionReason;
      parse?: ExtractionParseObservation;
    },
  ): void {
    if (!this.validWindowIndex(windowIndex) || !SECTION_NAMES.has(section)) {
      this.markLoss('preparation');
      return;
    }
    if (this.exhausted) {
      this.suppressed++;
      return;
    }
    this.guard(() => {
      const reason = opts?.reason;
      const parsedCount = nonNegative(count);
      if (
        !SECTION_STATES.has(state) ||
        !reason ||
        !SECTION_REASONS.has(reason) ||
        parsedCount === undefined
      ) {
        this.markLoss('preparation');
        return;
      }
      const response = opts?.responseText;
      const parse = opts?.parse;
      if (parse && (
        !PARSE_ROUTES.has(parse.route) ||
        nonNegative(parse.acceptedEntries) === undefined ||
        nonNegative(parse.salvagedEntries) === undefined ||
        (parse.rawEntries !== null && nonNegative(parse.rawEntries) === undefined) ||
        (parse.filteredEntries !== null && nonNegative(parse.filteredEntries) === undefined)
      )) {
        this.markLoss('preparation');
        return;
      }
      if (parse?.incomplete) this.markLoss('preparation');
      this.event(
        this.windowSpan(windowIndex),
        EXTRACTION_EVENT_SECTION,
        `section:${windowIndex}:${section}`,
        state,
        reason,
        {
          window_index: windowIndex,
          request_kind: section,
          count: parsedCount,
          ...(parse ? {
            parse_route: parse.route,
            accepted_entries: parse.acceptedEntries,
            salvaged_entries: parse.salvagedEntries,
            ...(parse.rawEntries !== null ? { raw_entries: parse.rawEntries } : {}),
            ...(parse.filteredEntries !== null ? { filtered_entries: parse.filteredEntries } : {}),
          } : {}),
          ...(typeof response === 'string'
            ? { response_hash: sha(response), response_chars: response.length }
            : {}),
        },
      );
    });
  }

  windowStarted(windowIndex: number, chunkIds: number[]): void {
    if (!this.validWindowIndex(windowIndex)) {
      this.markLoss('preparation');
      return;
    }
    if (this.exhausted) {
      this.suppressed++;
      return;
    }
    this.guard(() => {
      this.event(
        this.windowSpan(windowIndex),
        EXTRACTION_EVENT_WINDOW_STARTED,
        `window:${windowIndex}`,
        'started',
        'window-begin',
        {
          window_index: windowIndex,
          chunk_ids: chunkIds.filter((id) => positive(id) !== undefined),
          count: chunkIds.filter((id) => positive(id) !== undefined).length,
        },
      );
    });
  }

  windowFinished(windowIndex: number, state: 'complete' | 'partial' | 'failed', wroteRelations: number): void {
    if (!this.validWindowIndex(windowIndex) || !WINDOW_STATES.has(state)) {
      this.markLoss('preparation');
      return;
    }
    if (this.exhausted) {
      this.suppressed++;
      return;
    }
    this.guard(() => {
      const count = nonNegative(wroteRelations);
      if (count === undefined) {
        this.markLoss('preparation');
        return;
      }
      const decision = state === 'complete' ? 'completed' : state;
      this.event(
        this.windowSpan(windowIndex),
        EXTRACTION_EVENT_WINDOW_FINISHED,
        `window:${windowIndex}`,
        decision,
        `window-${decision}`,
        { window_index: windowIndex, count },
      );
    });
  }

  endpoint(
    candidateId: string,
    side: 'from' | 'to',
    resolution: TracedEndpointResolution,
  ): void {
    if (!this.validCandidateId(candidateId) || (side !== 'from' && side !== 'to')) {
      this.markLoss('preparation');
      return;
    }
    if (this.exhausted) {
      this.suppressed++;
      return;
    }
    this.guard(() => {
      if (!resolution || !ENDPOINT_METHODS.has(resolution.method)) {
        this.markLoss('preparation');
        return;
      }
      const candidateIds = (Array.isArray(resolution.candidateIds) ? resolution.candidateIds : [])
        .map((id) => positive(id))
        .filter((id): id is number => id !== undefined);
      const entityId = resolution.id === undefined ? undefined : positive(resolution.id);
      if (resolution.id !== undefined && entityId === undefined) {
        this.markLoss('preparation');
        return;
      }
      const ambiguous = resolution.method === 'direct-collision' || resolution.method === 'short-collision';
      const decision = entityId !== undefined ? 'resolved' : ambiguous ? 'ambiguous' : 'unresolved';
      this.event(
        this.candidateSpan(candidateId),
        EXTRACTION_EVENT_ENDPOINT,
        `${candidateId}:${side}`,
        decision,
        resolution.method,
        {
          ...(entityId !== undefined ? { entity_id: entityId } : {}),
          ...(candidateIds.length ? { entity_ids: candidateIds } : {}),
          count: candidateIds.length,
        },
      );
    });
  }

  retry(candidateId: string, decision: 'fixed' | 'failed', reason: RetryReason, attempt: number): void {
    if (!this.validCandidateId(candidateId) || !RETRY_DECISIONS.has(decision)) {
      this.markLoss('preparation');
      return;
    }
    if (this.exhausted) {
      this.suppressed++;
      return;
    }
    this.guard(() => {
      const ordinal = nonNegative(attempt);
      if (!RETRY_REASONS.has(reason) || ordinal === undefined) {
        this.markLoss('preparation');
        return;
      }
      this.event(
        this.candidateSpan(candidateId),
        EXTRACTION_EVENT_RETRY,
        candidateId,
        decision,
        reason,
        { attempt: ordinal, count: 1 },
      );
    });
  }

  retryCapped(windowIndex: number, count: number): void {
    if (!this.validWindowIndex(windowIndex)) {
      this.markLoss('preparation');
      return;
    }
    if (this.exhausted) {
      this.suppressed++;
      return;
    }
    this.guard(() => {
      const bounded = nonNegative(count);
      if (bounded === undefined) {
        this.markLoss('preparation');
        return;
      }
      this.event(
        this.windowSpan(windowIndex),
        EXTRACTION_EVENT_RETRY,
        `window:${windowIndex}`,
        'capped',
        'window-cap',
        { window_index: windowIndex, count: bounded },
      );
    });
  }

  citation(
    candidateId: string,
    decision: 'verified' | 'repointed' | 'dropped' | 'rejected',
    reason: CitationReason,
    opts: { chunkId?: number | null; evidence?: string; anchor?: string } = {},
  ): void {
    if (!this.validCandidateId(candidateId) || !CITATION_DECISIONS.has(decision)) {
      this.markLoss('preparation');
      return;
    }
    if (this.exhausted) {
      this.suppressed++;
      return;
    }
    this.guard(() => {
      if (!CITATION_REASONS.has(reason)) {
        this.markLoss('preparation');
        return;
      }
      const chunkId = opts?.chunkId === null || opts?.chunkId === undefined ? undefined : positive(opts.chunkId);
      if (opts?.chunkId !== null && opts?.chunkId !== undefined && chunkId === undefined) {
        this.markLoss('preparation');
        return;
      }
      this.event(
        this.candidateSpan(candidateId),
        EXTRACTION_EVENT_CITATION,
        candidateId,
        decision,
        reason,
        {
          ...(chunkId !== undefined ? { chunk_id: chunkId } : {}),
          ...(opts?.evidence !== undefined
            ? { evidence_hash: sha(opts.evidence), evidence_chars: opts.evidence.length }
            : {}),
          ...(opts?.anchor !== undefined
            ? { anchor_hash: sha(opts.anchor), anchor_chars: opts.anchor.length }
            : {}),
          count: 1,
        },
      );
    });
  }

  direction(candidateId: string, fromId: number, toId: number): void {
    if (!this.validCandidateId(candidateId)) {
      this.markLoss('preparation');
      return;
    }
    if (this.exhausted) {
      this.suppressed++;
      return;
    }
    this.guard(() => {
      const from = positive(fromId);
      const to = positive(toId);
      if (from === undefined || to === undefined) {
        this.markLoss('preparation');
        return;
      }
      this.event(
        this.candidateSpan(candidateId),
        EXTRACTION_EVENT_DIRECTION,
        candidateId,
        'flipped',
        'sentence-reverse',
        { entity_ids: [from, to], count: 1 },
      );
    });
  }

  claim(
    candidateId: string,
    kind: string,
    decision: 'inserted' | 'merged' | 'hinted' | 'noted' | 'dropped',
    reason: ClaimReason,
    refs: ExtractionClaimRefs = {},
  ): void {
    if (!this.validCandidateId(candidateId) || !CLAIM_DECISIONS.has(decision)) {
      this.markLoss('preparation');
      return;
    }
    if (this.exhausted) {
      this.suppressed++;
      return;
    }
    this.guard(() => {
      if (!CLAIM_REASONS.has(reason)) {
        this.markLoss('preparation');
        return;
      }
      const safe = this.claimRefs(refs);
      if (!safe) {
        this.markLoss('preparation');
        return;
      }
      this.event(
        this.candidateSpan(candidateId),
        EXTRACTION_EVENT_CLAIM,
        candidateId,
        decision,
        reason,
        {
          kind_hash: sha(kind),
          count: 1,
          ...safe,
        },
      );
    });
  }

  disposition(
    candidateId: string,
    decision: ExtractionTerminalDecision,
    reason: DispositionReason,
    counts: RelationOutcomeCounts,
  ): void {
    if (!this.validCandidateId(candidateId) || !DISPOSITION_DECISIONS.has(decision)) {
      this.markLoss('preparation');
      return;
    }
    const registered = this.registered.get(candidateId);
    if (registered) registered.disposed = true;
    if (this.exhausted) {
      this.suppressed++;
      return;
    }
    this.guard(() => {
      if (!DISPOSITION_REASONS.has(reason)) {
        this.markLoss('preparation');
        return;
      }
      const inserted = nonNegative(counts?.inserted);
      const merged = nonNegative(counts?.merged);
      const hinted = nonNegative(counts?.hinted);
      const noted = nonNegative(counts?.noted);
      const dropped = nonNegative(counts?.dropped);
      if (
        inserted === undefined ||
        merged === undefined ||
        hinted === undefined ||
        noted === undefined ||
        dropped === undefined
      ) {
        this.markLoss('preparation');
        return;
      }
      const claimCount = inserted + merged + hinted + noted + dropped;
      this.event(
        this.candidateSpan(candidateId),
        EXTRACTION_EVENT_DISPOSITION,
        candidateId,
        decision,
        reason,
        {
          claim_count: claimCount,
          inserted_count: inserted,
          merged_count: merged,
          hinted_count: hinted,
          noted_count: noted,
          dropped_count: dropped,
          count: 1,
        },
      );
    });
  }

  /** Close out parsed candidates whose window aborted before applyRelations. */
  abortWindow(windowIndex: number): void {
    if (!this.validWindowIndex(windowIndex)) {
      this.markLoss('preparation');
      return;
    }
    const pending = [...this.registered.entries()]
      .filter(([, value]) => value.windowIndex === windowIndex && !value.disposed);
    if (!pending.length) return;
    for (const [candidateId] of pending) {
      const value = this.registered.get(candidateId);
      if (value) value.disposed = true;
      if (this.exhausted) {
        this.suppressed++;
        continue;
      }
      this.guard(() => {
        this.event(
          this.candidateSpan(candidateId),
          EXTRACTION_EVENT_DISPOSITION,
          candidateId,
          'error',
          'candidate-aborted',
          {
            claim_count: 0,
            inserted_count: 0,
            merged_count: 0,
            hinted_count: 0,
            noted_count: 0,
            dropped_count: 0,
            count: 1,
          },
        );
      });
    }
  }

  runFinalized(
    status: ExtractionRunStatus,
    counts: { completed: number; partial: number; failed: number; skipped: number },
  ): void {
    if (this.exhausted) {
      this.suppressed++;
      return;
    }
    if (!RUN_STATUSES.has(status)) {
      this.markLoss('preparation');
      return;
    }
    this.guard(() => {
      const completed = nonNegative(counts?.completed);
      const partial = nonNegative(counts?.partial);
      const failed = nonNegative(counts?.failed);
      const skipped = nonNegative(counts?.skipped);
      if (
        completed === undefined ||
        partial === undefined ||
        failed === undefined ||
        skipped === undefined
      ) {
        this.markLoss('preparation');
        return;
      }
      this.event(
        this.rootSpan,
        EXTRACTION_EVENT_RUN_FINALIZED,
        `run:${this.runId}`,
        status,
        'run-finalized',
        {
          completed_count: completed,
          partial_count: partial,
          failed_count: failed,
          skipped_count: skipped,
          count: completed + partial + failed,
        },
      );
    });
  }

  /** True while the ledger can accept another diagnostic event. */
  canRecord(): boolean {
    return !this.exhausted;
  }

  /** Mark the trace non-exhaustive without changing extraction. Public and bounded. */
  markIncomplete(reason: ExtractionIncompleteReason): void {
    if (!INCOMPLETE_REASONS.has(reason)) {
      this.loss = true;
      return;
    }
    this.loss = true;
  }

  finish(interrupted = false): void {
    if (this.finished) return;
    this.finished = true;
    if (this.suppressed > 0) {
      try {
        traceLog.markDroppedTraceEvents(this.db, this.traceId, this.suppressed);
      } catch {
        this.loss = true;
      }
    }
    try {
      traceLog.finishTrace(
        this.db,
        this.traceId,
        interrupted ? { interrupted: true } : this.loss ? { completeness: 'truncated' } : {},
      );
    } catch {
      // Diagnostics never change the extraction result.
    }
  }

  private claimRefs(refs: ExtractionClaimRefs): TraceRefs | null {
    const out: TraceRefs = { lineage: 'at-decision' };
    const relationId = refs.relation_id === undefined ? undefined : positive(refs.relation_id);
    const hintId = refs.hint_id === undefined ? undefined : positive(refs.hint_id);
    const noteId = refs.note_id === undefined ? undefined : positive(refs.note_id);
    const eventId = refs.event_id === undefined ? undefined : positive(refs.event_id);
    if (
      (refs.relation_id !== undefined && relationId === undefined) ||
      (refs.hint_id !== undefined && hintId === undefined) ||
      (refs.note_id !== undefined && noteId === undefined) ||
      (refs.event_id !== undefined && eventId === undefined)
    ) {
      return null;
    }
    if (refs.status !== undefined && refs.status !== 'primary' && refs.status !== 'supporting') {
      return null;
    }
    if (relationId !== undefined) out.relation_id = relationId;
    if (hintId !== undefined) out.hint_id = hintId;
    if (noteId !== undefined) out.note_id = noteId;
    if (eventId !== undefined) out.event_id = eventId;
    if (refs.status !== undefined) out.status = refs.status;
    return out;
  }

  private markLoss(reason: ExtractionIncompleteReason): void {
    this.markIncomplete(reason);
  }

  private guard(action: () => void): void {
    if (this.exhausted) {
      this.suppressed++;
      return;
    }
    try {
      action();
    } catch {
      this.loss = true;
      this.suppressed++;
    }
  }

  private validWindowIndex(windowIndex: number): boolean {
    return Number.isInteger(windowIndex) && windowIndex >= 0;
  }

  private validCandidateId(candidateId: string): boolean {
    return typeof candidateId === 'string' && /^candidate:w\d+:relations:\d+$/.test(candidateId);
  }

  private windowSpan(windowIndex: number): string {
    return `sp-extract-window-${windowIndex}`;
  }

  private candidateSpan(candidateId: string): string {
    // candidate:w<index>:relations:<ordinal>
    const match = /^candidate:w(\d+):/.exec(candidateId);
    return this.windowSpan(match ? Number(match[1]) : 0);
  }

  private event(
    spanId: string,
    event: string,
    subject: string,
    decision: string,
    reasonCode: string,
    refs: TraceRefs,
  ): void {
    if (this.exhausted) {
      this.suppressed++;
      return;
    }
    try {
      const result = traceLog.recordTraceEvent(this.db, {
        traceId: this.traceId,
        projectId: this.projectId,
        spanId,
        parentSpanId: spanId === this.rootSpan ? null : this.rootSpan,
        stage: EXTRACTION_TRACE_STAGE,
        event,
        eventClass: 'diagnostic',
        subject,
        decision,
        reasonCode,
        refs: { run_id: this.runId, stage: 'extraction', ...refs },
        committed: false,
      });
      if (!result.recorded) {
        this.loss = true;
        if (result.reason === 'cap' || result.reason === 'unavailable') {
          this.exhausted = true;
        }
      }
    } catch {
      this.loss = true;
      this.exhausted = true;
    }
  }
}
