/**
 * The evidence web as a brief the planner can read.
 *
 * Deterministic, read-only, no model: the same database always yields the same
 * brief. Every item carries a citation or is marked `uncited`, so a consumer
 * can tell a proven tie from a possibility without guessing.
 *
 * Grades come from the bank's own review_status and are never upgraded here:
 * `user_confirmed` is proven, `attested` is citable at passage scope,
 * provisional/needs_review stay provisional, and a row without an assessment is
 * not offered as a possibility at all.
 */
import { Db, fromJson, strList } from './db.ts';
import { createResolver, loadIdentityContext, type EntityResolution } from './identity.ts';

export type BriefGrade = 'proven' | 'attested' | 'provisional';

export interface Citation {
  quote: string;
  locator: string;
}

export interface BriefTie {
  id: number;
  grade: BriefGrade;
  kind: string;
  from: string;
  to: string;
  /** The other party, from the asking entity's point of view, when known. */
  other: string;
  citation: Citation | null;
  uncited: boolean;
  /** Present on provisional items only. */
  strength?: number;
  missing?: string;
  /** Passage scope for attested rows. */
  scope?: string;
}

export interface BriefQuestion {
  id: number;
  threadId: number;
  question: string;
  wouldResolve: string;
  citation: Citation | null;
  uncited: boolean;
}

export interface BriefConflict {
  id: number;
  threadId: number;
  kindLow: string;
  kindHigh: string;
  strengthLow: number;
  strengthHigh: number;
  citation: Citation | null;
  uncited: boolean;
}

export interface BriefThread {
  id: number;
  kind: 'person' | 'pair';
  label: string;
  noteCount: number;
  periodLabels: string[];
  starved: boolean;
}

export interface BriefUnresolved {
  name: string;
  status: 'ambiguous' | 'absent';
  candidates: { id: number; name: string }[];
}

export interface WebBrief {
  entities: string[];
  resolved: { id: number; name: string }[];
  proven: BriefTie[];
  attested: BriefTie[];
  provisional: BriefTie[];
  openQuestions: BriefQuestion[];
  conflicts: BriefConflict[];
  threads: BriefThread[];
  unresolved: BriefUnresolved[];
  truncated: Record<string, number>;
}

export interface BriefOptions {
  entities?: string[];
  limitPerSection?: number;
  includeOpenEnds?: boolean;
}

function locatorOf(sourceRefs: unknown): string {
  for (const ref of fromJson<{ locator?: unknown }[]>(sourceRefs as string, [])) {
    const locator = String(ref?.locator ?? '').trim();
    if (locator) return locator;
  }
  return '';
}

function hasAssessment(supportingEvidence: string): boolean {
  for (const item of fromJson<{ assessment?: unknown }[]>(supportingEvidence ?? '[]', [])) {
    if (item && typeof item === 'object' && item.assessment) return true;
  }
  return false;
}

/** Build the brief. Reads only; never writes. */
export function buildWebBrief(db: Db, projectId: number, opts: BriefOptions = {}): WebBrief {
  const limit = Math.max(1, opts.limitPerSection ?? 12);
  const names = (opts.entities ?? []).map((name) => name.trim()).filter(Boolean);
  const context = loadIdentityContext(db, projectId);
  const resolver = createResolver(context);

  const resolved: { id: number; name: string }[] = [];
  const unresolved: BriefUnresolved[] = [];
  for (const name of [...new Set(names)].sort()) {
    const result: EntityResolution = resolver.resolve(name);
    if (result.status === 'resolved' && result.id !== null) {
      resolved.push({ id: result.id, name: result.name ?? name });
    } else {
      unresolved.push({
        name,
        status: result.status === 'ambiguous' ? 'ambiguous' : 'absent',
        candidates: result.candidates,
      });
    }
  }
  resolved.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id));
  const ids = new Set(resolved.map((entity) => entity.id));
  const nameOf = new Map(resolved.map((entity) => [entity.id, entity.name]));

  const ties: BriefTie[] = [];
  if (ids.size) {
    const rows = db.all<{
      id: number;
      from_entity: number;
      to_entity: number;
      kind: string;
      evidence: string;
      source_refs: string;
      review_status: string;
      scope: string;
      supporting_evidence: string;
      confidence: number;
      description: string;
      from_name: string;
      to_name: string;
    }>(
      `SELECT r.id, r.from_entity, r.to_entity, r.kind, r.evidence, r.source_refs, r.review_status,
              r.scope, r.supporting_evidence, r.confidence, r.description,
              fa.name AS from_name, fb.name AS to_name
         FROM canon_relation r
         JOIN canon_entity fa ON fa.id = r.from_entity
         JOIN canon_entity fb ON fb.id = r.to_entity
        WHERE r.project_id = ? AND (r.from_entity IN (SELECT value FROM json_each(?))
                                 OR r.to_entity IN (SELECT value FROM json_each(?)))
        ORDER BY r.id`,
      projectId,
      JSON.stringify([...ids]),
      JSON.stringify([...ids]),
    );
    for (const row of rows) {
      let grade: BriefGrade | null = null;
      if (row.review_status === 'user_confirmed') grade = 'proven';
      else if (row.review_status === 'attested') grade = 'attested';
      else if (row.review_status === 'provisional' || row.review_status === 'needs_review') {
        if (!hasAssessment(row.supporting_evidence)) continue;
        grade = 'provisional';
      }
      if (!grade) continue;
      const locator = locatorOf(row.source_refs);
      const quote = String(row.evidence ?? '').trim();
      const fromName = nameOf.get(row.from_entity) ?? row.from_name;
      const toName = nameOf.get(row.to_entity) ?? row.to_name;
      const other = nameOf.has(row.from_entity) ? row.to_name : row.from_name;
      const tie: BriefTie = {
        id: row.id,
        grade,
        kind: row.kind,
        from: fromName,
        to: toName,
        other,
        citation: quote && locator ? { quote, locator } : null,
        uncited: !(quote && locator),
      };
      if (grade === 'provisional') {
        tie.strength = Number(row.confidence) || 0;
        tie.missing = String(row.description ?? '') || '';
      }
      if (grade === 'attested') tie.scope = row.scope || '';
      ties.push(tie);
    }
  }

  const byGrade = (grade: BriefGrade): BriefTie[] =>
    ties
      .filter((tie) => tie.grade === grade)
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.id - b.id));

  const proven = byGrade('proven');
  const attested = byGrade('attested');
  const provisional = byGrade('provisional');

  const truncated: Record<string, number> = {};
  const cap = <T>(items: T[], section: string): T[] => {
    if (items.length <= limit) return items;
    truncated[section] = items.length - limit;
    return items.slice(0, limit);
  };

  // Open questions: threads touching the cast, oldest question first.
  const questions: BriefQuestion[] = [];
  if (ids.size) {
    const rows = db.all<{
      id: number;
      thread_id: number;
      question: string;
      would_resolve: string;
      created_at: string;
    }>(
      `SELECT o.id, o.thread_id, o.question, o.would_resolve, o.created_at
         FROM canon_open_end o
         JOIN canon_thread t ON t.id = o.thread_id
        WHERE o.project_id = ? AND o.status = 'open'
          AND (t.a_entity IN (SELECT value FROM json_each(?)) OR t.b_entity IN (SELECT value FROM json_each(?)))
        ORDER BY o.created_at ASC, o.id ASC`,
      projectId,
      JSON.stringify([...ids]),
      JSON.stringify([...ids]),
    );
    for (const row of rows) {
      questions.push({
        id: row.id,
        threadId: row.thread_id,
        question: row.question,
        wouldResolve: row.would_resolve,
        citation: null,
        uncited: true,
      });
    }
  }

  const conflicts: BriefConflict[] = [];
  if (ids.size) {
    const rows = db.all<{
      id: number;
      thread_id: number;
      kind_low: string;
      kind_high: string;
      note_low: number;
      note_high: number;
    }>(
      `SELECT c.id, c.thread_id, c.kind_low, c.kind_high, c.note_low, c.note_high
         FROM canon_thread_conflict c
         JOIN canon_thread t ON t.id = c.thread_id
        WHERE c.project_id = ? AND c.status = 'visible'
          AND (t.a_entity IN (SELECT value FROM json_each(?)) OR t.b_entity IN (SELECT value FROM json_each(?)))
        ORDER BY c.id ASC`,
      projectId,
      JSON.stringify([...ids]),
      JSON.stringify([...ids]),
    );
    for (const row of rows) {
      const low = db.get<{ strength: number; quote: string; locator: string }>(
        `SELECT n.strength, n.quote, n.locator FROM canon_thread_note n WHERE n.id = ?`,
        row.note_low,
      );
      const high = db.get<{ strength: number; quote: string; locator: string }>(
        `SELECT n.strength, n.quote, n.locator FROM canon_thread_note n WHERE n.id = ?`,
        row.note_high,
      );
      const citation =
        low?.quote && low.locator ? { quote: low.quote, locator: low.locator } : null;
      conflicts.push({
        id: row.id,
        threadId: row.thread_id,
        kindLow: row.kind_low,
        kindHigh: row.kind_high,
        strengthLow: Number(low?.strength) || 0,
        strengthHigh: Number(high?.strength) || 0,
        citation,
        uncited: citation === null,
      });
    }
  }

  const threads: BriefThread[] = [];
  if (ids.size) {
    const rows = db.all<{
      id: number;
      kind: 'person' | 'pair';
      period_label: string;
      a_name: string;
      b_name: string | null;
      note_count: number;
    }>(
      `SELECT t.id, t.kind, t.period_label, COALESCE(ea.name, '') AS a_name, eb.name AS b_name,
              (SELECT COUNT(*) FROM canon_thread_note n WHERE n.thread_id = t.id) AS note_count
         FROM canon_thread t
         LEFT JOIN canon_entity ea ON ea.id = t.a_entity
         LEFT JOIN canon_entity eb ON eb.id = t.b_entity
        WHERE t.project_id = ? AND t.status != 'dormant'
          AND (t.a_entity IN (SELECT value FROM json_each(?)) OR t.b_entity IN (SELECT value FROM json_each(?)))
        ORDER BY t.id`,
      projectId,
      JSON.stringify([...ids]),
      JSON.stringify([...ids]),
    );
    const grouped = new Map<number, BriefThread>();
    for (const row of rows) {
      const existing = grouped.get(row.id);
      if (existing) {
        if (row.period_label) existing.periodLabels.push(row.period_label);
        continue;
      }
      grouped.set(row.id, {
        id: row.id,
        kind: row.kind,
        label: row.kind === 'pair' ? `${row.a_name} / ${row.b_name ?? ''}` : row.a_name,
        noteCount: row.note_count,
        periodLabels: row.period_label ? [row.period_label] : [],
        starved: row.note_count === 0,
      });
    }
    threads.push(...grouped.values());
  }

  return {
    entities: [...new Set(names)].sort(),
    resolved,
    proven: cap(proven, 'proven'),
    attested: cap(attested, 'attested'),
    provisional: cap(provisional, 'provisional'),
    openQuestions: opts.includeOpenEnds === false ? [] : cap(questions, 'openQuestions'),
    conflicts: cap(conflicts, 'conflicts'),
    threads,
    unresolved,
    truncated,
  };
}

/** The five-headed block the planner reads. Empty sections are omitted. */
export function renderWebBrief(brief: WebBrief): string {
  const lines: string[] = [];
  const tieLine = (tie: BriefTie): string => {
    const where = tie.citation ? `[${tie.citation.locator}]` : '(uncited)';
    const extra =
      tie.grade === 'provisional'
        ? ` strength ${(tie.strength ?? 0).toFixed(2)}${tie.missing ? ` — ${tie.missing}` : ''}`
        : '';
    return `- ${tie.from} ${tie.kind} ${tie.to} ${where}${extra}`;
  };
  if (brief.proven.length) {
    lines.push('PROVEN TIES (you may state these as canon, with the locator)');
    for (const tie of brief.proven) lines.push(tieLine(tie));
  }
  if (brief.attested.length) {
    lines.push('ATTESTED TIES (citable at passage scope; cite the locator)');
    for (const tie of brief.attested) lines.push(tieLine(tie));
  }
  if (brief.provisional.length) {
    lines.push('PROVISIONAL — DO NOT ASSERT (you may treat as possibility, never as fact)');
    for (const tie of brief.provisional) lines.push(tieLine(tie));
  }
  if (brief.openQuestions.length) {
    lines.push('OPEN QUESTIONS (ask or leave open; never invent an answer)');
    for (const question of brief.openQuestions) {
      lines.push(`- ${question.question}${question.wouldResolve ? ` (would resolve: ${question.wouldResolve})` : ''}`);
    }
  }
  if (brief.conflicts.length) {
    lines.push('VISIBLE CONTRADICTIONS (show the disagreement, do not resolve it)');
    for (const conflict of brief.conflicts) {
      lines.push(`- ${conflict.kindLow} vs ${conflict.kindHigh} (thread ${conflict.threadId})`);
    }
  }
  if (!lines.length) return '';
  return [
    'EVIDENCE WEB (grade of every claim; every canon statement must carry the locator shown)',
    ...lines,
    'RULES: state a PROVEN or ATTESTED tie as canon only with its locator; a claim marked (uncited) is never canon;',
    'treat PROVISIONAL as possibility only; list OPEN QUESTIONS as questions and never answer them; show CONTRADICTIONS without resolving them.',
  ].join('\n');
}
