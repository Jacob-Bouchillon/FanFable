/**
 * Diagnostic trace for one `assembleContext` invocation.
 *
 * Retrieval keeps its own Phase 1/2a events. This records the second decision:
 * which retrieved or locally assembled items actually entered the context
 * bundle, and which were dropped, truncated or superseded.
 */
import type { Db } from '../core/db.ts';
import * as traceLog from '../trace/trace.ts';
import type { RetrievalTraceEvent, RetrievalTraceSink, TraceRefs } from '../trace/trace.ts';

export type ContextChildClass = 'required' | 'best-effort' | 'superseded';
export type ContextChildStatus =
  | 'complete'
  | 'empty'
  | 'failed'
  | 'skipped'
  | 'sampled'
  | 'truncated'
  | 'interrupted'
  | 'superseded';
export type ContextItemDecision =
  | 'included'
  | 'excluded'
  | 'budgeted'
  | 'truncated'
  | 'failed'
  | 'superseded';

interface ContextItemState {
  origins: number;
  terminal?: {
    decision: ContextItemDecision;
    reasonCode: string;
    refs: TraceRefs;
  };
}

interface ChildState {
  className: ContextChildClass;
  spanId: string;
  parentSpanId: string;
  status?: ContextChildStatus;
  selected: number;
}

interface ContextCounts {
  selected: number;
  budgeted: number;
  excluded: number;
  truncated: number;
}

/** Buffer and correlate the context-assembly side of one trace. */
export class ContextAssemblyTrace {
  readonly root: RetrievalTraceSink;
  readonly traceId: string;
  private readonly db: Db;
  private readonly projectId: number;
  private readonly buffer: traceLog.BufferedRetrievalTrace;
  private readonly items = new Map<string, ContextItemState>();
  private readonly sectionKeys = new Map<string, Set<string>>();
  private readonly sectionOrigins = new Map<string, number>();
  private readonly children = new Map<string, ChildState>();
  private interrupted = false;

  constructor(
    db: Db,
    projectId: number,
    traceId: string,
    buffer: traceLog.BufferedRetrievalTrace,
    opts: { focusCount: number; sceneCount: number },
  ) {
    this.db = db;
    this.projectId = projectId;
    this.traceId = traceId;
    this.buffer = buffer;
    // The span wrapper is intentionally created once. Inner wrappers below
    // retain their own span/parent pair.
    this.root = traceLog.withRetrievalTraceSpan(buffer, 'sp-context', null);
    this.emit(this.root, {
      event: 'context.requested',
      subject: 'context:bundle',
      decision: 'candidate',
      reasonCode: 'chapter',
      refs: {
        count: opts.focusCount,
        selected_count: opts.sceneCount,
        stage: 'chapter',
      },
    });
  }

  /** A child sink. The nesting-safe helper keeps this span's identity. */
  span(spanId: string, parentSpanId = 'sp-context'): RetrievalTraceSink {
    return traceLog.withRetrievalTraceSpan(this.root, spanId, parentSpanId);
  }

  /** Whether retrieval emitted any event under a child span. */
  hasSpan(spanId: string): boolean {
    return this.buffer.events.some((event) => event.spanId === spanId);
  }

  /** Selected retrieval chunks under one span, in first-seen order. */
  retrievalSelectedChunks(spanId: string): number[] {
    const ids = new Set<number>();
    for (const event of this.buffer.events) {
      if (
        event.spanId !== spanId ||
        event.event !== 'retrieval.candidate.disposition' ||
        event.decision !== 'selected' ||
        !event.subject?.startsWith('chunk:')
      ) {
        continue;
      }
      const chunkId = Number(event.refs?.chunk_id ?? event.subject.slice('chunk:'.length));
      if (Number.isInteger(chunkId) && chunkId > 0) ids.add(chunkId);
    }
    return [...ids];
  }

  childStarted(
    name: string,
    className: ContextChildClass,
    spanId = `sp-context-${name}`,
    parentSpanId = 'sp-context',
  ): void {
    if (this.children.has(name)) return;
    const child: ChildState = { className, spanId, parentSpanId, selected: 0 };
    this.children.set(name, child);
    this.emit(this.span(spanId, parentSpanId), {
      event: 'context.child.started',
      subject: `child:${name}`,
      decision: 'started',
      reasonCode: className,
      refs: { stage: className, count: 0 },
    });
  }

  childCompleted(
    name: string,
    status: ContextChildStatus,
    selected = 0,
  ): void {
    const child = this.children.get(name);
    if (!child || child.status) return;
    child.status = status;
    child.selected = Math.max(0, selected);
    this.emit(this.span(child.spanId, child.parentSpanId), {
      event: 'context.child.completed',
      subject: `child:${name}`,
      decision: 'completed',
      reasonCode: status,
      refs: {
        stage: child.className,
        count: child.selected,
        selected_count: child.selected,
      },
    });
  }

  markInterrupted(): void {
    this.interrupted = true;
  }

  /** Record a multi-origin contribution to one context item. */
  itemGenerated(
    sink: RetrievalTraceSink | undefined,
    section: string,
    key: string,
    reasonCode: string,
    refs: TraceRefs = {},
  ): void {
    if (!sink) return;
    const sectionSet = this.sectionKeys.get(section) ?? new Set<string>();
    sectionSet.add(key);
    this.sectionKeys.set(section, sectionSet);
    this.sectionOrigins.set(section, (this.sectionOrigins.get(section) ?? 0) + 1);
    const item = this.items.get(key) ?? { origins: 0 };
    item.origins++;
    this.items.set(key, item);
    this.emit(sink, {
      event: 'context.item.generated',
      subject: key,
      decision: 'candidate',
      reasonCode,
      refs: { ...refs, candidate_id: key, stage: section },
    });
  }

  /** One terminal outcome per unique context item. */
  itemDisposition(
    sink: RetrievalTraceSink | undefined,
    key: string,
    decision: ContextItemDecision,
    reasonCode: string,
    refs: TraceRefs = {},
  ): void {
    if (!sink) return;
    const item = this.items.get(key);
    if (!item || item.terminal) return;
    item.terminal = { decision, reasonCode, refs };
    this.emit(sink, {
      event: 'context.item.disposition',
      subject: key,
      decision,
      reasonCode,
      refs: { ...refs, candidate_id: key, stage: 'context-final' },
    });
  }

  selectedCount(): number {
    let selected = 0;
    for (const item of this.items.values()) {
      if (item.terminal?.decision === 'included' || item.terminal?.decision === 'truncated') {
        selected++;
      }
    }
    return selected;
  }

  /** Finish child bookkeeping, emit summaries and flush the trace. */
  finish(completed: boolean): void {
    try {
      if (!completed) this.interrupted = true;
      if (this.interrupted) {
        for (const [name, child] of this.children) {
          if (!child.status) this.childCompleted(name, 'interrupted');
        }
      }

      const finalCount = this.selectedCount();
      if (!this.children.has('final')) {
        this.childStarted('final', 'required', 'sp-context-final');
        this.childCompleted(
          'final',
          this.items.size && finalCount ? 'complete' : 'empty',
          finalCount,
        );
      }

      // Section summaries are exact even when retrieval detail is sampled.
      const sections = [
        'memory',
        'canon-preload',
        'retrieve-package',
        'connected',
        'canon-brief',
        'lore-brief',
        'verdicts',
        'previous',
        ...this.sectionKeys.keys(),
      ];
      for (const section of new Set(sections)) {
        this.summary(section, this.root);
      }
      this.summary('final', this.span('sp-context-final'));
      this.coverage();
      this.emit(this.root, {
        event: 'context.completed',
        subject: 'context:bundle',
        decision: 'completed',
        reasonCode: this.interrupted ? 'interrupted' : finalCount ? 'ok' : 'empty',
        refs: { count: finalCount, stage: 'context' },
      });

      const flushed = traceLog.flushRetrievalTrace(this.db, this.projectId, this.traceId, this.buffer);
      traceLog.finishTrace(
        this.db,
        this.traceId,
        this.interrupted
          ? { interrupted: true }
          : flushed.sampled
            ? { completeness: 'sampled' }
            : {},
      );
    } catch {
      // Diagnostics must never change the context result.
    }
  }

  private summary(section: string, sink: RetrievalTraceSink): void {
    const keys = section === 'final'
      ? [...this.items.keys()]
      : [...(this.sectionKeys.get(section) ?? [])];
    const raw = section === 'final'
      ? [...this.items.values()].reduce((sum, item) => sum + item.origins, 0)
      : (this.sectionOrigins.get(section) ?? 0);
    const counts = this.counts(keys);
    this.emit(sink, {
      event: 'context.summary',
      subject: section === 'final' ? 'context:final' : `context:${section}`,
      decision: 'completed',
      reasonCode: counts.selected ? 'ok' : keys.length ? 'partial' : 'empty',
      refs: {
        raw_count: raw,
        dedup_count: keys.length,
        ranked_count: keys.length,
        selected_count: counts.selected,
        budgeted_count: counts.budgeted,
        excluded_count: counts.excluded,
        truncated_count: counts.truncated,
        stage: 'context-assembly',
      },
    });
  }

  private coverage(): void {
    const all = [...this.children.values()];
    const required = all.filter((child) => child.className === 'required');
    const optional = all.filter((child) => child.className === 'best-effort');
    const contributing = all.filter((child) => child.selected > 0);
    const incomplete = (child: ChildState): boolean =>
      !child.status || !['complete', 'empty', 'superseded'].includes(child.status);
    const requiredIncomplete = required.filter(incomplete).length;
    const contributingIncomplete = contributing.filter(incomplete).length;
    const optionalIncomplete = optional
      .filter((child) => child.selected === 0 && incomplete(child))
      .length;
    const partial = requiredIncomplete + contributingIncomplete > 0;
    this.emit(this.root, {
      event: 'context.coverage',
      subject: 'context:coverage',
      decision: 'completed',
      reasonCode: partial ? 'partial' : 'complete',
      refs: {
        required_count: required.length,
        contributing_count: contributing.length,
        optional_count: optional.length,
        incomplete_count: requiredIncomplete + contributingIncomplete,
        required_incomplete_count: requiredIncomplete,
        contributing_incomplete_count: contributingIncomplete,
        optional_incomplete_count: optionalIncomplete,
        count: this.selectedCount(),
        stage: 'coverage',
      },
    });
  }

  private counts(keys: string[]): ContextCounts {
    const counts: ContextCounts = { selected: 0, budgeted: 0, excluded: 0, truncated: 0 };
    for (const key of keys) {
      const terminal = this.items.get(key)?.terminal;
      if (!terminal) continue;
      switch (terminal.decision) {
        case 'included':
          counts.selected++;
          break;
        case 'truncated':
          counts.selected++;
          counts.truncated++;
          break;
        case 'budgeted':
          counts.budgeted++;
          break;
        case 'excluded':
        case 'failed':
        case 'superseded':
          counts.excluded++;
          break;
      }
    }
    return counts;
  }

  private emit(sink: RetrievalTraceSink, event: Omit<RetrievalTraceEvent, 'stage'>): void {
    try {
      sink.emit({ stage: 'context', ...event });
    } catch {
      // A diagnostic sink cannot break assembly.
    }
  }
}
