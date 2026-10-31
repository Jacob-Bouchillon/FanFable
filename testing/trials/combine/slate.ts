/**
 * Ties-factory slate builder — ranked candidate pairs as provisional rows.
 *
 * Trial-only. Maps whole-book reader clusters through the bank's committed
 * identity bridge (exact, alias, guarded containment — never fuzzy, never
 * merged, ambiguous reported), then builds candidate pairs in signal order:
 * quote-exchange, action agent→patient, repeated co-mention (>= 2 passages;
 * single-passage co-mention is co-presence, not evidence, and is excluded).
 * Cap 400, highest signal first, deduped against banked pairs and against
 * each other. Each candidate becomes a provisional relation row with NO kind
 * claimed (kind ''), honest zero confidence, a verbatim span with its chunk
 * locator, and provenance in the description — written with the committed
 * insertRelation path so the committed relabel, assess, and attest passes can
 * take it from there. Unlocatable spans are dropped and counted, never
 * guessed. Counts only, never passage prose or names.
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/combine/slate.ts
 *
 * Writes provisional rows to the LIVE bank (backed up first — refuses when no
 * timestamped backup sits beside it) and testing/trials/combine/factory.json
 * (gitignored). Reads the chapter outputs read-only. Keeper is never assigned
 * here; ties bank on the user's word next.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Db } from '../../../fanfable/src/core/db.ts';
import type { Db as DbType } from '../../../fanfable/src/core/db.ts';
import { loadIdentityContext } from '../../../fanfable/src/identity/identity.ts';
import { mapClusters } from '../../../fanfable/src/identity/booknlp-bridge.ts';
import { insertRelation } from '../../../fanfable/src/lorebook.ts';

const TRACK = 'testing/trials/combine';
const BOOK_OUT = 'testing/trials/booknlp/out-book';
const BOOK_ID = 'book';
const LIVE = `${process.env.HOME}/.local/share/fanfable/fanfable.db`;
const PROJECT = 'halfbook';
const FACTORY = `${TRACK}/factory.json`;
const CAP = 400;

function fail(message: string): never {
  throw new Error(`slate: ${message}`);
}

const normName = (s: string): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normLocate = (s: string): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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

const pairKey = (a: number, b: number): string => `${Math.min(a, b)}:${Math.max(a, b)}`;

interface BookChar {
  id: number;
  mentions?: { proper?: { c: number; n: string }[] };
  agent?: { w: string; i: number }[];
  patient?: { w: string; i: number }[];
}

type Tier = 'quote-exchange' | 'action' | 'repeated-comention';

interface Candidate {
  tier: Tier;
  a: number;
  b: number;
  evidence: string;
  chunkId: number;
  locator: string;
  provenance: string;
}

export function build(): Record<string, unknown> {
  // Live backup must predate this run, or there is no run.
  const liveDir = dirname(resolve(LIVE));
  const backups = readdirSync(liveDir).filter((e) => e.startsWith('fanfable.db.backup-'));
  if (!backups.length) fail(`no timestamped backup beside ${LIVE} — back up first`);

  const ro = new DatabaseSync(resolve(LIVE), { readOnly: true });
  const dbLike = {
    all: <T>(sql: string, ...params: unknown[]): T[] => ro.prepare(sql).all(...params) as T[],
  };
  const one = <T>(sql: string, ...params: unknown[]): T | undefined =>
    ro.prepare(sql).get(...params) as T | undefined;
  const candidates: Candidate[] = [];
  const counts: Record<string, number> = {
    exchange: 0,
    action: 0,
    repeated: 0,
    skippedBanked: 0,
    skippedDuplicate: 0,
    skippedUnlocatable: 0,
    skippedSingle: 0,
    capped: 0,
  };
  let coverage: Record<string, unknown> = {};
  try {
    const project = one<{ id: number }>('SELECT id FROM project WHERE name = ?', PROJECT);
    if (!project) fail(`no project ${PROJECT}`);
    const pid = project.id;

    const book = JSON.parse(readFileSync(`${BOOK_OUT}/${BOOK_ID}.book`, 'utf8')) as {
      characters?: BookChar[];
    };
    const chars = book.characters ?? [];
    const clusters = chars.map((c) => ({
      key: String(c.id),
      names: [...new Set((c.mentions?.proper ?? []).map((m) => String(m.n)))],
    }));
    const mappings = mapClusters(dbLike as unknown as DbType, pid, clusters);
    const personsOf = (chainId: number): number[] => {
      const m = mappings.find((x) => x.key === String(chainId));
      return m && m.status === 'resolved' && m.entityId !== null ? [m.entityId] : [];
    };
    const resolved = mappings.filter((m) => m.status === 'resolved').length;
    const exactOnly = mappings.filter((m) => m.status === 'resolved' && m.how === 'exact').length;
    coverage = {
      clusters: mappings.length,
      exactOnly,
      exactCoverage: mappings.length ? Number((exactOnly / mappings.length).toFixed(3)) : 0,
      resolved,
      fullCoverage: mappings.length ? Number((resolved / mappings.length).toFixed(3)) : 0,
      byStatus: {
        resolved,
        ambiguous: mappings.filter((m) => m.status === 'ambiguous').length,
        absent: mappings.filter((m) => m.status === 'absent').length,
        merged: mappings.filter((m) => m.status === 'merged').length,
      },
    };

    // Sentence index for evidence spans.
    const bySent = new Map<string, { doc: number; word: string }[]>();
    for (const r of bodyRows(`${BOOK_OUT}/${BOOK_ID}.tokens`)) {
      const doc = Number(r[3]);
      if (!Number.isFinite(doc)) continue;
      const key = `${r[0]}\t${r[1]}`;
      const list = bySent.get(key) ?? [];
      list.push({ doc, word: String(r[4] ?? '') });
      bySent.set(key, list);
    }
    const sentText = new Map<string, string>();
    const keyOfDoc = new Map<number, string>();
    for (const [key, list] of bySent) {
      const text = detok([...list].sort((a, b) => a.doc - b.doc).map((e) => e.word));
      sentText.set(key, text);
      for (const e of list) keyOfDoc.set(e.doc, key);
    }

    // Roster forms for quote scanning.
    const context = loadIdentityContext(dbLike as unknown as DbType, pid);
    const characters = context.entities.filter((e) => e.kind === 'character');
    const forms = characters.map((e) => {
      const aliases = Array.isArray(e.aliases) ? e.aliases.map(String) : [];
      return { id: e.id, forms: [e.name, ...aliases].map(normName).filter(Boolean) };
    });
    const mentionedIn = (text: string): Set<number> => {
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
    };

    // Whole-bank chunks for the verbatim gate.
    const chunks = dbLike.all<{ id: number; locator: string; text: string }>(
      'SELECT id, locator, text FROM canon_chunk WHERE project_id = ? ORDER BY seq',
      pid,
    );
    const locate = (text: string): { id: number; locator: string } | null => {
      const want = normLocate(text);
      if (!want || want.length < 20) return null;
      for (const c of chunks) {
        if (normLocate(c.text).includes(want)) return { id: c.id, locator: c.locator };
      }
      return null;
    };

    // Banked pairs (any relation row, either direction): never re-proposed.
    const banked = new Set<string>();
    for (const row of dbLike.all<{ from_entity: number; to_entity: number }>(
      'SELECT from_entity, to_entity FROM canon_relation WHERE project_id = ?',
      pid,
    )) {
      banked.add(pairKey(row.from_entity, row.to_entity));
    }

    const seen = new Set<string>();
    const consider = (
      tier: Tier,
      a: number,
      b: number,
      evidence: string,
      provenance: string,
    ): void => {
      if (a === b) return;
      if (candidates.length >= CAP) {
        counts.capped++;
        return;
      }
      const key = pairKey(a, b);
      if (banked.has(key)) {
        counts.skippedBanked++;
        return;
      }
      // One row per pair, highest signal first: tiers run in priority order.
      if (seen.has(key)) {
        counts.skippedDuplicate++;
        return;
      }
      const at = locate(evidence);
      if (!at) {
        counts.skippedUnlocatable++;
        return;
      }
      seen.add(key);
      candidates.push({ tier, a, b, evidence, chunkId: at.id, locator: at.locator, provenance });
      if (tier === 'quote-exchange') counts.exchange++;
      else if (tier === 'action') counts.action++;
      else counts.repeated++;
    };

    // Tier 1: quote-exchange (speaker chain -> roster person named in quote).
    for (const r of bodyRows(`${BOOK_OUT}/${BOOK_ID}.quotes`)) {
      for (const speaker of personsOf(Number(r[5]))) {
        const quote = String(r[6] ?? '');
        for (const mentioned of mentionedIn(quote)) {
          if (mentioned !== speaker) consider('quote-exchange', speaker, mentioned, quote, 'speaker names them in-quote');
        }
      }
    }
    // Tier 2: shared agent-patient verb, evidenced by the verb's sentence.
    {
      const agents = new Map<number, Set<number>>();
      const patients = new Map<number, Set<number>>();
      for (const c of chars) {
        for (const person of personsOf(Number(c.id))) {
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
      // Verb token -> sentence via the token index.
      const tokSent = new Map<number, string>();
      for (const r of bodyRows(`${BOOK_OUT}/${BOOK_ID}.tokens`)) {
        const doc = Number(r[3]);
        if (Number.isFinite(doc)) tokSent.set(doc, `${r[0]}\t${r[1]}`);
      }
      for (const [verb, aSet] of agents) {
        const sentKey = tokSent.get(verb);
        const evidence = (sentKey !== undefined ? sentText.get(sentKey) : undefined) ?? '';
        for (const a of aSet) {
          for (const p of patients.get(verb) ?? new Set<number>()) {
            if (a !== p) consider('action', a, p, evidence, 'shared agent-patient verb');
          }
        }
      }
    }
    // Tier 3: repeated co-mention (>= 2 passages; singles are co-presence).
    {
      const pairSents = new Map<string, Set<string>>();
      const entRows = bodyRows(`${BOOK_OUT}/${BOOK_ID}.entities`);
      const sentPersons = new Map<string, Set<number>>();
      for (const r of entRows) {
        for (const person of personsOf(Number(r[0]))) {
          const keys = new Set<string>();
          for (let doc = Number(r[1]); doc <= Number(r[2]); doc++) {
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
      for (const [key, persons] of sentPersons) {
        const ids = [...persons].sort((a, b) => a - b);
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            const k = pairKey(ids[i]!, ids[j]!);
            const set = pairSents.get(k) ?? new Set<string>();
            set.add(key);
            pairSents.set(k, set);
          }
        }
      }
      const ordered = [...pairSents.entries()]
        .filter(([, sents]) => {
          if (sents.size < 2) {
            counts.skippedSingle++;
            return false;
          }
          return true;
        })
        .sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1));
      for (const [key, sents] of ordered) {
        const [a, b] = key.split(':').map(Number) as [number, number];
        const first = [...sents].sort()[0]!;
        consider('repeated-comention', a, b, sentText.get(first) ?? '', `co-mentioned across ${sents.size} passages`);
      }
    }
  } finally {
    ro.close();
  }

  // Insert as provisional kind-less rows through the committed path.
  const db = new Db(resolve(LIVE));
  const inserted: number[] = [];
  try {
    const project = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', PROJECT);
    if (!project) fail(`no project ${PROJECT} on live bank`);
    db.transaction(() => {
      for (const c of candidates) {
        const id = insertRelation(db, project.id, {
          fromEntity: c.a,
          toEntity: c.b,
          kind: '',
          description: `[slate-${c.tier}] ${c.provenance}`,
          evidence: c.evidence,
          sourceRefs: JSON.stringify([{ chunk: c.chunkId, locator: c.locator }]),
          reviewStatus: 'provisional',
          confidence: 0,
        });
        inserted.push(id);
      }
    });
  } finally {
    db.close();
  }
  const factory = {
    coverage,
    tiers: counts,
    candidates: candidates.length,
    inserted: inserted.length,
    cap: CAP,
    reviewStatus: 'provisional kind-less rows; keeper never assigned here',
  };
  mkdirSync(TRACK, { recursive: true });
  writeFileSync(FACTORY, JSON.stringify(factory, null, 1));
  console.log(
    `slate: exchange ${counts.exchange} action ${counts.action} repeated ${counts.repeated} ` +
      `inserted ${inserted.length}/${candidates.length} (cap ${CAP})`,
  );
  console.log(
    `slate: skipped banked ${counts.skippedBanked} dup ${counts.skippedDuplicate} ` +
      `unlocatable ${counts.skippedUnlocatable} single ${counts.skippedSingle} capped ${counts.capped}`,
  );
  console.log(
    `slate: coverage exact ${(coverage as Record<string, unknown>).exactCoverage} ` +
      `full ${(coverage as Record<string, unknown>).fullCoverage}`,
  );
  console.log(`slate: manifest ${FACTORY}`);
  return factory;
}

build();
