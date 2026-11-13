/**
 * Rulings export and replay.
 *
 * A rulings export is the portable record of what the bank decided: keepers,
 * tie-note rulings and identities, each with the quote that settled it. This
 * module writes that payload and replays one into a fresh bank, so a bank can
 * be rebuilt from its verdicts instead of re-read from the book.
 *
 * Moved verbatim out of lorebook.ts (2026-11-13); no logic changed. Replay
 * never merges entities and never edits a note: identities are read-only, and
 * every write goes through the court record.
 */
import { Db, fromJson, nowIso, strList } from '../core/db.ts';
import { compareText, normalise } from '../core/text.ts';
import { newClaimUid } from '../court/claim-proof.ts';
import { recordRuling } from '../court/ruling.ts';
import { canonicalName } from '../identity/names.ts';
import { relationStatusOf } from '../identity/relation-proof.ts';
import { loadOrderedChunks, type ChunkRow } from '../lorebook.ts';

const RULINGS_VERSION = 1 as const;

export interface RulingsExportKeeper {
  /** Stable claim instance identity, when the export carries one. */
  claim_uid?: string;
  from_name: string;
  from_aliases: string[];
  to_name: string;
  to_aliases: string[];
  kind: string;
  review_status: string;
  evidence: string;
  locator: string;
  exported_at: string;
  /** True when a human confirmed this row. A label for replay, never a tier. */
  confirmed_by_user?: boolean;
}

export interface RulingsExportNote {
  from_name: string;
  to_name: string;
  attempted_kind: string;
  status: string;
  ruling: string;
  evidence: string;
}

export interface RulingsExportIdentity {
  name: string;
  aliases: string[];
}

export interface RulingsExport {
  version: 1;
  counters: {
    project: string;
    keepers: number;
    note_rulings: number;
    identities: number;
  };
  keepers: RulingsExportKeeper[];
  note_rulings: RulingsExportNote[];
  identities: RulingsExportIdentity[];
}

export type RulingUnresolvedReason = 'name not found' | 'quote not found' | 'ambiguous name' | 'evidence-required';

export interface RulingReplayCategory {
  total: number;
  resolved: number;
  applied: number;
  already_present: number;
  unresolved: number;
}

export interface RulingReplayIssue {
  category: 'keeper' | 'note_ruling' | 'identity';
  from: string;
  to: string;
  kind: string;
  reason: RulingUnresolvedReason;
}

export interface RulingReplayResult {
  keepers: RulingReplayCategory;
  note_rulings: RulingReplayCategory;
  identities: RulingReplayCategory;
  total: RulingReplayCategory;
  issues: RulingReplayIssue[];
}

/** Codepoint order keeps exports byte-identical on every machine. */
function sortedAliases(value: unknown): string[] {
  const aliases = strList(value)
    .map((alias) => alias.trim())
    .filter(Boolean);
  return [...new Set(aliases)].sort(compareText);
}

/**
 * Every decision the author made, keyed by name rather than by row id.
 *
 * A rescan rewrites chunk and entity ids, so ids cannot travel. Names, aliases
 * and quotes can: this payload is what a fresh bank replays.
 */
export function exportRulings(
  db: Db,
  projectId: number,
  opts: { now?: string } = {},
): RulingsExport {
  const project = db.get<{ name: string }>('SELECT name FROM project WHERE id = ?', projectId);
  if (!project) throw new Error(`no project with id ${projectId}`);
  const exportedAt = opts.now ?? nowIso();
  const entities = db.all<{ id: number; name: string; aliases: string }>(
    'SELECT id, name, aliases FROM canon_entity WHERE project_id = ?',
    projectId,
  );
  const byId = new Map(entities.map((row) => [row.id, row]));

  const keepers: RulingsExportKeeper[] = [];
  for (const row of db.all<{
    claim_uid: string | null;
    from_entity: number;
    to_entity: number;
    kind: string;
    review_status: string;
    confirmed_by_user: number | null;
    evidence: string;
    source_refs: string;
  }>(
    `SELECT claim_uid, from_entity, to_entity, kind, review_status, confirmed_by_user, evidence, source_refs
       FROM canon_relation
      WHERE project_id = ? AND review_status IN ('accepted','user_confirmed')`,
    projectId,
  )) {
    const from = byId.get(row.from_entity);
    const to = byId.get(row.to_entity);
    if (!from || !to) continue;
    const refs = fromJson<{ locator?: unknown }[]>(row.source_refs, []);
    const locator = refs
      .map((ref) => (typeof ref?.locator === 'string' ? ref.locator.trim() : ''))
      .find(Boolean) ?? '';
    keepers.push({
      claim_uid: row.claim_uid ?? undefined,
      from_name: from.name,
      from_aliases: sortedAliases(from.aliases),
      to_name: to.name,
      to_aliases: sortedAliases(to.aliases),
      kind: row.kind,
      review_status: row.review_status,
      // The label travels with the keeper so replay can restore it without
      // inventing a tier. Export is the only way a verdict survives a wipe.
      confirmed_by_user: row.confirmed_by_user === 1,
      evidence: row.evidence,
      locator,
      exported_at: exportedAt,
    });
  }
  keepers.sort(
    (a, b) =>
      compareText(a.from_name, b.from_name) ||
      compareText(a.to_name, b.to_name) ||
      compareText(a.kind, b.kind) ||
      compareText(a.review_status, b.review_status) ||
      compareText(a.evidence, b.evidence) ||
      compareText(a.locator, b.locator) ||
      compareText(a.claim_uid ?? '', b.claim_uid ?? ''),
  );

  const noteRulings: RulingsExportNote[] = [];
  for (const row of db.all<{
    from_entity: number;
    to_entity: number;
    attempted_kind: string;
    status: string;
    ruling: string;
    evidence: string;
  }>(
    `SELECT from_entity, to_entity, attempted_kind, status, ruling, evidence
       FROM canon_tie_note
      WHERE project_id = ? AND ruling != ''`,
    projectId,
  )) {
    const from = byId.get(row.from_entity);
    const to = byId.get(row.to_entity);
    if (!from || !to) continue;
    noteRulings.push({
      from_name: from.name,
      to_name: to.name,
      attempted_kind: row.attempted_kind,
      status: row.status,
      ruling: row.ruling,
      evidence: row.evidence,
    });
  }
  noteRulings.sort(
    (a, b) =>
      compareText(a.from_name, b.from_name) ||
      compareText(a.to_name, b.to_name) ||
      compareText(a.attempted_kind, b.attempted_kind) ||
      compareText(a.status, b.status) ||
      compareText(a.ruling, b.ruling),
  );

  const identities: RulingsExportIdentity[] = entities
    .map((row) => ({ name: row.name, aliases: sortedAliases(row.aliases) }))
    .filter((row) => row.aliases.length > 0)
    .sort((a, b) => compareText(a.name, b.name));

  return {
    version: RULINGS_VERSION,
    counters: {
      project: project.name,
      keepers: keepers.length,
      note_rulings: noteRulings.length,
      identities: identities.length,
    },
    keepers,
    note_rulings: noteRulings,
    identities,
  };
}

/** Reject anything that is not a complete rulings export, with the reason. */
export function parseRulingsExport(value: unknown): RulingsExport {
  const fail = (detail: string): never => {
    throw new Error(`not a rulings export: ${detail}`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected a JSON object');
  const record = value as Record<string, unknown>;
  if (record.version !== RULINGS_VERSION) fail(`unsupported version ${String(record.version)}`);
  const counters = record.counters;
  if (!counters || typeof counters !== 'object' || Array.isArray(counters)) fail('missing counters');
  const rawProject = (counters as Record<string, unknown>).project;
  if (typeof rawProject !== 'string' || !rawProject.trim()) {
    fail('counters.project must be a non-empty string');
  }
  const project = rawProject as string;
  const asText = (raw: Record<string, unknown>, field: string, where: string): string => {
    const v = raw[field];
    if (typeof v === 'string') return v;
    return fail(`${where}.${field} must be a string`);
  };
  const asAliases = (raw: Record<string, unknown>, field: string, where: string): string[] => {
    const v = raw[field];
    if (!Array.isArray(v) || v.some((item) => typeof item !== 'string')) {
      fail(`${where}.${field} must be an array of strings`);
    }
    return (v as string[]).map((item) => item.trim()).filter(Boolean);
  };
  const asList = (field: 'keepers' | 'note_rulings' | 'identities'): Record<string, unknown>[] => {
    const v = record[field];
    if (!Array.isArray(v)) fail(`${field} must be an array`);
    return (v as unknown[]).map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        fail(`${field}[${index}] must be an object`);
      }
      return item as Record<string, unknown>;
    });
  };

  const keepers = asList('keepers').map((raw, index): RulingsExportKeeper => {
    const where = `keepers[${index}]`;
    const fromName = asText(raw, 'from_name', where).trim();
    const toName = asText(raw, 'to_name', where).trim();
    if (!fromName) fail(`${where}.from_name is empty`);
    if (!toName) fail(`${where}.to_name is empty`);
    return {
      claim_uid: typeof raw.claim_uid === 'string' && raw.claim_uid.trim() ? raw.claim_uid.trim() : undefined,
      from_name: fromName,
      from_aliases: asAliases(raw, 'from_aliases', where),
      to_name: toName,
      to_aliases: asAliases(raw, 'to_aliases', where),
      kind: asText(raw, 'kind', where),
      review_status: asText(raw, 'review_status', where),
      // Older exports predate the label; absent means "no verdict recorded"
      // and the keeper replays as an ordinary evidence-backed row.
      confirmed_by_user: raw.confirmed_by_user === true,
      evidence: asText(raw, 'evidence', where),
      locator: asText(raw, 'locator', where),
      exported_at: asText(raw, 'exported_at', where),
    };
  });

  const noteRulings = asList('note_rulings').map((raw, index): RulingsExportNote => {
    const where = `note_rulings[${index}]`;
    const fromName = asText(raw, 'from_name', where).trim();
    const toName = asText(raw, 'to_name', where).trim();
    if (!fromName) fail(`${where}.from_name is empty`);
    if (!toName) fail(`${where}.to_name is empty`);
    return {
      from_name: fromName,
      to_name: toName,
      attempted_kind: asText(raw, 'attempted_kind', where),
      status: asText(raw, 'status', where),
      ruling: asText(raw, 'ruling', where),
      evidence: asText(raw, 'evidence', where),
    };
  });

  const identities = asList('identities').map((raw, index): RulingsExportIdentity => {
    const where = `identities[${index}]`;
    const name = asText(raw, 'name', where).trim();
    if (!name) fail(`${where}.name is empty`);
    return { name, aliases: asAliases(raw, 'aliases', where) };
  });

  return {
    version: RULINGS_VERSION,
    counters: {
      project,
      keepers: keepers.length,
      note_rulings: noteRulings.length,
      identities: identities.length,
    },
    keepers,
    note_rulings: noteRulings,
    identities,
  };
}

interface RulingsResolver {
  resolve(name: string, aliases: string[]): { id: number } | { reason: RulingUnresolvedReason };
  resolveName(name: string): { id: number } | { reason: RulingUnresolvedReason };
}

/**
 * Exact resolution only: stored name, canonical name, then canonical alias.
 *
 * The export's own identities are a last resort, so a survivor whose alias the
 * rescan dropped can still be named by the alias the author used.
 */
function buildRulingsResolver(
  db: Db,
  projectId: number,
  exportedIdentities: RulingsExportIdentity[],
): RulingsResolver {
  const rows = db.all<{ id: number; name: string; aliases: string }>(
    'SELECT id, name, aliases FROM canon_entity WHERE project_id = ?',
    projectId,
  );
  const byRawName = new Map<string, number[]>();
  const byCanonicalName = new Map<string, number[]>();
  const byCanonicalAlias = new Map<string, number[]>();
  const push = (map: Map<string, number[]>, key: string, id: number): void => {
    if (!key) return;
    const list = map.get(key);
    if (!list) map.set(key, [id]);
    else if (!list.includes(id)) list.push(id);
  };
  for (const row of rows) {
    push(byRawName, row.name.trim().toLowerCase(), row.id);
    push(byCanonicalName, canonicalName(row.name), row.id);
    for (const alias of strList(row.aliases)) push(byCanonicalAlias, canonicalName(alias), row.id);
  }
  const exportedAlias = new Map<string, string>();
  const exportedIdentity = new Map<string, RulingsExportIdentity>();
  for (const identity of exportedIdentities) {
    const nameKey = canonicalName(identity.name);
    if (nameKey && !exportedIdentity.has(nameKey)) exportedIdentity.set(nameKey, identity);
    for (const alias of identity.aliases) {
      const key = canonicalName(alias);
      if (key && !exportedAlias.has(key)) exportedAlias.set(key, identity.name);
    }
  }
  const single = (ids: number[] | undefined): { id: number } | { reason: RulingUnresolvedReason } => {
    if (!ids || ids.length === 0) return { reason: 'name not found' };
    if (ids.length > 1) return { reason: 'ambiguous name' };
    return { id: ids[0]! };
  };
  const resolveName = (name: string): { id: number } | { reason: RulingUnresolvedReason } => {
    const clean = name.trim();
    if (!clean) return { reason: 'name not found' };
    const raw = byRawName.get(clean.toLowerCase());
    if (raw && raw.length === 1) return { id: raw[0]! };
    if (raw && raw.length > 1) return { reason: 'ambiguous name' };
    const canonical = canonicalName(clean);
    const named = byCanonicalName.get(canonical);
    if (named && named.length) return single(named);
    const aliased = byCanonicalAlias.get(canonical);
    if (aliased && aliased.length) return single(aliased);
    return { reason: 'name not found' };
  };
  const resolve = (name: string, aliases: string[]): { id: number } | { reason: RulingUnresolvedReason } => {
    const direct = resolveName(name);
    if ('id' in direct || direct.reason === 'ambiguous name') return direct;
    const viaExport = exportedAlias.get(canonicalName(name));
    if (viaExport) {
      const mapped = resolveName(viaExport);
      if ('id' in mapped || mapped.reason === 'ambiguous name') return mapped;
    }
    // The survivor may have been re-extracted under one of its old aliases.
    const identity = exportedIdentity.get(canonicalName(name));
    if (identity) {
      for (const alias of identity.aliases) {
        const hit = resolveName(alias);
        if ('id' in hit || hit.reason === 'ambiguous name') return hit;
      }
    }
    for (const alias of aliases) {
      const hit = resolveName(alias);
      if ('id' in hit || hit.reason === 'ambiguous name') return hit;
      const mappedName = exportedAlias.get(canonicalName(alias));
      if (mappedName) {
        const mapped = resolveName(mappedName);
        if ('id' in mapped || mapped.reason === 'ambiguous name') return mapped;
      }
    }
    return { reason: 'name not found' };
  };
  return { resolve, resolveName };
}

function blankReplayCategory(total = 0): RulingReplayCategory {
  return { total, resolved: 0, applied: 0, already_present: 0, unresolved: 0 };
}

function sumReplayCategories(categories: RulingReplayCategory[]): RulingReplayCategory {
  const total = blankReplayCategory();
  for (const category of categories) {
    total.total += category.total;
    total.resolved += category.resolved;
    total.applied += category.applied;
    total.already_present += category.already_present;
    total.unresolved += category.unresolved;
  }
  return total;
}

/**
 * Reapply an exported ruling file to the selected project.
 *
 * Nothing is deleted, merged, re-kinded or created except the exported
 * relations and tie notes whose quotes still verify in this bank. Writes run in
 * batches inside a transaction; `write: false` resolves and verifies only.
 */
export function replayRulings(
  db: Db,
  projectId: number,
  payload: unknown,
  opts: { write: boolean; limit?: number },
): RulingReplayResult {
  const exported = parseRulingsExport(payload);
  const now = nowIso();
  const resolver = buildRulingsResolver(db, projectId, exported.identities);
  const limit = opts.limit === undefined ? undefined : Math.max(0, Math.floor(opts.limit));
  const take = <T>(items: T[]): T[] => (limit === undefined ? items : items.slice(0, limit));
  const keepers = take(exported.keepers);
  const notes = take(exported.note_rulings);
  const identities = take(exported.identities);

  const issues: RulingReplayIssue[] = [];
  const writes: {
    sql: string;
    params: unknown[];
    /** The ruling this write must produce in the same transaction. */
    court?: {
      relationId: number | null;
      insert?: boolean;
      role?: 'appeal' | 'objection';
      subject?: string;
      fromStatus: string;
      toStatus: string;
      reference: string;
      quote: string;
    };
  }[] = [];
  let chunks: ChunkRow[] | null = null;
  const quoteRefs = (evidence: string): { source: string; locator: string; chunk: number }[] | undefined => {
    const needle = normalise(evidence);
    if (!needle) return undefined;
    chunks ??= loadOrderedChunks(db, projectId);
    const chunk = chunks.find((candidate) => normalise(candidate.text).includes(needle));
    if (!chunk) return undefined;
    return [{ source: chunk.source_title, locator: chunk.locator, chunk: chunk.id }];
  };
  const deficit = (
    report: RulingReplayCategory,
    category: RulingReplayIssue['category'],
    entry: { from: string; to: string; kind: string },
    reason: RulingUnresolvedReason,
  ): void => {
    report.unresolved++;
    issues.push({ category, from: entry.from, to: entry.to, kind: entry.kind, reason });
  };

  const keeperReport = blankReplayCategory(keepers.length);
  const seenKeepers = new Set<string>();
  for (const keeper of keepers) {
    const from = resolver.resolve(keeper.from_name, keeper.from_aliases);
    const to = resolver.resolve(keeper.to_name, keeper.to_aliases);
    const entry = { from: keeper.from_name, to: keeper.to_name, kind: keeper.kind };
    if (!('id' in from)) {
      deficit(keeperReport, 'keeper', entry, from.reason);
      continue;
    }
    if (!('id' in to)) {
      deficit(keeperReport, 'keeper', entry, to.reason);
      continue;
    }
    keeperReport.resolved++;
    const key = `${from.id}|${to.id}|${keeper.kind}`;
    if (seenKeepers.has(key)) {
      keeperReport.already_present++;
      continue;
    }
    seenKeepers.add(key);
    const existing = db.get<{ id: number; review_status: string }>(
      `SELECT id, review_status FROM canon_relation
        WHERE project_id = ? AND from_entity = ? AND to_entity = ? AND kind = ?
        ORDER BY id LIMIT 1`,
      projectId,
      from.id,
      to.id,
      keeper.kind,
    );
    // A confirmation is a verdict, and a verdict is only ever a label here.
    // Replay restores the label and never the tier, so a confirmations file
    // cannot add, remove, score or reorder one retrieval row. An existing row
    // keeps the status its own evidence earned; a missing one is parked for
    // review with the label attached, for measurement.
    if (keeper.confirmed_by_user === true || keeper.review_status === 'user_confirmed') {
      if (existing) {
        writes.push({
          sql: 'UPDATE canon_relation SET confirmed_by_user = 1 WHERE id = ? AND project_id = ?',
          params: [existing.id, projectId],
          // The ruling records the human decision without claiming a tier
          // change: from and to are the row's own status.
          court: {
            relationId: existing.id,
            fromStatus: existing.review_status,
            toStatus: existing.review_status,
            reference: keeper.kind,
            quote: keeper.evidence ?? '',
          },
        });
        keeperReport.already_present++;
      } else {
        const verdictEvidence = (keeper.evidence ?? '').trim();
        // A quote that is present but does not verify is still a bad quote:
        // the verdict labels rows, it does not excuse a fabricated citation.
        const verdictRefs = verdictEvidence ? quoteRefs(verdictEvidence) : undefined;
        if (verdictEvidence && !verdictRefs) {
          deficit(keeperReport, 'keeper', entry, 'quote not found');
          continue;
        }
        keeperReport.applied++;
        writes.push({
          sql: `INSERT INTO canon_relation
                  (project_id, claim_uid, from_entity, to_entity, kind, description, evidence, source_refs,
                   confidence, review_status, confirmed_by_user, relation_status, created_at)
                VALUES (?, ?, ?, ?, ?, '', ?, ?, 1.0, 'needs_review', 1, 'unknown', ?)`,
          params: [projectId, keeper.claim_uid ?? newClaimUid('relation'), from.id, to.id, keeper.kind, verdictEvidence, JSON.stringify(verdictRefs ?? []), now],
          court: {
            relationId: null,
            insert: true,
            fromStatus: '',
            toStatus: 'needs_review',
            reference: keeper.kind,
            quote: verdictEvidence,
          },
        });
      }
      continue;
    }
    if (existing) {
      if (existing.review_status === keeper.review_status) {
        keeperReport.already_present++;
      } else {
        keeperReport.applied++;
        writes.push({
          sql: `UPDATE canon_relation
                   SET review_status = ?
                 WHERE id = ? AND project_id = ?`,
          params: [keeper.review_status, existing.id, projectId],
          court: {
            relationId: existing.id,
            fromStatus: existing.review_status,
            toStatus: keeper.review_status,
            reference: `${keeper.kind}`,
            quote: keeper.evidence ?? '',
          },
        });
      }
      continue;
    }
    const evidence = (keeper.evidence ?? '').trim();
    if (!evidence) {
      // No sentence means no acceptance, whoever asked. A confirmation is a
      // label and this branch is only reached for non-verdict keepers.
      deficit(keeperReport, 'keeper', entry, 'evidence-required');
      continue;
    }
    const refs = quoteRefs(evidence);
    if (!refs) {
      deficit(keeperReport, 'keeper', entry, 'quote not found');
      continue;
    }
    keeperReport.applied++;
    writes.push({
      sql: `INSERT INTO canon_relation
              (project_id, claim_uid, from_entity, to_entity, kind, description, evidence, source_refs,
               confidence, review_status, confirmed_by_user, relation_status, created_at)
            VALUES (?, ?, ?, ?, ?, '', ?, ?, 1.0, ?, 0, ?, ?)`,
      params: [
        projectId,
        keeper.claim_uid ?? newClaimUid('relation'),
        from.id,
        to.id,
        keeper.kind,
        keeper.evidence,
        JSON.stringify(refs),
        keeper.review_status,
        relationStatusOf(keeper.evidence),
        now,
      ],
      court: {
        relationId: null,
        insert: true,
        fromStatus: '',
        toStatus: keeper.review_status,
        reference: keeper.kind,
        quote: keeper.evidence,
      },
    });
  }

  const noteReport = blankReplayCategory(notes.length);
  const seenNotes = new Set<string>();
  for (const note of notes) {
    const from = resolver.resolve(note.from_name, []);
    const to = resolver.resolve(note.to_name, []);
    const entry = { from: note.from_name, to: note.to_name, kind: note.attempted_kind };
    if (!('id' in from)) {
      deficit(noteReport, 'note_ruling', entry, from.reason);
      continue;
    }
    if (!('id' in to)) {
      deficit(noteReport, 'note_ruling', entry, to.reason);
      continue;
    }
    noteReport.resolved++;
    const key = `${from.id}|${to.id}|${note.attempted_kind}`;
    if (seenNotes.has(key)) {
      noteReport.already_present++;
      continue;
    }
    seenNotes.add(key);
    const existing = db.get<{ id: number; status: string; ruling: string }>(
      `SELECT id, status, ruling FROM canon_tie_note
        WHERE project_id = ? AND from_entity = ? AND to_entity = ? AND attempted_kind = ?`,
      projectId,
      from.id,
      to.id,
      note.attempted_kind,
    );
    if (existing) {
      if (existing.status === note.status && existing.ruling === note.ruling) {
        noteReport.already_present++;
      } else {
        noteReport.applied++;
        writes.push({
          sql: `UPDATE canon_tie_note SET status = ?, ruling = ?, ruled_at = ?
                 WHERE id = ? AND project_id = ?`,
          params: [note.status, note.ruling, now, existing.id, projectId],
          court: {
            relationId: null,
            role: 'objection',
            subject: `pair:${Math.min(from.id, to.id)}:${Math.max(from.id, to.id)}`,
            fromStatus: existing.status,
            toStatus: note.status,
            reference: note.attempted_kind,
            quote: note.evidence,
          },
        });
      }
      continue;
    }
    const refs = quoteRefs(note.evidence);
    if (!refs) {
      deficit(noteReport, 'note_ruling', entry, 'quote not found');
      continue;
    }
    noteReport.applied++;
    writes.push({
      sql: `INSERT INTO canon_tie_note
              (project_id, from_entity, to_entity, attempted_kind, reason, evidence, source_refs,
               status, ruling, ruled_at, created_at)
            VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`,
      params: [
        projectId,
        from.id,
        to.id,
        note.attempted_kind,
        note.evidence,
        JSON.stringify(refs),
        note.status,
        note.ruling,
        now,
        now,
      ],
      court: {
        relationId: null,
        role: 'objection',
        subject: `pair:${Math.min(from.id, to.id)}:${Math.max(from.id, to.id)}`,
        fromStatus: '',
        toStatus: note.status,
        reference: note.attempted_kind,
        quote: note.evidence,
      },
    });
  }

  // Identities are read-only: they prove a merged name still reaches its
  // survivor, but replay never merges or writes aliases.
  const identityReport = blankReplayCategory(identities.length);
  for (const identity of identities) {
    const hit = resolver.resolve(identity.name, identity.aliases);
    if ('id' in hit) {
      identityReport.resolved++;
    } else {
      deficit(identityReport, 'identity', { from: identity.name, to: '', kind: '' }, hit.reason);
    }
  }

  if (opts.write && writes.length) {
    const batchSize = 100;
    for (let start = 0; start < writes.length; start += batchSize) {
      const batch = writes.slice(start, start + batchSize);
      db.transaction(() => {
        for (const write of batch) {
          const result = db.run(write.sql, ...write.params);
          if (write.court) {
            recordRuling(db, projectId, {
              relationId: write.court.insert ? Number(result.lastInsertRowid) : write.court.relationId,
              subject: write.court.subject,
              role: write.court.role ?? 'appeal',
              actor: 'human',
              standard: 'replay',
              fromStatus: write.court.fromStatus,
              toStatus: write.court.toStatus,
              basis: `replay ${write.court.role === 'objection' ? 'objection' : 'keeper'}: ${write.court.reference}`,
              quote: write.court.quote,
            });
          }
        }
      });
    }
  }

  return {
    keepers: keeperReport,
    note_rulings: noteReport,
    identities: identityReport,
    total: sumReplayCategories([keeperReport, noteReport, identityReport]),
    issues,
  };
}

