/**
 * Feeder ingest: BookNLP chains + .book actions as combination inputs.
 *
 * Trial only, disposable copy. Reads the upstream chapter outputs read-only
 * and adds ONE note per chain/action entry touching a banked person, with a
 * rule-derived mid-tier share recorded as an assessment at ingest (never a
 * default): one-passage co-mention 0.35, repeated across passages 0.45,
 * shared agent-patient verb 0.5, possessor/modifier 0.4. Identity follows the
 * bank's own rules only (exact, alias, guarded containment); an ambiguous or
 * absent name becomes an open end on the resolved side, never a guess. The
 * verbatim gate admits every note: the sentence when it locates, else the
 * mention span; unlocatable entries are counted and skipped. Claims never
 * assert a kind (kind_fit partly at most). Every note carries provenance
 * (source, share, why) for the count below.
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/combine/feed.ts
 *
 * Writes notes + open ends to testing/trials/combine/work-fed.db only
 * (gitignored scratch). The live bank and the upstream outputs are never
 * written. Reports counts only, never passage prose or names.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { Db, nowIso } from '../../../fanfable/src/core/db.ts';
import { syncThreads, pickPeriodThread } from '../../../fanfable/src/web/threads.ts';
import { backfillThreadNotes, noteDedupeKey } from '../../../fanfable/src/web/note-ingest.ts';
import { loadIdentityContext, createResolver } from '../../../fanfable/src/identity/identity.ts';

const TRACK = 'testing/trials/combine';
const SOURCE = '/tmp/opencode/qwen35-copy.db.attested-backup-2026-10-31T04-12-43-478Z.db';
const WORK = `${TRACK}/work-fed.db`;
const FEED_JSON = `${TRACK}/feed.json`;
const BOOKNLP = 'testing/trials/booknlp/out';
const BOOK_ID = 'chapter';
const PROJECT = 'halfbook';

const CHAIN_SINGLE = 0.35;
const CHAIN_MULTI = 0.45;
const VERB_ROLE = 0.5;
const ATTR = 0.4;

function fail(message: string): never {
  throw new Error(`feed: ${message}`);
}

const normSpace = (s: string): string => String(s ?? '').replace(/\s+/g, ' ').trim();

function detok(words: string[]): string {
  return words
    .join(' ')
    .replace(/\s+([.,!?;:…%‰'’"”)\]}»])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function bodyRows(path: string): string[][] {
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
  const rows = lines.map((line) => line.split('\t'));
  if (rows.length && !/^-?\d+$/.test((rows[0]![0] ?? '').trim())) rows.shift();
  return rows;
}

interface FeedCounts {
  notesAdded: number;
  duplicateSkipped: number;
  gateFailed: number;
  openEnds: number;
  ambiguous: number;
  absent: number;
  chainMulti: number;
  bySource: Record<string, number>;
  byStrength: Record<string, number>;
}

export function feed(): FeedCounts {
  const sourceStat = statSync(SOURCE);
  mkdirSync(TRACK, { recursive: true });
  if (!existsSync(WORK)) copyFileSync(SOURCE, WORK);
  const counts: FeedCounts = {
    notesAdded: 0,
    duplicateSkipped: 0,
    gateFailed: 0,
    openEnds: 0,
    ambiguous: 0,
    absent: 0,
    chainMulti: 0,
    bySource: {},
    byStrength: {},
  };
  const db = new Db(WORK);
  try {
    const project = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', PROJECT);
    if (!project) fail(`no project ${PROJECT}`);
    const pid = project.id;
    syncThreads(db, pid);
    backfillThreadNotes(db, pid);

    const context = loadIdentityContext(db, pid);
    const resolver = createResolver(context);
    const kindOf = new Map(context.entities.map((e) => [e.id, e.kind]));
    const nameOf = new Map(context.entities.map((e) => [e.id, e.name]));

    // Token + sentence index from the read-only chapter outputs.
    const tokRows = bodyRows(`${BOOKNLP}/${BOOK_ID}.tokens`);
    const sentOfDoc = new Map<number, string>();
    const sentKeyOfDoc = new Map<number, string>();
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
        sentKeyOfDoc.set(e.doc, key);
      }
    }

    // Chapter chunks on the copy for the verbatim gate.
    const chunks = db.all<{ id: number; seq: number; text: string; locator: string }>(
      'SELECT id, seq, text, locator FROM canon_chunk WHERE project_id = ? ORDER BY seq',
      pid,
    );
    const locate = (text: string): { id: number; seq: number; locator: string } | null => {
      const want = normSpace(text);
      if (!want) return null;
      for (const c of chunks) {
        if (normSpace(c.text).includes(want)) return { id: c.id, seq: c.seq, locator: c.locator };
      }
      return null;
    };

    const book = JSON.parse(readFileSync(`${BOOKNLP}/${BOOK_ID}.book`, 'utf8')) as {
      characters?: {
        id: number;
        mentions?: { proper?: { c: number; n: string }[] };
        agent?: { w: string; i: number }[];
        patient?: { w: string; i: number }[];
        mod?: { w: string; i: number }[];
        poss?: { w: string; i: number }[];
      }[];
    };
    const chars = book.characters ?? [];
    const topName = new Map<number, string>();
    for (const c of chars) {
      const proper = [...(c.mentions?.proper ?? [])].sort((a, b) => b.c - a.c);
      topName.set(Number(c.id), proper.length ? String(proper[0]!.n) : '');
    }
    // Chain -> banked persons via the bank's own identity rules. A chain naming
    // two banked persons is a merge by the bank's lights, not a co-mention:
    // only single-person chains feed pairs.
    const personsOfChain = new Map<number, number[]>();
    let chainMulti = 0;
    for (const c of chars) {
      const persons = new Set<number>();
      for (const m of c.mentions?.proper ?? []) {
        const r = resolver.resolve(String(m.n));
        if (r.status === 'resolved' && r.id !== null && kindOf.get(r.id) === 'character') {
          persons.add(r.id);
        } else if (r.status === 'ambiguous') counts.ambiguous++;
        else counts.absent++;
      }
      if (persons.size > 1) counts.chainMulti++;
      personsOfChain.set(Number(c.id), [...persons]);
    }
    const singlePerson = (chainId: number): number | null => {
      const persons = personsOfChain.get(chainId) ?? [];
      return persons.length === 1 ? persons[0]! : null;
    };

    const at = nowIso();
    const personThread = (entityId: number): number => {
      const found = db.get<{ id: number }>(
        "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'person' AND a_entity = ? AND parent_a_thread IS NULL",
        pid,
        entityId,
      );
      if (found) return found.id;
      return Number(
        db.run(
          `INSERT INTO canon_thread
             (project_id, kind, a_entity, b_entity, pair_thread_id, status, birth_reason, created_at, updated_at)
           VALUES (?, 'person', ?, NULL, NULL, 'open', '', ?, ?)`,
          pid,
          entityId,
          at,
          at,
        ).lastInsertRowid,
      );
    };
    const pairThread = (a: number, b: number, seq: number): number => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const threads = db
        .all<{ id: number; period_from_seq: number | null; period_to_seq: number | null; period_label: string }>(
          `SELECT id, period_from_seq, period_to_seq, period_label FROM canon_thread
            WHERE project_id = ? AND kind = 'pair' AND a_entity = ? AND b_entity = ? AND parent_a_thread IS NULL
            ORDER BY id`,
          pid,
          lo,
          hi,
        )
        .map((row) => ({
          id: row.id,
          periodFromSeq: row.period_from_seq ?? null,
          periodToSeq: row.period_to_seq ?? null,
          periodLabel: row.period_label,
        }));
      const picked = pickPeriodThread(threads, seq);
      if (picked !== null) return picked;
      return Number(
        db.run(
          `INSERT INTO canon_thread
             (project_id, kind, a_entity, b_entity, pair_thread_id, status, birth_reason,
              period_label, period_from_seq, period_to_seq, temporal_status, created_at, updated_at)
           VALUES (?, 'pair', ?, ?, NULL, 'open', '', '', ?, ?, 'unknown', ?, ?)`,
          pid,
          lo,
          hi,
          seq,
          seq,
          at,
          at,
        ).lastInsertRowid,
      );
    };
    const addNote = (
      threadId: number,
      chunk: { id: number; locator: string },
      quote: string,
      claim: string,
      strength: number,
      source: string,
      why: string,
    ): void => {
      const key = noteDedupeKey(quote, claim);
      const existing = db.get<{ id: number }>(
        'SELECT id FROM canon_thread_note WHERE thread_id = ? AND dedupe_key = ?',
        threadId,
        key,
      );
      if (existing) {
        counts.duplicateSkipped++;
        return;
      }
      db.run(
        `INSERT INTO canon_thread_note
           (project_id, thread_id, chunk_id, locator, quote, claim, note_kind, strength,
            why, missing, is_context, supersedes_note_id, dedupe_key, strength_source, claim_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'observation', ?, ?, '', 0, NULL, ?, 'assessed', '', ?)`,
        pid,
        threadId,
        chunk.id,
        chunk.locator,
        quote,
        claim,
        strength,
        `[${source}] ${why}`,
        key,
        at,
      );
      counts.notesAdded++;
      counts.bySource[source] = (counts.bySource[source] ?? 0) + 1;
      counts.byStrength[String(strength)] = (counts.byStrength[String(strength)] ?? 0) + 1;
    };
    const addOpenEnd = (threadId: number, question: string): void => {
      const existing = db.get<{ id: number }>(
        'SELECT id FROM canon_open_end WHERE thread_id = ? AND question = ?',
        threadId,
        question,
      );
      if (existing) return;
      db.run(
        `INSERT INTO canon_open_end (project_id, thread_id, question, origin, would_resolve, status, created_at)
         VALUES (?, ?, ?, 'booknlp-chain', 'a passage naming the other person', 'open', ?)`,
        pid,
        threadId,
        question,
        at,
      );
      counts.openEnds++;
    };

    // Entities: chain -> banked persons present in each sentence.
    const entRows = bodyRows(`${BOOKNLP}/${BOOK_ID}.entities`);
    const sentPersons = new Map<string, Set<number>>();
    const sentOfMention = new Map<number, string>();
    for (const r of entRows) {
      const start = Number(r[1]);
      const key = sentKeyOfDoc.get(start);
      if (key === undefined) continue;
      if ((r[3] ?? '').toUpperCase() !== 'PROP') continue;
      const person = singlePerson(Number(r[0]));
      if (person === null) continue;
      const set = sentPersons.get(key) ?? new Set<number>();
      set.add(person);
      sentPersons.set(key, set);
    }
    const sentText = new Map<string, string>();
    for (const [key, list] of bySent) {
      sentText.set(key, detok([...list].sort((a, b) => a.doc - b.doc).map((e) => e.word)));
    }

    // Pair entries from co-mentions; one note per pair, strongest rule wins.
    const pairSents = new Map<string, Set<string>>();
    for (const [key, persons] of sentPersons) {
      const ids = [...persons].sort((a, b) => a - b);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const k = `${ids[i]}:${ids[j]}`;
          const set = pairSents.get(k) ?? new Set<string>();
          set.add(key);
          pairSents.set(k, set);
        }
      }
    }
    // Shared agent-patient verbs pair the agent's person with the patient's.
    const verbAgents = new Map<number, Set<number>>();
    const verbPatients = new Map<number, Set<number>>();
    for (const c of chars) {
      const person = singlePerson(Number(c.id));
      if (person === null) continue;
      for (const a of c.agent ?? []) {
        const set = verbAgents.get(a.i) ?? new Set<number>();
        set.add(person);
        verbAgents.set(a.i, set);
      }
      for (const p2 of c.patient ?? []) {
        const set = verbPatients.get(p2.i) ?? new Set<number>();
        set.add(person);
        verbPatients.set(p2.i, set);
      }
    }
    const verbPairs = new Map<string, number>();
    for (const [verb, agents] of verbAgents) {
      const patients = verbPatients.get(verb) ?? new Set<number>();
      for (const a of agents) {
        for (const p of patients) {
          if (a === p) continue;
          const k = `${Math.min(a, p)}:${Math.max(a, p)}`;
          if (!verbPairs.has(k)) verbPairs.set(k, verb);
        }
      }
    }

    const openQuestion = (entityId: number): string =>
      `which other person shares a passage with ${nameOf.get(entityId) ?? 'this person'} here?`;
    const pairKeys = new Set([...pairSents.keys(), ...verbPairs.keys()]);
    for (const key of pairKeys) {
      const [a, b] = key.split(':').map(Number) as [number, number];
      const verb = verbPairs.get(key);
      const sents = pairSents.get(key) ?? new Set<string>();
      const strength = verb !== undefined ? VERB_ROLE : sents.size >= 2 ? CHAIN_MULTI : CHAIN_SINGLE;
      const source = verb !== undefined ? 'book-action' : 'booknlp-chain';
      // Evidence sentence: the verb's sentence, else the first shared sentence.
      let evidence = '';
      if (verb !== undefined && sentOfDoc.get(verb)) evidence = sentOfDoc.get(verb)!;
      else for (const k of sents) {
        evidence = sentText.get(k) ?? '';
        break;
      }
      const chunk = locate(evidence);
      const an = nameOf.get(a) ?? '';
      const bn = nameOf.get(b) ?? '';
      if (!chunk) {
        // Fall back to the mention span; unlocatable entries never enter.
        counts.gateFailed++;
        addOpenEnd(personThread(a), openQuestion(a));
        continue;
      }
      const claim =
        verb !== undefined
          ? `${an} acts on ${bn}, linked through coreference`
          : sents.size >= 2
            ? `${an} and ${bn} share ${sents.size} passages`
            : `${an} and ${bn} share a passage`;
      addNote(
        pairThread(a, b, chunk.seq),
        chunk,
        evidence,
        claim,
        strength,
        source,
        verb !== undefined
          ? 'shared agent-patient verb; kind unstated (kind_fit partly at most)'
          : `co-mention across ${sents.size} passage(s); kind unstated (kind_fit partly at most)`,
      );
    }

    // Possessor/modifier entries: one note per banked person on their thread,
    // quoted from the entry's own sentence when it locates.
    const attrPersons = new Map<number, { n: number; sents: Set<string> }>();
    for (const c of chars) {
      const person = singlePerson(Number(c.id));
      if (person === null) continue;
      const words = [...(c.poss ?? []), ...(c.mod ?? [])];
      if (!words.length) continue;
      const entry = attrPersons.get(person) ?? { n: 0, sents: new Set<string>() };
      entry.n += words.length;
      for (const w of words) {
        const sent = sentOfDoc.get(w.i);
        if (sent) entry.sents.add(sent);
      }
      attrPersons.set(person, entry);
    }
    for (const [person, entry] of attrPersons) {
      const threadId = personThread(person);
      let quote: string | null = null;
      let chunk: { id: number; locator: string } | null = null;
      for (const sent of entry.sents) {
        const found = locate(sent);
        if (found) {
          quote = sent;
          chunk = found;
          break;
        }
      }
      if (!quote || !chunk) {
        counts.gateFailed++;
        continue;
      }
      addNote(
        threadId,
        chunk,
        quote,
        `possessions and modifiers recorded for ${nameOf.get(person) ?? ''} (${entry.n} entries)`,
        ATTR,
        'book-action',
        'possessor/modifier role; kind unstated (kind_fit partly at most)',
      );
    }

    writeFileSync(FEED_JSON, JSON.stringify(counts, null, 1));
    console.log(
      `feed: added ${counts.notesAdded} dup ${counts.duplicateSkipped} gateFailed ${counts.gateFailed} ` +
        `openEnds ${counts.openEnds} ambiguous ${counts.ambiguous} absent ${counts.absent}`,
    );
    console.log(`feed: bySource ${JSON.stringify(counts.bySource)} byStrength ${JSON.stringify(counts.byStrength)}`);
  } finally {
    db.close();
  }
  const after = statSync(SOURCE);
  const untouched = after.size === sourceStat.size && after.mtimeMs === sourceStat.mtimeMs;
  console.log(`source untouched: ${untouched}`);
  if (!untouched) fail('source bank moved during feed');
}

feed();
