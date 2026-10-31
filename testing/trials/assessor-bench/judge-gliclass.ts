/**
 * Assessor bench, Phase 1 — GLiClass v4 Edge (0.4B, CPU).
 *
 * Trial-only, measurement only. Scores every frozen-set packet with the
 * question "Does the passage state that {A} is {kind} of {B}?" as NLI-style
 * zero-shot labels [true-description, false-description]; score = P(true).
 * Metrics (accuracy at 0.5 and at the set-best threshold, precision, recall,
 * AUC, POS vs NEG score distribution) print as counts. Nothing banks.
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/assessor-bench/judge-gliclass.ts
 *
 * Writes only under testing/trials/assessor-bench/ (gitignored). No bank
 * access at all. Reports print counts only, never passage prose or names.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const TRACK = 'testing/trials/assessor-bench';
const VENV_PY = `${TRACK}/.venv/bin/python`;
const MODEL = 'knowledgator/gliclass-v4-edge';

function fail(message: string): never {
  throw new Error(`judge-gliclass: ${message}`);
}

const DRIVER = `
import json, sys, time
from gliclass import GLiClassModel, ZeroShotClassificationPipeline
from transformers import AutoTokenizer

packets = json.load(open(sys.argv[1]))["packets"]
model = GLiClassModel.from_pretrained("knowledgator/gliclass-v4-edge")
tokenizer = AutoTokenizer.from_pretrained("knowledgator/gliclass-v4-edge")
pipe = ZeroShotClassificationPipeline(model, tokenizer, classification_type="multi-label", device="cpu", progress_bar=False)
out = []
t0 = time.time()
for p in packets:
    a, b = p["pair"]
    claim = f"{a} is {p['kind']} of {b}"
    res = pipe(p["passage"], [f"the passage states that {claim}", f"the passage states no such tie"], threshold=0.0, batch_size=1)
    scores = res[0] if isinstance(res, list) else res
    s = 0.0
    try:
        for entry in scores:
            label = str(entry.get("label", ""))
            if label.startswith("the passage states that") and not label.startswith("the passage states no"):
                s = float(entry.get("score", 0.0))
                break
        else:
            s = float(scores[0].get("score", 0.0)) if scores else 0.0
    except Exception:
        s = 0.0
    out.append({"id": p["id"], "score": s})
secs = time.time() - t0
json.dump({"model": "knowledgator/gliclass-v4-edge", "secs": secs, "scores": out}, open(sys.argv[2], "w"))
print(f"gliclass: {len(out)} scored in {secs:.1f}s")
`;

export function metrics(
  scores: { id: number; score: number }[],
  labels: Record<number, string>,
  model = MODEL,
  metricsPath = `${TRACK}/metrics-gliclass.json`,
): void {
  const rows = scores
    .filter((s) => labels[s.id] === 'pos' || labels[s.id] === 'neg')
    .map((s) => ({ y: labels[s.id] === 'pos' ? 1 : 0, s: s.score }));
  const n = rows.length;
  const at = (t: number): { acc: number; prec: number; rec: number } => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    for (const r of rows) {
      const pred = r.s >= t ? 1 : 0;
      if (pred === 1 && r.y === 1) tp++;
      else if (pred === 1) fp++;
      else if (r.y === 1) fn++;
      else tn++;
    }
    return {
      acc: (tp + tn) / n,
      prec: tp + fp ? tp / (tp + fp) : 0,
      rec: tp + fn ? tp / (tp + fn) : 0,
    };
  };
  // AUC via ROC trapezoid.
  const sorted = [...rows].sort((a, b) => b.s - a.s);
  const P = rows.filter((r) => r.y === 1).length;
  const N = n - P;
  let auc = 0;
  let tp = 0;
  let fp = 0;
  let prevFpr = 0;
  let prevTpr = 0;
  for (const r of sorted) {
    if (r.y === 1) tp++;
    else fp++;
    const tpr = P ? tp / P : 0;
    const fpr = N ? fp / N : 0;
    auc += (fpr - prevFpr) * (tpr + prevTpr) / 2;
    prevFpr = fpr;
    prevTpr = tpr;
  }
  let best = { t: 0.5, acc: 0 };
  for (let t = 0.05; t < 1; t += 0.05) {
    const a = at(Number(t.toFixed(2))).acc;
    if (a > best.acc) best = { t: Number(t.toFixed(2)), acc: a };
  }
  const m05 = at(0.5);
  const pos = rows.filter((r) => r.y === 1).map((r) => r.s);
  const neg = rows.filter((r) => r.y === 0).map((r) => r.s);
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const report = {
    n,
    pos: P,
    neg: N,
    acc05: Number(m05.acc.toFixed(3)),
    prec05: Number(m05.prec.toFixed(3)),
    rec05: Number(m05.rec.toFixed(3)),
    bestThreshold: best.t,
    bestAcc: Number(best.acc.toFixed(3)),
    auc: Number(auc.toFixed(3)),
    posMean: Number(mean(pos).toFixed(3)),
    negMean: Number(mean(neg).toFixed(3)),
  };
  console.log(
    `${model}: n ${n} (pos ${P} neg ${N}) acc@0.5 ${report.acc05} prec ${report.prec05} rec ${report.rec05} ` +
      `best t=${report.bestThreshold} acc ${report.bestAcc} auc ${report.auc}`,
  );
  console.log(`${model}: posMean ${report.posMean} negMean ${report.negMean}`);
  mkdirSync(TRACK, { recursive: true });
  writeFileSync(metricsPath, JSON.stringify({ model, ...report }, null, 1));
}

function main(): void {
  const t0 = Date.now();
  const res = spawnSync(
    VENV_PY,
    ['-c', DRIVER, `${TRACK}/packets.json`, `${TRACK}/scores-gliclass.json`],
    { stdio: 'inherit' },
  );
  if (res.status !== 0) fail(`gliclass driver exited ${res.status}`);
  console.log(`driver wall ${(Date.now() - t0) / 1000}s`);
  const labels = JSON.parse(readFileSync(`${TRACK}/labels.json`, 'utf8')) as {
    labels: Record<number, string>;
  };
  const scores = JSON.parse(readFileSync(`${TRACK}/scores-gliclass.json`, 'utf8')) as {
    scores: { id: number; score: number }[];
  };
  metrics(scores.scores, labels.labels);
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('judge-gliclass.ts')) {
  try {
    main();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
