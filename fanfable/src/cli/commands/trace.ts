/**
 * The trace ledger: list, show and audit what was recorded.
 *
 * Moved out of cli.ts on 2026-11-13, logic unchanged. `db` is a parameter
 * rather than a module-level singleton so the command is a plain function.
 */
import { Db } from '../../core/db.ts';
import * as traceLog from '../../trace/trace.ts';
import { openTraceReadConnection } from '../../trace/trace-readonly.ts';
import { buildTrailsHtml, trailText } from '../../product/trail-html.ts';
import { C, heading, requireProject, flagString, flagNumber, type Args } from '../shared.ts';

export async function cmdTrace(db: Db, args: Args, dbPath: string): Promise<void> {
  const sub = args._[1];
  const traceId = args._[2];
  if (!sub || !traceId || (sub !== 'show' && sub !== 'audit')) {
    throw new Error('usage: fanfable trace show|audit <trace-id> [--json]');
  }
  const asJson = args.flags.json === true;
  const reader = openTraceReadConnection(dbPath);

  try {
    if (sub === 'show') {
      const view = traceLog.showTrace(reader, traceId);
      if (!view) throw new Error(`no trace "${traceId}"`);
      if (asJson) {
        console.log(JSON.stringify(view, null, 2));
        return;
      }
      console.log(`\n${C.bold('Trace')} ${view.trace.id}`);
      console.log(
        `completeness: ${view.trace.completeness}` +
          `   dropped_events: ${view.trace.droppedEvents}` +
          `   sampled_rate: ${view.trace.sampledRate}`,
      );
      console.log(`started: ${view.trace.startedAt}   finished: ${view.trace.finishedAt ?? '(unfinished)'}`);
      console.log(`project: ${view.trace.projectId}   events: ${view.events.length}`);
      if (Object.keys(view.trace.metadata).length) {
        console.log(`metadata: ${JSON.stringify(view.trace.metadata)}`);
      }
      const retrievalEvents = view.events.filter((event) => event.stage === 'retrieval');
      if (retrievalEvents.length) {
        const completed = retrievalEvents.find((event) => event.event === 'retrieval.completed');
        const searches = retrievalEvents.filter((event) => event.event === 'retrieval.search.completed');
        const summaries = retrievalEvents.filter((event) => event.event === 'retrieval.summary');
        const selected = retrievalEvents.filter(
          (event) => event.event === 'retrieval.candidate.disposition' && event.decision === 'selected',
        );
        const selectedChunks = selected.filter((event) => event.subject.startsWith('chunk:')).length;
        const selectedIndex = selected.length - selectedChunks;
        console.log(`\n${C.bold('Retrieval handoff')}`);
        if (completed) {
          console.log(
            `  outcome=${completed.reasonCode || '-'} selected=${completed.refs.count ?? selectedChunks}` +
              (selectedIndex ? ` index=${selectedIndex}` : ''),
          );
        }
        for (const event of searches) {
          console.log(
            `  ${event.subject}: ${event.reasonCode || '-'}` +
              (event.refs.count !== undefined ? ` count=${event.refs.count}` : ''),
          );
        }
        for (const event of summaries) {
          console.log(
            `  ${event.subject}: raw=${event.refs.raw_count ?? '-'}` +
              ` dedup=${event.refs.dedup_count ?? '-'}` +
              ` ranked=${event.refs.ranked_count ?? '-'}` +
              ` selected=${event.refs.selected_count ?? '-'}` +
              ` budgeted=${event.refs.budgeted_count ?? '-'}` +
              ` excluded=${event.refs.excluded_count ?? '-'}`,
          );
        }
        if (selected.length) {
          console.log(`  selected evidence: ${selected.map((event) => event.subject).join(', ')}`);
        }
      }
      const contextEvents = view.events.filter((event) => event.stage === 'context');
      if (contextEvents.length) {
        const contextual = view.events.filter(
          (event) => event.stage === 'context' || event.spanId.startsWith('sp-context'),
        );
        const spans = new Map<string, { id: string; parent: string | null; children: string[]; events: typeof view.events }>();
        for (const event of contextual) {
          let span = spans.get(event.spanId);
          if (!span) {
            span = { id: event.spanId, parent: event.parentSpanId, children: [], events: [] };
            spans.set(event.spanId, span);
          }
          span.events.push(event);
          if (span.parent === null && event.parentSpanId) span.parent = event.parentSpanId;
        }
        for (const span of spans.values()) {
          if (span.parent && spans.has(span.parent) && !spans.get(span.parent)!.children.includes(span.id)) {
            spans.get(span.parent)!.children.push(span.id);
          }
        }
        const completionFor = (id: string) =>
          spans.get(id)?.events.find((event) => event.event === 'context.child.completed');
        const printed = new Set<string>();
        const printSpan = (id: string, depth: number): void => {
          if (printed.has(id)) return;
          printed.add(id);
          const span = spans.get(id);
          if (!span) return;
          const completion = completionFor(id);
          const label = completion
            ? completion.subject.replace(/^child:/, '')
            : id === 'sp-context'
              ? 'context'
              : id;
          const kind = completion?.refs.stage ? ` [${completion.refs.stage}]` : '';
          const status = completion?.reasonCode ? ` ${completion.reasonCode}` : '';
          const selected = completion?.refs.selected_count ?? completion?.refs.count;
          console.log(
            `  ${'  '.repeat(depth)}${label}${kind}${status}` +
              (selected !== undefined ? ` selected=${selected}` : ''),
          );
          for (const child of span.children) printSpan(child, depth + 1);
        };
        console.log(`\n${C.bold('Context assembly tree')}`);
        if (spans.has('sp-context')) printSpan('sp-context', 0);
        else {
          for (const span of spans.values()) {
            if (!span.parent || !spans.has(span.parent)) printSpan(span.id, 0);
          }
        }

        const finalSummary = contextEvents.find(
          (event) => event.event === 'context.summary' && event.subject === 'context:final',
        );
        const dispositions = contextEvents.filter((event) => event.event === 'context.item.disposition');
        const included = dispositions.filter(
          (event) => event.decision === 'included' || event.decision === 'truncated',
        );
        const excluded = dispositions.filter(
          (event) => event.decision === 'budgeted' || event.decision === 'excluded' || event.decision === 'failed',
        );
        const coverage = contextEvents.find((event) => event.event === 'context.coverage');
        const locatorFor = (event: (typeof contextEvents)[number]): string => {
          const chunkId = Number(event.refs.chunk_id ?? 0);
          if (!Number.isInteger(chunkId) || chunkId <= 0) return '';
          const row = reader.get<{ locator: string }>(
            'SELECT locator FROM canon_chunk WHERE id = ? AND project_id = ?',
            chunkId,
            view.trace.projectId,
          );
          return row?.locator ? ` <${row.locator}>` : '';
        };
        console.log(`\n${C.bold('Context handoff')}`);
        if (finalSummary) {
          console.log(
            `  raw=${finalSummary.refs.raw_count ?? '-'}` +
              ` dedup=${finalSummary.refs.dedup_count ?? '-'}` +
              ` selected=${finalSummary.refs.selected_count ?? '-'}` +
              ` budgeted=${finalSummary.refs.budgeted_count ?? '-'}` +
              ` excluded=${finalSummary.refs.excluded_count ?? '-'}` +
              ` truncated=${finalSummary.refs.truncated_count ?? '-'}`,
          );
        }
        if (included.length) {
          console.log(
            `  final context: ${included
              .map((event) => `${event.subject}${locatorFor(event)}`)
              .join(', ')}`,
          );
        }
        if (excluded.length) {
          console.log(
            `  excluded: ${excluded
              .map((event) => `${event.subject} (${event.reasonCode || event.decision})`)
              .join(', ')}`,
          );
        }
        if (coverage) {
          console.log(
            `  coverage: ${coverage.reasonCode}` +
              ` required=${coverage.refs.required_count ?? '-'}` +
              ` contributing=${coverage.refs.contributing_count ?? '-'}` +
              ` optional=${coverage.refs.optional_count ?? '-'}` +
              ` incomplete=${coverage.refs.incomplete_count ?? '-'}`,
          );
        }
      }
      const writeEvents = view.events.filter((event) => event.stage === 'write');
      if (writeEvents.length) {
        const contextual = view.events.filter(
          (event) => event.stage === 'write' || event.spanId.startsWith('sp-write'),
        );
        const spans = new Map<string, { id: string; parent: string | null; children: string[]; events: typeof view.events }>();
        for (const event of contextual) {
          let span = spans.get(event.spanId);
          if (!span) {
            span = { id: event.spanId, parent: event.parentSpanId, children: [], events: [] };
            spans.set(event.spanId, span);
          }
          span.events.push(event);
          if (span.parent === null && event.parentSpanId) span.parent = event.parentSpanId;
        }
        for (const span of spans.values()) {
          if (span.parent && spans.has(span.parent) && !spans.get(span.parent)!.children.includes(span.id)) {
            spans.get(span.parent)!.children.push(span.id);
          }
        }
        const terminalFor = (id: string) =>
          spans.get(id)?.events.find((event) =>
            event.event === 'write.model.completed' ||
            event.event === 'write.model.failed' ||
            event.event === 'write.part.completed' ||
            event.event === 'write.part.skipped' ||
            event.event === 'write.completed' ||
            event.event === 'write.failed' ||
            event.event === 'write.stored' ||
            (event.event.startsWith('write.request.') && event.event !== 'write.request.parsed'),
          );
        const printed = new Set<string>();
        const printSpan = (id: string, depth: number): void => {
          if (printed.has(id)) return;
          printed.add(id);
          const span = spans.get(id);
          if (!span) return;
          const started = span.events.find((event) => event.event === 'write.model.started');
          const terminal = terminalFor(id);
          const label = id === 'sp-write'
            ? 'write'
            : started
              ? `${started.reasonCode || 'model'} ${started.subject}`
              : id.replace(/^sp-write-/, '');
          const status = terminal ? `${terminal.event.replace(/^write\./, '')} ${terminal.reasonCode || ''}`.trim() : '';
          console.log(`  ${'  '.repeat(depth)}${label}${status ? ` — ${status}` : ''}`);
          for (const child of span.children) printSpan(child, depth + 1);
        };
        console.log(`\n${C.bold('Write execution tree')}`);
        if (spans.has('sp-write')) printSpan('sp-write', 0);
        else {
          for (const span of spans.values()) {
            if (!span.parent || !spans.has(span.parent)) printSpan(span.id, 0);
          }
        }

        const sections = writeEvents
          .filter((event) => event.event === 'write.prompt.section')
          .sort((a, b) => Number(a.refs.rank ?? 0) - Number(b.refs.rank ?? 0));
        if (sections.length) {
          console.log(`\n${C.bold('Prompt sections')}`);
          for (const event of sections) {
            console.log(
              `  ${event.subject.replace(/^section:/, '')}: chars=${event.refs.section_chars ?? '-'}` +
                ` words=${event.refs.section_words ?? '-'} hash=${String(event.refs.content_hash ?? '').slice(0, 12)}`,
            );
          }
        }

        const calls = writeEvents.filter((event) => event.event === 'write.model.started');
        if (calls.length) {
          console.log(`\n${C.bold('Model calls')}`);
          for (const call of calls) {
            const completed = writeEvents.find(
              (event) =>
                (event.event === 'write.model.completed' || event.event === 'write.model.failed') &&
                event.subject === call.subject,
            );
            console.log(
              `  ${call.subject} ${call.reasonCode} model=${call.model || '-'}` +
                ` part=${call.refs.part ?? '-'} round=${call.refs.round ?? '-'}` +
                ` messages=${call.refs.message_count ?? '-'}` +
                ` prompt=${call.refs.prompt_chars ?? '-'} chars` +
                ` response=${completed?.refs.response_chars ?? '-'} chars` +
                ` ${completed?.event.replace(/^write\./, '') ?? 'unfinished'}`,
            );
          }
        }

        const requests = writeEvents.filter((event) => event.event === 'write.request.parsed');
        if (requests.length) {
          console.log(`\n${C.bold('Context requests')}`);
          for (const request of requests) {
            const terminal = writeEvents.find(
              (event) =>
                event.subject === request.subject &&
                event.refs.seq === request.refs.seq &&
                event.event.startsWith('write.request.') &&
                event.event !== 'write.request.parsed',
            );
            const consumed = writeEvents.some(
              (event) =>
                event.event === 'write.answer.consumed' &&
                event.subject === request.subject &&
                event.refs.seq === request.refs.seq,
            );
            const notIncluded = writeEvents.some(
              (event) =>
                event.event === 'write.answer.not-included' &&
                event.subject === request.subject &&
                event.refs.seq === request.refs.seq,
            );
            console.log(
              `  ${request.subject} kind=${request.refs.request_kind ?? '-'}` +
                ` status=${terminal?.event.replace(/^write\.request\./, '') ?? 'unfinished'}` +
                ` answer=${consumed ? 'consumed' : notIncluded ? 'not-included' : '-'}`,
            );
          }
        }

        const finalOutput = writeEvents.find((event) => event.event === 'write.output.final');
        const stored = writeEvents.find((event) => event.event === 'write.stored');
        const linked = writeEvents.find((event) => event.event === 'write.context.linked');
        const supplied = writeEvents.find((event) => event.event === 'write.context.supplied');
        console.log(`\n${C.bold('Write handoff')}`);
        if (linked) console.log(`  context trace: ${linked.refs.context_trace_id ?? '-'}`);
        else if (supplied) console.log('  context source: supplied-bundle');
        if (finalOutput) {
          console.log(
            `  output: chars=${finalOutput.refs.body_chars ?? '-'}` +
              ` words=${finalOutput.refs.body_words ?? '-'}` +
              ` hash=${String(finalOutput.refs.body_hash ?? '').slice(0, 12)}`,
          );
        }
        if (stored) {
          console.log(
            `  stored chapter: ${stored.refs.chapter_number ?? '-'}` +
              ` id=${stored.refs.chapter_id ?? '-'}` +
              ` chars=${stored.refs.body_chars ?? '-'}` +
              ` words=${stored.refs.body_words ?? '-'}`,
          );
        }
      }
      for (const event of view.events) {
        const parent = event.parentSpanId ? ` parent=${event.parentSpanId}` : '';
        console.log(
          `\n#${event.id} span=${event.spanId}${parent} ${event.stage} ${event.event}` +
            ` [${event.eventClass}]`,
        );
        console.log(
          `  decision=${event.decision || '-'} reason=${event.reasonCode || '-'}` +
            ` committed=${event.committed ? 'yes' : 'no'}`,
        );
        if (event.subject) console.log(`  subject=${event.subject}`);
        const refs = Object.entries(event.refs).map(([key, value]) => `${key}=${String(value)}`);
        if (refs.length) console.log(`  refs: ${refs.join(' ')}`);
        if (event.model || event.promptHash) {
          console.log(`  model=${event.model || '-'} prompt_hash=${event.promptHash || '-'}`);
        }
        if (event.durationMs !== null) console.log(`  duration_ms=${event.durationMs}`);
        if (event.error) console.log(`  error: ${event.error}`);
      }
      return;
    }

    const audit = traceLog.auditTrace(reader, traceId);
    if (!audit) throw new Error(`no trace "${traceId}"`);
    if (asJson) {
      console.log(JSON.stringify(audit, null, 2));
      return;
    }
    console.log(`\n${C.bold('Trace audit')} ${audit.traceId}`);
    console.log(
      `completeness: ${audit.completeness}` +
        `   exhaustive: ${audit.exhaustive ? 'yes' : 'no'}` +
        `   dropped_events: ${audit.droppedEvents}` +
        `   sampled_rate: ${audit.sampledRate}`,
    );
    console.log(
      audit.exhaustive
        ? C.green('This trace is an exhaustive account of the events it contains.')
        : C.yellow('This trace is NOT an exhaustive account; events were sampled, dropped or interrupted.'),
    );
    if (audit.noteAccounting) {
      const accounting = audit.noteAccounting;
      console.log(
        `note accounting: generated ${accounting.generated} = ` +
          `admitted ${accounting.admitted} + deduplicated ${accounting.deduplicated} + ` +
          `rejected ${accounting.rejected} + parked ${accounting.parked} ` +
          `(${accounting.verified ? 'verified' : 'not verified'})`,
      );
    }
    if (audit.extractionAccounting) {
      const accounting = audit.extractionAccounting;
      const outcomes = accounting.candidateOutcomes;
      const claims = accounting.claimEvents
        ? `claim events inserted ${accounting.claimEvents.inserted}, merged ${accounting.claimEvents.merged}, ` +
          `hinted ${accounting.claimEvents.hinted}, noted ${accounting.claimEvents.noted}, ` +
          `dropped ${accounting.claimEvents.dropped}`
        : 'claim events unavailable';
      console.log(
        `extraction accounting: parsed ${accounting.parsedCandidates}, terminal ${accounting.terminalDispositions} ` +
          `candidate outcomes (inserted ${outcomes.inserted}, merged ${outcomes.merged}, hinted ${outcomes.hinted}, ` +
          `noted ${outcomes.noted}, dropped ${outcomes.dropped}, mixed ${outcomes.mixed}, ` +
          `errors ${outcomes.errors}); ${claims}; sections failed ${accounting.failedSections}, ` +
          `missing ${accounting.missingSections}, partial ${accounting.partialSections}, ` +
          `unparsed ${accounting.unparsedSections}, skipped ${accounting.skippedSections}; ` +
          `aborted candidates ${accounting.abortedCandidates}; unique hints ${accounting.uniqueHints ?? 'unavailable'}; ` +
          `pipeline ${accounting.pipelineScope}/${accounting.pipelineLineage}; run ${accounting.runStatus} ` +
          `(${accounting.candidateAccountingVerified ? 'candidate accounting verified' : 'candidate accounting not verified'})`,
      );
    }
    console.log(`\n${C.bold('Provable violations')}: ${audit.violations.length}`);
    for (const item of audit.violations) {
      const event = item.eventId === undefined ? '' : ` event #${item.eventId}`;
      const claim = item.claimUid ? ` claim ${item.claimUid}` : '';
      console.log(`  ${C.red(item.code)}${event}${claim}: ${item.detail}`);
    }
    console.log(`\n${C.bold('Suspicious patterns')}: ${audit.suspicious.length}`);
    for (const item of audit.suspicious) {
      const event = item.eventId === undefined ? '' : ` event #${item.eventId}`;
      console.log(`  ${C.yellow(item.code)}${event}: ${item.detail}`);
    }
    console.log(`\n${C.bold('Checks')}`);
    for (const check of audit.checks) console.log(`  - ${check}`);
    console.log(`\n${C.bold('Limitations')}`);
    for (const limitation of audit.limitations) console.log(`  - ${limitation}`);
  } finally {
    reader.close();
  }
}

/* ------------------------------------------------------------------- main */

let db: Db;
