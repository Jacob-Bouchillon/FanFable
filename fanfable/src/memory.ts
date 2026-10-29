/**
 * Story Memory Manager.
 *
 * Mostly application logic and database storage, with the LLM used where
 * interpretation is needed (summaries, state extraction). It owns everything
 * about the AU story: outline, chapters, the AU timeline, characters and their
 * states/knowledge, relationships, plot threads, established facts and chapter
 * summaries.
 *
 * The important property is retrieval: the writer gets the *relevant subset* of
 * story history, not the whole story in every prompt.
 */
import { Db, nowIso, strList, toJson } from './db.ts';
import { extractJson, toStringArray } from './json.ts';
import type { LlmClient } from './llm.ts';
import { truncate } from './text.ts';

/* ------------------------------------------------------------------ models */

export interface Character {
  id: number;
  name: string;
  aliases: string[];
  profile: string;
  traits: string[];
  canonRef: string;
}

export interface CharacterState {
  id: number;
  characterId: number;
  characterName: string;
  location: string;
  condition: string;
  emotional: string;
  situation: string;
  source: string;
  asOfEventId: number | null;
  chapterId: number | null;
}

export interface KnowledgeEntry {
  id: number;
  characterId: number;
  characterName: string;
  fact: string;
  topic: string;
  certainty: string;
  source: string;
  evidence: string;
  canonEventId: number | null;
  auEventId: number | null;
}

export interface Relationship {
  id: number;
  a: string;
  b: string;
  kind: string;
  description: string;
  sentiment: string;
  source: string;
}

export interface PlotThread {
  id: number;
  title: string;
  description: string;
  status: string;
  events: string[];
}

export interface AuEvent {
  id: number;
  chapterId: number | null;
  chapterNumber: number | null;
  title: string;
  summary: string;
  storyTime: string;
  storyOrder: number;
  participants: string[];
  location: string;
  kind: string;
  adaptsCanonEventId: number | null;
  divergenceNote: string;
}

export interface StoryFact {
  id: number;
  kind: string;
  subject: string;
  content: string;
  certainty: string;
}

export interface ChapterSummary {
  id: number;
  chapterId: number;
  chapterNumber: number;
  title: string;
  summary: string;
  entities: string[];
}

/* -------------------------------------------------------------- characters */

export function upsertCharacter(
  db: Db,
  projectId: number,
  name: string,
  fields: Partial<Omit<Character, 'id'>> = {},
): number {
  const clean = name.trim();
  if (!clean) throw new Error('character name is required');
  const existing = db.get<{ id: number }>(
    'SELECT id FROM character WHERE project_id = ? AND lower(name) = lower(?)',
    projectId,
    clean,
  );
  const ts = nowIso();
  if (existing) {
    db.run(
      'UPDATE character SET aliases = ?, profile = ?, traits = ?, canon_ref = ?, updated_at = ? WHERE id = ?',
      toJson(fields.aliases ?? []),
      fields.profile ?? '',
      toJson(fields.traits ?? []),
      fields.canonRef ?? '',
      ts,
      existing.id,
    );
    return existing.id;
  }
  const r = db.run(
    'INSERT INTO character (project_id, name, aliases, profile, traits, canon_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    projectId,
    clean,
    toJson(fields.aliases ?? []),
    fields.profile ?? '',
    toJson(fields.traits ?? []),
    fields.canonRef ?? '',
    ts,
    ts,
  );
  return r.lastInsertRowid;
}

export function listCharacters(db: Db, projectId: number): Character[] {
  const rows = db.all<{
    id: number;
    name: string;
    aliases: string;
    profile: string;
    traits: string;
    canon_ref: string;
  }>('SELECT * FROM character WHERE project_id = ? ORDER BY name', projectId);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    aliases: strList(r.aliases),
    profile: r.profile,
    traits: strList(r.traits),
    canonRef: r.canon_ref,
  }));
}

/**
 * Link a story character to the canon character they are based on.
 *
 * Entity resolution has to be conservative: a wrong link is worse than no
 * link, because the graph would then assert a connection the source does not
 * support. Exact name or alias matches only.
 */
export function resolveToCanonEntity(
  db: Db,
  projectId: number,
  name: string,
  kind = 'character',
): number | undefined {
  const clean = (name ?? '').trim().toLowerCase();
  if (!clean) return undefined;
  const exact = db.get<{ id: number }>(
    `SELECT id FROM canon_entity WHERE project_id = ? AND kind = ? AND lower(name) = ?`,
    projectId,
    kind,
    clean,
  );
  if (exact) return exact.id;
  const alias = db.get<{ id: number }>(
    `SELECT id FROM canon_entity WHERE project_id = ? AND kind = ? AND lower(aliases) LIKE ?`,
    projectId,
    kind,
    `%"${clean}"%`,
  );
  return alias?.id;
}

/** Attach a story character to its canon counterpart, if one is obvious. */
export function linkCharacterToCanon(db: Db, projectId: number, characterId: number): number | undefined {
  const character = db.get<{ id: number; name: string; aliases: string; canon_entity_id: number | null }>(
    'SELECT id, name, aliases, canon_entity_id FROM character WHERE id = ? AND project_id = ?',
    characterId,
    projectId,
  );
  if (!character) return undefined;
  if (character.canon_entity_id) return character.canon_entity_id;
  const entityId = resolveToCanonEntity(db, projectId, character.name);
  if (!entityId) {
    for (const alias of strList(character.aliases)) {
      const found = resolveToCanonEntity(db, projectId, alias);
      if (found) {
        db.run('UPDATE character SET canon_entity_id = ? WHERE id = ?', found, characterId);
        return found;
      }
    }
    return undefined;
  }
  db.run('UPDATE character SET canon_entity_id = ? WHERE id = ?', entityId, characterId);
  return entityId;
}

export function findCharacter(db: Db, projectId: number, name: string): Character | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) return undefined;
  const all = listCharacters(db, projectId);
  return (
    all.find((c) => c.name.toLowerCase() === needle) ??
    all.find((c) => c.aliases.some((a) => a.toLowerCase() === needle))
  );
}

/** Resolve a name to a character, creating it when necessary. */
export function resolveCharacter(
  db: Db,
  projectId: number,
  name: string,
  create = true,
): Character | undefined {
  const found = findCharacter(db, projectId, name);
  if (found) return found;
  if (!create) return undefined;
  const id = upsertCharacter(db, projectId, name);
  return { id, name: name.trim(), aliases: [], profile: '', traits: [], canonRef: '' };
}

/* ------------------------------------------------------------------ states */

export function addCharacterState(
  db: Db,
  projectId: number,
  characterId: number,
  state: Partial<Omit<CharacterState, 'id' | 'characterId'>> = {},
): number {
  const r = db.run(
    `INSERT INTO character_state (project_id, character_id, as_of_event_id, chapter_id, location, condition, emotional, situation, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    projectId,
    characterId,
    state.asOfEventId ?? null,
    state.chapterId ?? null,
    state.location ?? '',
    state.condition ?? '',
    state.emotional ?? '',
    state.situation ?? '',
    state.source ?? 'inferred',
    nowIso(),
  );
  return r.lastInsertRowid;
}

export function listCharacterStates(db: Db, projectId: number, characterId?: number): CharacterState[] {
  const params: unknown[] = [projectId];
  let sql = `SELECT s.*, c.name AS character_name FROM character_state s
             JOIN character c ON c.id = s.character_id WHERE s.project_id = ?`;
  if (characterId !== undefined) {
    sql += ' AND s.character_id = ?';
    params.push(characterId);
  }
  sql += ' ORDER BY s.id';
  const rows = db.all<{
    id: number;
    character_id: number;
    character_name: string;
    location: string;
    condition: string;
    emotional: string;
    situation: string;
    source: string;
    as_of_event_id: number | null;
    chapter_id: number | null;
  }>(sql, ...params);
  return rows.map((r) => ({
    id: r.id,
    characterId: r.character_id,
    characterName: r.character_name,
    location: r.location,
    condition: r.condition,
    emotional: r.emotional,
    situation: r.situation,
    source: r.source,
    asOfEventId: r.as_of_event_id,
    chapterId: r.chapter_id,
  }));
}

/** The most recent state recorded for each character. */
export function currentStates(db: Db, projectId: number): CharacterState[] {
  const all = listCharacterStates(db, projectId);
  const latest = new Map<number, CharacterState>();
  for (const s of all) latest.set(s.characterId, s);
  return [...latest.values()];
}

/* -------------------------------------------------------------- knowledge */

export interface KnowledgeInput {
  characterId: number;
  fact: string;
  topic?: string;
  certainty?: string;
  source?: string;
  evidence?: string;
  canonEventId?: number | null;
  auEventId?: number | null;
  factId?: number | null;
  validUntilEventId?: number | null;
  chapterId?: number | null;
}

export function addKnowledge(db: Db, projectId: number, entry: KnowledgeInput): number {
  const r = db.run(
    `INSERT INTO character_knowledge (project_id, character_id, fact, topic, certainty, source, canon_event_id, au_event_id, fact_id, valid_until_event_id, chapter_id, evidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    projectId,
    entry.characterId,
    entry.fact,
    entry.topic ?? '',
    entry.certainty ?? 'knows',
    entry.source ?? 'inferred',
    entry.canonEventId ?? null,
    entry.auEventId ?? null,
    entry.factId ?? null,
    entry.validUntilEventId ?? null,
    entry.chapterId ?? null,
    entry.evidence ?? '',
    nowIso(),
  );
  return r.lastInsertRowid;
}

export function listKnowledge(db: Db, projectId: number, characterId?: number): KnowledgeEntry[] {
  const params: unknown[] = [projectId];
  let sql = `SELECT k.*, c.name AS character_name FROM character_knowledge k
             JOIN character c ON c.id = k.character_id WHERE k.project_id = ?`;
  if (characterId !== undefined) {
    sql += ' AND k.character_id = ?';
    params.push(characterId);
  }
  sql += ' ORDER BY k.id';
  const rows = db.all<{
    id: number;
    character_id: number;
    character_name: string;
    fact: string;
    topic: string;
    certainty: string;
    source: string;
    canon_event_id: number | null;
    au_event_id: number | null;
    evidence: string;
  }>(sql, ...params);
  return rows.map((r) => ({
    id: r.id,
    characterId: r.character_id,
    characterName: r.character_name,
    fact: r.fact,
    topic: r.topic,
    certainty: r.certainty,
    source: r.source,
    evidence: r.evidence,
    canonEventId: r.canon_event_id,
    auEventId: r.au_event_id,
  }));
}

/* ------------------------------------------------------------ relationships */

export function upsertRelationship(
  db: Db,
  projectId: number,
  aId: number,
  bId: number,
  rel: {
    kind?: string;
    description?: string;
    sentiment?: string;
    source?: string;
    chapterId?: number | null;
    /** The event the relationship starts at. */
    validFromEventId?: number | null;
    confidence?: number;
  } = {},
): void {
  const [x, y] = aId <= bId ? [aId, bId] : [bId, aId];
  // The current, open relationship for this pair. A relationship that changes
  // kind is not overwritten: the old one is closed and a new one is opened, so
  // the history of how two people relate survives.
  const existing = db.get<{ id: number; kind: string; description: string }>(
    `SELECT id, kind, description FROM relationship
     WHERE project_id = ? AND character_a = ? AND character_b = ? AND closed = 0
     ORDER BY id DESC LIMIT 1`,
    projectId,
    x,
    y,
  );
  const kindChanged =
    !!existing && !!rel.kind && existing.kind && existing.kind !== rel.kind;

  if (existing && kindChanged) {
    db.run(
      'UPDATE relationship SET closed = 1, valid_to_event_id = ?, updated_at = ? WHERE id = ?',
      rel.validFromEventId ?? null,
      nowIso(),
      existing.id,
    );
  } else if (existing) {
    db.run(
      'UPDATE relationship SET kind = ?, description = ?, sentiment = ?, source = ?, chapter_id = COALESCE(?, chapter_id), updated_at = ? WHERE id = ?',
      rel.kind ?? existing.kind,
      rel.description || existing.description,
      rel.sentiment ?? '',
      rel.source ?? 'inferred',
      rel.chapterId ?? null,
      nowIso(),
      existing.id,
    );
    return;
  }

  db.run(
    `INSERT INTO relationship (project_id, character_a, character_b, kind, description, sentiment, source,
                               chapter_id, valid_from_event_id, confidence, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    projectId,
    x,
    y,
    rel.kind ?? '',
    rel.description ?? '',
    rel.sentiment ?? '',
    rel.source ?? 'inferred',
    rel.chapterId ?? null,
    rel.validFromEventId ?? null,
    rel.confidence ?? 1,
    nowIso(),
  );
}

export function listRelationships(db: Db, projectId: number): Relationship[] {
  const rows = db.all<{
    id: number;
    kind: string;
    description: string;
    sentiment: string;
    source: string;
    a_name: string;
    b_name: string;
  }>(
    `SELECT r.*, a.name AS a_name, b.name AS b_name FROM relationship r
     JOIN character a ON a.id = r.character_a JOIN character b ON b.id = r.character_b
     WHERE r.project_id = ? ORDER BY r.id`,
    projectId,
  );
  return rows.map((r) => ({
    id: r.id,
    a: r.a_name,
    b: r.b_name,
    kind: r.kind,
    description: r.description,
    sentiment: r.sentiment,
    source: r.source,
  }));
}

/* ------------------------------------------------------------ plot threads */

/** Model wording for thread status varies; normalise it to the three states. */
export function normalizeThreadStatus(status: string): 'open' | 'resolved' | 'dropped' {
  const s = (status ?? '').trim().toLowerCase();
  if (['resolved', 'closed', 'complete', 'completed', 'done'].includes(s)) return 'resolved';
  if (['dropped', 'abandoned', 'abandon', 'cancelled', 'canceled', 'retired'].includes(s)) return 'dropped';
  return 'open';
}

export function upsertThread(
  db: Db,
  projectId: number,
  title: string,
  description = '',
  status = 'open',
): number {
  status = normalizeThreadStatus(status);
  const existing = db.get<{ id: number }>(
    'SELECT id FROM plot_thread WHERE project_id = ? AND lower(title) = lower(?)',
    projectId,
    title.trim(),
  );
  if (existing) {
    db.run(
      'UPDATE plot_thread SET description = ?, status = ?, resolved_at = ? WHERE id = ?',
      description,
      status,
      status === 'resolved' ? nowIso() : null,
      existing.id,
    );
    return existing.id;
  }
  const r = db.run(
    'INSERT INTO plot_thread (project_id, title, description, status, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?)',
    projectId,
    title.trim(),
    description,
    status,
    nowIso(),
    status === 'resolved' ? nowIso() : null,
  );
  return r.lastInsertRowid;
}

export function listThreads(db: Db, projectId: number): PlotThread[] {
  const rows = db.all<{ id: number; title: string; description: string; status: string }>(
    'SELECT id, title, description, status FROM plot_thread WHERE project_id = ? ORDER BY id',
    projectId,
  );
  const events = db.all<{ thread_id: number; title: string }>(
    `SELECT te.thread_id, e.title FROM thread_event te JOIN au_event e ON e.id = te.event_id
     WHERE e.project_id = ? ORDER BY e.id`,
    projectId,
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status,
    events: events.filter((e) => e.thread_id === r.id).map((e) => e.title),
  }));
}

/* --------------------------------------------------------------- AU events */

export function addAuEvent(
  db: Db,
  projectId: number,
  ev: Partial<AuEvent> & { title: string },
): number {
  const seq = db.get<{ n: number }>(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM au_event WHERE project_id = ?',
    projectId,
  );
  const r = db.run(
    `INSERT INTO au_event (project_id, chapter_id, seq, title, summary, story_time, story_order, participants, location, kind, adapts_canon_event_id, divergence_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    projectId,
    ev.chapterId ?? null,
    seq?.n ?? 1,
    ev.title,
    ev.summary ?? '',
    ev.storyTime ?? '',
    ev.storyOrder ?? 0,
    toJson(ev.participants ?? []),
    ev.location ?? '',
    ev.kind ?? 'event',
    ev.adaptsCanonEventId ?? null,
    ev.divergenceNote ?? '',
    nowIso(),
  );
  return r.lastInsertRowid;
}

export function listAuEvents(db: Db, projectId: number, chapterId?: number): AuEvent[] {
  const params: unknown[] = [projectId];
  let sql = `SELECT e.*, c.number AS chapter_number FROM au_event e
             LEFT JOIN chapter c ON c.id = e.chapter_id WHERE e.project_id = ?`;
  if (chapterId !== undefined) {
    sql += ' AND e.chapter_id = ?';
    params.push(chapterId);
  }
  sql += ' ORDER BY e.story_order, e.seq';
  const rows = db.all<{
    id: number;
    chapter_id: number | null;
    chapter_number: number | null;
    title: string;
    summary: string;
    story_time: string;
    story_order: number;
    participants: string;
    location: string;
    kind: string;
    adapts_canon_event_id: number | null;
    divergence_note: string;
  }>(sql, ...params);
  return rows.map((r) => ({
    id: r.id,
    chapterId: r.chapter_id,
    chapterNumber: r.chapter_number,
    title: r.title,
    summary: r.summary,
    storyTime: r.story_time,
    storyOrder: r.story_order,
    participants: strList(r.participants),
    location: r.location,
    kind: r.kind,
    adaptsCanonEventId: r.adapts_canon_event_id,
    divergenceNote: r.divergence_note,
  }));
}

/* ------------------------------------------------------------ story facts */

export function addFact(
  db: Db,
  projectId: number,
  fact: { kind?: string; subject?: string; content: string; certainty?: string; chapterId?: number | null; canonEventId?: number | null },
): number {
  const r = db.run(
    `INSERT INTO story_fact (project_id, kind, subject, content, certainty, chapter_id, canon_event_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    projectId,
    fact.kind ?? 'fact',
    fact.subject ?? '',
    fact.content,
    fact.certainty ?? 'established',
    fact.chapterId ?? null,
    fact.canonEventId ?? null,
    nowIso(),
  );
  return r.lastInsertRowid;
}

export function listFacts(db: Db, projectId: number, certainty?: string): StoryFact[] {
  const params: unknown[] = [projectId];
  let sql = 'SELECT * FROM story_fact WHERE project_id = ?';
  if (certainty) {
    sql += ' AND certainty = ?';
    params.push(certainty);
  }
  sql += ' ORDER BY id';
  const rows = db.all<{
    id: number;
    kind: string;
    subject: string;
    content: string;
    certainty: string;
  }>(sql, ...params);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    subject: r.subject,
    content: r.content,
    certainty: r.certainty,
  }));
}

/* --------------------------------------------------------------- summaries */

export function setChapterSummary(
  db: Db,
  projectId: number,
  chapterId: number,
  summary: string,
  entities: string[] = [],
): void {
  db.run('DELETE FROM chapter_summary WHERE chapter_id = ?', chapterId);
  db.run(
    'INSERT INTO chapter_summary (project_id, chapter_id, summary, entities, created_at) VALUES (?, ?, ?, ?, ?)',
    projectId,
    chapterId,
    summary,
    toJson(entities),
    nowIso(),
  );
}

export function listSummaries(db: Db, projectId: number, limit = 50): ChapterSummary[] {
  const rows = db.all<{
    id: number;
    chapter_id: number;
    summary: string;
    entities: string;
    number: number;
    title: string;
  }>(
    `SELECT s.*, c.number, c.title FROM chapter_summary s JOIN chapter c ON c.id = s.chapter_id
     WHERE s.project_id = ? ORDER BY c.number LIMIT ?`,
    projectId,
    limit,
  );
  return rows.map((r) => ({
    id: r.id,
    chapterId: r.chapter_id,
    chapterNumber: r.number,
    title: r.title,
    summary: r.summary,
    entities: strList(r.entities),
  }));
}

/* ------------------------------------------------------- context assembly */

export interface ContextSlice {
  characters: Character[];
  states: CharacterState[];
  knowledge: KnowledgeEntry[];
  relationships: Relationship[];
  threads: PlotThread[];
  events: AuEvent[];
  facts: StoryFact[];
  summaries: ChapterSummary[];
}

/**
 * Build the relevant subset of story memory for a scene.
 *
 * `focus` is a list of names (characters, places, threads) mentioned in the
 * chapter outline or by the user. Everything else is included only if it is
 * recent or still open, so the prompt stays inside a sane size.
 */
export function buildContextSlice(
  db: Db,
  projectId: number,
  opts: { focus?: string[]; maxSummaries?: number; maxEvents?: number } = {},
): ContextSlice {
  const focus = (opts.focus ?? []).map((f) => f.toLowerCase());
  const matches = (text: string) =>
    focus.length === 0 || focus.some((f) => text.toLowerCase().includes(f));

  const allCharacters = listCharacters(db, projectId);
  const characters = allCharacters.filter(
    (c) => matches(c.name) || c.aliases.some((a) => matches(a)),
  );
  const charIds = new Set(characters.map((c) => c.id));

  const states = currentStates(db, projectId).filter((s) => charIds.has(s.characterId));
  const knowledge = listKnowledge(db, projectId).filter(
    (k) => charIds.has(k.characterId) && (matches(k.fact) || matches(k.topic) || focus.length === 0),
  );
  const relationships = listRelationships(db, projectId).filter(
    (r) => charIds.size === 0 || charIds.has(aIdOf(r, allCharacters)) || charIds.has(bIdOf(r, allCharacters)),
  );

  const allThreads = listThreads(db, projectId);
  const threads = allThreads.filter((t) => t.status !== 'resolved' || matches(t.title));

  const allEvents = listAuEvents(db, projectId);
  const events = allEvents
    .filter((e) => matches(e.title) || e.participants.some((p) => matches(p)) || focus.length === 0)
    .slice(-(opts.maxEvents ?? 25));

  const facts = listFacts(db, projectId).filter((f) => focus.length === 0 || matches(f.subject) || matches(f.content));

  const summaries = listSummaries(db, projectId, opts.maxSummaries ?? 12).filter(
    (s) => focus.length === 0 || s.entities.some((e) => matches(e)) || matches(s.title),
  );

  return { characters, states, knowledge, relationships, threads, events, facts, summaries };
}

function aIdOf(r: Relationship, chars: Character[]): number {
  return chars.find((c) => c.name === r.a)?.id ?? -1;
}
function bIdOf(r: Relationship, chars: Character[]): number {
  return chars.find((c) => c.name === r.b)?.id ?? -1;
}

/** Render a context slice as prompt text, clearly sectioned and labelled. */
export function renderContextSlice(slice: ContextSlice): string {
  const parts: string[] = [];

  if (slice.summaries.length) {
    parts.push(
      '## STORY SO FAR (chapter summaries)\n' +
        slice.summaries
          .map((s) => `- Ch${s.chapterNumber}${s.title ? ` "${s.title}"` : ''}: ${s.summary}`)
          .join('\n'),
    );
  }
  if (slice.characters.length) {
    parts.push(
      '## CHARACTERS\n' +
        slice.characters
          .map((c) => {
            const state = slice.states.find((s) => s.characterId === c.id);
            const lines = [`- ${c.name}`];
            if (c.aliases.length) lines.push(`  aliases: ${c.aliases.join(', ')}`);
            if (c.profile) lines.push(`  profile: ${truncate(c.profile, 400)}`);
            if (c.traits.length) lines.push(`  traits: ${c.traits.join(', ')}`);
            if (state) {
              const bits = [
                state.location && `location: ${state.location}`,
                state.condition && `condition: ${state.condition}`,
                state.emotional && `emotional: ${state.emotional}`,
                state.situation && `situation: ${state.situation}`,
              ].filter(Boolean);
              if (bits.length) lines.push(`  current state (${state.source}): ${bits.join('; ')}`);
            }
            return lines.join('\n');
          })
          .join('\n'),
    );
  }
  if (slice.knowledge.length) {
    parts.push(
      '## WHAT EACH CHARACTER KNOWS\n' +
        slice.knowledge
          .map((k) => `- ${k.characterName}: ${k.fact} [${k.certainty}, ${k.source}]${k.evidence ? ` — ${k.evidence}` : ''}`)
          .join('\n'),
    );
  }
  if (slice.relationships.length) {
    parts.push(
      '## RELATIONSHIPS\n' + slice.relationships.map((r) => `- ${r.a} & ${r.b}: ${r.kind}${r.description ? ` — ${r.description}` : ''}`).join('\n'),
    );
  }
  if (slice.events.length) {
    parts.push(
      '## AU TIMELINE (events in the new story)\n' +
        slice.events
          .map(
            (e) =>
              `- [${e.storyTime || `order ${e.storyOrder}`}] ${e.title}${e.location ? ` @ ${e.location}` : ''}` +
              `${e.participants.length ? ` — ${e.participants.join(', ')}` : ''}${e.summary ? `: ${e.summary}` : ''}`,
          )
          .join('\n'),
    );
  }
  if (slice.threads.length) {
    parts.push(
      '## OPEN PLOT THREADS\n' +
        slice.threads.map((t) => `- [${t.status}] ${t.title}${t.description ? `: ${t.description}` : ''}`).join('\n'),
    );
  }
  if (slice.facts.length) {
    parts.push(
      '## ESTABLISHED FACTS & DECISIONS\n' +
        slice.facts.map((f) => `- (${f.kind}${f.certainty !== 'established' ? `/${f.certainty}` : ''}) ${f.subject ? `${f.subject}: ` : ''}${f.content}`).join('\n'),
    );
  }
  return parts.join('\n\n');
}

/**
 * Merge characters that are obviously the same person.
 *
 * Models are inconsistent about names: the same character can be "Serena",
 * "Serena Marsh" and "Serena Marsh of Ardenne". When one name is a word-wise
 * extension of another, they are the same person, and their state, knowledge
 * and relationships must not be split across two records.
 */
export function mergeSimilarCharacters(db: Db, projectId: number): string[] {
  const merged: string[] = [];
  for (let guard = 0; guard < 50; guard++) {
    const chars = listCharacters(db, projectId);
    let target: { keep: Character; drop: Character } | null = null;

    for (let i = 0; i < chars.length && !target; i++) {
      for (let j = 0; j < chars.length && !target; j++) {
        if (i === j) continue;
        const a = chars[i];
        const b = chars[j];
        const la = a.name.toLowerCase();
        const lb = b.name.toLowerCase();
        // Same person when one name is a word-wise extension of the other.
        const related = la.startsWith(lb + ' ') || lb.startsWith(la + ' ');
        if (!related) continue;
        // Keep the longer, more specific name.
        target = la.length >= lb.length ? { keep: a, drop: b } : { keep: b, drop: a };
      }
    }
    if (!target) break;

    const { keep, drop } = target;
    db.transaction(() => {
      const aliases = [...keep.aliases, drop.name, ...drop.aliases].filter(
        (a, i, arr) => a.toLowerCase() !== keep.name.toLowerCase() && arr.findIndex((x) => x.toLowerCase() === a.toLowerCase()) === i,
      );
      db.run(
        'UPDATE character SET aliases = ?, profile = ?, traits = ?, updated_at = ? WHERE id = ?',
        toJson(aliases),
        keep.profile || drop.profile,
        toJson([...new Set([...keep.traits, ...drop.traits])]),
        nowIso(),
        keep.id,
      );
      db.run('UPDATE character_state SET character_id = ? WHERE character_id = ?', keep.id, drop.id);
      db.run('UPDATE character_knowledge SET character_id = ? WHERE character_id = ?', keep.id, drop.id);

      // Relationships: move the dropped character's links onto the kept one.
      const dropRels = db.all<{
        character_a: number;
        character_b: number;
        kind: string;
        description: string;
        sentiment: string;
        source: string;
      }>(
        'SELECT character_a, character_b, kind, description, sentiment, source FROM relationship WHERE project_id = ? AND (character_a = ? OR character_b = ?)',
        projectId,
        drop.id,
        drop.id,
      );
      db.run(
        'DELETE FROM relationship WHERE project_id = ? AND (character_a = ? OR character_b = ?)',
        projectId,
        drop.id,
        drop.id,
      );
      for (const r of dropRels) {
        const other = r.character_a === drop.id ? r.character_b : r.character_a;
        if (other === keep.id) continue;
        const [x, y] = keep.id <= other ? [keep.id, other] : [other, keep.id];
        const existing = db.get<{ id: number; kind: string; description: string; sentiment: string }>(
          'SELECT id, kind, description, sentiment FROM relationship WHERE project_id = ? AND character_a = ? AND character_b = ?',
          projectId,
          x,
          y,
        );
        if (existing) {
          // Keep what is already known and only fill in the gaps.
          db.run(
            'UPDATE relationship SET kind = ?, description = ?, sentiment = ? WHERE id = ?',
            existing.kind || r.kind,
            existing.description || r.description,
            existing.sentiment || r.sentiment,
            existing.id,
          );
        } else {
          upsertRelationship(db, projectId, keep.id, other, {
            kind: r.kind,
            description: r.description,
            sentiment: r.sentiment,
            source: r.source,
          });
        }
      }
      db.run('DELETE FROM character WHERE id = ?', drop.id);
    });
    merged.push(`${drop.name} -> ${keep.name}`);
  }
  return merged;
}

/**
 * Remove everything a previous approval of this chapter derived.
 *
 * Re-approving an edited chapter must not leave two versions of the same
 * events, states and facts in the story memory.
 */
export function clearChapterExtraction(db: Db, projectId: number, chapterId: number): void {
  const eventIds = db
    .all<{ id: number }>('SELECT id FROM au_event WHERE project_id = ? AND chapter_id = ?', projectId, chapterId)
    .map((r) => r.id);
  for (const id of eventIds) {
    db.run('DELETE FROM canon_change WHERE project_id = ? AND au_event_id = ?', projectId, id);
  }
  // The edge tables cascade with their events, but the links between two
  // events of this chapter have to go too.
  db.run(
    `DELETE FROM au_event_link WHERE from_event_id IN (${eventIds.length ? eventIds.join(',') : '0'})
       OR to_event_id IN (${eventIds.length ? eventIds.join(',') : '0'})`,
  );
  db.run('DELETE FROM au_event WHERE project_id = ? AND chapter_id = ?', projectId, chapterId);
  db.run('DELETE FROM character_state WHERE project_id = ? AND chapter_id = ?', projectId, chapterId);
  db.run('DELETE FROM story_fact WHERE project_id = ? AND chapter_id = ?', projectId, chapterId);
  db.run('DELETE FROM chapter_summary WHERE project_id = ? AND chapter_id = ?', projectId, chapterId);

  // Everything this chapter established about who knows what, why people act,
  // what is secret and how people relate. Re-approving a chapter must not
  // leave the previous version's records behind.
  db.run('DELETE FROM character_knowledge WHERE project_id = ? AND chapter_id = ?', projectId, chapterId);
  db.run('DELETE FROM motivation WHERE project_id = ? AND chapter_id = ?', projectId, chapterId);
  db.run('DELETE FROM secret WHERE project_id = ? AND chapter_id = ?', projectId, chapterId);
  db.run('DELETE FROM relationship WHERE project_id = ? AND chapter_id = ?', projectId, chapterId);
}

/* --------------------------------------------- LLM-assisted state extraction */

export interface StateExtraction {
  summary: string;
  events: AuEvent[];
  characters: { name: string; aliases?: string[]; profile?: string; traits?: string[] }[];
  states: { character: string; location?: string; condition?: string; emotional?: string; situation?: string }[];
  knowledge: { character: string; fact: string; topic?: string; certainty?: string; evidence?: string }[];
  relationships: { a: string; b: string; kind?: string; description?: string; sentiment?: string }[];
  threads: { title: string; description?: string; status?: string }[];
  facts: { kind?: string; subject?: string; content: string }[];
  canonChanges: { canonEventId?: number; changeType?: string; description: string }[];
  /** Why someone does what they do. These become graph nodes. */
  motivations?: { character: string; kind?: string; statement: string; evidence?: string }[];
  /** Things that are true but not yet known to everyone. */
  secrets?: { title: string; statement?: string; knownBy?: string[]; revealed?: boolean }[];
  /** Cause and consequence between the events of this chapter. */
  links?: { from: string; to: string; kind?: string; description?: string }[];
  /** Which event develops which plot thread. */
  threadEvents?: { thread: string; event: string; kind?: string }[];
}

const EXTRACTION_SYSTEM = `You extract structured story state from a written chapter of fanfiction.
Reply with JSON only, using exactly this shape:
{
  "summary": "3-5 sentence summary of the chapter",
  "events": [{"title","summary","story_time","story_order","participants":[string],"location","kind","adapts_canon_event_id","divergence_note"}],
  "characters": [{"name","aliases":[string],"profile","traits":[string]}],
  "states": [{"character","location","condition","emotional","situation"}],
  "knowledge": [{"character","fact","topic","certainty","evidence"}],
  "relationships": [{"a","b","kind","description","sentiment"}],
  "threads": [{"title","description","status"}],
  "facts": [{"kind","subject","content"}],
  "canonChanges": [{"canon_event_id","change_type","description"}],
  "motivations": [{"character":"Name","kind":"motive|goal|fear|wound|want","statement":"why they do it","evidence":""}],
  "secrets": [{"title":"short name","statement":"what is hidden","knownBy":["Name"],"revealed":false}],
  "links": [{"from":"event title","to":"event title","kind":"cause|consequence","description":""}],
  "threadEvents": [{"thread":"thread title","event":"event title","kind":"introduced|developed|resolved"}]
}

Rules:
- certainty is one of: knows, believes, suspects, misunderstands, unknown.
- change_type is one of: altered, omitted, added, reversed, preserved.
- Only record what the chapter actually establishes. Do not invent details.
- events[].story_order is a number increasing with story time (flashbacks get a lower number).
- adapts_canon_event_id is the numeric id of the canon event this scene adapts, or null.
- motivations: what a character wants or fears, and why they act. Only if the chapter shows it.
- secrets: something true in this story that not everyone knows. "knownBy" lists who knows it already.
- links: one event causes or follows from another. Use the exact event titles from "events".
- threadEvents: how the plot threads move in this chapter.
- No prose outside the JSON.`;

export async function extractState(
  llm: LlmClient,
  chapterText: string,
  opts: { canonEvents?: { id: number; title: string; summary: string }[] } = {},
): Promise<StateExtraction> {
  const canonList = (opts.canonEvents ?? [])
    .map((c) => `- ${c.id}: ${c.title}${c.summary ? ` — ${truncate(c.summary, 200)}` : ''}`)
    .join('\n');

  const res = await llm.chat({
    system: EXTRACTION_SYSTEM,
    messages: [
      {
        role: 'user',
        content:
          (canonList ? `CANON EVENTS (use these ids when a scene adapts a canon event):\n${canonList}\n\n` : '') +
          `CHAPTER TEXT:\n${chapterText}`,
      },
    ],
    temperature: 0.2,
    // Ten arrays over a 2,500-word chapter overflowed 2,000 tokens: the reply
    // was cut mid-string, the JSON failed to parse, and approval stored no
    // state at all. Measured on a 2,496-word chapter: 6,000 parses cleanly
    // and yields 5 events, 2 facts and 2 relationships.
    maxTokens: 6000,
  });

  const parsed = extractJson<Record<string, unknown>>(res.text) ?? {};
  const arr = (key: string): Record<string, unknown>[] => {
    const v = parsed[key];
    return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  };

  return {
    summary: String(parsed.summary ?? '').trim(),
    events: arr('events').map((e) => ({
      id: 0,
      chapterId: null,
      chapterNumber: null,
      title: String(e.title ?? '').trim(),
      summary: String(e.summary ?? '').trim(),
      storyTime: String(e.story_time ?? '').trim(),
      storyOrder: Number(e.story_order ?? 0),
      participants: toStringArray(e.participants),
      location: String(e.location ?? '').trim(),
      kind: String(e.kind ?? 'event'),
      adaptsCanonEventId: e.adapts_canon_event_id ? Number(e.adapts_canon_event_id) : null,
      divergenceNote: String(e.divergence_note ?? '').trim(),
    })),
    characters: arr('characters').map((c) => ({
      name: String(c.name ?? '').trim(),
      aliases: toStringArray(c.aliases),
      profile: String(c.profile ?? '').trim(),
      traits: toStringArray(c.traits),
    })),
    states: arr('states').map((s) => ({
      character: String(s.character ?? '').trim(),
      location: String(s.location ?? '').trim(),
      condition: String(s.condition ?? '').trim(),
      emotional: String(s.emotional ?? '').trim(),
      situation: String(s.situation ?? '').trim(),
    })),
    knowledge: arr('knowledge').map((k) => ({
      character: String(k.character ?? '').trim(),
      fact: String(k.fact ?? '').trim(),
      topic: String(k.topic ?? '').trim(),
      certainty: String(k.certainty ?? 'knows').trim(),
      evidence: String(k.evidence ?? '').trim(),
    })),
    relationships: arr('relationships').map((r) => ({
      a: String(r.a ?? '').trim(),
      b: String(r.b ?? '').trim(),
      kind: String(r.kind ?? '').trim(),
      description: String(r.description ?? '').trim(),
      sentiment: String(r.sentiment ?? '').trim(),
    })),
    threads: arr('threads').map((t) => ({
      title: String(t.title ?? '').trim(),
      description: String(t.description ?? '').trim(),
      status: String(t.status ?? 'open').trim(),
    })),
    facts: arr('facts').map((f) => ({
      kind: String(f.kind ?? 'fact').trim(),
      subject: String(f.subject ?? '').trim(),
      content: String(f.content ?? '').trim(),
    })),
    canonChanges: arr('canonChanges').map((c) => ({
      canonEventId: c.canon_event_id ? Number(c.canon_event_id) : undefined,
      changeType: String(c.change_type ?? 'altered').trim(),
      description: String(c.description ?? '').trim(),
    })),
    motivations: arr('motivations').map((m) => ({
      character: String(m.character ?? '').trim(),
      kind: String(m.kind ?? 'motive').trim(),
      statement: String(m.statement ?? '').trim(),
      evidence: String(m.evidence ?? '').trim(),
    })),
    secrets: arr('secrets').map((x) => ({
      title: String(x.title ?? '').trim(),
      statement: String(x.statement ?? '').trim(),
      knownBy: toStringArray(x.known_by),
      revealed: x.revealed === true || x.revealed === 'true',
    })),
    links: arr('links').map((l) => ({
      from: String(l.from ?? '').trim(),
      to: String(l.to ?? '').trim(),
      kind: String(l.kind ?? 'consequence').trim(),
      description: String(l.description ?? '').trim(),
    })),
    threadEvents: arr('threadEvents').map((t) => ({
      thread: String(t.thread ?? '').trim(),
      event: String(t.event ?? '').trim(),
      kind: String(t.kind ?? 'developed').trim(),
    })),
  };
}

/**
 * Persist an extraction against a chapter. Called after the user approves a
 * chapter, so approved material and derived memory stay in sync.
 */
export function applyStateExtraction(
  db: Db,
  projectId: number,
  chapterId: number,
  extraction: StateExtraction,
  opts: { source?: string } = {},
): void {
  const source = opts.source ?? 'au';
  db.transaction(() => {
    for (const c of extraction.characters) {
      if (!c.name) continue;
      upsertCharacter(db, projectId, c.name, {
        aliases: c.aliases,
        profile: c.profile,
        traits: c.traits,
      });
    }
    mergeSimilarCharacters(db, projectId);

    // Entity resolution: a story character is the same person as the canon
    // character of the same name, and the graph needs to know that.
    for (const c of listCharacters(db, projectId)) {
      linkCharacterToCanon(db, projectId, c.id);
    }

    const eventIds = new Map<string, number>();
    for (const ev of extraction.events) {
      if (!ev.title) continue;
      const adapts = existingCanonEvent(db, projectId, ev.adaptsCanonEventId);
      const id = addAuEvent(db, projectId, {
        ...ev,
        chapterId,
        adaptsCanonEventId: adapts,
        storyOrder: ev.storyOrder || nextStoryOrder(db, projectId),
      });
      eventIds.set(ev.title.toLowerCase(), id);

      // Typed participation edges: who was in this event.
      for (const name of ev.participants) {
        const character = resolveCharacter(db, projectId, name, false);
        if (!character) continue;
        db.run(
          `INSERT OR IGNORE INTO au_event_participant (au_event_id, character_id, role) VALUES (?, ?, 'participant')`,
          id,
          character.id,
        );
      }

      for (const ch of extraction.canonChanges) {
        if (!ch.description) continue;
        db.run(
          `INSERT INTO canon_change (project_id, au_event_id, canon_event_id, change_type, description, confirmed, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          projectId,
          id,
          existingCanonEvent(db, projectId, ch.canonEventId ?? ev.adaptsCanonEventId),
          ch.changeType ?? 'altered',
          ch.description,
          0,
          nowIso(),
        );
      }
    }

    // Cause and consequence between events. The link usually reaches back to
    // an event from an earlier chapter — that is the interesting case — so the
    // titles are looked up across the whole story, not just this chapter.
    const storyEventIds = new Map(eventIds);
    for (const row of db.all<{ id: number; title: string }>(
      'SELECT id, title FROM au_event WHERE project_id = ?',
      projectId,
    )) {
      const key = row.title.toLowerCase();
      if (!storyEventIds.has(key)) storyEventIds.set(key, row.id);
    }
    for (const link of extraction.links ?? []) {
      const from = storyEventIds.get(link.from.toLowerCase());
      const to = storyEventIds.get(link.to.toLowerCase());
      if (!from || !to || from === to) continue;
      db.run(
        `INSERT OR REPLACE INTO au_event_link (project_id, from_event_id, to_event_id, kind, description, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, 1.0, ?)`,
        projectId,
        from,
        to,
        link.kind || 'consequence',
        link.description,
        nowIso(),
      );
    }
    for (const s of extraction.states) {
      if (!s.character) continue;
      const char = resolveCharacter(db, projectId, s.character);
      if (!char) continue;
      addCharacterState(db, projectId, char.id, {
        location: s.location,
        condition: s.condition,
        emotional: s.emotional,
        situation: s.situation,
        source,
        chapterId,
      });
    }
    for (const k of extraction.knowledge) {
      if (!k.character || !k.fact) continue;
      const char = resolveCharacter(db, projectId, k.character);
      if (!char) continue;
      const factId = findStoryFactId(db, projectId, k.fact);
      addKnowledge(db, projectId, {
        characterId: char.id,
        fact: k.fact,
        topic: k.topic ?? '',
        certainty: k.certainty ?? 'knows',
        source,
        evidence: k.evidence ?? '',
        factId,
        chapterId,
      });
    }
    for (const r of extraction.relationships) {
      if (!r.a || !r.b) continue;
      const a = resolveCharacter(db, projectId, r.a);
      const b = resolveCharacter(db, projectId, r.b);
      if (!a || !b) continue;
      upsertRelationship(db, projectId, a.id, b.id, {
        kind: r.kind,
        description: r.description,
        sentiment: r.sentiment,
        source,
        chapterId,
      });
    }
    for (const t of extraction.threads) {
      if (!t.title) continue;
      upsertThread(db, projectId, t.title, t.description ?? '', t.status ?? 'open');
    }
    for (const f of extraction.facts) {
      if (!f.content) continue;
      addFact(db, projectId, {
        kind: f.kind ?? 'fact',
        subject: f.subject ?? '',
        content: f.content,
        certainty: 'established',
        chapterId,
      });
    }
    // Motives: why a character acts, as graph nodes attached to them.
    for (const m of extraction.motivations ?? []) {
      if (!m.character || !m.statement) continue;
      const char = resolveCharacter(db, projectId, m.character, false);
      if (!char) continue;
      db.run(
        `INSERT INTO motivation (project_id, subject_type, subject_id, kind, statement, evidence, source, confidence, chapter_id, created_at)
         VALUES (?, 'character', ?, ?, ?, ?, ?, 1.0, ?, ?)`,
        projectId,
        char.id,
        m.kind || 'motive',
        m.statement,
        m.evidence ?? '',
        source,
        chapterId,
        nowIso(),
      );
    }

    // Secrets: true in the story, but not known to everyone.
    for (const sec of extraction.secrets ?? []) {
      if (!sec.title) continue;
      const existing = db.get<{ id: number }>(
        'SELECT id FROM secret WHERE project_id = ? AND lower(title) = lower(?)',
        projectId,
        sec.title,
      );
      let secretId = existing?.id;
      if (!secretId) {
        const r = db.run(
          `INSERT INTO secret (project_id, title, statement, status, chapter_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          projectId,
          sec.title,
          sec.statement ?? '',
          sec.revealed ? 'revealed' : 'open',
          chapterId,
          nowIso(),
        );
        secretId = r.lastInsertRowid;
      }
      for (const who of sec.knownBy ?? []) {
        const char = resolveCharacter(db, projectId, who, false);
        if (!char) continue;
        const already = db.get<{ id: number }>(
          `SELECT id FROM character_knowledge WHERE project_id = ? AND character_id = ? AND fact = ?`,
          projectId,
          char.id,
          sec.statement || sec.title,
        );
        if (already) continue;
        addKnowledge(db, projectId, {
          characterId: char.id,
          fact: sec.statement || sec.title,
          topic: sec.title,
          certainty: 'knows',
          source,
          evidence: '',
          chapterId,
        });
      }
    }

    // How the plot threads move in this chapter.
    for (const te of extraction.threadEvents ?? []) {
      if (!te.thread || !te.event) continue;
      const thread = db.get<{ id: number }>(
        'SELECT id FROM plot_thread WHERE project_id = ? AND lower(title) = lower(?)',
        projectId,
        te.thread,
      );
      const eventId = storyEventIds.get(te.event.toLowerCase());
      if (!thread || !eventId) continue;
      db.run(
        `INSERT OR REPLACE INTO thread_event (thread_id, event_id, kind) VALUES (?, ?, ?)`,
        thread.id,
        eventId,
        te.kind || 'developed',
      );
    }

    // An audit trail of what this approval wrote to the graph, so a later
    // re-approval can be seen rather than guessed at.
    db.run(
      'INSERT INTO graph_write (project_id, chapter_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      chapterId,
      'approval',
      [
        `${extraction.events.length} events`,
        `${extraction.characters.length} characters`,
        `${extraction.knowledge.length} knowledge entries`,
        `${extraction.relationships.length} relationships`,
        `${(extraction.motivations ?? []).length} motives`,
        `${(extraction.secrets ?? []).length} secrets`,
        `${(extraction.links ?? []).length} event links`,
      ].join(', '),
      nowIso(),
    );

    if (extraction.summary) {
      const entities = [
        ...new Set([
          ...extraction.events.flatMap((e) => e.participants),
          ...extraction.states.map((s) => s.character),
          ...extraction.knowledge.map((k) => k.character),
        ]),
      ].filter(Boolean);
      setChapterSummary(db, projectId, chapterId, extraction.summary, entities);
    }
  });
}

/** Find an established story fact that matches this claim, if there is one. */
function findStoryFactId(db: Db, projectId: number, text: string): number | undefined {
  const clean = (text ?? '').trim().toLowerCase();
  if (!clean) return undefined;
  const row = db.get<{ id: number }>(
    'SELECT id FROM story_fact WHERE project_id = ? AND lower(content) = ? LIMIT 1',
    projectId,
    clean,
  );
  return row?.id;
}

/** Only link to a canon event that really exists, so the FK never breaks. */
function existingCanonEvent(db: Db, projectId: number, id: number | null | undefined): number | null {
  if (!id) return null;
  const row = db.get<{ id: number }>(
    'SELECT id FROM canon_event WHERE id = ? AND project_id = ?',
    id,
    projectId,
  );
  return row?.id ?? null;
}

function nextStoryOrder(db: Db, projectId: number): number {
  const row = db.get<{ n: number | null }>(
    'SELECT MAX(story_order) AS n FROM au_event WHERE project_id = ?',
    projectId,
  );
  return (row?.n ?? 0) + 1;
}
