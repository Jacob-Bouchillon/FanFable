/**
 * Voice-fingerprint probe — do same-speaker quotes cluster by embedding?
 *
 * Trial-only, measurement only. Reads whole-book quote attributions, embeds
 * each attributed quote with local nomic-embed-text (embeddings only — no
 * reader model loads), and tests: (1) separability, mean cosine of
 * same-speaker vs cross-speaker pairs; (2) attribution by voice,
 * leave-one-quote-out nearest-centroid speaker vote with top-1 accuracy.
 * Speakers are BookNLP cluster ids with >= 5 attributed quotes; no roster,
 * no bank reads beyond the untouched proof. Nothing banks — measurement,
 * verbatim.
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/booknlp/voice-print.ts
 *
 * Writes only under testing/trials/booknlp/out-voice/ (gitignored). Reports
 * print counts only, never passage prose, quotes, or names.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const TRACK = 'testing/trials/booknlp';
const BOOK_OUT = `${TRACK}/out-book`;
const BOOK_ID = 'book';
const VOICE_DIR = `${TRACK}/out-voice`;
const DB_PATH = 'testing/trials/halfbook-run/plagueis-half.db';

const MODEL = 'nomic-embed-text';
const OLLAMA = 'http://127.0.0.1:11434';
const MIN_QUOTES = 5;
const SEED = 42;
const PAIR_SAMPLE = 20000;

function fail(message: string): never {
  throw new Error(`voice-print: ${message}`);
}

function dbStat(): { main: string } {
  const st = statSync(DB_PATH);
  return { main: `${st.size}:${st.mtimeMs}` };
}

function vram(): string {
  const res = spawnSync('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader'], {
    encoding: 'utf8',
  });
  return String(res.stdout ?? '').trim().replace(/\s+/g, ' ');
}

/** Deterministic RNG for pair sampling. */
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

function bodyRows(path: string): string[][] {
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
  const rows = lines.map((line) => line.split('\t'));
  if (rows.length && !/^-?\d+$/.test((rows[0]![0] ?? '').trim())) rows.shift();
  return rows;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) fail(`ollama embed ${res.status}`);
  const data = (await res.json()) as { embeddings?: number[][] };
  if (!data.embeddings || data.embeddings.length !== texts.length) {
    fail(`embed returned ${data.embeddings?.length ?? 0} vectors for ${texts.length} texts`);
  }
  return data.embeddings;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function norm(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

function cosine(a: number[], b: number[], na: number, nb: number): number {
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

/** Wilson 95% interval for k/n. */
function wilson(k: number, n: number, z = 1.96): { p: number; lo: number; hi: number } {
  if (n === 0) return { p: 0, lo: 0, hi: 0 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  const round3 = (x: number): number => Number(x.toFixed(3));
  return { p: round3(p), lo: round3(Math.max(0, center - half)), hi: round3(Math.min(1, center + half)) };
}

async function main(): Promise<void> {
  const before = dbStat();
  const vramBefore = vram();
  // Speaker -> attributed quote texts (mention present, text present).
  const quoteRows = bodyRows(`${BOOK_OUT}/${BOOK_ID}.quotes`);
  const bySpeaker = new Map<number, string[]>();
  for (const r of quoteRows) {
    if ((r[4] ?? '').trim().length === 0) continue;
    const text = String(r[6] ?? '').trim();
    if (!text) continue;
    const id = Number(r[5]);
    if (!Number.isFinite(id)) continue;
    const list = bySpeaker.get(id) ?? [];
    list.push(text);
    bySpeaker.set(id, list);
  }
  const speakers = [...bySpeaker.entries()].filter(([, texts]) => texts.length >= MIN_QUOTES);
  if (speakers.length < 2) fail(`only ${speakers.length} speakers with >= ${MIN_QUOTES} quotes`);
  const quotes: { speaker: number; text: string }[] = [];
  for (const [speaker, texts] of speakers) {
    for (const text of texts) quotes.push({ speaker, text });
  }
  console.log(`speakers ${speakers.length} quotes ${quotes.length} vramBefore ${vramBefore}`);

  // Embed in batches.
  const BATCH = 128;
  const vectors: number[][] = [];
  for (let i = 0; i < quotes.length; i += BATCH) {
    const batch = quotes.slice(i, i + BATCH).map((q) => q.text);
    vectors.push(...(await embedBatch(batch)));
    if (Math.floor(i / BATCH) % 10 === 0) process.stderr.write(`embed ${Math.min(i + BATCH, quotes.length)}/${quotes.length}\n`);
  }
  const norms = vectors.map(norm);
  const dim = vectors[0]!.length;

  // (1) Separability on seeded pair samples.
  const rand = mulberry32(SEED);
  const bySp = new Map<number, number[]>();
  quotes.forEach((q, i) => {
    const list = bySp.get(q.speaker) ?? [];
    list.push(i);
    bySp.set(q.speaker, list);
  });
  const idx = [...quotes.keys()];
  const mean = (pairs: [number, number][]): number => {
    if (!pairs.length) return 0;
    let s = 0;
    for (const [a, b] of pairs) s += cosine(vectors[a]!, vectors[b]!, norms[a]!, norms[b]!);
    return s / pairs.length;
  };
  const samePairs: [number, number][] = [];
  {
    // Pick speakers weighted by pair count, then a random pair within —
    // no pool materialization (one prolific speaker means millions of pairs).
    const lists = [...bySp.values()].filter((l) => l.length >= 2);
    const weights = lists.map((l) => (l.length * (l.length - 1)) / 2);
    const total = weights.reduce((a, b) => a + b, 0);
    for (let k = 0; k < Math.min(PAIR_SAMPLE, total); k++) {
      let x = rand() * total;
      let li = 0;
      while (x > weights[li]!) {
        x -= weights[li]!;
        li++;
      }
      const list = lists[li]!;
      const i = Math.floor(rand() * list.length);
      let j = Math.floor(rand() * (list.length - 1));
      if (j >= i) j++;
      samePairs.push([list[i]!, list[j]!]);
    }
  }
  const crossPairs: [number, number][] = [];
  {
    let guard = 0;
    while (crossPairs.length < PAIR_SAMPLE && guard < PAIR_SAMPLE * 50) {
      guard++;
      const a = Math.floor(rand() * idx.length);
      const b = Math.floor(rand() * idx.length);
      if (a === b || quotes[a]!.speaker === quotes[b]!.speaker) continue;
      crossPairs.push([a, b]);
    }
  }
  const sameCos = mean(samePairs);
  const crossCos = mean(crossPairs);
  const gap = sameCos - crossCos;

  // (2) Leave-one-quote-out nearest-centroid vote.
  const sums = new Map<number, number[]>();
  const counts = new Map<number, number>();
  quotes.forEach((q, i) => {
    const sum = sums.get(q.speaker) ?? new Array<number>(dim).fill(0);
    const v = vectors[i]!;
    for (let d = 0; d < dim; d++) sum[d]! += v[d]!;
    sums.set(q.speaker, sum);
    counts.set(q.speaker, (counts.get(q.speaker) ?? 0) + 1);
  });
  let correct = 0;
  for (let i = 0; i < quotes.length; i++) {
    const q = quotes[i]!;
    const v = vectors[i]!;
    const nv = norms[i]!;
    let best = -1;
    let bestCos = -2;
    for (const [speaker, sum] of sums) {
      const n = counts.get(speaker)!;
      // Leave this quote out of its own speaker's centroid.
      let cos: number;
      if (speaker === q.speaker) {
        if (n <= 1) continue;
        let dotLOO = 0;
        let normLOO = 0;
        for (let d = 0; d < dim; d++) {
          const c = (sum[d]! - v[d]!) / (n - 1);
          dotLOO += v[d]! * c;
          normLOO += c * c;
        }
        normLOO = Math.sqrt(normLOO);
        cos = nv === 0 || normLOO === 0 ? 0 : dotLOO / (nv * normLOO);
      } else {
        let dotC = 0;
        let normC = 0;
        for (let d = 0; d < dim; d++) {
          const c = sum[d]! / n;
          dotC += v[d]! * c;
          normC += c * c;
        }
        normC = Math.sqrt(normC);
        cos = nv === 0 || normC === 0 ? 0 : dotC / (nv * normC);
      }
      if (cos > bestCos) {
        bestCos = cos;
        best = speaker;
      }
    }
    if (best === q.speaker) correct++;
    if ((i + 1) % 2000 === 0) process.stderr.write(`vote ${i + 1}/${quotes.length}\n`);
  }
  const acc = wilson(correct, quotes.length);

  const manifest = {
    model: MODEL,
    nQuotes: quotes.length,
    nSpeakers: speakers.length,
    samePairs: samePairs.length,
    crossPairs: crossPairs.length,
    sameCos: Number(sameCos.toFixed(4)),
    crossCos: Number(crossCos.toFixed(4)),
    gap: Number(gap.toFixed(4)),
    top1: acc.p,
    interval: { lo: acc.lo, hi: acc.hi },
    correct,
    dim,
    vramBefore,
    vramAfter: vram(),
    reviewStatus: 'Nothing banks — measurement, verbatim',
    dbUntouched: dbStat(),
    dbBefore: before,
  };
  mkdirSync(VOICE_DIR, { recursive: true });
  writeFileSync(`${VOICE_DIR}/manifest.json`, JSON.stringify(manifest, null, 1));
  const after = dbStat();
  if (after.main !== before.main) fail('bank moved during probe');
  console.log(
    `separability: same ${manifest.sameCos} cross ${manifest.crossCos} gap ${manifest.gap} ` +
      `(pairs ${samePairs.length}/${crossPairs.length})`,
  );
  console.log(`top1: ${correct}/${quotes.length} = ${acc.p} (95% ${acc.lo}-${acc.hi})`);
  console.log(`bank untouched (main ${before.main}); manifest ${VOICE_DIR}/manifest.json`);
  console.log('Nothing banks — measurement, verbatim');

  // Unload the embedder: one model at a time, nothing stays resident for us.
  try {
    await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, keep_alive: 0 }),
    });
  } catch {
    /* best effort unload */
  }
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('voice-print.ts')) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
