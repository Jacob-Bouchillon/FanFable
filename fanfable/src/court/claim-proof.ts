/**
 * Claim identity and proof history.
 *
 * This module does not decide whether evidence establishes a claim. The
 * existing gates remain the sole proof authority. It gives each claim a
 * stable instance identity, records immutable proof attempts, and resolves
 * the latest attempt against the current claim/evidence/policy version.
 *
 * A stored `verified` outcome is never trusted by itself: the resolver
 * recomputes the current fingerprints, selects the latest attempt before
 * looking at the outcome, and returns `stale`/`unavailable` at read time when
 * the claim has moved on. There is no fallback to an older verified attempt.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Db, fromJson, nowIso } from '../core/db.ts';
import { normalise } from '../core/text.ts';

export type ClaimType = 'relation' | 'entity' | 'fact';
export type ProofStandard = 'sentence' | 'passage' | 'identity' | 'none';
export type StoredProofOutcome = 'verified' | 'failed' | 'not_evaluated' | 'legacy_unknown';
export type EffectiveProofOutcome = StoredProofOutcome | 'stale' | 'unavailable';

export const FINGERPRINT_VERSION = 'claim-proof-v1';
export const CURRENT_PROOF_POLICY_VERSION = 'claim-proof-v1';
export const SEMANTIC_GATE_POLICY_VERSION = 'gate-semantics-v1';

export const PROOF_STANDARDS: readonly ProofStandard[] = ['sentence', 'passage', 'identity', 'none'];
export const STORED_PROOF_OUTCOMES: readonly StoredProofOutcome[] = [
  'verified',
  'failed',
  'not_evaluated',
  'legacy_unknown',
];

export interface ProofPolicyDescriptor {
  policyVersion: string;
  semanticGatePolicyVersion: string;
  fingerprintVersion: string;
  standards: readonly ProofStandard[];
  storedOutcomes: readonly StoredProofOutcome[];
  effectiveOutcomes: readonly EffectiveProofOutcome[];
  resolverRule: string;
  authority: string;
}

/**
 * The declared proof-policy contract. This is the only input to the policy
 * fingerprint. Semantic changes to entailment, direction, alias or promotion
 * rules require a new semanticGatePolicyVersion and policyVersion; comment or
 * unrelated source changes do not affect this descriptor.
 */
export const PROOF_POLICY_DESCRIPTOR: ProofPolicyDescriptor = Object.freeze({
  policyVersion: CURRENT_PROOF_POLICY_VERSION,
  semanticGatePolicyVersion: SEMANTIC_GATE_POLICY_VERSION,
  fingerprintVersion: FINGERPRINT_VERSION,
  standards: Object.freeze([...PROOF_STANDARDS]) as readonly ProofStandard[],
  storedOutcomes: Object.freeze([...STORED_PROOF_OUTCOMES]) as readonly StoredProofOutcome[],
  effectiveOutcomes: Object.freeze([
    'verified',
    'failed',
    'not_evaluated',
    'legacy_unknown',
    'stale',
    'unavailable',
  ]) as readonly EffectiveProofOutcome[],
  resolverRule: 'latest-attempt-no-fallback',
  authority: 'gates.ts',
});

/** Prefixes are readable diagnostics; the random UUID is the identity. */
export function newClaimUid(type: ClaimType): string {
  const prefix = type === 'relation' ? 'rel' : type === 'entity' ? 'ent' : 'fact';
  return `${prefix}-${randomUUID()}`;
}

export interface ClaimFingerprints {
  claimFingerprint: string;
  evidenceFingerprint: string;
  inputFingerprint: string;
  fingerprintVersion: string;
}

export interface ClaimProofRow {
  id: number;
  project_id: number;
  claim_type: ClaimType;
  claim_uid: string;
  claim_id_at_eval: number | null;
  standard: ProofStandard;
  outcome: StoredProofOutcome;
  claim_fingerprint: string;
  evidence_fingerprint: string;
  input_fingerprint: string;
  fingerprint_version: string;
  policy_version: string;
  gate_version: string;
  attempt_seq: number;
  checked_at: string | null;
  proof_run_id: number | null;
  quote_hash: string;
  detail: string;
  created_at: string;
}

export interface ClaimProofResolution {
  effective: EffectiveProofOutcome;
  reason: string;
  proofId?: number;
  attemptSeq?: number;
  standard?: ProofStandard;
  policyVersion?: string;
  gatePolicyVersion?: string;
}

export interface AppendClaimProofInput {
  claimType: ClaimType;
  claimUid: string;
  standard: ProofStandard;
  outcome: StoredProofOutcome;
  policyVersion?: string;
  gateVersion?: string;
  checkedAt?: string | null;
  proofRunId?: number | null;
  quoteHash?: string;
  detail?: string;
  /**
   * Fingerprints captured when the gate evaluated the claim. When supplied
   * they must match the current claim, so a claim edited between evaluation
   * and append cannot be bound to the result.
   */
  fingerprints?: ClaimFingerprints;
}

export interface ClaimProofExportRow {
  claim_type: ClaimType;
  claim_uid: string;
  claim_id_at_eval: number | null;
  standard: ProofStandard;
  outcome: StoredProofOutcome;
  claim_fingerprint: string;
  evidence_fingerprint: string;
  input_fingerprint: string;
  fingerprint_version: string;
  policy_version: string;
  gate_version: string;
  attempt_seq: number;
  checked_at: string | null;
  proof_run_id: number | null;
  quote_hash: string;
  detail: string;
  created_at: string;
}

interface RelationRow {
  id: number;
  claim_uid: string | null;
  from_entity: number;
  to_entity: number;
  kind: string;
  evidence: string;
  anchor_evidence: string;
  kind_source: string;
  modality: string | null;
  scope: string | null;
  ledger_state: string | null;
  source_refs: string;
}

interface EntityRow {
  id: number;
  claim_uid: string | null;
  kind: string;
  name: string;
  aliases: string;
  summary: string;
  role: string;
  evidence: string;
  source_refs: string;
}

interface FactRow {
  id: number;
  claim_uid: string | null;
  statement: string;
  subject: string;
  topic: string;
  evidence: string;
  source_refs: string;
}

type ClaimRow = RelationRow | EntityRow | FactRow;

const STORED_OUTCOMES: ReadonlySet<string> = new Set(STORED_PROOF_OUTCOMES);

const STANDARDS: Readonly<Record<ClaimType, ReadonlySet<string>>> = {
  relation: new Set(['sentence', 'passage', 'none']),
  entity: new Set(['identity', 'none']),
  fact: new Set(['none']),
};

function stableString(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableString).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableString(record[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Canonical semantic fields, excluding the version label itself. */
function policySemanticFields(descriptor: ProofPolicyDescriptor): Record<string, unknown> {
  return {
    semanticGatePolicyVersion: descriptor.semanticGatePolicyVersion,
    fingerprintVersion: descriptor.fingerprintVersion,
    standards: descriptor.standards,
    storedOutcomes: descriptor.storedOutcomes,
    effectiveOutcomes: descriptor.effectiveOutcomes,
    resolverRule: descriptor.resolverRule,
    authority: descriptor.authority,
  };
}

/** Hash of the semantic contract, excluding the version label. */
export function proofPolicySemanticFingerprint(
  descriptor: ProofPolicyDescriptor = PROOF_POLICY_DESCRIPTOR,
): string {
  return sha256(stableString(policySemanticFields(descriptor)));
}

/**
 * Recorded policy-version history. The semantic fingerprint beside a version
 * makes a descriptor edit without a version bump fail explicitly.
 */
export const POLICY_VERSION_HISTORY: Readonly<Record<string, string>> = Object.freeze({
  'claim-proof-v1': '2c1ebf0043de4c413054410cbf02cb3f84fc55ddc57855029a35687d43152395',
});

/** Validate a descriptor against the recorded version history. */
export function proofPolicyVersionFor(
  descriptor: ProofPolicyDescriptor = PROOF_POLICY_DESCRIPTOR,
  history: Readonly<Record<string, string>> = POLICY_VERSION_HISTORY,
): string {
  const expected = history[descriptor.policyVersion];
  if (!expected) {
    throw new Error(`unknown proof policy version: ${descriptor.policyVersion}`);
  }
  if (expected !== proofPolicySemanticFingerprint(descriptor)) {
    throw new Error(
      'proof policy descriptor changed without a policy-version bump; record the new semantic fingerprint',
    );
  }
  return descriptor.policyVersion;
}

/** Hash of the declared policy descriptor only. It never reads gate source. */
export function proofPolicyFingerprint(
  descriptor: ProofPolicyDescriptor = PROOF_POLICY_DESCRIPTOR,
): string {
  return sha256(
    stableString({
      policyVersion: descriptor.policyVersion,
      ...policySemanticFields(descriptor),
    }),
  );
}

/** A stable hash of the normalized quote, for the proof ledger. */
export function claimQuoteHash(text: string): string {
  return sha256(`quote:${normalise(text)}`);
}

function citedEvidence(db: Db, projectId: number, raw: string): unknown[] {
  const refs = fromJson<Array<{ chunk?: unknown; source?: unknown; locator?: unknown }>>(raw, []);
  const ids = [...new Set(
    refs
      .map((ref) => Number(ref?.chunk))
      .filter((id) => Number.isInteger(id) && id > 0),
  )];
  const chunks = ids.length
    ? db.all<{ id: number; text: string }>(
        `SELECT id, text FROM canon_chunk
          WHERE project_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
        projectId,
        ...ids,
      )
    : [];
  const textHash = new Map(chunks.map((chunk) => [chunk.id, sha256(normalise(chunk.text))]));
  const entries = refs.map((ref) => {
    const chunk = Number(ref?.chunk);
    return {
      chunk: Number.isInteger(chunk) && chunk > 0 ? chunk : null,
      source: String(ref?.source ?? ''),
      locator: String(ref?.locator ?? ''),
      textHash: Number.isInteger(chunk) && chunk > 0 ? (textHash.get(chunk) ?? '') : '',
    };
  });
  const unique = new Map(entries.map((entry) => [stableString(entry), entry]));
  return [...unique.values()].sort((a, b) => stableString(a).localeCompare(stableString(b)));
}

function relationClaimFingerprint(db: Db, projectId: number, row: RelationRow): ClaimFingerprints {
  const endpoints = db.all<{ id: number; claim_uid: string | null }>(
    `SELECT id, claim_uid FROM canon_entity
      WHERE project_id = ? AND id IN (?, ?)`,
    projectId,
    row.from_entity,
    row.to_entity,
  );
  const byId = new Map(endpoints.map((entity) => [entity.id, entity.claim_uid]));
  const claim = {
    type: 'relation',
    claimUid: row.claim_uid ?? '',
    from: row.from_entity,
    fromUid: byId.get(row.from_entity) ?? null,
    to: row.to_entity,
    toUid: byId.get(row.to_entity) ?? null,
    direction: 'from->to',
    kind: normalise(row.kind),
    kindSource: normalise(row.kind_source ?? ''),
    modality: normalise(row.modality ?? ''),
    scope: normalise(row.scope ?? ''),
    ledgerState: normalise(row.ledger_state ?? ''),
  };
  const evidence = {
    quote: normalise(row.evidence),
    anchor: normalise(row.anchor_evidence ?? ''),
    refs: citedEvidence(db, projectId, row.source_refs),
  };
  return fingerprintsFor(claim, evidence);
}

function entityClaimFingerprint(db: Db, projectId: number, row: EntityRow): ClaimFingerprints {
  const claim = {
    type: 'entity',
    claimUid: row.claim_uid ?? '',
    kind: normalise(row.kind),
    name: normalise(row.name),
    aliases: [...new Set(fromJson<string[]>(row.aliases, []).map((alias) => normalise(alias)).filter(Boolean))].sort(),
    summary: normalise(row.summary ?? ''),
    role: normalise(row.role ?? ''),
  };
  const evidence = {
    quote: normalise(row.evidence),
    refs: citedEvidence(db, projectId, row.source_refs),
  };
  return fingerprintsFor(claim, evidence);
}

function factClaimFingerprint(db: Db, projectId: number, row: FactRow): ClaimFingerprints {
  const claim = {
    type: 'fact',
    claimUid: row.claim_uid ?? '',
    statement: normalise(row.statement),
    subject: normalise(row.subject ?? ''),
    topic: normalise(row.topic ?? ''),
  };
  const evidence = {
    quote: normalise(row.evidence),
    refs: citedEvidence(db, projectId, row.source_refs),
  };
  return fingerprintsFor(claim, evidence);
}

function fingerprintsFor(claim: unknown, evidence: unknown): ClaimFingerprints {
  const claimFingerprint = sha256(stableString(claim));
  const evidenceFingerprint = sha256(stableString(evidence));
  return {
    claimFingerprint,
    evidenceFingerprint,
    inputFingerprint: sha256(
      stableString({
        version: FINGERPRINT_VERSION,
        claimFingerprint,
        evidenceFingerprint,
      }),
    ),
    fingerprintVersion: FINGERPRINT_VERSION,
  };
}

function loadClaimRow(
  db: Db,
  projectId: number,
  claimType: ClaimType,
  claimUid: string,
): ClaimRow | null {
  if (!claimUid) return null;
  if (claimType === 'relation') {
    return (
      db.get<RelationRow>(
        `SELECT id, claim_uid, from_entity, to_entity, kind, evidence,
                anchor_evidence, kind_source, modality, scope, ledger_state, source_refs
           FROM canon_relation WHERE project_id = ? AND claim_uid = ?`,
        projectId,
        claimUid,
      ) ?? null
    );
  }
  if (claimType === 'entity') {
    return (
      db.get<EntityRow>(
        `SELECT id, claim_uid, kind, name, aliases, summary, role, evidence, source_refs
           FROM canon_entity WHERE project_id = ? AND claim_uid = ?`,
        projectId,
        claimUid,
      ) ?? null
    );
  }
  return (
    db.get<FactRow>(
      `SELECT id, claim_uid, statement, subject, topic, evidence, source_refs
         FROM canon_fact WHERE project_id = ? AND claim_uid = ?`,
      projectId,
      claimUid,
    ) ?? null
  );
}

/** Current fingerprints, or null when the claim instance does not exist. */
export function computeClaimFingerprints(
  db: Db,
  projectId: number,
  claimType: ClaimType,
  claimUid: string,
): ClaimFingerprints | null {
  const row = loadClaimRow(db, projectId, claimType, claimUid);
  if (!row) return null;
  if (claimType === 'relation') return relationClaimFingerprint(db, projectId, row as RelationRow);
  if (claimType === 'entity') return entityClaimFingerprint(db, projectId, row as EntityRow);
  return factClaimFingerprint(db, projectId, row as FactRow);
}

function sameFingerprints(a: ClaimFingerprints, b: ClaimFingerprints): boolean {
  return (
    a.fingerprintVersion === b.fingerprintVersion &&
    a.claimFingerprint === b.claimFingerprint &&
    a.evidenceFingerprint === b.evidenceFingerprint &&
    a.inputFingerprint === b.inputFingerprint
  );
}

/**
 * Append one immutable proof attempt for a current claim.
 *
 * Callers are the proof owner. The gate decides the outcome; this function
 * only records it. The transaction makes the attempt sequence and row atomic.
 */
export function appendClaimProof(
  db: Db,
  projectId: number,
  input: AppendClaimProofInput,
): { id: number; attemptSeq: number; fingerprints: ClaimFingerprints } {
  proofPolicyVersionFor(PROOF_POLICY_DESCRIPTOR);
  if (!STORED_OUTCOMES.has(input.outcome)) {
    throw new Error(`claim proof outcome must be stored outcome: ${input.outcome}`);
  }
  if (!STANDARDS[input.claimType].has(input.standard)) {
    throw new Error(`standard ${input.standard} is not valid for ${input.claimType}`);
  }
  if (input.outcome === 'verified' && input.standard === 'none') {
    throw new Error('verified proof requires a non-none standard');
  }
  return db.transaction(() => {
    const row = loadClaimRow(db, projectId, input.claimType, input.claimUid);
    if (!row) throw new Error('claim proof refused: claim instance does not exist');
    const current = computeClaimFingerprints(db, projectId, input.claimType, input.claimUid);
    if (!current) throw new Error('claim proof refused: claim instance disappeared');
    if (input.fingerprints && !sameFingerprints(input.fingerprints, current)) {
      throw new Error('claim proof refused: evaluated fingerprint does not match current claim');
    }
    const fingerprints = input.fingerprints ?? current;
    const next = db.get<{ n: number }>(
      `SELECT COALESCE(MAX(attempt_seq), 0) + 1 AS n
         FROM claim_proof
        WHERE project_id = ? AND claim_type = ? AND claim_uid = ?`,
      projectId,
      input.claimType,
      input.claimUid,
    );
    const attemptSeq = Number(next?.n ?? 1);
    const id = Number(
      db.run(
        `INSERT INTO claim_proof
           (project_id, claim_type, claim_uid, claim_id_at_eval, standard, outcome,
            claim_fingerprint, evidence_fingerprint, input_fingerprint, fingerprint_version,
            policy_version, gate_version, attempt_seq, checked_at, proof_run_id,
            quote_hash, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        projectId,
        input.claimType,
        input.claimUid,
        row.id,
        input.standard,
        input.outcome,
        fingerprints.claimFingerprint,
        fingerprints.evidenceFingerprint,
        fingerprints.inputFingerprint,
        fingerprints.fingerprintVersion,
        input.policyVersion ?? PROOF_POLICY_DESCRIPTOR.policyVersion,
        input.gateVersion ?? PROOF_POLICY_DESCRIPTOR.semanticGatePolicyVersion,
        attemptSeq,
        input.checkedAt ?? nowIso(),
        input.proofRunId ?? null,
        input.quoteHash ?? claimQuoteHash(evidenceOf(row)),
        String(input.detail ?? '').slice(0, 500),
        nowIso(),
      ).lastInsertRowid,
    );
    return { id, attemptSeq, fingerprints };
  });
}

function evidenceOf(row: ClaimRow): string {
  return String((row as { evidence?: unknown }).evidence ?? '');
}

/**
 * Resolve the effective proof for a claim instance.
 *
 * Latest attempt first (attempt_seq DESC, id DESC), then validity. A newer
 * failed / not_evaluated / legacy_unknown attempt blocks older verification.
 * `stale` and `unavailable` exist only in this result.
 */
export function resolveClaimProof(
  db: Db,
  projectId: number,
  claimType: ClaimType,
  claimUid: string,
  policyVersion: string = PROOF_POLICY_DESCRIPTOR.policyVersion,
  gatePolicyVersion: string = PROOF_POLICY_DESCRIPTOR.semanticGatePolicyVersion,
): ClaimProofResolution {
  proofPolicyVersionFor(PROOF_POLICY_DESCRIPTOR);
  const row = loadClaimRow(db, projectId, claimType, claimUid);
  if (!row) return { effective: 'unavailable', reason: 'claim_missing' };
  const current = computeClaimFingerprints(db, projectId, claimType, claimUid);
  if (!current) return { effective: 'unavailable', reason: 'claim_fingerprint_unavailable' };
  const latest = db.get<ClaimProofRow>(
    `SELECT * FROM claim_proof
      WHERE project_id = ? AND claim_type = ? AND claim_uid = ?
      ORDER BY attempt_seq DESC, id DESC
      LIMIT 1`,
    projectId,
    claimType,
    claimUid,
  );
  if (!latest) return { effective: 'not_evaluated', reason: 'no_proof' };
  const base = {
    proofId: latest.id,
    attemptSeq: latest.attempt_seq,
    standard: latest.standard,
    policyVersion: latest.policy_version,
    gatePolicyVersion: latest.gate_version,
  };
  if (latest.outcome !== 'verified') {
    return { ...base, effective: latest.outcome, reason: `latest_attempt_${latest.outcome}` };
  }
  if (latest.fingerprint_version !== current.fingerprintVersion) {
    return { ...base, effective: 'stale', reason: 'fingerprint_version' };
  }
  if (
    latest.claim_fingerprint !== current.claimFingerprint ||
    latest.evidence_fingerprint !== current.evidenceFingerprint ||
    latest.input_fingerprint !== current.inputFingerprint
  ) {
    return { ...base, effective: 'stale', reason: 'fingerprint_mismatch' };
  }
  if (latest.policy_version !== policyVersion) {
    return { ...base, effective: 'stale', reason: 'policy_mismatch' };
  }
  if (latest.gate_version !== gatePolicyVersion) {
    return { ...base, effective: 'stale', reason: 'gate_policy_mismatch' };
  }
  return { ...base, effective: 'verified', reason: 'ok' };
}

/** Read-only export, preserving claim UID and original attempt sequence. */
export function exportClaimProofs(db: Db, projectId: number): ClaimProofExportRow[] {
  return db.all<ClaimProofExportRow>(
    `SELECT claim_type, claim_uid, claim_id_at_eval, standard, outcome,
            claim_fingerprint, evidence_fingerprint, input_fingerprint,
            fingerprint_version, policy_version, gate_version, attempt_seq,
            checked_at, proof_run_id, quote_hash, detail, created_at
       FROM claim_proof
      WHERE project_id = ?
      ORDER BY claim_type, claim_uid, attempt_seq, id`,
    projectId,
  );
}

/**
 * Import proof attempts without re-sequencing them. Rows may arrive in any
 * order; the resolver selects the highest attempt_seq, never the last inserted.
 */
export function importClaimProofs(
  db: Db,
  projectId: number,
  rows: ClaimProofExportRow[],
): { inserted: number; skipped: number } {
  let inserted = 0;
  let skipped = 0;
  db.transaction(() => {
    for (const row of rows) {
      if (!STORED_OUTCOMES.has(row.outcome)) {
        skipped++;
        continue;
      }
      if (!STANDARDS[row.claim_type]?.has(row.standard)) {
        skipped++;
        continue;
      }
      const result = db.run(
        `INSERT OR IGNORE INTO claim_proof
           (project_id, claim_type, claim_uid, claim_id_at_eval, standard, outcome,
            claim_fingerprint, evidence_fingerprint, input_fingerprint, fingerprint_version,
            policy_version, gate_version, attempt_seq, checked_at, proof_run_id,
            quote_hash, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        projectId,
        row.claim_type,
        row.claim_uid,
        row.claim_id_at_eval,
        row.standard,
        row.outcome,
        row.claim_fingerprint,
        row.evidence_fingerprint,
        row.input_fingerprint,
        row.fingerprint_version,
        row.policy_version,
        row.gate_version,
        row.attempt_seq,
        row.checked_at,
        row.proof_run_id,
        row.quote_hash,
        row.detail,
        row.created_at,
      );
      if (result.changes) inserted++;
      else skipped++;
    }
  });
  return { inserted, skipped };
}
