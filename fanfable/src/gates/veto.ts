/**
 * The veto: a removable chained stage after mechanical proof.
 *
 * It scores a claimed (head, kind, tail) against the sentence that proved it.
 * It can only remove rows, never add or promote one. Removing the stage — an
 * absent scorer — leaves the pipeline working with more rows in review, which
 * is the fail-safe direction.
 *
 * The scorer is injected. The adopted implementation is the GLiNER2 relation
 * verifier at 0.60, run out of process (see testing/trials/valve-bench); unit
 * tests use a fake so the gate stays testable without a model.
 */

export const VETO_THRESHOLD = 0.6;

export interface VetoInput {
  fromName: string;
  toName: string;
  kind: string;
  sentence: string;
  chunkText: string;
}

export interface VetoScorer {
  /** 0..1: how strongly the text supports the claimed triple. */
  score(input: VetoInput): number | Promise<number>;
}

export interface VetoDecision {
  pass: boolean;
  reason?: 'veto-rejected';
  score?: number;
}

export function vetoDecision(score: number, threshold = VETO_THRESHOLD): VetoDecision {
  if (!Number.isFinite(score)) return { pass: false, reason: 'veto-rejected', score };
  if (score < threshold) return { pass: false, reason: 'veto-rejected', score };
  return { pass: true, score };
}

/**
 * Apply the veto to rows that already passed mechanical proof.
 *
 * `scorer` undefined means the stage is not installed: every row passes, and
 * the caller keeps its existing behaviour.
 */
export async function applyVeto<T extends VetoInput>(
  rows: T[],
  scorer: VetoScorer | undefined,
  threshold = VETO_THRESHOLD,
): Promise<{ kept: T[]; rejected: { row: T; score: number }[] }> {
  if (!scorer) return { kept: rows, rejected: [] };
  const kept: T[] = [];
  const rejected: { row: T; score: number }[] = [];
  for (const row of rows) {
    const score = await scorer.score(row);
    const decision = vetoDecision(score, threshold);
    if (decision.pass) kept.push(row);
    else rejected.push({ row, score });
  }
  return { kept, rejected };
}
