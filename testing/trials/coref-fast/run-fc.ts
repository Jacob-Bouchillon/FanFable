/**
 * fastcoref slice runs — FCoref then LingMess on the smoke slice.
 *
 * Trial-only. Runs each model over the same chapter bytes BookNLP smoked,
 * with span typing derived from spaCy POS (proper = span holds a PROPN,
 * nominal = common noun without PROPN, pronoun = PRP) because the library
 * returns bare spans. Steps: `fcoref` / `lingmess` run the model;
 * `score-<model>` maps proper spans to roster persons through the bank's own
 * identity rules (unmapped dropped, never guessed) and samples blind packets
 * (person name + description text, seed 42); `judge-<model>` asks qwen for
 * yes / no / cannot-tell per packet. Nothing banks — measurement, verbatim.
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/coref-fast/run-fc.ts [fcoref|lingmess|score-fcoref|score-lingmess|judge-fcoref|judge-lingmess]
 *
 * Writes only under testing/trials/coref-fast/ (gitignored). The bank is
 * opened read-only and never written. CPU only, except the qwen judge step
 * (one model at a time; unload afterwards). Reports print counts only, never
 * span text, names, or passage prose.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from '../../../fanfable/src/core/db.ts';
import { loadIdentityContext, createResolver } from '../../../fanfable/src/identity/identity.ts';

const TRACK = 'testing/trials/coref-fast';
const VENV_PY = `${TRACK}/venv/bin/python`;
const INPUT = 'testing/trials/booknlp/chapter.txt';
const BANK = 'testing/trials/halfbook-run/plagueis-half.db';
const QWEN = 'qwen3.5:9b';
const OLLAMA = 'http://127.0.0.1:11434';

function fail(message: string): never {
  throw new Error(`run-fc: ${message}`);
}

const DRIVER = `
import json, sys, time
import spacy
from fastcoref import FCoref, LingMessCoref

# Bridge for 2024-era custom models under a modern transformers: the loader
# reads a legacy tied-weights registry these classes predate
# (all_tied_weights_keys, now _tied_weights_keys internally). An empty
# registry preserves loading with no tied special-casing, which is inert for
# inference-only scoring; any other drift still raises. No vendored file is
# modified.
try:
    from fastcoref.coref_models.modeling_fcoref import FCorefModel
    from fastcoref.coref_models.modeling_lingmess import LingMessModel
    for _cls in (FCorefModel, LingMessModel):
        if 'all_tied_weights_keys' not in _cls.__dict__:
            _cls.all_tied_weights_keys = {}
except Exception as _e:
    print(f"bridge skipped: {_e}", flush=True)

which, inp, outp = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(inp).read()
nlp = spacy.load("en_core_web_sm")
if which == "fcoref":
    model = FCoref(device="cpu")
else:
    # Bridge: transformers 5.x defaults Longformer to SDPA, which it does not
    # implement; the loader's own error prescribes attn_implementation="eager".
    # Applied at our call site only; no vendored file is modified.
    from fastcoref.coref_models.modeling_lingmess import LingMessModel
    _orig_fp = LingMessModel.from_pretrained.__func__
    @classmethod
    def _eager_fp(cls, *a, **k):
        k.setdefault("attn_implementation", "eager")
        return _orig_fp(cls, *a, **k)
    LingMessModel.from_pretrained = _eager_fp
    model = LingMessCoref(device="cpu")
t0 = time.time()
# Span format, verified per model: CorefResult.get_clusters(as_strings=False)
# yields char offsets for both models (raw elements are token indices and
# must NOT be read as chars). LingMess drops over-long documents silently,
# so it runs per ~2000-token piece with offsets shifted back; clusters never
# cross pieces. FCoref takes the whole slice in one go.
def pieces(text, cap=2000):
    import re
    words = [(m.group(0), m.start()) for m in re.finditer(r'\\S+', text)]
    out = []
    for i in range(0, len(words), cap):
        chunk = words[i:i + cap]
        start = chunk[0][1]
        end = chunk[-1][1] + len(chunk[-1][0])
        out.append((text[start:end], start))
    return out or [(text, 0)]

def run_texts(items):
    all_clusters = []
    for piece_text, off in items:
        preds = model.predict(texts=[piece_text])
        preds = model.predict(texts=[piece_text])
        first = preds[0] if isinstance(preds, list) and preds else None
        if first is None or not hasattr(first, "get_clusters"):
            continue
        for cl in first.get_clusters(as_strings=False):
            spans = []
            for s in cl:
                try:
                    a, b = int(s[0]) + off, int(s[1]) + off
                except Exception:
                    continue
                spans.append((a, b))
            if spans:
                all_clusters.append(spans)
    return all_clusters

if which == "lingmess":
    clusters = run_texts(pieces(text))
else:
    clusters = run_texts([(text, 0)])
secs = time.time() - t0
doc = nlp(text)
toks = [(t.idx, t.idx + len(t.text), t.pos_) for t in doc]

def pos_of(start, end):
    tags = [p for (s, e, p) in toks if s < end and e > start]
    return tags

out_clusters = []
for cl in clusters:
    spans = []
    for s in cl:
        if isinstance(s, (list, tuple)) and len(s) >= 2:
            start, end = int(s[0]), int(s[1])
        elif isinstance(s, dict):
            start, end = int(s.get("start", 0)), int(s.get("end", 0))
        else:
            continue
        tags = pos_of(start, end)
        if any(t == "PRP" for t in tags):
            kind = "pronoun"
        elif any(t == "PROPN" for t in tags):
            kind = "proper"
        elif any(t == "NOUN" for t in tags):
            kind = "nominal"
        else:
            kind = "other"
        spans.append({"start": start, "end": end, "kind": kind, "len": end - start, "text": text[start:end]})
    out_clusters.append(spans)
json.dump({"model": which, "secs": secs, "chars": len(text), "clusters": out_clusters}, open(outp, "w"))
print(f"{which}: {len(out_clusters)} clusters in {secs:.1f}s")
`;

export function run(which: 'fcoref' | 'lingmess'): void {
  mkdirSync(TRACK, { recursive: true });
  const t0 = Date.now();
  const res = spawnSync(VENV_PY, ['-c', DRIVER, which, INPUT, `${TRACK}/${which}.json`], { stdio: 'inherit' });
  if (res.status !== 0) fail(`${which} driver exited ${res.status}`);
  console.log(`${which}: wall ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function score(which: 'fcoref' | 'lingmess'): Record<string, unknown> {
  const db = new DatabaseSync(resolve(BANK), { readOnly: true });
  try {
    const dbLike = {
      all: <T>(sql: string, ...params: unknown[]): T[] => db.prepare(sql).all(...params) as T[],
    };
    const context = loadIdentityContext(dbLike as unknown as Db, 1);
    const resolver = createResolver(context);
    const characters = context.entities.filter((e) => e.kind === 'character');
    const data = JSON.parse(readFileSync(`${TRACK}/${which}.json`, 'utf8')) as {
      secs: number;
      clusters: { kind: string; text?: string }[][];
    };
    const resolvePerson = (text: string): number | null => {
      const r = resolver.resolve(String(text ?? ''));
      if (r.status === 'resolved' && r.id !== null && characters.some((e) => e.id === r.id)) {
        return r.id;
      }
      return null;
    };
    const nameOf = new Map<number, string>();
    for (const e of characters) nameOf.set(e.id, e.name);
    let joins = 0;
    let mappedJoins = 0;
    let badMerges = 0;
    const persons = new Set<number>();
    const joinPackets: { person: string; desc: string }[] = [];
    for (const spans of data.clusters) {
      const hasProper = spans.some((s) => s.kind === 'proper');
      const hasNom = spans.some((s) => s.kind === 'nominal');
      if (!hasProper || !hasNom) continue;
      joins++;
      const ps = new Set<number>();
      for (const s of spans) {
        if (s.kind !== 'proper' || !s.text) continue;
        const id = resolvePerson(s.text);
        if (id !== null) {
          ps.add(id);
          persons.add(id);
        }
      }
      if (ps.size === 1) {
        mappedJoins++;
        const person = [...ps][0]!;
        const desc = spans.filter((s) => s.kind === 'nominal' && s.text).map((s) => s.text!)[0] ?? '';
        if (desc) joinPackets.push({ person: nameOf.get(person) ?? '', desc });
      } else if (ps.size > 1) {
        badMerges++;
      }
    }
    const rand = mulberry32(42);
    const sampled = [...joinPackets];
    for (let i = sampled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [sampled[i], sampled[j]] = [sampled[j]!, sampled[i]!];
    }
    const out = {
      model: which,
      secs: data.secs,
      clusters: data.clusters.length,
      joins,
      mappedJoins,
      badMerges,
      distinctPersons: persons.size,
      packets: sampled.slice(0, 20).map((p, i) => ({ id: `${which[0]}${i + 1}`, ...p })),
    };
    writeFileSync(`${TRACK}/score-${which}.json`, JSON.stringify(out, null, 1));
    console.log(
      `${which}: joins ${joins} mapped ${mappedJoins} badMerges ${badMerges} persons ${persons.size} packets ${out.packets.length}`,
    );
    return out;
  } finally {
    db.close();
  }
}

export type JoinVerdict = 'yes' | 'no' | 'cannot-tell';

export function parseJoin(raw: string): JoinVerdict | null {
  const blocks = raw.match(/\{[^{}]*\}/g) ?? [];
  const greedy = raw.match(/\{[\s\S]*\}/)?.[0];
  if (greedy) blocks.push(greedy);
  for (const block of blocks) {
    try {
      const obj = JSON.parse(block) as { verdict?: string };
      const v = String(obj.verdict ?? '').toLowerCase();
      if (v === 'yes' || v === 'no' || v === 'cannot-tell') return v;
    } catch {
      /* next block */
    }
  }
  return null;
}

export async function judge(which: 'fcoref' | 'lingmess'): Promise<void> {
  const ps = spawnSync('ollama', ['ps'], { encoding: 'utf8' });
  const lines = String(ps.stdout ?? '').split('\n').slice(1).filter((l) => l.trim().length > 0);
  const foreign = lines.filter((l) => !l.startsWith(QWEN));
  if (foreign.length) {
    fail(`non-judge model resident (${foreign.length} row(s)) — unload first, never evict blindly`);
  }
  const packetsPath = `${TRACK}/score-${which}.json`;
  if (!existsSync(packetsPath)) fail(`no ${packetsPath} (run score-${which} first)`);
  const { packets } = JSON.parse(readFileSync(packetsPath, 'utf8')) as {
    packets: { id: string; person: string; desc: string }[];
  };
  try {
    const tags = await fetch('http://127.0.0.1:11434/api/tags');
    if (!tags.ok) fail(`ollama tags ${tags.status}`);
  } catch (err) {
    fail(`ollama unreachable: ${(err as Error).message}`);
  }
  const results: { id: string; verdict: JoinVerdict; unparsable: boolean }[] = [];
  for (const packet of packets) {
    const prompt =
      `In this novel, does the description "${packet.desc}" plausibly refer to the character "${packet.person}"? ` +
      `Reply with JSON only: {"verdict": "yes" | "no" | "cannot-tell"}.`;
    let raw = '';
    try {
      const res = await fetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: QWEN,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          format: 'json',
          think: false,
          options: { temperature: 0, seed: 42 },
        }),
      });
      if (!res.ok) fail(`ollama ${res.status} at packet ${packet.id}`);
      const data = (await res.json()) as { message?: { content?: string } };
      raw = (data.message?.content ?? '').trim();
    } catch (err) {
      fail(`ollama call failed at packet ${packet.id}: ${(err as Error).message}`);
    }
    const verdict = parseJoin(raw);
    results.push({ id: packet.id, verdict: verdict ?? 'cannot-tell', unparsable: verdict === null });
  }
  const supported = results.filter((r) => r.verdict === 'yes').length;
  const n = results.length;
  const out = {
    model: which,
    n,
    yes: supported,
    no: results.filter((r) => r.verdict === 'no').length,
    cannotTell: results.filter((r) => r.verdict === 'cannot-tell').length,
    unparsable: results.filter((r) => r.unparsable).length,
    support: n ? Number((supported / n).toFixed(3)) : 0,
  };
  writeFileSync(`${TRACK}/judge-${which}.json`, JSON.stringify({ ...out, results }, null, 1));
  console.log(`${which}: yes ${out.yes}/${n} support ${out.support} unparsable ${out.unparsable}`);
}

export function wilson(k: number, n: number, z = 1.96): { p: number; lo: number; hi: number } {
  if (n === 0) return { p: 0, lo: 0, hi: 0 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  const round3 = (x: number): number => Number(x.toFixed(3));
  return { p: round3(p), lo: round3(Math.max(0, center - half)), hi: round3(Math.min(1, center + half)) };
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('run-fc.ts')) {
  const step = process.argv[2] ?? '';
  (async () => {
    if (step === 'fcoref' || step === 'lingmess') run(step);
    else if (step === 'score-fcoref') score('fcoref');
    else if (step === 'score-lingmess') score('lingmess');
    else if (step === 'judge-fcoref') await judge('fcoref');
    else if (step === 'judge-lingmess') await judge('lingmess');
    else {
      console.error('run-fc: use fcoref|lingmess|score-fcoref|score-lingmess|judge-fcoref|judge-lingmess');
      process.exit(1);
    }
  })().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
