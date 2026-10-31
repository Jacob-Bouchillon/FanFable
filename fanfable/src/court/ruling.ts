/**
 * The court record.
 *
 * A relation's `review_status` is the current verdict; this table is the
 * record of how it got there. Every actor writes here, and no actor writes a
 * status without one:
 *
 *   bank      charge    the extractor or scan proposes a claim
 *   chain     clue      a quote is verified in its cited chunk, a note is made
 *   web       clue      a meeting crosses evidence, a want is resolved
 *   assessor  verdict   the model scores a claim or a dossier
 *   guard     appeal    promote / audit / attest move a claim
 *   guard     objection a tie note holds a claim aside (unsupported, moment)
 *   assessor  objection evaluation parks a claim and files the case
 *   human     appeal    a person confirms, corrects or removes a claim
 *   human     removal   a person deletes a claim; the ruling keeps the case
 *
 * The subject key is `relation:<id>` for a claim, `thread:<id>` for a clue
 * about an investigation, `meeting:<id>` for a meeting. It survives the
 * deletion of the row it names, which is the point: a removal is a ruling,
 * not an absence.
 *
 * Additive only: nothing here changes a status. Callers change the status and
 * record the ruling in the same transaction.
 */
import { createHash } from 'node:crypto';
import { Db, nowIso } from '../db.ts';

export type RulingRole = 'charge' | 'clue' | 'verdict' | 'appeal' | 'removal' | 'objection';
export type RulingActor = 'bank' | 'web' | 'chain' | 'assessor' | 'guard' | 'human' | 'external';

export interface RulingInput {
  /** The claim this ruling is about, when it is about one. */
  relationId?: number | null;
  /** The investigation this clue belongs to, when it is not a claim ruling. */
  threadId?: number | null;
  /** Override the subject key; defaults to relation:<id> or thread:<id>. */
  subject?: string;
  role: RulingRole;
  actor: RulingActor;
  /** sentence-proof | passage-proof | strict-verbatim | assessment | dossier | ... */
  standard?: string;
  fromStatus?: string;
  toStatus?: string;
  /** One line of reasoning, never prose from the book. */
  basis?: string;
  /** The quote this ruling examined, hashed so the record carries no prose. */
  quote?: string;
}

export interface RulingRow {
  id: number;
  relation_id: number | null;
  thread_id: number | null;
  subject: string;
  role: string;
  actor: string;
  standard: string;
  from_status: string;
  to_status: string;
  basis: string;
  quote_hash: string;
  created_at: string;
}

export function relationSubject(relationId: number): string {
  return `relation:${relationId}`;
}

export function threadSubject(threadId: number): string {
  return `thread:${threadId}`;
}

export function meetingSubject(meetingId: number): string {
  return `meeting:${meetingId}`;
}

/** A stable fingerprint of the quote, so the record proves what it saw. */
export function quoteHash(text: string): string {
  const normal = String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normal).digest('hex');
}

export function recordRuling(db: Db, projectId: number, input: RulingInput): number {
  const relationId = input.relationId ?? null;
  const threadId = input.threadId ?? null;
  const subject =
    input.subject ?? (relationId !== null ? relationSubject(relationId) : threadId !== null ? threadSubject(threadId) : '');
  return Number(
    db.run(
      `INSERT INTO canon_ruling
         (project_id, relation_id, thread_id, subject, role, actor, standard,
          from_status, to_status, basis, quote_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      relationId,
      threadId,
      subject,
      input.role,
      input.actor,
      String(input.standard ?? ''),
      String(input.fromStatus ?? ''),
      String(input.toStatus ?? ''),
      String(input.basis ?? '').slice(0, 500),
      input.quote ? quoteHash(input.quote) : '',
      nowIso(),
    ).lastInsertRowid,
  );
}

export interface RulingQuery {
  subject?: string;
  relationId?: number;
  role?: string;
  limit?: number;
}

/** A claim's or thread's history, newest first. Read-only. */
export function listRulings(db: Db, projectId: number, opts: RulingQuery = {}): RulingRow[] {
  const where: string[] = ['project_id = ?'];
  const params: unknown[] = [projectId];
  if (opts.subject) {
    where.push('subject = ?');
    params.push(opts.subject);
  }
  if (opts.relationId !== undefined) {
    where.push('relation_id = ?');
    params.push(opts.relationId);
  }
  if (opts.role) {
    where.push('role = ?');
    params.push(opts.role);
  }
  const limit = opts.limit === undefined ? 100 : Math.max(1, Math.floor(opts.limit));
  return db.all<RulingRow>(
    `SELECT * FROM canon_ruling WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
    ...params,
    limit,
  );
}

export interface DocketRow {
  subject: string;
  relationId: number | null;
  threadId: number | null;
  pair: string;
  kind: string;
  status: string;
  role: string;
  actor: string;
  standard: string;
  basis: string;
  at: string;
  rulings: number;
  /** Pending tie notes on the same pair and kind. */
  objections: number;
  /** Open ends on the case's thread (clue rows only). */
  openEnds: number;
  /** True when a rival claim contests the relation. */
  contested: boolean;
}

/**
 * One line per case: the latest ruling for every subject, with the claim's
 * current status, its pending objections and any open want beside it.
 * Read-only. This is the docket a person reads.
 */
export function docket(
  db: Db,
  projectId: number,
  opts: { limit?: number; role?: string; actor?: string } = {},
): DocketRow[] {
  const limit = opts.limit === undefined ? 50 : Math.max(1, Math.floor(opts.limit));
  const where: string[] = [];
  const params: unknown[] = [projectId];
  if (opts.role) {
    where.push('latest.role = ?');
    params.push(opts.role);
  }
  if (opts.actor) {
    where.push('latest.actor = ?');
    params.push(opts.actor);
  }
  const rows = db.all<{
    subject: string;
    relation_id: number | null;
    thread_id: number | null;
    role: string;
    actor: string;
    standard: string;
    basis: string;
    created_at: string;
    kind: string | null;
    review_status: string | null;
    a_name: string | null;
    b_name: string | null;
    n: number;
    objections: number;
    open_ends: number;
    conflict_status: string | null;
  }>(
    `SELECT latest.subject, latest.relation_id, latest.thread_id, latest.role, latest.actor,
            latest.standard, latest.basis, latest.created_at,
            rel.kind, rel.review_status, rel.conflict_status,
            a.name AS a_name, b.name AS b_name,
            (SELECT COUNT(*) FROM canon_ruling r2
              WHERE r2.project_id = latest.project_id AND r2.subject = latest.subject) AS n,
            (SELECT COUNT(*) FROM canon_tie_note nt
              WHERE nt.project_id = latest.project_id AND nt.status = 'pending'
                AND rel.id IS NOT NULL
                AND ((nt.from_entity = rel.from_entity AND nt.to_entity = rel.to_entity)
                  OR (nt.from_entity = rel.to_entity AND nt.to_entity = rel.from_entity))
                AND lower(nt.attempted_kind) = lower(rel.kind)) AS objections,
            (SELECT COUNT(*) FROM canon_open_end oe
              WHERE oe.status = 'open'
                AND (
                  oe.thread_id = latest.thread_id
                  OR EXISTS (
                    SELECT 1 FROM canon_thread t
                     WHERE t.id = oe.thread_id AND t.project_id = latest.project_id
                       AND t.kind = 'pair' AND rel.id IS NOT NULL
                       AND t.a_entity = MIN(rel.from_entity, rel.to_entity)
                       AND t.b_entity = MAX(rel.from_entity, rel.to_entity)
                  )
                )) AS open_ends
       FROM canon_ruling latest
       JOIN (
         SELECT subject, MAX(id) AS id
           FROM canon_ruling
          WHERE project_id = ?
          GROUP BY subject
       ) last ON last.id = latest.id
       LEFT JOIN canon_relation rel ON rel.id = latest.relation_id
       LEFT JOIN canon_entity a ON a.id = rel.from_entity
       LEFT JOIN canon_entity b ON b.id = rel.to_entity
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY latest.id DESC
      LIMIT ?`,
    ...params,
    limit,
  );
  return rows.map((row) => ({
    subject: row.subject,
    relationId: row.relation_id,
    threadId: row.thread_id,
    pair:
      row.a_name && row.b_name
        ? `${row.a_name} / ${row.b_name}`
        : row.subject.startsWith('thread:')
          ? `thread ${row.subject.slice('thread:'.length)}`
          : row.subject.startsWith('pair:')
            ? `pair ${row.subject.slice('pair:'.length).replace(':', '/')}`
            : row.subject,
    kind: row.kind ?? '',
    status: row.review_status ?? (row.subject.startsWith('relation:') ? 'removed' : ''),
    role: row.role,
    actor: row.actor,
    standard: row.standard,
    basis: row.basis,
    at: row.created_at,
    rulings: row.n,
    objections: row.objections,
    openEnds: row.open_ends,
    contested: row.conflict_status === 'contested',
  }));
}

/**
 * Give every relation that predates the court record one opening charge.
 * Additive: no status changes. Returns how many charges were written.
 */
export function backfillCharges(db: Db, projectId: number): number {
  const rows = db.all<{ id: number; review_status: string }>(
    `SELECT r.id, r.review_status
       FROM canon_relation r
      WHERE r.project_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM canon_ruling g
           WHERE g.project_id = r.project_id AND g.relation_id = r.id
        )
      ORDER BY r.id`,
    projectId,
  );
  let written = 0;
  db.transaction(() => {
    for (const row of rows) {
      recordRuling(db, projectId, {
        relationId: row.id,
        role: 'charge',
        actor: 'bank',
        standard: 'imported',
        toStatus: row.review_status,
        basis: 'backfilled: predates the court record',
      });
      written++;
    }
  });
  return written;
}
