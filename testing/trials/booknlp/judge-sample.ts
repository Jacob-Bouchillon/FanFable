/**
 * BookNLP correctness test — blind-judged sample, one precision number out.
 *
 * Trial-only. Samples 40 pronoun bindings + 40 quote attributions (seed 42)
 * from the upstream chapter outputs, builds blind packets mechanically (text
 * evidence + the candidate under test, NEVER the source: no system labels, no
 * roster flags, no bank status), judges each with one spark-x2-q8 call, and
 * scores precision with splits. Outputs stay candidates — state that verbatim:
 * NOTHING banks here.
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/booknlp/judge-sample.ts [sample|judge|score|all]
 *
 * Writes only under testing/trials/booknlp/out-judge/ (gitignored). The bank
 * is opened read-only for the untouched proof and never written. Stops on any
 * Ollama failure. Reports print counts only, never passage prose or names.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TRACK = 'testing/trials/booknlp';
const OUT_DIR = `${TRACK}/out`;
const JUDGE_DIR = `${TRACK}/out-judge`;
const BOOK_ID = 'chapter';
const DB_PATH = 'testing/trials/halfbook-run/plagueis-half.db';

const MODEL = 'spark-x2-q8';
const TEMP = 0;
const SEED = 42;
const N_BIND = 40;
const N_ATTR = 40;
const OLLAMA = 'http://127.0.0.1:11434';

function fail(message: string): never {
  throw new Error(`judge-sample: ${message}`);
}

function dbStat(): { size: number; mtimeMs: number } {
  const st = statSync(DB_PATH);
  return { size: st.size, mtimeMs: st.mtimeMs };
}

function assertDbUntouched(before: { size: number; mtimeMs: number }, step: string): void {
  const after = dbStat();
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    fail(`bank changed during ${step} (size/mtime moved)`);
  }
}

/** Deterministic RNG for the seed-42 sample. */
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

function shuffled<T>(rows: T[], rand: () => number): T[] {
  const out = [...rows];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function bodyRows(path: string): string[][] {
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
  const rows = lines.map((line) => line.split('\t'));
  if (rows.length && !/^-?\d+$/.test((rows[0]![0] ?? '').trim())) rows.shift();
  return rows;
}

/** Mechanical detokenize: join with spaces, glue punctuation back. */
function detok(words: string[]): string {
  return words
    .join(' ')
    .replace(/\s+([.,!?;:…%‰'’"”)\]}»])/g, '$1')
    .replace(/([(«¿¡\["“‘])/g, ' $1')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Packet {
  kind: 'binding' | 'attribution';
  id: string;
  text: string;
  candidate: string;
  evidence: string;
  refs: Record<string, number | string>;
}

function loadInputs(): {
  packets: Packet[];
} {
  const book = JSON.parse(readFileSync(`${OUT_DIR}/${BOOK_ID}.book`, 'utf8')) as {
    characters?: { id: number; mentions?: { proper?: { c: number; n: string }[] } }[];
  };
  const chars = book.characters ?? [];
  const namedIds = new Set(chars.map((c) => Number(c.id)));
  const primaryName = new Map<number, string>();
  for (const c of chars) {
    const proper = [...(c.mentions?.proper ?? [])].sort((a, b) => b.c - a.c);
    primaryName.set(Number(c.id), proper.length ? String(proper[0]!.n) : '');
  }

  // Token index: docId -> word; sentence key para\tsent -> ordered words.
  const tokRows = bodyRows(`${OUT_DIR}/${BOOK_ID}.tokens`);
  const wordOf = new Map<number, string>();
  const sentWords = new Map<string, { doc: number; word: string }[]>();
  for (const r of tokRows) {
    const para = Number(r[0]);
    const sent = Number(r[1]);
    const doc = Number(r[3]);
    const word = String(r[4] ?? '');
    if (!Number.isFinite(doc)) continue;
    wordOf.set(doc, word);
    const key = `${para}\t${sent}`;
    const list = sentWords.get(key) ?? [];
    list.push({ doc, word });
    sentWords.set(key, list);
  }
  const docSent = new Map<number, string>();
  for (const [key, list] of sentWords) {
    const text = detok(
      [...list].sort((a, b) => a.doc - b.doc).map((e) => e.word),
    );
    for (const e of list) docSent.set(e.doc, text);
  }
  void wordOf;

  const rand = mulberry32(SEED);
  const packets: Packet[] = [];

  // 40 pronoun bindings: PRON entity rows linked to a named cluster.
  const entRows = bodyRows(`${OUT_DIR}/${BOOK_ID}.entities`);
  const pronPool = entRows.filter(
    (r) =>
      (r[3] ?? '').toUpperCase() === 'PRON' &&
      namedIds.has(Number(r[0])) &&
      (primaryName.get(Number(r[0])) ?? '').length > 0,
  );
  const bindings = shuffled(pronPool, rand).slice(0, N_BIND);
  if (bindings.length < N_BIND) fail(`only ${bindings.length} linkable pronouns, need ${N_BIND}`);
  bindings.forEach((r, i) => {
    const start = Number(r[1]);
    const end = Number(r[2]);
    const evidence = docSent.get(start) ?? '';
    if (!evidence) fail(`no sentence for pronoun token ${start}`);
    packets.push({
      kind: 'binding',
      id: `b${i + 1}`,
      text: String(r[5] ?? ''),
      candidate: primaryName.get(Number(r[0])) ?? '',
      evidence,
      refs: { coref: Number(r[0]), spanStart: start, spanEnd: end },
    });
  });

  // 40 quote attributions: attributed quotes with a resolved speaker.
  const quoteRows = bodyRows(`${OUT_DIR}/${BOOK_ID}.quotes`);
  const attrPool = quoteRows.filter(
    (r) =>
      (r[4] ?? '').trim().length > 0 &&
      namedIds.has(Number(r[5])) &&
      (primaryName.get(Number(r[5])) ?? '').length > 0,
  );
  const attributions = shuffled(attrPool, rand).slice(0, N_ATTR);
  if (attributions.length < N_ATTR) fail(`only ${attributions.length} resolved attributions, need ${N_ATTR}`);
  attributions.forEach((r, i) => {
    const qStart = Number(r[0]);
    const qEnd = Number(r[1]);
    const mStart = Number(r[2]);
    const mEnd = Number(r[3]);
    // Evidence: distinct sentences overlapping the quote or mention span, capped.
    const seen = new Set<string>();
    const parts: string[] = [];
    for (let doc = Math.min(qStart, mStart); doc <= Math.max(qEnd, mEnd); doc++) {
      const sent = docSent.get(doc);
      if (sent && !seen.has(sent)) {
        seen.add(sent);
        parts.push(sent);
        if (parts.length >= 4) break;
      }
    }
    if (!parts.length) fail(`no sentence for quote ${qStart}-${qEnd}`);
    packets.push({
      kind: 'attribution',
      id: `q${i + 1}`,
      text: String(r[6] ?? ''),
      candidate: primaryName.get(Number(r[5])) ?? '',
      evidence: parts.join(' '),
      refs: { charId: Number(r[5]), quoteStart: qStart, quoteEnd: qEnd, mentionStart: mStart, mentionEnd: mEnd },
    });
  });

  return { packets };
}

export function samplePackets(): void {
  const before = dbStat();
  mkdirSync(JUDGE_DIR, { recursive: true });
  const { packets } = loadInputs();
  const bindings = packets.filter((p) => p.kind === 'binding').length;
  const attributions = packets.filter((p) => p.kind === 'attribution').length;
  if (packets.some((p) => !p.candidate)) fail('empty candidate in packets');
  writeFileSync(
    `${JUDGE_DIR}/packets.json`,
    JSON.stringify({ seed: SEED, bindings, attributions, packets }, null, 1),
  );
  console.log(`sample: seed ${SEED} bindings ${bindings} attributions ${attributions} total ${packets.length}`);
  assertDbUntouched(before, 'sample');
  console.log(`sample: bank untouched (size ${before.size})`);
}

function promptFor(packet: Packet): string {
  const shape = '{"verdict": "supported" | "refuted" | "unclear", "reason": "<at most 12 words>"}';
  if (packet.kind === 'binding') {
    return (
      `You are grading a pronoun link. Sentence: "${packet.evidence}" ` +
      `Claim: the pronoun "${packet.text}" refers to ${packet.candidate}. ` +
      `Reply with JSON only: ${shape}. ` +
      `supported = the sentence clearly supports the link; refuted = it clearly points elsewhere; ` +
      `unclear = cannot tell from this sentence alone.`
    );
  }
  return (
    `You are grading a speaker attribution. Passage: "${packet.evidence}" ` +
    `Claim: ${packet.candidate} speaks the quote "${packet.text}". ` +
    `Reply with JSON only: ${shape}. ` +
    `supported = the passage clearly supports the speaker; refuted = it clearly names another speaker; ` +
    `unclear = cannot tell from this passage alone.`
  );
}

export type Verdict = 'supported' | 'refuted' | 'unclear';

function twelveWords(reason: string): { text: string; truncated: boolean } {
  const words = String(reason ?? '').split(/\s+/).filter(Boolean);
  if (words.length <= 12) return { text: words.join(' '), truncated: false };
  return { text: words.slice(0, 12).join(' '), truncated: true };
}

async function chat(prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      think: false,
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: TEMP, seed: SEED },
      stream: false,
    }),
  });
  if (!res.ok) fail(`ollama ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return (data.message?.content ?? '').trim();
}

export async function judgePackets(): Promise<void> {
  const packetsPath = `${JUDGE_DIR}/packets.json`;
  if (!existsSync(packetsPath)) fail(`no ${packetsPath} (run sample first)`);
  const { packets } = JSON.parse(readFileSync(packetsPath, 'utf8')) as { packets: Packet[] };
  // Verify the judge is up before spending calls.
  try {
    const tags = await fetch(`${OLLAMA}/api/tags`);
    if (!tags.ok) fail(`ollama tags ${tags.status}`);
  } catch (err) {
    fail(`ollama unreachable: ${(err as Error).message}`);
  }
  const results: { id: string; kind: string; verdict: Verdict; reason: string; unparsable: boolean }[] = [];
  let n = 0;
  for (const packet of packets) {
    let raw = '';
    try {
      raw = await chat(promptFor(packet));
    } catch (err) {
      fail(`ollama call failed at packet ${packet.id}: ${(err as Error).message}`);
    }
    let verdict: Verdict = 'unclear';
    let reason = '';
    let unparsable = false;
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const obj = JSON.parse(m[0]) as { verdict?: string; reason?: string };
        const v = String(obj.verdict ?? '').toLowerCase();
        if (v === 'supported' || v === 'refuted' || v === 'unclear') verdict = v;
        else unparsable = true;
        reason = String(obj.reason ?? '');
      } catch {
        unparsable = true;
      }
    } else {
      unparsable = true;
    }
    const fixed = twelveWords(reason);
    results.push({ id: packet.id, kind: packet.kind, verdict, reason: fixed.text, unparsable });
    n++;
    if (n % 10 === 0) process.stderr.write(`${n}/${packets.length}\n`);
  }
  mkdirSync(JUDGE_DIR, { recursive: true });
  writeFileSync(
    `${JUDGE_DIR}/verdicts.json`,
    JSON.stringify(
      { model: MODEL, temp: TEMP, seed: SEED, results },
      null,
      1,
    ),
  );
  const counts = (v: Verdict): number => results.filter((r) => r.verdict === v).length;
  console.log(
    `judge: model ${MODEL} temp ${TEMP} seed ${SEED} n ${results.length} ` +
      `supported ${counts('supported')} refuted ${counts('refuted')} unclear ${counts('unclear')} ` +
      `unparsable ${results.filter((r) => r.unparsable).length}`,
  );
}

/** Wilson 95% interval for k/n. */
export function wilson(k: number, n: number, z = 1.96): { p: number; lo: number; hi: number } {
  if (n === 0) return { p: 0, lo: 0, hi: 0 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  const round3 = (x: number): number => Number(x.toFixed(3));
  return { p: round3(p), lo: round3(Math.max(0, center - half)), hi: round3(Math.min(1, center + half)) };
}

export function scoreVerdicts(): Record<string, unknown> {
  const before = dbStat();
  const packetsPath = `${JUDGE_DIR}/packets.json`;
  const verdictsPath = `${JUDGE_DIR}/verdicts.json`;
  if (!existsSync(packetsPath) || !existsSync(verdictsPath)) fail('need packets.json and verdicts.json (run sample+judge first)');
  const { packets } = JSON.parse(readFileSync(packetsPath, 'utf8')) as { packets: Packet[] };
  const { results } = JSON.parse(readFileSync(verdictsPath, 'utf8')) as {
    results: { id: string; kind: string; verdict: Verdict }[];
  };
  if (results.length !== packets.length) fail(`verdict/packet count mismatch ${results.length}/${packets.length}`);
  const byId = new Map(results.map((r) => [r.id, r.verdict]));
  for (const p of packets) {
    if (!byId.has(p.id)) fail(`no verdict for packet ${p.id}`);
  }
  const split = (kind: string): { n: number; supported: number; refuted: number; unclear: number } => {
    const rows = results.filter((r) => r.kind === kind);
    return {
      n: rows.length,
      supported: rows.filter((r) => r.verdict === 'supported').length,
      refuted: rows.filter((r) => r.verdict === 'refuted').length,
      unclear: rows.filter((r) => r.verdict === 'unclear').length,
    };
  };
  const bindings = split('binding');
  const attributions = split('attribution');
  const n = results.length;
  const supported = results.filter((r) => r.verdict === 'supported').length;
  const refuted = results.filter((r) => r.verdict === 'refuted').length;
  const unclear = results.filter((r) => r.verdict === 'unclear').length;
  const overall = wilson(supported, n);
  const manifest = {
    model: MODEL,
    temp: TEMP,
    seed: SEED,
    n,
    supported,
    refuted,
    unclear,
    precision: overall.p,
    wilsonLow: overall.lo,
    wilsonHigh: overall.hi,
    splits: {
      bindings: { ...bindings, ...wilson(bindings.supported, bindings.n) },
      attributions: { ...attributions, ...wilson(attributions.supported, attributions.n) },
    },
    reviewStatus: 'Outputs stay candidates — NOTHING banks here',
  };
  writeFileSync(`${JUDGE_DIR}/manifest.json`, JSON.stringify(manifest, null, 1));
  assertDbUntouched(before, 'score');
  console.log(
    `score: n ${n} supported ${supported} refuted ${refuted} unclear ${unclear} ` +
      `precision ${overall.p} (95% ${overall.lo}-${overall.hi})`,
  );
  console.log(
    `score: bindings ${bindings.supported}/${bindings.n} attributions ${attributions.supported}/${attributions.n}`,
  );
  console.log(`score: bank untouched (size ${before.size}); manifest ${JUDGE_DIR}/manifest.json`);
  console.log('Outputs stay candidates — NOTHING banks here');
  return manifest;
}

async function main(argv: string[]): Promise<void> {
  const step = argv[0] ?? 'all';
  if (step === 'sample') samplePackets();
  else if (step === 'judge') await judgePackets();
  else if (step === 'score') scoreVerdicts();
  else if (step === 'all') {
    samplePackets();
    await judgePackets();
    scoreVerdicts();
  } else fail(`unknown step "${step}" (sample|judge|score|all)`);
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('judge-sample.ts')) {
  main(process.argv.slice(2)).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
