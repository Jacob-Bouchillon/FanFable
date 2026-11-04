/**
 * Durable source-extraction recovery.
 *
 * This module owns the attempt/lease/stage-coverage ledger. It deliberately
 * does not know how a claim is parsed or applied to canon: the caller supplies
 * a synchronous apply callback inside a short SQLite transaction. That keeps
 * provider calls outside transactions while making stage coverage and canon
 * application one atomic decision.
 *
 * The ledger is additive. Existing canon rows, lore_mined flags and the
 * extraction_run/extraction_window_run provenance are left as legacy state.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Db, fromJson, toJson } from '../core/db.ts';

export const RECOVERY_PARSER_VERSION = 'extraction-recovery-v1';
export const RECOVERY_DEPENDENCY_VERSION = 'source-extraction-v1';

export type RecoveryStage = 'entities-facts' | 'relations' | 'timeline' | 'legacy';
export type RecoveryStageStatus =
  | 'pending'
  | 'running'
  | 'complete'
  | 'empty'
  | 'failed'
  | 'deferred'
  | 'not_applicable'
  | 'invalidated';
export type RecoveryChildStatus =
  | 'pending'
  | 'running'
  | 'complete'
  | 'partial'
  | 'failed'
  | 'deferred'
  | 'invalidated';
export type RecoveryParentStatus =
  | 'pending'
  | 'running'
  | 'complete'
  | 'partial'
  | 'failed'
  | 'deferred'
  | 'invalidated';
export type RecoveryAttemptStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'incomplete'
  | 'stale'
  | 'deferred'
  | 'abandoned';

export interface RecoveryPolicy {
  /** Automatic attempts per stage, including the first. */
  maxAttempts: number;
  /** Lease lifetime for a claimed child. */
  leaseMs: number;
  /** How often a running stage renews its lease. */
  heartbeatMs: number;
  /** Backoff after attempt 1, 2, ...; last value repeats. */
  backoffMs: number[];
  /** Bounded fresh-snapshot replans for a relationship stage. */
  maxRosterReplans: number;
}

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = Object.freeze({
  maxAttempts: 3,
  leaseMs: 300_000,
  heartbeatMs: 60_000,
  backoffMs: [1_000, 2_000],
  maxRosterReplans: 2,
});

export interface RecoveryParentRow {
  id: number;
  project_id: number;
  source_id: number | null;
  scope_key: string;
  dependency_version: string;
  fingerprint: string;
  status: RecoveryParentStatus;
  readiness: string;
  optional_status: string;
  created_at: string;
  completed_at: string | null;
}

export interface RecoveryChildRow {
  id: number;
  parent_id: number;
  project_id: number;
  work_key: string;
  window_index: number;
  source_order: number;
  chunk_ids: string;
  required_stages: string;
  stage_fingerprints: string;
  fingerprint: string;
  status: RecoveryChildStatus;
  fencing: number;
  retry_epoch: number;
  created_at: string;
  completed_at: string | null;
}

export interface RecoveryCoverageRow {
  id: number;
  child_id: number;
  project_id: number;
  stage: RecoveryStage;
  fingerprint: string;
  status: RecoveryStageStatus;
  attempt_id: number | null;
  result_json: string;
  finalized_at: string;
}

export interface RecoveryStagedBatchRow {
  id: number;
  attempt_id: number;
  child_id: number;
  project_id: number;
  stage: RecoveryStage;
  fingerprint: string;
  payload_json: string;
  payload_sha256: string;
  byte_size: number;
  complete: number;
  finish_reason: string;
  created_at: string;
}

export interface RecoveryAttemptRow {
  id: number;
  child_id: number;
  project_id: number;
  stage: RecoveryStage;
  fingerprint: string;
  retry_epoch: number;
  attempt_number: number;
  status: RecoveryAttemptStatus;
  owner: string;
  fencing: number;
  lease_until: string;
  finish_reason: string;
  parser_route: string;
  error_code: string;
  started_at: string;
  finished_at: string | null;
}

export interface RecoveryClaimResult {
  ok: boolean;
  reason?: string;
  fencing?: number;
  conflicts?: number[];
  alreadyComplete?: boolean;
}

export interface RecoveryAttemptResult {
  ok: boolean;
  reason?: string;
  attemptId?: number;
  attemptNumber?: number;
  fencing?: number;
}

export interface RecoveryApplyResult {
  status: 'complete' | 'empty' | 'not_applicable';
  result?: unknown;
}

export interface RecoveryParentSummary {
  parentId: number;
  projectId: number;
  scopeKey: string;
  fingerprint: string;
  status: RecoveryParentStatus;
  children: Array<{
    childId: number;
    windowIndex: number;
    status: RecoveryChildStatus;
    chunkIds: number[];
    stages: Array<{
      stage: RecoveryStage;
      status: RecoveryStageStatus;
      fingerprint: string;
    }>;
  }>;
}

export interface RecoveryRosterEntity {
  id: number;
  kind: string;
  name: string;
  aliases: string;
  review_status: string;
}

export interface RecoveryRelationSnapshot {
  fingerprint: string;
  promptNames: string[];
  entities: RecoveryRosterEntity[];
}

export interface RecoveryDeferredRow {
  parentId: number;
  childId: number;
  projectId: number;
  windowIndex: number;
  stage: RecoveryStage | null;
  status: RecoveryChildStatus | RecoveryStageStatus;
  nextRetryAt: string | null;
}

export interface RecoveryClock {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function hash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
}

/** Stable JSON for hashes: object keys are sorted recursively. */
export function stableStringify(value: unknown): string {
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        out[key] = visit((input as Record<string, unknown>)[key]);
      }
      return out;
    }
    return input;
  };
  return JSON.stringify(visit(value));
}

export function recoveryStageFingerprint(input: {
  stage: RecoveryStage;
  chunkIds: number[];
  chunkHashes: string[];
  promptHash: string;
  provider: string;
  model: string;
  settingsHash: string;
  rosterFingerprint?: string;
  parserVersion?: string;
  dependencyVersion?: string;
}): string {
  return hash({
    kind: 'fanfable-recovery-stage',
    stage: input.stage,
    chunkIds: [...input.chunkIds].sort((a, b) => a - b),
    chunkHashes: input.chunkHashes,
    promptHash: input.promptHash,
    provider: input.provider,
    model: input.model,
    settingsHash: input.settingsHash,
    rosterFingerprint: input.stage === 'relations' ? input.rosterFingerprint ?? '' : '',
    parserVersion: input.parserVersion ?? RECOVERY_PARSER_VERSION,
    dependencyVersion: input.dependencyVersion ?? RECOVERY_DEPENDENCY_VERSION,
  });
}

/**
 * Stable identity for a claim at a source location. Re-extracting the same
 * claim from the same passage is idempotent even if prompt/model generation
 * changes; a different claim, evidence or passage is a separate contribution.
 */
export function recoveryContributionUid(input: {
  claimType: string;
  sourceChunkId: number | null;
  payload: unknown;
}): string {
  const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
    ? Object.fromEntries(
        Object.entries(input.payload as Record<string, unknown>)
          .filter(([key]) => key !== 'chunk_index'),
      )
    : input.payload;
  return hash({
    kind: 'fanfable-recovery-contribution',
    claimType: input.claimType,
    sourceChunkId: input.sourceChunkId,
    payload,
  });
}

/**
 * Stage-only claims use a private claim namespace. They remain durable and
 * exactly idempotent, but they cannot occupy the domain-effect identity that a
 * later authorized publication must claim. This deliberately does not publish
 * anything; it only keeps staging state from blocking publication.
 */
export function stagedRecoveryContributionUid(uid: string): string {
  return `staged:${uid}`;
}

export interface LegacyStagedContributionStatus {
  count: number;
  stages: string[];
  claimTypes: string[];
  status: 'incompatible-prefix';
  action: 'manual-review-required';
}

/**
 * Pre-namespace staged rows cannot be proven separable from the domain-effect
 * UID space. They are never reused as staged context and are never treated as
 * applied. Report them so a human can decide on a future additive repair; this
 * function performs no mutation.
 */
export function legacyStagedContributionStatus(
  db: Db,
  projectId: number,
): LegacyStagedContributionStatus {
  const rows = db.all<{ stage: string; claim_type: string }>(
    `SELECT stage, claim_type FROM extraction_contribution
      WHERE project_id = ? AND disposition = 'staged'
        AND contribution_uid NOT LIKE 'staged:%'`,
    projectId,
  );
  return {
    count: rows.length,
    stages: [...new Set(rows.map((row) => row.stage))],
    claimTypes: [...new Set(rows.map((row) => row.claim_type))],
    status: 'incompatible-prefix',
    action: 'manual-review-required',
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function addMs(ms: number, delta: number): string {
  return new Date(ms + delta).toISOString();
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/**
 * Chunks whose recovery work is authoritative published coverage.
 *
 * Stage-only work is durable and complete, but it never published canon and
 * never set lore_mined. Treating it as published would let a later legacy-mined
 * flag be mistaken for recovery-managed state, so only work linked to a parent
 * that was not staging-only counts here. Staging parents are marked at start,
 * not only on clean finalize, so a crash cannot disguise staged work as
 * published.
 */
export function recoveryPublishedChunkIds(db: Db, projectId: number): Set<number> {
  return new Set(
    db
      .all<{ chunk_id: number }>(
        `SELECT DISTINCT cw.chunk_id
           FROM extraction_recovery_chunk_work cw
           JOIN extraction_recovery_child c ON c.id = cw.child_id
           JOIN extraction_recovery_run_child rc ON rc.child_id = c.id
           JOIN extraction_recovery_parent p ON p.id = rc.parent_id
          WHERE cw.project_id = ?
            AND c.status = 'complete'
            AND p.readiness <> 'staged_only'`,
        projectId,
      )
      .map((row) => row.chunk_id),
  );
}

export class RecoveryController {
  readonly db: Db;
  readonly policy: RecoveryPolicy;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(db: Db, policy: Partial<RecoveryPolicy> = {}, clock: RecoveryClock = {}) {
    this.db = db;
    this.policy = {
      ...DEFAULT_RECOVERY_POLICY,
      ...policy,
      backoffMs: policy.backoffMs?.length ? [...policy.backoffMs] : [...DEFAULT_RECOVERY_POLICY.backoffMs],
      maxRosterReplans: policy.maxRosterReplans ?? DEFAULT_RECOVERY_POLICY.maxRosterReplans,
    };
    if (!Number.isInteger(this.policy.maxAttempts) || this.policy.maxAttempts < 1) {
      throw new Error('recovery maxAttempts must be a positive integer');
    }
    if (this.policy.leaseMs <= 0 || this.policy.heartbeatMs <= 0) {
      throw new Error('recovery lease and heartbeat must be positive');
    }
    this.now = clock.now ?? (() => Date.now());
    this.sleepFn = clock.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  sleep(ms: number): Promise<void> {
    return this.sleepFn(ms);
  }

  backoff(attemptNumber: number): number {
    const index = Math.min(Math.max(0, attemptNumber - 1), this.policy.backoffMs.length - 1);
    return this.policy.backoffMs[index] ?? 0;
  }

  beginParent(input: {
    projectId: number;
    sourceId?: number | null;
    scopeKey: string;
    fingerprint: string;
    dependencyVersion?: string;
  }): number {
    const at = iso(this.now());
    const dependency = input.dependencyVersion ?? RECOVERY_DEPENDENCY_VERSION;
    return this.db.transaction(
      () => {
        const existing = this.db.get<{ id: number }>(
          `SELECT id FROM extraction_recovery_parent
            WHERE project_id = ? AND scope_key = ? AND fingerprint = ?`,
          input.projectId,
          input.scopeKey,
          input.fingerprint,
        );
        if (existing) return existing.id;
        return this.db.run(
          `INSERT INTO extraction_recovery_parent
             (project_id, source_id, scope_key, dependency_version, fingerprint, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
          input.projectId,
          input.sourceId ?? null,
          input.scopeKey,
          dependency,
          input.fingerprint,
          at,
        ).lastInsertRowid;
      },
      { immediate: true },
    );
  }

  /**
   * Locate or create the reusable work unit for an exact ordered chunk scope
   * and generation. The run/parent only links to it; it is not identity.
   */
  beginChild(input: {
    parentId: number;
    projectId: number;
    workKey: string;
    windowIndex: number;
    sourceOrder: number;
    chunkIds: number[];
    requiredStages: RecoveryStage[];
    fingerprint: string;
  }): number {
    const at = iso(this.now());
    return this.db.transaction(
      () => {
        const existing = this.db.get<{ id: number }>(
          `SELECT id FROM extraction_recovery_child
            WHERE project_id = ? AND work_key = ?`,
          input.projectId,
          input.workKey,
        );
        let childId = existing?.id;
        if (childId === undefined) {
          childId = this.db.run(
            `INSERT INTO extraction_recovery_child
               (parent_id, project_id, work_key, window_index, source_order, chunk_ids,
                required_stages, stage_fingerprints, fingerprint, status, fencing, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, 'pending', 0, ?)`,
            input.parentId,
            input.projectId,
            input.workKey,
            input.windowIndex,
            input.sourceOrder,
            toJson(input.chunkIds),
            toJson(input.requiredStages),
            input.fingerprint,
            at,
          ).lastInsertRowid;
        }
        const linked = this.db.get<{ child_id: number }>(
          'SELECT child_id FROM extraction_recovery_run_child WHERE parent_id = ? AND window_index = ?',
          input.parentId,
          input.windowIndex,
        );
        if (linked && linked.child_id !== childId) {
          throw new Error('run window already linked to different work');
        }
        this.db.run(
          `INSERT OR IGNORE INTO extraction_recovery_run_child
             (parent_id, child_id, window_index, source_order)
           VALUES (?, ?, ?, ?)`,
          input.parentId,
          childId,
          input.windowIndex,
          input.sourceOrder,
        );
        for (const chunkId of input.chunkIds) {
          this.db.run(
            `INSERT OR IGNORE INTO extraction_recovery_chunk_work
               (chunk_id, project_id, child_id, work_key, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            chunkId,
            input.projectId,
            childId,
            input.workKey,
            at,
          );
        }
        return childId;
      },
      { immediate: true },
    );
  }

  childByWorkKey(projectId: number, workKey: string): RecoveryChildRow | undefined {
    return this.db.get<RecoveryChildRow>(
      'SELECT * FROM extraction_recovery_child WHERE project_id = ? AND work_key = ?',
      projectId,
      workKey,
    );
  }

  managedChunkIds(projectId: number): Set<number> {
    return recoveryPublishedChunkIds(this.db, projectId);
  }

  getParent(parentId: number): RecoveryParentRow | undefined {
    return this.db.get<RecoveryParentRow>('SELECT * FROM extraction_recovery_parent WHERE id = ?', parentId);
  }

  getChild(childId: number): RecoveryChildRow | undefined {
    return this.db.get<RecoveryChildRow>('SELECT * FROM extraction_recovery_child WHERE id = ?', childId);
  }

  children(parentId: number): RecoveryChildRow[] {
    return this.db.all<RecoveryChildRow>(
      `SELECT c.* FROM extraction_recovery_child c
        JOIN extraction_recovery_run_child r ON r.child_id = c.id
       WHERE r.parent_id = ?
       ORDER BY r.source_order, r.window_index`,
      parentId,
    );
  }

  chunkIds(child: RecoveryChildRow): number[] {
    return fromJson<number[]>(child.chunk_ids, []).filter((id) => Number.isFinite(id));
  }

  requiredStages(child: RecoveryChildRow): RecoveryStage[] {
    const stages = fromJson<RecoveryStage[]>(child.required_stages, []);
    return stages.filter((stage): stage is RecoveryStage =>
      stage === 'entities-facts' || stage === 'relations' || stage === 'timeline' || stage === 'legacy',
    );
  }

  stageFingerprints(child: RecoveryChildRow): Partial<Record<RecoveryStage, string>> {
    return fromJson<Partial<Record<RecoveryStage, string>>>(child.stage_fingerprints, {});
  }

  setStageFingerprint(
    childId: number,
    stage: RecoveryStage,
    fingerprint: string,
    owner: string,
    fencing: number,
  ): void {
    this.db.transaction(
      () => {
        const child = this.requireChild(childId);
        if (child.fencing !== fencing || child.status !== 'running') {
          throw new Error('stale-fencing');
        }
        const ownership = this.ownsChunks(child, owner, fencing, this.now());
        if (!ownership.ok) throw new Error(ownership.reason);
        const map = this.stageFingerprints(child);
        if (map[stage] === fingerprint) return;
        map[stage] = fingerprint;
        this.db.run(
          'UPDATE extraction_recovery_child SET stage_fingerprints = ? WHERE id = ?',
          toJson(map),
          childId,
        );
      },
      { immediate: true },
    );
  }

  getCoverage(childId: number, stage: RecoveryStage, fingerprint: string): RecoveryCoverageRow | undefined {
    return this.db.get<RecoveryCoverageRow>(
      `SELECT * FROM extraction_stage_coverage
        WHERE child_id = ? AND stage = ? AND fingerprint = ?
        ORDER BY id DESC LIMIT 1`,
      childId,
      stage,
      fingerprint,
    );
  }

  coverageForChild(childId: number): RecoveryCoverageRow[] {
    return this.db.all<RecoveryCoverageRow>(
      'SELECT * FROM extraction_stage_coverage WHERE child_id = ? ORDER BY id',
      childId,
    );
  }

  latestStagedBatch(
    childId: number,
    stage: RecoveryStage,
    fingerprint: string,
  ): RecoveryStagedBatchRow | undefined {
    return this.db.get<RecoveryStagedBatchRow>(
      `SELECT * FROM extraction_staged_batch
        WHERE child_id = ? AND stage = ? AND fingerprint = ? AND complete = 1
        ORDER BY id DESC LIMIT 1`,
      childId,
      stage,
      fingerprint,
    );
  }

  stagedBatchForAttempt(attemptId: number): RecoveryStagedBatchRow | undefined {
    return this.db.get<RecoveryStagedBatchRow>(
      'SELECT * FROM extraction_staged_batch WHERE attempt_id = ? ORDER BY id DESC LIMIT 1',
      attemptId,
    );
  }

  private sealedBatch(
    attemptId: number,
    childId: number,
    stage: RecoveryStage,
    fingerprint: string,
  ): RecoveryStagedBatchRow | undefined {
    return this.db.get<RecoveryStagedBatchRow>(
      `SELECT * FROM extraction_staged_batch
        WHERE attempt_id = ? AND child_id = ? AND stage = ? AND fingerprint = ? AND complete = 1
        ORDER BY id DESC LIMIT 1`,
      attemptId,
      childId,
      stage,
      fingerprint,
    );
  }

  hasContribution(projectId: number, uid: string): boolean {
    return !!this.db.get<{ id: number }>(
      'SELECT id FROM extraction_contribution WHERE project_id = ? AND contribution_uid = ?',
      projectId,
      uid,
    );
  }

  /**
   * Claim a contribution atomically. The unique key is the cross-process
   * exact-repeat guard: only the winner applies canon effects. The row is
   * inserted inside the caller's apply transaction, so a failed apply removes
   * the claim and a committed apply finalizes it separately.
   */
  recordContribution(input: {
    projectId: number;
    childId: number;
    stage: RecoveryStage;
    claimType: string;
    uid: string;
    payload: unknown;
    dependencyFingerprint: string;
    disposition?: string;
    canonTable?: string;
    canonId?: number | null;
  }): { inserted: boolean; id: number | null } {
    const at = iso(this.now());
    const result = this.db.run(
      `INSERT OR IGNORE INTO extraction_contribution
         (project_id, child_id, stage, contribution_uid, claim_type, payload_sha256,
          dependency_fingerprint, evaluation_count, disposition, canon_table, canon_id, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      input.projectId,
      input.childId,
      input.stage,
      input.uid,
      input.claimType,
      hash(input.payload),
      input.dependencyFingerprint,
      input.disposition ?? 'applying',
      input.canonTable ?? '',
      input.canonId ?? null,
      at,
    );
    if (result.changes > 0) return { inserted: true, id: result.lastInsertRowid };
    const existing = this.db.get<{
      id: number;
      contribution_uid: string;
      disposition: string;
      dependency_fingerprint: string;
    }>(
      `SELECT id, contribution_uid, disposition, dependency_fingerprint
         FROM extraction_contribution
        WHERE project_id = ? AND contribution_uid = ?`,
      input.projectId,
      input.uid,
    );
    if (!existing) return { inserted: false, id: null };
    // A pre-namespace staged row may be indistinguishable from a domain UID.
    // Never hand its id to a non-stage caller as if it were claimable.
    if (
      existing.disposition === 'staged' &&
      !existing.contribution_uid.startsWith('staged:') &&
      !input.uid.startsWith('staged:')
    ) {
      return { inserted: false, id: null };
    }
    // Only a contribution that never produced a stable canon effect may be
    // re-evaluated, and only when its dependency generation changed. Applied,
    // review-held, or in-flight claims remain idempotent.
    if (existing.disposition !== 'dropped' && existing.disposition !== 'invalidated') {
      return { inserted: false, id: existing.id };
    }
    if (existing.dependency_fingerprint === input.dependencyFingerprint) {
      return { inserted: false, id: existing.id };
    }
    const reclaimed = this.db.run(
      `UPDATE extraction_contribution
          SET child_id = ?, stage = ?, dependency_fingerprint = ?,
              evaluation_count = evaluation_count + 1, disposition = 'applying',
              canon_table = '', canon_id = NULL, applied_at = ?
        WHERE id = ? AND disposition IN ('dropped', 'invalidated')`,
      input.childId,
      input.stage,
      input.dependencyFingerprint,
      at,
      existing.id,
    );
    return { inserted: reclaimed.changes > 0, id: existing.id };
  }

  finalizeContribution(
    contributionId: number,
    input: { disposition: string; canonTable?: string; canonId?: number | null },
  ): void {
    this.db.run(
      `UPDATE extraction_contribution
          SET disposition = ?, canon_table = ?, canon_id = ?
        WHERE id = ?`,
      input.disposition,
      input.canonTable ?? '',
      input.canonId ?? null,
      contributionId,
    );
  }

  recordEffect(input: {
    contributionId: number;
    effectType: string;
    effectKey: string;
    canonTable?: string;
    canonId?: number | null;
  }): boolean {
    const result = this.db.run(
      `INSERT OR IGNORE INTO extraction_effect
         (contribution_id, effect_type, effect_key, canon_table, canon_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.contributionId,
      input.effectType,
      input.effectKey,
      input.canonTable ?? '',
      input.canonId ?? null,
      iso(this.now()),
    );
    return result.changes > 0;
  }

  /** Claim every chunk in the child atomically. Expired leases are stealable. */
  claimChild(
    childId: number,
    owner: string,
    options: {
      expectedStageFingerprints?: Partial<Record<RecoveryStage, string>>;
      explicitRetry?: boolean;
    } = {},
  ): RecoveryClaimResult {
    const now = this.now();
    return this.db.transaction(
      () => {
        let child = this.requireChild(childId);
        // Leases a live worker holds on any of these chunks block a reopen.
        const leaseConflicts = (ids: number[]): number[] => {
          const conflicts: number[] = [];
          for (const chunkId of ids) {
            const lease = this.db.get<{ child_id: number; owner: string; lease_until: string }>(
              'SELECT child_id, owner, lease_until FROM extraction_chunk_lease WHERE chunk_id = ?',
              chunkId,
            );
            if (
              lease &&
              Date.parse(lease.lease_until) > now &&
              (lease.child_id !== childId || lease.owner !== owner)
            ) {
              conflicts.push(chunkId);
            }
          }
          return conflicts;
        };
        if (child.status === 'complete') {
          const expected = options.expectedStageFingerprints;
          const stored = this.stageFingerprints(child);
          const stillCurrent = !expected || this.requiredStages(child).every(
            (stage) => expected[stage] === undefined || expected[stage] === stored[stage],
          );
          if (stillCurrent) {
            return { ok: true, fencing: child.fencing, alreadyComplete: true };
          }
          // Check ownership before mutating the child: reopening a complete
          // child while another worker holds a lease used to leave the child
          // pending and its windows marked lore_mined, so retry could never
          // publish them. Overlap returns without touching any row.
          const reopenIds = this.chunkIds(child);
          const conflicts = leaseConflicts(reopenIds);
          if (conflicts.length) return { ok: false, reason: 'overlap', conflicts };
          this.db.run(
            "UPDATE extraction_recovery_child SET status = 'pending', completed_at = NULL WHERE id = ?",
            childId,
          );
          // A reopen is retryable again: the same chunks must be minable, as
          // they were before the child first published. Existing canon rows
          // and staged work stay untouched.
          if (reopenIds.length) {
            const placeholders = reopenIds.map(() => '?').join(',');
            this.db.run(
              `UPDATE canon_chunk SET lore_mined = 0 WHERE id IN (${placeholders})`,
              ...reopenIds,
            );
          }
          child = this.requireChild(childId);
        }
        if (child.status === 'deferred') {
          if (!options.explicitRetry) return { ok: false, reason: 'deferred' };
          this.db.run(
            `UPDATE extraction_recovery_child
                SET status = 'pending', completed_at = NULL, retry_epoch = retry_epoch + 1
              WHERE id = ?`,
            childId,
          );
          this.db.run(
            `UPDATE extraction_stage_coverage
                SET status = 'invalidated'
              WHERE child_id = ? AND status = 'deferred'`,
            childId,
          );
          child = this.requireChild(childId);
        }
        const ids = this.chunkIds(child);
        // Re-claiming the same child with the same owner is idempotent: do not
        // mint a new fencing value that makes this worker's own attempt stale.
        const sameOwner =
          child.status === 'running' &&
          child.fencing > 0 &&
          ids.every((chunkId) => {
            const lease = this.db.get<{ child_id: number; owner: string; fencing: number; lease_until: string }>(
              'SELECT child_id, owner, fencing, lease_until FROM extraction_chunk_lease WHERE chunk_id = ?',
              chunkId,
            );
            return (
              !!lease &&
              lease.child_id === childId &&
              lease.owner === owner &&
              lease.fencing === child.fencing &&
              Date.parse(lease.lease_until) > now
            );
          });
        if (sameOwner) return { ok: true, fencing: child.fencing };
        const conflicts = leaseConflicts(ids);
        if (conflicts.length) return { ok: false, reason: 'overlap', conflicts };
        const fencing = child.fencing + 1;
        for (const chunkId of ids) {
          this.db.run(
            `INSERT INTO extraction_chunk_lease
               (chunk_id, project_id, child_id, owner, fencing, lease_until)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(chunk_id) DO UPDATE SET
               project_id = excluded.project_id,
               child_id = excluded.child_id,
               owner = excluded.owner,
               fencing = excluded.fencing,
               lease_until = excluded.lease_until`,
            chunkId,
            child.project_id,
            childId,
            owner,
            fencing,
            addMs(now, this.policy.leaseMs),
          );
        }
        this.db.run(
          `UPDATE extraction_recovery_child
              SET status = 'running', fencing = ?
            WHERE id = ? AND fencing = ?`,
          fencing,
          childId,
          child.fencing,
        );
        for (const parentId of this.parentIdsForChild(childId)) {
          this.db.run(
            `UPDATE extraction_recovery_parent
                SET status = 'running'
              WHERE id = ? AND status IN ('pending', 'running', 'partial', 'failed')`,
            parentId,
          );
        }
        return { ok: true, fencing };
      },
      { immediate: true },
    );
  }

  renewChild(childId: number, owner: string, fencing: number): { ok: boolean; reason?: string } {
    const now = this.now();
    return this.db.transaction(
      () => {
        const child = this.requireChild(childId);
        if (child.fencing !== fencing || child.status !== 'running') {
          return { ok: false, reason: 'stale-fencing' };
        }
        const ids = this.chunkIds(child);
        const ownership = this.ownsChunks(child, owner, fencing, now);
        if (!ownership.ok) return { ok: false, reason: ownership.reason };
        const renewed = this.db.run(
          `UPDATE extraction_chunk_lease
              SET lease_until = ?
            WHERE child_id = ? AND owner = ? AND fencing = ?`,
          addMs(now, this.policy.leaseMs),
          childId,
          owner,
          fencing,
        );
        if (renewed.changes !== ids.length) {
          throw new Error('lease-renewal-changed-row-count');
        }
        this.db.run(
          `UPDATE extraction_attempt
              SET lease_until = ?
            WHERE child_id = ? AND owner = ? AND fencing = ? AND status = 'running'`,
          addMs(now, this.policy.leaseMs),
          childId,
          owner,
          fencing,
        );
        return { ok: true };
      },
      { immediate: true },
    );
  }

  releaseChild(childId: number, owner: string, fencing: number): void {
    const now = iso(this.now());
    this.db.transaction(
      () => {
        this.db.run(
          `UPDATE extraction_chunk_lease SET lease_until = ?
            WHERE child_id = ? AND owner = ? AND fencing = ?`,
          now,
          childId,
          owner,
          fencing,
        );
      },
      { immediate: true },
    );
  }

  beginAttempt(
    childId: number,
    stage: RecoveryStage,
    owner: string,
    fencing: number,
    fingerprint: string,
  ): RecoveryAttemptResult {
    const now = this.now();
    return this.db.transaction(
      () => {
        const child = this.requireChild(childId);
        if (child.fencing !== fencing || child.status !== 'running') {
          return { ok: false, reason: 'stale-fencing' };
        }
        if (this.stageFingerprints(child)[stage] !== fingerprint) {
          return { ok: false, reason: 'stale-fingerprint' };
        }
        const ownership = this.ownsChunks(child, owner, fencing, now);
        if (!ownership.ok) return { ok: false, reason: ownership.reason };
        // Attempts belong to one stage generation. A fingerprint/config change
        // gets a fresh three-attempt budget; old running attempts cannot block
        // the new generation after fencing has moved.
        this.db.run(
          `UPDATE extraction_attempt
              SET status = 'stale', error_code = 'stale-generation', finished_at = ?
            WHERE child_id = ? AND stage = ? AND status = 'running'
              AND (fingerprint <> ? OR fencing <> ?)`,
          iso(now),
          childId,
          stage,
          fingerprint,
          fencing,
        );
        let running = this.db.get<RecoveryAttemptRow>(
          `SELECT * FROM extraction_attempt
            WHERE child_id = ? AND stage = ? AND fingerprint = ? AND retry_epoch = ? AND status = 'running'
            ORDER BY id DESC LIMIT 1`,
          childId,
          stage,
          fingerprint,
          child.retry_epoch,
        );
        if (running) {
          const expired = Date.parse(running.lease_until) <= now;
          if (expired) {
            this.db.run(
              `UPDATE extraction_attempt
                  SET status = 'stale', error_code = 'lease-expired', finished_at = ?
                WHERE id = ? AND status = 'running'`,
              iso(now),
              running.id,
            );
            running = undefined;
          } else if (running.owner !== owner || running.fencing !== fencing) {
            return { ok: false, reason: 'attempt-owned' };
          } else {
            return {
              ok: true,
              attemptId: running.id,
              attemptNumber: running.attempt_number,
              fencing,
            };
          }
        }
        const count = this.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM extraction_attempt
            WHERE child_id = ? AND stage = ? AND fingerprint = ? AND retry_epoch = ?`,
          childId,
          stage,
          fingerprint,
          child.retry_epoch,
        );
        const used = Number(count?.n ?? 0);
        if (used >= this.policy.maxAttempts) return { ok: false, reason: 'attempts-exhausted' };
        const attemptNumber = used + 1;
        const attemptId = this.db.run(
          `INSERT INTO extraction_attempt
             (child_id, project_id, stage, fingerprint, retry_epoch, attempt_number, status, owner, fencing,
              lease_until, finish_reason, parser_route, error_code, started_at)
           VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, '', '', '', ?)`,
          childId,
          child.project_id,
          stage,
          fingerprint,
          child.retry_epoch,
          attemptNumber,
          owner,
          fencing,
          addMs(now, this.policy.leaseMs),
          iso(now),
        ).lastInsertRowid;
        return { ok: true, attemptId, attemptNumber, fencing };
      },
      { immediate: true },
    );
  }

  private ownsChunks(
    child: RecoveryChildRow,
    owner: string,
    fencing: number,
    now: number,
  ): { ok: true } | { ok: false; reason: string } {
    for (const chunkId of this.chunkIds(child)) {
      const lease = this.db.get<{
        child_id: number;
        owner: string;
        fencing: number;
        lease_until: string;
      }>(
        'SELECT child_id, owner, fencing, lease_until FROM extraction_chunk_lease WHERE chunk_id = ?',
        chunkId,
      );
      if (
        !lease ||
        lease.child_id !== child.id ||
        lease.owner !== owner ||
        lease.fencing !== fencing ||
        Date.parse(lease.lease_until) <= now
      ) {
        return { ok: false, reason: 'lease-lost' };
      }
    }
    return { ok: true };
  }

  stageBatch(input: {
    attemptId: number;
    childId: number;
    projectId: number;
    stage: RecoveryStage;
    fingerprint: string;
    payload: unknown;
    finishReason: string;
    complete: boolean;
  }): number {
    const payloadJson = stableStringify(input.payload);
    const at = iso(this.now());
    return this.db.transaction(
      () => {
        const attempt = this.requireAttempt(input.attemptId);
        if (attempt.status !== 'running') throw new Error(`attempt ${attempt.id} is not running`);
        if (
          attempt.child_id !== input.childId ||
          attempt.project_id !== input.projectId ||
          attempt.fingerprint !== input.fingerprint
        ) {
          throw new Error('stale-attempt');
        }
        const child = this.requireChild(input.childId);
        if (child.project_id !== input.projectId) throw new Error('stale-child');
        if (child.fencing !== attempt.fencing || child.status !== 'running') {
          throw new Error('stale-fencing');
        }
        const ownership = this.ownsChunks(child, attempt.owner, attempt.fencing, this.now());
        if (!ownership.ok) throw new Error(ownership.reason);
        const existing = this.db.get<{ id: number }>(
          `SELECT id FROM extraction_staged_batch
            WHERE child_id = ? AND stage = ? AND fingerprint = ? AND payload_sha256 = ?`,
          input.childId,
          input.stage,
          input.fingerprint,
          hash(payloadJson),
        );
        if (existing) {
          if (input.complete) {
            this.db.run(
              `UPDATE extraction_staged_batch
                  SET complete = 1, attempt_id = ?, finish_reason = ?, created_at = ?
                WHERE id = ?`,
              input.attemptId,
              input.finishReason,
              at,
              existing.id,
            );
          }
          return existing.id;
        }
        return this.db.run(
          `INSERT INTO extraction_staged_batch
             (attempt_id, child_id, project_id, stage, fingerprint, payload_json,
              payload_sha256, byte_size, complete, finish_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          input.attemptId,
          input.childId,
          input.projectId,
          input.stage,
          input.fingerprint,
          payloadJson,
          hash(payloadJson),
          Buffer.byteLength(payloadJson, 'utf8'),
          input.complete ? 1 : 0,
          input.finishReason,
          at,
        ).lastInsertRowid;
      },
      { immediate: true },
    );
  }

  finishAttempt(
    attemptId: number,
    status: Exclude<RecoveryAttemptStatus, 'running'>,
    input: {
      finishReason?: string;
      parserRoute?: string;
      errorCode?: string;
      owner?: string;
      fencing?: number;
    } = {},
  ): void {
    this.db.run(
      `UPDATE extraction_attempt
          SET status = ?, finish_reason = ?, parser_route = ?, error_code = ?, finished_at = ?
        WHERE id = ? AND status = 'running'
          ${input.owner === undefined ? '' : 'AND owner = ?'}
          ${input.fencing === undefined ? '' : 'AND fencing = ?'}`,
      status,
      input.finishReason ?? '',
      input.parserRoute ?? '',
      input.errorCode ?? '',
      iso(this.now()),
      attemptId,
      ...(input.owner === undefined ? [] : [input.owner]),
      ...(input.fencing === undefined ? [] : [input.fencing]),
    );
  }

  /**
   * Apply a complete staged batch and write its coverage in one transaction.
   * The callback must be synchronous and must not call a provider.
   */
  applyCoverage(input: {
    childId: number;
    projectId: number;
    stage: RecoveryStage;
    fingerprint: string;
    attemptId: number;
    owner: string;
    fencing: number;
    status: 'complete' | 'empty' | 'not_applicable';
    result?: unknown;
    apply?: () => void;
  }): RecoveryCoverageRow {
    const now = this.now();
    return this.db.transaction(
      () => {
        const child = this.requireChild(input.childId);
        if (child.project_id !== input.projectId) throw new Error('stale-child');
        if (child.fencing !== input.fencing || child.status !== 'running') {
          throw new Error('stale-fencing');
        }
        const attempt = this.requireAttempt(input.attemptId);
        if (
          attempt.child_id !== input.childId ||
          attempt.project_id !== input.projectId ||
          attempt.stage !== input.stage ||
          attempt.fingerprint !== input.fingerprint
        ) {
          throw new Error('stale-attempt');
        }
        const ownership = this.ownsChunks(child, input.owner, input.fencing, now);
        if (!ownership.ok) throw new Error(ownership.reason);
        const batch = this.sealedBatch(
          input.attemptId,
          input.childId,
          input.stage,
          input.fingerprint,
        );
        if (!batch) throw new Error('sealed-batch-missing');
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(batch.payload_json) as Record<string, unknown>;
        } catch {
          throw new Error('sealed-batch-invalid');
        }
        const empty = this.payloadEmpty(input.stage, payload);
        if (input.status === 'not_applicable') {
          if (payload.notApplicable !== true) throw new Error('sealed-batch-status-mismatch');
        } else if (input.status === 'empty') {
          if (!empty) throw new Error('sealed-batch-status-mismatch');
        } else if (empty) {
          throw new Error('sealed-batch-status-mismatch');
        }
        const existing = this.getCoverage(input.childId, input.stage, input.fingerprint);
        if (
          existing &&
          (existing.status === 'complete' || existing.status === 'empty' || existing.status === 'not_applicable')
        ) {
          return existing;
        }
        input.apply?.();
        this.db.run(
          `INSERT INTO extraction_stage_coverage
             (child_id, project_id, stage, fingerprint, status, attempt_id, result_json, finalized_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(child_id, stage, fingerprint) DO UPDATE SET
             status = excluded.status,
             attempt_id = excluded.attempt_id,
             result_json = excluded.result_json,
             finalized_at = excluded.finalized_at`,
          input.childId,
          input.projectId,
          input.stage,
          input.fingerprint,
          input.status,
          input.attemptId,
          stableStringify(input.result ?? {}),
          iso(now),
        );
        this.db.run(
          `UPDATE extraction_attempt
              SET status = 'succeeded', finished_at = ?
            WHERE id = ? AND status = 'running'`,
          iso(now),
          input.attemptId,
        );
        return this.db.get<RecoveryCoverageRow>(
          `SELECT * FROM extraction_stage_coverage
            WHERE child_id = ? AND stage = ? AND fingerprint = ?`,
          input.childId,
          input.stage,
          input.fingerprint,
        )!;
      },
      { immediate: true },
    );
  }

  deferStage(input: {
    childId: number;
    projectId: number;
    stage: RecoveryStage;
    fingerprint: string;
    attemptId?: number;
    /** Required: a deferral expires leases and must prove ownership. */
    owner: string;
    fencing: number;
    reason: string;
  }): void {
    const now = this.now();
    this.db.transaction(
      () => {
        const child = this.requireChild(input.childId);
        if (child.project_id !== input.projectId) throw new Error('stale-child');
        if (child.fencing !== input.fencing || child.status !== 'running') {
          throw new Error('stale-fencing');
        }
        const ownership = this.ownsChunks(child, input.owner, input.fencing, now);
        if (!ownership.ok) throw new Error(ownership.reason);
        if (input.attemptId !== undefined) {
          const attempt = this.requireAttempt(input.attemptId);
          if (
            attempt.child_id !== input.childId ||
            attempt.stage !== input.stage ||
            attempt.fingerprint !== input.fingerprint
          ) {
            throw new Error('stale-attempt');
          }
          if (attempt.owner !== input.owner || attempt.fencing !== input.fencing) {
            throw new Error('stale-fencing');
          }
        }
        const existing = this.getCoverage(input.childId, input.stage, input.fingerprint);
        const nextRetryAt = addMs(now, this.policy.backoffMs[this.policy.backoffMs.length - 1] ?? 0);
        if (
          !existing ||
          (existing.status !== 'complete' && existing.status !== 'empty' && existing.status !== 'not_applicable')
        ) {
          this.db.run(
            `INSERT INTO extraction_stage_coverage
               (child_id, project_id, stage, fingerprint, status, attempt_id, result_json, finalized_at)
             VALUES (?, ?, ?, ?, 'deferred', ?, ?, ?)
             ON CONFLICT(child_id, stage, fingerprint) DO UPDATE SET
               status = 'deferred',
               attempt_id = excluded.attempt_id,
               result_json = excluded.result_json,
               finalized_at = excluded.finalized_at`,
            input.childId,
            input.projectId,
            input.stage,
            input.fingerprint,
            input.attemptId ?? null,
            stableStringify({ reason: input.reason, nextRetryAt }),
            iso(now),
          );
        }
        if (input.attemptId) {
          this.db.run(
            `UPDATE extraction_attempt
                SET status = 'deferred', error_code = ?, finished_at = ?
              WHERE id = ? AND status IN ('running', 'incomplete', 'failed')`,
            input.reason,
            iso(now),
            input.attemptId,
          );
        }
        this.db.run(
          `UPDATE extraction_recovery_child
              SET status = 'deferred'
            WHERE id = ? AND status <> 'complete'`,
          input.childId,
        );
        for (const parentId of this.parentIdsForChild(input.childId)) {
          this.db.run(
            `UPDATE extraction_recovery_parent
                SET status = 'deferred'
              WHERE id = ? AND status <> 'complete'`,
            parentId,
          );
        }
        // Fencing is the ownership predicate: a stale caller cannot expire a
        // live owner's leases even if it still knows the child id.
        this.db.run(
          'UPDATE extraction_chunk_lease SET lease_until = ? WHERE child_id = ? AND fencing = ?',
          iso(now),
          input.childId,
          input.fencing,
        );
      },
      { immediate: true },
    );
  }

  /** Complete a child only when every required stage has durable coverage. */
  finalizeChild(
    childId: number,
    owner: string,
    fencing: number,
    beforeFinalize?: (status: RecoveryChildStatus) => void,
    markMined = true,
  ): RecoveryChildStatus {
    const now = this.now();
    return this.db.transaction(
      () => {
        const child = this.requireChild(childId);
        if (child.status === 'complete') return 'complete';
        if (child.status === 'deferred') return 'deferred';
        if (child.fencing !== fencing) throw new Error('stale-fencing');
        const ownership = this.ownsChunks(child, owner, fencing, now);
        if (!ownership.ok) throw new Error(ownership.reason);
        const stagePrints = this.stageFingerprints(child);
        const required = this.requiredStages(child);
        const statuses = required.map((stage) => {
          const fingerprint = stagePrints[stage];
          const coverage = fingerprint ? this.getCoverage(childId, stage, fingerprint) : undefined;
          return { stage, fingerprint, coverage };
        });
        const allComplete = required.length > 0 && statuses.every(
          ({ coverage }) =>
            coverage &&
            (coverage.status === 'complete' ||
              coverage.status === 'empty' ||
              coverage.status === 'not_applicable'),
        );
        const deferred = statuses.some(({ coverage }) => coverage?.status === 'deferred');
        const failed = statuses.some(({ coverage }) => coverage?.status === 'failed');
        const status: RecoveryChildStatus = allComplete
          ? 'complete'
          : deferred
            ? 'deferred'
            : failed
              ? 'failed'
              : 'partial';
        beforeFinalize?.(status);
        if (status === 'complete') {
          this.db.run(
            `UPDATE extraction_recovery_child SET status = 'complete', completed_at = ? WHERE id = ?`,
            iso(now),
            childId,
          );
          if (markMined) {
            const ids = this.chunkIds(child);
            if (ids.length) {
              const placeholders = ids.map(() => '?').join(',');
              this.db.run(
                `UPDATE canon_chunk SET lore_mined = 1 WHERE id IN (${placeholders})`,
                ...ids,
              );
            }
          }
        } else {
          // A retryable/partial child loses ownership; explicit or automatic
          // recovery may claim it again. No staged work is deleted.
          this.db.run(
            'UPDATE extraction_recovery_child SET status = ? WHERE id = ?',
            status,
            childId,
          );
        }
        this.db.run(
          'UPDATE extraction_chunk_lease SET lease_until = ? WHERE child_id = ? AND fencing = ?',
          iso(now),
          childId,
          fencing,
        );
        return status;
      },
      { immediate: true },
    );
  }

  /**
   * Mark an in-process failure durable when the caller still owns the child.
   * A lost/stale owner must not mutate the child; auto-recovery will handle it
   * after the lease expires.
   */
  abortChild(childId: number, owner: string, fencing: number, reason: string): boolean {
    const now = this.now();
    return this.db.transaction(
      () => {
        const child = this.requireChild(childId);
        if (child.status === 'complete' || child.status === 'deferred') return false;
        if (child.fencing !== fencing || child.status !== 'running') return false;
        const ownership = this.ownsChunks(child, owner, fencing, now);
        if (!ownership.ok) return false;
        this.db.run(
          `UPDATE extraction_attempt
              SET status = 'abandoned', error_code = ?, finished_at = ?
            WHERE child_id = ? AND status = 'running'`,
          reason.slice(0, 200),
          iso(now),
          childId,
        );
        this.db.run(
          `UPDATE extraction_recovery_child SET status = 'failed' WHERE id = ?`,
          childId,
        );
        for (const parentId of this.parentIdsForChild(childId)) {
          this.db.run(
            `UPDATE extraction_recovery_parent
                SET status = 'failed'
              WHERE id = ? AND status <> 'complete'`,
            parentId,
          );
        }
        this.db.run(
          'UPDATE extraction_chunk_lease SET lease_until = ? WHERE child_id = ? AND fencing = ?',
          iso(now),
          childId,
          fencing,
        );
        return true;
      },
      { immediate: true },
    );
  }

  setParentReadiness(
    parentId: number,
    readiness: string,
    optionalStatus: Record<string, unknown>,
  ): void {
    this.db.run(
      `UPDATE extraction_recovery_parent
          SET readiness = ?, optional_status = ?
        WHERE id = ?`,
      readiness,
      stableStringify(optionalStatus),
      parentId,
    );
  }

  finalizeParent(
    parentId: number,
    options: { forcePartial?: boolean } = {},
  ): RecoveryParentStatus {
    const now = this.now();
    return this.db.transaction(
      () => {
        const parent = this.getParent(parentId);
        if (!parent) throw new Error(`missing recovery parent ${parentId}`);
        if (parent.status === 'complete' && options.forcePartial !== true) return 'complete';
        const children = this.children(parentId);
        const statuses = children.map((child) => child.status);
        const derived: RecoveryParentStatus =
          children.length > 0 && statuses.every((item) => item === 'complete')
            ? 'complete'
            : statuses.some((item) => item === 'deferred')
              ? 'deferred'
              : statuses.some((item) => item === 'failed')
                ? 'failed'
                : statuses.some((item) => item === 'partial')
                  ? 'partial'
                  : 'pending';
        const status: RecoveryParentStatus =
          options.forcePartial === true && derived === 'complete' ? 'partial' : derived;
        this.db.run(
          `UPDATE extraction_recovery_parent
              SET status = ?, completed_at = ?
            WHERE id = ?`,
          status,
          status === 'complete' ? iso(now) : null,
          parentId,
        );
        return status;
      },
      { immediate: true },
    );
  }

  /**
   * Freeze the exact prompt names and resolver rows used by one relationship
   * stage. The snapshot is the source of truth for both the prompt and
   * endpoint resolution; a concurrent DB change cannot mix the two.
   */
  snapshotRelationStage(
    projectId: number,
    promptNames: string[],
    entityRows?: RecoveryRosterEntity[],
    persist = true,
  ): RecoveryRelationSnapshot {
    const entities = entityRows ?? this.db.all<RecoveryRosterEntity>(
      `SELECT id, kind, name, aliases, COALESCE(review_status, 'accepted') AS review_status
         FROM canon_entity WHERE project_id = ? ORDER BY id`,
      projectId,
    );
    const payload = { promptNames: [...promptNames], entities };
    const rosterJson = stableStringify(payload);
    const fingerprint = hash(rosterJson);
    const at = iso(this.now());
    if (persist) {
      this.db.run(
        `INSERT OR IGNORE INTO extraction_roster_snapshot
           (project_id, fingerprint, roster_json, created_at)
         VALUES (?, ?, ?, ?)`,
        projectId,
        fingerprint,
        rosterJson,
        at,
      );
    }
    return { fingerprint, promptNames: [...promptNames], entities };
  }

  relationSnapshot(projectId: number, fingerprint: string): RecoveryRelationSnapshot | undefined {
    const row = this.db.get<{ roster_json: string }>(
      'SELECT roster_json FROM extraction_roster_snapshot WHERE project_id = ? AND fingerprint = ?',
      projectId,
      fingerprint,
    );
    if (!row) return undefined;
    try {
      const payload = JSON.parse(row.roster_json) as {
        promptNames?: unknown;
        entities?: unknown;
      };
      if (!Array.isArray(payload.promptNames) || !Array.isArray(payload.entities)) return undefined;
      return {
        fingerprint,
        promptNames: payload.promptNames.map(String),
        entities: payload.entities as RecoveryRosterEntity[],
      };
    } catch {
      return undefined;
    }
  }

  snapshotRoster(projectId: number): { id: number; fingerprint: string; rosterJson: string } {
    const rows = this.db.all<{
      id: number;
      kind: string;
      name: string;
      aliases: string;
      review_status: string;
    }>(
      `SELECT id, kind, name, aliases, COALESCE(review_status, 'accepted') AS review_status
         FROM canon_entity WHERE project_id = ? ORDER BY id`,
      projectId,
    );
    const rosterJson = stableStringify(rows);
    const fingerprint = hash(rosterJson);
    const at = iso(this.now());
    const existing = this.db.get<{ id: number }>(
      'SELECT id FROM extraction_roster_snapshot WHERE project_id = ? AND fingerprint = ?',
      projectId,
      fingerprint,
    );
    if (existing) return { id: existing.id, fingerprint, rosterJson };
    const id = this.db.run(
      `INSERT INTO extraction_roster_snapshot
         (project_id, fingerprint, roster_json, created_at)
       VALUES (?, ?, ?, ?)`,
      projectId,
      fingerprint,
      rosterJson,
      at,
    ).lastInsertRowid;
    return { id, fingerprint, rosterJson };
  }

  status(parentId: number): RecoveryParentSummary {
    const parent = this.getParent(parentId);
    if (!parent) throw new Error(`missing recovery parent ${parentId}`);
    return {
      parentId,
      projectId: parent.project_id,
      scopeKey: parent.scope_key,
      fingerprint: parent.fingerprint,
      status: parent.status,
      children: this.children(parentId).map((child) => {
        const prints = this.stageFingerprints(child);
        return {
          childId: child.id,
          windowIndex: child.window_index,
          status: child.status,
          chunkIds: this.chunkIds(child),
          stages: this.requiredStages(child).map((stage) => {
            const fingerprint = prints[stage] ?? '';
            const coverage = fingerprint ? this.getCoverage(child.id, stage, fingerprint) : undefined;
            return {
              stage,
              status: coverage?.status ?? 'pending',
              fingerprint,
            };
          }),
        };
      }),
    };
  }

  deferred(projectId?: number): RecoveryDeferredRow[] {
    const rows = this.db.all<{
      parent_id: number;
      p_project_id: number;
      p_status: RecoveryParentStatus;
      child_id: number;
      c_project_id: number;
      window_index: number;
      c_status: RecoveryChildStatus;
    }>(
      `SELECT p.id AS parent_id, p.project_id AS p_project_id, p.status AS p_status,
              c.id AS child_id, c.project_id AS c_project_id, c.window_index,
              c.status AS c_status
         FROM extraction_recovery_parent p
         JOIN extraction_recovery_run_child r ON r.parent_id = p.id
         JOIN extraction_recovery_child c ON c.id = r.child_id
        WHERE c.status = 'deferred' ${projectId === undefined ? '' : 'AND p.project_id = ?'}
        ORDER BY p.id, r.source_order, r.window_index`,
      ...(projectId === undefined ? [] : [projectId]),
    );
    return rows.map((row) => {
      const coverages = this.coverageForChild(row.child_id).filter((coverage) => coverage.status === 'deferred');
      const latest = coverages[coverages.length - 1];
      let nextRetryAt: string | null = null;
      if (latest) {
        try {
          const parsed = JSON.parse(latest.result_json || '{}') as { nextRetryAt?: unknown };
          if (typeof parsed.nextRetryAt === 'string') nextRetryAt = parsed.nextRetryAt;
        } catch {
          /* malformed diagnostic payload: keep the deferral visible without it */
        }
      }
      return {
        parentId: row.parent_id,
        childId: row.child_id,
        projectId: row.c_project_id,
        windowIndex: row.window_index,
        stage: latest?.stage ?? null,
        status: latest?.status ?? row.c_status,
        nextRetryAt,
      };
    });
  }

  private payloadEmpty(stage: RecoveryStage, payload: Record<string, unknown>): boolean {
    const array = (key: string): unknown[] => (Array.isArray(payload[key]) ? payload[key] as unknown[] : []);
    if (stage === 'entities-facts') return array('entities').length === 0 && array('facts').length === 0;
    if (stage === 'relations') return array('relations').length === 0;
    if (stage === 'timeline') return array('timeline').length === 0;
    return array('entities').length === 0 &&
      array('facts').length === 0 &&
      array('relations').length === 0 &&
      array('timeline').length === 0;
  }

  private parentIdsForChild(childId: number): number[] {
    return this.db
      .all<{ parent_id: number }>(
        'SELECT parent_id FROM extraction_recovery_run_child WHERE child_id = ?',
        childId,
      )
      .map((row) => row.parent_id);
  }

  private requireChild(childId: number): RecoveryChildRow {
    const child = this.getChild(childId);
    if (!child) throw new Error(`missing recovery child ${childId}`);
    return child;
  }

  private requireAttempt(attemptId: number): RecoveryAttemptRow {
    const attempt = this.db.get<RecoveryAttemptRow>('SELECT * FROM extraction_attempt WHERE id = ?', attemptId);
    if (!attempt) throw new Error(`missing recovery attempt ${attemptId}`);
    return attempt;
  }
}

/** A per-run owner token. Unique across processes without a host-specific name. */
export function newRecoveryOwner(): string {
  return `${process.pid}:${randomUUID()}`;
}

/** Start a lease heartbeat. The returned `lost()` becomes true after a failed renewal. */
export function startRecoveryHeartbeat(
  controller: RecoveryController,
  childId: number,
  owner: string,
  fencing: number,
): { stop: () => void; lost: () => boolean } {
  let lost = false;
  const timer = setInterval(() => {
    if (lost) return;
    try {
      const renewed = controller.renewChild(childId, owner, fencing);
      if (!renewed.ok) lost = true;
    } catch {
      lost = true;
    }
  }, controller.policy.heartbeatMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    lost: () => lost,
  };
}
