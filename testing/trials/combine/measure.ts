/**
 * Combination measurement (trial only, disposable copy, read-only source).
 *
 * Builds the web on a scratch copy of the assessed half-book snapshot, then
 * asks one question: does the combination tally surface held-aside pairs that
 * raw confidence leaves held? Counts only, never passage prose. The source
 * bank is never written; the scratch copy dies in-job.
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/combine/measure.ts [pairs.json]
 *
 * The pair sheet is local scratch data (names live there, never here).
 * Writes work.db + manifest.json under testing/trials/combine/ (gitignored).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Db } from '../../../fanfable/src/core/db.ts';
import { syncThreads } from '../../../fanfable/src/web/threads.ts';
import { backfillThreadNotes, normaliseForDedupe } from '../../../fanfable/src/web/note-ingest.ts';
import { projectMinConfidence } from '../../../fanfable/src/lorebook.ts';
import { combineScore, meetsBar, quotePairCounts, type WeakNote } from '../../../fanfable/src/core/combine.ts';

const TRACK = 'testing/trials/combine';
const SOURCE = process.env.COMBINE_SOURCE ?? '/tmp/opencode/qwen35-copy.db.attested-backup-2026-10-31T04-12-43-478Z.db';
const WORK = process.env.COMBINE_WORK ?? `${TRACK}/work.db`;
const MANIFEST = process.env.COMBINE_MANIFEST ?? `${TRACK}/manifest.json`;
const FROZEN50 = 'testing/trials/nuextract-duel/frozen50.json';
const PROJECT = 'halfbook';

/** Held-aside grades. Anything else counts as already out of the inbox. */
const HELD = new Set(['needs_review', 'provisional']);

function fail(message: string): never {
  throw new Error(`measure: ${message}`);
}

interface SheetPair {
  id: string;
  a: string;
  b: string;
  block: string;
  expect: string;
}

const normName = (s: string): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function main(): void {
  const sourceStat = statSync(SOURCE);
  mkdirSync(TRACK, { recursive: true });
  // A prebuilt copy (e.g. with feeder notes) is reused as-is; sync and
  // backfill below are idempotent, so re-running them adds nothing twice.
  if (!existsSync(WORK)) copyFileSync(SOURCE, WORK);
  const db = new Db(WORK);
  try {
    const project = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', PROJECT);
    if (!project) fail(`no project ${PROJECT}`);
    const pid = project.id;

    const sync = syncThreads(db, pid);
    const ingest = backfillThreadNotes(db, pid);
    const bar = projectMinConfidence(db, pid);

    const threads = db.all<{ id: number; kind: string; a_entity: number; b_entity: number | null }>(
      "SELECT id, kind, a_entity, b_entity FROM canon_thread WHERE project_id = ? AND status != 'dormant'",
      pid,
    );
    const pairById = new Map<number, { id: number; a_entity: number; b_entity: number }>();
    for (const t of threads) {
      if (t.kind === 'pair' && t.b_entity !== null) {
        pairById.set(t.id, { id: t.id, a_entity: t.a_entity, b_entity: t.b_entity });
      }
    }
    const pairThreads = [...pairById.values()];
    const notes = db.all<{
      id: number;
      thread_id: number;
      chunk_id: number | null;
      quote: string;
      strength: number;
      strength_source: string;
      is_context: number;
      dedupe_key: string;
    }>(
      `SELECT id, thread_id, chunk_id, quote, strength, strength_source, is_context, dedupe_key
         FROM canon_thread_note WHERE project_id = ?`,
      pid,
    );
    const byThread = new Map<number, typeof notes>();
    for (const n of notes) {
      const list = byThread.get(n.thread_id) ?? [];
      list.push(n);
      byThread.set(n.thread_id, list);
    }
    const sentences = notes.flatMap((n) => {
      const t = pairById.get(n.thread_id);
      if (!t) return [];
      return [{ sentence: normaliseForDedupe(n.quote), aEntity: t.a_entity, bEntity: t.b_entity }];
    });
    const pairCounts = quotePairCounts(sentences);

    const relations = db.all<{ from_entity: number; to_entity: number; review_status: string }>(
      'SELECT from_entity, to_entity, review_status FROM canon_relation WHERE project_id = ?',
      pid,
    );
    const statusOf = (a: number, b: number): string[] => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return relations
        .filter(
          (r) =>
            (r.from_entity === lo && r.to_entity === hi) || (r.from_entity === hi && r.to_entity === lo),
        )
        .map((r) => r.review_status);
    };

    let threadsScored = 0;
    let candidates = 0;
    let rawClears = 0;
    let damperHits = 0;
    let contributions = 0;
    let unassessedZeroed = 0;
    let contextExcluded = 0;
    const candidatePairs = new Set<string>();
    const rawPairs = new Set<string>();
    for (const t of pairThreads) {
      const list = byThread.get(t.id) ?? [];
      if (!list.length) continue;
      threadsScored++;
      for (const n of list) {
        if (n.is_context === 1) contextExcluded++;
        else if (n.strength_source !== 'assessed') unassessedZeroed++;
      }
      const weak: WeakNote[] = list.map((n) => ({
        strength: n.strength,
        assessed: n.strength_source === 'assessed',
        chunkId: n.chunk_id,
        dedupeKey: n.dedupe_key,
        pairsCited: pairCounts.get(normaliseForDedupe(n.quote)) ?? 1,
        isContext: n.is_context === 1,
        noteId: n.id,
      }));
      const out = combineScore(weak);
      contributions += out.contributions.length;
      damperHits += out.contributions.filter((c) => c.damped).length;
      const statuses = statusOf(t.a_entity, t.b_entity);
      const proven = statuses.some((s) => !HELD.has(s));
      const pairKey = `${Math.min(t.a_entity, t.b_entity)}:${Math.max(t.a_entity, t.b_entity)}`;
      const rawMax = Math.max(
        0,
        ...list.filter((n) => n.is_context !== 1 && n.strength_source === 'assessed').map((n) => n.strength),
      );
      if (proven) continue;
      if (meetsBar(out.score, bar)) {
        candidates++;
        candidatePairs.add(pairKey);
      }
      if (rawMax >= bar) {
        rawClears++;
        rawPairs.add(pairKey);
      }
    }
    const newPairs = [...candidatePairs].filter((k) => !rawPairs.has(k)).length;

    // Frozen-50: rows address bank relations by id. Counts only.
    const frozen = JSON.parse(readFileSync(FROZEN50, 'utf8')) as { id: number }[];
    let fProven = 0;
    let fCandidate = 0;
    let fRaw = 0;
    for (const row of frozen) {
      const rel = db.get<{ from_entity: number; to_entity: number; review_status: string }>(
        'SELECT from_entity, to_entity, review_status FROM canon_relation WHERE id = ?',
        row.id,
      );
      if (!rel) continue;
      if (!HELD.has(rel.review_status)) {
        fProven++;
        continue;
      }
      const pairKey = `${Math.min(rel.from_entity, rel.to_entity)}:${Math.max(rel.from_entity, rel.to_entity)}`;
      if (candidatePairs.has(pairKey)) fCandidate++;
      if (rawPairs.has(pairKey)) fRaw++;
    }

    // Locked-20: local scratch sheet. Counts per block only.
    const sheetPath = process.argv[2] ?? '';
    const locked: Record<string, { n: number; candidate: number; raw: number }> = {};
    let resolved = 0;
    let ambiguous = 0;
    let absent = 0;
    if (sheetPath && existsSync(sheetPath)) {
      const sheet = JSON.parse(readFileSync(sheetPath, 'utf8')) as SheetPair[];
      const entities = db.all<{ id: number; name: string; aliases: string }>(
        'SELECT id, name, aliases FROM canon_entity WHERE project_id = ?',
        pid,
      );
      const formToIds = new Map<string, number[]>();
      for (const e of entities) {
        let aliases: string[] = [];
        try {
          aliases = JSON.parse(e.aliases || '[]') as string[];
        } catch {
          aliases = [];
        }
        for (const f of [e.name, ...aliases].map(normName).filter(Boolean)) {
          formToIds.set(f, [...(formToIds.get(f) ?? []), e.id]);
        }
      }
      for (const pair of sheet) {
        const aIds = formToIds.get(normName(pair.a)) ?? [];
        const bIds = formToIds.get(normName(pair.b)) ?? [];
        if (!aIds.length || !bIds.length) {
          absent++;
          continue;
        }
        if (aIds.length > 1 || bIds.length > 1) {
          ambiguous++;
          continue;
        }
        resolved++;
        const key = `${Math.min(aIds[0]!, bIds[0]!)}:${Math.max(aIds[0]!, bIds[0]!)}`;
        const cell = locked[pair.block] ?? { n: 0, candidate: 0, raw: 0 };
        cell.n++;
        if (candidatePairs.has(key)) cell.candidate++;
        if (rawPairs.has(key)) cell.raw++;
        locked[pair.block] = cell;
      }
    }

    // Zero-drift: attest dry-run on the copy must match the manifest grades.
    const attest = spawnSync(
      'npm',
      ['run', '--silent', 'fanfable', '--', '--db', WORK, '--project', PROJECT, 'lore', 'attest'],
      { encoding: 'utf8' },
    );
    const attestOut = String(attest.stdout ?? '');
    const checked = attestOut.match(/checked (\d+)/)?.[1] ?? '?';
    const attested = attestOut.match(/attested (\d+)/)?.[1] ?? '?';
    const keeperTrack = attestOut.match(/keeper-track (\d+)/)?.[1] ?? '?';
    const accepted = attestOut.match(/\(accepted (\d+)\)/)?.[1] ?? '?';

    const manifest = {
      source: SOURCE,
      sourceStat: { size: sourceStat.size, mtimeMs: sourceStat.mtimeMs },
      sync: { personCreated: sync.personThreadsCreated, pairCreated: sync.pairThreadsCreated },
      ingest: {
        notes: ingest.notes,
        pairNotes: ingest.pairNotes,
        strengthSource: ingest.strengthSource,
      },
      bar,
      bank: { threadsScored, candidates, rawClears, newPairs, contributions, damperHits, unassessedZeroed, contextExcluded },
      frozen50: { n: frozen.length, proven: fProven, candidate: fCandidate, raw: fRaw },
      locked20: { resolved, ambiguous, absent, blocks: locked },
      attestDryRun: { checked: Number(checked), attested: Number(attested), keeperTrack: Number(keeperTrack), accepted: Number(accepted) },
    };
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
    console.log(
      `bank: threads ${threadsScored} candidates ${candidates} raw ${rawClears} newPairs ${newPairs} ` +
        `contrib ${contributions} damped ${damperHits} zeroed ${unassessedZeroed} ctx ${contextExcluded}`,
    );
    console.log(`frozen50: n ${frozen.length} proven ${fProven} candidate ${fCandidate} raw ${fRaw}`);
    console.log(`locked20: resolved ${resolved} ambiguous ${ambiguous} absent ${absent} ${JSON.stringify(locked)}`);
    console.log(`attest dry-run: checked ${checked} attested ${attested} accepted ${accepted} keeper-track ${keeperTrack}`);
    console.log(`manifest ${MANIFEST}`);
  } finally {
    db.close();
  }
  const after = statSync(SOURCE);
  const untouched = after.size === sourceStat.size && after.mtimeMs === sourceStat.mtimeMs;
  console.log(`source untouched: ${untouched}`);
  if (!untouched) fail('source bank moved during measurement');
}

main();
