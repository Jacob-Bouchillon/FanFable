/**
 * Binding re-judge — the 20 unclear pronoun links with passage context.
 *
 * Trial-only. Reads the 20 unclear binding packet ids from
 * testing/trials/booknlp/out-judge/, rebuilds each packet with PASSAGE
 * context (the pronoun's sentence plus one sentence either side, taken from
 * the read-only bank chunks with chunk ids recorded), re-judges with
 * spark-x2-q8, and scores migration + revised binding precision. Blind rules
 * identical to the first round: the judge sees only the packet — no BookNLP
 * labels, no roster flags, no bank status, no prior verdict. Outputs stay
 * candidates — NOTHING banks here.
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/booknlp/rejudge-bindings.ts [rebuild|judge|score|all]
 *
 * Writes only under testing/trials/booknlp/out-judge2/ (gitignored). The bank
 * is opened read-only and never written. Stops on any Ollama failure. Reports
 * print counts only, never passage prose or names.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TRACK = 'testing/trials/booknlp';
const OUT_JUDGE = `${TRACK}/out-judge`;
const JUDGE2_DIR = `${TRACK}/out-judge2`;
const SELECT_JSON = `${TRACK}/select.json`;
const DB_PATH = 'testing/trials/halfbook-run/plagueis-half.db';
const PROJECT = 'halfbook';

const MODEL = 'spark-x2-q8';
const TEMP = 0;
const SEED = 42;
const OLLAMA = 'http://127.0.0.1:11434';

function fail(message: string): never {
  throw new Error(`rejudge-bindings: ${message}`);
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

const norm = (s: string): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function splitSentences(text: string): string[] {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export interface RePacket {
  kind: 'binding';
  id: string;
  text: string;
  candidate: string;
  evidence: string;
  refs: Record<string, number | string | number[]>;
}

export function rebuildPackets(): void {
  const before = dbStat();
  const packets = JSON.parse(readFileSync(`${OUT_JUDGE}/packets.json`, 'utf8')) as {
    packets: { kind: string; id: string; text: string; candidate: string; evidence: string }[];
  };
  const verdicts = JSON.parse(readFileSync(`${OUT_JUDGE}/verdicts.json`, 'utf8')) as {
    results: { id: string; kind: string; verdict: string }[];
  };
  const unclearIds = new Set(
    verdicts.results.filter((r) => r.kind === 'binding' && r.verdict === 'unclear').map((r) => r.id),
  );
  const targets = packets.packets.filter((p) => unclearIds.has(p.id));
  if (targets.length === 0) fail('no unclear bindings to re-judge');
  console.log(`rebuild: unclear binding targets ${targets.length}`);

  const sel = JSON.parse(readFileSync(SELECT_JSON, 'utf8')) as {
    pick: { seqFrom: number; seqTo: number };
  };
  const db = new DatabaseSync(resolve(DB_PATH), { readOnly: true });
  let chunks: { id: number; seq: number; text: string }[];
  try {
    const project = db.prepare('SELECT id AS id FROM project WHERE name = ?').get(PROJECT) as { id: number };
    chunks = db
      .prepare('SELECT id AS id, seq AS seq, text AS text FROM canon_chunk WHERE project_id = ? AND seq >= ? AND seq <= ? ORDER BY seq')
      .all(project.id, sel.pick.seqFrom, sel.pick.seqTo) as typeof chunks;
  } finally {
    db.close();
  }
  if (!chunks.length) fail('no chapter chunks in the bank');

  const chunkNorm = chunks.map((c) => norm(c.text));
  const rebuilt: RePacket[] = [];
  const edgeAnchors: string[] = [];
  for (const t of targets) {
    const want = norm(t.evidence);
    const wantTokens = new Set(want.split(' ').filter(Boolean));
    // Anchor: chunk whose normalized text contains the sentence, else best overlap.
    let anchor = chunks.findIndex((_, i) => chunkNorm[i]!.includes(want));
    if (anchor < 0) {
      let best = -1;
      let bestScore = 0;
      chunks.forEach((c, i) => {
        const tokens = new Set(chunkNorm[i]!.split(' ').filter(Boolean));
        let hit = 0;
        for (const tok of wantTokens) if (tokens.has(tok)) hit++;
        const score = hit / Math.max(1, wantTokens.size);
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      });
      if (bestScore < 0.5) fail(`packet ${t.id}: sentence not found in chapter chunks`);
      anchor = best;
    }
    // Sentence index inside the anchor chunk by token overlap.
    const sents = splitSentences(chunks[anchor]!.text);
    let sentIdx = -1;
    let bestOverlap = -1;
    sents.forEach((s, i) => {
      const tokens = new Set(norm(s).split(' ').filter(Boolean));
      let hit = 0;
      for (const tok of wantTokens) if (tokens.has(tok)) hit++;
      if (hit > bestOverlap) {
        bestOverlap = hit;
        sentIdx = i;
      }
    });
    if (sentIdx < 0 || bestOverlap / Math.max(1, wantTokens.size) < 0.3) {
      fail(`packet ${t.id}: anchor sentence not located in chunk seq ${chunks[anchor]!.seq}`);
    }
    // ±1 sentence, crossing into neighboring chunks at edges; record chunk ids.
    const parts: string[] = [];
    const used: number[] = [];
    const push = (chunkIdx: number, s: string): void => {
      parts.push(s);
      if (!used.includes(chunks[chunkIdx]!.id)) used.push(chunks[chunkIdx]!.id);
    };
    if (sentIdx - 1 >= 0) {
      push(anchor, sents[sentIdx - 1]!);
    } else if (anchor - 1 >= 0) {
      const prev = splitSentences(chunks[anchor - 1]!.text);
      if (prev.length) push(anchor - 1, prev[prev.length - 1]!);
      else edgeAnchors.push(t.id);
    } else {
      edgeAnchors.push(t.id);
    }
    push(anchor, sents[sentIdx]!);
    if (sentIdx + 1 < sents.length) {
      push(anchor, sents[sentIdx + 1]!);
    } else if (anchor + 1 < chunks.length) {
      const next = splitSentences(chunks[anchor + 1]!.text);
      if (next.length) push(anchor + 1, next[0]!);
      else edgeAnchors.push(t.id);
    } else {
      edgeAnchors.push(t.id);
    }
    rebuilt.push({
      kind: 'binding',
      id: t.id,
      text: t.text,
      candidate: t.candidate,
      evidence: parts.join(' '),
      refs: { chunkIds: used, anchorSeq: chunks[anchor]!.seq, sentences: parts.length },
    });
  }

  mkdirSync(JUDGE2_DIR, { recursive: true });
  writeFileSync(
    `${JUDGE2_DIR}/packets.json`,
    JSON.stringify({ context: 'passage±1', seed: SEED, n: rebuilt.length, packets: rebuilt }, null, 1),
  );
  console.log(`rebuild: packets ${rebuilt.length} edgeAnchors ${edgeAnchors.length} sentencesPerPacket 3-or-fewer`);
  assertDbUntouched(before, 'rebuild');
  console.log(`rebuild: bank untouched (size ${before.size})`);
}

function promptFor(packet: RePacket): string {
  const shape = '{"verdict": "supported" | "refuted" | "unclear", "reason": "<at most 12 words>"}';
  return (
    `You are grading a pronoun link. Passage: "${packet.evidence}" ` +
    `Claim: the pronoun "${packet.text}" refers to ${packet.candidate}. ` +
    `Reply with JSON only: ${shape}. ` +
    `supported = the passage clearly supports the link; refuted = it clearly points elsewhere; ` +
    `unclear = cannot tell from this passage alone.`
  );
}

export type Verdict = 'supported' | 'refuted' | 'unclear';

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
  const packetsPath = `${JUDGE2_DIR}/packets.json`;
  if (!existsSync(packetsPath)) fail(`no ${packetsPath} (run rebuild first)`);
  const { packets } = JSON.parse(readFileSync(packetsPath, 'utf8')) as { packets: RePacket[] };
  try {
    const tags = await fetch(`${OLLAMA}/api/tags`);
    if (!tags.ok) fail(`ollama tags ${tags.status}`);
  } catch (err) {
    fail(`ollama unreachable: ${(err as Error).message}`);
  }
  const results: { id: string; verdict: Verdict; reason: string; unparsable: boolean }[] = [];
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
    const words = reason.split(/\s+/).filter(Boolean);
    results.push({
      id: packet.id,
      verdict,
      reason: words.slice(0, 12).join(' '),
      unparsable,
    });
    n++;
    if (n % 10 === 0) process.stderr.write(`${n}/${packets.length}\n`);
  }
  writeFileSync(`${JUDGE2_DIR}/verdicts.json`, JSON.stringify({ model: MODEL, temp: TEMP, seed: SEED, results }, null, 1));
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
  const verdictsPath = `${JUDGE2_DIR}/verdicts.json`;
  if (!existsSync(verdictsPath)) fail('need verdicts.json (run rebuild+judge first)');
  const { results } = JSON.parse(readFileSync(verdictsPath, 'utf8')) as {
    results: { id: string; verdict: Verdict }[];
  };
  const supported = results.filter((r) => r.verdict === 'supported').length;
  const refuted = results.filter((r) => r.verdict === 'refuted').length;
  const unclear = results.filter((r) => r.verdict === 'unclear').length;
  // First round bindings: 8 supported of 40; the 20 unclear are re-judged here.
  const revisedSupported = 8 + supported;
  const revised = wilson(revisedSupported, 40);
  const manifest = {
    model: MODEL,
    temp: TEMP,
    seed: SEED,
    n: results.length,
    supported,
    refuted,
    unclear,
    precision: wilson(supported, results.length).p,
    context: 'passage±1',
    migration: { fromUnclear: results.length, toSupported: supported, toRefuted: refuted, stillUnclear: unclear },
    revisedBinding: { n: 40, supported: revisedSupported, precision: revised.p, wilsonLow: revised.lo, wilsonHigh: revised.hi },
    attributionRef: { n: 40, supported: 34 },
    reviewStatus: 'Outputs stay candidates — NOTHING banks here',
  };
  writeFileSync(`${JUDGE2_DIR}/manifest.json`, JSON.stringify(manifest, null, 1));
  assertDbUntouched(before, 'score');
  console.log(
    `score: migration supported ${supported} refuted ${refuted} stillUnclear ${unclear} ` +
      `revisedBinding ${revisedSupported}/40 precision ${revised.p} (95% ${revised.lo}-${revised.hi})`,
  );
  console.log(`score: bank untouched (size ${before.size}); manifest ${JUDGE2_DIR}/manifest.json`);
  console.log('Outputs stay candidates — NOTHING banks here');
  return manifest;
}

async function main(argv: string[]): Promise<void> {
  const step = argv[0] ?? 'all';
  if (step === 'rebuild') rebuildPackets();
  else if (step === 'judge') await judgePackets();
  else if (step === 'score') scoreVerdicts();
  else if (step === 'all') {
    rebuildPackets();
    await judgePackets();
    scoreVerdicts();
  } else fail(`unknown step "${step}" (rebuild|judge|score|all)`);
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('rejudge-bindings.ts')) {
  main(process.argv.slice(2)).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
