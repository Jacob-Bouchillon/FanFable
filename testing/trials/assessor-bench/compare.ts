/**
 * Assessor bench, Phase 4 — comparison (no new model calls).
 *
 * Trial-only, read-only bank. Reads the three metrics files plus the frozen
 * labels, recomputes the Q8 incumbent column from stored assessments
 * (strength >= 0.7 predicts true; zero new calls), and writes the comparison
 * table. Nothing banks.
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/assessor-bench/compare.ts
 *
 * Writes only testing/trials/assessor-bench/compare.json (gitignored).
 * Reports print counts only, never passage prose or names.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TRACK = 'testing/trials/assessor-bench';
const LIVE = `${process.env.HOME}/.local/share/fanfable/fanfable.db`;

function fail(message: string): never {
  throw new Error(`compare: ${message}`);
}

const round3 = (x: number): number => Number(x.toFixed(3));

export function compare(): void {
  const before = statSync(resolve(LIVE));
  const beforeKey = `${before.size}:${before.mtimeMs}`;
  const labels = JSON.parse(readFileSync(`${TRACK}/labels.json`, 'utf8')) as {
    labels: Record<number, string>;
  };
  const gliclass = JSON.parse(readFileSync(`${TRACK}/metrics-gliclass.json`, 'utf8')) as Record<string, unknown>;
  const glidre = JSON.parse(readFileSync(`${TRACK}/metrics-glidre.json`, 'utf8')) as Record<string, unknown>;
  const glidreScores = JSON.parse(readFileSync(`${TRACK}/scores-glidre.json`, 'utf8')) as {
    skipped: number;
  };
  // Q8 incumbent from stored assessments: no new calls.
  const db = new DatabaseSync(resolve(LIVE), { readOnly: true });
  let q8: Record<string, number>;
  try {
    const packets = JSON.parse(readFileSync(`${TRACK}/packets.json`, 'utf8')) as {
      packets: { id: number }[];
    };
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    for (const p of packets.packets) {
      const row = db.prepare('SELECT supporting_evidence FROM canon_relation WHERE id = ?').get(p.id) as
        | { supporting_evidence: string }
        | undefined;
      let s = 0;
      try {
        const items = JSON.parse(row?.supporting_evidence ?? '[]') as { assessment?: { strength?: number } }[];
        for (const item of items) {
          const v = Number(item?.assessment?.strength);
          if (Number.isFinite(v) && v > s) s = v;
        }
      } catch {
        s = 0;
      }
      const pred = s >= 0.7 ? 1 : 0;
      const y = labels.labels[p.id] === 'pos' ? 1 : 0;
      if (pred === 1 && y === 1) tp++;
      else if (pred === 1) fp++;
      else if (y === 1) fn++;
      else tn++;
    }
    const n = tp + fp + fn + tn;
    q8 = {
      n,
      acc: round3((tp + tn) / n),
      prec: tp + fp ? round3(tp / (tp + fp)) : 0,
      rec: tp + fn ? round3(tp / (tp + fn)) : 0,
      posRecall: tp + fn ? round3(tp / (tp + fn)) : 0,
      negFpr: fp + tn ? round3(fp / (fp + tn)) : 0,
    };
  } finally {
    db.close();
  }
  const table = {
    q8: { ...q8, setup: 'none (stored assessments)', latency: 'n/a' },
    gliclass: { ...gliclass, setup: 'pip + 0.4B download, CPU ~4.8s/item' },
    glidre: { ...glidre, skipped: glidreScores.skipped, setup: 'source install + 300M download, CPU fast' },
    relweave: { status: 'blocked: 4-bit needs CUDA torch; env is CPU-only' },
  };
  writeFileSync(`${TRACK}/compare.json`, JSON.stringify(table, null, 1));
  console.log(`q8: acc ${q8.acc} prec ${q8.prec} rec ${q8.rec} fpr ${q8.negFpr}`);
  console.log(
    `gliclass: acc ${(gliclass.acc05 as number) ?? (gliclass as { acc?: number }).acc} ` +
      `auc ${gliclass.auc} best ${(gliclass.bestThreshold as number) ?? '?'}->${(gliclass.bestAcc as number) ?? '?'}`,
  );
  console.log(`glidre: scored ${(glidre.n as number) ?? '?'} skipped ${glidreScores.skipped} auc ${glidre.auc}`);
  console.log(`bank untouched (main ${beforeKey}); manifest ${TRACK}/compare.json`);
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('compare.ts')) {
  try {
    compare();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
