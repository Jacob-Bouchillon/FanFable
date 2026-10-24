/**
 * Extracted book lore.
 *
 * The text index tells you *where* something was said. This module pulls
 * *what the book says* out into structured form: the people, places, things
 * and rules that exist, the relationships between them, the facts the source
 * supports, and the book's own timeline.
 *
 * Every entry keeps the passages it came from, so nothing here is a black box:
 * the UI can show the evidence, and the writer can be grounded in facts rather
 * than in a wall of retrieved text.
 */
import { Db, nowIso, strList, toJson } from './db.ts';
import { asRecordArray, extractJson, salvageJsonArray, toStringArray } from './json.ts';
import type { LlmClient } from './llm.ts';
import { truncate } from './text.ts';

/* ------------------------------------------------------------------ models */

export type EntityKind = 'character' | 'location' | 'item' | 'rule' | 'faction' | 'creature';

export interface CanonEntity {
  id: number;
  kind: EntityKind;
  name: string;
  aliases: string[];
  summary: string;
  attributes: Record<string, string>;
  role: string;
  status: string;
  firstChunk: number | null;
  evidence: string;
  sourceRefs: { source: string; locator: string }[];
  mentions: number;
}

export interface CanonRelation {
  id: number;
  fromId: number;
  fromName: string;
  toId: number;
  toName: string;
  kind: string;
  description: string;
  evidence: string;
}

export interface CanonFact {
  id: number;
  topic: string;
  statement: string;
  kind: string;
  certainty: string;
  subject: string;
  evidence: string;
  sourceRefs: { source: string; locator: string }[];
}

export interface CanonTimelineEntry {
  id: number;
  eventId: number | null;
  seq: number;
  title: string;
  summary: string;
  when: string;
  participants: string[];
  location: string;
  evidence: string;
}

/* ------------------------------------------------------------- extraction */

const EXTRACT_SYSTEM = `You read passages from a book and record what the book establishes, as structured notes.

Reply with JSON only:
{
  "entities": [
    {"kind":"character|location|item|rule|faction|creature",
     "name":"the name as the book gives it",
     "aliases":["other names or titles"],
     "summary":"one or two sentences on who or what this is",
     "attributes":{"any":"kind specific detail"},
     "role":"their role in the story, if it is a person",
     "status":"alive, dead, missing, ruined, unknown — if the book says",
     "chunk_index": 0,
     "evidence":"a short exact quote from the passage"}
  ],
  "relations": [
    {"from":"name","to":"name","kind":"one short phrase, such as 'sibling of'",
     "description":"one sentence","chunk_index":0,"evidence":"a short exact quote"}
  ],
  "facts": [
    {"topic":"the subject of the fact","statement":"what the book establishes",
     "kind":"rule|fact|background","certainty":"confirmed|inferred","subject":"name it concerns",
     "chunk_index":0,"evidence":"a short exact quote"}
  ],
  "timeline": [
    {"title":"what happens","summary":"one or two sentences","when":"when it happens, in the book's words",
     "participants":["names"],"location":"where","chunk_index":0,"evidence":"a short exact quote"}
  ]
}

Rules:
- Only record what these passages support. Never fill gaps with general knowledge.
- chunk_index is the number shown in front of each passage. Use it for every entry.
- evidence must be a short phrase that appears in the passage, not your own words.
- One relation per entry, with one kind. If two people have several relationships,
  write a separate entry for each.
- The direction matters: "from" is the one who has the relationship and "to" is
  the one it is to. If Harry is Petunia's nephew, it is from="Harry Potter",
  to="Aunt Petunia", kind="nephew of".
- If the passages contain no new people or facts, return empty arrays.
- No prose outside the JSON.`;

export interface ExtractWindowProgress {
  phase: 'lore';
  done: number;
  total: number;
  passagesDone: number;
  passagesTotal: number;
}

export interface ExtractOptions {
  sourceId?: number;
  /** How many passages to send in one request. */
  windowSize?: number;
  /** How many windows to read at the same time. */
  concurrency?: number;
  /** Only process passages that have not been extracted yet (default on). */
  incremental?: boolean;
  /**
   * How many tokens the model may use for one window.
   *
   * A verbose model can run out of tokens half way through the answer, and
   * then the window yields nothing at all. Raising this is cheaper than
   * losing a window.
   */
  maxTokens?: number;
  onProgress?: (message: string) => void;
  /** Structured window counts, for a progress monitor rather than the console. */
  onWindow?: (progress: ExtractWindowProgress) => void;
}

interface ChunkRow {
  id: number;
  seq: number;
  heading: string;
  locator: string;
  text: string;
  source_title: string;
  path: string;
  source_id: number;
}

/**
 * Read the imported material and record its lore.
 *
 * Runs in windows of passages so a whole book does not have to fit in the
 * context, and keeps a record of which passages were already processed.
 */
export async function extractLore(
  db: Db,
  llm: LlmClient,
  projectId: number,
  opts: ExtractOptions = {},
): Promise<{ entities: number; relations: number; facts: number; timeline: number; passages: number }> {
  const windowSize = opts.windowSize ?? 8;
  const params: unknown[] = [projectId];
  let sql = `SELECT c.id, c.seq, c.heading, c.locator, c.text, s.title AS source_title, s.path, c.source_id
             FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id
             WHERE c.project_id = ?`;
  if (opts.sourceId) {
    sql += ' AND c.source_id = ?';
    params.push(opts.sourceId);
  }
  sql += ' ORDER BY c.source_id, c.seq';
  const chunks = db.all<ChunkRow>(sql, ...params);
  if (!chunks.length) {
    return { entities: 0, relations: 0, facts: 0, timeline: 0, passages: 0 };
  }

  // Passages that have already been mined are skipped, so re-running the
  // extraction over a long book is cheap.
  const mined = new Set(
    db
      .all<{ id: number }>('SELECT id FROM canon_chunk WHERE project_id = ? AND lore_mined = 1', projectId)
      .map((r) => r.id),
  );

  const stats = { entities: 0, relations: 0, facts: 0, timeline: 0, passages: 0 };
  const entityIdByName = new Map<string, number>();

  // Every passage of the project, so a quote that belongs to a neighbouring
  // passage can be found and its reference corrected.
  const allChunks = db.all<{
    id: number;
    seq: number;
    source_id: number;
    text: string;
    locator: string;
    source_title: string;
  }>(
    `SELECT c.id, c.seq, c.source_id, c.text, c.locator, s.title AS source_title
     FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id
     WHERE c.project_id = ? ORDER BY c.source_id, c.seq`,
    projectId,
  );
  const chunkById = new Map(allChunks.map((c) => [c.id, c as ChunkRow]));
  const neighboursOf = (id: number | undefined): ChunkRow[] => {
    const chunk = id === undefined ? undefined : chunkById.get(id);
    if (!chunk) return [];
    const out: ChunkRow[] = [];
    for (const candidate of allChunks) {
      if (candidate.source_id !== chunk.source_id) continue;
      if (Math.abs(candidate.seq - chunk.seq) <= 2) out.push(candidate as ChunkRow);
    }
    return out;
  };
  const windows: ChunkRow[][] = [];
  for (let start = 0; start < chunks.length; start += windowSize) {
    const window = chunks.slice(start, start + windowSize);
    if (opts.incremental !== false && window.every((c) => mined.has(c.id))) continue;
    windows.push(window);
  }
  if (!windows.length) {
    opts.onProgress?.('everything has already been read');
    return stats;
  }

  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 4));
  const maxTokens = opts.maxTokens ?? 3000;
  let done = 0;

  for (let batch = 0; batch < windows.length; batch += concurrency) {
    const group = windows.slice(batch, batch + concurrency);
    await Promise.all(
      group.map(async (window) => {
        const found = await extractWindow(db, llm, projectId, window, entityIdByName, stats, neighboursOf, maxTokens);
        for (const c of window) db.run('UPDATE canon_chunk SET lore_mined = 1 WHERE id = ?', c.id);
        done++;
        opts.onProgress?.(
          `read ${done}/${windows.length} windows (${done * windowSize} of ${chunks.length} passages)`,
        );
        opts.onWindow?.({
          phase: 'lore',
          done,
          total: windows.length,
          passagesDone: Math.min(done * windowSize, chunks.length),
          passagesTotal: chunks.length,
        });
        return found;
      }),
    );
  }

  // Fold any duplicates left by earlier runs into one row per pair.
  dedupeRelations(db, projectId);
  mergeCanonEntities(db, projectId);

  return stats;
}

/** One relation per pair: keep the most detailed description. */
function dedupeRelations(db: Db, projectId: number): void {
  const rows = db.all<{ id: number; from_entity: number; to_entity: number; kind: string; description: string }>(
    'SELECT id, from_entity, to_entity, kind, description FROM canon_relation WHERE project_id = ? ORDER BY id',
    projectId,
  );
  const seen = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    // The same pair can hold several relationships, so the kind is part of the key.
    const key = `${row.from_entity}:${row.to_entity}:${row.kind}`;
    const first = seen.get(key);
    if (!first) {
      seen.set(key, row);
      continue;
    }
    if (row.description.length > first.description.length) {
      db.run('UPDATE canon_relation SET kind = ?, description = ? WHERE id = ?', row.kind, row.description, first.id);
    }
    db.run('DELETE FROM canon_relation WHERE id = ?', row.id);
  }
}

/**
 * Recover the complete records from one section of a truncated answer.
 *
 * A model that runs out of tokens leaves the JSON unfinished. The records it
 * did finish are good, and the section that was cut off is the part that is
 * missing — usually the relations, because they come last. Without this, one
 * long window loses everything it produced.
 */
function salvageSection(text: string, key: string): Record<string, unknown>[] {
  const at = (text ?? '').indexOf(`"${key}"`);
  if (at < 0) return [];
  const open = text.indexOf('[', at);
  if (open < 0) return [];
  return salvageJsonArray(text.slice(open));
}

/**
 * The four sections of an extraction answer.
 *
 * A complete answer is used as it is. A truncated one is salvaged section by
 * section, so the parts the model finished are kept.
 */
function parseExtraction(text: string): {
  entities: Record<string, unknown>[];
  relations: Record<string, unknown>[];
  facts: Record<string, unknown>[];
  timeline: Record<string, unknown>[];
} {
  const parsed = extractJson<Record<string, unknown>>(text);
  if (parsed && typeof parsed === 'object') {
    const whole = {
      entities: asRecordArray(parsed.entities),
      relations: asRecordArray(parsed.relations),
      facts: asRecordArray(parsed.facts),
      timeline: asRecordArray(parsed.timeline),
    };
    if (whole.entities.length || whole.relations.length || whole.facts.length || whole.timeline.length) {
      return whole;
    }
  }
  return {
    entities: salvageSection(text, 'entities'),
    relations: salvageSection(text, 'relations'),
    facts: salvageSection(text, 'facts'),
    timeline: salvageSection(text, 'timeline'),
  };
}

/** Read one window of passages and record what it contains. */
async function extractWindow(
  db: Db,
  llm: LlmClient,
  projectId: number,
  window: ChunkRow[],
  entityIdByName: Map<string, number>,
  stats: { entities: number; relations: number; facts: number; timeline: number; passages: number },
  neighboursOf: (id: number | undefined) => ChunkRow[] = () => [],
  maxTokens = 3000,
): Promise<void> {
  {

    let parsed: {
      entities: Record<string, unknown>[];
      relations: Record<string, unknown>[];
      facts: Record<string, unknown>[];
      timeline: Record<string, unknown>[];
    } = { entities: [], relations: [], facts: [], timeline: [] };
    try {
      const res = await llm.chat({
        system: EXTRACT_SYSTEM,
        messages: [
          {
            role: 'user',
            content:
              'PASSAGES:\n' +
              window
                .map(
                  (c, i) =>
                    `[#${i}] ${c.source_title} | ${c.locator}\n${truncate(c.text, 1400)}`,
                )
                .join('\n\n'),
          },
        ],
        temperature: 0.1,
        maxTokens,
      });
      parsed = parseExtraction(res.text);
    } catch {
      return; // a bad window should not abort the whole extraction
    }

    const chunkAt = (idx: unknown): ChunkRow | undefined => {
      const i = Number(idx);
      return Number.isFinite(i) ? window[i] : undefined;
    };
    const refsFor = (chunk: ChunkRow | undefined) =>
      chunk ? [{ source: chunk.source_title, locator: chunk.locator }] : [];

    for (const raw of parsed.entities) {
      const name = String(raw.name ?? '').trim();
      if (!name) continue;
      const kind = normaliseKind(String(raw.kind ?? 'character'));
      const chunk = chunkAt(raw.chunk_index);
      const found = verifyQuote(raw.evidence, chunk, neighboursOf(chunk?.id));
      const evidence = found.quote;
      const refs = found.chunkId !== null ? [{ source: found.source, locator: found.locator, chunk: found.chunkId }] : refsFor(chunk);
      const existing = entityIdByName.get(key(name)) ?? findEntityId(db, projectId, kind, name);
      const attributes = (raw.attributes ?? {}) as Record<string, unknown>;
      if (existing) {
        db.run(
          `UPDATE canon_entity SET summary = ?, role = ?, status = ?, attributes = ?, evidence = ?,
                  source_refs = ?, mentions = mentions + 1, updated_at = ? WHERE id = ?`,
          String(raw.summary ?? '').trim(),
          String(raw.role ?? '').trim(),
          String(raw.status ?? '').trim(),
          toJson(Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k, String(v)]))),
          evidence,
          toJson(refs),
          nowIso(),
          existing,
        );
        entityIdByName.set(key(name), existing);
        continue;
      }
      db.run(
        `INSERT OR IGNORE INTO canon_entity (project_id, kind, name, aliases, summary, attributes, role, status,
                                   first_chunk, evidence, source_refs, mentions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        projectId,
        kind,
        name,
        toJson(toStringArray(raw.aliases)),
        String(raw.summary ?? '').trim(),
        toJson(Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k, String(v)]))),
        String(raw.role ?? '').trim(),
        String(raw.status ?? '').trim(),
        found.chunkId ?? chunk?.id ?? null,
        evidence,
        toJson(refs),
        nowIso(),
        nowIso(),
      );
      const row = db.get<{ id: number }>(
        'SELECT id FROM canon_entity WHERE project_id = ? AND kind = ? AND lower(name) = lower(?)',
        projectId,
        kind,
        name,
      );
      if (row) {
        entityIdByName.set(key(name), row.id);
        stats.entities++;
      }
    }

    for (const raw of parsed.relations) {
      const fromId = resolveEntity(db, projectId, entityIdByName, String(raw.from ?? ''));
      const toId = resolveEntity(db, projectId, entityIdByName, String(raw.to ?? ''));
      if (!fromId || !toId || fromId === toId) continue;
      const chunk = chunkAt(raw.chunk_index);
      const kinds = normaliseKinds(String(raw.kind ?? ''));
      const foundRelation = verifyQuote(raw.evidence, chunk, neighboursOf(chunk?.id));
      const relationEvidence = foundRelation.quote;
      const relationRefs = foundRelation.chunkId !== null
        ? [{ source: foundRelation.source, locator: foundRelation.locator, chunk: foundRelation.chunkId }]
        : refsFor(chunk);
      for (const kind of kinds) {
      const existing = db.get<{ id: number; kind: string; description: string; evidence: string }>(
        'SELECT id, kind, description, evidence FROM canon_relation WHERE project_id = ? AND from_entity = ? AND to_entity = ? AND kind = ?',
        projectId,
        fromId,
        toId,
        kind,
      );
      if (existing) {
        // One relation per pair: keep the richer description rather than
        // accumulating near-duplicates across extraction runs.
        const description = String(raw.description ?? '').trim();
        db.run(
          'UPDATE canon_relation SET kind = ?, description = ?, evidence = ? WHERE id = ?',
          existing.kind || kind,
          description.length > existing.description.length ? description : existing.description,
          relationEvidence || existing.evidence,
          existing.id,
        );
      } else {
        db.run(
          `INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, evidence, source_refs, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          projectId,
          fromId,
          toId,
          kind,
          String(raw.description ?? '').trim(),
          relationEvidence,
          toJson(relationRefs),
          nowIso(),
        );
        stats.relations++;
      }
      }
    }

    for (const raw of parsed.facts) {
      const statement = String(raw.statement ?? '').trim();
      if (!statement) continue;
      const chunk = chunkAt(raw.chunk_index);
      const topic = String(raw.topic ?? '').trim();
      const dup = db.get<{ id: number }>(
        'SELECT id FROM canon_fact WHERE project_id = ? AND statement = ?',
        projectId,
        statement,
      );
      if (dup) continue;
      db.run(
        `INSERT INTO canon_fact (project_id, topic, statement, kind, certainty, subject, evidence, source_refs, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        projectId,
        topic,
        statement,
        String(raw.kind ?? 'fact').trim(),
        String(raw.certainty ?? 'confirmed').trim(),
        String(raw.subject ?? '').trim(),
        verifyQuote(raw.evidence, chunk, neighboursOf(chunk?.id)).quote,
        toJson(refsFor(chunk)),
        nowIso(),
      );
      stats.facts++;
    }

    for (const raw of parsed.timeline) {
      const title = String(raw.title ?? '').trim();
      if (!title) continue;
      const chunk = chunkAt(raw.chunk_index);
      const dup = db.get<{ id: number }>('SELECT id FROM canon_timeline WHERE project_id = ? AND title = ?', projectId, title);
      if (dup) continue;
      const seq = db.get<{ n: number | null }>('SELECT MAX(seq) AS n FROM canon_timeline WHERE project_id = ?', projectId);
      db.run(
        `INSERT INTO canon_timeline (project_id, canon_event, seq, title, summary, time_label, participants, location, evidence, source_refs, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        projectId,
        (seq?.n ?? 0) + 1,
        title,
        String(raw.summary ?? '').trim(),
        String(raw.when ?? '').trim(),
        toJson(toStringArray(raw.participants)),
        String(raw.location ?? '').trim(),
        String(raw.evidence ?? '').trim(),
        toJson(refsFor(chunk)),
        nowIso(),
      );
      stats.timeline++;
    }

    stats.passages += window.length;
  }
}

/**
 * Keep an evidence quote only if it really appears in the source.
 *
 * Models paraphrase when they are asked for a quote, and they often quote a
 * neighbouring passage while citing the current one. Both are recoverable:
 * a quote that is not in the cited passage is looked for in the passages
 * around it, and the reference is corrected to where it actually is.
 *
 * A quote that appears nowhere is dropped: a fabricated citation is worse
 * than no citation.
 */
function verifyQuote(
  raw: unknown,
  chunk: ChunkRow | undefined,
  neighbours: ChunkRow[] = [],
): { quote: string; chunkId: number | null; source: string; locator: string } {
  const text = String(raw ?? '').trim();
  const empty = { quote: '', chunkId: chunk?.id ?? null, source: chunk?.source_title ?? '', locator: chunk?.locator ?? '' };
  if (!text || !chunk) return empty;

  const needle = normalise(text);
  if (!needle) return empty;

  const search = (target: ChunkRow | undefined): boolean => {
    if (!target) return false;
    return normalise(target.text).includes(needle);
  };

  if (search(chunk)) {
    return { quote: text, chunkId: chunk.id, source: chunk.source_title, locator: chunk.locator };
  }
  // The model may have added a prefix or a trailing full stop.
  const words = needle.split(' ').slice(0, 6).join(' ');
  if (words.length > 8) {
    const partial = (target: ChunkRow | undefined): boolean => {
      if (!target) return false;
      return normalise(target.text).includes(words);
    };
    if (partial(chunk)) {
      return { quote: text, chunkId: chunk.id, source: chunk.source_title, locator: chunk.locator };
    }
    // Look in the passages around the cited one.
    for (const candidate of neighbours) {
      if (candidate.id === chunk.id) continue;
      if (partial(candidate)) {
        return {
          quote: text,
          chunkId: candidate.id,
          source: candidate.source_title,
          locator: candidate.locator,
        };
      }
    }
  }
  return empty;
}

/** Normalise a string for comparison: letters and digits, single spaces. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Are two names the same person under two names?
 *
 * "Serena" and "Serena Marsh" are the same; so are "Hagrid" and "Rubeus
 * Hagrid". The shorter name has to appear as a whole word in the longer one,
 * so "Ann" and "Anna" are not merged.
 */
function isNameVariant(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short === long) return true;
  return long.split(/\s+/).includes(short);
}

/**
 * Merge entities that are the same thing under two names.
 *
 * Books are full of "Aunt Petunia" and "Aunt Petunia Dursley"; the index
 * should hold one person, not two.
 */
export function mergeCanonEntities(db: Db, projectId: number): string[] {
  const merged: string[] = [];
  for (let guard = 0; guard < 100; guard++) {
    const entities = listEntities(db, projectId);
    let pair: { keep: CanonEntity; drop: CanonEntity } | null = null;
    for (const a of entities) {
      for (const b of entities) {
        if (a.id === b.id) continue;
        const la = a.name.toLowerCase();
        const lb = b.name.toLowerCase();
        if (!isNameVariant(la, lb)) continue;
        pair = la.length >= lb.length ? { keep: a, drop: b } : { keep: b, drop: a };
        break;
      }
      if (pair) break;
    }
    if (!pair) break;

    const { keep, drop } = pair;
    db.transaction(() => {
      const aliases = [...keep.aliases, drop.name, ...drop.aliases].filter(
        (al, i, arr) =>
          al.toLowerCase() !== keep.name.toLowerCase() &&
          arr.findIndex((x) => x.toLowerCase() === al.toLowerCase()) === i,
      );
      db.run(
        'UPDATE canon_entity SET aliases = ?, summary = ?, role = ?, status = ?, mentions = mentions + ?, updated_at = ? WHERE id = ?',
        toJson(aliases),
        keep.summary || drop.summary,
        keep.role || drop.role,
        keep.status || drop.status,
        drop.mentions,
        nowIso(),
        keep.id,
      );
      // Move relations over, and drop the ones that would now be duplicates.
      const rels = db.all<{ id: number; from_entity: number; to_entity: number; kind: string; description: string; evidence: string }>(
        'SELECT id, from_entity, to_entity, kind, description, evidence FROM canon_relation WHERE project_id = ? AND (from_entity = ? OR to_entity = ?)',
        projectId,
        drop.id,
        drop.id,
      );
      for (const r of rels) {
        const from = r.from_entity === drop.id ? keep.id : r.from_entity;
        const to = r.to_entity === drop.id ? keep.id : r.to_entity;
        if (from === to) {
          db.run('DELETE FROM canon_relation WHERE id = ?', r.id);
          continue;
        }
        const existing = db.get<{ id: number }>(
          'SELECT id FROM canon_relation WHERE project_id = ? AND from_entity = ? AND to_entity = ?',
          projectId,
          from,
          to,
        );
        if (existing) {
          db.run('DELETE FROM canon_relation WHERE id = ?', r.id);
        } else {
          db.run('UPDATE canon_relation SET from_entity = ?, to_entity = ? WHERE id = ?', from, to, r.id);
        }
      }
      db.run('UPDATE canon_fact SET subject = ? WHERE project_id = ? AND subject = ?', keep.name, projectId, drop.name);
      db.run('DELETE FROM canon_entity WHERE id = ?', drop.id);
    });
    merged.push(`${drop.name} -> ${keep.name}`);
  }
  return merged;
}

/**
 * Split a relation kind into single kinds.
 *
 * Models sometimes return several relationships in one field ("sibling of |
 * friend of"), and sometimes return the list of examples from the prompt. The
 * first is split apart; the second is dropped, because a row of every possible
 * relationship says nothing.
 */
export function normaliseKinds(kind: string): string[] {
  const raw = (kind ?? '').trim();
  if (!raw) return ['related to'];
  const parts = raw
    .split(/[|;,]/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const useful = parts.filter((p) => p.length > 1 && p.length <= 40 && !p.includes('...'));
  if (!useful.length) return ['related to'];
  // A row of many different relationship words is the example list, not data.
  const distinct = new Set(useful);
  if (distinct.size >= 4) return ['related to'];
  return useful;
}

function normaliseKind(kind: string): EntityKind {
  const k = kind.toLowerCase();
  if (k.includes('loc') || k.includes('place')) return 'location';
  if (k.includes('item') || k.includes('object') || k.includes('thing')) return 'item';
  if (k.includes('rule') || k.includes('law') || k.includes('magic') || k.includes('lore')) return 'rule';
  if (k.includes('faction') || k.includes('group') || k.includes('family')) return 'faction';
  if (k.includes('creature') || k.includes('animal') || k.includes('beast')) return 'creature';
  return 'character';
}

function key(name: string): string {
  return name.trim().toLowerCase();
}

function findEntityId(db: Db, projectId: number, kind: EntityKind, name: string): number | undefined {
  const row = db.get<{ id: number }>(
    'SELECT id FROM canon_entity WHERE project_id = ? AND kind = ? AND lower(name) = lower(?)',
    projectId,
    kind,
    name,
  );
  if (row) return row.id;
  const alias = db.get<{ id: number }>(
    `SELECT id FROM canon_entity WHERE project_id = ? AND lower(name) = lower(?)`,
    projectId,
    name,
  );
  return alias?.id;
}

function resolveEntity(
  db: Db,
  projectId: number,
  cache: Map<string, number>,
  name: string,
): number | undefined {
  const clean = name.trim();
  if (!clean) return undefined;
  const cached = cache.get(key(clean));
  if (cached) return cached;
  const found = findEntityId(db, projectId, 'character', clean)
    ?? db.get<{ id: number }>('SELECT id FROM canon_entity WHERE project_id = ? AND lower(name) = lower(?)', projectId, clean)?.id;
  if (found) cache.set(key(clean), found);
  return found;
}

/* ------------------------------------------------------------- retrieval */

export function listEntities(db: Db, projectId: number, kind?: EntityKind): CanonEntity[] {
  const params: unknown[] = [projectId];
  let sql = 'SELECT * FROM canon_entity WHERE project_id = ?';
  if (kind) {
    sql += ' AND kind = ?';
    params.push(kind);
  }
  sql += ' ORDER BY kind, name';
  const rows = db.all<{
    id: number;
    kind: string;
    name: string;
    aliases: string;
    summary: string;
    attributes: string;
    role: string;
    status: string;
    first_chunk: number | null;
    evidence: string;
    source_refs: string;
    mentions: number;
  }>(sql, ...params);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as EntityKind,
    name: r.name,
    aliases: strList(r.aliases),
    summary: r.summary,
    attributes: JSON.parse(r.attributes || '{}') as Record<string, string>,
    role: r.role,
    status: r.status,
    firstChunk: r.first_chunk,
    evidence: r.evidence,
    sourceRefs: JSON.parse(r.source_refs || '[]') as { source: string; locator: string }[],
    mentions: r.mentions,
  }));
}

export function listRelations(db: Db, projectId: number): CanonRelation[] {
  const rows = db.all<{
    id: number;
    from_entity: number;
    to_entity: number;
    kind: string;
    description: string;
    evidence: string;
    from_name: string;
    to_name: string;
  }>(
    `SELECT r.id, r.from_entity, r.to_entity, r.kind, r.description, r.evidence,
            a.name AS from_name, b.name AS to_name
     FROM canon_relation r
     JOIN canon_entity a ON a.id = r.from_entity
     JOIN canon_entity b ON b.id = r.to_entity
     WHERE r.project_id = ? ORDER BY r.id`,
    projectId,
  );
  return rows.map((r) => ({
    id: r.id,
    fromId: r.from_entity,
    fromName: r.from_name,
    toId: r.to_entity,
    toName: r.to_name,
    kind: r.kind,
    description: r.description,
    evidence: r.evidence,
  }));
}

export function listFacts(db: Db, projectId: number, topic?: string): CanonFact[] {
  const params: unknown[] = [projectId];
  let sql = 'SELECT * FROM canon_fact WHERE project_id = ?';
  if (topic) {
    sql += ' AND (topic = ? OR lower(topic) LIKE ?)';
    params.push(topic, `%${topic.toLowerCase()}%`);
  }
  sql += ' ORDER BY id';
  const rows = db.all<{
    id: number;
    topic: string;
    statement: string;
    kind: string;
    certainty: string;
    subject: string;
    evidence: string;
    source_refs: string;
  }>(sql, ...params);
  return rows.map((r) => ({
    id: r.id,
    topic: r.topic,
    statement: r.statement,
    kind: r.kind,
    certainty: r.certainty,
    subject: r.subject,
    evidence: r.evidence,
    sourceRefs: JSON.parse(r.source_refs || '[]') as { source: string; locator: string }[],
  }));
}

export function listTimeline(db: Db, projectId: number): CanonTimelineEntry[] {
  const rows = db.all<{
    id: number;
    canon_event: number | null;
    seq: number;
    title: string;
    summary: string;
    time_label: string;
    participants: string;
    location: string;
    evidence: string;
  }>('SELECT * FROM canon_timeline WHERE project_id = ? ORDER BY seq, id', projectId);
  return rows.map((r) => ({
    id: r.id,
    eventId: r.canon_event,
    seq: r.seq,
    title: r.title,
    summary: r.summary,
    when: r.time_label,
    participants: strList(r.participants),
    location: r.location,
    evidence: r.evidence,
  }));
}

export function updateEntity(
  db: Db,
  projectId: number,
  id: number,
  patch: Partial<Pick<CanonEntity, 'name' | 'summary' | 'role' | 'status' | 'kind'>>,
): void {
  const existing = db.get<{ id: number }>('SELECT id FROM canon_entity WHERE id = ? AND project_id = ?', id, projectId);
  if (!existing) return;
  db.run(
    'UPDATE canon_entity SET name = ?, summary = ?, role = ?, status = ?, kind = ?, updated_at = ? WHERE id = ?',
    patch.name ?? '',
    patch.summary ?? '',
    patch.role ?? '',
    patch.status ?? '',
    patch.kind ?? 'character',
    nowIso(),
    id,
  );
}

export function deleteEntity(db: Db, projectId: number, id: number): void {
  db.run('DELETE FROM canon_entity WHERE id = ? AND project_id = ?', id, projectId);
}

/* ------------------------------------------------------------------ brief */

export interface LoreBrief {
  entities: string;
  relations: string;
  facts: string;
}

/**
 * A compact, factual brief of the book lore.
 *
 * This is what the writer gets instead of (or alongside) raw passages: names,
 * roles, states, relationships and the rules of the world, each with the
 * citation it came from.
 */
export function buildLoreBrief(
  db: Db,
  projectId: number,
  opts: { names?: string[]; maxEntities?: number; includeFacts?: boolean } = {},
): LoreBrief {
  const all = listEntities(db, projectId);
  const names = (opts.names ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean);
  const matched = names.length
    ? all.filter(
        (e) =>
          names.some((n) => e.name.toLowerCase().includes(n) || e.aliases.some((a) => a.toLowerCase().includes(n))),
      )
    : all;
  const chosen = matched.slice(0, opts.maxEntities ?? 20);
  const relations = listRelations(db, projectId).filter(
    (r) => !names.length || chosen.some((e) => e.id === r.fromId || e.id === r.toId),
  );
  const facts = opts.includeFacts === false ? [] : listFacts(db, projectId);
  return renderBrief(chosen, relations, facts, names);
}

/** Turn lore records into the three text sections used in prompts. */
export function renderBrief(
  entities: CanonEntity[],
  relations: CanonRelation[],
  facts: CanonFact[],
  names: string[] = [],
): LoreBrief {
  const entityLines = entities.map((e) => {
    const bits = [
      e.summary,
      e.role ? `role: ${e.role}` : '',
      e.status ? `status: ${e.status}` : '',
      Object.entries(e.attributes)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; '),
    ].filter(Boolean);
    const refs = e.sourceRefs.map((r) => r.locator).join(', ');
    return `- ${e.name}${e.aliases.length ? ` (${e.aliases.join(', ')})` : ''} [${e.kind}]` +
      `${bits.length ? `: ${bits.join('. ')}` : ''}${refs ? ` (${refs})` : ''}`;
  });

  const relationLines = relations.slice(0, 25).map(
    (r) => `- ${r.fromName} → ${r.toName}: ${r.kind}${r.description ? ` — ${r.description}` : ''}`,
  );

  const factLines = facts
    .filter((f) => !names.length || !f.subject || names.some((n) => f.subject.toLowerCase().includes(n)))
    .slice(0, 25)
    .map((f) => `- ${f.statement}${f.topic ? ` (${f.topic})` : ''}${f.certainty === 'inferred' ? ' [inferred]' : ''}`);

  return {
    entities: entityLines.join('\n'),
    relations: relationLines.join('\n'),
    facts: factLines.join('\n'),
  };
}

/** The brief rendered for a prompt. */
export function formatLoreBrief(brief: LoreBrief): string {
  const parts: string[] = [];
  if (brief.entities) parts.push(`PEOPLE, PLACES AND THINGS:\n${brief.entities}`);
  if (brief.relations) parts.push(`RELATIONSHIPS IN THE SOURCE:\n${brief.relations}`);
  if (brief.facts) parts.push(`ESTABLISHED BY THE SOURCE:\n${brief.facts}`);
  if (!parts.length) return '';
  return (
    parts.join('\n\n') +
    '\n\nUse these names, roles, states and rules exactly as given. Do not add numbers, ' +
    'cases or rules that are not stated here or in the retrieved passages.'
  );
}

/**
 * Find the lore entry a name refers to, exactly.
 *
 * Loose search is useful for questions ("what does the warden know") but
 * wrong for a person: "Harry Potter" must not return Aunt Petunia.
 */
export function findEntity(db: Db, projectId: number, name: string): CanonEntity | undefined {
  const clean = (name ?? '').trim().toLowerCase();
  if (!clean) return undefined;
  const all = listEntities(db, projectId);
  const exact = all.find((e) => e.name.toLowerCase() === clean);
  if (exact) return exact;
  const alias = all.find((e) => e.aliases.some((a) => a.toLowerCase() === clean));
  if (alias) return alias;
  // A fuller name that starts with what was asked for: "Harry" -> "Harry Potter".
  return all.find((e) => e.name.toLowerCase().startsWith(clean + ' '));
}

/**
 * Look up lore entries that mention a name or phrase.
 *
 * Used by the lore researcher to answer from the extracted index first, and to
 * fill in context requests about a character.
 */
export function searchLore(db: Db, projectId: number, query: string, limit = 10): {
  entities: CanonEntity[];
  relations: CanonRelation[];
  facts: CanonFact[];
  timeline: CanonTimelineEntry[];
} {
  const q = query.trim().toLowerCase();
  if (!q) return { entities: [], relations: [], facts: [], timeline: [] };
  const words = q.split(/[^a-z0-9']+/).filter((w) => w.length > 2);

  const entities = listEntities(db, projectId).filter((e) => {
    const hay = `${e.name} ${e.aliases.join(' ')} ${e.summary} ${e.role}`.toLowerCase();
    return words.some((w) => hay.includes(w));
  });

  const rels = listRelations(db, projectId).filter((r) => {
    const hay = `${r.fromName} ${r.toName} ${r.kind} ${r.description}`.toLowerCase();
    return words.some((w) => hay.includes(w));
  });

  const facts = listFacts(db, projectId).filter((f) => {
    const hay = `${f.topic} ${f.statement} ${f.subject}`.toLowerCase();
    return words.some((w) => hay.includes(w));
  });

  const timeline = listTimeline(db, projectId).filter((t) => {
    const hay = `${t.title} ${t.summary} ${t.participants.join(' ')} ${t.location}`.toLowerCase();
    return words.some((w) => hay.includes(w));
  });

  return {
    entities: entities.slice(0, limit),
    relations: rels.slice(0, limit),
    facts: facts.slice(0, limit),
    timeline: timeline.slice(0, limit),
  };
}

/** How much lore has been extracted, for the UI. */
export function loreStats(db: Db, projectId: number): {
  entities: number;
  relations: number;
  facts: number;
  timeline: number;
  characters: number;
  locations: number;
  rules: number;
} {
  const count = (sql: string, ...params: unknown[]) => db.get<{ n: number }>(sql, ...params)?.n ?? 0;
  return {
    entities: count('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', projectId),
    relations: count('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', projectId),
    facts: count('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = ?', projectId),
    timeline: count('SELECT COUNT(*) AS n FROM canon_timeline WHERE project_id = ?', projectId),
    characters: count("SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ? AND kind = 'character'", projectId),
    locations: count("SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ? AND kind = 'location'", projectId),
    rules: count("SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ? AND kind = 'rule'", projectId),
  };
}
