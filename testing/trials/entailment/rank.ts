/**
 * Entailment ranking of the review queue — GLiClass scores every row.
 *
 * Trial-only, read-only bank. Steps: `sets` builds A (proof rows), B
 * (needs_review), C (non-empty quote + resolvable chunk) and joins the 90
 * audit labels (supported = positive, else negative); `score` runs GLiClass
 * P("the passage states this claim") with kind-aware claim strings and
 * quote-anchored passage windows; `validate` reports AUC etc. on the
 * labelled rows; `rank` writes the id/status/score CSV plus tier counts.
 * Nothing banks, nothing demotes, nothing promotes.
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/entailment/rank.ts [sets|score|validate|rank|all]
 *
 * Writes only under testing/trials/entailment/ (gitignored). The bank is
 * opened read-only and never written. CPU only; Ollama untouched. Reports
 * print counts only, never passage prose, quotes, names, or answer keys.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const TRACK = 'testing/trials/entailment';
const LIVE = `${process.env.HOME}/.local/share/fanfable/fanfable.db`;
const PROJECT = 'halfbook';
const VENV_PY = 'testing/trials/assessor-bench/.venv/bin/python';
const AUDITS = [
  'testing/trials/fp-audit/out/verdicts.json',
  'testing/trials/fp-audit2/out/verdicts.json',
];
const PACKETS = [
  'testing/trials/fp-audit/out/packets.json',
  'testing/trials/fp-audit2/out/packets.json',
];

function fail(message: string): never {
  throw new Error(`entailment: ${message}`);
}

function dbStat(): { main: string } {
  const st = statSync(resolve(LIVE));
  return { main: `${st.size}:${st.mtimeMs}` };
}

export function sets(): void {
  const before = dbStat();
  const db = new DatabaseSync(resolve(LIVE), { readOnly: true });
  try {
    const project = db.prepare('SELECT id FROM project WHERE name = ?').get(PROJECT) as { id: number };
    const ids = (status: string): number[] =>
      (db.prepare('SELECT id FROM canon_relation WHERE project_id = ? AND review_status = ? ORDER BY id').all(
        project.id,
        status,
      ) as { id: number }[]).map((r) => r.id);
    const A = [
      ...ids('accepted'),
      ...ids('attested'),
      ...ids('user_confirmed'),
    ].sort((a, b) => a - b);
    const B = ids('needs_review');
    // C: non-empty quote + resolvable chunk.
    const rows = db.prepare(
      `SELECT id, evidence, source_refs FROM canon_relation WHERE project_id = ? ORDER BY id`,
    ).all(project.id) as { id: number; evidence: string; source_refs: string }[];
    const chunkIds = new Set(
      (db.prepare('SELECT id FROM canon_chunk WHERE project_id = ?').all(project.id) as { id: number }[]).map(
        (r) => r.id,
      ),
    );
    let noQuote = 0;
    let noChunk = 0;
    const c: number[] = [];
    for (const row of rows) {
      if (!String(row.evidence ?? '').trim()) {
        noQuote++;
        continue;
      }
      let chunk = 0;
      try {
        const refs = JSON.parse(row.source_refs || '[]') as { chunk?: unknown }[];
        const found = refs.find((ref) => Number.isFinite(Number(ref?.chunk)) && Number(ref?.chunk) > 0);
        if (found) chunk = Number(found.chunk);
      } catch {
        chunk = 0;
      }
      if (!chunk || !chunkIds.has(chunk)) {
        noChunk++;
        continue;
      }
      c.push(row.id);
    }
    // Labelled: join both audits' packets + verdicts.
    const labelOf = new Map<number, number>();
    let overlapAB = 0;
    for (let k = 0; k < AUDITS.length; k++) {
      const { results } = JSON.parse(readFileSync(AUDITS[k]!, 'utf8')) as {
        results: { id: number; verdict: string }[];
      };
      for (const r of results) {
        const y = r.verdict === 'supported' ? 1 : 0;
        if (labelOf.has(r.id)) overlapAB++;
        labelOf.set(r.id, y);
      }
    }
    let inA = 0;
    let inB = 0;
    let pos = 0;
    for (const [id, y] of labelOf) {
      if (A.includes(id)) inA++;
      if (B.includes(id)) inB++;
      if (y === 1) pos++;
    }
    const out = {
      A: A.length,
      B: B.length,
      C: c.length,
      skippedNoQuote: noQuote,
      skippedNoChunk: noChunk,
      labelled: labelOf.size,
      labelledPos: pos,
      labelledNeg: labelOf.size - pos,
      labelledInA: inA,
      labelledInB: inB,
      labelledOverlapAcrossAudits: overlapAB,
      cIds: c,
      labels: Object.fromEntries(labelOf),
    };
    mkdirSync(TRACK, { recursive: true });
    writeFileSync(`${TRACK}/sets.json`, JSON.stringify(out, null, 1));
    console.log(`sets: A ${A.length} B ${B.length} C ${c.length} (noQuote ${noQuote} noChunk ${noChunk})`);
    console.log(
      `sets: labelled ${labelOf.size} (pos ${pos} neg ${labelOf.size - pos}) inA ${inA} inB ${inB} overlap ${overlapAB}`,
    );
  } finally {
    db.close();
  }
  const after = dbStat();
  if (after.main !== before.main) fail('bank moved during sets');
  console.log(`bank untouched (main ${before.main})`);
}

const DRIVER = `
import json, sys, time
from gliclass import GLiClassModel, ZeroShotClassificationPipeline
from transformers import AutoTokenizer

spec = json.load(open(sys.argv[1]))
items = spec["items"]
model = GLiClassModel.from_pretrained("knowledgator/gliclass-v4-edge")
tokenizer = AutoTokenizer.from_pretrained("knowledgator/gliclass-v4-edge")
pipe = ZeroShotClassificationPipeline(model, tokenizer, classification_type="multi-label", device="cpu", progress_bar=False)
out = []
t0 = time.time()
for it in items:
    res = pipe(it["passage"], ["the passage states this claim", "the passage does not state this claim"], threshold=0.0, batch_size=1)
    scores = res[0] if isinstance(res, list) else res
    s = 0.0
    try:
        for entry in scores:
            if str(entry.get("label", "")) == "the passage states this claim":
                s = float(entry.get("score", 0.0))
                break
    except Exception:
        pass
    out.append({"id": it["id"], "score": s, "trimmed": bool(it.get("trimmed", False))})
secs = time.time() - t0
json.dump({"model": "knowledgator/gliclass-v4-edge", "secs": secs, "scores": out}, open(sys.argv[2], "w"))
print(f"entailment: {len(out)} scored in {secs:.1f}s")
`;

/** Kind-aware claim string. Empty kinds are never templated (skipped upstream). */
export function claimString(a: string, kind: string, b: string): string | null {
  const k = String(kind ?? '').trim();
  if (!k) return null;
  if (k === 'appears_with') return `${a} appears with ${b}`;
  if (k.includes('_')) return `${a} ${k.replace(/_/g, ' ')} ${b}`;
  const base = k.replace(/\s+of$/, '');
  const art = /^[aeiou]/i.test(base) ? 'an' : 'a';
  if (base !== k) return `${a} is ${art} ${base} of ${b}`;
  return `${a} is ${art} ${k} of ${b}`;
}

function splitSentences(text: string): string[] {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Quote sentence plus one neighbour each side, hard-capped at 1200 chars. */
export function windowFor(chunkText: string, quote: string): { window: string; trimmed: boolean } {
  const sents = splitSentences(chunkText);
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const want = norm(quote);
  let idx = sents.findIndex((s) => norm(s).includes(want) || (want.length > 0 && want.includes(norm(s))));
  if (idx < 0) idx = 0;
  const parts = sents.slice(Math.max(0, idx - 1), idx + 2);
  let window = parts.join(' ');
  const trimmed = window.length !== norm(chunkText).length && sents.length > 1;
  if (window.length > 1200) window = window.slice(0, 1200);
  return { window, trimmed };
}

export function score(): void {
  const before = dbStat();
  const setsData = JSON.parse(readFileSync(`${TRACK}/sets.json`, 'utf8')) as {
    cIds: number[];
  };
  const db = new DatabaseSync(resolve(LIVE), { readOnly: true });
  const items: { id: number; passage: string }[] = [];
  let skippedEmptyKind = 0;
  const windowLens: number[] = [];
  let trimmedCount = 0;
  try {
    const project = db.prepare('SELECT id FROM project WHERE name = ?').get(PROJECT) as { id: number };
    for (const id of setsData.cIds) {
      const row = db.prepare(
        `SELECT r.kind, r.evidence, r.source_refs AS sourceRefs, a.name AS fromName, b.name AS toName
           FROM canon_relation r
           JOIN canon_entity a ON a.id = r.from_entity
           JOIN canon_entity b ON b.id = r.to_entity
          WHERE r.project_id = ? AND r.id = ?`,
      ).get(project.id, id) as
        | { kind: string; evidence: string; sourceRefs: string; fromName: string; toName: string }
        | undefined;
      if (!row) continue;
      const claim = claimString(row.fromName, row.kind, row.toName);
      if (claim === null) {
        skippedEmptyKind++;
        continue;
      }
      let chunkId = 0;
      try {
        const refs = JSON.parse(row.sourceRefs || '[]') as { chunk?: unknown }[];
        const found = refs.find((ref) => Number.isFinite(Number(ref?.chunk)) && Number(ref?.chunk) > 0);
        if (found) chunkId = Number(found.chunk);
      } catch {
        chunkId = 0;
      }
      const chunkText = (
        db.prepare('SELECT text FROM canon_chunk WHERE id = ?').get(chunkId) as { text: string } | undefined
      )?.text;
      if (!chunkText) continue;
      const { window, trimmed } = windowFor(chunkText, row.evidence);
      windowLens.push(window.length);
      if (trimmed) trimmedCount++;
      // The claim rides in the label slot; the driver asks P(states claim).
      items.push({ id, passage: `Claim: ${claim}\nPassage: ${window}`, trimmed });
    }
  } finally {
    db.close();
  }
  const sortedLens = [...windowLens].sort((a, b) => a - b);
  const median = sortedLens.length ? sortedLens[Math.floor(sortedLens.length / 2)]! : 0;
  const mean = windowLens.length ? windowLens.reduce((a, b) => a + b, 0) / windowLens.length : 0;
  writeFileSync(`${TRACK}/spec.json`, JSON.stringify({ n: items.length, items }, null, 1));
  const t0 = Date.now();
  const res = spawnSync(
    VENV_PY,
    ['-c', DRIVER, `${TRACK}/spec.json`, `${TRACK}/scores.json`],
    { stdio: 'inherit' },
  );
  if (res.status !== 0) fail(`scorer driver exited ${res.status}`);
  const secs = (Date.now() - t0) / 1000;
  const meta = {
    items: items.length,
    skippedEmptyKind,
    trimmed: trimmedCount,
    windowMean: Number(mean.toFixed(1)),
    windowMedian: median,
    secs: Number(secs.toFixed(1)),
    secsPerRow: items.length ? Number((secs / items.length).toFixed(2)) : 0,
  };
  writeFileSync(`${TRACK}/scoring-meta.json`, JSON.stringify(meta, null, 1));
  console.log(
    `score: items ${meta.items} skippedEmptyKind ${skippedEmptyKind} trimmed ${trimmedCount} ` +
      `window mean ${meta.windowMean} median ${meta.windowMedian} secs ${meta.secs} (${meta.secsPerRow}/row)`,
  );
  const after = dbStat();
  if (after.main !== before.main) fail('bank moved during score');
}

/** AUC via ROC trapezoid. */
function auc(ys: number[], ss: number[]): number {
  const order = ss.map((_, i) => i).sort((a, b) => ss[b]! - ss[a]!);
  const P = ys.filter((y) => y === 1).length;
  const N = ys.length - P;
  if (!P || !N) return 0;
  let tp = 0;
  let fp = 0;
  let prevFpr = 0;
  let prevTpr = 0;
  let area = 0;
  for (const i of order) {
    if (ys[i] === 1) tp++;
    else fp++;
    const tpr = tp / P;
    const fpr = fp / N;
    area += (fpr - prevFpr) * (tpr + prevTpr) / 2;
    prevFpr = fpr;
    prevTpr = tpr;
  }
  return area;
}

export function validate(): Record<string, unknown> {
  const setsData = JSON.parse(readFileSync(`${TRACK}/sets.json`, 'utf8')) as {
    labels: Record<number, number>;
  };
  const scores = JSON.parse(readFileSync(`${TRACK}/scores.json`, 'utf8')) as {
    scores: { id: number; score: number }[];
  };
  const labels = setsData.labels;
  const rows = scores.scores.filter((s) => labels[s.id] === 0 || labels[s.id] === 1);
  const ys = rows.map((s) => labels[s.id]!);
  const ss = rows.map((s) => s.score);
  const area = auc(ys, ss);
  const at = (t: number): { acc: number; prec: number; rec: number } => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    for (let i = 0; i < rows.length; i++) {
      const pred = ss[i]! >= t ? 1 : 0;
      if (pred === 1 && ys[i] === 1) tp++;
      else if (pred === 1) fp++;
      else if (ys[i] === 1) fn++;
      else tn++;
    }
    const n = rows.length || 1;
    return {
      acc: (tp + tn) / n,
      prec: tp + fp ? tp / (tp + fp) : 0,
      rec: tp + fn ? tp / (tp + fn) : 0,
    };
  };
  let best = { t: 0.5, acc: 0 };
  for (let t = 0.05; t < 1; t += 0.05) {
    const a = at(Number(t.toFixed(2))).acc;
    if (a > best.acc) best = { t: Number(t.toFixed(2)), acc: a };
  }
  const m05 = at(0.5);
  const posScores = rows.filter((_, i) => ys[i] === 1).map((r) => r.score);
  const negScores = rows.filter((_, i) => ys[i] === 0).map((r) => r.score);
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const out = {
    n: rows.length,
    pos: ys.filter((y) => y === 1).length,
    neg: ys.filter((y) => y === 0).length,
    auc: Number(area.toFixed(3)),
    acc05: Number(m05.acc.toFixed(3)),
    prec05: Number(m05.prec.toFixed(3)),
    rec05: Number(m05.rec.toFixed(3)),
    bestThreshold: best.t,
    bestAcc: Number(best.acc.toFixed(3)),
    posMean: Number(mean(posScores).toFixed(3)),
    negMean: Number(mean(negScores).toFixed(3)),
  };
  writeFileSync(`${TRACK}/validation.json`, JSON.stringify(out, null, 1));
  console.log(
    `validate: n ${out.n} (pos ${out.pos} neg ${out.neg}) auc ${out.auc} ` +
      `acc@0.5 ${out.acc05} prec ${out.prec05} rec ${out.rec05} best t=${out.bestThreshold} acc ${out.bestAcc}`,
  );
  console.log(`validate: posMean ${out.posMean} negMean ${out.negMean}`);
  if (out.n < 60) console.log(`validate: only ${out.n} labelled rows survived (< 60), proceeding stated`);
  return out;
}

export function rank(): Record<string, unknown> {
  const before = dbStat();
  const scores = JSON.parse(readFileSync(`${TRACK}/scores.json`, 'utf8')) as {
    scores: { id: number; score: number; trimmed: boolean }[];
  };
  const db = new DatabaseSync(resolve(LIVE), { readOnly: true });
  try {
    const project = db.prepare('SELECT id FROM project WHERE name = ?').get(PROJECT) as { id: number };
    const statusOf = new Map<number, string>();
    for (const row of db.prepare('SELECT id, review_status FROM canon_relation WHERE project_id = ?').all(
      project.id,
    ) as { id: number; review_status: string }[]) {
      statusOf.set(row.id, row.review_status);
    }
    const ranked = [...scores.scores].sort((a, b) => b.score - a.score);
    const lines = ['id,review_status,score,trimmed_yn'];
    for (const s of ranked) {
      lines.push(`${s.id},${statusOf.get(s.id) ?? 'unknown'},${s.score.toFixed(4)},${s.trimmed ? 'y' : 'n'}`);
    }
    writeFileSync(`${TRACK}/ranked.csv`, lines.join('\n') + '\n');
    // Top decile by tier; proof rows below 0.3.
    const cutoff = Math.max(1, Math.floor(ranked.length / 10));
    const top = ranked.slice(0, cutoff);
    const byTier: Record<string, number> = {};
    for (const s of top) {
      const tier = statusOf.get(s.id) ?? 'unknown';
      byTier[tier] = (byTier[tier] ?? 0) + 1;
    }
    const proofLow = ranked.filter(
      (s) =>
        s.score < 0.3 &&
        (statusOf.get(s.id) === 'accepted' ||
          statusOf.get(s.id) === 'attested' ||
          statusOf.get(s.id) === 'user_confirmed'),
    ).length;
    const out = { rows: ranked.length, topDecile: cutoff, topByTier: byTier, proofBelow03: proofLow };
    writeFileSync(`${TRACK}/rank-summary.json`, JSON.stringify(out, null, 1));
    console.log(`rank: rows ${ranked.length} decile ${cutoff} tiers ${JSON.stringify(byTier)} proofBelow03 ${proofLow}`);
    console.log(`rank: ${TRACK}/ranked.csv`);
  } finally {
    db.close();
  }
  const after = dbStat();
  if (after.main !== before.main) fail('bank moved during rank');
  return {};
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('rank.ts')) {
  const step = process.argv[2] ?? 'all';
  if (step === 'sets') sets();
  else if (step === 'score') score();
  else if (step === 'validate') validate();
  else if (step === 'rank') rank();
  else if (step === 'all') {
    sets();
    score();
    validate();
    rank();
  } else console.error(`rank: unknown step "${step}" (sets|score|validate|rank|all)`);
}
