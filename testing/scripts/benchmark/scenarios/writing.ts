/**
 * Chapter writing scenario.
 *
 * The model is given the same context every time: the same canon brief, the
 * same graph context, the same story memory, the same approved outline, the
 * same target length. The context is assembled once, by the baseline model, and
 * handed to every candidate, so that what is being compared is the prose and
 * not the model's ability to gather its own material.
 *
 * What is measured:
 *   length           did it write the chapter it was asked for
 *   repetition       did it say the same thing twice
 *   copying          did it lift the source's sentences
 *   outline          did it write the chapter the plan describes
 *   canon/au         did it keep the divergence, or drift back to the canon
 *   invention        did it make up names
 */
import { Db } from '../../../../fanfable/src/db.ts';
import * as controller from '../../../../fanfable/src/plan/controller.ts';
import * as planner from '../../../../fanfable/src/plan/planner.ts';
import type { LlmClient } from '../../../../fanfable/src/llm.ts';
import type { RecordingClient } from '../harness.ts';
import { copiedRate, inventedNameRate, proseStats, repetitionRate, words } from '../measure.ts';

const STOP = new Set([
  'the', 'and', 'that', 'with', 'from', 'they', 'have', 'been', 'were', 'his', 'her', 'him', 'she',
  'its', 'their', 'into', 'than', 'then', 'when', 'what', 'will', 'would', 'could', 'should',
  'about', 'which', 'there', 'here', 'this', 'these', 'those', 'said', 'says', 'say', 'after',
  'before', 'because', 'while', 'where', 'every', 'never', 'always', 'under', 'over', 'through',
]);

function contentWords(text: string): string[] {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 4 && !STOP.has(w));
}

export interface WritingResult {
  chapter: number;
  words: number;
  target: number;
  lengthRatio: number;
  repetition: number;
  copied: number;
  inventedNames: number;
  inventedNameList: string;
  /** The share of the outline's characters the chapter names. */
  charactersPresent: number;
  /** The share of the outline's scenes the chapter actually covers. */
  sceneCoverage: number;
  /** The share of the outline's canon bullets the chapter reflects. */
  canonCoverage: number;
  /** The share of the outline's AU bullets the chapter reflects. */
  auCoverage: number;
  /** Sentences that put Harry in Gryffindor, which this story does not do. */
  canonLeak: number;
  /** Does the chapter keep the divergence at all? */
  divergenceKept: boolean;
  /** Characters of raw protocol or metadata left in the prose. */
  protocolLeak: number;
  /** The share of words inside quotation marks. */
  dialogueShare: number;
  meanSentenceWords: number;
  typeTokenRatio: number;
  repeatedOpenings: number;
  longSentences: number;
  paragraphs: number;
  contextRequests: number;
  ms: number;
  promptTokens: number;
  completionTokens: number;
}

/** How much of a piece of text the chapter reflects. */
function coverage(text: string, bodyLower: string): number {
  const terms = contentWords(text);
  if (!terms.length) return 1;
  const hit = terms.filter((t) => bodyLower.includes(t)).length;
  return hit / terms.length;
}

export async function runWriting(
  db: Db,
  modelClient: RecordingClient,
  contextLlm: LlmClient,
  projectId: number,
  opts: {
    chapterNumber: number;
    chapter: planner.ChapterOutline;
    bundle: controller.ContextBundle;
    targetWords: number;
    sourceText: string;
  },
): Promise<{ result: WritingResult; body: string }> {
  const started = Date.now();
  const written = await controller.writeChapter(db, modelClient, projectId, {
    chapterNumber: opts.chapterNumber,
    bundle: opts.bundle,
    contextLlm,
    targetWords: opts.targetWords,
    skipContinuity: true,
  });
  const ms = Date.now() - started;
  const body = written.chapter.body ?? '';
  const bodyLower = body.toLowerCase();

  const outline = opts.chapter;
  const characters = outline.characters ?? [];
  // A character counts as present if the chapter names them: the full name, the
  // surname, or the first name. Models write "Ron Weasley" and "Ron" in the
  // same breath, and a metric that insists on the full name measures spelling
  // rather than presence.
  const named = characters.filter((c) => {
    const tokens = c.split(/\s+/).filter((t) => t.toLowerCase() !== 'the' && t.length > 2);
    const candidates = [c, ...tokens];
    return candidates.some((candidate) => bodyLower.includes(candidate.toLowerCase()));
  });

  const sceneHits = (outline.scenes ?? []).filter((s) => {
    const terms = contentWords(`${s.title} ${s.summary}`);
    if (!terms.length) return false;
    const hit = terms.filter((t) => bodyLower.includes(t)).length;
    return hit / terms.length >= 0.25;
  });

  const canonHits = (outline.canon ?? []).filter((b) => coverage(b, bodyLower) >= 0.3);
  const auHits = (outline.au ?? []).filter((b) => coverage(b, bodyLower) >= 0.3);

  // Canon leak: a sentence that puts Harry in Gryffindor. In this story he is
  // in Slytherin, so a sentence that says otherwise contradicts the plan.
  //
  // A sentence that merely mentions Gryffindor is not a leak: Neville really
  // is in Gryffindor, and so are Ron and Hermione. What counts is a sentence
  // that says Harry was put there.
  const sentences = body.split(/(?<=[.!?])\s+/);
  const leaks = sentences.filter((s) => {
    const l = s.toLowerCase();
    if (!l.includes('gryffindor') || !l.includes('harry')) return false;
    // A placement, with Harry on one side of it and Gryffindor on the other.
    const placed =
      /harry[^.]{0,60}?(sorted|placed|put|chosen|selected|went|belonged|house)[^.]{0,40}?gryffindor/.test(l) ||
      /gryffindor[^.]{0,40}?(was|is|are)[^.]{0,25}?harry/.test(l);
    if (!placed) return false;
    // A negation is not a leak.
    if (/(not|never|rather than|instead of|no longer|would have been|nobody)/.test(l)) return false;
    return true;
  });

  // Protocol leakage: raw request or metadata blocks left in the prose.
  const protocolLeak = (body.match(/\[\[\s*(CONTEXT|META)\s*\]\]/gi) ?? []).length * 10
    + (/"events"\s*:|"knowledge"\s*:|"canon_changes"\s*:/.test(body) ? 200 : 0);

  const stats = proseStats(body, opts.sourceText);

  const result: WritingResult = {
    chapter: opts.chapterNumber,
    words: words(body),
    target: opts.targetWords,
    lengthRatio: words(body) / opts.targetWords,
    repetition: repetitionRate(body),
    copied: copiedRate(body, opts.sourceText),
    inventedNames: inventedNameRate(body, opts.sourceText),
    inventedNameList: stats.inventedNames.slice(0, 12).join(', '),
    charactersPresent: characters.length ? named.length / characters.length : 1,
    sceneCoverage: outline.scenes?.length ? sceneHits.length / outline.scenes.length : 0,
    canonCoverage: outline.canon?.length ? canonHits.length / outline.canon.length : 0,
    auCoverage: outline.au?.length ? auHits.length / outline.au.length : 0,
    canonLeak: leaks.length,
    divergenceKept: /slytherin/i.test(body),
    protocolLeak,
    dialogueShare: stats.dialogueShare,
    meanSentenceWords: stats.meanSentenceWords,
    typeTokenRatio: stats.typeTokenRatio,
    repeatedOpenings: stats.repeatedOpenings,
    longSentences: stats.longSentences,
    paragraphs: stats.paragraphs,
    contextRequests: written.trace.length,
    ms,
    promptTokens: modelClient.promptTokens,
    completionTokens: modelClient.completionTokens,
  };

  return { result, body };
}

/** Remove a chapter and everything derived from it, so the next model starts clean. */
export function removeChapter(db: Db, projectId: number, chapterNumber: number): void {
  const chapter = controller.getChapter(db, projectId, chapterNumber);
  if (!chapter) return;
  db.run('DELETE FROM continuity_issue WHERE project_id = ? AND chapter_id = ?', projectId, chapter.id);
  db.run('DELETE FROM context_request WHERE project_id = ? AND chapter_id = ?', projectId, chapter.id);
  db.run('DELETE FROM chapter_revision WHERE chapter_id = ?', chapter.id);
  db.run('DELETE FROM chapter WHERE id = ?', chapter.id);
}
