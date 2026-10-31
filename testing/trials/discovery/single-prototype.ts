/**
 * SINGLE-track prototype: single-sentence evidence enumeration in winning
 * strata only (trial-only, no bank writes).
 *
 * Reads the D4 follow-up list (<followup.csv>, already in rank order) and, for
 * each follow-up pair, scans its shared chunks sentence by sentence, keeping
 * sentences that name BOTH endpoints via derived variants. No tie-phrase
 * filter at this stage: the independent judge decides quotability afterwards.
 * Mechanical only: no model, no verdicts. Counts only on stdout.
 *
 * Matcher path reused from pair-threads.ts / scanSentenceCandidates
 * (lorebook.ts): roster index over every entity plus full text, derived
 * variants, exact contiguous token-sequence match, nested-identity refusal.
 * Ranking: closest mentions first (minimal covering token span), then
 * earliest seq. The sort is total, so selection is deterministic with no
 * shuffling and no seed. Reruns with the same inputs are byte-identical.
 *
 * DB safety: the <db-copy> argument MUST be a disposable copy under the OS
 * temp dir, never a live bank — opening a bank runs migrations/tidy writes,
 * so any other path fails closed. This script itself issues only SELECTs
 * after open. Rollback is deleting the out dir.
 *
 * Usage:
 *   node --no-warnings testing/trials/discovery/single-prototype.ts <db-copy> <project> <followup.csv> [out-dir] [per-pair-cap=3]
 *
 * Out dir defaults to <followup-dir>/single. Writes single-candidates.csv
 * (fid,pair,stratum,sentence,locator,chunk,seq,span_tokens) +
 * single-packets.md (one section per fid present in the CSV, candidate
 * sentences + exact locators + the identical A/B/C/D rubric).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Db, strList } from '../../../fanfable/src/core/db.ts';
import { buildRosterIndex, canonicalName, deriveNameVariants } from '../../../fanfable/src/identity/names.ts';
import { splitSentences } from '../../../fanfable/src/core/text.ts';
import { csvCell, parseCsv } from './allocate-followup.ts';
import { JUDGE_BLOCK, findLeakage } from './sample-followup.ts';

export const DEFAULT_CAP = 3;
/** Cap increases need explicit user approval. */
export const MAX_CAP = 3;

export interface Mention {
  start: number;
  end: number;
}

/** Exact contiguous token-sequence matches, same predicate as the threads. */
export function positions(tokens: string[], target: string[]): number[] {
  const at: number[] = [];
  if (!target.length) return at;
  for (let i = 0; i + target.length <= tokens.length; i++) {
    if (target.every((word, k) => tokens[i + k] === word)) at.push(i);
  }
  return at;
}

/**
 * One canonical name nesting contiguously inside the other: one person the
 * bank split, never a pair. Same predicate as pair-threads.ts.
 */
export function nests(short: string[], long: string[]): boolean {
  return (
    short.length > 0 &&
    short.length < long.length &&
    long.some((_, at) => short.every((word, k) => long[at + k] === word))
  );
}

/** Every variant match span of one endpoint in a tokenised sentence. */
export function mentions(tokens: string[], variants: string[][]): Mention[] {
  return variants.flatMap((variant) =>
    positions(tokens, variant).map((start) => ({ start, end: start + variant.length - 1 })),
  );
}

export interface SentenceHit {
  /** Minimal covering token span from first to last mention (scan distance). */
  span: number;
}

/**
 * Both-names test for one sentence. Variants are precomputed token arrays
 * (db-free, unit-testable). Returns the closest covering span, or null when
 * either endpoint is unnamed. No tie-phrase requirement at this stage.
 */
export function analyzeSentence(sentence: string, variantsA: string[][], variantsB: string[][]): SentenceHit | null {
  const tokens = canonicalName(sentence).split(' ').filter(Boolean);
  if (tokens.length < 2) return null;
  const atA = mentions(tokens, variantsA);
  const atB = mentions(tokens, variantsB);
  if (!atA.length || !atB.length) return null;
  let closest = Number.POSITIVE_INFINITY;
  for (const a of atA) {
    for (const b of atB) {
      const span = Math.max(a.end, b.end) - Math.min(a.start, b.start);
      if (span < closest) closest = span;
    }
  }
  return { span: closest };
}

/** Byte-verbatim sourcing: the kept sentence must occur word-for-word in its chunk. */
export function isVerbatim(source: string, sentence: string): boolean {
  return sentence.length > 0 && source.includes(sentence);
}

/**
 * Expand Windows 8.3 short-name segments (e.g. OMENGA~1) through directory
 * listings so two spellings of one location compare equal. Segments that
 * cannot be resolved stay as-is, which fails closed downstream.
 */
export function expandShortSegments(full: string): string {
  const parts = full.split(sep);
  let out = parts[0] ?? '';
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i]!;
    let use = seg;
    if (seg.includes('~')) {
      try {
        const stem = seg
          .split('~')[0]!
          .replace(/[^a-z0-9]/gi, '')
          .toUpperCase();
        const cands = readdirSync(out || sep).filter((e) =>
          e.replace(/[^a-z0-9]/gi, '').toUpperCase().startsWith(stem),
        );
        if (stem && cands.length === 1) use = cands[0]!;
      } catch {
        /* leave as-is */
      }
    }
    out = out.endsWith(sep) ? out + use : out + sep + use;
  }
  return out;
}

/** Live-bank guard: only disposable copies under the OS temp dir are opened. */
export function isTempPath(p: string): boolean {
  if (p === ':memory:') return false;
  const norm = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s);
  let root = '';
  try {
    root = norm(expandShortSegments(resolve(tmpdir())));
  } catch {
    return false;
  }
  const cands = [resolve(p)];
  try {
    if (existsSync(p)) cands.push(realpathSync(p));
  } catch {
    /* resolve-form only */
  }
  return cands.some((c) => norm(expandShortSegments(c)).startsWith(root + norm(sep)));
}

export interface RawCandidate {
  sentence: string;
  locator: string;
  chunk: number;
  seq: number;
  span: number;
  /** Sentence order within its chunk; final determinism tiebreak. */
  order: number;
}

/**
 * Rank: closest mentions first, then earliest seq, then chunk, then sentence
 * order. Total order — deterministic with no shuffling and no seed.
 */
export function rankCandidates(cands: RawCandidate[]): RawCandidate[] {
  return [...cands].sort(
    (a, b) => a.span - b.span || a.seq - b.seq || a.chunk - b.chunk || a.order - b.order,
  );
}

/** Ranked, capped, still in rank order. */
export function selectTop(cands: RawCandidate[], cap: number): RawCandidate[] {
  return rankCandidates(cands).slice(0, Math.max(0, cap));
}

export interface FidSection {
  fid: string;
  pair: string;
  stratum: string;
  cands: RawCandidate[];
}

/** One packet section per fid: candidates + exact locators, nothing else. */
export function renderFidSection(s: FidSection): string {
  const lines: string[] = [`## ${s.fid} — ${s.pair}`, ''];
  s.cands.forEach((c, i) => {
    lines.push(`### Candidate ${i + 1} — ${c.locator} (chunk ${c.chunk}, seq ${c.seq}, span ${c.span})`, '');
    lines.push(c.sentence, '');
  });
  return lines.join('\n');
}

export interface FollowupSpec {
  id: string;
  pair: string;
  stratum: string;
}

function fail(msg: string): never {
  throw new Error(msg);
}

export function main(argv: string[]): void {
  const [dbRaw, projectName, followupRaw, outRaw, capRaw] = argv;
  if (!dbRaw || !projectName || !followupRaw) {
    fail('usage: single-prototype.ts <db-copy> <project> <followup.csv> [out-dir] [per-pair-cap=3]');
  }
  const cap = capRaw === undefined ? DEFAULT_CAP : Number(capRaw);
  if (!Number.isInteger(cap) || cap < 1) fail(`bad per-pair cap "${capRaw ?? ''}": want an integer >= 1`);
  if (cap > MAX_CAP) fail(`per-pair cap ${cap} exceeds ${MAX_CAP}: cap increases need explicit user approval`);
  const dbPath = resolve(dbRaw);
  if (!isTempPath(dbPath)) {
    fail(
      `refusing live bank path "${dbRaw}": pass a disposable copy under ${tmpdir()} ` +
        `(opening a bank runs migrations/tidy writes)`,
    );
  }
  const followupPath = resolve(followupRaw);
  const outDir = resolve(outRaw ?? join(dirname(followupPath), 'single'));

  const raw = parseCsv(readFileSync(followupPath, 'utf8'));
  if (!raw.length) fail('followup.csv holds no rows');
  const seen = new Set<string>();
  const specs: FollowupSpec[] = raw.map((r, i) => {
    const id = (r.id ?? '').trim();
    const pair = (r.pair ?? '').trim();
    if (!id) fail(`followup.csv row ${i + 1}: missing id`);
    if (seen.has(id)) fail(`followup.csv: duplicate id "${id}"`);
    if (!pair.includes(' / ')) fail(`followup.csv: bad pair for id "${id}" (want "A / B")`);
    seen.add(id);
    return { id, pair, stratum: (r.stratum ?? '').trim() };
  });

  const db = new Db(dbPath);
  try {
    const project = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName);
    if (!project) fail(`no project named "${projectName}"`);
    const pid = project.id;

    const chunks = db.all<{ id: number; seq: number; locator: string; text: string }>(
      'SELECT id, seq, locator, text FROM canon_chunk WHERE project_id = ? ORDER BY source_id, seq',
      pid,
    );
    if (!chunks.length) fail('no chunks: the db copy holds no imported text for this project');
    const chunkById = new Map(chunks.map((c) => [c.id, c]));

    const allRows = db
      .all<{ name: string; aliases: string }>('SELECT name, aliases FROM canon_entity WHERE project_id = ?', pid)
      .map((row) => ({ name: row.name, aliases: strList(row.aliases) }));
    const rosterIndex = buildRosterIndex(allRows, chunks.map((c) => c.text).join(' '));
    const variantCache = new Map<string, string[][]>();
    const variantsOf = (name: string): string[][] => {
      const hit = variantCache.get(name);
      if (hit) return hit;
      const row = allRows.find((r) => r.name === name);
      const v = row
        ? deriveNameVariants(row, rosterIndex)
            .map((x) => canonicalName(x).split(' ').filter(Boolean))
            .filter((t) => t.length > 0)
        : [];
      variantCache.set(name, v);
      return v;
    };

    let refused = 0;
    let pairsEmpty = 0;
    const sections: FidSection[] = [];
    for (const spec of specs) {
      const [aName, bName] = spec.pair.split(' / ').map((s) => s.trim()) as [string, string];
      const aTokens = canonicalName(aName).split(' ').filter(Boolean);
      const bTokens = canonicalName(bName).split(' ').filter(Boolean);
      if (nests(aTokens, bTokens) || nests(bTokens, aTokens)) {
        refused++;
        continue;
      }
      const a = db.get<{ id: number }>('SELECT id FROM canon_entity WHERE project_id = ? AND name = ?', pid, aName);
      const b = db.get<{ id: number }>('SELECT id FROM canon_entity WHERE project_id = ? AND name = ?', pid, bName);
      if (!a || !b) fail(`no bank identity for pair "${spec.id}": refusing to scan an unresolved name`);
      const lo = Math.min(a.id, b.id);
      const hi = Math.max(a.id, b.id);
      const thread = db.get<{ shared_chunks: string }>(
        'SELECT shared_chunks FROM canon_pair_thread WHERE project_id = ? AND a_entity = ? AND b_entity = ?',
        pid,
        lo,
        hi,
      );
      if (!thread) fail(`no pair thread for "${spec.id}": refusing to scan a pair with no shared passage`);
      const shared = (JSON.parse(thread.shared_chunks) as number[])
        .map((cid) => chunkById.get(cid))
        .filter((c) => c !== undefined)
        .sort((x, y) => x.seq - y.seq || x.id - y.id);
      const variantsA = variantsOf(aName);
      const variantsB = variantsOf(bName);
      const found: RawCandidate[] = [];
      const seenSent = new Set<string>();
      for (const c of shared) {
        splitSentences(c.text).forEach((sentence, order) => {
          const s = sentence.trim();
          if (!s || !isVerbatim(c.text, s)) return;
          const hit = analyzeSentence(s, variantsA, variantsB);
          if (!hit) return;
          const key = `${c.id}|${s}`;
          if (seenSent.has(key)) return;
          seenSent.add(key);
          found.push({ sentence: s, locator: c.locator, chunk: c.id, seq: c.seq, span: hit.span, order });
        });
      }
      if (!found.length) {
        pairsEmpty++;
        continue;
      }
      sections.push({ fid: spec.id, pair: spec.pair, stratum: spec.stratum, cands: selectTop(found, cap) });
    }

    mkdirSync(outDir, { recursive: true });
    const csvPath = join(outDir, 'single-candidates.csv');
    const mdPath = join(outDir, 'single-packets.md');
    const lines = ['fid,pair,stratum,sentence,locator,chunk,seq,span_tokens'];
    for (const s of sections) {
      for (const c of s.cands) {
        lines.push(
          [s.fid, s.pair, s.stratum, c.sentence, c.locator, String(c.chunk), String(c.seq), String(c.span)]
            .map(csvCell)
            .join(','),
        );
      }
    }
    writeFileSync(csvPath, `${lines.join('\n')}\n`);
    const head = `# Single-sentence candidates — winning strata only\n\n${JUDGE_BLOCK}\n`;
    const body = sections.map(renderFidSection).join('\n');
    writeFileSync(mdPath, `${head}\n${body}\n`);
    const leaked = findLeakage(`${head}\n${body}\n`);
    const total = sections.reduce((n, s) => n + s.cands.length, 0);

    // Counts only on stdout — never sentences, pairs, or locators.
    console.log(`project: ${projectName}`);
    console.log(`db copy: ${dbPath}`);
    console.log(`follow-up rows: ${specs.length}, nesting-refused: ${refused}, pairs with no single-sentence hit: ${pairsEmpty}`);
    console.log(`pairs with candidates: ${sections.length}, candidates: ${total} (cap ${cap} per pair)`);
    console.log(`leakage terms in packets: ${leaked.length}${leaked.length ? ` (${leaked.join(', ')})` : ''}`);
    console.log(`wrote ${csvPath} (${total} rows)`);
    console.log(`wrote ${mdPath} (${sections.length} sections)`);
    if (leaked.length > 0) fail(`packet leakage (${leaked.join(', ')}): stopping, packets left for inspection`);
  } finally {
    db.close();
  }
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
    console.error(`single-prototype: ${(err as Error).message}`);
    process.exit(1);
  }
}
