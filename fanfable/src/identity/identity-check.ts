/**
 * Identity collision pass.
 *
 * One canonical name should mean one entity. When it does not, the bank has a
 * defect that corrupts every relationship count — and a short form that names
 * one person while the bank stores the long form as another row is the same
 * defect seen from the other side.
 *
 * Rows are related when `nameRelation` says `same` or `containment`, judged on
 * names and aliases. A containment edge counts only when the shorter form could
 * identify someone on its own: it needs a substantial token, it must not be a
 * title or a token carried by most of the roster, and it must not be contained
 * in more than `NAME_GROUP_CAP` entities.
 *
 * The pass never merges, renames, deletes or re-kinds anything. It marks the
 * rows for a human to rule on, and says why. Idempotent: a second run finds
 * nothing new to flag.
 */
import { Db } from '../core/db.ts';
import { nameRelation } from './names.ts';
import {
  NAME_GROUP_CAP,
  containedCount,
  entityForms,
  loadIdentityContext,
  usableShortForm,
  type IdentityEntity,
} from './identity.ts';

export type CollisionEdge = 'same-form' | 'containment';

export interface IdentityCollision {
  ids: number[];
  kinds: string[];
  edge: CollisionEdge;
}

export interface IdentityCheckResult {
  /** Groups of two or more related rows. */
  collisions: IdentityCollision[];
  /** Entity pairs joined by a same-form relation. */
  sameFormEdges: number;
  /** Entity pairs joined by a usable containment relation. */
  containmentEdges: number;
  /** Entities marked (or, on a dry run, that would be marked). */
  flagged: number;
  /** Entities already carrying the flag, left as they are. */
  alreadyFlagged: number;
  quarantinedSkipped: number;
  /** Pairs rejected because the short form was too generic. */
  skippedByGroupCap: number;
  written: boolean;
}

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

function collisionReason(self: number, others: number[]): string {
  return `identity-collision: ${others.filter((id) => id !== self).join(',')}`;
}

/** Union-find over entity ids. */
function makeGroups(ids: number[]): { find: (id: number) => number; union: (a: number, b: number) => void } {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  return {
    find,
    union(a: number, b: number) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    },
  };
}

export function flagIdentityCollisions(
  db: Db,
  projectId: number,
  opts: { write?: boolean } = {},
): IdentityCheckResult {
  const write = opts.write === true;
  const context = loadIdentityContext(db, projectId);
  const entities = context.entities;
  const formsById = new Map(entities.map((entity) => [entity.id, entityForms(entity)]));
  const memo = new Map<string, number>();

  const result: IdentityCheckResult = {
    collisions: [],
    sameFormEdges: 0,
    containmentEdges: 0,
    flagged: 0,
    alreadyFlagged: 0,
    quarantinedSkipped: 0,
    skippedByGroupCap: 0,
    written: write,
  };

  const groups = makeGroups(entities.map((entity) => entity.id));
  const edgeOfPair = new Map<string, CollisionEdge>();

  for (let i = 0; i < entities.length; i++) {
    const left = entities[i]!;
    for (let j = i + 1; j < entities.length; j++) {
      const right = entities[j]!;
      const pairKey = `${left.id}|${right.id}`;
      if (edgeOfPair.has(pairKey)) continue;
      let edge: CollisionEdge | null = null;
      let rejectedByCap = false;
      for (const a of formsById.get(left.id)!) {
        for (const b of formsById.get(right.id)!) {
          const relation = nameRelation(a, b);
          if (relation === 'same') {
            edge = 'same-form';
            break;
          }
          if (relation !== 'containment') continue;
          const aTokens = a.split(' ').filter(Boolean);
          const bTokens = b.split(' ').filter(Boolean);
          const short = aTokens.length < bTokens.length ? a : b;
          if (usableShortForm(short, context.index, containedCount(short, entities, memo), isTitleToken)) {
            edge = 'containment';
            break;
          }
          rejectedByCap = true;
        }
        if (edge) break;
      }
      if (edge) {
        edgeOfPair.set(pairKey, edge);
        groups.union(left.id, right.id);
        if (edge === 'same-form') result.sameFormEdges++;
        else result.containmentEdges++;
      } else if (rejectedByCap) {
        result.skippedByGroupCap++;
      }
    }
  }

  const members = new Map<number, IdentityEntity[]>();
  for (const entity of entities) {
    const root = groups.find(entity.id);
    const list = members.get(root) ?? [];
    list.push(entity);
    members.set(root, list);
  }

  for (const root of [...members.keys()].sort((a, b) => a - b)) {
    const group = members.get(root)!;
    if (group.length < 2) continue;
    const ids = group.map((entity) => entity.id).sort((a, b) => a - b);
    const kinds = [...new Set(group.map((entity) => entity.kind))].sort();
    // A group is labelled by its strongest edge.
    let edge: CollisionEdge = 'containment';
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (edgeOfPair.get(`${ids[i]}|${ids[j]}`) === 'same-form') edge = 'same-form';
        if (edgeOfPair.get(`${ids[j]}|${ids[i]}`) === 'same-form') edge = 'same-form';
      }
    }
    result.collisions.push({ ids, kinds, edge });

    for (const entity of group) {
      if (entity.review_status === 'quarantined') {
        result.quarantinedSkipped++;
        continue;
      }
      const reason = collisionReason(entity.id, ids);
      if (entity.review_status === 'needs_review' && entity.quarantine_reason === reason) {
        result.alreadyFlagged++;
        continue;
      }
      result.flagged++;
      if (!write) continue;
      db.run(
        `UPDATE canon_entity SET review_status = 'needs_review', quarantine_reason = ?, updated_at = ?
          WHERE id = ? AND project_id = ?`,
        reason,
        new Date().toISOString(),
        entity.id,
        projectId,
      );
    }
  }

  return result;
}

/** Counts only, for measuring the effect of a matching change. */
export function countIdentityCollisions(db: Db, projectId: number): { sameForm: number; containment: number } {
  const result = flagIdentityCollisions(db, projectId);
  return { sameForm: result.sameFormEdges, containment: result.containmentEdges };
}
