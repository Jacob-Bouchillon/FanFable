/**
 * Name pass: per-person front-to-back recall, notes on threads, NEVER rows.
 *
 * For each character entity: gather candidate passages CODE-ONLY (name +
 * alias + variant match, cap 6 spread across the book), one Spark call per
 * person (slot extraction, verbatim spans only), ingest results as immutable
 * notes (verbatim gate + dedupe enforced, honest strength). Pronouns are
 * never resolved by guessing: unmatched stays an open end.
 *
 * Writes ONLY web tables on the given copy (canon_thread / note / open_end /
 * meeting / birth / ruling). Asserts zero diff on canon_relation,
 * canon_tie_note, canon_tie_hint. No bank-certifying writes, ever.
 *
 * Usage:
 *   cp testing/trials/halfbook-run/plagueis-half.db testing/trials/discovery/namepass-copy.db
 *   node --no-warnings testing/trials/discovery/namepass.ts [dbPath] [limit]
 */
import { Db } from '../../../fanfable/src/db.ts';
import { syncThreads } from '../../../fanfable/src/web/threads.ts';
import { runMeetings } from '../../../fanfable/src/web/meetings.ts';
import { recordRuling } from '../../../fanfable/src/court/ruling.ts';
import {
  assertableClaim,
  isVerbatimInChunk,
  noteDedupeKey,
} from '../../../fanfable/src/web/note-ingest.ts';
import { explicitVariants } from '../../../fanfable/src/gates.ts';
import { extractJson } from '../../../fanfable/src/json.ts';

const DB = process.argv[2] ?? 'testing/trials/discovery/namepass-copy.db';
const LIMIT = process.argv[3] === undefined ? Infinity : Math.max(0, Number(process.argv[3]));
const SPARK = process.env.NAMEPASS_URL ?? 'http://127.0.0.1:11437/generate';
const PACKET_CAP = 6;

const fold = (s: string): string => String(s ?? '').replace(/[\u2018\u2019]/g, "'").toLowerCase();

/** Earliest, latest, evenly between, capped — same packet rule as the unproposed-pairs design. */
function spreadPick(ids: number[]): number[] {
  if (ids.length <= PACKET_CAP) return [...ids];
  const out = new Set<number>([ids[0]!, ids[ids.length - 1]!]);
  const inner = ids.slice(1, -1);
  const step = inner.length / (PACKET_CAP - 2);
  for (let k = 0; k < PACKET_CAP - 2; k++) out.add(inner[Math.min(inner.length - 1, Math.floor(k * step + step / 2))]!);
  return [...ids.filter((id) => out.has(id))].slice(0, PACKET_CAP);
}

interface SparkItem {
  other?: string;
  tie?: string;
  passage?: number;
  quote?: string;
  strength?: number;
  why?: string;
  missing?: string;
}

const SYSTEM =
  'You read passages from a novel and list relationships between the named person and other specific people. ' +
  'Reply with JSON only: an array like [{"other": "<name as written>", "tie": "<relationship in a few words>", ' +
  '"passage": <number>, "quote": "<exact span copied character for character from that passage>", ' +
  '"strength": <0-1 how strongly the passage states this tie>, "why": "<one sentence>", ' +
  '"missing": "<what would settle it>"}]. ' +
  'The quote must be copied exactly from the passage it cites; never invent, paraphrase or stitch. ' +
  'Name only people the passages actually show; if none, reply [].';

const counts = {
  names: 0,
  calls: 0,
  callErrors: 0,
  items: 0,
  notesAdded: 0,
  skipped: {} as Record<string, number>,
  openEndsAdded: 0,
  bankBefore: '',
  bankAfter: '',
};
const skip = (reason: string): void => {
  counts.skipped[reason] = (counts.skipped[reason] ?? 0) + 1;
};

const bankTally = (db: Db, projectId: number): string =>
  ['canon_relation', 'canon_tie_note', 'canon_tie_hint']
    .map((t) => `${t}=${db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`, projectId)?.n ?? -1}`)
    .join(',');

const db = new Db(DB);
const project = db.get<{ id: number }>(`SELECT id FROM project WHERE name = 'halfbook'`);
if (!project) throw new Error('no halfbook project in copy');
const pid = project.id;

counts.bankBefore = bankTally(db, pid);
const synced = syncThreads(db, pid);
console.log(`threads synced: +${synced.personThreadsCreated} person, +${synced.pairThreadsCreated} pair`);

const people = db.all<{ id: number; name: string; aliases: string }>(
  `SELECT id, name, aliases FROM canon_entity WHERE project_id = ? AND kind = 'character' AND review_status != 'quarantined' ORDER BY id`,
  pid,
).slice(0, LIMIT);
const chunks = db.all<{ id: number; seq: number; locator: string; text: string }>(
  `SELECT id, seq, locator, text FROM canon_chunk WHERE project_id = ? ORDER BY seq`,
  pid,
);
const aliasList = (json: string): string[] => {
  try {
    const list = JSON.parse(json || '[]') as unknown[];
    return Array.isArray(list) ? list.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
};
const threadOf = (a: number, b: number | null): number | null =>
  db.get<{ id: number }>(
    b === null
      ? `SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'person' AND a_entity = ? AND b_entity IS NULL AND parent_a_thread IS NULL`
      : `SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'pair' AND a_entity = ? AND b_entity = ? AND period_label = '' AND parent_a_thread IS NULL ORDER BY id LIMIT 1`,
    ...(b === null ? [pid, a] : [pid, a, b]),
  )?.id ?? null;
const ensurePairThread = (a: number, b: number): number => {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const found = threadOf(lo, hi);
  if (found !== null) return found;
  const at = new Date().toISOString();
  return Number(
    db.run(
      `INSERT INTO canon_thread
        (project_id, kind, a_entity, b_entity, pair_thread_id, status, birth_reason,
         period_label, period_from_seq, period_to_seq, temporal_status, created_at, updated_at)
       VALUES (?, 'pair', ?, ?, NULL, 'open', '', '', NULL, NULL, 'unknown', ?, ?)`,
      pid, lo, hi, at, at,
    ).lastInsertRowid,
  );
};
const ensureOpenEnd = (threadId: number, question: string, origin: string): void => {
  const existing = db.get<{ id: number }>(
    'SELECT id FROM canon_open_end WHERE thread_id = ? AND question = ?',
    threadId, question,
  );
  if (existing) return;
  db.run(
    `INSERT INTO canon_open_end (project_id, thread_id, question, origin, would_resolve, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    pid, threadId, question, origin, '', new Date().toISOString(),
  );
  counts.openEndsAdded++;
};
const entitiesByName = new Map<string, { id: number; name: string }>();
for (const p of db.all<{ id: number; name: string; aliases: string }>(
  `SELECT id, name, aliases FROM canon_entity WHERE project_id = ? AND kind = 'character'`, pid)) {
  entitiesByName.set(p.name.toLowerCase(), { id: p.id, name: p.name });
  for (const a of aliasList(p.aliases)) {
    if (!entitiesByName.has(a.toLowerCase())) entitiesByName.set(a.toLowerCase(), { id: p.id, name: p.name });
  }
}

for (const person of people) {
  counts.names++;
  const forms = [person.name, ...aliasList(person.aliases), ...explicitVariants(person.name, aliasList(person.aliases))];
  const foldedForms = [...new Set(forms.map((f) => fold(f).trim()).filter(Boolean))];
  const hits = chunks.filter((c) => {
    const text = fold(c.text);
    return foldedForms.some((f) => f.length > 2 && text.includes(f));
  });
  const personThread = threadOf(person.id, null);
  if (personThread === null) {
    skip('no-person-thread');
    continue;
  }
  if (!hits.length) {
    ensureOpenEnd(personThread, `no passages name ${person.name}`, 'namepass');
    skip('no-passages');
    continue;
  }
  const picked = spreadPick(hits.map((h) => h.id));
  const byId = new Map(hits.map((h) => [h.id, h]));
  const block = picked
    .map((id, i) => `### P${i + 1} (chunk ${id}, ${byId.get(id)?.locator ?? '?'})\n${byId.get(id)?.text ?? ''}`)
    .join('\n\n');

  let items: SparkItem[] = [];
  try {
    counts.calls++;
    const isOllama = SPARK.includes(':11434/api/chat');
    const res = await fetch(SPARK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        isOllama
          ? {
              model: process.env.NAMEPASS_MODEL ?? 'spark-x2-q8',
              messages: [
                { role: 'system', content: SYSTEM },
                { role: 'user', content: `PERSON: ${person.name}\n\nPASSAGES:\n${block}` },
              ],
              think: false,
              stream: false,
              options: { temperature: 0, seed: 42, num_predict: 2048 },
            }
          : {
              messages: [
                { role: 'system', content: SYSTEM },
                { role: 'user', content: `PERSON: ${person.name}\n\nPASSAGES:\n${block}` },
              ],
              max_tokens: 2048,
              temperature: 0,
              seed: 42,
              thinking: false,
            },
      ),
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const data = (await res.json()) as {
      text?: string;
      error?: string;
      message?: { content?: string };
      choices?: { message?: { content?: string } }[];
    };
    if (data.error) throw new Error(data.error);
    const text = isOllama
      ? data.message?.content ?? ''
      : (data.choices?.[0]?.message?.content ?? data.text ?? '');
    if (process.env.NAMEPASS_DUMP && counts.calls === 1) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync('/tmp/namepass-raw.txt', text);
    }
    const parsed = extractJson<unknown>(text);
    items = Array.isArray(parsed) ? (parsed as SparkItem[]) : [];
  } catch (e) {
    counts.callErrors++;
    ensureOpenEnd(personThread, `read failed for ${person.name}: ${e instanceof Error ? e.message : e}`, 'namepass');
    continue;
  }

  db.transaction(() => {
    for (const item of items) {
      counts.items++;
      const otherName = String(item.other ?? '').trim();
      const tie = String(item.tie ?? '').trim();
      const quote = String(item.quote ?? '').trim();
      const strength = Number(item.strength);
      if (!otherName || !tie || !quote) {
        skip('empty-fields');
        continue;
      }
      const chunkId = picked[(Number(item.passage) || 1) - 1] ?? picked[0]!;
      const chunk = byId.get(chunkId);
      if (!chunk || !isVerbatimInChunk(chunk.text, quote)) {
        skip('not-verbatim');
        continue;
      }
      if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
        skip('bad-strength');
        continue;
      }
      const target = entitiesByName.get(otherName.toLowerCase());
      if (!target || target.id === person.id) {
        ensureOpenEnd(personThread, `who is ${otherName} (${tie} of ${person.name})?`, chunk.locator);
        skip(target && target.id === person.id ? 'same-person' : 'unresolved-other');
        continue;
      }
      const claim = assertableClaim({
        fromName: person.name, toName: target.name, kind: tie,
        why: String(item.why ?? ''), quote,
      });
      if (!claim.claim) {
        skip('no-assertable-claim');
        continue;
      }
      const threadId = ensurePairThread(person.id, target.id);
      const key = noteDedupeKey(quote, claim.claim);
      const existing = db.get<{ id: number }>(
        'SELECT id FROM canon_thread_note WHERE thread_id = ? AND dedupe_key = ?', threadId, key);
      if (existing) {
        skip('duplicate');
        continue;
      }
      const id = Number(db.run(
        `INSERT INTO canon_thread_note
          (project_id, thread_id, chunk_id, locator, quote, claim, note_kind, strength,
           why, missing, is_context, supersedes_note_id, dedupe_key, strength_source, claim_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'observation', ?, ?, ?, 0, NULL, ?, 'assessed', ?, ?)`,
        pid, threadId, chunk.id, chunk.locator, quote, claim.claim,
        Math.min(1, Math.max(0, strength)),
        String(item.why ?? '').slice(0, 500), String(item.missing ?? '').slice(0, 500),
        key, tie.slice(0, 120), new Date().toISOString(),
      ).lastInsertRowid);
      recordRuling(db, pid, {
        relationId: null, threadId, role: 'clue', actor: 'external',
        standard: 'verbatim-quote', basis: `note ${id} quote verbatim in chunk ${chunk.id}`, quote,
      });
      counts.notesAdded++;
    }
  });
  if (counts.names % 25 === 0) console.log(`...${counts.names}/${people.length} names, ${counts.notesAdded} notes`);
}
console.log(JSON.stringify({ ...counts, people: people.length }));
counts.bankAfter = bankTally(db, pid);
if (counts.bankBefore !== counts.bankAfter) {
  console.error(`BANK DIFF: ${counts.bankBefore} -> ${counts.bankAfter}`);
  process.exitCode = 1;
}
console.log(JSON.stringify({ bankBefore: counts.bankBefore, bankAfter: counts.bankAfter }));
db.close();
