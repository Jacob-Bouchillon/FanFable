/**
 * Planning scenario.
 *
 * The premise, the divergence point and the canon are fixed. The model is
 * asked for an outline, and the outline is scored on things that can be
 * counted:
 *
 *   coverage        does the plan cover what the author asked for
 *   completeness    does every chapter have a goal, a synopsis and scenes
 *   canon/au split  does the plan say what the canon establishes and what
 *                   this story changes, or does it blur the two
 *   canon refs      do the canon event ids it cites exist
 *   consequence     does the plan carry the divergence forward, or does it
 *                   change one thing and then forget about it
 */
import { Db } from '../../../../fanfable/src/db.ts';
import * as controller from '../../../../fanfable/src/plan/controller.ts';
import * as graph from '../../../../fanfable/src/graph.ts';
import * as lore from '../../../../fanfable/src/lore.ts';
import * as planner from '../../../../fanfable/src/plan/planner.ts';
import { extractJson } from '../../../../fanfable/src/json.ts';
import type { RecordingClient } from '../harness.ts';

export interface PlanningResult {
  jsonValid: boolean;
  chapters: number;
  chapterCountOk: boolean;
  /** The share of chapters with a goal, a synopsis and at least one scene. */
  completeChapters: number;
  goalPresent: number;
  synopsisPresent: number;
  scenesPresent: number;
  /** The share of chapters that separate what the canon establishes from what the story changes. */
  canonAuSplit: number;
  openQuestions: number;
  canonRefs: number;
  canonRefsValid: number;
  /** The share of the premise's content words that appear in the plan. */
  premiseCoverage: number;
  /** Does the plan keep the divergence? */
  divergenceHonoured: boolean;
  /** The share of later chapters whose text says something follows from something. */
  consequencePlanning: number;
  notes: number;
  ms: number;
  promptTokens: number;
  completionTokens: number;
}

const STOP = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'they', 'have', 'been', 'were', 'his', 'her',
  'him', 'she', 'its', 'their', 'into', 'than', 'then', 'when', 'what', 'will', 'would', 'could',
  'should', 'about', 'which', 'there', 'here', 'every', 'story', 'chapter', 'story',
]);

function contentWords(text: string): string[] {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
}

export async function runPlanning(
  db: Db,
  client: RecordingClient,
  projectId: number,
  req: {
    premise: string;
    divergence: string;
    chapterCount: number;
    preferences?: Record<string, string>;
  },
): Promise<{ result: PlanningResult; outline: planner.Outline | null; raw: string }> {
  // The context is built exactly as the controller builds it, and it contains
  // no model calls at all: the canon brief is a search, the graph context is a
  // walk over the database. So every model is given the same context.
  // The same index the controller builds for a plan: the events the premise
  // touches, inside a character budget.
  const canonEvents = controller.selectCanonEvents(db, projectId, req.premise, req.divergence);
  const passages = await lore.searchCanon(db, projectId, `${req.premise} ${req.divergence}`, { limit: 8 });
  const brief = passages.map((p) => p.text).join('\n\n');
  const graphContext = graph.buildGraphContext(db, projectId, {
    query: `${req.premise} ${req.divergence}`,
    focus: graph.terms(`${req.premise} ${req.divergence}`).slice(0, 4),
    hops: 1,
    maxNodes: 30,
    maxWords: 800,
  }).text;

  const started = Date.now();
  const data = await planner.draftOutline(client, {
    premise: req.premise,
    divergence: req.divergence,
    chapterCount: req.chapterCount,
    preferences: req.preferences,
    canonBrief: brief,
    graphContext,
    canonEvents: canonEvents.map((e) => ({ id: e.id, title: e.title, summary: e.summary })),
  });
  const ms = Date.now() - started;

  const raw = client.calls[client.calls.length - 1]?.output ?? '';
  const parsed = extractJson<Record<string, unknown>>(raw);
  const jsonValid = !!parsed && Array.isArray(parsed.chapters);

  const validIds = new Set(canonEvents.map((e) => e.id));
  const chapters = data.chapters;

  let goalPresent = 0;
  let synopsisPresent = 0;
  let scenesPresent = 0;
  let canonAuSplit = 0;
  let openQuestions = 0;
  let notes = 0;
  let consequencePlanning = 0;
  let canonRefs = 0;
  let canonRefsValid = 0;

  const consequenceWords = /\b(because|after|since|so that|consequence|result|therefore|leads to|follows|because of|as a result)\b/i;

  chapters.forEach((ch, i) => {
    if (ch.goal.trim()) goalPresent++;
    if (ch.synopsis.trim()) synopsisPresent++;
    if (ch.scenes.length) scenesPresent++;
    if ((ch.canon?.length ?? 0) > 0 && (ch.au?.length ?? 0) > 0) canonAuSplit++;
    openQuestions += ch.openQuestions?.length ?? 0;
    if (ch.notes.trim()) notes++;
    if (i > 0 && consequenceWords.test(`${ch.goal} ${ch.synopsis} ${ch.notes}`)) consequencePlanning++;
    const ids = [...(ch.canonEventIds ?? []), ...ch.scenes.flatMap((s) => s.canonEventIds ?? [])];
    canonRefs += ids.length;
    canonRefsValid += ids.filter((id) => validIds.has(id)).length;
  });

  const outlineText = JSON.stringify(data).toLowerCase();
  const premiseWords = contentWords(req.premise);
  const covered = premiseWords.filter((w) => outlineText.includes(w)).length;

  const result: PlanningResult = {
    jsonValid,
    chapters: chapters.length,
    chapterCountOk: chapters.length === req.chapterCount,
    completeChapters: chapters.length
      ? (goalPresent + synopsisPresent + scenesPresent) / (3 * chapters.length)
      : 0,
    goalPresent: chapters.length ? goalPresent / chapters.length : 0,
    synopsisPresent: chapters.length ? synopsisPresent / chapters.length : 0,
    scenesPresent: chapters.length ? scenesPresent / chapters.length : 0,
    canonAuSplit: chapters.length ? canonAuSplit / chapters.length : 0,
    openQuestions,
    canonRefs,
    canonRefsValid: canonRefs ? canonRefsValid / canonRefs : 1,
    premiseCoverage: premiseWords.length ? covered / premiseWords.length : 0,
    divergenceHonoured: /slytherin/.test(outlineText),
    consequencePlanning: chapters.length > 1 ? consequencePlanning / (chapters.length - 1) : 0,
    notes,
    ms,
    promptTokens: client.promptTokens,
    completionTokens: client.completionTokens,
  };

  return {
    result,
    outline: {
      id: 0,
      version: 0,
      status: 'draft',
      premise: data.premise,
      divergence: data.divergence,
      divergenceRef: data.divergenceRef,
      canonRefs: data.canonRefs,
      structure: data.structure,
      chapters: data.chapters,
      preferences: data.preferences,
      createdAt: '',
      updatedAt: '',
      approvedAt: null,
    },
    raw,
  };
}
