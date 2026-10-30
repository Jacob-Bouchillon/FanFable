/**
 * Sample unproposed co-occurring pairs into mechanical evidence packets.
 *
 * Reads the code-only pair threads, keeps pairs with no relation in either
 * direction, stratifies by co-occurrence bucket and book third, and draws a
 * deterministic (seed 42) sample of 80 with population weights. No model, no
 * verdicts, no bank writes. Counts only on stdout; passage prose goes only
 * into the packet files.
 *
 * Usage:
 *   node --no-warnings testing/trials/discovery/sample-unproposed.ts <db-path> <project-name> [out-dir]
 *
 * Out dir defaults to testing/trials/discovery/unproposed (repo root).
 * Writes packets-1.md, packets-2.md and sample.csv there.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Db } from '../../../fanfable/src/db.ts';
import { buildRosterIndex, canonicalName, deriveNameVariants } from '../../../fanfable/src/names.ts';
import { splitSentences } from '../../../fanfable/src/text.ts';

const SAMPLE_N = 80;
const SEED = 42;
const PACKET_CAP = 6;

const JUDGE_BLOCK = `Judge each pair from the passages only. Give one verdict:
- A — Supported and quotable: a lasting relationship is established by a single identifiable sentence.
- B — Supported, needs multiple sentences: the relationship is clear, but no single sentence establishes it.
- C — Not a relationship: co-occurrence, a moment, or unrelated.
- D — Indeterminate: the packet does not support a reliable verdict.
For A and B quote the sentence(s) and locator. Give a reason of 12 words or fewer for every verdict. Do not use outside knowledge.`;

/** Deterministic RNG: same seed, same sample. */
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

const csvCell = (s: string): string => {
  const t = String(s ?? '');
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

function bucketOf(n: number): string {
  if (n <= 1) return '1';
  if (n <= 3) return '2-3';
  if (n <= 9) return '4-9';
  return '10+';
}

function positions(tokens: string[], target: string[]): number[] {
  const at: number[] = [];
  if (!target.length) return at;
  for (let i = 0; i + target.length <= tokens.length; i++) {
    if (target.every((word, k) => tokens[i + k] === word)) at.push(i);
  }
  return at;
}

const [dbPath, projectName, outRaw] = process.argv.slice(2);
if (!dbPath || !projectName) {
  throw new Error('usage: sample-unproposed.ts <db-path> <project-name> [out-dir]');
}
const outDir = resolve(outRaw ?? join('testing', 'trials', 'discovery', 'unproposed'));

const db = new Db(resolve(dbPath));
try {
  const project = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName);
  if (!project) throw new Error(`no project named "${projectName}"`);
  const pid = project.id;

  const people =
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ? AND kind = 'character' AND review_status != 'quarantined'",
      pid,
    )?.n ?? 0;
  const threads =
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_pair_thread WHERE project_id = ?', pid)?.n ?? 0;
  if (!threads) {
    throw new Error('no pair threads: run "fanfable lore pair-threads --build" first');
  }

  interface ThreadRow {
    a_entity: number;
    b_entity: number;
    cooccur_count: number;
    shared_chunks: string;
    first_seq: number;
    a_name: string;
    b_name: string;
  }
  // Unproposed: no relation row between the endpoints in either direction, at any status.
  const unproposed = db.all<ThreadRow>(
    `SELECT t.a_entity, t.b_entity, t.cooccur_count, t.shared_chunks, t.first_seq,
            fa.name AS a_name, fb.name AS b_name
       FROM canon_pair_thread t
       JOIN canon_entity fa ON fa.id = t.a_entity
       JOIN canon_entity fb ON fb.id = t.b_entity
      WHERE t.project_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM canon_relation r
           WHERE r.project_id = t.project_id
             AND ((r.from_entity = t.a_entity AND r.to_entity = t.b_entity)
               OR (r.from_entity = t.b_entity AND r.to_entity = t.a_entity))
        )
      ORDER BY t.a_entity, t.b_entity`,
    pid,
  );

  const chunks = db.all<{ id: number; seq: number; locator: string; text: string }>(
    'SELECT id, seq, locator, text FROM canon_chunk WHERE project_id = ? ORDER BY source_id, seq',
    pid,
  );
  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  const bySeq = [...chunks].sort((x, y) => x.seq - y.seq);
  const maxSeq = bySeq.length ? bySeq[bySeq.length - 1]!.seq : 0;
  const thirdOf = (seq: number): number => Math.min(2, Math.floor((seq * 3) / (maxSeq + 1)));

  interface Item extends ThreadRow {
    stratum: string;
    shared: number[];
  }
  const items: Item[] = unproposed.map((t) => ({
    ...t,
    stratum: `${bucketOf(t.cooccur_count)}/t${thirdOf(t.first_seq) + 1}`,
    shared: JSON.parse(t.shared_chunks) as number[],
  }));

  // Stratify, then allocate the sample by largest remainder.
  const strata = new Map<string, Item[]>();
  for (const item of items) {
    const list = strata.get(item.stratum) ?? [];
    list.push(item);
    strata.set(item.stratum, list);
  }
  const keys = [...strata.keys()].sort();
  const popTotal = items.length;
  const targetTotal = Math.min(SAMPLE_N, popTotal);
  const quota = (pop: number): number => (pop * targetTotal) / popTotal;
  const targets = new Map<string, number>();
  {
    const base = new Map<string, number>();
    const frac: { key: string; f: number }[] = [];
    let assigned = 0;
    for (const key of keys) {
      const q = quota(strata.get(key)!.length);
      const b = Math.floor(q);
      base.set(key, b);
      frac.push({ key, f: q - b });
      assigned += b;
    }
    frac.sort((x, y) => y.f - x.f || (x.key < y.key ? -1 : 1));
    let rest = targetTotal - assigned;
    for (const { key } of frac) {
      if (rest <= 0) break;
      base.set(key, base.get(key)! + 1);
      rest--;
    }
    for (const key of keys) targets.set(key, base.get(key)!);
  }
  // Short strata contribute all they have; freed seats go to the largest
  // strata with remaining capacity, deterministically. The denominator —
  // the full population — never shrinks silently.
  const shortfalls = new Map<string, number>();
  let pool = 0;
  for (const key of keys) {
    const pop = strata.get(key)!.length;
    const want = targets.get(key)!;
    if (want > pop) {
      shortfalls.set(key, want - pop);
      pool += want - pop;
      targets.set(key, pop);
    }
  }
  while (pool > 0) {
    const open = keys
      .filter((k) => targets.get(k)! < strata.get(k)!.length)
      .sort((x, y) => strata.get(y)!.length - strata.get(x)!.length || (x < y ? -1 : 1));
    if (!open.length) break;
    targets.set(open[0]!, targets.get(open[0]!)! + 1);
    pool--;
  }

  // Draw within each stratum with one seed-42 stream, strata in stable order.
  const rand = mulberry32(SEED);
  const sampled: { item: Item; weight: number }[] = [];
  for (const key of keys) {
    const list = [...strata.get(key)!].sort((x, y) => x.a_entity - y.a_entity || x.b_entity - y.b_entity);
    const idx = list.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [idx[i], idx[j]] = [idx[j]!, idx[i]!];
    }
    const k = targets.get(key)!;
    const weight = k > 0 ? list.length / k : 0;
    for (const i of idx.slice(0, k)) sampled.push({ item: list[i]!, weight });
  }
  sampled.sort((x, y) => x.item.a_entity - y.item.a_entity || x.item.b_entity - y.item.b_entity);
  const uids = new Map<{ item: Item; weight: number }, string>();
  sampled.forEach((s, i) => uids.set(s, `U${String(i + 1).padStart(3, '0')}`));
  const uidOf = (s: { item: Item; weight: number }): string => uids.get(s)!;

  // Verify every chosen passage genuinely names both endpoints via variants.
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
  const variantTokens = (name: string): string[][] => {
    const row = allRows.find((r) => r.name === name);
    if (!row) return [];
    return deriveNameVariants(row, rosterIndex)
      .map((v) => canonicalName(v).split(' ').filter(Boolean))
      .filter((t) => t.length > 0);
  };
  const variantCache = new Map<string, string[][]>();
  const variantsOf = (name: string): string[][] => {
    const hit = variantCache.get(name);
    if (hit) return hit;
    const v = variantTokens(name);
    variantCache.set(name, v);
    return v;
  };
  let verifyMisses = 0;
  const namesPresent = (text: string, name: string): boolean => {
    const tokens = canonicalName(text).split(' ').filter(Boolean);
    return variantsOf(name).some((v) => positions(tokens, v).length > 0);
  };

  // Spread picks: earliest, latest, evenly between, capped at 6.
  const spreadPick = (shared: number[]): number[] => {
    if (shared.length <= PACKET_CAP) return shared;
    const out: number[] = [];
    for (let i = 0; i < PACKET_CAP; i++) {
      out.push(shared[Math.round((i * (shared.length - 1)) / (PACKET_CAP - 1))]!);
    }
    return [...new Set(out)];
  };

  interface Packet {
    uid: string;
    pair: string;
    blocks: {
      locator: string;
      chunkId: number;
      seq: number;
      before: string;
      beforeLocator: string;
      text: string;
      after: string;
      afterLocator: string;
    }[];
  }
  const packets: Packet[] = sampled.map((s) => {
    const uid = uidOf(s);
    const picked = spreadPick(s.item.shared);
    const blocks = picked.map((cid) => {
      const c = chunkById.get(cid)!;
      const at = bySeq.findIndex((x) => x.id === cid);
      const prev = at > 0 ? bySeq[at - 1]! : undefined;
      const next = at >= 0 && at < bySeq.length - 1 ? bySeq[at + 1]! : undefined;
      const prevSent = prev ? splitSentences(prev.text) : [];
      const nextSent = next ? splitSentences(next.text) : [];
      if (!namesPresent(c.text, s.item.a_name) || !namesPresent(c.text, s.item.b_name)) verifyMisses++;
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
    return { uid, pair: `${s.item.a_name} / ${s.item.b_name}`, blocks };
  });

  const renderPacket = (p: Packet): string => {
    const lines: string[] = [`## ${p.uid} — ${p.pair}`, ''];
    p.blocks.forEach((b, i) => {
      lines.push(`### Passage ${i + 1} — ${b.locator} (chunk ${b.chunkId}, seq ${b.seq})`, '');
      if (b.before) lines.push(`> Context before [${b.beforeLocator}]: ${b.before}`, '');
      lines.push(b.text, '');
      if (b.after) lines.push(`> Context after [${b.afterLocator}]: ${b.after}`, '');
    });
    return lines.join('\n');
  };

  mkdirSync(outDir, { recursive: true });
  const half = Math.ceil(packets.length / 2);
  // With a shortfall the split stays as even as possible; file names are stable.
  const fileA = join(outDir, 'packets-1.md');
  const fileB = join(outDir, 'packets-2.md');
  const head = (n: number, of: number): string =>
    `# Character pairs — evidence packets (part ${n} of ${of})\n\n${JUDGE_BLOCK}\n`;
  const bodyA = packets.slice(0, half).map(renderPacket).join('\n');
  const bodyB = packets.slice(half).map(renderPacket).join('\n');
  writeFileSync(fileA, `${head(1, 2)}\n${bodyA}\n`);
  writeFileSync(fileB, `${head(2, 2)}\n${bodyB}\n`);

  const csvLines = ['id,pair,stratum,pop_weight,locators'];
  sampled.forEach((s) => {
    const uid = uidOf(s);
    const locators = spreadPick(s.item.shared)
      .map((cid) => chunkById.get(cid)!.locator)
      .join(' | ');
    csvLines.push(
      [uid, `${s.item.a_name} / ${s.item.b_name}`, s.item.stratum, String(s.weight), locators]
        .map(csvCell)
        .join(','),
    );
  });
  const csvPath = join(outDir, 'sample.csv');
  writeFileSync(csvPath, `${csvLines.join('\n')}\n`);

  // Counts only on stdout — never passage prose.
  const words = chunks.reduce((n, c) => n + c.text.split(/\s+/).filter(Boolean).length, 0);
  console.log(`project: ${projectName}`);
  console.log(`people: ${people}, threads: ${threads}, unproposed population: ${popTotal}`);
  console.log(
    `chunker: fanfable/src/text.ts chunkText (maxWords 220, overlapWords 40); ` +
      `${chunks.length} chunks, avg ${(chunks.length ? words / chunks.length : 0).toFixed(1)} words`,
  );
  console.log('stratum pop sampled weight shortfall');
  for (const key of keys) {
    const pop = strata.get(key)!.length;
    const got = targets.get(key)!;
    const w = got > 0 ? pop / got : 0;
    console.log(`  ${key} ${pop} ${got} ${w.toFixed(4)} ${shortfalls.get(key) ?? 0}`);
  }
  const goalShortfall = SAMPLE_N - sampled.length;
  console.log(
    `sampled: ${sampled.length} of ${SAMPLE_N} goal from population ${popTotal}` +
      (goalShortfall > 0 ? ` (shortfall ${goalShortfall}: all available taken)` : ' (shortfall 0)'),
  );
  console.log(`verify misses: ${verifyMisses}`);
  console.log(`wrote ${fileA} (${packets.slice(0, half).length} packets)`);
  console.log(`wrote ${fileB} (${packets.slice(half).length} packets)`);
  console.log(`wrote ${csvPath} (${sampled.length} rows)`);
} finally {
  db.close();
}
