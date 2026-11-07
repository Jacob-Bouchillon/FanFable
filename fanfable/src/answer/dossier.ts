/**
 * Derived character dossier.
 *
 * No new table: relations, timeline events, chapters and the appears/mentioned
 * status are computed from the bank on every read. "Mentioned" is derived from
 * the text, never stored as a kind or a role.
 */
import { Db, fromJson } from '../core/db.ts';
import { deriveChapterNumbers } from './chapters.ts';

export type DossierStatus = 'appears' | 'mentioned';

export interface DossierRelation {
  kind: string;
  direction: 'out' | 'in';
  other: { id: number; name: string };
  quote: string;
  locator: string;
  status: string;
}

export interface DossierEvent {
  seq: number;
  title: string;
  summary: string;
  participants: string[];
  quote: string;
  locator: string;
}

export interface CharacterDossier {
  entityId: number;
  name: string;
  kind: string;
  aliases: string[];
  summary: string;
  role: string;
  /** Facts the text states about the being: sentient, speaks, and any later tags. */
  attributes: Record<string, unknown> | null;
  status: DossierStatus;
  relations: DossierRelation[];
  events: DossierEvent[];
  firstChapter: number | null;
  lastChapter: number | null;
  counts: {
    relations: number;
    events: number;
    chapters: number;
  };
}

interface EntityRow {
  id: number;
  name: string;
  aliases: string;
  kind: string;
  summary: string;
  role: string;
  attributes?: string;
}

interface ChunkRow {
  id: number;
  seq: number;
  locator: string;
  heading: string;
  text: string;
}

function collapseWhitespace(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formsOf(entity: EntityRow): string[] {
  const forms = [entity.name, ...fromJson<string[]>(entity.aliases, [])]
    .map((value) => collapseWhitespace(value))
    .filter(Boolean);
  return [...new Set(forms)];
}

function formPattern(form: string): RegExp {
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(form)}(?![a-z0-9])`, 'i');
}

/** A chunk that is a quoted artifact rather than a scene. */
function isArtifactText(text: string): boolean {
  return /\b(card|cards|book|books|song|songs|list|lists|legend|legends|tale|tales|history|chronicle|prophecy|compendium|encyclopedia|catalogue|newspaper|article|title|titles)\b/i.test(
    String(text ?? ''),
  );
}

function firstChunkId(sourceRefs: string): number | null {
  const parsed = fromJson<unknown>(sourceRefs, []);
  if (!Array.isArray(parsed)) return null;
  for (const raw of parsed) {
    const id = Number((raw as { chunk?: unknown } | null)?.chunk);
    if (Number.isInteger(id) && id > 0) return id;
  }
  return null;
}

function participantNames(raw: string): string[] {
  const parsed = fromJson<unknown>(raw, []);
  if (Array.isArray(parsed)) {
    return parsed
      .map((value) => collapseWhitespace(String(value ?? '')))
      .filter(Boolean);
  }
  return [];
}

/**
 * A generic event names nobody: it has more than two participants and the title
 * contains none of them. No book vocabulary is involved, so the same rule works
 * on any novel.
 */
function isGenericEvent(title: string, participants: string[]): boolean {
  if (participants.length <= 2) return false;
  const words = new Set(collapseWhitespace(title).toLowerCase().match(/[a-z0-9]+/g) ?? []);
  return !participants.some((name) =>
    (name.toLowerCase().match(/[a-z0-9]+/g) ?? []).some((token) => token.length > 2 && words.has(token)),
  );
}

function relationRank(status: string): number {
  if (status === 'accepted') return 0;
  if (status === 'needs_review') return 1;
  return 2;
}

/**
 * Resolve a timeline participant name through the bank's names and aliases.
 * Exact is preferred; a surname-only form also reaches the full name when that
 * is the only person carrying the surname.
 */
function participantResolver(entities: EntityRow[]): (name: string) => EntityRow | null {
  const exact = new Map<string, EntityRow[]>();
  for (const entity of entities) {
    for (const form of formsOf(entity)) {
      const key = form.toLowerCase();
      exact.set(key, [...(exact.get(key) ?? []), entity]);
    }
  }
  const byToken = (name: string): EntityRow | null => {
    const tokens = name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    if (!tokens.length) return null;
    const hits = entities.filter((entity) => {
      const forms = formsOf(entity).map((form) => form.toLowerCase());
      return forms.some((form) => tokens.every((token) => form.includes(token)));
    });
    return hits.length === 1 ? hits[0]! : null;
  };
  return (name: string) => {
    const key = collapseWhitespace(name).toLowerCase();
    if (!key) return null;
    const direct = exact.get(key);
    if (direct?.length === 1) return direct[0]!;
    return byToken(name);
  };
}

export function entityMentionStatus(
  db: Db,
  projectId: number,
  entityId: number,
): DossierStatus {
  const entity = db.get<EntityRow>(
    'SELECT id, name, aliases, kind, summary, role, attributes FROM canon_entity WHERE project_id = ? AND id = ?',
    projectId,
    entityId,
  );
  if (!entity) return 'mentioned';
  const forms = formsOf(entity);
  const patterns = forms.map(formPattern);

  const events = db.all<{ participants: string }>(
    'SELECT participants FROM canon_timeline WHERE project_id = ?',
    projectId,
  );
  const resolve = participantResolver(
    db.all<EntityRow>('SELECT id, name, aliases, kind, summary, role, attributes FROM canon_entity WHERE project_id = ?', projectId),
  );
  for (const event of events) {
    const ids = new Set(
      participantNames(event.participants)
        .map((name) => resolve(name)?.id)
        .filter((id): id is number => id !== undefined),
    );
    if (ids.size > 0 && ids.size <= 4 && ids.has(entityId)) return 'appears';
  }

  const relations = db.all<{ evidence: string }>(
    'SELECT evidence FROM canon_relation WHERE project_id = ? AND (from_entity = ? OR to_entity = ?)',
    projectId,
    entityId,
    entityId,
  );
  for (const relation of relations) {
    if (!isArtifactText(relation.evidence)) return 'appears';
  }

  const chunks = db.all<ChunkRow>(
    'SELECT id, seq, locator, heading, text FROM canon_chunk WHERE project_id = ? ORDER BY seq, id',
    projectId,
  ).filter((chunk) => patterns.some((pattern) => pattern.test(String(chunk.text ?? ''))));
  if (!chunks.length) return 'mentioned';
  return chunks.every((chunk) => isArtifactText(chunk.text)) ? 'mentioned' : 'appears';
}

export function characterDossier(
  db: Db,
  projectId: number,
  entityId: number,
): CharacterDossier | null {
  const entity = db.get<EntityRow>(
    'SELECT id, name, aliases, kind, summary, role, attributes FROM canon_entity WHERE project_id = ? AND id = ?',
    projectId,
    entityId,
  );
  if (!entity) return null;
  const aliases = fromJson<string[]>(entity.aliases, []).map((value) => collapseWhitespace(value)).filter(Boolean);

  const relationRows = db.all<{
    id: number;
    from_entity: number;
    to_entity: number;
    kind: string;
    evidence: string;
    source_refs: string;
    review_status: string;
    other_id: number;
    other_name: string;
  }>(
    `SELECT r.id, r.from_entity, r.to_entity, r.kind, r.evidence, r.source_refs, r.review_status,
            o.id AS other_id, o.name AS other_name
       FROM canon_relation r
       JOIN canon_entity o ON o.id = CASE WHEN r.from_entity = ? THEN r.to_entity ELSE r.from_entity END
      WHERE r.project_id = ? AND (r.from_entity = ? OR r.to_entity = ?)
      ORDER BY r.id`,
    entityId,
    projectId,
    entityId,
    entityId,
  );

  const chunkIds = [...new Set(relationRows
    .map((row) => firstChunkId(row.source_refs))
    .filter((id): id is number => id !== null))];
  const locatorByChunk = new Map<number, string>();
  if (chunkIds.length) {
    const chunks = db.all<{ id: number; locator: string }>(
      `SELECT id, locator FROM canon_chunk WHERE project_id = ? AND id IN (${chunkIds.map(() => '?').join(', ')})`,
      projectId,
      ...chunkIds,
    );
    for (const chunk of chunks) locatorByChunk.set(Number(chunk.id), String(chunk.locator ?? ''));
  }

  const relations: DossierRelation[] = relationRows
    .map((row) => {
      const chunkId = firstChunkId(row.source_refs);
      return {
        kind: String(row.kind ?? ''),
        direction: Number(row.from_entity) === entityId ? 'out' as const : 'in' as const,
        other: { id: Number(row.other_id), name: String(row.other_name ?? '') },
        quote: String(row.evidence ?? ''),
        locator: chunkId === null ? '' : (locatorByChunk.get(chunkId) ?? ''),
        status: String(row.review_status ?? ''),
      };
    })
    .sort((left, right) =>
      relationRank(left.status) - relationRank(right.status)
      || left.other.name.localeCompare(right.other.name)
      || left.kind.localeCompare(right.kind));

  const entities = db.all<EntityRow>(
    'SELECT id, name, aliases, kind, summary, role, attributes FROM canon_entity WHERE project_id = ?',
    projectId,
  );
  const resolve = participantResolver(entities);
  const timeline = db.all<{
    seq: number;
    title: string;
    summary: string;
    participants: string;
    evidence: string;
    source_refs: string;
  }>(
    'SELECT seq, title, summary, participants, evidence, source_refs FROM canon_timeline WHERE project_id = ? ORDER BY seq',
    projectId,
  );
  const events: DossierEvent[] = [];
  for (const row of timeline) {
    const names = participantNames(row.participants);
    const resolved = names
      .map((name) => resolve(name))
      .filter((value): value is EntityRow => value !== null);
    const ids = [...new Set(resolved.map((value) => value.id))];
    if (!ids.includes(entityId) || ids.length === 0 || ids.length > 4) continue;
    const title = String(row.title ?? '');
    if (isGenericEvent(title, resolved.map((value) => value.name))) continue;
    const chunkId = firstChunkId(row.source_refs);
    events.push({
      seq: Number(row.seq ?? 0),
      title,
      summary: String(row.summary ?? ''),
      participants: resolved.map((value) => value.name),
      quote: String(row.evidence ?? ''),
      locator: chunkId === null ? '' : (locatorByChunk.get(chunkId) ?? ''),
    });
  }
  events.sort((left, right) => left.seq - right.seq);

  const chunks = db.all<ChunkRow>(
    'SELECT id, seq, locator, heading, text FROM canon_chunk WHERE project_id = ? ORDER BY seq, id',
    projectId,
  );
  const chapterMap = deriveChapterNumbers(chunks);
  const patterns = formsOf(entity).map(formPattern);
  const chapters = new Set<number>();
  for (const chunk of chunks) {
    if (!patterns.some((pattern) => pattern.test(String(chunk.text ?? '')))) continue;
    const chapter = chapterMap.get(Number(chunk.id))?.chapter;
    if (chapter !== undefined) chapters.add(chapter);
  }
  const orderedChapters = [...chapters].sort((left, right) => left - right);

  return {
    entityId: Number(entity.id),
    name: String(entity.name ?? ''),
    kind: String(entity.kind ?? ''),
    aliases,
    summary: String(entity.summary ?? ''),
    role: String(entity.role ?? ''),
    attributes: fromJson<Record<string, unknown> | null>(entity.attributes ?? '', null),
    status: entityMentionStatus(db, projectId, entityId),
    relations,
    events,
    firstChapter: orderedChapters[0] ?? null,
    lastChapter: orderedChapters[orderedChapters.length - 1] ?? null,
    counts: {
      relations: relations.length,
      events: events.length,
      chapters: orderedChapters.length,
    },
  };
}
