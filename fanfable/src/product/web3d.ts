/**
 * Read-only evidence-web projection for the 3D view.
 *
 * Pure database reads: no writes, no model calls. The server serialises these
 * shapes; the client draws them.
 */
import { createHash } from 'node:crypto';
import { Db, fromJson } from '../core/db.ts';

export type WebNodeKind = 'person' | 'pair' | 'born';

export interface WebGraphNode {
  id: string;
  threadId: number;
  /** The person entity behind a person node; null for other node kinds. */
  entityId: number | null;
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
  a_kind: string | null;
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
      `SELECT COUNT(*) AS n
         FROM canon_thread t
         JOIN canon_entity e ON e.id = t.a_entity
        WHERE t.project_id = ? AND t.kind = 'person' AND e.kind = 'character'`, projectId)?.n ?? 0),
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
            a.name AS a_name, b.name AS b_name, a.kind AS a_kind,
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
    // A person thread is a view of a character, never of an item or a place.
    if (thread.kind === 'person' && thread.a_kind !== 'character') continue;
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
      entityId: thread.kind === 'person' ? thread.a_entity : null,
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

export interface WebPersonTie {
  relationId: number;
  direction: 'out' | 'in';
  counterpart: { id: number; name: string };
  kind: string;
  family: string;
  status: string;
  quote: string;
  anchor: string;
  locator: string;
  seq: number;
  description: string;
}

export interface WebPersonDossier {
  person: { id: number; name: string; aliases: string[]; kind: string };
  counts: { total: number; accepted: number; needsReview: number };
  groups: Array<{ family: string; ties: WebPersonTie[] }>;
  duplicates: Array<{ id: number; name: string; reason: string }>;
}

const FAMILY_ORDER = ['kin', 'friend', 'hostile', 'teach', 'trust', 'ally', 'colleague', 'other'];

const FAMILY_BY_KIND: Record<string, string> = {
  'brother of': 'kin',
  'sister of': 'kin',
  'sibling of': 'kin',
  'son of': 'kin',
  'child of': 'kin',
  'nephew of': 'kin',
  'cousin of': 'kin',
  'relative of': 'kin',
  'parent of': 'kin',
  'spouse of': 'kin',
  'friend of': 'friend',
  'acquaintance': 'friend',
  'peer': 'friend',
  'partner': 'friend',
  'enemy of': 'hostile',
  'rival of': 'hostile',
  'disliked': 'hostile',
  'feared': 'hostile',
  'jealous of': 'hostile',
  'student of': 'teach',
  'teacher of': 'teach',
  'mentor of': 'teach',
  'leader of': 'teach',
  'trusted': 'trust',
  'distrusted': 'trust',
  'ally of': 'ally',
  'colleague of': 'colleague',
};

export function relationFamily(kind: string): string {
  return FAMILY_BY_KIND[String(kind ?? '').trim().toLowerCase()] ?? 'other';
}

const GENERIC_NAME_TOKENS = new Set(['mr', 'mrs', 'miss', 'professor', 'uncle', 'aunt', 'lord', 'the']);

function stringList(value: string | null | undefined): string[] {
  const parsed: unknown = fromJson<unknown>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => String(entry ?? '').trim()).filter(Boolean);
}

interface NameForm {
  value: string;
  alias: boolean;
  /** Every useful token, used to decide which name is the shorter one. */
  raw: Set<string>;
  /** Tokens left after the generic-token and minimum-length filter. */
  tokens: Set<string>;
}

function nameForm(value: string, alias: boolean): NameForm {
  const raw = new Set<string>();
  const tokens = new Set<string>();
  for (const token of String(value ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (!token) continue;
    raw.add(token);
    if (token.length > 2 && !GENERIC_NAME_TOKENS.has(token)) tokens.add(token);
  }
  return { value: String(value ?? ''), alias, raw, tokens };
}

function nameForms(name: string, aliases: string[]): NameForm[] {
  const forms = [nameForm(name, false)];
  for (const alias of aliases) {
    const form = nameForm(alias, true);
    // A one-token alias is a surname or epithet ("Weasley", "Potter"),
    // never enough to identify the person by itself.
    if (form.raw.size >= 2) forms.push(form);
  }
  return forms.filter((form) => form.raw.size > 0);
}

/**
 * True when every token of `shorter` is present in `longer`, and `shorter`
 * carries fewer tokens. A generic token on the shorter side (for example the
 * "Mrs" in "Mrs. Potter") therefore blocks the match instead of being dropped.
 */
function isContained(shorter: NameForm, longer: NameForm): boolean {
  if (shorter.tokens.size === 0 || shorter.raw.size >= longer.raw.size) return false;
  for (const token of shorter.raw) if (!longer.raw.has(token)) return false;
  for (const token of shorter.tokens) if (!longer.tokens.has(token)) return false;
  return true;
}

function containmentReason(shorter: NameForm, longer: NameForm): string {
  if (longer.alias) {
    return shorter.alias
      ? `alias "${shorter.value}" contained in alias "${longer.value}"`
      : `shares the alias "${longer.value}"`;
  }
  return shorter.alias
    ? `alias "${shorter.value}" contained in "${longer.value}"`
    : `name contained in "${longer.value}"`;
}

function duplicateReason(ownForms: NameForm[], otherForms: NameForm[]): string | null {
  for (const own of ownForms) {
    for (const other of otherForms) {
      if (isContained(own, other)) return containmentReason(own, other);
      if (isContained(other, own)) return containmentReason(other, own);
    }
  }
  return null;
}

/** First numeric chunk id in a source_refs array. */
function citedChunkId(sourceRefs: string | null | undefined): number | null {
  const parsed: unknown = fromJson<unknown>(sourceRefs, []);
  if (!Array.isArray(parsed)) return null;
  for (const ref of parsed) {
    const n = Number((ref as { chunk?: unknown } | null)?.chunk);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export function webPersonDossier(db: Db, projectId: number, entityId: number): WebPersonDossier | null {
  const person = db.get<{ id: number; name: string; aliases: string; kind: string }>(
    'SELECT id, name, aliases, kind FROM canon_entity WHERE project_id = ? AND id = ?',
    projectId,
    entityId,
  );
  if (!person) return null;
  const aliases = stringList(person.aliases);

  const relationRows = db.all<{
    id: number;
    from_entity: number;
    to_entity: number;
    kind: string;
    description: string;
    evidence: string;
    anchor_evidence: string;
    source_refs: string;
    review_status: string;
    from_name: string | null;
    to_name: string | null;
  }>(
    `SELECT r.id, r.from_entity, r.to_entity, r.kind, r.description, r.evidence,
            r.anchor_evidence, r.source_refs, r.review_status,
            fa.name AS from_name, fb.name AS to_name
       FROM canon_relation r
       JOIN canon_entity fa ON fa.id = r.from_entity
       JOIN canon_entity fb ON fb.id = r.to_entity
      WHERE r.project_id = ? AND (r.from_entity = ? OR r.to_entity = ?)
      ORDER BY r.id`,
    projectId,
    entityId,
    entityId,
  );

  const chunkIds = [...new Set(relationRows
    .map((row) => citedChunkId(row.source_refs))
    .filter((id): id is number => id !== null))];
  const chunkById = new Map<number, { locator: string; seq: number }>();
  if (chunkIds.length) {
    const chunks = db.all<{ id: number; locator: string; seq: number }>(
      `SELECT id, locator, seq FROM canon_chunk
        WHERE project_id = ? AND id IN (${chunkIds.map(() => '?').join(', ')})`,
      projectId,
      ...chunkIds,
    );
    for (const chunk of chunks) {
      chunkById.set(Number(chunk.id), { locator: String(chunk.locator ?? ''), seq: Number(chunk.seq) });
    }
  }

  const ties: WebPersonTie[] = relationRows.map((row) => {
    const out = Number(row.from_entity) === entityId;
    const counterpartId = out ? Number(row.to_entity) : Number(row.from_entity);
    const kind = String(row.kind ?? '');
    const family = relationFamily(kind);
    const chunkId = citedChunkId(row.source_refs);
    const chunk = chunkId === null ? undefined : chunkById.get(chunkId);
    const seq = chunk ? Number(chunk.seq) : -1;
    return {
      relationId: Number(row.id),
      direction: out ? 'out' : 'in',
      counterpart: {
        id: counterpartId,
        name: String(out ? (row.to_name ?? '') : (row.from_name ?? '')),
      },
      kind,
      family,
      status: String(row.review_status ?? ''),
      quote: String(row.evidence ?? ''),
      anchor: String(row.anchor_evidence ?? ''),
      locator: chunk?.locator ?? '',
      seq: Number.isFinite(seq) ? seq : -1,
      description: String(row.description ?? ''),
    };
  });

  const grouped = new Map<string, WebPersonTie[]>();
  for (const tie of ties) {
    const bucket = grouped.get(tie.family);
    if (bucket) bucket.push(tie);
    else grouped.set(tie.family, [tie]);
  }
  const groups = FAMILY_ORDER
    .filter((family) => grouped.has(family))
    .map((family) => ({
      family,
      ties: grouped.get(family)!.sort((a, b) => a.seq - b.seq || a.relationId - b.relationId),
    }));

  const ownForms = nameForms(String(person.name ?? ''), aliases);
  const duplicates: Array<{ id: number; name: string; reason: string }> = [];
  if (ownForms.some((form) => form.tokens.size > 0)) {
    const others = db.all<{ id: number; name: string; aliases: string }>(
      'SELECT id, name, aliases FROM canon_entity WHERE project_id = ? AND id <> ? ORDER BY id',
      projectId,
      entityId,
    );
    for (const other of others) {
      const reason = duplicateReason(
        ownForms,
        nameForms(String(other.name ?? ''), stringList(other.aliases)),
      );
      if (reason) {
        duplicates.push({
          id: Number(other.id),
          name: String(other.name ?? ''),
          reason,
        });
      }
    }
  }

  return {
    person: { id: Number(person.id), name: String(person.name ?? ''), aliases, kind: String(person.kind ?? '') },
    counts: {
      total: ties.length,
      accepted: ties.filter((tie) => tie.status === 'accepted').length,
      needsReview: ties.filter((tie) => tie.status === 'needs_review').length,
    },
    groups,
    duplicates,
  };
}

export interface WebMapNode {
  id: number;
  name: string;
  kind: string;
  degree: number;
}

export interface WebMapEdge {
  id: number;
  from: number;
  to: number;
  kind: string;
  family: string;
  status: string;
  quote: string;
  locator: string;
}

export interface WebMap {
  nodes: WebMapNode[];
  edges: WebMapEdge[];
}

export interface WebMapOptions {
  /** Append character entities with no accepted/needs-review relation, degree 0. */
  includeIsolated?: boolean;
}

export function buildWebMap(db: Db, projectId: number, opts: WebMapOptions = {}): WebMap {
  const rows = db.all<{
    id: number;
    from_entity: number;
    to_entity: number;
    kind: string;
    evidence: string;
    source_refs: string;
    review_status: string;
    from_name: string;
    from_kind: string;
    to_name: string;
    to_kind: string;
  }>(
    `SELECT r.id, r.from_entity, r.to_entity, r.kind, r.evidence, r.source_refs, r.review_status,
            fa.name AS from_name, fa.kind AS from_kind,
            fb.name AS to_name, fb.kind AS to_kind
       FROM canon_relation r
       JOIN canon_entity fa ON fa.id = r.from_entity AND fa.project_id = r.project_id
       JOIN canon_entity fb ON fb.id = r.to_entity AND fb.project_id = r.project_id
      WHERE r.project_id = ? AND r.review_status IN ('accepted', 'needs_review')
      ORDER BY r.id`,
    projectId,
  );

  const chunkIds = [...new Set(rows
    .map((row) => citedChunkId(row.source_refs))
    .filter((id): id is number => id !== null))];
  const locatorByChunk = new Map<number, string>();
  if (chunkIds.length) {
    const chunks = db.all<{ id: number; locator: string }>(
      `SELECT id, locator FROM canon_chunk
        WHERE project_id = ? AND id IN (${chunkIds.map(() => '?').join(', ')})`,
      projectId,
      ...chunkIds,
    );
    for (const chunk of chunks) locatorByChunk.set(Number(chunk.id), String(chunk.locator ?? ''));
  }

  const edges: WebMapEdge[] = rows.map((row) => {
    const from = Number(row.from_entity);
    const to = Number(row.to_entity);
    const kind = String(row.kind ?? '');
    const chunkId = citedChunkId(row.source_refs);
    return {
      id: Number(row.id),
      from,
      to,
      kind,
      family: relationFamily(kind),
      status: String(row.review_status ?? ''),
      quote: String(row.evidence ?? ''),
      locator: chunkId === null ? '' : (locatorByChunk.get(chunkId) ?? ''),
    };
  });

  const nodeById = new Map<number, WebMapNode>();
  const ensureNode = (id: number, name: string, kind: string): WebMapNode => {
    let node = nodeById.get(id);
    if (!node) {
      node = { id, name: String(name ?? ''), kind: String(kind ?? ''), degree: 0 };
      nodeById.set(id, node);
    }
    return node;
  };
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const edge = edges[index]!;
    ensureNode(edge.from, row.from_name, row.from_kind).degree += 1;
    ensureNode(edge.to, row.to_name, row.to_kind).degree += 1;
  }

  if (opts.includeIsolated === true) {
    const entities = db.all<{ id: number; name: string; kind: string }>(
      "SELECT id, name, kind FROM canon_entity WHERE project_id = ? AND kind = 'character' ORDER BY id",
      projectId,
    );
    for (const entity of entities) {
      if (!nodeById.has(Number(entity.id))) {
        nodeById.set(Number(entity.id), {
          id: Number(entity.id),
          name: String(entity.name ?? ''),
          kind: String(entity.kind ?? ''),
          degree: 0,
        });
      }
    }
  }

  return {
    nodes: [...nodeById.values()].sort((a, b) => a.id - b.id),
    edges,
  };
}
