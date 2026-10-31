/**
 * BookNLP finder stage — candidate pairs into the review queue, never the bank.
 *
 * Trial-only. Reads whole-book chapter outputs, builds quote-exchange and
 * co-mention candidate pairs under strict identity (exact, alias, guarded
 * containment; unmapped or ambiguous names are dropped, never guessed), and
 * writes them as pending review-queue rows on a DISPOSABLE copy only:
 * attempted_kind carries the signal (`quote-exchange` / `co-mention`, never a
 * relationship claim), reason `booknlp-candidate`, evidence a verbatim span
 * with its chunk locator. Unknown kinds park under the strict checker, so
 * candidates surface for review and can never promote. Pairs already holding
 * any relation row are skipped (the bank reviews those itself). Nothing with
 * review_status is touched; nothing banks — candidates for review, verbatim.
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/booknlp/book-candidates.ts [score|write|prove|all] [pairs.json]
 *
 * The pair sheet is local scratch data (names live there, never here).
 * Writes only under testing/trials/booknlp/out-book/ (gitignored). The source
 * bank is opened read-only and never written. Reports print counts only,
 * never passage prose or names.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Db, nowIso } from '../../../fanfable/src/core/db.ts';
import type { Db as DbType } from '../../../fanfable/src/core/db.ts';
import { loadIdentityContext, createResolver } from '../../../fanfable/src/identity/identity.ts';
import { prioritiseTieNotes } from '../../../fanfable/src/lorebook.ts';
import {
  bodyRows,
  detok,
  normName,
  pairKey,
  mentionedPersons,
  buildPersonMaps,
  buildExchangePairs,
  buildCorefPairs,
  buildActionPairs,
} from './rel-signals.ts';

const TRACK = 'testing/trials/booknlp';
const BOOK_OUT = `${TRACK}/out-book`;
const BOOK_ID = 'book';
const DB_PATH = 'testing/trials/halfbook-run/plagueis-half.db';
const PROJECT = 'halfbook';
const COPY_DB = `${BOOK_OUT}/review-copy.db`;
const MANIFEST = `${BOOK_OUT}/manifest.json`;

function fail(message: string): never {
  throw new Error(`book-candidates: ${message}`);
}

function dbStat(): { main: string } {
  const st = statSync(DB_PATH);
  return { main: `${st.size}:${st.mtimeMs}` };
}

const normSpace = (s: string): string => String(s ?? '').replace(/\s+/g, ' ').trim();

interface Loaded {
  chars: { id: number; mentions?: { proper?: { c: number; n: string }[] } }[];
  strict: Map<number, number[]>;
  clusterPersons: Map<number, number[]>;
  rosterPersons: number;
  cleanChains: number;
  voidChains: number;
  droppedUnmapped: number;
  droppedAmbiguous: number;
  forms: { id: number; forms: string[] }[];
  quoteRows: string[][];
  entRows: string[][];
  keyOfDoc: Map<number, string>;
  sentText: Map<string, string>;
}

function load(): Loaded {
  for (const ext of ['book', 'entities', 'quotes', 'tokens']) {
    if (!existsSync(`${BOOK_OUT}/${BOOK_ID}.${ext}`)) {
      fail(`missing ${BOOK_OUT}/${BOOK_ID}.${ext} (run the whole-book pipeline first)`);
    }
  }
  const db = new DatabaseSync(resolve(DB_PATH), { readOnly: true });
  try {
    const dbLike = {
      all: <T>(sql: string, ...params: unknown[]): T[] => db.prepare(sql).all(...params) as T[],
    };
    const project = db.prepare('SELECT id FROM project WHERE name = ?').get(PROJECT) as
      | { id: number }
      | undefined;
    if (!project) fail(`no project ${PROJECT}`);
    const context = loadIdentityContext(dbLike as unknown as DbType, project.id);
    const resolver = createResolver(context);
    const characters = context.entities.filter((e) => e.kind === 'character');
    const forms = characters.map((e) => {
      const aliases = Array.isArray(e.aliases) ? e.aliases.map(String) : [];
      return { id: e.id, forms: [e.name, ...aliases].map(normName).filter(Boolean) };
    });
    const book = JSON.parse(readFileSync(`${BOOK_OUT}/${BOOK_ID}.book`, 'utf8')) as {
      characters?: { id: number; mentions?: { proper?: { c: number; n: string }[] } }[];
    };
    const chars = book.characters ?? [];
    const maps = buildPersonMaps(chars, resolver, characters);
    const clusterPersons = new Map<number, number[]>();
    for (const c of chars) {
      const persons = new Set<number>();
      for (const m of c.mentions?.proper ?? []) {
        const r = resolver.resolve(String(m.n));
        if (r.status === 'resolved' && r.id !== null && characters.some((e) => e.id === r.id)) {
          persons.add(r.id);
        }
      }
      clusterPersons.set(Number(c.id), [...persons]);
    }
    const tokRows = bodyRows(`${BOOK_OUT}/${BOOK_ID}.tokens`);
    const keyOfDoc = new Map<number, string>();
    const sentText = new Map<string, string>();
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
      sentText.set(key, text);
      for (const e of list) keyOfDoc.set(e.doc, key);
    }
    return {
      chars,
      strict: maps.strict,
      clusterPersons,
      rosterPersons: characters.length,
      cleanChains: maps.cleanChains,
      voidChains: maps.voidChains,
      droppedUnmapped: maps.droppedUnmapped,
      droppedAmbiguous: maps.droppedAmbiguous,
      forms,
      quoteRows: bodyRows(`${BOOK_OUT}/${BOOK_ID}.quotes`),
      entRows: bodyRows(`${BOOK_OUT}/${BOOK_ID}.entities`),
      keyOfDoc,
      sentText,
    };
  } finally {
    db.close();
  }
}

function bankSets(): { bankedAll: Set<string>; bankedPairsTotal: number } {
  const db = new DatabaseSync(resolve(DB_PATH), { readOnly: true });
  try {
    const project = db.prepare('SELECT id FROM project WHERE name = ?').get(PROJECT) as { id: number };
    const bankedAll = new Set<string>();
    for (const row of db.prepare('SELECT from_entity, to_entity FROM canon_relation WHERE project_id = ?').all(
      project.id,
    ) as { from_entity: number; to_entity: number }[]) {
      bankedAll.add(pairKey(row.from_entity, row.to_entity));
    }
    return { bankedAll, bankedPairsTotal: bankedAll.size };
  } finally {
    db.close();
  }
}

const hit = (
  pairs: Set<string>,
  bankedAll: Set<string>,
  bankedPairsTotal: number,
): { n: number; hits: number; precision: number; recall: number } => {
  let hits = 0;
  for (const key of pairs) if (bankedAll.has(key)) hits++;
  return {
    n: pairs.size,
    hits,
    precision: pairs.size ? Number((hits / pairs.size).toFixed(3)) : 0,
    recall: bankedPairsTotal ? Number((hits / bankedPairsTotal).toFixed(3)) : 0,
  };
};

export function score(): Record<string, unknown> {
  const before = dbStat();
  const loaded = load();
  const exchange = buildExchangePairs(loaded.quoteRows, loaded.strict, loaded.forms);
  const coref = buildCorefPairs(loaded.entRows, loaded.strict, loaded.keyOfDoc);
  const action = buildActionPairs(loaded.chars, loaded.strict).pairs;
  const { bankedAll, bankedPairsTotal } = bankSets();
  // Same four as the chapter probe, bank-wide denominators.
  let exactOne = 0;
  let badMerges = 0;
  const matchedPersons = new Set<number>();
  for (const persons of loaded.clusterPersons.values()) {
    for (const id of persons) matchedPersons.add(id);
    if (persons.length === 1) exactOne++;
    else if (persons.length > 1) badMerges++;
  }
  const namedIds = new Set(loaded.clusterPersons.keys());
  const entPron = loaded.entRows.filter((r) => (r[3] ?? '').toUpperCase() === 'PRON');
  const quoteAttributed = loaded.quoteRows.filter((r) => (r[4] ?? '').trim().length > 0).length;
  const four = {
    clusters: loaded.clusterPersons.size,
    clusterExactOnePerson: exactOne,
    clusterBadTwoPersonMerges: badMerges,
    rosterPersons: loaded.rosterPersons,
    rosterMissed: loaded.rosterPersons - matchedPersons.size,
    pronounMentions: entPron.length,
    pronounLinkedToNamed: entPron.filter((r) => namedIds.has(Number(r[0]))).length,
    quotes: loaded.quoteRows.length,
    quotesAttributed: quoteAttributed,
    quotesAttributedPct: loaded.quoteRows.length
      ? Number(((100 * quoteAttributed) / loaded.quoteRows.length).toFixed(1))
      : 0,
  };
  const sheetPath = process.argv[3] ?? '';
  const lockedHits: Record<string, number> = {};
  let lockedResolved = 0;
  if (sheetPath && existsSync(sheetPath) && sheetPath.endsWith('.json')) {
    const sheet = JSON.parse(readFileSync(sheetPath, 'utf8')) as { a: string; b: string; block: string }[];
    const formToIds = new Map<string, number[]>();
    for (const entry of loaded.forms) {
      for (const form of entry.forms) {
        formToIds.set(form, [...(formToIds.get(form) ?? []), entry.id]);
      }
    }
    const combined = new Set([...exchange, ...coref]);
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
    runPath: 'whole-book single run',
    directionRule: 'scored unordered (bank threads normalize lo:hi; relation from/to stays as read)',
    four,
    identity: {
      cleanChains: loaded.cleanChains,
      voidChains: loaded.voidChains,
      droppedUnmapped: loaded.droppedUnmapped,
      droppedAmbiguous: loaded.droppedAmbiguous,
    },
    sets: {
      actionPairs: hit(action, bankedAll, bankedPairsTotal),
      quoteExchange: hit(exchange, bankedAll, bankedPairsTotal),
      corefComentions: hit(coref, bankedAll, bankedPairsTotal),
      combined: hit(new Set([...exchange, ...coref]), bankedAll, bankedPairsTotal),
    },
    bankedPairsTotal,
    lockedResolved,
    lockedHits,
    reviewStatus: 'Nothing banks — candidates for review, verbatim',
    dbUntouched: dbStat(),
    dbBefore: before,
  };
  mkdirSync(BOOK_OUT, { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  for (const [name, s] of Object.entries(manifest.sets)) {
    console.log(`${name}: n ${s.n} hits ${s.hits} precision ${s.precision} recall ${s.recall}`);
  }
  const f = manifest.four as Record<string, number>;
  console.log(
    `four: clusters ${f.clusters} exactOne ${f.clusterExactOnePerson} badMerges ${f.clusterBadTwoPersonMerges} ` +
      `roster ${f.rosterPersons} missed ${f.rosterMissed} pron ${f.pronounLinkedToNamed}/${f.pronounMentions} ` +
      `quotes ${f.quotesAttributed}/${f.quotes} (${f.quotesAttributedPct}%)`,
  );
  console.log(`locked: resolved ${lockedResolved} hits ${JSON.stringify(lockedHits)}`);
  console.log(`bank untouched (main ${before.main}); manifest ${MANIFEST}`);
  return manifest;
}

export function write(): Record<string, unknown> {
  const before = dbStat();
  const loaded = load();
  if (!existsSync(COPY_DB)) copyFileSync(DB_PATH, COPY_DB);
  const counts = {
    exchangeWritten: 0,
    comentionsWritten: 0,
    skippedBanked: 0,
    skippedDuplicate: 0,
    skippedUnlocatable: 0,
  };
  const locatorDb = new DatabaseSync(resolve(DB_PATH), { readOnly: true });
  let chunks: { id: number; locator: string; text: string }[];
  let pid = 0;
  try {
    const project = locatorDb.prepare('SELECT id FROM project WHERE name = ?').get(PROJECT) as { id: number };
    pid = project.id;
    chunks = locatorDb.prepare('SELECT id, locator, text FROM canon_chunk WHERE project_id = ? ORDER BY seq').all(
      pid,
    ) as typeof chunks;
  } finally {
    locatorDb.close();
  }
  const normLocate = (s: string): string =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const locate = (text: string): { id: number; locator: string } | null => {
    const want = normLocate(text);
    if (!want || want.length < 20) return null;
    for (const c of chunks) {
      if (normLocate(c.text).includes(want)) return { id: c.id, locator: c.locator };
    }
    return null;
  };
  const db = new Db(COPY_DB);
  try {
    const hasRelation = (a: number, b: number): boolean =>
      !!db.get<{ id: number }>(
        `SELECT id FROM canon_relation WHERE project_id = ?
           AND ((from_entity = ? AND to_entity = ?) OR (from_entity = ? AND to_entity = ?)) LIMIT 1`,
        pid,
        a,
        b,
        b,
        a,
      );
    const hasPending = (a: number, b: number, kind: string): boolean =>
      !!db.get<{ id: number }>(
        `SELECT id FROM canon_tie_note WHERE project_id = ? AND attempted_kind = ? AND status = 'pending'
           AND ((from_entity = ? AND to_entity = ?) OR (from_entity = ? AND to_entity = ?)) LIMIT 1`,
        pid,
        kind,
        a,
        b,
        b,
        a,
      );
    const insert = (a: number, b: number, kind: string, evidence: string, chunkId: number, locator: string): void => {
      db.run(
        `INSERT INTO canon_tie_note
           (project_id, from_entity, to_entity, attempted_kind, reason, evidence, source_refs,
            status, ruling, ruled_at, created_at)
         VALUES (?, ?, ?, ?, 'booknlp-candidate', ?, ?, 'pending', '', '', ?)`,
        pid,
        a,
        b,
        kind,
        evidence,
        JSON.stringify([{ chunk: chunkId, locator }]),
        nowIso(),
      );
    };
    const place = (a: number, b: number, kind: string, evidence: string): void => {
      if (hasRelation(a, b)) {
        counts.skippedBanked++;
        return;
      }
      if (hasPending(a, b, kind)) {
        counts.skippedDuplicate++;
        return;
      }
      const at = locate(evidence);
      if (!at) {
        counts.skippedUnlocatable++;
        return;
      }
      insert(a, b, kind, evidence, at.id, at.locator);
      if (kind === 'quote-exchange') counts.exchangeWritten++;
      else counts.comentionsWritten++;
    };
    // Quote-exchange: the quote itself is the verbatim span.
    const seen = new Set<string>();
    for (const r of loaded.quoteRows) {
      for (const speaker of loaded.strict.get(Number(r[5])) ?? []) {
        const quote = String(r[6] ?? '');
        for (const mentioned of mentionedPersons(quote, loaded.forms)) {
          if (mentioned === speaker) continue;
          const key = `q:${pairKey(speaker, mentioned)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          place(speaker, mentioned, 'quote-exchange', quote);
        }
      }
    }
    // Co-mentions: first shared sentence stands as the span.
    const sentPersons = new Map<string, Set<number>>();
    for (const r of loaded.entRows) {
      for (const person of loaded.strict.get(Number(r[0])) ?? []) {
        const start = Number(r[1]);
        const end = Number(r[2]);
        const keys = new Set<string>();
        for (let doc = start; doc <= end; doc++) {
          const key = loaded.keyOfDoc.get(doc);
          if (key !== undefined) keys.add(key);
        }
        for (const key of keys) {
          const set = sentPersons.get(key) ?? new Set<number>();
          set.add(person);
          sentPersons.set(key, set);
        }
      }
    }
    const pairSent = new Map<string, string>();
    for (const [key, persons] of sentPersons) {
      const ids = [...persons].sort((a, b) => a - b);
      const text = loaded.sentText.get(key) ?? '';
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const k = `c:${pairKey(ids[i]!, ids[j]!)}`;
          if (!pairSent.has(k)) pairSent.set(k, text);
        }
      }
    }
    for (const [key, evidence] of pairSent) {
      const [a, b] = key.slice(2).split(':').map(Number) as [number, number];
      place(a, b, 'co-mention', evidence);
    }
    writeFileSync(
      `${BOOK_OUT}/write.json`,
      JSON.stringify(
        {
          copy: COPY_DB,
          locateRule: 'lowercase alnum-only containment, 20-char minimum (BookNLP spacing artifacts defeat byte match)',
          ...counts,
        },
        null,
        1,
      ),
    );
    console.log(
      `write: exchange ${counts.exchangeWritten} comentions ${counts.comentionsWritten} ` +
        `skipped banked ${counts.skippedBanked} dup ${counts.skippedDuplicate} unlocatable ${counts.skippedUnlocatable}`,
    );
    console.log(`write: copy ${COPY_DB}`);
  } finally {
    db.close();
  }
  const after = statSync(DB_PATH);
  const untouched = `${after.size}:${after.mtimeMs}` === before.main;
  console.log(`source untouched: ${untouched}`);
  if (!untouched) fail('source bank moved during write');
  return counts;
}

export function prove(): Record<string, unknown> {
  if (!existsSync(COPY_DB)) fail(`no ${COPY_DB} (run write first)`);
  const db = new Db(COPY_DB);
  try {
    const project = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', PROJECT);
    if (!project) fail(`no project ${PROJECT}`);
    const queue = prioritiseTieNotes(db, project.id, { limit: 100000 });
    const ours = db.all<{ attempted_kind: string; id: number }>(
      `SELECT attempted_kind, id FROM canon_tie_note WHERE project_id = ? AND reason = 'booknlp-candidate'`,
      project.id,
    );
    const queuedOurs = queue.filter((row) => ours.some((o) => o.id === row.id));
    const promotableOurs = queuedOurs.filter((row) => row.decision.ok).length;
    const promotableAll = queue.filter((row) => row.decision.ok).length;
    const proof = {
      copy: COPY_DB,
      queueRows: queue.length,
      candidateRows: ours.length,
      candidateRowsQueued: queuedOurs.length,
      promotableCandidates: promotableOurs,
      promotableOverall: promotableAll,
    };
    writeFileSync(`${BOOK_OUT}/prove.json`, JSON.stringify(proof, null, 1));
    console.log(
      `prove: queue ${proof.queueRows} candidates ${proof.candidateRows} queued ${proof.candidateRowsQueued} ` +
        `promotableCandidates ${proof.promotableCandidates} promotableOverall ${proof.promotableOverall}`,
    );
    if (promotableOurs !== 0) fail('a candidate promotes — the row shape is wrong');
    return proof;
  } finally {
    db.close();
  }
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('book-candidates.ts')) {
  const step = process.argv[2] ?? 'score';
  if (step === 'score') score();
  else if (step === 'write') write();
  else if (step === 'prove') prove();
  else if (step === 'all') {
    score();
    write();
    prove();
  } else console.error(`book-candidates: unknown step "${step}"`);
}
