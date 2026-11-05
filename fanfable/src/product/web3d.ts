/**
 * Read-only evidence-web projection for the 3D view.
 *
 * Pure database reads: no writes, no model calls. The server serialises these
 * shapes; the client draws them.
 */
import { createHash } from 'node:crypto';
import { Db } from '../core/db.ts';

export type WebNodeKind = 'person' | 'pair' | 'born';

export interface WebGraphNode {
  id: string;
  threadId: number;
  kind: WebNodeKind;
  label: string;
  aName: string;
  bName: string;
  status: string;
  period: string;
  temporal: string;
  /** Period start sequence when the thread is period-scoped. */
  periodFromSeq: number | null;
  notes: number;
  degree: number;
  /** Populated only when the graph request asks for `notes=1`. */
  firstNote?: { quote: string; locator: string; strength: number } | null;
}

export interface WebGraphLink {
  source: string;
  target: string;
  kind: 'membership' | 'meeting' | 'birth';
  weight: number;
}

export interface WebGraph {
  projectId: number;
  revision: string;
  counts: {
    personThreads: number;
    pairThreads: number;
    notes: number;
    meetings: number;
    births: number;
    openEnds: number;
  };
  nodes: WebGraphNode[];
  links: WebGraphLink[];
  openEnds: { threadId: number; questionCount: number }[];
  updatedAt: string;
}

interface ThreadRow {
  id: number;
  kind: 'person' | 'pair';
  a_entity: number;
  b_entity: number | null;
  status: string;
  period_label: string;
  period_from_seq: number | null;
  temporal_status: string;
  birth_reason: string;
  created_at: string;
  updated_at: string;
  a_name: string | null;
  b_name: string | null;
  notes: number;
}

export function buildWebGraph(
  db: Db,
  projectId: number,
  opts: { limit?: number; all?: boolean; notes?: boolean } = {},
): WebGraph {
  const limit = Math.max(1, Math.min(5000, Math.floor(opts.limit ?? 1500)));
  const counts = {
    personThreads: Number(db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM canon_thread WHERE project_id = ? AND kind = 'person'", projectId)?.n ?? 0),
    pairThreads: Number(db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM canon_thread WHERE project_id = ? AND kind = 'pair'", projectId)?.n ?? 0),
    notes: Number(db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM canon_thread_note WHERE project_id = ?', projectId)?.n ?? 0),
    meetings: Number(db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM canon_meeting WHERE project_id = ?', projectId)?.n ?? 0),
    births: Number(db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM canon_birth WHERE project_id = ?', projectId)?.n ?? 0),
    openEnds: Number(db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM canon_open_end WHERE project_id = ? AND status = 'open'", projectId)?.n ?? 0),
  };

  const threads = db.all<ThreadRow>(
    `SELECT t.id, t.kind, t.a_entity, t.b_entity, t.status, t.period_label, t.period_from_seq, t.temporal_status,
            t.birth_reason, t.created_at, t.updated_at,
            a.name AS a_name, b.name AS b_name,
            (SELECT COUNT(*) FROM canon_thread_note n WHERE n.thread_id = t.id) AS notes
       FROM canon_thread t
       LEFT JOIN canon_entity a ON a.id = t.a_entity
       LEFT JOIN canon_entity b ON b.id = t.b_entity
      WHERE t.project_id = ?
      ORDER BY t.id`,
    projectId,
  );
  const meetings = db.all<{ id: number; thread_a: number; thread_b: number; notes_exchanged: number }>(
    'SELECT id, thread_a, thread_b, notes_exchanged FROM canon_meeting WHERE project_id = ? ORDER BY id',
    projectId,
  );
  const births = db.all<{
    id: number;
    parent_a_thread: number;
    parent_b_thread: number;
    child_thread: number;
    combined_score: number;
  }>(
    'SELECT id, parent_a_thread, parent_b_thread, child_thread, combined_score FROM canon_birth WHERE project_id = ? ORDER BY id',
    projectId,
  );
  const personThreadByEntity = new Map<number, number>();
  for (const thread of threads) if (thread.kind === 'person') personThreadByEntity.set(thread.a_entity, thread.id);
  const birthByChild = new Map<number, (typeof births)[number]>();
  for (const birth of births) birthByChild.set(birth.child_thread, birth);
  const meetingThreads = new Set<number>();
  for (const meeting of meetings) {
    meetingThreads.add(meeting.thread_a);
    meetingThreads.add(meeting.thread_b);
  }

  const selected: ThreadRow[] = [];
  for (const thread of threads) {
    const born = birthByChild.has(thread.id);
    const keep = born || thread.kind === 'person' || opts.all === true ||
      thread.notes > 0 || meetingThreads.has(thread.id);
    if (!keep) continue;
    selected.push(thread);
    if (selected.length >= limit) break;
  }

  const firstNotes = new Map<number, { quote: string; locator: string; strength: number }>();
  if (opts.notes === true) {
    const rows = db.all<{ thread_id: number; quote: string; locator: string; strength: number }>(
      `SELECT n.thread_id, n.quote, n.locator, n.strength
         FROM canon_thread_note n
         JOIN (
           SELECT thread_id, MIN(id) AS id
             FROM canon_thread_note
            WHERE project_id = ?
            GROUP BY thread_id
         ) first ON first.id = n.id
        WHERE n.project_id = ?`,
      projectId,
      projectId,
    );
    for (const row of rows) {
      firstNotes.set(row.thread_id, {
        quote: String(row.quote ?? ''),
        locator: String(row.locator ?? ''),
        strength: Number(row.strength) || 0,
      });
    }
  }

  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const nodes: WebGraphNode[] = selected.map((thread) => {
    const birth = birthByChild.get(thread.id);
    const kind: WebNodeKind = birth ? 'born' : thread.kind;
    const parentA = birth ? threadById.get(birth.parent_a_thread) : undefined;
    const parentB = birth ? threadById.get(birth.parent_b_thread) : undefined;
    const aName = kind === 'person' ? (thread.a_name ?? '') : kind === 'born'
      ? (parentA?.a_name ?? '')
      : (thread.a_name ?? '');
    const bName = kind === 'pair' ? (thread.b_name ?? '') : kind === 'born'
      ? (parentB?.a_name ?? '')
      : '';
    const label = kind === 'person'
      ? (thread.a_name || `person #${thread.id}`)
      : kind === 'pair'
        ? `${thread.a_name ?? '?'}–${thread.b_name ?? '?'}`
        : `child #${thread.id}`;
    return {
      id: `t:${thread.id}`,
      threadId: thread.id,
      kind,
      label,
      aName,
      bName,
      status: thread.status,
      period: thread.period_label || '',
      temporal: thread.temporal_status || 'unknown',
      periodFromSeq: thread.period_from_seq === null ? null : Number(thread.period_from_seq),
      notes: thread.notes,
      degree: 0,
      ...(opts.notes === true ? { firstNote: firstNotes.get(thread.id) ?? null } : {}),
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const links: WebGraphLink[] = [];
  const addLink = (link: WebGraphLink): void => {
    if (!nodeById.has(link.source) || !nodeById.has(link.target)) return;
    if (link.source === link.target) return;
    links.push(link);
  };
  for (const thread of selected) {
    const birth = birthByChild.get(thread.id);
    if (birth) {
      addLink({ source: `t:${birth.parent_a_thread}`, target: `t:${thread.id}`, kind: 'birth', weight: Number(birth.combined_score) || 1 });
      addLink({ source: `t:${birth.parent_b_thread}`, target: `t:${thread.id}`, kind: 'birth', weight: Number(birth.combined_score) || 1 });
    }
    if (thread.kind === 'pair') {
      const personThread = personThreadByEntity.get(thread.a_entity);
      if (personThread !== undefined) {
        addLink({ source: `t:${thread.id}`, target: `t:${personThread}`, kind: 'membership', weight: 1 });
      }
    }
  }
  for (const meeting of meetings) {
    addLink({
      source: `t:${meeting.thread_a}`,
      target: `t:${meeting.thread_b}`,
      kind: 'meeting',
      weight: Number(meeting.notes_exchanged) || 1,
    });
  }
  for (const link of links) {
    const source = nodeById.get(link.source)!;
    const target = nodeById.get(link.target)!;
    source.degree++;
    target.degree++;
  }

  const openEndRows = db.all<{ thread_id: number; n: number }>(
    "SELECT thread_id, COUNT(*) AS n FROM canon_open_end WHERE project_id = ? AND status = 'open' GROUP BY thread_id ORDER BY thread_id",
    projectId,
  );
  const openEnds = openEndRows
    .filter((row) => nodeById.has(`t:${row.thread_id}`))
    .map((row) => ({ threadId: row.thread_id, questionCount: Number(row.n) }));

  const latest = (sql: string): string =>
    String(db.get<{ ts: string | null }>(sql, projectId)?.ts ?? '');
  const updatedAt = [
    latest("SELECT MAX(COALESCE(updated_at, created_at)) AS ts FROM canon_thread WHERE project_id = ?"),
    latest('SELECT MAX(created_at) AS ts FROM canon_thread_note WHERE project_id = ?'),
    latest('SELECT MAX(COALESCE(updated_at, created_at)) AS ts FROM canon_meeting WHERE project_id = ?'),
    latest('SELECT MAX(created_at) AS ts FROM canon_birth WHERE project_id = ?'),
    latest('SELECT MAX(created_at) AS ts FROM canon_open_end WHERE project_id = ?'),
  ].filter(Boolean).sort().pop() ?? '';
  const countsHash = createHash('sha256').update(JSON.stringify(counts)).digest('hex').slice(0, 12);
  return {
    projectId,
    revision: `${updatedAt}:${countsHash}`,
    counts,
    nodes,
    links,
    openEnds,
    updatedAt,
  };
}

export interface WebThreadDetail {
  thread: {
    id: number;
    kind: 'person' | 'pair';
    label: string;
    aName: string;
    bName: string;
    status: string;
    period: string;
    temporal: string;
    birthReason: string;
    notes: number;
    createdAt: string;
    updatedAt: string;
  };
  notes: {
    id: number;
    quote: string;
    locator: string;
    claim: string;
    claimKind: string;
    strength: number;
    strengthSource: string;
    missing: string;
    isContext: boolean;
    createdAt: string;
  }[];
  openEnds: { id: number; question: string; wouldResolve: string; status: string }[];
  meetings: { id: number; otherThreadId: number; notesExchanged: number; status: string; revision: number }[];
}

export function webThreadDetail(db: Db, projectId: number, threadId: number): WebThreadDetail | null {
  const thread = db.get<{
    id: number;
    kind: 'person' | 'pair';
    a_name: string | null;
    b_name: string | null;
    status: string;
    period_label: string;
    temporal_status: string;
    birth_reason: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT t.id, t.kind, a.name AS a_name, b.name AS b_name, t.status, t.period_label,
            t.temporal_status, t.birth_reason, t.created_at, t.updated_at
       FROM canon_thread t
       LEFT JOIN canon_entity a ON a.id = t.a_entity
       LEFT JOIN canon_entity b ON b.id = t.b_entity
      WHERE t.project_id = ? AND t.id = ?`,
    projectId,
    threadId,
  );
  if (!thread) return null;
  const notes = db.all<{
    id: number;
    quote: string;
    locator: string;
    claim: string;
    claim_kind: string;
    strength: number;
    strength_source: string;
    missing: string;
    is_context: number;
    created_at: string;
  }>(
    `SELECT id, quote, locator, claim, claim_kind, strength, strength_source, missing, is_context, created_at
       FROM canon_thread_note WHERE project_id = ? AND thread_id = ? ORDER BY id`,
    projectId,
    threadId,
  );
  const openEnds = db.all<{ id: number; question: string; would_resolve: string; status: string }>(
    'SELECT id, question, would_resolve, status FROM canon_open_end WHERE project_id = ? AND thread_id = ? ORDER BY id',
    projectId,
    threadId,
  );
  const meetings = db.all<{ id: number; thread_a: number; thread_b: number; notes_exchanged: number; status: string; revision: number }>(
    `SELECT id, thread_a, thread_b, notes_exchanged, status, revision
       FROM canon_meeting WHERE project_id = ? AND (thread_a = ? OR thread_b = ?) ORDER BY id`,
    projectId,
    threadId,
    threadId,
  );
  return {
    thread: {
      id: thread.id,
      kind: thread.kind,
      label: thread.kind === 'person'
        ? (thread.a_name ?? `person #${thread.id}`)
        : `${thread.a_name ?? '?'}–${thread.b_name ?? '?'}`,
      aName: thread.a_name ?? '',
      bName: thread.b_name ?? '',
      status: thread.status,
      period: thread.period_label || '',
      temporal: thread.temporal_status || 'unknown',
      birthReason: thread.birth_reason || '',
      notes: notes.length,
      createdAt: thread.created_at,
      updatedAt: thread.updated_at,
    },
    notes: notes.map((note) => ({
      id: note.id,
      quote: note.quote,
      locator: note.locator,
      claim: note.claim,
      claimKind: note.claim_kind,
      strength: Number(note.strength) || 0,
      strengthSource: note.strength_source,
      missing: note.missing,
      isContext: Number(note.is_context) === 1,
      createdAt: note.created_at,
    })),
    openEnds: openEnds.map((row) => ({
      id: row.id,
      question: row.question,
      wouldResolve: row.would_resolve,
      status: row.status,
    })),
    meetings: meetings.map((row) => ({
      id: row.id,
      otherThreadId: row.thread_a === threadId ? row.thread_b : row.thread_a,
      notesExchanged: Number(row.notes_exchanged) || 0,
      status: row.status,
      revision: Number(row.revision) || 0,
    })),
  };
}
