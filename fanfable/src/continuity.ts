/**
 * Continuity Checker.
 *
 * Checks a scene against the approved outline, the previous chapters, the canon
 * references and the current AU state. It reports problems with evidence and
 * explanations. It never rewrites anything and it never rejects an intentional
 * AU change on its own — it points it out and lets the author decide.
 */
import { Db, nowIso } from './db.ts';
import { extractJson } from './json.ts';
import type { LlmClient } from './llm.ts';
import { similarity, splitSentences, truncate } from './text.ts';
import { nameMentionedExact } from './names.ts';
import type { ContextSlice } from './memory.ts';
import * as lorebook from './lorebook.ts';
import { graphContinuityChecks } from './graph-checks.ts';

export type IssueSeverity = 'error' | 'warning' | 'note';

export type IssueCategory =
  | 'chronology'
  | 'knowledge'
  | 'relationship'
  | 'location'
  | 'injury'
  | 'motivation'
  | 'canon-mix'
  | 'repetition'
  | 'thread'
  | 'unexplained-change'
  | 'outline-deviation';

export interface ContinuityIssue {
  id?: number;
  severity: IssueSeverity;
  category: IssueCategory;
  message: string;
  evidence: string;
  suggestion: string;
  resolution: 'open' | 'accepted' | 'fixed';
}

export interface ChapterRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  status: string;
  summary: string;
}

/* ------------------------------------------------------------- persistence */

export function saveIssues(db: Db, projectId: number, chapterId: number | null, issues: ContinuityIssue[]): number[] {
  const ids: number[] = [];
  for (const i of issues) {
    const r = db.run(
      `INSERT INTO continuity_issue (project_id, chapter_id, severity, category, message, evidence, suggestion, resolution, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      chapterId,
      i.severity,
      i.category,
      i.message,
      i.evidence,
      i.suggestion,
      i.resolution ?? 'open',
      nowIso(),
    );
    ids.push(r.lastInsertRowid);
  }
  return ids;
}

export function listIssues(
  db: Db,
  projectId: number,
  opts: { chapterId?: number; openOnly?: boolean } = {},
): (ContinuityIssue & { id: number; chapterNumber: number | null; createdAt: string })[] {
  const params: unknown[] = [projectId];
  let sql = `SELECT i.*, c.number AS chapter_number FROM continuity_issue i
             LEFT JOIN chapter c ON c.id = i.chapter_id WHERE i.project_id = ?`;
  if (opts.chapterId !== undefined) {
    sql += ' AND i.chapter_id = ?';
    params.push(opts.chapterId);
  }
  if (opts.openOnly) sql += " AND i.resolution = 'open'";
  sql += ' ORDER BY CASE i.severity WHEN \'error\' THEN 0 WHEN \'warning\' THEN 1 ELSE 2 END, i.id';
  const rows = db.all<{
    id: number;
    chapter_id: number | null;
    severity: string;
    category: string;
    message: string;
    evidence: string;
    suggestion: string;
    resolution: string;
    chapter_number: number | null;
    created_at: string;
  }>(sql, ...params);
  return rows.map((r) => ({
    id: r.id,
    severity: r.severity as IssueSeverity,
    category: r.category as IssueCategory,
    message: r.message,
    evidence: r.evidence,
    suggestion: r.suggestion,
    resolution: r.resolution as ContinuityIssue['resolution'],
    chapterNumber: r.chapter_number,
    createdAt: r.created_at,
  }));
}

export function setIssueResolution(db: Db, projectId: number, issueId: number, resolution: ContinuityIssue['resolution']): void {
  db.run('UPDATE continuity_issue SET resolution = ? WHERE id = ? AND project_id = ?', resolution, issueId, projectId);
}

/* ------------------------------------------------- deterministic checks */

export interface KeeperTie {
  fromName: string;
  fromAliases: string[];
  toName: string;
  toAliases: string[];
  kind: string;
  evidence: string;
  locator: string;
}

export interface DeterministicInput {
  chapter: ChapterRecord;
  previousChapters: ChapterRecord[];
  events: { id: number; title: string; storyOrder: number; kind: string; chapterId: number | null; adaptsCanonEventId: number | null; divergenceNote: string }[];
  threads: { id: number; title: string; status: string; events: string[] }[];
  knowledge: { characterName: string; fact: string; topic: string; certainty: string; source: string }[];
  canonChanges: { auEventId: number | null; canonEventId: number | null; changeType: string; description: string; eventTitle: string }[];
  /** What the source material says about people, from the extracted lore index. */
  canonEntities?: { name: string; kind: string; status: string; summary: string }[];
  /** Changes the author has already recorded, so they are not flagged again. */
  knownDivergences?: { description: string; subject: string }[];
  /** Keeper-grade ties whose endpoints both appear in the chapter. */
  keeperTies?: KeeperTie[];
  /** Provisional ties whose endpoints both appear (notes only). */
  provisionalTies?: KeeperTie[];
}

/**
 * Checks that do not need a model: chronology, repetition, forgotten threads,
 * and adaptations that were not distinguished from the original.
 */
export function deterministicChecks(input: DeterministicInput): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  const { chapter } = input;

  // 1. Events inside the chapter must not run backwards in story time, and a
  //    flashback must carry an earlier order than the chapter it lives in.
  const chapterEvents = input.events.filter((e) => e.chapterId === chapter.id);
  for (let i = 1; i < chapterEvents.length; i++) {
    const prev = chapterEvents[i - 1];
    const cur = chapterEvents[i];
    if (cur.kind === 'flashback' || prev.kind === 'flashback') continue;
    if (cur.storyOrder < prev.storyOrder) {
      issues.push({
        severity: 'warning',
        category: 'chronology',
        message: `Story time goes backwards inside chapter ${chapter.number}: "${cur.title}" is ordered before "${prev.title}".`,
        evidence: `"${cur.title}" (order ${cur.storyOrder}) follows "${prev.title}" (order ${prev.storyOrder})`,
        suggestion: 'Adjust the story_order of these events, or mark the earlier one as a flashback.',
        resolution: 'open',
      });
    }
  }
  for (const e of chapterEvents) {
    if (e.kind === 'flashback' && e.storyOrder >= chapter.number) {
      issues.push({
        severity: 'warning',
        category: 'chronology',
        message: `Flashback "${e.title}" in chapter ${chapter.number} is not placed in the past.`,
        evidence: `story_order ${e.storyOrder} vs chapter ${chapter.number}`,
        suggestion: 'Give the flashback a story_order earlier than the chapter that contains it.',
        resolution: 'open',
      });
    }
  }

  // 2. Repetition: the chapter body should not substantially restate an earlier chapter.
  const current = chapter.body.toLowerCase();
  for (const prev of input.previousChapters) {
    const score = similarity(current, prev.body.toLowerCase());
    if (score > 0.35) {
      issues.push({
        severity: score > 0.6 ? 'error' : 'warning',
        category: 'repetition',
        message: `Chapter ${chapter.number} substantially repeats chapter ${prev.number}.`,
        evidence: `token overlap ${(score * 100).toFixed(0)}% with "${prev.title}"`,
        suggestion: 'Rewrite the duplicated passage or cut it; check whether the scene was meant to advance the plot.',
        resolution: 'open',
      });
    }
  }

  // 3. Open threads that have gone quiet.
  const body = chapter.body.toLowerCase();
  for (const t of input.threads) {
    if (t.status !== 'open') continue;
    const titleWords = t.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const mentioned = titleWords.some((w) => body.includes(w));
    const inEvents = t.events.some((ev) => ev.toLowerCase().split(/\s+/).some((w) => w.length > 3 && body.includes(w)));
    if (!mentioned && !inEvents && input.previousChapters.length >= 2) {
      issues.push({
        severity: 'note',
        category: 'thread',
        message: `Open plot thread "${t.title}" has not been touched for several chapters.`,
        evidence: `Thread status: open; no mention in chapter ${chapter.number}.`,
        suggestion: 'Advance or deliberately retire this thread, or note that it is intentionally dormant.',
        resolution: 'open',
      });
    }
  }

  // 4. An adaptation that is not distinguished from the original canon scene.
  for (const e of chapterEvents) {
    if (e.adaptsCanonEventId && !e.divergenceNote.trim()) {
      issues.push({
        severity: 'note',
        category: 'canon-mix',
        message: `"${e.title}" adapts canon event ${e.adaptsCanonEventId} but does not record what changed.`,
        evidence: `au_event ${e.id} links to canon_event ${e.adaptsCanonEventId} with an empty divergence note.`,
        suggestion: 'Record the divergence so later writers know this scene differs from the original.',
        resolution: 'open',
      });
    }
  }

  // 5. A recorded change from canon that the story has not accounted for.
  //    (Unconfirmed changes are workflow state, not a continuity problem, so
  //    they live with the timeline rather than in the issue list.)
  for (const c of input.canonChanges) {
    if (!c.eventTitle) continue;
    if (!/preserved/i.test(c.changeType)) continue;
    issues.push({
      severity: 'note',
      category: 'canon-mix',
      message: `The change from canon recorded for "${c.eventTitle}" is not reflected in the chapter.`,
      evidence: c.description,
      suggestion: 'Either apply the change on the page or record it as the intended difference.',
      resolution: 'open',
    });
  }

  // 5b. A chapter that explicitly denies a keeper-grade tie.
  //     Omission is not contradiction: only a denial in a sentence that names
  //     both sides (or one side plus a pronoun) is reported.
  const denial = /\b(never\s+(?:met|served|knew|known)|no\s+(?:relationship|tie|connection)|not\s+(?:my|his|her|their|your)\s+(?:master|aide|apprentice|teacher|student|mentor|parent|child|friend|enemy|ally|spouse|husband|wife)|denied\s+(?:any\s+)?(?:connection|relationship|tie)|(?:was|were)\s+lying)\b/i;
  const pronoun = /\b(he|she|they|him|her|them|his|hers|their|theirs|i|me|my|mine|we|us|our|ours)\b/i;
  const sentences = splitSentences(chapter.body);
  const denialFor = (tie: KeeperTie): string | null => {
    const aVariants = [tie.fromName, ...tie.fromAliases].filter(Boolean);
    const bVariants = [tie.toName, ...tie.toAliases].filter(Boolean);
    for (const sentence of sentences) {
      if (!denial.test(sentence)) continue;
      const a = aVariants.some((name) => nameMentionedExact(name, sentence));
      const b = bVariants.some((name) => nameMentionedExact(name, sentence));
      if ((a && b) || ((a || b) && pronoun.test(sentence))) return sentence.trim();
    }
    return null;
  };
  for (const tie of input.keeperTies ?? []) {
    const sentence = denialFor(tie);
    if (!sentence) continue;
    issues.push({
      severity: 'error',
      category: 'relationship',
      message: `Chapter ${chapter.number} denies the keeper tie: ${tie.fromName} — ${tie.kind} — ${tie.toName}.`,
      evidence: sentence,
      suggestion:
        `Keeper locator: ${tie.locator || 'unplaced'}. Keeper evidence: "${truncate(tie.evidence, 180)}". ` +
        'If this scene intentionally changes the relationship, record the divergence.',
      resolution: 'open',
    });
  }
  for (const tie of input.provisionalTies ?? []) {
    const sentence = denialFor(tie);
    if (!sentence) continue;
    issues.push({
      severity: 'note',
      category: 'relationship',
      message:
        `Chapter ${chapter.number} denies a provisional tie: ${tie.fromName} — ${tie.kind} — ${tie.toName}. ` +
        'The bank holds only unverified evidence for this relationship.',
      evidence: sentence,
      suggestion: `Unverified locator: ${tie.locator || 'unplaced'}. Evidence: "${truncate(tie.evidence, 180)}".`,
      resolution: 'open',
    });
  }

  // 6. Someone who is dead (or missing) in the source, but acts in this story.
  //    This is only possible because the book's lore was extracted, and it
  //    cannot be judged a mistake: an AU may well resurrect someone. It asks
  //    whether the story has explained itself.
  const dead = (input.canonEntities ?? []).filter((e) =>
    /\b(dead|deceased|killed|murdered|missing)\b/i.test(e.status || ''),
  );
  const bodyLower = chapter.body.toLowerCase();
  for (const e of dead) {
    const name = e.name.trim();
    if (!name) continue;
    const mentions = bodyLower.includes(name.toLowerCase());
    if (!mentions) continue;
    const explained = (input.knownDivergences ?? []).some((d) => {
      const hay = `${d.description} ${d.subject}`.toLowerCase();
      return hay.includes(name.toLowerCase()) || name.toLowerCase().includes(d.subject.toLowerCase());
    });
    if (explained) continue;
    issues.push({
      severity: 'note',
      category: 'canon-mix',
      message: `${name} is ${e.status || 'not present'} in the source material but appears in this chapter.`,
      evidence: e.summary || e.status,
      suggestion:
        'Confirm whether this scene predates the recorded death. If the story keeps them alive, record the change from canon so later chapters know it was intended.',
      resolution: 'open',
    });
  }

  return issues;
}

/* ------------------------------------------------------ model-assisted checks */

const CHECK_SYSTEM = `You are the Continuity Checker for a fanfiction project.
You are given: the approved outline for a chapter, the text of the chapter that was just written,
the recorded story memory (characters, what they know, relationships, timeline) and canon evidence.

Find real problems. Report each with:
{
  "severity": "error | warning | note",
  "category": "chronology | knowledge | relationship | location | injury | motivation | canon-mix | repetition | thread | unexplained-change | outline-deviation",
  "message": "one sentence describing the problem",
  "evidence": "quote the specific sentence(s) from the chapter or the memory record that shows it",
  "suggestion": "what the author could change"
}

Check for:
- a character acting on information they do not have yet at this point in the story
- someone being somewhere they could not be, or being described as uninjured after an injury
- relationships that shift without cause, motivations that contradict what is recorded
- canon details appearing unchanged even though the AU divergence changed them
  (or AU changes being presented as if they were canon)
- a rule, number, count, name or signal meaning that differs from the canon evidence
  (for example a different number of lights, a different price, a different order of events)
- an action that contradicts an established motive, or ignores the consequence of an
  event the story has already established
- a character who acts on a connection they could not have known yet
- a scene that contradicts the approved outline
- events repeating something the story already did

Rules:
- Only report what the evidence actually shows. Do not invent problems.
- A deliberate AU change is not a contradiction. If something looks like a change of canon
  but the divergence is recorded, report it as a "note" at most.
- Reply with JSON only: {"issues":[...]}. No prose.`;

export interface LlmCheckInput {
  chapter: ChapterRecord;
  outlineText: string;
  memoryText: string;
  canonText: string;
  /** Connected context: relationships, motives and consequences. */
  connectedText: string;
  canonChangeText: string;
}

export async function modelChecks(llm: LlmClient, input: LlmCheckInput): Promise<ContinuityIssue[]> {
  const user = [
    `## APPROVED OUTLINE FOR THIS CHAPTER\n${input.outlineText}`,
    `## RECORDED STORY MEMORY\n${input.memoryText || '(none recorded yet)'}`,
    `## CANON EVIDENCE\n${input.canonText || '(none supplied)'}`,
    input.connectedText ? `## CONNECTED CONTEXT (relationships, motives, events and their consequences)\n${input.connectedText}` : '',
    input.canonChangeText ? `## RECORDED CHANGES FROM CANON\n${input.canonChangeText}` : '',
    `## CHAPTER ${input.chapter.number} TEXT\n${truncate(input.chapter.body, 14000)}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  let res;
  try {
    res = await llm.chat({
      system: CHECK_SYSTEM,
      messages: [{ role: 'user', content: user }],
      temperature: 0.1,
      maxTokens: 2000,
    });
  } catch {
    return [];
  }

  const parsed = extractJson<{ issues?: unknown }>(res.text);
  const list = Array.isArray(parsed?.issues) ? (parsed!.issues as Record<string, unknown>[]) : [];
  const issues: ContinuityIssue[] = [];
  for (const raw of list) {
    const message = String(raw.message ?? '').trim();
    if (!message) continue;
    const severity = String(raw.severity ?? 'warning').toLowerCase();
    const category = String(raw.category ?? 'other').toLowerCase();
    issues.push({
      severity: (severity === 'error' || severity === 'note' ? severity : 'warning') as IssueSeverity,
      category: category as IssueCategory,
      message,
      evidence: String(raw.evidence ?? '').trim(),
      suggestion: String(raw.suggestion ?? '').trim(),
      resolution: 'open',
    });
  }
  return issues;
}

/** Merge model issues with deterministic ones, dropping obvious duplicates. */
export function mergeIssues(deterministic: ContinuityIssue[], model: ContinuityIssue[]): ContinuityIssue[] {
  const out = [...deterministic];
  for (const issue of model) {
    const key = `${issue.category}:${issue.message.toLowerCase()}`;
    const dup = out.some(
      (d) =>
        d.category === issue.category &&
        (d.message.toLowerCase() === issue.message.toLowerCase() ||
          (issue.evidence && d.evidence && issue.evidence.slice(0, 60) === d.evidence.slice(0, 60))),
    );
    if (!dup) out.push(issue);
    else if (key && !out.find((d) => d.message === issue.message)) out.push(issue);
  }
  return out;
}

/* --------------------------------------------------------------------- api */

export interface CheckOptions {
  useModel?: boolean;
  /** Mutable report holder for dropped model issues. */
  stats?: { droppedModelIssues: number };
  keeperTies?: KeeperTie[];
  provisionalTies?: KeeperTie[];
  llm?: LlmClient;
  outlineText?: string;
  memoryText?: string;
  canonText?: string;
  connectedText?: string;
  canonChangeText?: string;
}

export async function checkChapter(
  db: Db,
  projectId: number,
  chapter: ChapterRecord,
  context: ContextSlice,
  opts: CheckOptions = {},
): Promise<ContinuityIssue[]> {
  const events = db.all<{
    id: number;
    title: string;
    story_order: number;
    kind: string;
    chapter_id: number | null;
    adapts_canon_event_id: number | null;
    divergence_note: string;
  }>(
    'SELECT id, title, story_order, kind, chapter_id, adapts_canon_event_id, divergence_note FROM au_event WHERE project_id = ? ORDER BY seq',
    projectId,
  );

  const previousChapters = db.all<{
    id: number;
    number: number;
    title: string;
    body: string;
    status: string;
    summary: string;
  }>(
    'SELECT id, number, title, body, status, summary FROM chapter WHERE project_id = ? AND number < ? ORDER BY number',
    projectId,
    chapter.number,
  );

  const canonChanges = db.all<{
    au_event_id: number | null;
    canon_event_id: number | null;
    change_type: string;
    description: string;
    title: string | null;
  }>(
    `SELECT cc.au_event_id, cc.canon_event_id, cc.change_type, cc.description, e.title
     FROM canon_change cc LEFT JOIN au_event e ON e.id = cc.au_event_id
     WHERE cc.project_id = ? ORDER BY cc.id`,
    projectId,
  );

  // Graph-based checks: contradictions that depend on how things connect.
  const storyOrder =
    db.get<{ n: number | null }>(
      'SELECT MAX(story_order) AS n FROM au_event WHERE project_id = ? AND chapter_id = ?',
      projectId,
      chapter.id,
    )?.n ??
    db.get<{ n: number | null }>(
      'SELECT MAX(story_order) AS n FROM au_event WHERE project_id = ?',
      projectId,
    )?.n ??
    0;

  const graphIssues = graphContinuityChecks(db, projectId, {
    chapterId: chapter.id,
    chapterNumber: chapter.number,
    body: chapter.body,
    storyOrder,
  });

  const deterministic = deterministicChecks({
    chapter,
    previousChapters,
    events: events.map((e) => ({
      id: e.id,
      title: e.title,
      storyOrder: e.story_order,
      kind: e.kind,
      chapterId: e.chapter_id,
      adaptsCanonEventId: e.adapts_canon_event_id,
      divergenceNote: e.divergence_note,
    })),
    threads: context.threads.map((t) => ({ id: t.id, title: t.title, status: t.status, events: t.events })),
    knowledge: context.knowledge.map((k) => ({
      characterName: k.characterName,
      fact: k.fact,
      topic: k.topic,
      certainty: k.certainty,
      source: k.source,
    })),
    canonChanges: canonChanges.map((c) => ({
      auEventId: c.au_event_id,
      canonEventId: c.canon_event_id,
      changeType: c.change_type,
      description: c.description,
      eventTitle: c.title ?? '',
    })),
    canonEntities: lorebook.listEntities(db, projectId).map((e) => ({
      name: e.name,
      kind: e.kind,
      status: e.status,
      summary: e.summary,
    })),
    knownDivergences: db
      .all<{ description: string; title: string | null }>(
        `SELECT cc.description, e.title FROM canon_change cc
         LEFT JOIN au_event e ON e.id = cc.au_event_id WHERE cc.project_id = ?`,
        projectId,
      )
      .map((d) => ({ description: d.description, subject: d.title ?? '' })),
    keeperTies: opts.keeperTies,
    provisionalTies: opts.provisionalTies,
  });

  let model: ContinuityIssue[] = [];
  if (opts.useModel && opts.llm) {
    model = await modelChecks(opts.llm, {
      chapter,
      outlineText: opts.outlineText ?? '',
      memoryText: opts.memoryText ?? '',
      canonText: opts.canonText ?? '',
      connectedText: opts.connectedText ?? '',
      canonChangeText: opts.canonChangeText ?? '',
    });
    const normaliseEvidence = (text: string): string =>
      (text ?? '')
        .replace(/[“”«»]/g, '"')
        .replace(/[‘’]/g, "'")
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
    const body = normaliseEvidence(chapter.body);
    const before = model.length;
    model = model.filter((issue) => {
      const evidence = normaliseEvidence(issue.evidence);
      return !!evidence && body.includes(evidence);
    });
    if (opts.stats) opts.stats.droppedModelIssues = before - model.length;
  }

  return mergeIssues(mergeIssues(deterministic, graphIssues), model);
}
