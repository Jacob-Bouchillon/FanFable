/**
 * Identity: who a name refers to, and which rows are one person split.
 *
 * Two jobs share one rule. Collision flagging asks "are these rows the same
 * person?" and resolution asks "which row does this name mean?". Both answer it
 * with `nameRelation` (same form, or containment), not string equality, and
 * both refuse to guess when more than one row fits.
 *
 * Nothing here merges, renames or re-kinds. A collision is a flag for a human;
 * an ambiguous name stays ambiguous.
 */
import { Db, strList } from '../core/db.ts';
import {
  NAME_DF_CAP,
  buildRosterIndex,
  canonicalName,
  nameRelation,
  type RosterIndex,
} from './names.ts';

/**
 * A short form contained in more entities than this is too generic to identify
 * anyone; edges through it are dropped rather than flagging half the roster.
 */
export const NAME_GROUP_CAP = 8;

export interface IdentityEntity {
  id: number;
  name: string;
  aliases: string[];
  kind: string;
  review_status: string;
  quarantine_reason: string;
}

export interface IdentityContext {
  projectId: number;
  entities: IdentityEntity[];
  index: RosterIndex;
}

/** Every entity plus a roster index built over the project's text. */
export function loadIdentityContext(db: Db, projectId: number): IdentityContext {
  const entities = db
    .all<{ id: number; name: string; aliases: string; kind: string; review_status: string; quarantine_reason: string | null }>(
      `SELECT id, name, aliases, kind, review_status, quarantine_reason
         FROM canon_entity WHERE project_id = ? ORDER BY id`,
      projectId,
    )
    .map((row) => ({
      id: row.id,
      name: row.name,
      aliases: strList(row.aliases),
      kind: row.kind,
      review_status: row.review_status,
      quarantine_reason: String(row.quarantine_reason ?? ''),
    }));
  const text = db
    .all<{ text: string }>('SELECT text FROM canon_chunk WHERE project_id = ?', projectId)
    .map((row) => row.text)
    .join(' ');
  const index = buildRosterIndex(
    entities.map((entity) => ({ name: entity.name, aliases: entity.aliases })),
    text,
  );
  return { projectId, entities, index };
}

/** Canonical explicit forms of one entity (name first, then aliases). */
export function entityForms(entity: IdentityEntity): string[] {
  const forms = [entity.name, ...entity.aliases]
    .map((form) => canonicalName(form))
    .filter(Boolean);
  return [...new Set(forms)];
}

/**
 * Is the shorter form a name that could identify someone on its own?
 *
 * Rejects forms with no substantial token, forms that are a title, tokens that
 * appear in more entities than `NAME_DF_CAP`, and forms contained in more than
 * `NAME_GROUP_CAP` entities.
 */
export function usableShortForm(
  short: string,
  index: RosterIndex,
  containedCount: number,
  isUniversalTitle: (token: string) => boolean,
): boolean {
  const tokens = canonicalName(short).split(' ').filter(Boolean);
  if (!tokens.length) return false;
  if (!tokens.some((token) => token.length >= 3)) return false;
  if (tokens.some((token) => isUniversalTitle(token))) return false;
  for (const token of tokens) {
    if ((index.titleFreq.get(token) ?? 0) > NAME_DF_CAP) return false;
  }
  return containedCount <= NAME_GROUP_CAP;
}

/** How many entities carry a form that contains `short`. */
export function containedCount(
  short: string,
  entities: IdentityEntity[],
  memo: Map<string, number> = new Map(),
): number {
  const key = canonicalName(short);
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  const shortTokens = key.split(' ').filter(Boolean);
  let count = 0;
  for (const entity of entities) {
    const related = entityForms(entity).some((form) => {
      const tokens = form.split(' ').filter(Boolean);
      return tokens.length > shortTokens.length && shortTokens.every((token) => tokens.includes(token));
    });
    if (related) count++;
  }
  memo.set(key, count);
  return count;
}

export type ResolutionStatus = 'resolved' | 'ambiguous' | 'absent';
export type ResolutionHow = 'exact' | 'alias' | 'containment';

export interface EntityResolution {
  status: ResolutionStatus;
  id: number | null;
  name: string | null;
  how: ResolutionHow | null;
  /** Every candidate, ascending by id, when the answer is not unique. */
  candidates: { id: number; name: string }[];
}

export interface Resolver {
  resolve(name: string): EntityResolution;
  resolvePair(a: string, b: string): {
    a: EntityResolution;
    b: EntityResolution;
    status: ResolutionStatus;
  };
}

/**
 * Build a resolver once per run.
 *
 * Resolution order: exact stored name, then alias, then containment through a
 * usable short form. More than one candidate is `ambiguous` — the resolver
 * never picks one.
 */
export function createResolver(context: IdentityContext): Resolver {
  const memo = new Map<string, number>();
  const { entities, index } = context;

  const candidatesFor = (name: string): EntityResolution => {
    const query = canonicalName(name);
    if (!query) {
      return { status: 'absent', id: null, name: null, how: null, candidates: [] };
    }

    const exact: number[] = [];
    const alias: number[] = [];
    const containment: number[] = [];
    const seen = new Set<number>();

    for (const entity of entities) {
      const nameForm = canonicalName(entity.name);
      if (nameForm === query) {
        exact.push(entity.id);
        seen.add(entity.id);
        continue;
      }
      if (entity.aliases.some((form) => canonicalName(form) === query)) {
        alias.push(entity.id);
        seen.add(entity.id);
        continue;
      }
    }
    const direct = exact.length ? exact : alias;
    if (direct.length) {
      const how: ResolutionHow = exact.length ? 'exact' : 'alias';
      const unique = [...new Set(direct)].sort((a, b) => a - b);
      if (unique.length === 1) {
        const entity = entities.find((e) => e.id === unique[0]!)!;
        return { status: 'resolved', id: entity.id, name: entity.name, how, candidates: [] };
      }
      return {
        status: 'ambiguous',
        id: null,
        name: null,
        how: null,
        candidates: unique.map((id) => ({ id, name: entities.find((e) => e.id === id)!.name })),
      };
    }

    for (const entity of entities) {
      if (seen.has(entity.id)) continue;
      for (const form of entityForms(entity)) {
        if (nameRelation(form, query) !== 'containment') continue;
        const formTokens = form.split(' ').filter(Boolean);
        const queryTokens = query.split(' ').filter(Boolean);
        const short = formTokens.length < queryTokens.length ? form : query;
        if (!usableShortForm(short, index, containedCount(short, entities, memo), isTitleToken)) continue;
        containment.push(entity.id);
        break;
      }
    }
    const unique = [...new Set(containment)].sort((a, b) => a - b);
    if (unique.length === 1) {
      const entity = entities.find((e) => e.id === unique[0]!)!;
      return { status: 'resolved', id: entity.id, name: entity.name, how: 'containment', candidates: [] };
    }
    if (unique.length > 1) {
      return {
        status: 'ambiguous',
        id: null,
        name: null,
        how: null,
        candidates: unique.map((id) => ({ id, name: entities.find((e) => e.id === id)!.name })),
      };
    }
    return { status: 'absent', id: null, name: null, how: null, candidates: [] };
  };

  const cache = new Map<string, EntityResolution>();
  const resolve = (name: string): EntityResolution => {
    const key = canonicalName(name);
    const cached = cache.get(key);
    if (cached) return cached;
    const result = candidatesFor(name);
    cache.set(key, result);
    return result;
  };

  return {
    resolve,
    resolvePair(a: string, b: string) {
      const left = resolve(a);
      const right = resolve(b);
      const status: ResolutionStatus =
        left.status === 'ambiguous' || right.status === 'ambiguous'
          ? 'ambiguous'
          : left.status === 'absent' || right.status === 'absent'
            ? 'absent'
            : 'resolved';
      return { a: left, b: right, status };
    },
  };
}

/** Universal honorifics and kin titles: a bare title never identifies anyone. */
const TITLE_TOKENS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'sir', 'lady', 'lord', 'master', 'mistress', 'captain', 'commander',
  'general', 'admiral', 'colonel', 'major', 'sergeant', 'king', 'queen', 'prince', 'princess',
  'emperor', 'empress', 'count', 'countess', 'duke', 'duchess', 'baron', 'boss', 'senator',
  'chancellor', 'viceroy', 'magister', 'aunt', 'uncle', 'great', 'father', 'mother',
  'brother', 'sister', 'son', 'daughter', 'clan',
]);

function isTitleToken(token: string): boolean {
  return TITLE_TOKENS.has(token);
}

/** Resolve one name against the project's entities. */
export function resolveEntity(db: Db, projectId: number, name: string): EntityResolution {
  return createResolver(loadIdentityContext(db, projectId)).resolve(name);
}

/** Resolve both endpoints; ambiguous or absent on either side blocks the pair. */
export function resolvePair(
  db: Db,
  projectId: number,
  a: string,
  b: string,
): { a: EntityResolution; b: EntityResolution; status: ResolutionStatus } {
  return createResolver(loadIdentityContext(db, projectId)).resolvePair(a, b);
}
