/**
 * Diagnostic trace for one `controller.writeChapter` invocation.
 *
 * The write trace is independent from the Phase 2b-1 context trace. It records
 * actual ChatRequest provenance, request consumption, model-call outcomes and
 * final chapter storage without retaining prompt or response prose.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../core/db.ts';
import type { ChatRequest, ChatResponse, LlmClient } from '../core/llm.ts';
import * as traceLog from '../trace/trace.ts';
import type { TraceRefs } from '../trace/trace.ts';

/** A six-part write with four context follow-ups needs about 260 events. */
export const WRITE_TRACE_MAX_EVENTS = 512;

export interface TraceContextRequest {
  kind: string;
  query: string;
  character?: string;
}

export interface RequestTraceContext {
  requestId: string;
  seq: number;
  part: number;
  round: number;
  spanId: string;
}

export interface WriteTraceStartInfo {
  chapterNumber: number;
  mode: 'write' | 'regenerate';
  existing: boolean;
  targetWords: number;
}

export interface WriteModelInfo {
  role: 'writer' | 'context-expand' | 'context-mining' | 'continuation';
  part?: number;
  round?: number;
  attempt?: number;
  parentSpanId: string;
  llm: LlmClient;
}

export interface WriteRequestLog {
  status: 'resolved' | 'empty' | 'denied';
  resultCount: number;
  rowId?: number;
}

const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function requestHash(req: TraceContextRequest): string {
  return sha(`${req.kind}\u0000${req.query.toLowerCase().trim()}\u0000${req.character ?? ''}`);
}

function messageHash(role: string, content: string): string {
  return sha(`${role}\u0000${content}`);
}

/** The actual request, not a reconstructed summary, hashed without storing it. */
function requestHashOf(request: ChatRequest): string {
  return sha(JSON.stringify({
    system: request.system ?? '',
    messages: request.messages,
    temperature: request.temperature ?? null,
    maxTokens: request.maxTokens ?? null,
    stop: request.stop ?? null,
    format: request.format ?? null,
  }));
}

function promptSections(prompt: string): { name: string; text: string }[] {
  const headers = [...prompt.matchAll(/^## (.+)$/gm)];
  const sections: { name: string; text: string }[] = [];
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i]!.index ?? 0;
    const end = i + 1 < headers.length ? (headers[i + 1]!.index ?? prompt.length) : prompt.length;
    sections.push({ name: headers[i]![1]!.trim(), text: prompt.slice(start, end).trim() });
  }
  return sections;
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    const status = (error as { status?: unknown }).status;
    return status !== undefined ? `${error.name}:${String(status)}` : error.name;
  }
  return 'unknown-error';
}

/**
 * A diagnostic sink. Every method is best-effort: trace writes never throw into
 * the writer. Required events are marked with refs.stage='required' so their
 * absence makes the audit non-exhaustive without making the writer depend on it.
 */
export class WriteTrace {
  readonly traceId: string;
  private readonly db: Db;
  private readonly projectId: number;
  private readonly rootSpan: string;
  private readonly spans = new Map<string, { spanId: string; parentSpanId: string | null }>();
  private readonly callSpans = new Map<string, string>();
  private readonly callResponses = new Map<string, { hash: string; chars: number }>();
  private readonly pendingAnswers = new Map<string, {
    requestId: string;
    seq: number;
    spanId: string;
    answerHash: string;
    answerChars: number;
  }>();
  private callSeq = 0;
  private unansweredCount = 0;
  private finished = false;
  private failedFlag = false;

  constructor(db: Db, projectId: number, traceId: string, info: WriteTraceStartInfo) {
    this.db = db;
    this.projectId = projectId;
    this.traceId = traceId;
    this.rootSpan = 'sp-write';
    this.span('sp-write', null);
    this.span('sp-write-context', 'sp-write');
    this.event('sp-write', 'write.started', 'write:chapter', 'started', info.mode, 'required', {
      stage: 'required',
      chapter_number: info.chapterNumber,
      body_words: info.targetWords,
    });
    if (info.existing) this.event('sp-write', 'write.regenerate', 'write:chapter', 'started', 'existing', 'best-effort', {
      stage: 'best-effort',
      chapter_number: info.chapterNumber,
    });
  }

  span(spanId: string, parentSpanId: string | null): string {
    if (!this.spans.has(spanId)) {
      this.spans.set(spanId, { spanId, parentSpanId });
    }
    return spanId;
  }

  regeneratePrior(info: { chapterId: number; chapterNumber: number; status: string; body: string }): void {
    this.event('sp-write', 'write.regenerate.prior', 'chapter:prior', 'superseded', 'regenerate', 'best-effort', {
      stage: 'best-effort',
      chapter_id: info.chapterId,
      chapter_number: info.chapterNumber,
      status: info.status,
      body_hash: sha(info.body),
      body_chars: info.body.length,
      body_words: info.body.split(/\s+/).filter(Boolean).length,
    });
  }

  contextLinked(contextTraceId: string): void {
    this.event('sp-write-context', 'write.context.linked', `context:${contextTraceId}`, 'linked', 'assembled', 'required', {
      stage: 'required',
      context_trace_id: contextTraceId,
    });
  }

  contextSupplied(): void {
    this.event('sp-write-context', 'write.context.supplied', 'context:bundle', 'supplied', 'supplied-bundle', 'required', {
      stage: 'required',
    });
  }

  contextAssemblyMissing(): void {
    this.event('sp-write-context', 'write.context.missing', 'context:bundle', 'missing', 'assembled-without-trace', 'required', {
      stage: 'required',
    });
  }

  partStarted(index: number, total: number, target: number, partTarget: number): string {
    const spanId = `sp-write-part-${index}`;
    this.span(spanId, 'sp-write');
    this.event(spanId, 'write.part.started', `part:${index}`, 'started', 'part', 'required', {
      stage: 'required',
      part: index,
      count: target,
      body_words: partTarget,
    });
    return spanId;
  }

  partSkipped(index: number, total: number, reason: string): void {
    const spanId = `sp-write-part-${index}`;
    this.span(spanId, 'sp-write');
    this.event(spanId, 'write.part.skipped', `part:${index}`, 'skipped', reason, 'required', {
      stage: 'required',
      part: index,
      count: total,
    });
  }

  partCompleted(index: number, words: number, calls: number): void {
    this.event(`sp-write-part-${index}`, 'write.part.completed', `part:${index}`, 'completed', 'complete', 'required', {
      stage: 'required',
      part: index,
      body_words: words,
      call_count: calls,
    });
  }

  roundStarted(part: number, round: number): string {
    const spanId = `sp-write-round-${part}-${round}`;
    this.span(spanId, `sp-write-part-${part}`);
    this.event(spanId, 'write.round.started', `round:${part}:${round}`, 'started', 'round', 'required', {
      stage: 'required',
      part,
      round,
    });
    return spanId;
  }

  roundCompleted(part: number, round: number): void {
    this.event(`sp-write-round-${part}-${round}`, 'write.round.completed', `round:${part}:${round}`, 'completed', 'complete', 'required', {
      stage: 'required',
      part,
      round,
    });
  }

  promptBuilt(
    spanId: string,
    prompt: string,
    info: { part: number; total: number; round: number; messageCount: number; previousChars: number; beatCount: number },
  ): void {
    const hash = sha(prompt);
    this.event(spanId, 'write.prompt.built', 'prompt:writer', 'built', 'writer', 'required', {
      stage: 'required',
      part: info.part,
      round: info.round,
      raw_count: info.total,
      prompt_chars: prompt.length,
      message_count: info.messageCount,
      previous_chars: info.previousChars,
      beat_count: info.beatCount,
    }, { promptHash: hash });
    const sections = promptSections(prompt);
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]!;
      const known = new Set([
        'TASK',
        'STORY PREMISE',
        'AU DIVERGENCE POINT',
        'APPROVED CHAPTER OUTLINE',
        'SCENE TO WRITE',
        'WRITING PREFERENCES',
        'STORY MEMORY (existing story state)',
        'CONNECTED CONTEXT (who and what this scene touches, and how it all connects)',
        'CANON EVIDENCE (reference material from the source — facts and beats only)',
        'END OF THE PREVIOUS CHAPTER (for continuity)',
        'AUTHOR INSTRUCTIONS FOR THIS SCENE',
        'NOTE',
        'OUTPUT',
      ]);
      const label = known.has(section.name) ? section.name : `extra-${i + 1}`;
      this.event(spanId, 'write.prompt.section', `section:${label}`, 'included', 'section', 'required', {
        stage: 'required',
        rank: i + 1,
        section_chars: section.text.length,
        section_words: section.text.split(/\s+/).filter(Boolean).length,
        content_hash: sha(section.text),
      });
    }
  }

  promptMessage(
    spanId: string,
    index: number,
    role: string,
    source: string,
    content: string,
    info: { part: number; round: number },
  ): void {
    this.event(spanId, 'write.prompt.message', `message:${index}`, 'included', source, 'required', {
      stage: 'required',
      part: info.part,
      round: info.round,
      message_index: index,
      message_role: role,
      section_chars: content.length,
      content_hash: messageHash(role, content),
    });
  }

  requestSpan(part: number, round: number, seq: number): string {
    const spanId = `sp-write-request-${seq}`;
    this.span(spanId, `sp-write-round-${part}-${round}`);
    return spanId;
  }

  requestKey(req: TraceContextRequest): string {
    return requestHash(req);
  }

  requestParsed(ctx: RequestTraceContext, req: TraceContextRequest): void {
    this.event(ctx.spanId, 'write.request.parsed', `request:${ctx.requestId}`, 'parsed', req.kind, 'best-effort', {
      stage: 'best-effort',
      part: ctx.part,
      round: ctx.round,
      seq: ctx.seq,
      count: req.query.length,
      request_kind: req.kind,
      candidate_id: ctx.requestId,
    });
  }

  requestOutcome(
    ctx: RequestTraceContext,
    req: TraceContextRequest,
    status: WriteRequestLog['status'],
    answer: { label: string; kind: string; content: string } | null,
    log: WriteRequestLog,
  ): void {
    this.event(ctx.spanId, `write.request.${status}`, `request:${ctx.requestId}`, status, status, 'best-effort', {
      stage: 'best-effort',
      part: ctx.part,
      round: ctx.round,
      seq: ctx.seq,
      count: log.resultCount,
      request_row_id: log.rowId,
      request_kind: req.kind,
      candidate_id: ctx.requestId,
      ...(answer ? {
        content_hash: sha(answer.content),
        answer_chars: answer.content.length,
      } : {}),
    });
  }

  requestDisposition(ctx: RequestTraceContext, req: TraceContextRequest, status: string, reason: string): void {
    if (status === 'unanswered') this.unansweredCount++;
    this.event(ctx.spanId, `write.request.${status}`, `request:${ctx.requestId}`, status, reason, 'best-effort', {
      stage: 'best-effort',
      part: ctx.part,
      round: ctx.round,
      seq: ctx.seq,
      candidate_id: ctx.requestId,
      request_kind: req.kind,
    });
  }

  answerQueued(ctx: RequestTraceContext, answer: { content: string }): void {
    const key = `${ctx.requestId}:${ctx.seq}`;
    this.pendingAnswers.set(key, {
      requestId: ctx.requestId,
      seq: ctx.seq,
      spanId: ctx.spanId,
      answerHash: sha(answer.content),
      answerChars: answer.content.length,
    });
  }

  modelStarted(request: ChatRequest, info: WriteModelInfo): string {
    this.callSeq++;
    const callId = `call:${this.callSeq}`;
    const spanId = `sp-write-call-${this.callSeq}`;
    this.callSpans.set(callId, spanId);
    this.span(spanId, info.parentSpanId);
    const promptHash = requestHashOf(request);
    const systemHash = sha(request.system ?? '');
    this.event(spanId, 'write.model.started', callId, 'started', info.role, 'required', {
      stage: 'required',
      part: info.part,
      round: info.round,
      attempt: info.attempt,
      model_provider: info.llm.settings.provider,
      system_hash: systemHash,
      system_chars: (request.system ?? '').length,
      prompt_chars: (request.system ?? '').length +
        request.messages.reduce((sum, message) => sum + message.content.length, 0),
      message_count: request.messages.length,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      request_kind: info.role,
    }, {
      model: info.llm.settings.model,
      promptHash,
    });
    this.event(spanId, 'write.model.system', callId, 'included', 'system', 'required', {
      stage: 'required',
      system_hash: systemHash,
      system_chars: (request.system ?? '').length,
    });
    for (let i = 0; i < request.messages.length; i++) {
      const message = request.messages[i]!;
      this.event(spanId, 'write.model.message', `message:${i}`, 'included', 'messages', 'required', {
        stage: 'required',
        message_index: i,
        message_role: message.role,
        section_chars: message.content.length,
        content_hash: messageHash(message.role, message.content),
      });
    }
    if (info.role === 'writer' || info.role === 'continuation') {
      this.consumePendingAnswers(spanId);
    }
    return callId;
  }

  modelCompleted(callId: string, response: ChatResponse): void {
    const spanId = this.callSpans.get(callId);
    if (!spanId) return;
    const hash = sha(response.text);
    this.callResponses.set(callId, { hash, chars: response.text.length });
    this.event(spanId, 'write.model.completed', callId, 'completed', 'ok', 'required', {
      stage: 'required',
      response_chars: response.text.length,
      response_hash: hash,
      prompt_tokens: response.usage?.promptTokens,
      completion_tokens: response.usage?.completionTokens,
    }, {
      model: response.model,
      durationMs: response.durationMs,
    });
  }

  modelFailed(callId: string, error: unknown, required = true): void {
    const spanId = this.callSpans.get(callId);
    if (!spanId) return;
    if (required) this.failedFlag = true;
    this.event(spanId, 'write.model.failed', callId, 'failed', 'model-error', required ? 'required' : 'best-effort', {
      stage: required ? 'required' : 'best-effort',
    }, { error: safeError(error) });
  }

  outputDisposition(
    callId: string,
    decision: 'included' | 'superseded' | 'empty' | 'truncated' | 'ambiguous',
    reason: string,
    extra: TraceRefs = {},
  ): void {
    const spanId = this.callSpans.get(callId);
    if (!spanId) return;
    const response = this.callResponses.get(callId);
    this.event(spanId, 'write.output.disposition', callId, decision, reason, 'best-effort', {
      stage: 'best-effort',
      ...(response ? { response_hash: response.hash, response_chars: response.chars } : {}),
      ...extra,
    });
  }

  continuationStarted(attempt: number, reason: string, have: number, target: number): string {
    const spanId = `sp-write-continuation-${attempt}`;
    this.span(spanId, 'sp-write');
    this.event(spanId, 'write.continuation.started', `continuation:${attempt}`, 'started', reason, 'best-effort', {
      stage: 'best-effort',
      attempt,
      body_words: have,
      section_words: target,
    });
    return spanId;
  }

  continuationCompleted(attempt: number, text: string): void {
    this.event(`sp-write-continuation-${attempt}`, 'write.continuation.completed', `continuation:${attempt}`, 'completed', 'continuation-output', 'best-effort', {
      stage: 'best-effort',
      attempt,
      response_chars: text.length,
      response_hash: sha(text),
    });
  }

  continuationEmpty(attempt: number): void {
    this.event(`sp-write-continuation-${attempt}`, 'write.continuation.empty', `continuation:${attempt}`, 'empty', 'empty-output', 'best-effort', {
      stage: 'best-effort',
      attempt,
    });
  }

  outputFinal(prose: string): string {
    const hash = sha(prose);
    this.event('sp-write', 'write.output.final', 'write:output', 'completed', 'final', 'required', {
      stage: 'required',
      body_chars: prose.length,
      body_words: prose.split(/\s+/).filter(Boolean).length,
      body_hash: hash,
    });
    return hash;
  }

  outputDedupe(removed: number): void {
    this.event('sp-write', 'write.output.dedupe', 'write:output', 'completed', 'dedupe', 'best-effort', {
      stage: 'best-effort',
      dropped_paragraphs: removed,
    });
  }

  storeRequested(info: { chapterNumber: number; existing: boolean }): void {
    this.event('sp-write', 'write.store.requested', 'chapter:store', 'requested', info.existing ? 'existing' : 'new', 'required', {
      stage: 'required',
      chapter_number: info.chapterNumber,
    });
  }

  stored(info: {
    chapterId: number;
    chapterNumber: number;
    status: string;
    body: string;
    existing: boolean;
    revisionId?: number;
  }): void {
    const hash = sha(info.body);
    this.event('sp-write', 'write.stored', 'chapter:store', 'completed', 'stored', 'required', {
      stage: 'required',
      status: info.status,
      chapter_id: info.chapterId,
      chapter_number: info.chapterNumber,
      body_chars: info.body.length,
      body_words: info.body.split(/\s+/).filter(Boolean).length,
      body_hash: hash,
      revision_row_id: info.revisionId,
    });
  }

  storeFailed(reason: string): void {
    this.event('sp-write', 'write.store.failed', 'chapter:store', 'failed', reason, 'required', {
      stage: 'required',
    });
  }

  placeholderRemoved(): void {
    this.event('sp-write', 'write.placeholder.removed', 'chapter:store', 'removed', 'write-failed', 'required', {
      stage: 'required',
    });
  }

  completed(info: { calls: number; words: number; continuations: number; droppedParagraphs: number }): void {
    this.event('sp-write', 'write.completed', 'write:execution', 'completed', 'ok', 'required', {
      stage: 'required',
      call_count: info.calls,
      body_words: info.words,
      continuation_count: info.continuations,
      dropped_paragraphs: info.droppedParagraphs,
      unanswered_requests: this.unansweredCount,
    });
  }

  failed(reason: string, error?: unknown): void {
    this.failedFlag = true;
    this.event('sp-write', 'write.failed', 'write:execution', 'failed', reason, 'required', {
      stage: 'required',
    }, { error: error === undefined ? undefined : safeError(error) });
  }

  pendingNotIncluded(reason: string): void {
    for (const pending of this.pendingAnswers.values()) {
      this.event(pending.spanId, 'write.answer.not-included', `request:${pending.requestId}`, 'not-included', reason, 'best-effort', {
        stage: 'best-effort',
        seq: pending.seq,
        content_hash: pending.answerHash,
        answer_chars: pending.answerChars,
        candidate_id: pending.requestId,
      });
    }
    this.pendingAnswers.clear();
  }

  finish(interrupted = false): void {
    if (this.finished) return;
    this.finished = true;
    this.pendingNotIncluded('write-ended');
    try {
      traceLog.finishTrace(
        this.db,
        this.traceId,
        interrupted || this.failedFlag ? { interrupted: true } : {},
      );
    } catch {
      // Diagnostics never change the write result.
    }
  }

  getCallCount(): number {
    return this.callSeq;
  }

  /** Transparent observer for resolver-internal model calls. */
  wrapLlm(
    llm: LlmClient,
    role: 'context-expand' | 'context-mining',
    ctx: RequestTraceContext,
  ): LlmClient {
    return {
      settings: llm.settings,
      available: () => llm.available(),
      chat: async (request: ChatRequest): Promise<ChatResponse> => {
        const callId = this.modelStarted(request, {
          role,
          part: ctx.part,
          round: ctx.round,
          parentSpanId: ctx.spanId,
          llm,
        });
        try {
          const response = await llm.chat(request);
          this.modelCompleted(callId, response);
          return response;
        } catch (error) {
          this.modelFailed(callId, error, false);
          throw error;
        }
      },
    };
  }

  private consumePendingAnswers(spanId: string): void {
    for (const pending of this.pendingAnswers.values()) {
      this.event(spanId, 'write.answer.consumed', `request:${pending.requestId}`, 'consumed', 'next-request', 'best-effort', {
        stage: 'best-effort',
        seq: pending.seq,
        content_hash: pending.answerHash,
        response_chars: pending.answerChars,
        candidate_id: pending.requestId,
      });
    }
    this.pendingAnswers.clear();
  }

  private event(
    spanId: string,
    event: string,
    subject: string,
    decision: string,
    reasonCode: string,
    stage: string,
    refs: TraceRefs,
    extra: { model?: string; promptHash?: string; durationMs?: number; error?: string } = {},
  ): void {
    try {
      traceLog.recordTraceEvent(this.db, {
        traceId: this.traceId,
        projectId: this.projectId,
        spanId,
        parentSpanId: this.spans.get(spanId)?.parentSpanId ?? null,
        stage: 'write',
        event,
        eventClass: 'diagnostic',
        subject,
        decision,
        reasonCode,
        refs: { ...refs, stage: refs.stage ?? stage },
        model: extra.model,
        promptHash: extra.promptHash,
        durationMs: extra.durationMs,
        error: extra.error,
      });
    } catch {
      // Best-effort by definition.
    }
  }

}
