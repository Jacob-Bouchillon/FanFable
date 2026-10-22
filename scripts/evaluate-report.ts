/**
 * Turn a benchmark run into markdown tables.
 *
 *   node scripts/evaluate-report.ts <run-id> [<run-id> ...]
 *
 * The numbers come from the run files, not from anything typed by hand, so
 * the tables in RESULTS.md can be regenerated and checked.
 */
import { RunStore, isMain, mean } from './benchmark/harness.ts';

/** Which columns to show for each role, and how to read them. */
const COLUMNS: Record<string, { key: string; label: string; format: 'number' | 'percent' | 'seconds' | 'int' }[]> = {
  lore: [
    { key: 'failedCalls', label: 'failed calls', format: 'int' },
    { key: 'recall', label: 'recall', format: 'percent' },
    { key: 'precision', label: 'precision', format: 'percent' },
    { key: 'matched', label: 'matched', format: 'int' },
    { key: 'extracted', label: 'extracted', format: 'int' },
    { key: 'unmatched', label: 'unmatched', format: 'int' },
    { key: 'fabricatedQuotes', label: 'fabricated quotes', format: 'int' },
    { key: 'unbacked', label: 'no quote', format: 'int' },
    { key: 'quoted', label: 'verified quote', format: 'int' },
    { key: 'nameAccuracy', label: 'name accuracy', format: 'percent' },
    { key: 'msPerWindow', label: 's/window', format: 'seconds' },
  ],
  planning: [
    { key: 'jsonValid', label: 'valid json', format: 'number' },
    { key: 'chapters', label: 'chapters', format: 'number' },
    { key: 'completeChapters', label: 'complete', format: 'percent' },
    { key: 'canonAuSplit', label: 'canon/au split', format: 'percent' },
    { key: 'openQuestions', label: 'open questions', format: 'number' },
    { key: 'canonRefs', label: 'canon refs', format: 'int' },
    { key: 'canonRefsValid', label: 'refs valid', format: 'percent' },
    { key: 'premiseCoverage', label: 'premise covered', format: 'percent' },
    { key: 'divergenceHonoured', label: 'divergence kept', format: 'number' },
    { key: 'consequencePlanning', label: 'consequence planned', format: 'percent' },
    { key: 'ms', label: 'time', format: 'seconds' },
  ],
  writing: [
    { key: 'words', label: 'words', format: 'int' },
    { key: 'lengthRatio', label: 'length', format: 'percent' },
    { key: 'repetition', label: 'repetition', format: 'percent' },
    { key: 'copied', label: 'copied', format: 'percent' },
    { key: 'inventedNames', label: 'invented names', format: 'percent' },
    { key: 'charactersPresent', label: 'characters', format: 'percent' },
    { key: 'sceneCoverage', label: 'scenes', format: 'percent' },
    { key: 'canonCoverage', label: 'canon bullets', format: 'percent' },
    { key: 'auCoverage', label: 'au bullets', format: 'percent' },
    { key: 'canonLeak', label: 'canon leak', format: 'int' },
    { key: 'dialogueShare', label: 'dialogue', format: 'percent' },
    { key: 'meanSentenceWords', label: 'words/sentence', format: 'number' },
    { key: 'typeTokenRatio', label: 'types', format: 'number' },
    { key: 'longSentences', label: 'long sentences', format: 'int' },
    { key: 'ms', label: 'time', format: 'seconds' },
  ],
  continuity: [
    { key: 'detected', label: 'found', format: 'number' },
    { key: 'planted', label: 'planted', format: 'number' },
    { key: 'falsePositives', label: 'false positives', format: 'int' },
    { key: 'falsePositiveRate', label: 'fp rate', format: 'percent' },
    { key: 'deterministicDetected', label: 'found without a model', format: 'number' },
    { key: 'combinedDetected', label: 'found in total', format: 'number' },
    { key: 'ms', label: 'time', format: 'seconds' },
  ],
  'long-story': [
    { key: 'chapters', label: 'chapters', format: 'int' },
    { key: 'words', label: 'words', format: 'int' },
    { key: 'lengthRatio', label: 'length', format: 'percent' },
    { key: 'repetition', label: 'repetition', format: 'percent' },
    { key: 'auEvents', label: 'events', format: 'int' },
    { key: 'knowledgeRecords', label: 'knowledge', format: 'int' },
    { key: 'charactersWithKnowledge', label: 'knowers', format: 'int' },
    { key: 'relationships', label: 'relationships', format: 'int' },
    { key: 'threads', label: 'threads', format: 'int' },
    { key: 'threadsResolved', label: 'resolved', format: 'int' },
    { key: 'secrets', label: 'secrets', format: 'int' },
    { key: 'motivations', label: 'motivations', format: 'int' },
    { key: 'storyFacts', label: 'facts', format: 'int' },
    { key: 'conflicts', label: 'conflicts', format: 'int' },
    { key: 'graphNodes', label: 'nodes', format: 'int' },
    { key: 'graphIssues', label: 'graph issues', format: 'int' },
    { key: 'plantedCaught', label: 'planted caught', format: 'number' },
    { key: 'canonEntityDelta', label: 'canonΔ entities', format: 'int' },
    { key: 'canonRelationDelta', label: 'canonΔ relations', format: 'int' },
    { key: 'canonEventDelta', label: 'canonΔ events', format: 'int' },
    { key: 'ms', label: 'time', format: 'seconds' },
  ],
};

function format(value: number | undefined, kind: string): string {
  if (value === undefined || !Number.isFinite(value)) return '-';
  if (kind === 'percent') return `${(value * 100).toFixed(0)}%`;
  if (kind === 'seconds') return `${(value / 1000).toFixed(1)}s`;
  if (kind === 'int') return String(Math.round(value));
  if (kind === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return value.toFixed(2);
}

export function markdownReport(runIds: string[]): string {
  const out: string[] = [];
  for (const runId of runIds) {
    const { meta, results } = RunStore.load(runId);
    out.push(`## Run \`${runId}\``);
    out.push('');
    out.push(`Started ${meta.startedAt}. ${meta.notes ?? ''}`);
    out.push('');
    const roles = [...new Set(results.map((r) => r.role))];
    for (const role of roles) {
      const columns = COLUMNS[role];
      if (!columns) continue;
      const rows = results.filter((r) => r.role === role);
      const models = [...new Set(rows.map((r) => r.model))];
      out.push(`### ${role}`);
      out.push('');
      out.push(`| model | ${columns.map((c) => c.label).join(' | ')} |`);
      out.push(`| --- | ${columns.map(() => '---:').join(' | ')} |`);
      for (const model of models) {
        const all = rows.filter((r) => r.model === model);
        const mine = all.filter((r) => r.ok);
        // A run whose calls all failed is not a measurement. Say so instead of
        // printing a row of zeroes that reads like a score.
        const failed = all.filter((r) => !r.ok);
        // Counted from the recorded calls, so it works for runs written
        // before the metric existed.
        const failedCallsOf = (r: (typeof rows)[number]): number =>
          (r.calls ?? []).filter((c) => c.error).length;
        const totalCallsOf = (r: (typeof rows)[number]): number => (r.calls ?? []).length;
        const everyCallFailed =
          mine.length > 0 &&
          mine.every((r) => {
            const total = totalCallsOf(r);
            return total > 0 && failedCallsOf(r) >= total;
          });
        const cells = columns.map((c) => {
          if (c.key === 'failedCalls') {
            return String(Math.round(mean(mine.map(failedCallsOf)) ?? 0));
          }
          if (everyCallFailed) return 'run failed';
          const values = mine
            .map((r) => {
              const raw = r.metrics[c.key];
              if (typeof raw === 'string') return raw === 'yes' ? 1 : raw === 'no' ? 0 : NaN;
              return Number(raw);
            })
            .filter((n) => Number.isFinite(n));
          return format(mean(values) ?? undefined, c.format);
        });
        const note = failed.length ? ` (${failed.length} run(s) failed)` : '';
        out.push(`| ${model}${note} | ${cells.join(' | ')} |`);
      }
      out.push('');
    }
  }
  return out.join('\n');
}

function main(): void {
  const runs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!runs.length) {
    console.log('usage: node scripts/evaluate-report.ts <run-id> [...]');
    return;
  }
  console.log(markdownReport(runs));
}

if (isMain(import.meta.url)) {
  main();
}
