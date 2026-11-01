/**
 * Batch form of the veto, for a runtime that loads a model once per process.
 *
 * `applyVeto` (per row) is the unit-test contract. `applyVetoBatch` is what the
 * bridge uses: one process, one model load, many candidates. Both remove rows
 * and never add one, and both are no-ops when no scorer is installed.
 */
import { VETO_THRESHOLD, vetoDecision, type VetoInput } from './veto.ts';

export interface VetoBatchScorer {
  /** One score per input, in order. `null` means the row could not be scored. */
  scoreBatch(inputs: VetoInput[]): Promise<(number | null)[]>;
}

export async function applyVetoBatch<T extends VetoInput>(
  rows: T[],
  scorer: VetoBatchScorer | undefined,
  threshold = VETO_THRESHOLD,
): Promise<{ kept: T[]; rejected: { row: T; score: number }[]; unscored: T[] }> {
  if (!scorer || rows.length === 0) return { kept: rows, rejected: [], unscored: [] };
  const scores = await scorer.scoreBatch(rows);
  const kept: T[] = [];
  const rejected: { row: T; score: number }[] = [];
  const unscored: T[] = [];
  rows.forEach((row, i) => {
    const score = scores[i];
    if (score === null || score === undefined || !Number.isFinite(score)) {
      // Fail safe: an unscorable row stays in review, it is not promoted.
      unscored.push(row);
      return;
    }
    const decision = vetoDecision(score, threshold);
    if (decision.pass) kept.push(row);
    else rejected.push({ row, score });
  });
  return { kept, rejected, unscored };
}
