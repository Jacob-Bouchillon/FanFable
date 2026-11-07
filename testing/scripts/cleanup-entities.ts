/**
 * Apply the general identity-cleanup rules to one work copy.
 *
 * No book-specific names live in this file; the optional --claims JSON carries
 * the verified evidence for the copy being cleaned.
 */
import { readFileSync } from 'node:fs';
import { Db } from '../../fanfable/src/core/db.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import {
  findAliasMerges,
  findNicknameAliases,
  findOwnershipClaims,
  findTypoVariants,
  loadEntities,
  surfaceFacts,
} from '../../fanfable/src/identity/cleanup.ts';
import {
  findEntity,
  insertEntityCandidate,
  insertOwnedCreatureRelation,
  mergeEntitiesWithRuling,
  quarantineEntity,
  reclassifyEntityKind,
  rejectRelation,
  setEntityAttributes,
} from '../../fanfable/src/lorebook.ts';

interface PetClaim {
  name: string;
  owner: string;
  quote: string;
  seq?: number;
  sentient?: boolean | null;
  speaks?: boolean | null;
}

interface Claims {
  pets?: PetClaim[];
  merges?: Array<{ keep: string; drop: string; basis?: string; quote?: string }>;
  species?: string[];
  rejects?: Array<{ relationId: number; basis?: string }>;
  annotate?: Array<{
    name: string;
    kind?: string;
    sentient?: boolean | null;
    speaks?: boolean | null;
    quote?: string;
  }>;
  add?: Array<{
    name: string;
    kind: string;
    quote: string;
    seq?: number;
    sentient?: boolean | null;
    speaks?: boolean | null;
  }>;
  quarantine?: Array<{ name: string; reason: string }>;
  typoSkip?: string[];
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dbPath = flag('db');
const projectName = flag('project') ?? 'hp1';
const phase = flag('phase') ?? 'report';
const write = process.argv.includes('--write');
const claimsPath = flag('claims');
if (!dbPath) {
  console.error('usage: node --no-warnings testing/scripts/cleanup-entities.ts --db <path> --project <name> --phase <typo|nickname|alias|pets|species|owl|report> [--write] [--claims <json>]');
  process.exit(2);
}

const claims: Claims = claimsPath ? JSON.parse(readFileSync(claimsPath, 'utf8')) as Claims : {};
const db = new Db(dbPath);

function normalize(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function includeQuote(db: Db, projectId: number, text: string, seq?: number): { chunkId: number; locator: string } | null {
  const quote = normalize(text);
  if (!quote) return null;
  const chunks = seq === undefined
    ? db.all<{ id: number; locator: string; text: string }>(
      'SELECT id, locator, text FROM canon_chunk WHERE project_id = ? ORDER BY seq, id', projectId)
    : db.all<{ id: number; locator: string; text: string }>(
      'SELECT id, locator, text FROM canon_chunk WHERE project_id = ? AND seq = ?', projectId, seq);
  for (const chunk of chunks) {
    if (normalize(chunk.text).includes(quote)) {
      return { chunkId: Number(chunk.id), locator: String(chunk.locator ?? '') };
    }
  }
  return null;
}

function requireEntity(projectId: number, name: string): ReturnType<typeof findEntity> {
  return findEntity(db, projectId, name);
}

function counts(projectId: number): Record<string, number> {
  const one = (sql: string, ...args: unknown[]): number =>
    Number(db.get<{ n: number }>(sql, ...args)?.n ?? 0);
  return {
    entities: one('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', projectId),
    characters: one("SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ? AND kind = 'character'", projectId),
    creatures: one("SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ? AND kind = 'creature'", projectId),
    species: one("SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ? AND kind = 'species'", projectId),
    relations: one('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', projectId),
    timeline: one('SELECT COUNT(*) AS n FROM canon_timeline WHERE project_id = ?', projectId),
    quarantined: one("SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ? AND review_status = 'quarantined'", projectId),
  };
}

try {
  const project = controller.getProjectByName(db, projectName);
  if (!project) throw new Error(`no project named "${projectName}"`);
  const projectId = project.id;
  const before = counts(projectId);
  const report: Record<string, unknown> = { phase, write, before };

  if (phase === 'typo') {
    const skip = new Set((claims.typoSkip ?? []).map((name) => name.toLowerCase()));
    const variants = findTypoVariants(db, projectId).filter((variant) => !skip.has(variant.name.toLowerCase()));
    const applied: string[] = [];
    for (const variant of variants) {
      if (!write) continue;
      const reason = `typo variant of ${variant.canonicalName}`;
      if (quarantineEntity(db, projectId, variant.entityId, reason, `${variant.reason}; ${variant.canonicalName}`, '')) {
        applied.push(`${variant.name} -> quarantined as ${reason}`);
      }
    }
    report.variants = variants;
    report.applied = applied;
    for (const quarantine of claims.quarantine ?? []) {
      const entity = requireEntity(projectId, quarantine.name);
      report.applied = applied;
      if (!write || !entity) continue;
      if (quarantineEntity(db, projectId, entity.id, quarantine.reason, quarantine.reason, '')) {
        applied.push(`${quarantine.name} -> quarantined (${quarantine.reason})`);
      }
    }
    report.applied = applied;
  }

  if (phase === 'nickname') {
    const nicknames = findNicknameAliases(db, projectId);
    const applied: string[] = [];
    for (const nickname of nicknames) {
      if (!write) continue;
      if (nickname.personId !== null) {
        if (mergeEntitiesWithRuling(db, projectId, nickname.personId, nickname.entityId,
          `nickname alias: ${nickname.name} -> ${nickname.personName}`, nickname.evidence)) {
          applied.push(`${nickname.name} -> ${nickname.personName}`);
        }
      } else {
        const reason = nickname.ambiguous.length
          ? `nickname ambiguous: ${nickname.ambiguous.join(' / ')}`
          : 'nickname unresolved';
        if (quarantineEntity(db, projectId, nickname.entityId, reason, reason, nickname.evidence)) {
          applied.push(`${nickname.name} -> quarantined (${reason})`);
        }
      }
    }
    report.nicknames = nicknames;
    report.applied = applied;
  }

  if (phase === 'alias') {
    const merges = findAliasMerges(db, projectId);
    const applied: string[] = [];
    for (const merge of merges) {
      if (!write) continue;
      if (mergeEntitiesWithRuling(db, projectId, merge.keepId, merge.dropId,
        `${merge.basis}: ${merge.dropName} -> ${merge.keepName}`, merge.quote)) {
        applied.push(`${merge.dropName} -> ${merge.keepName} (${merge.basis})`);
      }
    }
    report.merges = merges;
    report.applied = applied;
  }

  if (phase === 'pets') {
    const claimsReport: Array<Record<string, unknown>> = [];
    const discovered = findOwnershipClaims(db, projectId);
    for (const pet of claims.pets ?? []) {
      const entity = requireEntity(projectId, pet.name);
      const owner = requireEntity(projectId, pet.owner);
      const support = includeQuote(db, projectId, pet.quote, pet.seq);
      claimsReport.push({
        name: pet.name,
        owner: pet.owner,
        entityId: entity?.id ?? null,
        ownerId: owner?.id ?? null,
        quoteVerified: support !== null,
      });
      if (!write || !entity || !owner || !support) continue;
      if (entity.kind !== 'creature') {
        reclassifyEntityKind(db, projectId, entity.id, 'creature', `pet: ${pet.name}`, pet.quote);
      }
      setEntityAttributes(db, projectId, entity.id, {
        sentient: pet.sentient ?? null,
        speaks: pet.speaks ?? null,
      }, `pet facts: ${pet.name}`, pet.quote);
      const refs = JSON.stringify([{ locator: support.locator, chunk: support.chunkId }]);
      insertOwnedCreatureRelation(db, projectId, owner.id, entity.id, pet.quote, refs);
    }
    for (const merge of claims.merges ?? []) {
      const keep = requireEntity(projectId, merge.keep);
      const drop = requireEntity(projectId, merge.drop);
      claimsReport.push({ merge: `${merge.drop} -> ${merge.keep}`, keepId: keep?.id ?? null, dropId: drop?.id ?? null });
      if (!write || !keep || !drop) continue;
      mergeEntitiesWithRuling(db, projectId, keep.id, drop.id, merge.basis ?? 'named individual', merge.quote ?? '');
    }
    for (const name of claims.species ?? []) {
      const entity = requireEntity(projectId, name);
      claimsReport.push({ species: name, entityId: entity?.id ?? null, was: entity?.kind ?? null });
      if (!write || !entity) continue;
      reclassifyEntityKind(db, projectId, entity.id, 'species', `plural breed: ${name}`, entity.evidence);
    }
    for (const annotation of claims.annotate ?? []) {
      const entity = requireEntity(projectId, annotation.name);
      claimsReport.push({ annotate: annotation.name, entityId: entity?.id ?? null });
      if (!write || !entity) continue;
      if (annotation.kind) reclassifyEntityKind(db, projectId, entity.id, annotation.kind as never, `annotate: ${annotation.name}`, annotation.quote ?? '');
      setEntityAttributes(db, projectId, entity.id, {
        sentient: annotation.sentient ?? null,
        speaks: annotation.speaks ?? null,
      }, `text facts: ${annotation.name}`, annotation.quote ?? '');
    }
    for (const addition of claims.add ?? []) {
      const support = includeQuote(db, projectId, addition.quote, addition.seq);
      claimsReport.push({ add: addition.name, quoteVerified: support !== null });
      if (!write || !support) continue;
      const id = insertEntityCandidate(db, projectId, {
        kind: addition.kind as never,
        name: addition.name,
        evidence: addition.quote,
        firstChunk: support.chunkId,
        sourceRefs: JSON.stringify([{ locator: support.locator, chunk: support.chunkId }]),
        attributes: { sentient: addition.sentient ?? null, speaks: addition.speaks ?? null },
      });
      claimsReport.push({ add: addition.name, entityId: id });
    }
    report.discovered = discovered;
    report.claims = claimsReport;
  }

  if (phase === 'species') {
    const facts = surfaceFacts(db, projectId);
    const entities = loadEntities(db, projectId).filter((entity) => entity.kind === 'creature');
    const applied: string[] = [];
    for (const entity of entities) {
      if (!facts.isPlural(entity.name)) continue;
      if (write) {
        if (reclassifyEntityKind(db, projectId, entity.id, 'species', `plural creature surface: ${entity.name}`, '')) {
          applied.push(`${entity.name} -> species`);
        }
      } else {
        applied.push(`${entity.name} -> species`);
      }
    }
    report.applied = applied;
  }

  if (phase === 'owl') {
    const facts = surfaceFacts(db, projectId);
    const entities = loadEntities(db, projectId);
    const byId = new Map(entities.map((entity) => [entity.id, entity]));
    const relations = db.all<{ id: number; from_entity: number; to_entity: number; kind: string; evidence: string; review_status: string }>(
      "SELECT id, from_entity, to_entity, kind, evidence, review_status FROM canon_relation WHERE project_id = ? AND kind = 'acquaintance'",
      projectId,
    );
    const applied: string[] = [];
    for (const relation of relations) {
      const from = byId.get(Number(relation.from_entity));
      const to = byId.get(Number(relation.to_entity));
      if (!from || !to) continue;
      const animal = facts.isCommonSurface(to.name) && from.kind === 'character'
        ? to
        : facts.isCommonSurface(from.name) && to.kind === 'character' ? from : null;
      if (!animal) continue;
      if (write) {
        rejectRelation(db, projectId, Number(relation.id), "superseded-by:Malfoy's eagle owl", relation.evidence);
        quarantineEntity(db, projectId, animal.id, 'generic animal, not an individual', `relation ${relation.id} rejected`, relation.evidence);
        applied.push(`relation ${relation.id} rejected; ${animal.name} quarantined`);
      } else {
        applied.push(`relation ${relation.id} would be rejected; ${animal.name} quarantined`);
      }
    }
    for (const reject of claims.rejects ?? []) {
      if (!write) continue;
      if (rejectRelation(db, projectId, reject.relationId, reject.basis ?? 'cleanup', '')) {
        applied.push(`relation ${reject.relationId} rejected`);
      }
    }
    report.applied = applied;
  }

  if (phase === 'report') {
    report.entities = loadEntities(db, projectId);
    report.ownership = findOwnershipClaims(db, projectId);
  }

  report.after = counts(projectId);
  console.log(JSON.stringify(report, null, 2));
} finally {
  db.close();
}
