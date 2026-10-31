/**
 * Three-way breakdown — instrument vs adapter vs signals-among-mapped.
 *
 * Trial-only, measurement only. Uses the upstream whole-book outputs and
 * separates three stages: (1) INSTRUMENT ALONE scores BookNLP against
 * itself in its own cluster namespace — no roster, no bank; (2) ADAPTER
 * counts the cluster→roster mapping funnel gate by gate (exact, alias,
 * containment, ambiguous, absent) plus the candidate-pair survival rate;
 * (3) SIGNALS AMONG MAPPED reports precision/recall only on pairs where both
 * endpoints mapped, with both denominators (reachable given mapping, total).
 * Nothing banks — measurement, verbatim.
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/booknlp/breakdown.ts
 *
 * Writes only under testing/trials/booknlp/out-book/ (gitignored; breakdown.json
 * beside manifest.json). The bank is opened read-only and never written.
 * Reports print counts only, never passage prose, quotes, or names.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from '../../../fanfable/src/core/db.ts';
import { loadIdentityContext, createResolver } from '../../../fanfable/src/identity/identity.ts';
import { bodyRows, detok, normName, pairKey } from './rel-signals.ts';

const TRACK = 'testing/trials/booknlp';
const BOOK_OUT = `${TRACK}/out-book`;
const BOOK_ID = 'book';
const DB_PATH = 'testing/trials/halfbook-run/plagueis-half.db';
const PROJECT = 'halfbook';

function fail(message: string): never {
  throw new Error(`breakdown: ${message}`);
}

function dbStat(): { main: string } {
  const st = statSync(DB_PATH);
  return { main: `${st.size}:${st.mtimeMs}` };
}

interface CharRow {
  id: number;
  mentions?: {
    proper?: { c: number; n: string }[];
    common?: { c: number; n: string }[];
    pronoun?: { c: number; n: string }[];
  };
  agent?: { w: string; i: number }[];
  patient?: { w: string; i: number }[];
}

function mentionCount(c: CharRow): number {
  const m = c.mentions ?? {};
  return (m.proper ?? []).length + (m.common ?? []).length + (m.pronoun ?? []).length;
}

export function run(): Record<string, unknown> {
  const before = dbStat();
  const book = JSON.parse(readFileSync(`${BOOK_OUT}/${BOOK_ID}.book`, 'utf8')) as {
    characters?: CharRow[];
  };
  const chars = book.characters ?? [];
  const entRows = bodyRows(`${BOOK_OUT}/${BOOK_ID}.entities`);
  const quoteRows = bodyRows(`${BOOK_OUT}/${BOOK_ID}.quotes`);
  const tokRows = bodyRows(`${BOOK_OUT}/${BOOK_ID}.tokens`);

  // ---- stage 1: instrument alone (cluster namespace, no roster, no bank)
  const multi = chars.filter((c) => mentionCount(c) > 1).length;
  const single = chars.length - multi;
  const pronTotal = entRows.filter((r) => (r[3] ?? '').toUpperCase() === 'PRON').length;
  const charIds = new Set(chars.map((c) => Number(c.id)));
  const pronLinked = entRows.filter(
    (r) => (r[3] ?? '').toUpperCase() === 'PRON' && charIds.has(Number(r[0])),
  ).length;
  const quotesAttributed = quoteRows.filter((r) => (r[4] ?? '').trim().length > 0).length;
  // Sentence index for own-namespace pairs.
  const keyOfDoc = new Map<number, string>();
  for (const r of tokRows) {
    const doc = Number(r[3]);
    if (Number.isFinite(doc)) keyOfDoc.set(doc, `${r[0]}\t${r[1]}`);
  }
  void detok;
  const multiIds = new Set(chars.filter((c) => mentionCount(c) > 1).map((c) => Number(c.id)));
  // Co-mention pairs by chain id.
  const coPairs = new Set<string>();
  {
    const sentChains = new Map<string, Set<number>>();
    for (const r of entRows) {
      const id = Number(r[0]);
      if (!charIds.has(id)) continue;
      const keys = new Set<string>();
      for (let doc = Number(r[1]); doc <= Number(r[2]); doc++) {
        const key = keyOfDoc.get(doc);
        if (key !== undefined) keys.add(key);
      }
      for (const key of keys) {
        const set = sentChains.get(key) ?? new Set<number>();
        set.add(id);
        sentChains.set(key, set);
      }
    }
    for (const ids of sentChains.values()) {
      const list = [...ids].sort((a, b) => a - b);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) coPairs.add(`${list[i]}:${list[j]}`);
      }
    }
  }
  // Exchange pairs by chain id (speaker chain -> mentioned span's chain).
  const exPairs = new Set<string>();
  for (const r of quoteRows) {
    const speaker = Number(r[5]);
    if (!charIds.has(speaker)) continue;
    const mStart = Number(r[2]);
    const mEnd = Number(r[3]);
    const owners = new Set<number>();
    for (const e of entRows) {
      if (Number(e[1]) <= mEnd && Number(e[2]) >= mStart && charIds.has(Number(e[0]))) {
        owners.add(Number(e[0]));
      }
    }
    for (const owner of owners) {
      if (owner !== speaker) exPairs.add(`${Math.min(speaker, owner)}:${Math.max(speaker, owner)}`);
    }
  }
  // Action pairs by chain id.
  const actPairs = new Set<string>();
  {
    const agents = new Map<number, Set<number>>();
    const patients = new Map<number, Set<number>>();
    for (const c of chars) {
      const id = Number(c.id);
      for (const a of c.agent ?? []) {
        const set = agents.get(a.i) ?? new Set<number>();
        set.add(id);
        agents.set(a.i, set);
      }
      for (const p of c.patient ?? []) {
        const set = patients.get(p.i) ?? new Set<number>();
        set.add(id);
        patients.set(p.i, set);
      }
    }
    for (const [verb, aSet] of agents) {
      for (const a of aSet) {
        for (const p of patients.get(verb) ?? new Set<number>()) {
          if (a !== p) actPairs.add(`${Math.min(a, p)}:${Math.max(a, p)}`);
        }
      }
    }
  }
  const ownPairs = new Set([...coPairs, ...exPairs, ...actPairs]);
  const pairKeys = [...ownPairs].map((k) => k.split(':').map(Number) as [number, number]);
  const multiMulti = pairKeys.filter(([a, b]) => multiIds.has(a) && multiIds.has(b)).length;
  const instrument = {
    clusters: chars.length,
    singletonClusters: single,
    multiMentionClusters: multi,
    pronounMentions: pronTotal,
    pronounLinked: pronLinked,
    quotes: quoteRows.length,
    quotesAttributed,
    coMentionPairs: coPairs.size,
    exchangePairs: exPairs.size,
    actionPairs: actPairs.size,
    ownPairs: ownPairs.size,
    multiMultiPairs: multiMulti,
  };

  // ---- stage 2: adapter funnel (cluster -> roster, gate by gate)
  const db = new DatabaseSync(resolve(DB_PATH), { readOnly: true });
  let adapter: Record<string, unknown>;
  let mappedPersons: Set<number>;
  try {
    const dbLike = {
      all: <T>(sql: string, ...params: unknown[]): T[] => db.prepare(sql).all(...params) as T[],
    };
    const project = db.prepare('SELECT id FROM project WHERE name = ?').get(PROJECT) as { id: number };
    const context = loadIdentityContext(dbLike as unknown as Db, project.id);
    const resolver = createResolver(context);
    const characters = context.entities.filter((e) => e.kind === 'character');
    let exact = 0;
    let alias = 0;
    let containment = 0;
    let ambiguous = 0;
    let absent = 0;
    const chainPerson = new Map<number, number[]>();
    for (const c of chars) {
      const persons = new Set<number>();
      const hows = new Set<string>();
      let bad = false;
      for (const m of c.mentions?.proper ?? []) {
        const r = resolver.resolve(String(m.n));
        if (r.status === 'resolved' && r.id !== null && characters.some((e) => e.id === r.id)) {
          persons.add(r.id);
          if (r.how) hows.add(r.how);
        } else {
          bad = true;
        }
      }
      if (!bad && persons.size === 1) {
        const how = [...hows][0]!;
        if (how === 'exact') exact++;
        else if (how === 'alias') alias++;
        else containment++;
      } else if (persons.size === 0 && !bad) {
        absent++;
      } else {
        // Mixed or multi-person chains: count the failure, keep resolved persons.
        const rel = resolver.resolve(
          String((c.mentions?.proper ?? []).map((m) => m.n).join(' ') || 'zz-no-name'),
        );
        void rel;
        if ([...persons].length > 1) ambiguous++;
        else absent++;
      }
      chainPerson.set(Number(c.id), [...persons]);
    }
    mappedPersons = new Set<number>();
    for (const persons of chainPerson.values()) {
      for (const id of persons) mappedPersons.add(id);
    }
    // Pair survival: own-namespace pairs with both endpoints mapped.
    let survived = 0;
    for (const [a, b] of pairKeys) {
      const pa = chainPerson.get(a) ?? [];
      const pb = chainPerson.get(b) ?? [];
      if (pa.length >= 1 && pb.length >= 1) survived++;
    }
    const coverage = chars.length
      ? Number(([...chainPerson.values()].filter((p) => p.length >= 1).length / chars.length).toFixed(3))
      : 0;
    adapter = {
      exact,
      alias,
      containment,
      ambiguous,
      absent,
      chainsMapped: [...chainPerson.values()].filter((p) => p.length >= 1).length,
      chainsTotal: chars.length,
      mappingCoverage: coverage,
      ownPairs: ownPairs.size,
      pairsSurvived: survived,
      pairSurvivalRate: ownPairs.size ? Number((survived / ownPairs.size).toFixed(3)) : 0,
    };
  } finally {
    db.close();
  }

  // ---- stage 3: signals among mapped (denominators reported)
  const db2 = new DatabaseSync(resolve(DB_PATH), { readOnly: true });
  let signals: Record<string, unknown>;
  try {
    const project = db2.prepare('SELECT id FROM project WHERE name = ?').get(PROJECT) as { id: number };
    const bankedAll = new Set<string>();
    for (const row of db2.prepare('SELECT from_entity, to_entity FROM canon_relation WHERE project_id = ?').all(
      project.id,
    ) as { from_entity: number; to_entity: number }[]) {
      bankedAll.add(pairKey(row.from_entity, row.to_entity));
    }
    // Mapped pairs: own-namespace pairs with both endpoints mapped to persons.
    const dbLike2 = {
      all: <T>(sql: string, ...params: unknown[]): T[] => db2.prepare(sql).all(...params) as T[],
    };
    const context = loadIdentityContext(dbLike2 as unknown as Db, project.id);
    const resolver = createResolver(context);
    const characters = context.entities.filter((e) => e.kind === 'character');
    const mapChain = (id: number): number[] => {
      const c = chars.find((x) => Number(x.id) === id);
      if (!c) return [];
      const persons = new Set<number>();
      for (const m of c.mentions?.proper ?? []) {
        const r = resolver.resolve(String(m.n));
        if (r.status === 'resolved' && r.id !== null && characters.some((e) => e.id === r.id)) {
          persons.add(r.id);
        }
      }
      return [...persons];
    };
    const mappedPairs = new Set<string>();
    for (const [a, b] of pairKeys) {
      const pa = mapChain(a);
      const pb = mapChain(b);
      for (const x of pa) {
        for (const y of pb) {
          if (x !== y) mappedPairs.add(pairKey(x, y));
        }
      }
    }
    let hits = 0;
    for (const key of mappedPairs) if (bankedAll.has(key)) hits++;
    // Reachable: banked pairs with both endpoints among mapped persons.
    const reachable = new Set<string>();
    for (const key of bankedAll) {
      const [a, b] = key.split(':').map(Number) as [number, number];
      if (mappedPersons.has(a) && mappedPersons.has(b)) reachable.add(key);
    }
    let hitsReachable = 0;
    for (const key of mappedPairs) if (reachable.has(key)) hitsReachable++;
    signals = {
      mappedPairs: mappedPairs.size,
      hits,
      precision: mappedPairs.size ? Number((hits / mappedPairs.size).toFixed(3)) : 0,
      bankedTotal: bankedAll.size,
      recallTotal: bankedAll.size ? Number((hits / bankedAll.size).toFixed(3)) : 0,
      bankedReachable: reachable.size,
      hitsReachable,
      recallReachable: reachable.size ? Number((hitsReachable / reachable.size).toFixed(3)) : 0,
    };
  } finally {
    db2.close();
  }

  const manifest = {
    instrument,
    adapter,
    signalsAmongMapped: signals,
    reviewStatus: 'Nothing banks — measurement, verbatim',
    dbUntouched: dbStat(),
    dbBefore: before,
  };
  mkdirSync(`${BOOK_OUT}`, { recursive: true });
  writeFileSync(`${BOOK_OUT}/breakdown.json`, JSON.stringify(manifest, null, 1));
  const after = dbStat();
  if (after.main !== before.main) fail('bank moved during breakdown');
  const i = instrument as Record<string, number>;
  const a = adapter as Record<string, number>;
  const s = signals as Record<string, number>;
  console.log(
    `instrument: clusters ${i.clusters} single ${i.singletonClusters} multi ${i.multiMentionClusters} ` +
      `pron ${i.pronounLinked}/${i.pronounMentions} quotes ${i.quotesAttributed}/${i.quotes} ` +
      `pairs co ${i.coMentionPairs} ex ${i.exchangePairs} act ${i.actionPairs} own ${i.ownPairs} multiMulti ${i.multiMultiPairs}`,
  );
  console.log(
    `adapter: exact ${a.exact} alias ${a.alias} containment ${a.containment} ambiguous ${a.ambiguous} absent ${a.absent} ` +
      `coverage ${a.mappingCoverage} pairSurvival ${a.pairsSurvived}/${a.ownPairs} (${a.pairSurvivalRate})`,
  );
  console.log(
    `mapped: pairs ${s.mappedPairs} hits ${s.hits} precision ${s.precision} ` +
      `recallTotal ${s.recallTotal} reachable ${s.bankedReachable} recallReachable ${s.recallReachable}`,
  );
  console.log(`bank untouched (main ${before.main})`);
  return manifest;
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('breakdown.ts')) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
