/**
 * Allocate a capped top-yield follow-up from judged Discovery 3 output.
 *
 * Trial-only: reads <sample.csv> + <verdicts-final.csv>, ranks strata by
 * weighted yield, and selects a small capped follow-up (default 24) from the
 * top-ranked strata only. No model calls, no bank writes, no verdict logic of
 * its own. Counts only on stdout; the work list goes to followup.csv and the
 * counts-only report to allocation.md, both under the out dir (local-only).
 *
 * Selection semantics: the follow-up re-judges top-yield sampled pairs under
 * identical packet + rubric conditions (a replication check), so its rows are
 * drawn from the judged sample itself. Each sampled UID appears at most once;
 * seats that exceed available rows are reported as shortfall, never filled
 * from lower strata. Reruns with the same inputs are byte-identical (seed 42);
 * fresh F-ids are assigned in rank order.
 *
 * Usage:
 *   node --no-warnings testing/trials/discovery/allocate-followup.ts <sample.csv> <verdicts-final.csv> [n=24] [out-dir]
 *
 * Out dir defaults to <sample-dir>/followup. Writes followup.csv
 * (id,pair,stratum,pop_weight,locators,reason=top-yield) + allocation.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SEED = 42;
export const DEFAULT_N = 24;
/** Follow-up samples larger than this need explicit user approval. */
export const MAX_N = 30;
/** Only the top-ranked strata receive seats. */
export const TOP_STRATA = 3;
export const REASON = 'top-yield';

export interface Interval {
  lo: number;
  hi: number;
}

/**
 * Wilson 95% interval for a proportion (z = 1.96). Same formula as
 * score-unproposed.ts, copied so this script stays dependency-free; any
 * change to the scorer's interval math must be mirrored here.
 */
export function wilson(p: number, n: number, z = 1.96): Interval {
  if (n <= 0) return { lo: 0, hi: 0 };
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/**
 * Minimal CSV reader. Same dialect as score-unproposed.ts (quoted cells,
 * doubled quotes, CR-tolerant); copied for the same reason as wilson above.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cell = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch === '\r') {
      // skip; \n handles the break
    } else {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const head = (rows.shift() ?? []).map((h) => h.trim());
  return rows
    .filter((r) => r.some((c) => c.trim().length > 0))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** CSV writer cell. Same rule as sample-unproposed.ts. */
export function csvCell(s: string): string {
  const t = String(s ?? '');
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** Deterministic RNG: same seed, same selection. Same stream as sample-unproposed.ts. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Verdict = 'A' | 'B' | 'C' | 'D';
const VERDICTS: ReadonlySet<string> = new Set(['A', 'B', 'C', 'D']);

export interface SampleRow {
  id: string;
  pair: string;
  stratum: string;
  weight: number;
  locators: string;
}

/** Parse and validate the decision sample. Throws a clean Error on bad rows. */
export function parseSample(text: string): SampleRow[] {
  const raw = parseCsv(text);
  if (!raw.length) throw new Error('sample.csv holds no rows');
  const seen = new Set<string>();
  return raw.map((r, i) => {
    const id = r.id ?? '';
    const w = Number(r.pop_weight);
    if (!id) throw new Error(`sample.csv row ${i + 1}: missing id`);
    if (seen.has(id)) throw new Error(`sample.csv: duplicate id "${id}"`);
    if (!Number.isFinite(w) || w <= 0) throw new Error(`sample.csv: bad pop_weight for id "${id}"`);
    if (!(r.stratum ?? '').trim()) throw new Error(`sample.csv: missing stratum for id "${id}"`);
    seen.add(id);
    return { id, pair: r.pair ?? id, stratum: (r.stratum ?? '').trim(), weight: w, locators: r.locators ?? '' };
  });
}

export interface Judgement {
  verdict: Verdict;
  /** Non-empty quote cells count toward the SINGLE branch; prose is never printed. */
  quote: string;
}

/**
 * Parse a final verdicts sheet. Rows for unknown sample ids are ignored and
 * counted by the caller; rows with no valid verdict mark the id unjudged.
 */
export function parseVerdicts(text: string): { judged: Map<string, Judgement>; duplicates: number } {
  const judged = new Map<string, Judgement>();
  let duplicates = 0;
  for (const r of parseCsv(text)) {
    const id = (r.id ?? '').trim();
    if (!id) continue;
    const v = (r.verdict ?? '').trim().toUpperCase();
    if (!VERDICTS.has(v)) continue;
    if (judged.has(id)) duplicates++;
    judged.set(id, { verdict: v as Verdict, quote: (r.quote ?? '').trim() });
  }
  return { judged, duplicates };
}

export interface StratumYield {
  stratum: string;
  judged: number;
  weight: number;
  counts: Record<Verdict, number>;
  wsum: Record<Verdict, number>;
  share: Record<Verdict, number>;
  shareAB: number;
  ciAB: Interval;
  ciA: Interval;
  ciB: Interval;
  ciC: Interval;
}

const zeroCounts = (): Record<Verdict, number> => ({ A: 0, B: 0, C: 0, D: 0 });

/** Weighted shares + Wilson intervals for one stratum (or the whole sample). */
export function summarize(stratum: string, rows: { weight: number; verdict: Verdict }[]): StratumYield {
  const counts = zeroCounts();
  const wsum = zeroCounts();
  let weight = 0;
  for (const r of rows) {
    counts[r.verdict]++;
    wsum[r.verdict] += r.weight;
    weight += r.weight;
  }
  const share = zeroCounts();
  (['A', 'B', 'C', 'D'] as const).forEach((v) => {
    share[v] = weight ? wsum[v] / weight : 0;
  });
  const shareAB = weight ? (wsum.A + wsum.B) / weight : 0;
  // Interval width follows the judged row count, as in the scorer.
  const n = rows.length;
  return {
    stratum,
    judged: n,
    weight,
    counts,
    wsum,
    share,
    shareAB,
    ciAB: wilson(shareAB, n),
    ciA: wilson(share.A, n),
    ciB: wilson(share.B, n),
    ciC: wilson(share.C, n),
  };
}

/**
 * Rank comparator: weighted A+B lower bound desc, then weighted A lower
 * bound desc, then stratum name asc. Total order — deterministic.
 */
export function compareStrata(a: StratumYield, b: StratumYield): number {
  return (
    b.ciAB.lo - a.ciAB.lo || b.ciA.lo - a.ciA.lo || (a.stratum < b.stratum ? -1 : a.stratum > b.stratum ? 1 : 0)
  );
}

/** Ranked copy, best yield first. */
export function rankStrata(yields: StratumYield[]): StratumYield[] {
  return [...yields].sort(compareStrata);
}

export interface SeatCand {
  stratum: string;
  weight: number;
  rows: number;
}

export interface SeatPlan {
  seats: Map<string, number>;
  shortfall: number;
}

/**
 * Largest-remainder seat allocation over the top-k ranked candidates,
 * proportional to stratum population weight. Seats are capped by available
 * rows; freed seats redistribute deterministically (fraction desc, weight
 * desc, stratum name asc) and any remainder is reported as shortfall.
 */
export function allocateSeats(cands: SeatCand[], n: number, topK: number = TOP_STRATA): SeatPlan {
  const top = cands.slice(0, Math.max(0, topK));
  const seats = new Map<string, number>();
  for (const c of top) seats.set(c.stratum, 0);
  const totalW = top.reduce((s, c) => s + c.weight, 0);
  if (!top.length || totalW <= 0 || n <= 0) return { seats, shortfall: Math.max(0, n) };
  const order = [...top]
    .map((c) => ({ c, quota: (n * c.weight) / totalW }))
    .sort((x, y) => y.quota - x.quota || y.c.weight - x.c.weight || (x.c.stratum < y.c.stratum ? -1 : 1));
  let assigned = 0;
  const frac: { stratum: string; f: number; weight: number }[] = [];
  for (const { c, quota } of order) {
    const base = Math.floor(quota);
    seats.set(c.stratum, base);
    frac.push({ stratum: c.stratum, f: quota - base, weight: c.weight });
    assigned += base;
  }
  frac.sort((x, y) => y.f - x.f || y.weight - x.weight || (x.stratum < y.stratum ? -1 : 1));
  let rest = n - assigned;
  for (const f of frac) {
    if (rest <= 0) break;
    seats.set(f.stratum, seats.get(f.stratum)! + 1);
    rest--;
  }
  // Cap by available rows; redistribute freed seats in the same priority order.
  const byStratum = new Map(top.map((c) => [c.stratum, c]));
  let pool = 0;
  for (const [s, k] of seats) {
    const cap = byStratum.get(s)!.rows;
    if (k > cap) {
      pool += k - cap;
      seats.set(s, cap);
    }
  }
  while (pool > 0) {
    const open = frac.filter((f) => seats.get(f.stratum)! < byStratum.get(f.stratum)!.rows);
    if (!open.length) break;
    seats.set(open[0]!.stratum, seats.get(open[0]!.stratum)! + 1);
    pool--;
  }
  return { seats, shortfall: pool };
}

export type Branch = 'STOP' | 'SINGLE' | 'MULTI' | 'INCONCLUSIVE';

export interface Decision {
  branch: Branch;
  /** Which threshold fired, with its measured values. */
  detail: string;
  aQuotes: number;
  requiredN: { atObserved: number; worstCase: number } | null;
}

/** Sample size for a ±halfWidth interval on a share p (normal approximation). */
export function requiredN(p: number, halfWidth = 0.05, z = 1.96): number {
  return Math.ceil(((z * z) / (halfWidth * halfWidth)) * p * (1 - p));
}

/**
 * Recommendation from the overall weighted yield. Thresholds are a reporting
 * contract, not established truth: STOP on mostly-C, SINGLE on quotable yield
 * with at least 3 verifying single-sentence quotes, MULTI on multi-sentence
 * yield while single-sentence yield stays low, else INCONCLUSIVE.
 */
export function decide(overall: StratumYield, aQuotes: number): Decision {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  if (overall.ciC.lo >= 0.8) {
    return {
      branch: 'STOP',
      detail: `weighted C lower bound ${pct(overall.ciC.lo)} >= 80%: mostly-C, skip broader machinery`,
      aQuotes,
      requiredN: null,
    };
  }
  if (overall.ciAB.hi < 0.05) {
    return {
      branch: 'STOP',
      detail: `weighted A+B upper bound ${pct(overall.ciAB.hi)} < 5%: no recoverable yield, skip broader machinery`,
      aQuotes,
      requiredN: null,
    };
  }
  if (overall.ciA.lo >= 0.05 && aQuotes >= 3) {
    return {
      branch: 'SINGLE',
      detail:
        `weighted A lower bound ${pct(overall.ciA.lo)} >= 5% with ${aQuotes} verifying ` +
        `single-sentence quotes: improve discovery toward single-sentence evidence in winning strata only`,
      aQuotes,
      requiredN: null,
    };
  }
  if (overall.ciB.lo >= 0.1 && overall.ciA.lo < 0.05) {
    return {
      branch: 'MULTI',
      detail:
        `weighted B lower bound ${pct(overall.ciB.lo)} >= 10% while A lower bound ${pct(overall.ciA.lo)} < 5%: ` +
        `prototype multi-sentence evidence only`,
      aQuotes,
      requiredN: null,
    };
  }
  return {
    branch: 'INCONCLUSIVE',
    detail:
      `no threshold fired (C lo ${pct(overall.ciC.lo)}, A+B hi ${pct(overall.ciAB.hi)}, ` +
      `A lo ${pct(overall.ciA.lo)} with ${aQuotes} quotes, B lo ${pct(overall.ciB.lo)}): no build`,
    aQuotes,
    requiredN: { atObserved: requiredN(overall.shareAB), worstCase: requiredN(0.5) },
  };
}

export interface FollowupRow {
  fid: string;
  sampleId: string;
  pair: string;
  stratum: string;
  weight: number;
  locators: string;
}

/**
 * Draw the seated rows: one seed-42 stream over strata in rank order, each
 * stratum's id-sorted rows shuffled, first k taken. Distinct UIDs by
 * construction; reruns are identical.
 */
export function selectFollowup(
  rowsByStratum: Map<string, SampleRow[]>,
  ranked: StratumYield[],
  seats: Map<string, number>,
  rand: () => number,
): FollowupRow[] {
  const out: FollowupRow[] = [];
  let k = 0;
  for (const y of ranked) {
    const take = seats.get(y.stratum) ?? 0;
    if (take <= 0) continue;
    const list = [...(rowsByStratum.get(y.stratum) ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1));
    const idx = list.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [idx[i], idx[j]] = [idx[j]!, idx[i]!];
    }
    for (const i of idx.slice(0, take)) {
      k++;
      const r = list[i]!;
      out.push({
        fid: `F${String(k).padStart(3, '0')}`,
        sampleId: r.id,
        pair: r.pair,
        stratum: r.stratum,
        weight: r.weight,
        locators: r.locators,
      });
    }
  }
  return out;
}

const pct1 = (x: number): string => `${(x * 100).toFixed(1)}%`;
const ci = (v: Interval): string => `${pct1(v.lo)}–${pct1(v.hi)}`;

/** Counts-only report. Never pair names, quotes, locators, or prose. */
export function renderAllocationMd(args: {
  sampleName: string;
  verdictsName: string;
  n: number;
  seed: number;
  topK: number;
  overall: StratumYield;
  ranked: StratumYield[];
  seats: Map<string, number>;
  shortfall: number;
  followup: FollowupRow[];
  decision: Decision;
}): string {
  const { overall, ranked, seats, followup, decision } = args;
  const L: string[] = [];
  L.push('# Discovery 4 — top-yield follow-up allocation', '');
  L.push(`sample: ${args.sampleName} (${overall.judged} judged)`);
  L.push(`verdicts: ${args.verdictsName}`);
  L.push(`follow-up cap n=${args.n}, seed=${args.seed}, top ${args.topK} strata only`, '');
  L.push('## Overall weighted yield', '');
  L.push(`share A ${pct1(overall.share.A)} (95% ${ci(overall.ciA)}), B ${pct1(overall.share.B)} (95% ${ci(overall.ciB)}),`);
  L.push(`C ${pct1(overall.share.C)} (95% ${ci(overall.ciC)}), D ${pct1(overall.share.D)};`);
  L.push(`A+B ${pct1(overall.shareAB)} (95% ${ci(overall.ciAB)}; n=${overall.judged})`, '');
  L.push('## Per-stratum weighted yield', '');
  L.push('stratum judged weight A% B% C% D% A+B% + 95% interval');
  for (const y of ranked) {
    L.push(
      `  ${y.stratum} ${y.judged} ${y.weight.toFixed(1)} ` +
        `${pct1(y.share.A)} ${pct1(y.share.B)} ${pct1(y.share.C)} ${pct1(y.share.D)} ` +
        `${pct1(y.shareAB)} [${ci(y.ciAB)}]`,
    );
  }
  L.push('', '## Ranking (A+B lower bound, then A lower bound, then stratum)', '');
  ranked.forEach((y, i) => {
    L.push(`  ${i + 1}. ${y.stratum} AB-lo ${pct1(y.ciAB.lo)} A-lo ${pct1(y.ciA.lo)}`);
  });
  L.push('', '## Allocation (largest remainder over top strata by population weight)', '');
  for (const y of ranked.slice(0, args.topK)) {
    L.push(`  ${y.stratum}: seats ${seats.get(y.stratum) ?? 0} (stratum weight ${y.weight.toFixed(1)})`);
  }
  if (args.shortfall > 0) L.push(`shortfall: ${args.shortfall} seats unfilled (strata exhausted, never backfilled below top ${args.topK})`);
  else L.push('shortfall: 0');
  L.push(`follow-up rows: ${followup.length}`, '');
  L.push(`## Decision: ${decision.branch}`, '', decision.detail, '');
  if (decision.requiredN) {
    L.push(
      `interval width on A+B share: ${(overall.ciAB.hi - overall.ciAB.lo).toFixed(3)} ` +
        `(95% ${ci(overall.ciAB)}); ` +
        `required n for 5-point precision: ~${decision.requiredN.atObserved} at observed share ` +
        `(${decision.requiredN.worstCase} worst-case p=0.5)`,
      '',
    );
  }
  L.push('## Follow-up judging cost envelope (judge runs separately; this task made zero model calls)', '');
  L.push('- model: fixed at judge time; same packet + rubric conditions as the Discovery 3 verdicts run');
  L.push('- seed 42; 1 packet per call');
  L.push(`- max calls ${Math.min(args.n + 6, MAX_N)} (follow-up rows + spares; hard ceiling ${MAX_N}, larger needs approval)`);
  L.push('- concurrency 1; one heavy job at a time; 8GB VRAM ceiling');
  L.push('- one-window smoke first; `ps` after any kill; never two extractions on one GPU', '');
  L.push(
    'Selection semantics: replication re-judging of top-yield sampled pairs; ' +
      'each sampled UID at most once; reruns byte-identical.',
    '',
  );
  return L.join('\n');
}

function fail(msg: string): never {
  throw new Error(msg);
}

export function main(argv: string[]): void {
  const [sampleRaw, verdictsRaw, nRaw, outRaw] = argv;
  if (!sampleRaw || !verdictsRaw) {
    fail('usage: allocate-followup.ts <sample.csv> <verdicts-final.csv> [n=24] [out-dir]');
  }
  const n = nRaw === undefined ? DEFAULT_N : Number(nRaw);
  if (!Number.isInteger(n) || n < 1) fail(`bad follow-up size "${nRaw ?? ''}": want an integer >= 1`);
  if (n > MAX_N) fail(`follow-up n=${n} exceeds the ${MAX_N} cap: larger samples need explicit user approval`);
  const samplePath = resolve(sampleRaw);
  const verdictsPath = resolve(verdictsRaw);
  if (!existsSync(verdictsPath)) {
    fail(
      `no final verdicts at "${verdictsRaw}": judge the sample first, then pass <verdicts-final.csv> ` +
        `(this task never invents verdicts; counts only until the scorer runs with final sheets)`,
    );
  }
  const outDir = resolve(outRaw ?? join(dirname(samplePath), 'followup'));

  const sample = parseSample(readFileSync(samplePath, 'utf8'));
  const { judged, duplicates } = parseVerdicts(readFileSync(verdictsPath, 'utf8'));
  const unknown = [...judged.keys()].filter((id) => !sample.some((r) => r.id === id)).length;
  const missing = sample.filter((r) => !judged.has(r.id));
  if (missing.length) {
    fail(
      `PENDING: ${sample.length - missing.length}/${sample.length} final verdicts filled; ` +
        `${missing.length} missing (${missing.slice(0, 10).map((r) => r.id).join(', ')}${missing.length > 10 ? ', …' : ''})`,
    );
  }

  const rowsByStratum = new Map<string, SampleRow[]>();
  for (const r of sample) {
    const list = rowsByStratum.get(r.stratum) ?? [];
    list.push(r);
    rowsByStratum.set(r.stratum, list);
  }
  const yields = [...rowsByStratum.entries()].map(([stratum, rows]) =>
    summarize(
      stratum,
      rows.map((r) => ({ weight: r.weight, verdict: judged.get(r.id)!.verdict })),
    ),
  );
  const ranked = rankStrata(yields);
  const overall = summarize(
    'overall',
    sample.map((r) => ({ weight: r.weight, verdict: judged.get(r.id)!.verdict })),
  );
  const aQuotes = sample.filter((r) => judged.get(r.id)!.verdict === 'A' && judged.get(r.id)!.quote.length > 0).length;
  const { seats, shortfall } = allocateSeats(
    ranked.map((y) => ({
      stratum: y.stratum,
      weight: y.weight,
      rows: rowsByStratum.get(y.stratum)!.length,
    })),
    n,
  );
  const followup = selectFollowup(rowsByStratum, ranked, seats, mulberry32(SEED));
  const decision = decide(overall, aQuotes);

  mkdirSync(outDir, { recursive: true });
  const csvPath = join(outDir, 'followup.csv');
  const mdPath = join(outDir, 'allocation.md');
  const lines = ['id,pair,stratum,pop_weight,locators,reason'];
  for (const f of followup) {
    lines.push(
      [f.fid, f.pair, f.stratum, String(f.weight), f.locators, REASON].map(csvCell).join(','),
    );
  }
  writeFileSync(csvPath, `${lines.join('\n')}\n`);
  writeFileSync(
    mdPath,
    renderAllocationMd({
      sampleName: basename(samplePath),
      verdictsName: basename(verdictsPath),
      n,
      seed: SEED,
      topK: TOP_STRATA,
      overall,
      ranked,
      seats,
      shortfall,
      followup,
      decision,
    }),
  );

  // Counts only on stdout — never pairs, quotes, or locators.
  console.log(`judged: ${overall.judged}/${sample.length} (duplicate verdict rows: ${duplicates}, unknown ids ignored: ${unknown})`);
  console.log('stratum judged weight A% B% C% D% A+B% [95%]');
  for (const y of ranked) {
    console.log(
      `  ${y.stratum} ${y.judged} ${y.weight.toFixed(1)} ` +
        `${pct1(y.share.A)} ${pct1(y.share.B)} ${pct1(y.share.C)} ${pct1(y.share.D)} ` +
        `${pct1(y.shareAB)} [${ci(y.ciAB)}]`,
    );
  }
  console.log(`ranking: ${ranked.map((y) => y.stratum).join(' > ')}`);
  console.log(
    `allocation (top ${TOP_STRATA}): ` +
      ranked
        .slice(0, TOP_STRATA)
        .map((y) => `${y.stratum}=${seats.get(y.stratum) ?? 0}`)
        .join(', ') +
      ` (shortfall ${shortfall})`,
  );
  console.log(`decision: ${decision.branch} — ${decision.detail}`);
  console.log(`wrote ${csvPath} (${followup.length} rows)`);
  console.log(`wrote ${mdPath}`);
}

const entry = process.argv[1];
let invoked = false;
if (entry) {
  try {
    invoked = import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    invoked = false;
  }
}
if (invoked) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`allocate-followup: ${(err as Error).message}`);
    process.exit(1);
  }
}
