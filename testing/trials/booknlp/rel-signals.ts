/**
 * BookNLP-for-rel test — do its signals predict banked ties?
 *
 * Trial-only, read-only bank. Builds three candidate pair sets from the ran
 * chapter outputs, code-only: (1) agent→patient action pairs sharing one verb;
 * (2) quote-exchange pairs (speaker → roster person named in the quote text);
 * (3) coref co-mention pairs (two roster persons in one chain's passages, via
 * any mention kind — the weakest signal). Identity follows the bank's own
 * rules (exact, alias, guarded containment); ambiguous or absent names are
 * dropped, never guessed. Scoring is UNORDERED (the bank's threads normalize
 * pairs lo:hi while relation from/to stays as read, so direction is kept as
 * info, never as a hit condition).
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/booknlp/rel-signals.ts [pairs.json]
 *
 * The pair sheet is local scratch data (names live there, never here).
 * Writes only under testing/trials/booknlp/out-rel/ (gitignored). The bank is
 * opened read-only and never written. Reports print counts only, never
 * passage prose or names. Nothing banks — candidates for review, verbatim.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from '../../../fanfable/src/core/db.ts';
import { loadIdentityContext, createResolver } from '../../../fanfable/src/identity/identity.ts';

const TRACK = 'testing/trials/booknlp';
// Dense-fight overrides (env): same scoring code, new inputs.
const OUT_DIR = process.env.BOOKNLP_OUT ?? `${TRACK}/out`;
const REL_DIR = process.env.BOOKNLP_REL ?? `${TRACK}/out-rel`;
const BOOK_ID = process.env.BOOKNLP_ID ?? 'chapter';
const DB_PATH = 'testing/trials/halfbook-run/plagueis-half.db';
const PROJECT = 'halfbook';
const SELECT_JSON = process.env.BOOKNLP_SELECT ?? `${TRACK}/select.json`;
const RESCORE_MANIFEST = process.env.BOOKNLP_MANIFEST ?? 'manifest2.json';
const RESCORE_FULL = process.env.BOOKNLP_FULL === '1';

function fail(message: string): never {
  throw new Error(`rel-signals: ${message}`);
}

function dbStat(): { main: string; sidecars: Record<string, string> } {
  // The gate is the main file's content identity. Journal sidecars (-shm)
  // churn on any connection, even read-only, so they are recorded as info.
  const dir = resolve(DB_PATH, '..');
  const sidecars: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith('plagueis-half.db')) continue;
    const st = statSync(resolve(dir, entry));
    if (entry === 'plagueis-half.db') continue;
    sidecars[entry] = `${st.size}:${st.mtimeMs}`;
  }
  const main = statSync(DB_PATH);
  return { main: `${main.size}:${main.mtimeMs}`, sidecars };
}

function sameStats(a: ReturnType<typeof dbStat>, b: ReturnType<typeof dbStat>): boolean {
  return a.main === b.main;
}

export function detok(words: string[]): string {
  return words
    .join(' ')
    .replace(/\s+([.,!?;:…%‰'’"”)\]}»])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function bodyRows(path: string): string[][] {
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
  const rows = lines.map((line) => line.split('\t'));
  if (rows.length && !/^-?\d+$/.test((rows[0]![0] ?? '').trim())) rows.shift();
  return rows;
}

export const normName = (s: string): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Roster person named in text: token-boundary match on full name or alias. */
export function mentionedPersons(text: string, forms: { id: number; forms: string[] }[]): Set<number> {
  const padded = ` ${normName(text)} `;
  const found = new Set<number>();
  for (const entry of forms) {
    for (const form of entry.forms) {
      if (form && padded.includes(` ${form} `)) {
        found.add(entry.id);
        break;
      }
    }
  }
  return found;
}

export const pairKey = (a: number, b: number): string => `${Math.min(a, b)}:${Math.max(a, b)}`;

export interface BookChar {
  id: number;
  mentions?: { proper?: { c: number; n: string }[] };
  agent?: { w: string; i: number }[];
  patient?: { w: string; i: number }[];
}

/**
 * Chain -> banked persons under one rule. Strict (unanimous): every proper
 * name resolves cleanly to one person, else the chain feeds nothing. Loose
 * (feeder grade): every resolved person counts. Shared by the voided run and
 * every rescore so the mapping — never the scoring — is what differs.
 */
export function buildPersonMaps(
  chars: BookChar[],
  resolver: ReturnType<typeof createResolver>,
  characters: { id: number }[],
): {
  strict: Map<number, number[]>;
  loose: Map<number, number[]>;
  droppedUnmapped: number;
  droppedAmbiguous: number;
  cleanChains: number;
  voidChains: number;
} {
  const strict = new Map<number, number[]>();
  const loose = new Map<number, number[]>();
  let droppedUnmapped = 0;
  let droppedAmbiguous = 0;
  let cleanChains = 0;
  let voidChains = 0;
  for (const c of chars) {
    const persons = new Set<number>();
    let bad = false;
    for (const m of c.mentions?.proper ?? []) {
      const r = resolver.resolve(String(m.n));
      if (r.status === 'resolved' && r.id !== null && characters.some((e) => e.id === r.id)) {
        persons.add(r.id);
      } else {
        bad = true;
        if (r.status === 'ambiguous') droppedAmbiguous++;
        else droppedUnmapped++;
      }
    }
    const id = Number(c.id);
    if (!bad && persons.size === 1) {
      cleanChains++;
      strict.set(id, [...persons]);
    } else {
      voidChains++;
      strict.set(id, []);
    }
    loose.set(id, [...persons]);
  }
  return { strict, loose, droppedUnmapped, droppedAmbiguous, cleanChains, voidChains };
}

/** Set 1: agent→patient pairs sharing one verb token. */
export function buildActionPairs(chars: BookChar[], personsOf: Map<number, number[]>): { pairs: Set<string>; sharedVerbs: number } {
  const agents = new Map<number, Set<number>>();
  const patients = new Map<number, Set<number>>();
  for (const c of chars) {
    for (const person of personsOf.get(Number(c.id)) ?? []) {
      for (const a of c.agent ?? []) {
        const set = agents.get(a.i) ?? new Set<number>();
        set.add(person);
        agents.set(a.i, set);
      }
      for (const p of c.patient ?? []) {
        const set = patients.get(p.i) ?? new Set<number>();
        set.add(person);
        patients.set(p.i, set);
      }
    }
  }
  const pairs = new Set<string>();
  let sharedVerbs = 0;
  for (const [verb, aSet] of agents) {
    const pSet = patients.get(verb) ?? new Set<number>();
    for (const a of aSet) {
      for (const p of pSet) {
        if (a !== p) {
          sharedVerbs++;
          pairs.add(pairKey(a, p));
        }
      }
    }
  }
  return { pairs, sharedVerbs };
}

/** Set 2: quote-exchange pairs (speaker → roster person named in the quote). */
export function buildExchangePairs(
  quoteRows: string[][],
  personsOf: Map<number, number[]>,
  forms: { id: number; forms: string[] }[],
): Set<string> {
  const pairs = new Set<string>();
  for (const r of quoteRows) {
    for (const speaker of personsOf.get(Number(r[5])) ?? []) {
      const quote = String(r[6] ?? '');
      for (const mentioned of mentionedPersons(quote, forms)) {
        if (mentioned !== speaker) pairs.add(pairKey(speaker, mentioned));
      }
    }
  }
  return pairs;
}

/** Set 3: coref co-mention pairs (chains sharing one passage, any mention). */
export function buildCorefPairs(
  entRows: string[][],
  personsOf: Map<number, number[]>,
  keyOfDoc: Map<number, string>,
): Set<string> {
  const pairs = new Set<string>();
  const sentPersons = new Map<string, Set<number>>();
  for (const r of entRows) {
    for (const person of personsOf.get(Number(r[0])) ?? []) {
      const start = Number(r[1]);
      const end = Number(r[2]);
      const keys = new Set<string>();
      for (let doc = start; doc <= end; doc++) {
        const key = keyOfDoc.get(doc);
        if (key !== undefined) keys.add(key);
      }
      for (const key of keys) {
        const set = sentPersons.get(key) ?? new Set<number>();
        set.add(person);
        sentPersons.set(key, set);
      }
    }
  }
  for (const persons of sentPersons.values()) {
    const ids = [...persons].sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) pairs.add(pairKey(ids[i]!, ids[j]!));
    }
  }
  return pairs;
}

export function run(): Record<string, unknown> {
  const before = dbStat();
  const ro = new DatabaseSync(resolve(DB_PATH), { readOnly: true });
  // identity.ts only reads via .all; this adapter keeps the bank read-only.
  const dbLike = {
    all: <T>(sql: string, ...params: unknown[]): T[] => ro.prepare(sql).all(...params) as T[],
  };
  const all = dbLike.all;
  const one = <T>(sql: string, ...params: unknown[]): T | undefined =>
    ro.prepare(sql).get(...params) as T | undefined;
  try {
    const project = one<{ id: number }>('SELECT id FROM project WHERE name = ?', PROJECT);
    if (!project) fail(`no project ${PROJECT}`);
    const pid = project.id;
    const sel = JSON.parse(readFileSync(SELECT_JSON, 'utf8')) as { pick: { seqFrom: number; seqTo: number } };

    const context = loadIdentityContext(dbLike as unknown as Db, pid);
    const resolver = createResolver(context);
    const characters = context.entities.filter((e) => e.kind === 'character');
    const forms = characters.map((e) => {
      const aliases = Array.isArray(e.aliases) ? e.aliases.map(String) : [];
      return { id: e.id, forms: [e.name, ...aliases].map(normName).filter(Boolean) };
    });

    const book = JSON.parse(readFileSync(`${OUT_DIR}/${BOOK_ID}.book`, 'utf8')) as {
      characters?: {
        id: number;
        mentions?: { proper?: { c: number; n: string }[] };
        agent?: { w: string; i: number }[];
        patient?: { w: string; i: number }[];
      }[];
    };
    const chars = book.characters ?? [];
    const maps = buildPersonMaps(chars, resolver, characters);
    const { droppedUnmapped, droppedAmbiguous } = maps;
    const strict = maps.strict;

    // Token -> sentence text (+ key for grouping chains per passage).
    const tokRows = bodyRows(`${OUT_DIR}/${BOOK_ID}.tokens`);
    const sentOfDoc = new Map<number, string>();
    const keyOfDoc = new Map<number, string>();
    const bySent = new Map<string, { doc: number; word: string }[]>();
    for (const r of tokRows) {
      const doc = Number(r[3]);
      if (!Number.isFinite(doc)) continue;
      const key = `${r[0]}\t${r[1]}`;
      const list = bySent.get(key) ?? [];
      list.push({ doc, word: String(r[4] ?? '') });
      bySent.set(key, list);
    }
    for (const [key, list] of bySent) {
      const text = detok([...list].sort((a, b) => a.doc - b.doc).map((e) => e.word));
      for (const e of list) {
        sentOfDoc.set(e.doc, text);
        keyOfDoc.set(e.doc, key);
      }
    }

    // The three sets share builders with every rescore; only the person map
    // differs between identity rules.
    const set1 = buildActionPairs(chars, strict).pairs;
    const set2 = buildExchangePairs(bodyRows(`${OUT_DIR}/${BOOK_ID}.quotes`), strict, forms);
    const set3 = buildCorefPairs(bodyRows(`${OUT_DIR}/${BOOK_ID}.entities`), strict, keyOfDoc);

    // Bank side, same chapter range, read-only.
    const chunkSeq = new Map<number, number>();
    for (const row of all<{ id: number; seq: number }>(
      'SELECT id, seq FROM canon_chunk WHERE project_id = ?',
      pid,
    )) {
      chunkSeq.set(row.id, row.seq);
    }
    const inRange = (seq: number | undefined): boolean =>
      seq !== undefined && seq >= sel.pick.seqFrom && seq <= sel.pick.seqTo;
    const chunkIdsOf = (sourceRefs: string): number[] => {
      try {
        const refs = JSON.parse(sourceRefs || '[]') as { chunk?: unknown }[];
        return refs
          .map((ref) => Number(ref?.chunk))
          .filter((n) => Number.isFinite(n) && n > 0);
      } catch {
        return [];
      }
    };
    // Banked pairs in range: a relation row (any status) citing this chapter.
    const bankedInRange = new Set<string>();
    const bankedAll = new Set<string>();
    for (const row of all<{ from_entity: number; to_entity: number; source_refs: string }>(
      'SELECT from_entity, to_entity, source_refs FROM canon_relation WHERE project_id = ?',
      pid,
    )) {
      const key = pairKey(row.from_entity, row.to_entity);
      bankedAll.add(key);
      if (chunkIdsOf(row.source_refs).some((id) => inRange(chunkSeq.get(id)))) {
        bankedInRange.add(key);
      }
    }

    const scoreSet = (pairs: Set<string>): { n: number; hits: number; precision: number } => {
      let hits = 0;
      for (const key of pairs) if (bankedAll.has(key)) hits++;
      return { n: pairs.size, hits, precision: pairs.size ? Number((hits / pairs.size).toFixed(3)) : 0 };
    };
    const s1 = scoreSet(set1);
    const s2 = scoreSet(set2);
    const s3 = scoreSet(set3);
    const combined = new Set([...set1, ...set2, ...set3]);
    const sc = scoreSet(combined);
    const recallOf = (pairs: Set<string>): { hit: number; total: number; recall: number } => {
      let hit = 0;
      for (const key of bankedInRange) if (pairs.has(key)) hit++;
      return { hit, total: bankedInRange.size, recall: bankedInRange.size ? Number((hit / bankedInRange.size).toFixed(3)) : 0 };
    };

    // Locked-20 overlap from the local scratch sheet (counts per block only).
    const sheetPath = process.argv[2] ?? '';
    const lockedHits: Record<string, number> = {};
    let lockedResolved = 0;
    if (sheetPath && existsSync(sheetPath)) {
      const sheet = JSON.parse(readFileSync(sheetPath, 'utf8')) as {
        id: string;
        a: string;
        b: string;
        block: string;
      }[];
      const formToIds = new Map<string, number[]>();
      for (const entry of forms) {
        for (const form of entry.forms) {
          formToIds.set(form, [...(formToIds.get(form) ?? []), entry.id]);
        }
      }
      for (const pair of sheet) {
        const aIds = formToIds.get(normName(pair.a)) ?? [];
        const bIds = formToIds.get(normName(pair.b)) ?? [];
        if (aIds.length !== 1 || bIds.length !== 1) continue;
        lockedResolved++;
        if (combined.has(pairKey(aIds[0]!, bIds[0]!))) {
          lockedHits[pair.block] = (lockedHits[pair.block] ?? 0) + 1;
        }
      }
    }

    const manifest = {
      directionRule: 'scored unordered (bank threads normalize lo:hi; relation from/to stays as read)',
      range: { seqFrom: sel.pick.seqFrom, seqTo: sel.pick.seqTo },
      sets: {
        actionPairs: { ...s1, ...recallOf(set1) },
        quoteExchange: { ...s2, ...recallOf(set2) },
        corefComentions: { ...s3, ...recallOf(set3) },
        combined: { ...sc, ...recallOf(combined) },
      },
      bankedPairsInRange: bankedInRange.size,
      bankedPairsTotal: bankedAll.size,
      droppedUnmapped,
      droppedAmbiguous,
      lockedResolved,
      lockedHits,
      reviewStatus: 'Nothing banks — candidates for review, verbatim',
      dbUntouched: dbStat(),
      dbBefore: before,
    };
    mkdirSync(REL_DIR, { recursive: true });
    writeFileSync(`${REL_DIR}/manifest.json`, JSON.stringify(manifest, null, 1));
    const after = dbStat();
    if (!sameStats(after, before)) {
      fail('bank changed during scoring (size/mtime moved)');
    }
    console.log(
      `sets: action ${s1.n}/${s1.hits} exchange ${s2.n}/${s2.hits} coref ${s3.n}/${s3.hits} combined ${sc.n}/${sc.hits}`,
    );
    console.log(
      `recall: rangePairs ${bankedInRange.size} bySet action ${recallOf(set1).hit} exchange ${recallOf(set2).hit} coref ${recallOf(set3).hit} combined ${recallOf(combined).hit}`,
    );
    console.log(`locked: resolved ${lockedResolved} hits ${JSON.stringify(lockedHits)}`);
    console.log(`dropped: unmapped ${droppedUnmapped} ambiguous ${droppedAmbiguous}`);
    console.log(`bank untouched (main ${before.main}); manifest ${REL_DIR}/manifest.json`);
    console.log('Nothing banks — candidates for review, verbatim');
    return manifest;
  } finally {
    ro.close();
  }
}

/**
 * Action-set rescore under both identity rules.
 *
 * Correction record: the voided run's 0 was NOT a schema mismatch — this
 * harness always read agent[]/patient[] (see set 1 above), and the file holds
 * no actions/possessives/modifiers keys. The 0 came from unanimous identity
 * voiding 89 of 97 chains. This rescore measures the same agent→patient
 * signal under (a) unanimous identity (expect ~0) and (b) feeder-grade loose
 * mapping (expect ~1 pair from ~6 shared verbs), with identical chapter,
 * bank range, and precision/recall/locked scoring per column. Wire neither:
 * strict stays the banking rule, loose stays a measurement.
 */
export function rescoreActions(): Record<string, unknown> {
  const before = dbStat();
  const ro = new DatabaseSync(resolve(DB_PATH), { readOnly: true });
  const dbLike = {
    all: <T>(sql: string, ...params: unknown[]): T[] => ro.prepare(sql).all(...params) as T[],
  };
  try {
    const project = ro.prepare('SELECT id FROM project WHERE name = ?').get(PROJECT) as
      | { id: number }
      | undefined;
    if (!project) fail(`no project ${PROJECT}`);
    const pid = project.id;
    const sel = JSON.parse(readFileSync(SELECT_JSON, 'utf8')) as { pick: { seqFrom: number; seqTo: number } };
    const context = loadIdentityContext(dbLike as unknown as Db, pid);
    const resolver = createResolver(context);
    const characters = context.entities.filter((e) => e.kind === 'character');

    const book = JSON.parse(readFileSync(`${OUT_DIR}/${BOOK_ID}.book`, 'utf8')) as {
      characters?: {
        id: number;
        mentions?: { proper?: { c: number; n: string }[] };
        agent?: { w: string; i: number }[];
        patient?: { w: string; i: number }[];
      }[];
    };
    const chars = book.characters ?? [];
    // (a) unanimous: every proper name resolves cleanly to one person.
    const strictPersons = new Map<number, number[]>();
    // (b) loose: any resolved person counts (feeder grade).
    const loosePersons = new Map<number, number[]>();
    let voidChains = 0;
    let cleanChains = 0;
    for (const c of chars) {
      const persons = new Set<number>();
      let bad = false;
      for (const m of c.mentions?.proper ?? []) {
        const r = resolver.resolve(String(m.n));
        if (r.status === 'resolved' && r.id !== null && characters.some((e) => e.id === r.id)) {
          persons.add(r.id);
        } else {
          bad = true;
        }
      }
      const id = Number(c.id);
      if (!bad && persons.size === 1) {
        cleanChains++;
        strictPersons.set(id, [...persons]);
      } else {
        voidChains++;
      }
      if (persons.size >= 1) loosePersons.set(id, [...persons]);
    }

    const buildPairs = (personsOf: Map<number, number[]>): { pairs: Set<string>; sharedVerbs: number } => {
      const agents = new Map<number, Set<number>>();
      const patients = new Map<number, Set<number>>();
      for (const c of chars) {
        for (const person of personsOf.get(Number(c.id)) ?? []) {
          for (const a of c.agent ?? []) {
            const set = agents.get(a.i) ?? new Set<number>();
            set.add(person);
            agents.set(a.i, set);
          }
          for (const p of c.patient ?? []) {
            const set = patients.get(p.i) ?? new Set<number>();
            set.add(person);
            patients.set(p.i, set);
          }
        }
      }
      const pairs = new Set<string>();
      let sharedVerbs = 0;
      for (const [verb, aSet] of agents) {
        const pSet = patients.get(verb) ?? new Set<number>();
        for (const a of aSet) {
          for (const p of pSet) {
            if (a !== p) {
              sharedVerbs++;
              pairs.add(pairKey(a, p));
            }
          }
        }
      }
      return { pairs, sharedVerbs };
    };
    const strict = buildPairs(strictPersons);
    const loose = buildPairs(loosePersons);

    // Bank side: same range, same unordered scoring as the voided run.
    const chunkSeq = new Map<number, number>();
    for (const row of dbLike.all<{ id: number; seq: number }>(
      'SELECT id, seq FROM canon_chunk WHERE project_id = ?',
      pid,
    )) {
      chunkSeq.set(row.id, row.seq);
    }
    const bankedInRange = new Set<string>();
    const bankedAll = new Set<string>();
    for (const row of dbLike.all<{ from_entity: number; to_entity: number; source_refs: string }>(
      'SELECT from_entity, to_entity, source_refs FROM canon_relation WHERE project_id = ?',
      pid,
    )) {
      const key = pairKey(row.from_entity, row.to_entity);
      bankedAll.add(key);
      try {
        const refs = JSON.parse(row.source_refs || '[]') as { chunk?: unknown }[];
        const seqs = refs
          .map((ref) => chunkSeq.get(Number(ref?.chunk)))
          .filter((seq): seq is number => Number.isFinite(seq));
        if (seqs.some((seq) => seq >= sel.pick.seqFrom && seq <= sel.pick.seqTo)) {
          bankedInRange.add(key);
        }
      } catch {
        /* unparseable refs cite nothing */
      }
    }
    const scorePairs = (pairs: Set<string>): { n: number; hits: number; precision: number; recallHit: number } => {
      let hits = 0;
      for (const key of pairs) if (bankedAll.has(key)) hits++;
      let recallHit = 0;
      for (const key of bankedInRange) if (pairs.has(key)) recallHit++;
      return {
        n: pairs.size,
        hits,
        precision: pairs.size ? Number((hits / pairs.size).toFixed(3)) : 0,
        recallHit,
      };
    };
    const strictScore = scorePairs(strict.pairs);
    const looseScore = scorePairs(loose.pairs);

    // Locked-20 overlap per column from the local scratch sheet.
    const sheetPath = process.argv[3] ?? process.argv[2] ?? '';
    const locked = (pairs: Set<string>): { resolved: number; byBlock: Record<string, number> } => {
      const byBlock: Record<string, number> = {};
      let resolved = 0;
      if (!sheetPath || !existsSync(sheetPath)) return { resolved, byBlock };
      const sheet = JSON.parse(readFileSync(sheetPath, 'utf8')) as {
        a: string;
        b: string;
        block: string;
      }[];
      const formToIds = new Map<string, number[]>();
      for (const e of characters) {
        const aliases = Array.isArray(e.aliases) ? e.aliases.map(String) : [];
        for (const form of [e.name, ...aliases].map(normName).filter(Boolean)) {
          formToIds.set(form, [...(formToIds.get(form) ?? []), e.id]);
        }
      }
      for (const pair of sheet) {
        const aIds = formToIds.get(normName(pair.a)) ?? [];
        const bIds = formToIds.get(normName(pair.b)) ?? [];
        if (aIds.length !== 1 || bIds.length !== 1) continue;
        resolved++;
        if (pairs.has(pairKey(aIds[0]!, bIds[0]!))) {
          byBlock[pair.block] = (byBlock[pair.block] ?? 0) + 1;
        }
      }
      return { resolved, byBlock };
    };
    const strictLocked = locked(strict.pairs);
    const looseLocked = locked(loose.pairs);

    // Full three-signal columns (dense fight): the voided run's builders,
    // both identity rules. Null on the plain rescore path.
    let fullCols: Record<string, unknown> | null = null;
    if (RESCORE_FULL) {
      const quoteRows = bodyRows(`${OUT_DIR}/${BOOK_ID}.quotes`);
      const entRows = bodyRows(`${OUT_DIR}/${BOOK_ID}.entities`);
      const keyOfDoc = new Map<number, string>();
      for (const r of bodyRows(`${OUT_DIR}/${BOOK_ID}.tokens`)) {
        const doc = Number(r[3]);
        if (Number.isFinite(doc)) keyOfDoc.set(doc, `${r[0]}\t${r[1]}`);
      }
      const forms = characters.map((e) => {
        const aliases = Array.isArray(e.aliases) ? e.aliases.map(String) : [];
        return { id: e.id, forms: [e.name, ...aliases].map(normName).filter(Boolean) };
      });
      const modeCols = (personsOf: Map<number, number[]>) => {
        const action = buildActionPairs(chars, personsOf).pairs;
        const exchange = buildExchangePairs(quoteRows, personsOf, forms);
        const coref = buildCorefPairs(entRows, personsOf, keyOfDoc);
        const combined = new Set([...action, ...exchange, ...coref]);
        const col = (pairs: Set<string>) => {
          const s = scorePairs(pairs);
          const lock = locked(pairs);
          return {
            ...s,
            recallTotal: bankedInRange.size,
            lockedResolved: lock.resolved,
            lockedHits: lock.byBlock,
          };
        };
        return { action: col(action), exchange: col(exchange), coref: col(coref), combined: col(combined) };
      };
      fullCols = { unanimous: modeCols(strictPersons), loose: modeCols(loosePersons) };
    }

    const manifest = {
      correction:
        'the voided 0 was identity strictness, not a schema mismatch: this harness always read agent[]/patient[] and the file holds no other keys',
      directionRule: 'scored unordered (bank threads normalize lo:hi; relation from/to stays as read)',
      range: { seqFrom: sel.pick.seqFrom, seqTo: sel.pick.seqTo },
      gapCost: { chains: chars.length, cleanChains, voidChains },
      unanimous: {
        sharedVerbs: strict.sharedVerbs,
        ...strictScore,
        recallTotal: bankedInRange.size,
        lockedResolved: strictLocked.resolved,
        lockedHits: strictLocked.byBlock,
      },
      loose: {
        sharedVerbs: loose.sharedVerbs,
        ...looseScore,
        recallTotal: bankedInRange.size,
        lockedResolved: looseLocked.resolved,
        lockedHits: looseLocked.byBlock,
      },
      bankedPairsInRange: bankedInRange.size,
      bankedPairsTotal: bankedAll.size,
      ...(fullCols ? { modes: fullCols } : {}),
      reviewStatus: 'Nothing banks — candidates for review, verbatim',
      dbUntouched: dbStat(),
      dbBefore: before,
    };
    mkdirSync(REL_DIR, { recursive: true });
    writeFileSync(`${REL_DIR}/${RESCORE_MANIFEST}`, JSON.stringify(manifest, null, 1));
    const after = dbStat();
    if (!sameStats(after, before)) fail('bank changed during rescore (content moved)');
    console.log(
      `unanimous: chains ${cleanChains} verbs ${strict.sharedVerbs} pairs ${strictScore.n} ` +
        `precision ${strictScore.precision} recall ${strictScore.recallHit}/${bankedInRange.size} ` +
        `locked ${JSON.stringify(strictLocked.byBlock)}`,
    );
    console.log(
      `loose: verbs ${loose.sharedVerbs} pairs ${looseScore.n} ` +
        `precision ${looseScore.precision} recall ${looseScore.recallHit}/${bankedInRange.size} ` +
        `locked ${JSON.stringify(looseLocked.byBlock)}`,
    );
    console.log(`gap: void ${voidChains} of ${chars.length} chains`);
    if (fullCols) {
      for (const [mode, cols] of Object.entries(fullCols) as [string, Record<string, { n: number; hits: number; precision: number; recallHit: number }>][]) {
        console.log(
          `${mode}: action ${cols.action!.n}/${cols.action!.hits} exchange ${cols.exchange!.n}/${cols.exchange!.hits} ` +
            `coref ${cols.coref!.n}/${cols.coref!.hits} combined ${cols.combined!.n}/${cols.combined!.hits}`,
        );
      }
    }
    console.log(`bank untouched (main ${before.main}); manifest ${REL_DIR}/${RESCORE_MANIFEST}`);
    console.log('Nothing banks — candidates for review, verbatim');
    return manifest;
  } finally {
    ro.close();
  }
}

const entry = process.argv[1] ?? '';
const step = process.argv[2] ?? 'run';
if (entry.endsWith('rel-signals.ts')) {
  if (step === 'rescore') {
    rescoreActions();
  } else {
    run();
  }
}
