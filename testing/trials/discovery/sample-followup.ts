/**
 * Build mechanical evidence packets for a Discovery 4 follow-up list.
 *
 * Reads followup.csv (id,pair,stratum,pop_weight,locators,reason) and resolves
 * each pair against the bank: same spread picks as sample-unproposed.ts
 * (earliest/latest/even, cap 6), one sentence of context either side, exact
 * locators, no bank/stratum leakage. Mechanical only: no model, no verdicts.
 * Counts only on stdout; passage prose goes only into followup-packets.md.
 *
 * DB safety: the <db> argument MUST be a disposable copy under the temp dir,
 * never a live bank — opening a bank runs migrations/tidy writes, so copy it
 * first and pass the copy. This script itself issues only SELECTs after open.
 * Rollback is deleting the out dir; the bank is never mutated by this script.
 *
 * Usage:
 *   node --no-warnings testing/trials/discovery/sample-followup.ts <db> <project> <followup.csv> [out-dir]
 *
 * Out dir defaults to <followup-dir>/packets. Writes followup-packets.md
 * (judging sheet) + followup-packets.csv (id,pair,stratum,pop_weight,locators
 * linkage in sample.csv shape, so the verdict scorer accepts it).
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Db } from '../../../fanfable/src/db.ts';
import { buildRosterIndex, canonicalName, deriveNameVariants } from '../../../fanfable/src/identity/names.ts';
import { splitSentences } from '../../../fanfable/src/text.ts';
import { csvCell, parseCsv } from './allocate-followup.ts';

const PACKET_CAP = 6;

/**
 * Judge rubric. Identical to sample-unproposed.ts by requirement (identical
 * packet + rubric conditions for the replication check); any change there
 * must be mirrored here.
 */
export const JUDGE_BLOCK = `Judge each pair from the passages only. Give one verdict:
- A — Supported and quotable: a lasting relationship is established by a single identifiable sentence.
- B — Supported, needs multiple sentences: the relationship is clear, but no single sentence establishes it.
- C — Not a relationship: co-occurrence, a moment, or unrelated.
- D — Indeterminate: the packet does not support a reliable verdict.
For A and B quote the sentence(s) and locator. Give a reason of 12 words or fewer for every verdict. Do not use outside knowledge.`;

/**
 * Leakage terms: bank/stratum/sample vocabulary that must never appear in a
 * packet. Matched case-insensitively as substrings. Rubric words (verdict,
 * relationship, passage) are packet conditions, not leakage, and stay out.
 */
export const LEAKAGE_TERMS = [
  'stratum',
  'pop_weight',
  'top-yield',
  'unproposed',
  'review_status',
  'quarantined',
  'canon_',
];

/** Terms from LEAKAGE_TERMS found in text (unique, lowercase). Empty is clean. */
export function findLeakage(text: string): string[] {
  const lower = text.toLowerCase();
  return LEAKAGE_TERMS.filter((t) => lower.includes(t));
}

/** Exact contiguous token-sequence matches, same predicate as the sampler. */
export function positions(tokens: string[], target: string[]): number[] {
  const at: number[] = [];
  if (!target.length) return at;
  for (let i = 0; i + target.length <= tokens.length; i++) {
    if (target.every((word, k) => tokens[i + k] === word)) at.push(i);
  }
  return at;
}

/**
 * Spread picks: earliest, latest, evenly between, capped at 6. Same logic as
 * sample-unproposed.ts; shared chunk lists are already in seq order.
 */
export function spreadPick(shared: number[]): number[] {
  if (shared.length <= PACKET_CAP) return [...shared];
  const out: number[] = [];
  for (let i = 0; i < PACKET_CAP; i++) {
    out.push(shared[Math.round((i * (shared.length - 1)) / (PACKET_CAP - 1))]!);
  }
  return [...new Set(out)];
}

export interface FollowupSpec {
  id: string;
  pair: string;
  stratum: string;
  weight: number;
  locators: string;
}

export interface PacketBlock {
  locator: string;
  chunkId: number;
  seq: number;
  before: string;
  beforeLocator: string;
  text: string;
  after: string;
  afterLocator: string;
}

export interface FollowupPacket {
  uid: string;
  pair: string;
  blocks: PacketBlock[];
}

/** Packet rendering. Same shape as sample-unproposed.ts: pair + passages only. */
export function renderPacket(p: FollowupPacket): string {
  const lines: string[] = [`## ${p.uid} — ${p.pair}`, ''];
  p.blocks.forEach((b, i) => {
    lines.push(`### Passage ${i + 1} — ${b.locator} (chunk ${b.chunkId}, seq ${b.seq})`, '');
    if (b.before) lines.push(`> Context before [${b.beforeLocator}]: ${b.before}`, '');
    lines.push(b.text, '');
    if (b.after) lines.push(`> Context after [${b.afterLocator}]: ${b.after}`, '');
  });
  return lines.join('\n');
}

function fail(msg: string): never {
  throw new Error(msg);
}

export function main(argv: string[]): void {
  const [dbRaw, projectName, followupRaw, outRaw] = argv;
  if (!dbRaw || !projectName || !followupRaw) {
    fail('usage: sample-followup.ts <db-copy> <project> <followup.csv> [out-dir]');
  }
  const dbPath = resolve(dbRaw);
  const followupPath = resolve(followupRaw);
  const outDir = resolve(outRaw ?? join(dirname(followupPath), 'packets'));

  const raw = parseCsv(readFileSync(followupPath, 'utf8'));
  if (!raw.length) fail('followup.csv holds no rows');
  const seen = new Set<string>();
  const specs: FollowupSpec[] = raw.map((r, i) => {
    const id = (r.id ?? '').trim();
    const pair = (r.pair ?? '').trim();
    const w = Number(r.pop_weight);
    if (!id) fail(`followup.csv row ${i + 1}: missing id`);
    if (seen.has(id)) fail(`followup.csv: duplicate id "${id}"`);
    if (!pair.includes(' / ')) fail(`followup.csv: bad pair for id "${id}" (want "A / B")`);
    if (!Number.isFinite(w) || w <= 0) fail(`followup.csv: bad pop_weight for id "${id}"`);
    seen.add(id);
    return { id, pair, stratum: (r.stratum ?? '').trim(), weight: w, locators: r.locators ?? '' };
  });

  // The caller passes a disposable copy; record which file was opened.
  const db = new Db(dbPath);
  try {
    const project = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName);
    if (!project) fail(`no project named "${projectName}"`);
    const pid = project.id;

    const chunks = db.all<{ id: number; source_id: number; seq: number; locator: string; text: string }>(
      'SELECT id, source_id, seq, locator, text FROM canon_chunk WHERE project_id = ? ORDER BY source_id, seq',
      pid,
    );
    if (!chunks.length) fail('no chunks: the db copy holds no imported text for this project');
    const chunkById = new Map(chunks.map((c) => [c.id, c]));
    const bySeq = [...chunks].sort((x, y) => x.source_id - y.source_id || x.seq - y.seq);

    // Variant verification, same path as the sampler: roster over every
    // entity plus full text, derived variants, exact contiguous match.
    const allRows = db
      .all<{ name: string; aliases: string }>('SELECT name, aliases FROM canon_entity WHERE project_id = ?', pid)
      .map((row) => {
        try {
          return { name: row.name, aliases: JSON.parse(row.aliases) as string[] };
        } catch {
          return { name: row.name, aliases: [] as string[] };
        }
      });
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
    const namesPresent = (text: string, name: string): boolean => {
      const tokens = canonicalName(text).split(' ').filter(Boolean);
      return variantsOf(name).some((v) => positions(tokens, v).length > 0);
    };

    let verifyMisses = 0;
    const packets: FollowupPacket[] = [];
    const locatorLines: string[] = [];
    for (const spec of specs) {
      const [aName, bName] = spec.pair.split(' / ').map((s) => s.trim()) as [string, string];
      const a = db.get<{ id: number }>('SELECT id FROM canon_entity WHERE project_id = ? AND name = ?', pid, aName);
      const b = db.get<{ id: number }>('SELECT id FROM canon_entity WHERE project_id = ? AND name = ?', pid, bName);
      if (!a || !b) fail(`no bank identity for pair "${spec.id}": refusing to packet an unresolved name`);
      const lo = Math.min(a.id, b.id);
      const hi = Math.max(a.id, b.id);
      const thread = db.get<{ shared_chunks: string }>(
        'SELECT shared_chunks FROM canon_pair_thread WHERE project_id = ? AND a_entity = ? AND b_entity = ?',
        pid,
        lo,
        hi,
      );
      if (!thread) fail(`no pair thread for "${spec.id}": refusing to packet a pair with no shared passage`);
      const shared = JSON.parse(thread.shared_chunks) as number[];
      const picked = spreadPick(shared);
      const blocks = picked.map((cid) => {
        const c = chunkById.get(cid);
        if (!c) fail(`stale chunk reference in pair thread for "${spec.id}": refusing to packet`);
        const at = bySeq.findIndex((x) => x.id === cid);
        const prev = at > 0 ? bySeq[at - 1]! : undefined;
        const next = at >= 0 && at < bySeq.length - 1 ? bySeq[at + 1]! : undefined;
        const prevSent = prev ? splitSentences(prev.text) : [];
        const nextSent = next ? splitSentences(next.text) : [];
        if (!namesPresent(c.text, aName) || !namesPresent(c.text, bName)) verifyMisses++;
        return {
          locator: c.locator,
          chunkId: c.id,
          seq: c.seq,
          before: prev && prevSent.length ? prevSent[prevSent.length - 1]! : '',
          beforeLocator: prev ? prev.locator : '',
          text: c.text,
          after: next && nextSent.length ? nextSent[0]! : '',
          afterLocator: next ? next.locator : '',
        };
      });
      packets.push({ uid: spec.id, pair: spec.pair, blocks });
      locatorLines.push(picked.map((cid) => chunkById.get(cid)!.locator).join(' | '));
    }

    mkdirSync(outDir, { recursive: true });
    const mdPath = join(outDir, 'followup-packets.md');
    const head = `# Follow-up pairs — evidence packets\n\n${JUDGE_BLOCK}\n`;
    const body = packets.map(renderPacket).join('\n');
    writeFileSync(mdPath, `${head}\n${body}\n`);
    const mdText = `${head}\n${body}\n`;
    const leaked = findLeakage(mdText);

    const csvPath = join(outDir, 'followup-packets.csv');
    const csvLines = ['id,pair,stratum,pop_weight,locators'];
    specs.forEach((spec, i) => {
      csvLines.push([spec.id, spec.pair, spec.stratum, String(spec.weight), locatorLines[i]!].map(csvCell).join(','));
    });
    writeFileSync(csvPath, `${csvLines.join('\n')}\n`);

    // Counts only on stdout — never passage prose.
    console.log(`project: ${projectName}`);
    console.log(`db copy: ${dbPath}`);
    console.log(`follow-up rows: ${specs.length}, packets: ${packets.length}`);
    console.log(`verify misses: ${verifyMisses}`);
    console.log(`leakage terms in packets: ${leaked.length}${leaked.length ? ` (${leaked.join(', ')})` : ''}`);
    console.log(`wrote ${mdPath} (${packets.length} packets)`);
    console.log(`wrote ${csvPath} (${specs.length} rows)`);
    if (verifyMisses > 0) fail(`${verifyMisses} packet passages do not name both endpoints: stopping, packets left for inspection`);
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
    console.error(`sample-followup: ${(err as Error).message}`);
    process.exit(1);
  }
}
