/**
 * Read-only data for the dev visualizer.
 *
 * Local-only and never imported by the ship UI. No INSERT/UPDATE/DELETE.
 */
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { Db, fromJson, strList } from './db.ts';
import * as controller from './plan/controller.ts';
import * as loreDiag from './answer/lore-diagnostics.ts';

/** A short commit stamp for the dev page's provenance footer. */
const DEV_COMMIT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: import.meta.dirname,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
})();


interface DevChunkRow {
  id: number;
  seq: number;
  locator: string;
}

interface DevEntityRow {
  id: number;
  kind: string;
  name: string;
  aliases: string;
  summary: string;
  role: string;
  status: string;
  first_chunk: number | null;
  mentions: number;
  review_status: string | null;
}

interface DevRelationRow {
  id: number;
  from_entity: number;
  to_entity: number;
  from_name: string;
  to_name: string;
  kind: string;
  description: string;
  evidence: string;
  supporting_evidence: string;
  source_refs: string;
  review_status: string | null;
  modality: string | null;
  conflict_status: string | null;
  scope: string | null;
  ledger_state: string | null;
}

interface DevTimelineRow {
  id: number;
  seq: number;
  title: string;
  summary: string;
  time_label: string;
  participants: string;
  location: string;
  evidence: string;
  source_refs: string;
}

interface DevRef {
  source?: string;
  locator?: string;
  chunk?: number;
}

/** The first banked chunk reference, which is also the row's story position. */
function devRef(raw: string): DevRef | undefined {
  const refs = fromJson<{ source?: unknown; locator?: unknown; chunk?: unknown }[]>(raw, []);
  const found = refs.find((r) => Number.isFinite(Number(r?.chunk)) && Number(r?.chunk) > 0);
  const ref = found ?? refs[0];
  if (!ref) return undefined;
  const chunk = Number(ref.chunk);
  return {
    source: typeof ref.source === 'string' ? ref.source : undefined,
    locator: typeof ref.locator === 'string' ? ref.locator : undefined,
    chunk: Number.isFinite(chunk) && chunk > 0 ? chunk : undefined,
  };
}

/**
 * Read-only data for the dev visualizer.
 *
 * Every field comes from a bank row: names, quotes, locators, review states
 * and counts. Nothing is generated, and no INSERT/UPDATE/DELETE runs here.
 * The graph route the ship UI uses drops parked rows and hides source refs;
 * the visualizer needs both, so this thin aggregator exists beside it.
 */
export function devGraphSummary(db: Db, project: controller.Project) {
  const chunks = db.all<DevChunkRow>(
    'SELECT id, seq, locator FROM canon_chunk WHERE project_id = ? ORDER BY seq, id',
    project.id,
  );
  const chunkById = new Map(chunks.map((c) => [c.id, c]));

  const entities = db.all<DevEntityRow>(
    `SELECT id, kind, name, aliases, summary, role, status, first_chunk, mentions, review_status
       FROM canon_entity WHERE project_id = ? ORDER BY id`,
    project.id,
  );

  const relations = db.all<DevRelationRow>(
    `SELECT r.id, r.from_entity, r.to_entity, a.name AS from_name, b.name AS to_name,
            r.kind, r.description, r.evidence, r.supporting_evidence, r.source_refs, r.review_status,
            r.modality, r.conflict_status, r.scope, r.ledger_state
       FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ? ORDER BY r.id`,
    project.id,
  );

  const timeline = db.all<DevTimelineRow>(
    `SELECT id, seq, title, summary, time_label, participants, location, evidence, source_refs
       FROM canon_timeline WHERE project_id = ? ORDER BY seq, id`,
    project.id,
  );

  const count = (sql: string, ...params: unknown[]): number =>
    db.get<{ n: number }>(sql, ...params)?.n ?? 0;

  // Thin-name badges come from the same diagnostics the CLI reports; the
  // visualizer only reads the subjects, never the suggestions or prose.
  let thinNames = new Set<string>();
  try {
    for (const gap of loreDiag.diagnose(db, project.id, { limit: 200 })) {
      if (gap.kind === 'isolated-entity' || gap.kind === 'thin-entity') thinNames.add(gap.subject);
    }
  } catch {
    thinNames = new Set();
  }

  const keeperDegree = new Map<number, number>();
  const parkedDegree = new Map<number, number>();
  const coverageDegree = new Map<number, number>();
  const byType: Record<string, number> = {};
  const byReview: Record<string, number> = {};
  for (const r of relations) {
    const status = r.review_status ?? 'accepted';
    byType[r.kind] = (byType[r.kind] ?? 0) + 1;
    byReview[status] = (byReview[status] ?? 0) + 1;
    const keeper = status === 'accepted' || status === 'user_confirmed';
    const coverage = r.kind === 'appears_with';
    for (const id of [r.from_entity, r.to_entity]) {
      if (keeper) keeperDegree.set(id, (keeperDegree.get(id) ?? 0) + 1);
      else if (coverage) coverageDegree.set(id, (coverageDegree.get(id) ?? 0) + 1);
      else parkedDegree.set(id, (parkedDegree.get(id) ?? 0) + 1);
    }
  }

  const byKind: Record<string, number> = {};
  for (const e of entities) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;

  const nodes = entities.map((e) => {
    const chunk = e.first_chunk !== null ? chunkById.get(e.first_chunk) : undefined;
    return {
      id: e.id,
      name: e.name,
      kind: e.kind,
      aliases: strList(e.aliases),
      summary: e.summary,
      role: e.role,
      status: e.status,
      reviewStatus: e.review_status ?? 'accepted',
      mentions: e.mentions,
      firstChunk: e.first_chunk,
      firstSeq: chunk?.seq ?? null,
      locator: chunk?.locator ?? null,
      thin: thinNames.has(e.name),
      keeperTies: keeperDegree.get(e.id) ?? 0,
      parkedTies: parkedDegree.get(e.id) ?? 0,
      coverageTies: coverageDegree.get(e.id) ?? 0,
    };
  });

  const edges = relations.map((r) => {
    const ref = devRef(r.source_refs);
    const chunk = ref?.chunk !== undefined ? chunkById.get(ref.chunk) : undefined;
    return {
      id: r.id,
      fromId: r.from_entity,
      toId: r.to_entity,
      fromName: r.from_name,
      toName: r.to_name,
      kind: r.kind,
      description: r.description,
      evidence: r.evidence,
      supportingEvidence: (() => {
        try {
          const raw = JSON.parse(r.supporting_evidence || '[]');
          return Array.isArray(raw) ? raw : [];
        } catch { return []; }
      })(),
      reviewStatus: r.review_status ?? 'accepted',
      modality: r.modality ?? 'asserted',
      conflictStatus: r.conflict_status ?? 'none',
      scope: r.scope ?? '',
      ledgerState: r.ledger_state ?? 'verified',
      coverage: r.kind === 'appears_with',
      locator: ref?.locator ?? chunk?.locator ?? null,
      chunkSeq: chunk?.seq ?? null,
    };
  });

  const timelineEntries = timeline.map((t) => {
    const ref = devRef(t.source_refs);
    const chunk = ref?.chunk !== undefined ? chunkById.get(ref.chunk) : undefined;
    return {
      id: t.id,
      seq: t.seq,
      title: t.title,
      summary: t.summary,
      when: t.time_label,
      participants: strList(t.participants),
      location: t.location,
      evidence: t.evidence,
      locator: ref?.locator ?? chunk?.locator ?? null,
      chunkSeq: chunk?.seq ?? null,
    };
  });

  const keepers = relations.filter((r) => {
    const status = r.review_status ?? 'accepted';
    return status === 'accepted' || status === 'user_confirmed';
  }).length;

  return {
    project: { id: project.id, name: project.name },
    db: basename(db.path),
    commit: DEV_COMMIT,
    readOnly: true,
    maxChunkSeq: chunks.reduce((m, c) => Math.max(m, c.seq), 0),
    maxTimelineSeq: timeline.reduce((m, t) => Math.max(m, t.seq), 0),
    counts: {
      entities: entities.length,
      relations: relations.length,
      keepers,
      accepted: relations.filter((r) => (r.review_status ?? 'accepted') === 'accepted').length,
      userConfirmed: relations.filter((r) => r.review_status === 'user_confirmed').length,
      parked: relations.filter((r) => (r.review_status ?? 'accepted') === 'needs_review').length,
      provisional: relations.filter((r) => r.review_status === 'provisional').length,
      coverage: relations.filter((r) => r.kind === 'appears_with').length,
      pendingNotes: count(
        "SELECT COUNT(*) AS n FROM canon_tie_note WHERE project_id = ? AND status = 'pending'",
        project.id,
      ),
      quarantinePending: count(
        "SELECT COUNT(*) AS n FROM quarantine_alias WHERE project_id = ? AND status = 'pending'",
        project.id,
      ),
      timeline: timeline.length,
      chunks: chunks.length,
      byKind,
      byType,
      byReview,
    },
    thinNames: [...thinNames].sort((a, b) => a.localeCompare(b)),
    nodes,
    edges,
    timeline: timelineEntries,
  };
}

