/**
 * Coref probe judge + score — pairwise description resolution vs gold.
 *
 * Trial-only. Asks qwen3.5:9b (temp 0, seed 42, think false, constrained
 * JSON) per packet which named character a description refers to, or nobody.
 * Scores overall accuracy plus correct / wrong-character / said-nobody /
 * unparsable splits, resolvable-subset accuracy with Wilson interval,
 * hard-negative accuracy, and two no-model baselines (never-resolve and
 * token-overlap). Nothing banks — measurement, verbatim.
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/coref-probe/judge.ts [judge|score|all]
 *
 * Writes only under testing/trials/coref-probe/ (gitignored). The bank is
 * never opened. One model at a time; unload afterwards. Reports print counts
 * only, never description text, names, or passage prose.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const TRACK = 'testing/trials/coref-probe';
const QWEN = 'qwen3.5:9b';
const OLLAMA = 'http://127.0.0.1:11434';
const SEED = 42;

function fail(message: string): never {
  throw new Error(`coref-probe: ${message}`);
}

function dbStat(): { main: string } {
  const st = statSync(`${process.env.HOME}/.local/share/fanfable/fanfable.db`);
  return { main: `${st.size}:${st.mtimeMs}` };
}

const norm = (s: string): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

interface Packet {
  id: string;
  doc: string;
  desc: string;
  context: string;
  candidates: string[];
}

export function parseAnswer(raw: string): string | null {
  const blocks = raw.match(/\{[^{}]*\}/g) ?? [];
  const greedy = raw.match(/\{[\s\S]*\}/)?.[0];
  if (greedy) blocks.push(greedy);
  for (const block of blocks) {
    try {
      const obj = JSON.parse(block) as { answer?: string };
      const a = String(obj.answer ?? '').trim();
      if (a) return a;
    } catch {
      /* next block */
    }
  }
  return null;
}

async function chat(prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: QWEN,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      format: 'json',
      think: false,
      options: { temperature: 0, seed: SEED },
    }),
  });
  if (!res.ok) fail(`ollama ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return (data.message?.content ?? '').trim();
}

export async function judge(): Promise<void> {
  const ps = spawnSync('ollama', ['ps'], { encoding: 'utf8' });
  const lines = String(ps.stdout ?? '').split('\n').slice(1).filter((l) => l.trim().length > 0);
  const foreign = lines.filter((l) => !l.startsWith(QWEN));
  if (foreign.length) {
    fail(`non-judge model resident (${foreign.length} row(s)) — unload first, never evict blindly`);
  }
  const { packets } = JSON.parse(readFileSync(`${TRACK}/packets.json`, 'utf8')) as { packets: Packet[] };
  try {
    const tags = await fetch(`${OLLAMA}/api/tags`);
    if (!tags.ok) fail(`ollama tags ${tags.status}`);
  } catch (err) {
    fail(`ollama unreachable: ${(err as Error).message}`);
  }
  const results: { id: string; answer: string; unparsable: boolean }[] = [];
  let n = 0;
  for (const packet of packets) {
    const prompt =
      `In this passage, which of these named characters does the description "${packet.desc}" refer to? ` +
      `Answer with exactly one name from the list, or 'nobody'. ` +
      `Passage: "${packet.context}". ` +
      `Candidates: ${packet.candidates.map((c) => `"${c}"`).join(', ')}. ` +
      `Reply with JSON only: {"answer": "<one candidate exactly as written, or nobody>"}.`;
    let raw = '';
    try {
      raw = await chat(prompt);
    } catch (err) {
      fail(`ollama call failed at packet ${packet.id}: ${(err as Error).message}`);
    }
    const answer = parseAnswer(raw);
    results.push({ id: packet.id, answer: answer ?? '', unparsable: answer === null });
    n++;
    if (n % 25 === 0) process.stderr.write(`${n}/${packets.length}\n`);
  }
  mkdirSync(TRACK, { recursive: true });
  writeFileSync(`${TRACK}/verdicts.json`, JSON.stringify({ model: QWEN, temp: 0, seed: SEED, results }, null, 1));
  console.log(`judge: n ${results.length} unparsable ${results.filter((r) => r.unparsable).length}`);
}

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'and', 'or', 'with', 'for', 'as', 'is']);

/** Trivial overlap baseline: most shared significant tokens wins, ties abstain. */
export function overlapBaseline(desc: string, candidates: string[]): string {
  const dtoks = new Set(norm(desc).split(' ').filter((t) => t.length >= 3 && !STOP.has(t)));
  let best = '';
  let bestScore = 0;
  let tied = false;
  for (const c of candidates) {
    if (norm(c) === 'nobody') continue;
    const ctoks = new Set(norm(c).split(' ').filter((t) => t.length >= 3 && !STOP.has(t)));
    let score = 0;
    for (const t of dtoks) if (ctoks.has(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = c;
      tied = false;
    } else if (score === bestScore && score > 0) {
      tied = true;
    }
  }
  return bestScore > 0 && !tied ? best : 'nobody';
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

export function score(): Record<string, unknown> {
  const { packets } = JSON.parse(readFileSync(`${TRACK}/packets.json`, 'utf8')) as { packets: Packet[] };
  const { labels } = JSON.parse(readFileSync(`${TRACK}/labels.json`, 'utf8')) as {
    labels: Record<string, string>;
  };
  const { results } = JSON.parse(readFileSync(`${TRACK}/verdicts.json`, 'utf8')) as {
    results: { id: string; answer: string; unparsable: boolean }[];
  };
  if (results.length !== packets.length) fail('verdict/packet count mismatch');
  const byPacket = new Map(packets.map((p) => [p.id, p]));
  let correct = 0;
  let wrongCharacter = 0;
  let saidNobody = 0;
  let unparsable = 0;
  let resCorrect = 0;
  let resN = 0;
  let negCorrect = 0;
  let negN = 0;
  let overlapCorrect = 0;
  for (const r of results) {
    const packet = byPacket.get(r.id)!;
    const gold = norm(labels[r.id] ?? '');
    if (r.unparsable) {
      unparsable++;
      continue;
    }
    const got = norm(r.answer);
    const ok = got === gold && got.length > 0;
    if (ok) correct++;
    else if (got === 'nobody') saidNobody++;
    else wrongCharacter++;
    const isNeg = gold === 'nobody';
    if (isNeg) {
      negN++;
      if (ok) negCorrect++;
    } else {
      resN++;
      if (ok) resCorrect++;
    }
    if (norm(overlapBaseline(packet.desc, packet.candidates)) === gold) overlapCorrect++;
  }
  const n = results.length;
  const overall = wilson(correct, n);
  const resW = wilson(resCorrect, resN);
  const negW = wilson(negCorrect, negN);
  // Never-resolve baseline: 0 correct on resolvables by construction.
  const manifest = {
    model: QWEN,
    temp: 0,
    seed: SEED,
    n,
    correct,
    wrongCharacter,
    saidNobody,
    unparsable,
    accuracy: overall.p,
    wilsonLow: overall.lo,
    wilsonHigh: overall.hi,
    resolvable: { n: resN, correct: resCorrect, ...resW },
    hardNegatives: { n: negN, correct: negCorrect, ...negW },
    neverResolve: { correct: 0, note: '0 correct on resolvables by construction' },
    overlapBaseline: { correct: overlapCorrect, accuracy: Number((overlapCorrect / n).toFixed(3)) },
    reviewStatus: 'Nothing banks — measurement, verbatim',
  };
  writeFileSync(`${TRACK}/manifest.json`, JSON.stringify(manifest, null, 1));
  console.log(
    `score: correct ${correct}/${n} accuracy ${overall.p} (${overall.lo}-${overall.hi}) ` +
      `wrongChar ${wrongCharacter} nobody ${saidNobody} unparsable ${unparsable}`,
  );
  console.log(`score: resolvable ${resCorrect}/${resN} (${resW.p}) negatives ${negCorrect}/${negN} overlap ${overlapCorrect}/${n}`);
  return manifest;
}

async function main(argv: string[]): Promise<void> {
  const step = argv[0] ?? 'all';
  if (step === 'judge') await judge();
  else if (step === 'score') score();
  else if (step === 'all') {
    await judge();
    score();
  } else fail(`unknown step "${step}"`);
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('judge.ts')) {
  main(process.argv.slice(2)).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
