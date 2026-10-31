/**
 * Graph-based continuity checks.
 *
 * These are the contradictions that plain text retrieval cannot see, because
 * they depend on *relations between things*: what a character knows and when
 * they learned it, what one event caused, how two people relate now versus
 * earlier, what the story changed and what the characters still believe.
 *
 * Every finding carries the evidence it is based on, and none of them treats an
 * intentional change from canon as a mistake — the divergence is the point of
 * the story.
 */
import { Db } from '../core/db.ts';
import type { ContinuityIssue } from '../product/continuity.ts';
import { terms } from '../support/graph.ts';

export interface GraphCheckInput {
  chapterId: number;
  chapterNumber: number;
  /** The text of the chapter being checked. */
  body: string;
  /** The story order the chapter sits at, for timeline comparisons. */
  storyOrder: number;
}

/** Distinctive words in a claim: the ones that would not appear by chance. */
function distinctiveTerms(text: string): string[] {
  return (text ?? '')
    .split(/[^A-Za-z0-9'’-]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 3)
    .filter((w) => /[A-Z]/.test(w.slice(1)) || w.toLowerCase() === w)
    .map((w) => w.toLowerCase());
}

/**
 * A character who acts on something before they could know it.
 *
 * The knowledge has to be tied to an event: without one, we cannot say when
 * the character learned it, and guessing would produce false alarms.
 */
function checkKnowledgeBeforeLearning(db: Db, projectId: number, input: GraphCheckInput): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  const body = input.body.toLowerCase();

  const rows = db.all<{
    id: number;
    character_id: number;
    fact: string;
    topic: string;
    certainty: string;
    au_event_id: number | null;
    character_name: string;
    event_order: number | null;
  }>(
    `SELECT k.id, k.character_id, k.fact, k.topic, k.certainty, k.au_event_id,
            c.name AS character_name, e.story_order AS event_order
     FROM character_knowledge k
     JOIN character c ON c.id = k.character_id
     LEFT JOIN au_event e ON e.id = k.au_event_id
     WHERE k.project_id = ? AND k.au_event_id IS NOT NULL`,
    projectId,
  );

  for (const row of rows) {
    if (row.event_order === null || row.event_order === undefined) continue;
    if (row.event_order <= input.storyOrder) continue; // learned before this chapter

    // The claim has to be *about* something the chapter mentions, and the
    // character has to be in the chapter.
    const claim = `${row.fact} ${row.topic}`.toLowerCase();
    const distinctive = distinctiveTerms(claim);
    const shared = distinctive.filter((t) => body.includes(t));
    if (!shared.length) continue;
    // The character has to be in the chapter. A first name is enough: prose
    // rarely repeats surnames.
    const full = row.character_name.toLowerCase();
    const first = full.split(' ')[0];
    if (!body.includes(full) && !(first.length > 2 && body.includes(first))) continue;

    issues.push({
      severity: 'warning',
      category: 'knowledge',
      message: `${row.character_name} refers to "${row.fact}" before the event where they learn it.`,
      evidence: `learned at story order ${row.event_order}; chapter ${input.chapterNumber} is at ${input.storyOrder}. Shared terms: ${shared.join(', ')}`,
      suggestion: 'Move the learning earlier, or have the character learn it in this chapter.',
      resolution: 'open',
    });
  }
  return issues;
}

/** An event that happens before the event that caused it. */
function checkImpossibleOrder(db: Db, projectId: number, _input: GraphCheckInput): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  const rows = db.all<{
    from_event_id: number;
    to_event_id: number;
    kind: string;
    description: string;
    from_order: number;
    to_order: number;
    from_title: string;
    to_title: string;
  }>(
    `SELECT l.from_event_id, l.to_event_id, l.kind, l.description,
            f.story_order AS from_order, t.story_order AS to_order,
            f.title AS from_title, t.title AS to_title
     FROM au_event_link l
     JOIN au_event f ON f.id = l.from_event_id
     JOIN au_event t ON t.id = l.to_event_id
     WHERE l.project_id = ? AND l.kind IN ('cause', 'consequence')`,
    projectId,
  );

  for (const row of rows) {
    if (row.from_order <= row.to_order) continue;
    issues.push({
      severity: 'error',
      category: 'chronology',
      message: `"${row.from_title}" is marked as the cause of "${row.to_title}" but happens after it.`,
      evidence: `${row.from_title} is at story order ${row.from_order}; ${row.to_title} is at ${row.to_order}. ${row.description}`,
      suggestion: 'Swap the order of the two events, or record the link the other way round.',
      resolution: 'open',
    });
  }
  return issues;
}

/** Two people whose relationship changed with nothing to explain it. */
function checkRelationshipChanges(db: Db, projectId: number, _input: GraphCheckInput): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  const rows = db.all<{
    id: number;
    character_a: number;
    character_b: number;
    kind: string;
    description: string;
    closed: number;
    valid_from_event_id: number | null;
    chapter_id: number | null;
    a_name: string;
    b_name: string;
  }>(
    `SELECT r.*, a.name AS a_name, b.name AS b_name
     FROM relationship r
     JOIN character a ON a.id = r.character_a
     JOIN character b ON b.id = r.character_b
     WHERE r.project_id = ?`,
    projectId,
  );

  const byPair = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.character_a}:${row.character_b}`;
    byPair.set(key, [...(byPair.get(key) ?? []), row]);
  }

  for (const [, pair] of byPair) {
    if (pair.length < 2) continue;
    const current = pair.filter((r) => !r.closed);
    const past = pair.filter((r) => r.closed);
    if (!current.length || !past.length) continue;
    for (const old of past) {
      if (old.kind === current[0].kind) continue;
      // The change needs a cause: an event, or a chapter that explains it.
      const hasCause = !!old.valid_from_event_id || !!old.chapter_id;
      if (hasCause) continue;
      issues.push({
        severity: 'note',
        category: 'relationship',
        message: `${old.a_name} and ${old.b_name} changed from "${old.kind}" to "${current[0].kind}" with nothing recorded to explain it.`,
        evidence: `${old.description || 'no description'}`,
        suggestion: 'Record the event or chapter where the relationship changed, so later chapters know.',
        resolution: 'open',
      });
    }
  }
  return issues;
}

/** A character recorded in one place while an event puts them somewhere else. */
function checkLocations(db: Db, projectId: number, _input: GraphCheckInput): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  const rows = db.all<{
    id: number;
    character_name: string;
    location: string;
    as_of_event_id: number | null;
    event_location: string;
    event_title: string;
  }>(
    `SELECT s.id, c.name AS character_name, s.location, s.as_of_event_id,
            e.location AS event_location, e.title AS event_title
     FROM character_state s
     JOIN character c ON c.id = s.character_id
     JOIN au_event e ON e.id = s.as_of_event_id
     WHERE s.project_id = ? AND s.location != '' AND e.location != '' AND s.location != e.location`,
    projectId,
  );

  for (const row of rows) {
    issues.push({
      severity: 'warning',
      category: 'location',
      message: `${row.character_name} is recorded at "${row.location}" during "${row.event_title}", which happens at "${row.event_location}".`,
      evidence: `state: ${row.location} / event: ${row.event_location}`,
      suggestion: 'Correct one of the two, or explain the move.',
      resolution: 'open',
    });
  }
  return issues;
}

/**
 * A divergence the story has made, and something that still treats the canon
 * version as true.
 */
function checkDivergenceConsequences(db: Db, projectId: number, _input: GraphCheckInput): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];

  const changes = db.all<{
    id: number;
    au_event_id: number | null;
    canon_event_id: number | null;
    change_type: string;
    description: string;
    au_title: string;
    canon_title: string;
  }>(
    `SELECT c.id, c.au_event_id, c.canon_event_id, c.change_type, c.description,
            a.title AS au_title, e.title AS canon_title
     FROM canon_change c
     LEFT JOIN au_event a ON a.id = c.au_event_id
     LEFT JOIN canon_event e ON e.id = c.canon_event_id
     WHERE c.project_id = ?`,
    projectId,
  );

  for (const change of changes) {
    if (!change.canon_event_id) continue;
    if (!['prevented', 'reversed', 'omitted'].includes(change.change_type)) continue;

    // The story says the canon event does not happen — but it happens anyway.
    const later = db.get<{ id: number; title: string }>(
      `SELECT id, title FROM au_event
       WHERE project_id = ? AND adapts_canon_event_id = ? AND id != COALESCE(?, -1)
       LIMIT 1`,
      projectId,
      change.canon_event_id,
      change.au_event_id ?? null,
    );
    if (!later) continue;
    issues.push({
      severity: 'warning',
      category: 'canon-mix',
      message: `The story records "${change.description}" as ${change.change_type}, yet "${later.title}" still adapts the canon event it refers to.`,
      evidence: `canon event ${change.canon_event_id}: ${change.canon_title}`,
      suggestion: 'Either the change or the adaptation is wrong; the story cannot do both.',
      resolution: 'open',
    });
  }

  // A character still believes a canon fact the story has changed.
  const beliefs = db.all<{
    id: number;
    character_name: string;
    fact: string;
    source: string;
    certainty: string;
  }>(
    `SELECT k.id, c.name AS character_name, k.fact, k.source, k.certainty
     FROM character_knowledge k JOIN character c ON c.id = k.character_id
     WHERE k.project_id = ? AND k.source = 'canon'`,
    projectId,
  );
  for (const belief of beliefs) {
    const beliefTerms = terms(belief.fact);
    if (!beliefTerms.length) continue;
    for (const change of changes) {
      if (change.change_type === 'preserved') continue;
      const changeTerms = terms(change.description);
      const shared = beliefTerms.filter((t) => changeTerms.includes(t));
      if (shared.length < 2) continue;
      issues.push({
        severity: 'note',
        category: 'canon-mix',
        message: `${belief.character_name} still holds "${belief.fact}", but the story changed something related to it.`,
        evidence: `change: ${change.description} (${change.change_type})`,
        suggestion: 'If the character should now know better, record how they learned it.',
        resolution: 'open',
      });
    }
  }

  return issues;
}

/** A plot thread resolved without being resolved, or the other way round. */
function checkThreads(db: Db, projectId: number, _input: GraphCheckInput): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  const rows = db.all<{
    id: number;
    title: string;
    status: string;
    description: string;
    kinds: string;
  }>(
    `SELECT t.id, t.title, t.status, t.description,
            GROUP_CONCAT(te.kind) AS kinds
     FROM plot_thread t LEFT JOIN thread_event te ON te.thread_id = t.id
     WHERE t.project_id = ? GROUP BY t.id`,
    projectId,
  );

  for (const row of rows) {
    const kinds = (row.kinds ?? '').split(',').filter(Boolean);
    const resolvedByEvent = kinds.includes('resolved');
    if (row.status === 'resolved' && !resolvedByEvent) {
      issues.push({
        severity: 'note',
        category: 'thread',
        message: `The plot thread "${row.title}" is marked resolved, but no event records it being resolved.`,
        evidence: row.description || 'no description',
        suggestion: 'Record the event that closed the thread, so the timeline agrees with the thread.',
        resolution: 'open',
      });
    }
    if (row.status === 'open' && resolvedByEvent) {
      issues.push({
        severity: 'warning',
        category: 'thread',
        message: `The plot thread "${row.title}" was resolved by an event but is still marked open.`,
        evidence: row.description || 'no description',
        suggestion: 'Mark the thread resolved, or remove the resolving event.',
        resolution: 'open',
      });
    }
  }
  return issues;
}

/**
 * All the graph-based checks for one chapter.
 */
export function graphContinuityChecks(
  db: Db,
  projectId: number,
  input: GraphCheckInput,
): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  issues.push(...checkKnowledgeBeforeLearning(db, projectId, input));
  issues.push(...checkImpossibleOrder(db, projectId, input));
  issues.push(...checkRelationshipChanges(db, projectId, input));
  issues.push(...checkLocations(db, projectId, input));
  issues.push(...checkDivergenceConsequences(db, projectId, input));
  issues.push(...checkThreads(db, projectId, input));
  return issues;
}
