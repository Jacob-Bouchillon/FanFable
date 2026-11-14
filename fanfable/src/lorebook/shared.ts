/**
 * Small helpers shared by more than one lorebook module.
 *
 * This file exists so that moving a section out of `lorebook.ts` does not mean
 * also moving every one-line helper it touches. Anything here must be used by
 * at least two modules; anything used by one belongs in that module.
 */
import { Db, strList } from '../core/db.ts';
import { normalise } from '../core/text.ts';
import type { EndpointResolutionMethod, TracedEndpointResolution } from '../trace/extraction-trace.ts';
import { canonicalName } from '../identity/names.ts';
import type { ChunkRow, EntityKind } from '../lorebook.ts';

/**
 * The first chunk id named by a row's `source_refs` JSON.
 *
 * A malformed reference is simply no reference: the caller decides whether
 * that matters, and inventing a fallback here would hide bad data.
 */
export function firstChunkOf(sourceRefs: string): number | undefined {
  try {
    const refs = JSON.parse(sourceRefs || '[]') as { chunk?: unknown }[];
    for (const ref of refs) {
      const id = Number(ref?.chunk);
      if (Number.isFinite(id) && id > 0) return id;
    }
  } catch {
    /* a malformed reference is simply no reference */
  }
  return undefined;
}

/**
 * The model's kind word, defensively.
 *
 * Species words are a people; animal and beast words are a creature; anything
 * unrecognised keeps the historical character fallback so old and stray values
 * behave exactly as before.
 */
export function normaliseKind(kind: string): EntityKind {
  const k = kind.toLowerCase();
  if (k.includes('loc') || k.includes('place')) return 'location';
  if (k.includes('item') || k.includes('object') || k.includes('thing')) return 'item';
  if (k.includes('rule') || k.includes('law') || k.includes('magic') || k.includes('lore')) return 'rule';
  if (k.includes('faction') || k.includes('group') || k.includes('family')) return 'faction';
  // Organisations and the roles they hold are never people. The schema has no
  // role bucket, so both land in `faction`: a non-person row that can still
  // carry membership, instead of a character invented from a job title.
  if (
    k.includes('organi') ||
    k.includes('company') ||
    k.includes('guild') ||
    k.includes('order') ||
    k.includes('institution') ||
    k.includes('role') ||
    k.includes('rank') ||
    k.includes('occupation')
  ) {
    return 'faction';
  }
  if (
    k.includes('species') ||
    k.includes('race') ||
    k.includes('people') ||
    k.includes('folk') ||
    k.includes('lineage') ||
    k.includes('bloodline')
  ) {
    return 'species';
  }
  if (k.includes('creature') || k.includes('animal') || k.includes('beast')) return 'creature';
  return 'character';
}

// ---------------------------------------------------------------- entities

export function key(name: string): string {
  return name.trim().toLowerCase();
}

export function findEntityId(db: Db, projectId: number, kind: EntityKind, name: string): number | undefined {
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
  if (alias) return alias.id;
  // A stored alias is the same person under a shorter name. Without this the
  // extractor created a second entity for every short form the model used:
  // the book had "Ronald Weasley" with alias "Ron", and a window that wrote
  // "Ron" found no match and banked a new character called "Ron". That pair
  // then made the short form ambiguous for every later relation, so those
  // relations were demoted to hints instead of being banked — which is why a
  // fully mined chapter can end up with almost no ties.
  //
  // Only an unambiguous alias counts. Two entities claiming the same form is
  // an identity question, not something to guess: the caller keeps its
  // existing behaviour and the collision is reported.
  const owners = db.all<{ id: number }>(
    `SELECT e.id
       FROM canon_entity e, json_each(CASE WHEN json_valid(e.aliases) THEN e.aliases ELSE '[]' END) a
      WHERE e.project_id = ? AND lower(a.value) = lower(?)`,
    projectId,
    name,
  );
  return owners.length === 1 ? owners[0]!.id : undefined;
}

/**
 * Resolve a relationship endpoint against the current project roster.
 *
 * Canonical exact name, then canonical exact stored alias, then the existing
 * unique single-token short-name rule. More than one candidate is ambiguous
 * and returns undefined, so the caller keeps its existing unresolved hint.
 * This deliberately does not import an alias from another row, merge records
 * or fall through to a different kind. No result is cached: extraction adds
 * entities between windows, and a unique short form can become ambiguous.
 */
export function resolveEntityDetailedFromRows(
  rows: Array<{ id: number; name: string; aliases: string }>,
  name: string,
): TracedEndpointResolution {
  const query = canonicalName(name);
  if (!query) return { method: 'empty', candidateIds: [] };

  const nameHits = rows
    .filter((row) => canonicalName(row.name) === query)
    .map((row) => row.id);
  const aliasHits = rows
    .filter((row) => strList(row.aliases).some((alias) => canonicalName(alias) === query))
    .map((row) => row.id);
  // An exact name and another entity's alias are both direct matches. They
  // must be compared as one candidate set; returning the name hit first would
  // silently assign the alias collision to one entity.
  const directHits = [...new Set([...nameHits, ...aliasHits])];
  if (directHits.length === 1) {
    const method: EndpointResolutionMethod =
      nameHits.length && aliasHits.length
        ? 'direct-mixed'
        : nameHits.length
          ? 'direct-name'
          : 'direct-alias';
    return { id: directHits[0], method, candidateIds: directHits };
  }
  if (directHits.length > 1) {
    return { method: 'direct-collision', candidateIds: directHits };
  }

  const tokens = query.split(' ').filter(Boolean);
  if (tokens.length !== 1) return { method: 'none', candidateIds: [] };
  const needle = tokens[0]!;
  if (needle.length < 3) return { method: 'none', candidateIds: [] };
  const shortHits = rows
    .filter((row) =>
      [row.name, ...strList(row.aliases)].some((value) =>
        canonicalName(value).split(' ').includes(needle),
      ),
    )
    .map((row) => row.id);
  if (shortHits.length === 1) return { id: shortHits[0], method: 'short-name', candidateIds: shortHits };
  if (shortHits.length > 1) return { method: 'short-collision', candidateIds: shortHits };
  return { method: 'none', candidateIds: [] };
}

export function resolveEntityDetailed(
  db: Db,
  projectId: number,
  name: string,
): TracedEndpointResolution {
  const rows = db.all<{ id: number; name: string; aliases: string }>(
    'SELECT id, name, aliases FROM canon_entity WHERE project_id = ? ORDER BY id',
    projectId,
  );
  return resolveEntityDetailedFromRows(rows, name);
}

export function resolveEntity(
  db: Db,
  projectId: number,
  name: string,
): number | undefined {
  return resolveEntityDetailed(db, projectId, name).id;
}

// --------------------------------------------------------------- passages

export function chunkAt(window: ChunkRow[], idx: unknown): ChunkRow | undefined {
  const i = Number(idx);
  return Number.isFinite(i) ? window[i] : undefined;
}

export function refsFor(
  chunk: ChunkRow | undefined,
): { source: string; locator: string; chunk?: number; chunk_start?: number; chunk_end?: number }[] {
  if (!chunk) return [];
  return [{
    source: chunk.source_title,
    locator: chunk.locator,
    chunk: chunk.id,
    ...(chunk.chunk_start === undefined ? {} : { chunk_start: chunk.chunk_start }),
    ...(chunk.chunk_end === undefined ? {} : { chunk_end: chunk.chunk_end }),
  }];
}

// ------------------------------------------------------------ quotations

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
export function verifyQuote(
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

