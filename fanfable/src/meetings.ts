/**
 * Meetings, scoped sharing and births — the second layer of the evidence web.
 *
 * Two threads meet when they share a subject. The match is deterministic and
 * structural: no fuzzy identity, no name-string comparison, and no merge. A
 * meeting exchanges only the notes relevant to that subject, resolves wants
 * immediately, records what remains, and may birth ONE child thread.
 *
 * Scoped sharing is the rule that keeps identity apart from relationship
 * evidence. A note's scope comes from its thread's kind: a person thread is
 * `identity`, a pair thread is `pair`. Identity notes may answer a want and
 * inform a meeting, but they never contribute to a birth's evidence score and
 * never become pair evidence. The scope is stored on every exchange row so a
 * consumer cannot lose the distinction later.
 *
 * Claim-meets-evidence is pair-scoped in this schema (a claim is about a pair,
 * evidence is about a pair), so it arrives here as a `shared_pair` meeting
 * rather than through a separate fuzzy matcher.
 *
 * Everything in this module is code-only: no model call, and nothing is
 * written to `canon_relation`, `canon_tie_note` or `canon_tie_hint`.
 */
import { Db, nowIso } from './db.ts';
import { projectMinConfidence } from './lorebook.ts';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';

export type MatchKind = 'shared_person' | 'shared_pair';
export type NoteScope = 'identity' | 'pair';
export type BirthTrigger = 'resolved_want' | 'pooled_evidence' | 'shared_event' | 'combined_investigation';
export type BirthSkip = 'one-per-meeting' | 'duplicate-lineage' | 'insufficient-both-sides' | 'below-threshold';

/** A subject key: `person:<id>` or `pair:<lo>:<hi>`. */
export interface SubjectKey {
  kind: 'person' | 'pair';
  a: number;
  b: number | null;
  key: string;
}

export function subjectKeyOf(kind: 'person' | 'pair', a: number, b: number | null): SubjectKey {
  if (kind === 'person') return { kind, a, b: null, key: `person:${a}` };
  const lo = Math.min(a, b ?? a);
  const hi = Math.max(a, b ?? a);
  return { kind: 'pair', a: lo, b: hi, key: `pair:${lo}:${hi}` };
}

export function parseSubjectKey(key: string): SubjectKey {
  const parts = key.split(':');
  if (parts[0] === 'person' && parts.length === 2) {
    const a = Number(parts[1]);
    return { kind: 'person', a, b: null, key };
  }
  if (parts[0] === 'pair' && parts.length === 3) {
    const a = Number(parts[1]);
    const b = Number(parts[2]);
    return { kind: 'pair', a, b, key };
  }
  throw new Error(`bad subject key "${key}"`);
}

interface ThreadSubjectRow {
  id: number;
  kind: 'person' | 'pair';
  subject: SubjectKey;
}

export interface CandidateMeeting {
  matchKey: string;
  matchKind: MatchKind;
  threadA: number;
  threadB: number;
}

/** Read every thread and its subject; the shared basis for matching and sharing. */
function loadSubjects(db: Db, projectId: number): ThreadSubjectRow[] {
  return db
    .all<{ id: number; kind: 'person' | 'pair'; a_entity: number; b_entity: number | null }>(
      'SELECT id, kind, a_entity, b_entity FROM canon_thread WHERE project_id = ? ORDER BY id',
      projectId,
    )
    .map((row) => ({ id: row.id, kind: row.kind, subject: subjectKeyOf(row.kind, row.a_entity, row.b_entity) }));
}

export interface Enumeration {
  candidates: CandidateMeeting[];
  /** Parent walks that hit the depth cap and were stopped. */
  groupsSkippedForDepth: number;
}

/** How far a parent chain may be walked before the branch is abandoned. */
export const MAX_ANCESTRY_DEPTH = 32;

interface ThreadNode {
  id: number;
  kind: 'person' | 'pair';
  subject: SubjectKey;
  periodLabel: string;
  parents: number[];
}

/** Every thread, its subject and its parentage, in id order. */
function loadThreadNodes(db: Db, projectId: number): ThreadNode[] {
  return db
    .all<{
      id: number;
      kind: 'person' | 'pair';
      a_entity: number;
      b_entity: number | null;
      period_label: string;
      parent_a_thread: number | null;
      parent_b_thread: number | null;
    }>(
      `SELECT id, kind, a_entity, b_entity, period_label, parent_a_thread, parent_b_thread
         FROM canon_thread WHERE project_id = ? AND status != 'dormant' ORDER BY id`,
      projectId,
    )
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      subject: subjectKeyOf(row.kind, row.a_entity, row.b_entity),
      periodLabel: row.period_label,
      parents: [row.parent_a_thread, row.parent_b_thread].filter(
        (parent): parent is number => parent !== null,
      ),
    }));
}

/**
 * Ancestor lookups with a depth cap.
 *
 * A born thread may itself be a parent, so walks are memoised. A chain longer
 * than the cap is abandoned and counted rather than followed: the mesh must
 * never be able to hang a command or throw on its own history.
 */
function makeAncestry(nodes: ThreadNode[]): {
  ancestorsOf: (id: number) => Set<number>;
  depthCuts: () => number;
} {
  const parentOf = new Map(nodes.map((node) => [node.id, node.parents]));
  const cache = new Map<number, Set<number>>();
  let cuts = 0;
  const ancestorsOf = (id: number): Set<number> => {
    const cached = cache.get(id);
    if (cached) return cached;
    const out = new Set<number>();
    let frontier = parentOf.get(id) ?? [];
    let depth = 0;
    while (frontier.length) {
      if (depth >= MAX_ANCESTRY_DEPTH) {
        cuts++;
        break;
      }
      const next: number[] = [];
      for (const parent of frontier) {
        if (out.has(parent)) continue;
        out.add(parent);
        for (const grandparent of parentOf.get(parent) ?? []) next.push(grandparent);
      }
      frontier = next;
      depth++;
    }
    cache.set(id, out);
    return out;
  };
  return { ancestorsOf, depthCuts: () => cuts };
}

/**
 * Every pair of threads that shares a subject, grouped once by subject.
 *
 * A person subject gathers that person's thread together with every pair
 * thread naming them, and two pair threads that share exactly one endpoint. A
 * pair subject gathers threads about the same unordered pair.
 *
 * Groups are built as sets in one pass, so a subject with many threads costs
 * one insertion each rather than a scan of the growing list. Parent/child
 * threads never meet: a birth is a record of the meeting, not another side of
 * it. Deterministic throughout: subjects in key order, threads in id order, and
 * every pair normalized so `threadA < threadB`.
 */
export function enumerateCandidates(db: Db, projectId: number): Enumeration {
  const nodes = loadThreadNodes(db, projectId);
  const subjectById = new Map(nodes.map((node) => [node.id, node.subject]));
  const { ancestorsOf, depthCuts } = makeAncestry(nodes);
  const byPerson = new Map<number, Set<number>>();
  const byPair = new Map<string, Set<number>>();

  const add = (map: Map<number | string, Set<number>>, key: number | string, id: number): void => {
    const set = map.get(key);
    if (set) set.add(id);
    else map.set(key, new Set([id]));
  };

  for (const node of nodes) {
    if (node.kind === 'person') {
      add(byPerson, node.subject.a, node.id);
    } else {
      add(byPair, node.subject.key, node.id);
      add(byPerson, node.subject.a, node.id);
      if (node.subject.b !== null) add(byPerson, node.subject.b, node.id);
    }
  }

  const seen = new Set<string>();
  const out: CandidateMeeting[] = [];
  const push = (matchKey: string, matchKind: MatchKind, x: number, y: number): void => {
    const a = Math.min(x, y);
    const b = Math.max(x, y);
    if (a === b) return;
    // A thread never meets its own ancestor or descendant.
    if (ancestorsOf(a).has(b) || ancestorsOf(b).has(a)) return;
    const id = `${matchKey}|${a}|${b}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ matchKey, matchKind, threadA: a, threadB: b });
  };

  // Same-pair meetings first: two threads about one unordered pair.
  for (const key of [...byPair.keys()].sort()) {
    const ids = [...byPair.get(key)!].sort((x, y) => x - y);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) push(key, 'shared_pair', ids[i]!, ids[j]!);
    }
  }

  // Person meetings: the person's own thread plus every pair thread naming
  // them, and pair threads that share exactly this endpoint.
  for (const entity of [...byPerson.keys()].sort((x, y) => x - y)) {
    const ids = [...byPerson.get(entity)!].sort((x, y) => x - y);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const x = ids[i]!;
        const y = ids[j]!;
        const sx = subjectById.get(x)!;
        const sy = subjectById.get(y)!;
        // Two threads about the very same pair belong to the pair subject.
        if (sx.key === sy.key) continue;
        push(`person:${entity}`, 'shared_person', x, y);
      }
    }
  }

  return {
    candidates: out.sort(
      (x, y) =>
        (x.matchKey < y.matchKey ? -1 : x.matchKey > y.matchKey ? 1 : 0) ||
        x.threadA - y.threadA ||
        x.threadB - y.threadB,
    ),
    groupsSkippedForDepth: depthCuts(),
  };
}

/** Every pair of threads that shares a subject. */
export function candidateMeetings(db: Db, projectId: number): CandidateMeeting[] {
  return enumerateCandidates(db, projectId).candidates;
}

/**
 * Is a note from a thread relevant to a meeting, and in which scope?
 *
 * Scope follows the thread's kind, never the note's wording. A person thread
 * supplies `identity` notes; a pair thread supplies `pair` notes.
 */
export function meetingRelevance(
  threadSubject: string,
  matchKey: string,
): { relevant: boolean; scope: NoteScope; relevance: string } {
  const thread = parseSubjectKey(threadSubject);
  const match = parseSubjectKey(matchKey);
  const scope: NoteScope = thread.kind === 'person' ? 'identity' : 'pair';
  let relevant = false;
  if (match.kind === 'pair') {
    relevant = thread.kind === 'pair' && thread.a === match.a && thread.b === match.b;
  } else if (thread.kind === 'person') {
    relevant = thread.a === match.a;
  } else {
    relevant = thread.a === match.a || thread.b === match.a;
  }
  return { relevant, scope, relevance: `subject ${matchKey}` };
}

/**
 * Combine independent support: `score = 1 − Π(1 − sᵢ)`.
 *
 * Independence rules, because same-scene repeats are not independent:
 * - notes citing the same chunk (`seq`) count once, at the highest strength;
 * - a note whose chunk is adjacent to another (`|Δseq| <= 1`) counts at half
 *   weight.
 * Duplicates therefore never inflate the score.
 */
export function combineSupport(notes: { strength: number; seq: number }[]): { score: number; independent: number } {
  const bySeq = new Map<number, number>();
  for (const note of notes) {
    const s = Math.min(1, Math.max(0, Number(note.strength) || 0));
    const prev = bySeq.get(note.seq);
    if (prev === undefined || s > prev) bySeq.set(note.seq, s);
  }
  const seqs = [...bySeq.keys()].sort((x, y) => x - y);
  if (!seqs.length) return { score: 0, independent: 0 };
  let product = 1;
  for (const seq of seqs) {
    const adjacent = seqs.some((other) => other !== seq && Math.abs(other - seq) <= 1);
    const weight = bySeq.get(seq)! * (adjacent ? 0.5 : 1);
    product *= 1 - weight;
  }
  return { score: 1 - product, independent: seqs.length };
}

const STOPWORDS = new Set([
  'the', 'and', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'or', 'but', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'that', 'this', 'these', 'those', 'it', 'its', 'his', 'her',
  'their', 'them', 'he', 'she', 'they', 'who', 'whom', 'what', 'which', 'from', 'as', 'not', 'no',
  'do', 'does', 'did', 'has', 'have', 'had', 'if', 'then', 'than', 'so', 'such', 'into', 'about',
  'over', 'after', 'before', 'between', 'both', 'each', 'any', 'all', 'more', 'most', 'some', 'one',
  'two', 'there', 'here', 'when', 'where', 'how', 'why', 'may', 'might', 'must', 'can', 'could',
]);

/** Lowercase, punctuation stripped, stopwords and very short tokens dropped. */
export function significantTokens(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

/** Tokens shared by a note's claim and an open end's "what would resolve it". */
export function matchedTokens(claim: string, wouldResolve: string): string[] {
  const a = new Set(significantTokens(claim));
  const b = new Set(significantTokens(wouldResolve));
  return [...a].filter((token) => b.has(token)).sort();
}

interface PlannedResolution {
  end: OpenEndRow;
  note: NoteRow;
  tokens: string[];
  kind: 'new' | 'improved';
  previousResolutionId?: number;
}

/**
 * Decide which wants the other side answers, without writing anything.
 *
 * Planning before writing is what lets the admission rule refuse a candidate
 * that crossed nothing: a refused meeting leaves no exchange and no
 * resolution behind.
 */
function planResolutions(
  db: Db,
  meetingId: number | null,
  threadA: number,
  threadB: number,
  openEndsByThread: Map<number, OpenEndRow[]>,
  notesByThread: Map<number, NoteRow[]>,
): PlannedResolution[] {
  const plans: PlannedResolution[] = [];
  const plan = (wanted: number, other: number): void => {
    for (const end of openEndsByThread.get(wanted) ?? []) {
      const options = (notesByThread.get(other) ?? [])
        .map((note) => ({ note, tokens: matchedTokens(note.claim, end.would_resolve) }))
        .filter((entry) => entry.tokens.length >= 2)
        .sort((x, y) => y.tokens.length - x.tokens.length || x.note.id - y.note.id);
      const best = options[0];
      if (!best) continue;
      if (meetingId === null) {
        if (end.status !== 'open') continue;
        plans.push({ end, note: best.note, tokens: best.tokens, kind: 'new' });
        continue;
      }
      const active = db.get<{ id: number; resolved_by_note_id: number; match_tokens: string }>(
        `SELECT id, resolved_by_note_id, match_tokens FROM canon_meeting_resolution
          WHERE meeting_id = ? AND open_end_id = ? AND superseded_by IS NULL
          ORDER BY id DESC LIMIT 1`,
        meetingId,
        end.id,
      );
      if (!active) {
        if (end.status !== 'open') continue; // resolved elsewhere: never claim it
        plans.push({ end, note: best.note, tokens: best.tokens, kind: 'new' });
        continue;
      }
      // A changed resolution: only when a new note matches more strongly.
      const previousTokens = active.match_tokens ? active.match_tokens.split(',').filter(Boolean).length : 0;
      if (active.resolved_by_note_id === best.note.id || best.tokens.length <= previousTokens) continue;
      plans.push({
        end,
        note: best.note,
        tokens: best.tokens,
        kind: 'improved',
        previousResolutionId: active.id,
      });
    }
  };
  plan(threadA, threadB);
  plan(threadB, threadA);
  return plans;
}

interface CombinedInput {
  matchKind: MatchKind;
  matchKey: string;
  threadA: number;
  threadB: number;
  periodOf: Map<number, string>;
  ancestorsOf: (id: number) => Set<number>;
  evidenceA: { note: NoteRow }[];
  evidenceB: { note: NoteRow }[];
  pairA: NoteRow[];
  pairB: NoteRow[];
}

/**
 * The fourth trigger: one pair, two periods, one investigation that spans them.
 *
 * This is the contract's "meaningful new combined investigative purpose". It
 * demands the same two-sided pair evidence as every other birth, and at least
 * two independent notes under the existing independence rule, so it never
 * manufactures a claim — it only recognises that the pair now needs a single
 * investigation rather than separate ones.
 */
function combinedInvestigation(input: CombinedInput): { reason: string } | null {
  if (input.matchKind !== 'shared_pair') return null;
  const left = parseSubjectKey(input.matchKey);
  if (left.kind !== 'pair') return null;
  const labelA = input.periodOf.get(input.threadA) ?? '';
  const labelB = input.periodOf.get(input.threadB) ?? '';
  if (labelA === labelB) return null;
  if (input.ancestorsOf(input.threadA).has(input.threadB)) return null;
  if (input.ancestorsOf(input.threadB).has(input.threadA)) return null;
  if (!input.evidenceA.length || !input.evidenceB.length) return null;
  const combined = combineSupport(
    [...input.pairA, ...input.pairB].map((note) => ({ strength: note.strength, seq: note.seq })),
  );
  if (combined.independent < 2) return null;
  const a = labelA === '' ? 'single stretch' : labelA;
  const b = labelB === '' ? 'single stretch' : labelB;
  return {
    reason: `two period investigations (${a} vs ${b}) with ${combined.independent} independent notes`,
  };
}

export interface RunMeetingsOptions {
  /** Override the project's `minConfidence` (tests and one-off commands). */
  minConfidence?: number;
  /**
   * Admit meetings whose only crossing is identity-scope sharing. Off by
   * default: identity information is not relationship evidence, so a meeting
   * between a person thread and a pair thread is normally not recorded.
   */
  includeIdentityOnly?: boolean;
  /** Override the per-run birth cap (tests only; the default is the ceiling). */
  maxBirthsPerRun?: number;
}

/** Why a candidate meeting was not recorded at all. */
export type RefusalReason = 'no-crossing-notes' | 'one-sided' | 'identity-only';

export interface RunMeetingsResult {
  /** Thread pairs that shared a subject and were examined. */
  candidatesExamined: number;
  /** Same count under its spec name; kept alongside for clarity. */
  candidatesConsidered: number;
  /** Time spent building the candidate list. */
  enumerationMs: number;
  /** Parent walks abandoned at the depth cap. */
  groupsSkippedForDepth: number;
  meetingsCreated: number;
  meetingsReused: number;
  /** Candidates that crossed nothing and left no rows. */
  meetingsRefused: number;
  refusedByReason: Record<RefusalReason, number>;
  exchangesAdded: number;
  wantsResolved: number;
  birthsCreated: number;
  /** Births a trigger wanted but the per-run cap held back. */
  birthsDeferred: number;
  /** Contributions attached to an existing born thread instead of a new birth. */
  birthsEnriched: number;
  /** Triggers refused because the child would duplicate a parent. */
  birthsRefused: Record<'child-equals-parent', number>;
  birthsByTrigger: Record<BirthTrigger, number>;
  birthsSkipped: Record<BirthSkip, number>;
}

/** Births one run may create, so a crowded bank cannot stall a command. */
export const MAX_BIRTHS_PER_RUN = 500;

interface NoteRow {
  id: number;
  thread_id: number;
  chunk_id: number | null;
  claim: string;
  strength: number;
  seq: number;
  is_context: number;
}

interface OpenEndRow {
  id: number;
  thread_id: number;
  question: string;
  origin: string;
  would_resolve: string;
  status: 'open' | 'resolved' | 'abandoned';
  resolved_by_note_id: number | null;
  resolved_at: string | null;
}

interface MeetingRow {
  id: number;
  project_id: number;
  thread_a: number;
  thread_b: number;
  match_key: string;
  match_kind: MatchKind;
  revision: number;
  notes_exchanged: number;
  wants_resolved: number;
  child_thread: number | null;
  remaining: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function loadMeetingRow(db: Db, projectId: number, id: number): MeetingRow | undefined {
  return db.get<MeetingRow>('SELECT * FROM canon_meeting WHERE id = ? AND project_id = ?', id, projectId);
}

/**
 * Run every candidate meeting: exchange relevant notes, resolve wants, and
 * birth at most one child per meeting.
 *
 * Idempotent: the same threads with the same notes create no second meeting,
 * no duplicate exchange rows and no second child, and `revision` does not
 * move. New evidence appends exchanges and bumps `revision` once per run.
 * A meeting row is recorded only when it has something to record — at least
 * one exchanged note — because a meeting is defined by what was exchanged.
 */
export function runMeetings(db: Db, projectId: number, opts: RunMeetingsOptions = {}): RunMeetingsResult {
  const at = nowIso();
  const threshold = opts.minConfidence ?? projectMinConfidence(db, projectId);
  const result: RunMeetingsResult = {
    candidatesExamined: 0,
    candidatesConsidered: 0,
    enumerationMs: 0,
    groupsSkippedForDepth: 0,
    meetingsCreated: 0,
    meetingsReused: 0,
    meetingsRefused: 0,
    refusedByReason: { 'no-crossing-notes': 0, 'one-sided': 0, 'identity-only': 0 },
    exchangesAdded: 0,
    wantsResolved: 0,
    birthsCreated: 0,
    birthsDeferred: 0,
    birthsEnriched: 0,
    birthsRefused: { 'child-equals-parent': 0 },
    birthsByTrigger: {
      resolved_want: 0,
      pooled_evidence: 0,
      shared_event: 0,
      combined_investigation: 0,
    },
    birthsSkipped: {
      'one-per-meeting': 0,
      'duplicate-lineage': 0,
      'insufficient-both-sides': 0,
      'below-threshold': 0,
    },
  };
  const includeIdentityOnly = opts.includeIdentityOnly === true;
  const maxBirthsPerRun = opts.maxBirthsPerRun ?? MAX_BIRTHS_PER_RUN;

  const nodes = loadThreadNodes(db, projectId);
  const subjectOf = new Map(nodes.map((node) => [node.id, node.subject]));
  const periodOf = new Map(nodes.map((node) => [node.id, node.periodLabel]));
  const { ancestorsOf } = makeAncestry(nodes);
  const notesByThread = new Map<number, NoteRow[]>();
  for (const note of db.all<NoteRow>(
    `SELECT n.id, n.thread_id, n.chunk_id, n.claim, n.strength, n.is_context, COALESCE(c.seq, 0) AS seq
       FROM canon_thread_note n
       LEFT JOIN canon_chunk c ON c.id = n.chunk_id
      WHERE n.project_id = ?
      ORDER BY n.id`,
    projectId,
  )) {
    const list = notesByThread.get(note.thread_id) ?? [];
    list.push(note);
    notesByThread.set(note.thread_id, list);
  }
  const openEndsByThread = new Map<number, OpenEndRow[]>();
  for (const end of db.all<OpenEndRow>(
    'SELECT id, thread_id, question, origin, would_resolve, status, resolved_by_note_id, resolved_at FROM canon_open_end WHERE project_id = ? ORDER BY id',
    projectId,
  )) {
    const list = openEndsByThread.get(end.thread_id) ?? [];
    list.push(end);
    openEndsByThread.set(end.thread_id, list);
  }
  // Event ids cited by each thread through its notes' chunks.
  const eventsByThread = new Map<number, Set<number>>();
  for (const row of db.all<{ thread_id: number; event_id: number }>(
    `SELECT DISTINCT n.thread_id AS thread_id, e.id AS event_id
       FROM canon_thread_note n
       JOIN canon_event e ON e.chunk_id = n.chunk_id AND e.project_id = n.project_id
      WHERE n.project_id = ?`,
    projectId,
  )) {
    const set = eventsByThread.get(row.thread_id) ?? new Set<number>();
    set.add(row.event_id);
    eventsByThread.set(row.thread_id, set);
  }

  const existing = new Map<string, MeetingRow>();
  for (const row of db.all<MeetingRow>('SELECT * FROM canon_meeting WHERE project_id = ?', projectId)) {
    existing.set(`${row.thread_a}|${row.thread_b}|${row.match_key}`, row);
  }
  const lineageTaken = new Set(
    db
      .all<{ parent_a_thread: number; parent_b_thread: number; trigger: string }>(
        'SELECT parent_a_thread, parent_b_thread, trigger FROM canon_birth WHERE project_id = ?',
        projectId,
      )
      .map((row) => `${row.parent_a_thread}|${row.parent_b_thread}|${row.trigger}`),
  );

  const enumerationStarted = Date.now();
  const enumeration = enumerateCandidates(db, projectId);
  result.enumerationMs = Date.now() - enumerationStarted;
  const candidates = enumeration.candidates;
  result.candidatesExamined = candidates.length;
  result.candidatesConsidered = candidates.length;
  result.groupsSkippedForDepth = enumeration.groupsSkippedForDepth;

  db.transaction(() => {
    for (const candidate of candidates) {
      const { threadA, threadB, matchKey, matchKind } = candidate;
      const notesA = notesByThread.get(threadA) ?? [];
      const notesB = notesByThread.get(threadB) ?? [];

      // Everything shareable, collected before a single row is written.
      const shareable: { note: NoteRow; thread: number; scope: NoteScope; direction: 'a_to_b' | 'b_to_a' }[] = [];
      const collect = (notes: NoteRow[], thread: number, direction: 'a_to_b' | 'b_to_a'): void => {
        if (!notes.length) return;
        const rel = meetingRelevance(subjectOf.get(thread)!.key, matchKey);
        if (!rel.relevant) return;
        for (const note of notes) shareable.push({ note, thread, scope: rel.scope, direction });
      };
      collect(notesA, threadA, 'a_to_b');
      collect(notesB, threadB, 'b_to_a');
      if (!shareable.length) {
        result.meetingsRefused++;
        result.refusedByReason['no-crossing-notes']++;
        continue;
      }

      const evidenceA = shareable.filter(
        (entry) => entry.thread === threadA && entry.scope === 'pair' && entry.note.is_context !== 1,
      );
      const evidenceB = shareable.filter(
        (entry) => entry.thread === threadB && entry.scope === 'pair' && entry.note.is_context !== 1,
      );
      const sideA = shareable.some((entry) => entry.thread === threadA);
      const sideB = shareable.some((entry) => entry.thread === threadB);

      const key = `${threadA}|${threadB}|${matchKey}`;
      let meeting = existing.get(key);
      let created = false;

      // A want answered from the other side is a crossing too, so it admits.
      const plans = planResolutions(db, meeting?.id ?? null, threadA, threadB, openEndsByThread, notesByThread);
      const crossing = evidenceA.length > 0 && evidenceB.length > 0;
      let admitted = crossing || plans.length > 0;
      if (!admitted && includeIdentityOnly) admitted = sideA && sideB;

      if (!admitted) {
        result.meetingsRefused++;
        const reason: RefusalReason =
          !sideA || !sideB
            ? sideA || sideB
              ? 'one-sided'
              : 'no-crossing-notes'
            : evidenceA.length || evidenceB.length
              ? 'one-sided'
              : 'identity-only';
        result.refusedByReason[reason]++;
        continue;
      }

      if (!meeting) {
        const id = Number(
          db.run(
            `INSERT INTO canon_meeting
               (project_id, thread_a, thread_b, match_key, match_kind, revision, notes_exchanged,
                wants_resolved, remaining, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 0, 0, 0, '', 'open', ?, ?)`,
            projectId,
            threadA,
            threadB,
            matchKey,
            matchKind,
            at,
            at,
          ).lastInsertRowid,
        );
        meeting = loadMeetingRow(db, projectId, id)!;
        existing.set(key, meeting);
        created = true;
      }

      let added = 0;
      const exchanged: { note: NoteRow; thread: number; scope: NoteScope }[] = [];
      const hasExchange = (noteId: number): boolean =>
        db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM canon_meeting_exchange WHERE meeting_id = ? AND note_id = ?',
          meeting!.id,
          noteId,
        )!.n > 0;
      for (const entry of shareable) {
        exchanged.push({ note: entry.note, thread: entry.thread, scope: entry.scope });
        if (hasExchange(entry.note.id)) continue;
        db.run(
          `INSERT INTO canon_meeting_exchange (meeting_id, note_id, direction, scope, relevance, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          meeting.id,
          entry.note.id,
          entry.direction,
          entry.scope,
          `subject ${matchKey}`,
          at,
        );
        added++;
      }

      // ---- wants answered on the spot
      let resolvedNow = 0;
      for (const plan of plans) {
        if (plan.kind === 'new') {
          db.run(
            `INSERT INTO canon_meeting_resolution
               (meeting_id, open_end_id, resolved_by_note_id, match_tokens, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            meeting.id,
            plan.end.id,
            plan.note.id,
            plan.tokens.join(','),
            at,
          );
          db.run(
            `UPDATE canon_open_end SET status = 'resolved', resolved_by_note_id = ?, resolved_at = ?
              WHERE id = ? AND status = 'open'`,
            plan.note.id,
            at,
            plan.end.id,
          );
        } else {
          const newId = Number(
            db.run(
              `INSERT INTO canon_meeting_resolution
                 (meeting_id, open_end_id, resolved_by_note_id, match_tokens, created_at)
               VALUES (?, ?, ?, ?, ?)`,
              meeting.id,
              plan.end.id,
              plan.note.id,
              plan.tokens.join(','),
              at,
            ).lastInsertRowid,
          );
          db.run('UPDATE canon_meeting_resolution SET superseded_by = ? WHERE id = ?', newId, plan.previousResolutionId);
          db.run(
            'UPDATE canon_open_end SET resolved_by_note_id = ?, resolved_at = ? WHERE id = ?',
            plan.note.id,
            at,
            plan.end.id,
          );
        }
        resolvedNow++;
      }

      const activeResolutions = db.all<{ resolved_by_note_id: number }>(
        `SELECT r.resolved_by_note_id AS resolved_by_note_id
           FROM canon_meeting_resolution r
          WHERE r.meeting_id = ? AND r.superseded_by IS NULL`,
        meeting.id,
      ).length;

      if (created) result.meetingsCreated++;
      else result.meetingsReused++;
      result.exchangesAdded += added;
      result.wantsResolved += resolvedNow;

      // ---- birth evaluation (at most one child per meeting)
      // Context notes are co-presence only: they are shared and may answer a
      // want, but they are never relationship evidence and never raise a score.
      const pairExchanged = exchanged.filter((entry) => entry.scope === 'pair' && entry.note.is_context !== 1);
      const pairA = pairExchanged.filter((entry) => entry.thread === threadA).map((entry) => entry.note);
      const pairB = pairExchanged.filter((entry) => entry.thread === threadB).map((entry) => entry.note);

      let trigger: BirthTrigger | null = null;
      let score = 0;
      let reason = '';
      let skip: BirthSkip | null = null;

      // 1. A want answered by pair-scope evidence is a new knowledge state.
      const pairResolved = db
        .all<{ note_id: number; scope: string }>(
          `SELECT r.resolved_by_note_id AS note_id, x.scope AS scope
             FROM canon_meeting_resolution r
             JOIN canon_meeting_exchange x ON x.meeting_id = r.meeting_id AND x.note_id = r.resolved_by_note_id
             JOIN canon_thread_note n ON n.id = r.resolved_by_note_id
            WHERE r.meeting_id = ? AND r.superseded_by IS NULL AND n.is_context = 0`,
          meeting.id,
        )
        .filter((row) => row.scope === 'pair');
      if (pairResolved.length) {
        trigger = 'resolved_want';
        reason = `resolved want with pair evidence (note ${pairResolved[0]!.note_id})`;
      } else if (pairA.length || pairB.length) {
        if (!pairA.length || !pairB.length) {
          skip = 'insufficient-both-sides';
        } else {
          const each = combineSupport(pairA.map((n) => ({ strength: n.strength, seq: n.seq })));
          const other = combineSupport(pairB.map((n) => ({ strength: n.strength, seq: n.seq })));
          const both = combineSupport(
            [...pairA, ...pairB].map((n) => ({ strength: n.strength, seq: n.seq })),
          );
          // 2. Combined support clears the bar while each parent alone does not.
          if (each.score < threshold && other.score < threshold && both.score >= threshold) {
            trigger = 'pooled_evidence';
            score = both.score;
            reason = `pooled pair support ${both.score.toFixed(3)} from ${both.independent} independent passages (each side below ${threshold})`;
          } else if (both.score < threshold) {
            skip = 'below-threshold';
          }
        }
      }

      // 3. Both parents independently cite the same event through their notes.
      // Evaluated even when pooled evidence fell short: the triggers are
      // alternatives, not a chain of prerequisites.
      if (!trigger) {
        const eventsA = eventsByThread.get(threadA) ?? new Set<number>();
        const eventsB = eventsByThread.get(threadB) ?? new Set<number>();
        const shared = [...eventsA].filter((id) => eventsB.has(id)).sort((x, y) => x - y);
        if (shared.length) {
          trigger = 'shared_event';
          skip = null;
          reason = `both parents cite event ${shared[0]}`;
        }
      }

      // 4. Two period investigations of one pair need one investigation that
      // spans the whole book. This is a new combined purpose, not a threshold
      // crossing, so it does not touch the evidence maths.
      if (!trigger) {
        const combined = combinedInvestigation({
          matchKind,
          matchKey,
          threadA,
          threadB,
          periodOf,
          ancestorsOf,
          evidenceA,
          evidenceB,
          pairA,
          pairB,
        });
        if (combined) {
          trigger = 'combined_investigation';
          skip = null;
          reason = combined.reason;
        }
      }

      if (trigger) {
        // A birth takes its subject from the evidence that was pooled, never
        // from the meeting that happened to hold the conversation.
        const contributions = new Map<string, number>();
        for (const entry of pairExchanged) {
          const subject = subjectOf.get(entry.thread);
          if (subject && subject.kind === 'pair') {
            contributions.set(subject.key, (contributions.get(subject.key) ?? 0) + 1);
          }
        }
        const rank = (a: [string, number], b: [string, number]): number => {
          if (b[1] !== a[1]) return b[1] - a[1];
          const ka = parseSubjectKey(a[0]);
          const kb = parseSubjectKey(b[0]);
          return ka.a - kb.a || (ka.b ?? 0) - (kb.b ?? 0);
        };
        const best = [...contributions.entries()].sort(rank)[0];
        const child = best
          ? (() => {
              const parsed = parseSubjectKey(best[0]);
              return {
                kind: 'pair' as const,
                key: best[0],
                a: parsed.a,
                b: parsed.b,
                source: 'evidence-pair' as const,
                notes: best[1],
              };
            })()
          : (() => {
              const subject = subjectOf.get(threadA)!;
              const person = subject.kind === 'person' ? subject.a : subject.a;
              return {
                kind: 'person' as const,
                key: `person:${person}`,
                a: person,
                b: null,
                source: 'meeting-person' as const,
                notes: 0,
              };
            })();

        const sameAs = (parent: number): boolean => {
          const subject = subjectOf.get(parent)!;
          // A combined child is a NEW investigation of the same pair: it is
          // distinguished by spanning the periods, so the period label is part
          // of the investigation's identity here. Without that, every combined
          // birth would be refused as a copy of its own parent.
          const childLabel = trigger === 'combined_investigation' ? 'combined' : '';
          const parentLabel = periodOf.get(parent) ?? '';
          return (
            subject.kind === child.kind &&
            subject.a === child.a &&
            (subject.b ?? null) === child.b &&
            parentLabel === childLabel
          );
        };

        if (meeting.child_thread) {
          result.birthsSkipped['one-per-meeting']++;
        } else if (existingBornThread(db, projectId, child) !== null) {
          // The subject already has a born investigation: attach the new pooled
          // evidence instead of creating a sibling. This is not a second birth.
          const existing = existingBornThread(db, projectId, child)!;
          enrichBirth(db, projectId, existing, meeting, pairExchanged, at);
          meeting.child_thread = existing;
          result.birthsEnriched++;
        } else if (sameAs(threadA) || sameAs(threadB)) {
          result.birthsRefused['child-equals-parent']++;
        } else if (lineageTaken.has(`${threadA}|${threadB}|${trigger}`)) {
          result.birthsSkipped['duplicate-lineage']++;
        } else if (result.birthsCreated + result.birthsEnriched >= maxBirthsPerRun) {
          // The cap binds: keep evaluating, create nothing more, say so.
          result.birthsDeferred++;
        } else {
          const childId = createBirth(
            db,
            projectId,
            meeting,
            child,
            trigger,
            score,
            reason,
            pairExchanged,
            at,
            trigger === 'combined_investigation' ? { label: 'combined', status: 'current' } : undefined,
          );
          meeting.child_thread = childId;
          lineageTaken.add(`${threadA}|${threadB}|${trigger}`);
          result.birthsCreated++;
          result.birthsByTrigger[trigger]++;
        }
      } else if (skip) {
        result.birthsSkipped[skip]++;
      }

      // ---- record what remains and settle the counters
      const openWants = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM canon_open_end o
          JOIN canon_thread t ON t.id = o.thread_id
         WHERE t.project_id = ? AND o.status = 'open' AND o.thread_id IN (?, ?)`,
        projectId,
        threadA,
        threadB,
      )!.n;
      const remaining = `open ends ${openWants}; pair notes ${pairExchanged.length}; identity notes ${exchanged.length - pairExchanged.length}`;
      const revision = meeting.revision + (added > 0 || resolvedNow > 0 ? 1 : 0);
      db.run(
        `UPDATE canon_meeting
            SET revision = ?, notes_exchanged = ?, wants_resolved = ?, remaining = ?,
                child_thread = ?, updated_at = ?
          WHERE id = ?`,
        revision,
        db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_meeting_exchange WHERE meeting_id = ?', meeting.id)!.n,
        activeResolutions,
        remaining,
        meeting.child_thread,
        at,
        meeting.id,
      );
      meeting.revision = revision;
    }
  });

  return result;
}

/**
 * Create the child thread, record the birth, reference the pooled notes and
 * carry both parents' wants.
 *
 * The child is a NEW thread with parents recorded; no entity is merged and no
 * relation is written. Pooled notes are referenced, never copied.
 */
export interface ChildSubject {
  kind: 'pair' | 'person';
  key: string;
  a: number;
  b: number | null;
  source: 'evidence-pair' | 'meeting-person';
  notes: number;
}

/** The born thread already covering this subject, if any. */
function existingBornThread(db: Db, projectId: number, child: ChildSubject): number | null {
  const row = db.get<{ id: number }>(
    `SELECT id FROM canon_thread
      WHERE project_id = ? AND kind = ? AND a_entity = ? AND COALESCE(b_entity, 0) = ?
        AND parent_a_thread IS NOT NULL AND status != 'dormant'
      ORDER BY id LIMIT 1`,
    projectId,
    child.kind,
    child.a,
    child.b ?? 0,
  );
  return row?.id ?? null;
}

/** Carry a parent's wants onto the child, skipping ones already carried. */
function carryWants(
  db: Db,
  projectId: number,
  childId: number,
  meeting: MeetingRow,
  at: string,
  unresolvedOnly = false,
): void {
  const already = new Set(
    db
      .all<{ carried_from_open_end_id: number | null }>(
        'SELECT carried_from_open_end_id FROM canon_open_end WHERE thread_id = ? AND carried_from_open_end_id IS NOT NULL',
        childId,
      )
      .map((row) => row.carried_from_open_end_id!),
  );
  for (const parent of [meeting.thread_a, meeting.thread_b]) {
    for (const end of db.all<OpenEndRow>(
      'SELECT id, thread_id, question, origin, would_resolve, status, resolved_by_note_id, resolved_at FROM canon_open_end WHERE thread_id = ? ORDER BY id',
      parent,
    )) {
      if (already.has(end.id)) continue;
      if (unresolvedOnly && end.status === 'resolved') continue;
      if (end.status === 'resolved') {
        db.run(
          `INSERT INTO canon_open_end
             (project_id, thread_id, question, origin, would_resolve, status,
              resolved_by_note_id, resolved_at, carried_from_open_end_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'resolved', ?, ?, ?, ?)`,
          projectId,
          childId,
          end.question,
          end.origin,
          end.would_resolve,
          end.resolved_by_note_id,
          end.resolved_at,
          end.id,
          at,
        );
      } else {
        db.run(
          `INSERT INTO canon_open_end
             (project_id, thread_id, question, origin, would_resolve, status,
              resolved_by_note_id, resolved_at, carried_from_open_end_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          projectId,
          childId,
          end.question,
          end.origin,
          end.would_resolve,
          end.status === 'abandoned' ? 'abandoned' : 'open',
          end.resolved_by_note_id,
          end.resolved_at,
          end.id,
          at,
        );
      }
      already.add(end.id);
    }
  }
}

/**
 * Attach new pooled evidence to an existing born thread.
 *
 * A birth row means "this subject was born once". A second meeting that pools
 * more evidence for the same subject enriches that thread — references only,
 * never a copy, never a second birth.
 */
function enrichBirth(
  db: Db,
  projectId: number,
  childId: number,
  meeting: MeetingRow,
  pooled: { note: NoteRow; thread: number; scope: NoteScope }[],
  at: string,
): void {
  for (const entry of pooled) {
    db.run(
      `INSERT OR IGNORE INTO canon_thread_note_ref (thread_id, note_id, role, created_at)
       VALUES (?, ?, 'pooled', ?)`,
      childId,
      entry.note.id,
      at,
    );
  }
  carryWants(db, projectId, childId, meeting, at, true);
}

function createBirth(
  db: Db,
  projectId: number,
  meeting: MeetingRow,
  child: ChildSubject,
  trigger: BirthTrigger,
  score: number,
  reason: string,
  pooled: { note: NoteRow; thread: number; scope: NoteScope }[],
  at: string,
  childPeriod?: { label: string; status: 'current' | 'historical' | 'unknown' | 'uncertain' },
): number {
  const birthReason = [
    `trigger=${trigger}`,
    `subject-source=${child.source}`,
    `subject=${child.key}`,
    `notes=${child.notes}`,
    score > 0 ? `score=${score.toFixed(3)}` : '',
    reason,
  ]
    .filter(Boolean)
    .join('; ');
  const childId = Number(
    db.run(
      `INSERT INTO canon_thread
         (project_id, kind, a_entity, b_entity, pair_thread_id, status, parent_a_thread, parent_b_thread,
          birth_reason, period_label, period_from_seq, period_to_seq, temporal_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      child.kind,
      child.a,
      child.b,
      meeting.thread_a,
      meeting.thread_b,
      birthReason,
      childPeriod?.label ?? '',
      null,
      null,
      childPeriod?.status ?? 'unknown',
      at,
      at,
    ).lastInsertRowid,
  );

  // Pooled evidence is referenced, never duplicated. Identity notes are
  // excluded by construction: only pair-scope exchanges reach this list.
  for (const entry of pooled) {
    db.run(
      `INSERT OR IGNORE INTO canon_thread_note_ref (thread_id, note_id, role, created_at)
       VALUES (?, ?, 'pooled', ?)`,
      childId,
      entry.note.id,
      at,
    );
  }

  carryWants(db, projectId, childId, meeting, at);

  db.run(
    `INSERT INTO canon_birth
       (project_id, meeting_id, parent_a_thread, parent_b_thread, child_thread, trigger,
        combined_score, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    projectId,
    meeting.id,
    meeting.thread_a,
    meeting.thread_b,
    childId,
    trigger,
    score,
    reason,
    at,
  );
  return childId;
}

export interface MeetingExchange {
  noteId: number;
  threadId: number;
  direction: 'a_to_b' | 'b_to_a';
  scope: NoteScope;
  relevance: string;
  createdAt: string;
}

export interface MeetingResolution {
  id: number;
  openEndId: number;
  resolvedByNoteId: number;
  matchTokens: string;
  supersededBy: number | null;
  createdAt: string;
}

export interface LoadedMeeting {
  meeting: MeetingRow;
  exchanges: MeetingExchange[];
  resolutions: MeetingResolution[];
  child: { threadId: number; trigger: BirthTrigger; combinedScore: number; reason: string } | null;
}

/** One meeting with its scope-marked exchanges, every resolution, and its child. */
export function loadMeeting(db: Db, projectId: number, id: number): LoadedMeeting | null {
  const meeting = loadMeetingRow(db, projectId, id);
  if (!meeting) return null;
  const exchanges = db
    .all<{
      note_id: number;
      thread_id: number;
      direction: 'a_to_b' | 'b_to_a';
      scope: NoteScope;
      relevance: string;
      created_at: string;
    }>(
      `SELECT x.note_id, n.thread_id, x.direction, x.scope, x.relevance, x.created_at
         FROM canon_meeting_exchange x
         JOIN canon_thread_note n ON n.id = x.note_id
        WHERE x.meeting_id = ?
        ORDER BY x.note_id`,
      id,
    )
    .map((row) => ({
      noteId: row.note_id,
      threadId: row.thread_id,
      direction: row.direction,
      scope: row.scope,
      relevance: row.relevance,
      createdAt: row.created_at,
    }));
  const resolutions = db
    .all<{
      id: number;
      open_end_id: number;
      resolved_by_note_id: number;
      match_tokens: string;
      superseded_by: number | null;
      created_at: string;
    }>('SELECT * FROM canon_meeting_resolution WHERE meeting_id = ? ORDER BY id', id)
    .map((row) => ({
      id: row.id,
      openEndId: row.open_end_id,
      resolvedByNoteId: row.resolved_by_note_id,
      matchTokens: row.match_tokens,
      supersededBy: row.superseded_by,
      createdAt: row.created_at,
    }));
  const birth = db.get<{ child_thread: number; trigger: BirthTrigger; combined_score: number; reason: string }>(
    'SELECT child_thread, trigger, combined_score, reason FROM canon_birth WHERE meeting_id = ?',
    id,
  );
  return {
    meeting,
    exchanges,
    resolutions,
    child: birth
      ? {
          threadId: birth.child_thread,
          trigger: birth.trigger,
          combinedScore: birth.combined_score,
          reason: birth.reason,
        }
      : null,
  };
}

export interface ListMeetingsOptions {
  status?: 'open' | 'resolved' | 'dormant';
  limit?: number;
}

/** Newest first; a meeting is a record of something that already happened. */
export function listMeetings(db: Db, projectId: number, opts: ListMeetingsOptions = {}): MeetingRow[] {
  const where = opts.status ? 'AND status = ?' : '';
  const params: unknown[] = opts.status ? [opts.status] : [];
  return db.all<MeetingRow>(
    `SELECT * FROM canon_meeting
      WHERE project_id = ? ${where}
      ORDER BY created_at DESC, id DESC
      ${opts.limit && opts.limit > 0 ? 'LIMIT ?' : ''}`,
    projectId,
    ...params,
    ...(opts.limit && opts.limit > 0 ? [opts.limit] : []),
  );
}

/* ------------------------------------------------------- reconciliation */

/**
 * Is this database a disposable copy under the OS temp directory?
 *
 * Reconciliation deletes meeting rows, so it is only ever allowed on a copy.
 * Windows short names (OMENGA~1) are expanded through directory listings so two
 * spellings of one location compare equal; anything unresolved fails closed.
 */
export function isTempDatabasePath(path: string): boolean {
  if (!path || path === ':memory:') return false;
  const expand = (full: string): string => {
    const parts = full.split(sep);
    let out = parts[0] ?? '';
    for (let i = 1; i < parts.length; i++) {
      const segment = parts[i]!;
      let use = segment;
      if (segment.includes('~')) {
        try {
          const stem = segment.split('~')[0]!.replace(/[^a-z0-9]/gi, '').toUpperCase();
          const matches = readdirSync(out || sep).filter(
            (entry) => entry.replace(/[^a-z0-9]/gi, '').toUpperCase().startsWith(stem),
          );
          if (stem && matches.length === 1) use = matches[0]!;
        } catch {
          /* leave as-is */
        }
      }
      out = out.endsWith(sep) ? out + use : out + sep + use;
    }
    return out;
  };
  const norm = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);
  let root: string;
  try {
    root = norm(expand(resolve(tmpdir())));
  } catch {
    return false;
  }
  const candidates = [resolve(path)];
  try {
    if (existsSync(path)) candidates.push(realpathSync(path));
  } catch {
    /* resolve form only */
  }
  return candidates.some((candidate) => norm(expand(candidate)).startsWith(root + norm(sep)));
}

export interface ReconcileResult {
  examined: number;
  wouldRefuse: number;
  byReason: Record<RefusalReason, number>;
  deleted: number;
  written: boolean;
}

/**
 * Report (and optionally delete) meetings that the admission rule would no
 * longer record.
 *
 * This exists because the mesh was built before the rule: 27,858 meetings came
 * from accepting any co-occurrence of notes. It only ever touches meeting rows,
 * their exchanges and their resolutions � never a note, a relation or an open
 * end. `write` is refused outside the temp directory.
 */
export function reconcileMeetings(
  db: Db,
  projectId: number,
  opts: { write?: boolean } = {},
): ReconcileResult {
  const write = opts.write === true;
  if (write && !isTempDatabasePath(db.path)) {
    throw new Error(
      `refusing --write outside the temp directory (${db.path}): reconciliation deletes meeting rows and must run on a copy`,
    );
  }
  const result: ReconcileResult = {
    examined: 0,
    wouldRefuse: 0,
    byReason: { 'no-crossing-notes': 0, 'one-sided': 0, 'identity-only': 0 },
    deleted: 0,
    written: write,
  };
  const doomed: number[] = [];
  for (const meeting of db.all<MeetingRow>('SELECT * FROM canon_meeting WHERE project_id = ? ORDER BY id', projectId)) {
    result.examined++;
    const exchanges = db.all<{ direction: string; scope: string; is_context: number }>(
      `SELECT x.direction, x.scope, n.is_context
         FROM canon_meeting_exchange x
         JOIN canon_thread_note n ON n.id = x.note_id
        WHERE x.meeting_id = ?`,
      meeting.id,
    );
    const evidenceA = exchanges.filter(
      (row) => row.direction === 'a_to_b' && row.scope === 'pair' && row.is_context !== 1,
    ).length;
    const evidenceB = exchanges.filter(
      (row) => row.direction === 'b_to_a' && row.scope === 'pair' && row.is_context !== 1,
    ).length;
    const resolutions = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM canon_meeting_resolution WHERE meeting_id = ?',
      meeting.id,
    )!.n;
    if ((evidenceA > 0 && evidenceB > 0) || resolutions > 0) continue;
    result.wouldRefuse++;
    const reason: RefusalReason =
      evidenceA || evidenceB ? 'one-sided' : exchanges.length ? 'identity-only' : 'no-crossing-notes';
    result.byReason[reason]++;
    doomed.push(meeting.id);
  }
  if (write && doomed.length) {
    db.transaction(() => {
      for (const id of doomed) {
        db.run('DELETE FROM canon_meeting_resolution WHERE meeting_id = ?', id);
        db.run('DELETE FROM canon_meeting_exchange WHERE meeting_id = ?', id);
        db.run('DELETE FROM canon_meeting WHERE id = ?', id);
      }
    });
    result.deleted = doomed.length;
  }
  return result;
}

/* ------------------------------------------------- born-thread reconciliation */

export interface BornReconcileResult {
  /** Subjects with more than one born thread. */
  duplicateSubjects: number;
  /** Born threads beyond the first of each subject. */
  extraThreads: number;
  /** Threads marked dormant by this run. */
  markedDormant: number;
  written: boolean;
}

/**
 * Collapse duplicated born subjects without deleting anything.
 *
 * Before a subject could only be born once, the same pair could birth a child
 * from every meeting that pooled it. The lowest id stays live; the rest become
 * dormant, remember which thread superseded them, and drop out of meeting
 * candidacy. Notes and references are never touched.
 */
export function reconcileBornThreads(
  db: Db,
  projectId: number,
  opts: { write?: boolean } = {},
): BornReconcileResult {
  const write = opts.write === true;
  if (write && !isTempDatabasePath(db.path)) {
    throw new Error(
      `refusing --write outside the temp directory (${db.path}): reconciliation marks born threads and must run on a copy`,
    );
  }
  const rows = db.all<{ id: number; kind: string; a_entity: number; b_entity: number | null; birth_reason: string }>(
    `SELECT id, kind, a_entity, b_entity, birth_reason FROM canon_thread
      WHERE project_id = ? AND parent_a_thread IS NOT NULL AND status != 'dormant'
      ORDER BY id`,
    projectId,
  );
  const groups = new Map<string, { id: number; birth_reason: string }[]>();
  for (const row of rows) {
    const key = `${row.kind}|${row.a_entity}|${row.b_entity ?? 0}`;
    const list = groups.get(key) ?? [];
    list.push({ id: row.id, birth_reason: row.birth_reason });
    groups.set(key, list);
  }

  const result: BornReconcileResult = {
    duplicateSubjects: 0,
    extraThreads: 0,
    markedDormant: 0,
    written: write,
  };
  const at = new Date().toISOString();
  for (const key of [...groups.keys()].sort()) {
    const list = groups.get(key)!;
    if (list.length < 2) continue;
    result.duplicateSubjects++;
    result.extraThreads += list.length - 1;
    const keeper = Math.min(...list.map((row) => row.id));
    for (const row of list) {
      if (row.id === keeper) continue;
      if (write) {
        db.run(
          `UPDATE canon_thread SET status = 'dormant', birth_reason = ?, updated_at = ? WHERE id = ? AND project_id = ?`,
          `${row.birth_reason}; superseded-by:${keeper}`,
          at,
          row.id,
          projectId,
        );
      }
      result.markedDormant++;
    }
  }
  return result;
}
