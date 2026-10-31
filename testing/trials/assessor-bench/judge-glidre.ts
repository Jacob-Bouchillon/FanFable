/**
 * Assessor bench, Phase 3 — GLiDRE (cea-list-ia/glidre_multi, ~300M, CPU).
 *
 * Trial-only, measurement only. Document-level input per packet: quote plus
 * passage (quote-scoped rows name both endpoints in the quote while the chunk
 * may name one; offsets index the joined text, fallback counted) with both
 * endpoint mentions (exact, then case-insensitive; unlocatable names skip the
 * packet and are counted), our relation labels verbatim, threshold 0.0 to
 * keep raw scores (the card's 0.3 is reported as a reference operating point,
 * not the scorer). Score = max relation score returned (single pair and
 * single label in, so every relation concerns them). Metrics shared with the
 * GLiClass runner. Nothing banks.
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/assessor-bench/judge-glidre.ts
 *
 * Writes only under testing/trials/assessor-bench/ (gitignored). No bank
 * access at all. Reports print counts only, never passage prose or names.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { metrics } from './judge-gliclass.ts';

const TRACK = 'testing/trials/assessor-bench';
const VENV_PY = `${TRACK}/.venv/bin/python`;
const MODEL = 'cea-list-ia/glidre_multi';

function fail(message: string): never {
  throw new Error(`judge-glidre: ${message}`);
}

const DRIVER = `
import json, sys, time
from glidre import GLiDRE

packets = json.load(open(sys.argv[1]))["packets"]
model = GLiDRE.from_pretrained("cea-list-ia/glidre_multi")

def spans(text, name):
    # Exact, then case-insensitive; offsets always index the original text.
    out = []
    s = 0
    while True:
        i = text.find(name, s)
        if i < 0:
            break
        out.append({"value": text[i:i + len(name)], "start": i, "end": i + len(name)})
        s = i + 1
    if not out:
        low, lname = text.lower(), name.lower()
        s = 0
        while True:
            i = low.find(lname, s)
            if i < 0:
                break
            out.append({"value": text[i:i + len(name)], "start": i, "end": i + len(name)})
            s = i + 1
    return out

out = []
skipped = 0
fallback = 0
t0 = time.time()
for p in packets:
    a, b = p["pair"]
    # Document is quote + passage: quote-scoped rows name both endpoints in
    # the quote while the chunk may name one; offsets index the joined text.
    doc = (p["quote"] or "") + chr(10) + (p["passage"] or "")
    ma, mb = spans(doc, a), spans(doc, b)
    if not ma or not mb:
        skipped += 1
        continue
    if doc != p["passage"]:
        fallback += 1
    mentions = [
        {"id": 0, "type": "PER", "mentions": ma},
        {"id": 1, "type": "PER", "mentions": mb},
    ]
    try:
        rels = model.predict_entities(text=doc, labels=[p["kind"]], mentions=mentions, threshold=0.0, multi_label=False)
    except Exception as e:
        print(f"packet {p['id']} error: {str(e)[:100]}", flush=True)
        skipped += 1
        continue
    # Single pair + single label in, so every returned relation concerns them.
    s = 0.0
    try:
        for r in rels or []:
            s = max(s, float(r.get("score", 0.0)))
    except Exception:
        pass
    out.append({"id": p["id"], "score": s})
secs = time.time() - t0
json.dump({"model": "cea-list-ia/glidre_multi", "secs": secs, "skipped": skipped, "fallback": fallback, "scores": out}, open(sys.argv[2], "w"))
print(f"glidre: {len(out)} scored, {skipped} skipped ({fallback} quote-joined), in {secs:.1f}s")
`;

function main(): void {
  const t0 = Date.now();
  const res = spawnSync(
    VENV_PY,
    ['-c', DRIVER, `${TRACK}/packets.json`, `${TRACK}/scores-glidre.json`],
    { stdio: 'inherit' },
  );
  if (res.status !== 0) fail(`glidre driver exited ${res.status}`);
  console.log(`driver wall ${(Date.now() - t0) / 1000}s`);
  const labels = JSON.parse(readFileSync(`${TRACK}/labels.json`, 'utf8')) as {
    labels: Record<number, string>;
  };
  const scores = JSON.parse(readFileSync(`${TRACK}/scores-glidre.json`, 'utf8')) as {
    scores: { id: number; score: number }[];
    skipped: number;
    fallback: number;
  };
  console.log(`glidre: skipped-unlocatable ${scores.skipped} quote-joined ${scores.fallback ?? 0}`);
  metrics(scores.scores, labels.labels, MODEL, `${TRACK}/metrics-glidre.json`);
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('judge-glidre.ts')) {
  try {
    main();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
