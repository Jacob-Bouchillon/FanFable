/**
 * Coverage read: targeted re-reads for names with no proof-grade tie.
 *
 * Trial-only. Step `list` (read-only) finds characters with no relation at
 * accepted/attested/user_confirmed and picks up to 4 spread passages each
 * where another character appears, preferring passages nothing cites yet.
 * Step `read` makes one Q8 call per uncovered name with the committed
 * slot-extraction wording (verbatim spans only, temp 0, seed 42, think
 * false) and inserts results as kind-less needs_review rows through the
 * committed insertRelation path (kind-less rows realign to needs_review per
 * the factory finding, so the committed relabel pass can see them; held and
 * invisible, never status-moving). Reruns add nothing: pair-plus-evidence
 * dedupe. Counts only, never passage prose or names.
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/discovery/cover-read.ts [list|read|all]
 *
 * Writes live rows only in `read` (live bank backed up first inside the
 * step; user_confirmed count guarded before and after) and
 * testing/trials/discovery/cover.json (gitignored). Keeper never assigned.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { copyFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Db } from '../../../fanfable/src/core/db.ts';
import type { Db as DbType } from '../../../fanfable/src/core/db.ts';
import { loadIdentityContext, createResolver } from '../../../fanfable/src/identity/identity.ts';
import { insertRelation } from '../../../fanfable/src/lorebook.ts';
import { isVerbatimInChunk } from '../../../fanfable/src/web/note-ingest.ts';
import { explicitVariants } from '../../../fanfable/src/gates/gates.ts';
import { extractJson } from '../../../fanfable/src/core/json.ts';

const TRACK = 'testing/trials/discovery';
const LIVE = `${process.env.HOME}/.local/share/fanfable/fanfable.db`;
const PROJECT = 'halfbook';
const COVER_JSON = `${TRACK}/cover.json`;
const PACKET_CAP = 4;
const OLLAMA = 'http://127.0.0.1:11434';
const MODEL = 'spark-x2-q8';

// Committed slot-extraction wording from namepass.ts (verbatim).
const SYSTEM =
  'You read passages from a novel and list relationships between the named person and other specific people. ' +
  'Reply with JSON only: an array like [{"other": "<name as written>", "tie": "<relationship in a few words>", ' +
  '"passage": <number>, "quote": "<exact span copied character for character from that passage>", ' +
  '"strength": <0-1 how strongly the passage states this tie>, "why": "<one sentence>", ' +
  '"missing": "<what would settle it>"}]. ' +
  'The quote must be copied exactly from the passage it cites; never invent, paraphrase or stitch. ' +
  'Name only people the passages actually show; if none, reply [].';

const fold = (s: string): string => String(s ?? '').replace(/[\u2018\u2019]/g, "'").toLowerCase();

/** Earliest, latest, evenly between, capped at 4. */
function spreadPick(ids: number[]): number[] {
  if (ids.length <= PACKET_CAP) return [...ids];
  const out = new Set<number>([ids[0]!, ids[ids.length - 1]!]);
  const inner = ids.slice(1, -1);
  const step = inner.length / (PACKET_CAP - 2);
  for (let k = 0; k < PACKET_CAP - 2; k++) out.add(inner[Math.min(inner.length - 1, Math.floor(k * step + step / 2))]!);
  return [...ids.filter((id) => out.has(id))].slice(0, PACKET_CAP);
}

function fail(message: string): never {
  throw new Error(`cover-read: ${message}`);
}

interface CoverEntry {
  id: number;
  mentions: number;
  passages: { chunk: number; locator: string }[];
}

export function list(): CoverEntry[] {
  const db = new DatabaseSync(resolve(LIVE), { readOnly: true });
  try {
    const dbLike = {
      all: <T>(sql: string, ...params: unknown[]): T[] => db.prepare(sql).all(...params) as T[],
    };
    const project = db.prepare('SELECT id FROM project WHERE name = ?').get(PROJECT) as { id: number };
    const covered = new Set<number>();
    for (const row of dbLike.all<{ from_entity: number; to_entity: number }>(
      `SELECT from_entity, to_entity FROM canon_relation
        WHERE project_id = ? AND review_status IN ('accepted','attested','user_confirmed')`,
      project.id,
    )) {
      covered.add(row.from_entity);
      covered.add(row.to_entity);
    }
    const people = dbLike.all<{ id: number; name: string; aliases: string; mentions: number }>(
      `SELECT id, name, aliases, mentions FROM canon_entity
        WHERE project_id = ? AND kind = 'character' ORDER BY id`,
      project.id,
    );
    const chunks = dbLike.all<{ id: number; seq: number; locator: string; text: string }>(
      'SELECT id, seq, locator, text FROM canon_chunk WHERE project_id = ? ORDER BY seq',
      project.id,
    );
    const aliasList = (json: string): string[] => {
      try {
        const list = JSON.parse(json || '[]') as unknown[];
        return Array.isArray(list) ? list.map(String).filter(Boolean) : [];
      } catch {
        return [];
      }
    };
    // Roster forms per person for co-mention detection.
    const formsOf = new Map<number, string[]>();
    for (const p of people) {
      const forms = [p.name, ...aliasList(p.aliases), ...explicitVariants(p.name, aliasList(p.aliases))];
      formsOf.set(p.id, [...new Set(forms.map((f) => fold(f).trim()).filter((f) => f.length > 2))]);
    }
    // Cited chunks per person (deprioritized, not excluded).
    const cited = new Map<number, Set<number>>();
    for (const row of dbLike.all<{ from_entity: number; to_entity: number; source_refs: string }>(
      'SELECT from_entity, to_entity, source_refs FROM canon_relation WHERE project_id = ?',
      project.id,
    )) {
      try {
        const refs = JSON.parse(row.source_refs || '[]') as { chunk?: unknown }[];
        for (const pid of [row.from_entity, row.to_entity]) {
          const set = cited.get(pid) ?? new Set<number>();
          for (const ref of refs) {
            const n = Number(ref?.chunk);
            if (Number.isFinite(n) && n > 0) set.add(n);
          }
          cited.set(pid, set);
        }
      } catch {
        /* unparseable refs cite nothing */
      }
    }
    const entries: CoverEntry[] = [];
    for (const p of people) {
      if (covered.has(p.id)) continue;
      const mine = formsOf.get(p.id) ?? [];
      const hits: number[] = [];
      const chunkPersons = new Map<number, Set<number>>();
      for (const c of chunks) {
        const text = fold(c.text);
        if (!mine.some((f) => text.includes(f))) continue;
        hits.push(c.id);
        const set = new Set<number>();
        for (const [pid2, forms] of formsOf) {
          if (forms.some((f) => text.includes(f))) set.add(pid2);
        }
        chunkPersons.set(c.id, set);
      }
      // Co-mention chunks first (another character present), uncited first.
      const byId = new Map(chunks.map((c) => [c.id, c]));
      const co = hits.filter((id) => (chunkPersons.get(id)?.size ?? 0) >= 2);
      const citedSet = cited.get(p.id) ?? new Set<number>();
      const rank = (ids: number[]): number[] =>
        [...ids].sort((a, b) => Number(citedSet.has(a)) - Number(citedSet.has(b)));
      const picked = spreadPick(rank(co.length ? co : hits));
      entries.push({
        id: p.id,
        mentions: p.mentions,
        passages: picked.map((id) => ({ chunk: id, locator: byId.get(id)?.locator ?? '' })),
      });
    }
    mkdirSync(TRACK, { recursive: true });
    writeFileSync(COVER_JSON, JSON.stringify({ names: entries.length, entries }, null, 1));
    const withCo = entries.filter((e) => e.passages.length > 0).length;
    console.log(`list: uncovered ${entries.length} withPassages ${withCo} manifest ${COVER_JSON}`);
    return entries;
  } finally {
    db.close();
  }
}

interface ReadCounts {
  names: number;
  calls: number;
  callErrors: number;
  items: number;
  inserted: number;
  skipped: Record<string, number>;
  openEnds: number;
}

export async function read(): Promise<ReadCounts> {
  // Backup before any live write; user_confirmed guarded both sides.
  const liveDir = dirname(resolve(LIVE));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(resolve(LIVE), resolve(liveDir, `fanfable.db.backup-${stamp}`));
  console.log(`backup: fanfable.db.backup-${stamp}`);
  const counts: ReadCounts = { names: 0, calls: 0, callErrors: 0, items: 0, inserted: 0, skipped: {}, openEnds: 0 };
  const skip = (reason: string): void => {
    counts.skipped[reason] = (counts.skipped[reason] ?? 0) + 1;
  };
  if (!existsSync(COVER_JSON)) fail(`no ${COVER_JSON} (run list first)`);
  const { entries } = JSON.parse(readFileSync(COVER_JSON, 'utf8')) as { entries: CoverEntry[] };
  const db = new Db(resolve(LIVE));
  try {
    const project = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', PROJECT);
    if (!project) fail(`no project ${PROJECT}`);
    const pid = project.id;
    const guard = (): number =>
      db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM canon_relation WHERE review_status='user_confirmed'`)!.n;
    if (guard() !== 34) fail(`user_confirmed baseline moved before reads (got ${guard()})`);
    const context = loadIdentityContext(db, pid);
    const resolver = createResolver(context);
    const characters = context.entities.filter((e) => e.kind === 'character');
    const chunks = db.all<{ id: number; locator: string; text: string }>(
      'SELECT id, locator, text FROM canon_chunk WHERE project_id = ? ORDER BY seq',
      pid,
    );
    const byChunk = new Map(chunks.map((c) => [c.id, c]));
    const people = new Map(
      db
        .all<{ id: number; name: string }>(`SELECT id, name FROM canon_entity WHERE project_id = ? AND kind='character'`, pid)
        .map((p) => [p.id, p.name] as [number, string]),
    );
    for (const entry of entries) {
      counts.names++;
      const personName = people.get(entry.id) ?? '';
      if (!entry.passages.length) {
        skip('no-passages');
        continue;
      }
      const block = entry.passages
        .map((p, i) => `### P${i + 1} (chunk ${p.chunk}, ${p.locator})\n${byChunk.get(p.chunk)?.text ?? ''}`)
        .join('\n\n');
      let items: {
        other?: unknown;
        tie?: unknown;
        passage?: unknown;
        quote?: unknown;
        strength?: unknown;
        why?: unknown;
        missing?: unknown;
      }[] = [];
      try {
        counts.calls++;
        const res = await fetch(`${OLLAMA}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: MODEL,
            messages: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: `PERSON: ${personName}\n\nPASSAGES:\n${block}` },
            ],
            think: false,
            stream: false,
            options: { temperature: 0, seed: 42, num_predict: 2048 },
          }),
        });
        if (!res.ok) throw new Error(`ollama ${res.status}`);
        const data = (await res.json()) as { message?: { content?: string } };
        const parsed = extractJson<unknown>(data.message?.content ?? '');
        items = Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        counts.callErrors++;
        skip('call-error');
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
          const chunkId = entry.passages[(Number(item.passage) || 1) - 1]?.chunk ?? entry.passages[0]!.chunk;
          const chunk = byChunk.get(chunkId);
          if (!chunk || !isVerbatimInChunk(chunk.text, quote)) {
            skip('not-verbatim');
            continue;
          }
          if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
            skip('bad-strength');
            continue;
          }
          const r = resolver.resolve(otherName);
          if (r.status !== 'resolved' || r.id === null || !characters.some((e) => e.id === r.id)) {
            const thread = db.get<{ id: number }>(
              `SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'person' AND a_entity = ? AND parent_a_thread IS NULL`,
              pid,
              entry.id,
            );
            if (thread) {
              const q = `who is ${otherName} (${tie} of ${personName})?`;
              if (!db.get<{ id: number }>('SELECT id FROM canon_open_end WHERE thread_id = ? AND question = ?', thread.id, q)) {
                db.run(
                  `INSERT INTO canon_open_end (project_id, thread_id, question, origin, would_resolve, status, created_at)
                   VALUES (?, ?, ?, 'cover-read', 'a passage naming them', 'open', ?)`,
                  pid,
                  thread.id,
                  q,
                  new Date().toISOString(),
                );
                counts.openEnds++;
              }
            }
            skip(r.status === 'ambiguous' ? 'ambiguous-other' : 'unresolved-other');
            continue;
          }
          if (r.id === entry.id) {
            skip('same-person');
            continue;
          }
          // Dedupe: the bank holds one kind-less row per pair (unique index on
          // pair + kind), so any kind-less row for the pair blocks a new one
          // whatever its span; same-span duplicates of kinded rows block too.
          const dup = db.get<{ id: number }>(
            `SELECT r.id FROM canon_relation r WHERE r.project_id = ?
               AND ((r.from_entity = ? AND r.to_entity = ?) OR (r.from_entity = ? AND r.to_entity = ?))
               AND (r.kind = '' OR r.evidence = ?) LIMIT 1`,
            pid,
            entry.id,
            r.id,
            r.id,
            entry.id,
            quote,
          );
          if (dup) {
            skip('duplicate');
            continue;
          }
          insertRelation(db, pid, {
            fromEntity: entry.id,
            toEntity: r.id,
            kind: '',
            description: `[cover-read] ${String(item.why ?? '').slice(0, 300)}`,
            evidence: quote,
            sourceRefs: JSON.stringify([{ chunk: chunk.id, locator: chunk.locator }]),
            reviewStatus: 'needs_review',
            confidence: 0,
          });
          counts.inserted++;
        }
      });
      if (counts.names % 25 === 0) console.log(`...${counts.names}/${entries.length} names, ${counts.inserted} rows`);
    }
    if (guard() !== 34) fail(`user_confirmed moved during reads (got ${guard()})`);
    writeFileSync(`${TRACK}/cover-read.json`, JSON.stringify(counts, null, 1));
    console.log(
      `read: names ${counts.names} calls ${counts.calls} errors ${counts.callErrors} ` +
        `items ${counts.items} inserted ${counts.inserted} openEnds ${counts.openEnds}`,
    );
    console.log(`read: skipped ${JSON.stringify(counts.skipped)}`);
    return counts;
  } finally {
    db.close();
  }
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('cover-read.ts')) {
  const step = process.argv[2] ?? 'all';
  (async () => {
    if (step === 'list') list();
    else if (step === 'read') await read();
    else if (step === 'all') {
      list();
      await read();
    } else console.error(`cover-read: unknown step "${step}"`);
  })().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
