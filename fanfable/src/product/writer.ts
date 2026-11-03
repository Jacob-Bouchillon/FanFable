/**
 * Story Writer.
 *
 * Writes scenes and chapters sequentially from the approved plan, using canon
 * passages, story memory, character states and user instructions.
 *
 * Dynamic context: the writer may stop mid-draft and ask for more information.
 * It does so with a structured request block that the application controller
 * resolves (through the Lore Researcher or the Story Memory Manager) and feeds
 * back in. Requests are de-duplicated and capped so a model cannot loop.
 */
import { extractJson } from '../core/json.ts';
import type { ChatRequest, LlmClient } from '../core/llm.ts';
import type { ChapterOutline, Outline, OutlinePreferences } from '../plan/planner.ts';
import { dedupeParagraphs, similarity, wordCount } from '../core/text.ts';
import type { RequestTraceContext, WriteTrace } from '../trace/write-trace.ts';

/* ------------------------------------------------------------ context protocol */

export type ContextKind = 'lore' | 'memory' | 'canon' | 'character' | 'au' | 'graph';

export interface ContextRequest {
  kind: ContextKind;
  query: string;
  limit?: number;
  character?: string;
}

export interface ResolvedContext {
  label: string;
  kind: ContextKind;
  content: string;
}

export interface ContextLimits {
  /**
   * Maximum additional writer calls caused by context requests, across the
   * whole chapter. Every part always gets one initial writer call first.
   */
  maxRounds: number;
  /** Maximum distinct requests honoured per scene. */
  maxRequests: number;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = { maxRounds: 4, maxRequests: 10 };

/** Pull context requests out of a writer message. */
export function parseContextRequests(text: string): ContextRequest[] {
  const out: ContextRequest[] = [];
  const pattern = /\[\[\s*CONTEXT\s*\]\]([\s\S]*?)\[\[\s*END\s*\]\]/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text ?? '')) !== null) {
    const parsed = extractJson<Record<string, unknown>>(m[1]);
    if (!parsed) continue;
    const kind = String(parsed.kind ?? 'lore').toLowerCase() as ContextKind;
    const query = String(parsed.query ?? parsed.subject ?? '').trim();
    if (!query) continue;
    const req: ContextRequest = {
      kind: (['lore', 'memory', 'canon', 'character', 'au', 'graph'].includes(kind) ? kind : 'lore') as ContextKind,
      query,
    };
    if (parsed.limit !== undefined) req.limit = Number(parsed.limit);
    if (parsed.character) req.character = String(parsed.character);
    out.push(req);
  }
  return out;
}

/** Remove request blocks from prose that should be saved to the chapter file. */
export function stripProtocolBlocks(text: string): string {
  return (text ?? '')
    .replace(/\[\[\s*CONTEXT\s*\]\][\s\S]*?\[\[\s*END\s*\]\]/gi, '')
    .replace(/\[\[\s*META\s*\]\][\s\S]*?\[\[\s*END\s*\]\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Remove a metadata object that lost its markers.
 *
 * The protocol is a `[[META]]` block, but a model will sometimes write the
 * JSON straight onto the end of the prose. Left alone, that JSON is saved as
 * the last paragraph of the chapter — and a truncated one at that, because
 * the model ran out of tokens in the middle of it.
 */
export function stripTrailingMeta(text: string): string {
  const body = text ?? '';
  const metaKeys = [
    'events',
    'knowledge',
    'states',
    'canon_changes',
    'canonChanges',
    'threads',
    'relationships',
    'motivations',
    'secrets',
    'links',
    'summary',
  ];
  // The last plausible start of a JSON object: a brace at the beginning of a
  // line, or a brace that follows the end of a sentence.
  const candidates: number[] = [];
  const braceAt = body.lastIndexOf('{');
  if (braceAt >= 0) candidates.push(braceAt);
  const lineStart = body.lastIndexOf('\n{');
  if (lineStart >= 0) candidates.push(lineStart + 1);
  for (const at of candidates.sort((a, b) => b - a)) {
    const candidate = body.slice(at);
    // It has to look like JSON: a brace immediately followed by a key. Prose
    // that happens to contain a brace, or a character who says the word
    // "events", must not be mistaken for metadata and cut off.
    if (!/^\s*\{\s*"/.test(candidate)) continue;
    const head = candidate.slice(0, 240);
    if (!metaKeys.some((k) => head.includes(`"${k}"`))) continue;
    return body.slice(0, at).trim();
  }
  return body.trim();
}

/** Parse the optional trailing metadata block the writer may emit. */
export function parseMeta(text: string): Record<string, unknown> | null {
  const m = /\[\[\s*META\s*\]\]([\s\S]*?)\[\[\s*END\s*\]\]/i.exec(text ?? '');
  if (!m) return null;
  return extractJson<Record<string, unknown>>(m[1]);
}

export function requestKey(req: ContextRequest): string {
  return `${req.kind}:${req.query.toLowerCase().trim()}`;
}

/* ------------------------------------------------------------------ prompts */

const WRITER_SYSTEM = `You are the Story Writer for a long-form fanfiction project.
You write the next scene or chapter of an alternate-universe story, in sequence, from an
approved plan, using the source material, the story memory and the author's instructions.

Rules of the craft:
- Follow the approved chapter outline closely. The outline is the plan; the prose is the execution.
- Length matters: write the full requested length. Do not stop after a setup beat; a chapter
  has a beginning, a middle and an aftermath, and every one of them must be on the page.
- Stay in character: voice, mannerisms, motivations and knowledge must match what is recorded.
- Keep physical and chronological plausibility: people cannot be where they were not, cannot
  know what they have not learned, and cannot heal from injuries they have not had.
- Respect the AU divergence: events the plan changes must be changed on the page, and the
  consequences of that change must follow through.
- If a scene adapts a canon scene, make the adaptation legible: what is the same, what is
  different, and why. Never present an AU event as if it were the original.
- When you use canon material, rework the words. Keep the beat, the facts and the voice of
  the original, but write fresh sentences. Do not paste source sentences word for word
  unless the outline explicitly calls for a scene that is reproduced unchanged.
- Never invent canonical facts. If the canon evidence supplied does not support a detail,
  do not state it as canon. If a detail is not in the evidence, keep it generic or omit it.
- Write the prose only. No headings, no "Chapter N" title unless the plan gives a title,
  no explanations about the process.

CONTEXT PROTOCOL
If you need information that is not in the prompt, you may request it. Insert a request block
anywhere in your output:

[[CONTEXT]]
{"kind": "lore", "query": "what the source says about the night of the raid"}
[[END]]

kinds:
- "lore"     -> search the original source material (facts, scenes, dialogue, world rules)
- "memory"   -> search what already happened in this story (previous events, decisions)
- "character"-> what a specific character knows, believes or has done (add "character": "Name")
- "canon"    -> the exact wording of a specific canon scene you are adapting
- "au"       -> what this story has already changed relative to canon

Rules for requests:
- Ask only when the answer would change what you write.
- Maximum two request blocks per turn, one question each.
- Prefer "graph" over "lore" when you need to know how things are connected
  rather than what the source says about one thing.
- The controller answers you in the next message; continue the scene from where you stopped.
- Do not invent the answer yourself.

METADATA
After the prose, you may append a metadata block describing what the scene established:

[[META]]
{"events":[{"title":"","summary":"","story_time":"","story_order":0,"participants":[""],"location":"","kind":"event","adapts_canon_event_id":null,"divergence_note":""}],
 "knowledge":[{"character":"","fact":"","certainty":"knows","evidence":""}],
 "states":[{"character":"","location":"","condition":"","emotional":""}],
 "canon_changes":[{"canon_event_id":1,"change_type":"altered","description":""}]}
[[END]]

Only include metadata you are sure about. If you emit no metadata block the controller will
extract state itself.`;

function buildWriterPrompt(ctx: {
  chapter: ChapterOutline | undefined;
  chapterNumber: number;
  outline: Outline | undefined;
  memory: string;
  canon: string;
  connected?: string;
  previousChapterTail: string;
  userInstructions: string;
  sceneNumber?: number;
  sceneSummary?: string;
  preferences: OutlinePreferences;
  resumed?: boolean;
  /** Which part of the chapter this is, when the chapter is written in parts. */
  part?: { index: number; total: number; target: number; previous: string; beats: string[] };
}): string {
  const parts: string[] = [];

  const target = ctx.chapter?.targetWords ?? 2500;
  if (ctx.part) {
    const { index, total, target: partTarget, previous, beats } = ctx.part;
    parts.push(
      `## TASK\nWrite part ${index} of ${total} of chapter ${ctx.chapterNumber}. ` +
        `This part is about ${partTarget} words of prose — roughly ` +
        `${Math.max(3, Math.round(partTarget / 180))} substantial paragraphs.\n` +
        (previous
          ? `## WHAT HAS HAPPENED SO FAR IN THIS CHAPTER\n${previous}\n\n` +
            `Continue from exactly where that stops. Do not repeat it, do not restate it, and do not ` +
            `begin a new scene unless the outline says this part is where the scene turns.`
          : `This is the opening of the chapter. Establish the situation, the place and the people, ` +
            `and end it at a point where something is about to happen.`) +
        (beats?.length
          ? `\n\n## BEATS ALREADY WRITTEN — do not write these again, in any form\n${beats
              .map((b) => `- ${b}`)
              .join('\n')}`
          : ''),
    );
  } else {
    parts.push(
      `## TASK\nWrite ${ctx.sceneSummary ? 'the scene described below' : 'the next chapter'} ` +
        `(chapter ${ctx.chapterNumber}) of the story. Target length: ` +
        `${target} words — aim for at least that many words of prose, ` +
        `roughly ${Math.max(4, Math.round(target / 180))} substantial paragraphs. ` +
        `Do not stop early.`,
    );
  }

  if (ctx.outline) {
    parts.push(
      `## STORY PREMISE\n${ctx.outline.premise}\n\n## AU DIVERGENCE POINT\n${ctx.outline.divergence || '(not yet decided)'}` +
        (ctx.outline.divergenceRef ? `\n(anchored to canon reference: ${ctx.outline.divergenceRef})` : ''),
    );
  }

  if (ctx.chapter) {
    parts.push(
      `## APPROVED CHAPTER OUTLINE\n` +
        `title: ${ctx.chapter.title}\n` +
        `goal: ${ctx.chapter.goal}\n` +
        `synopsis: ${ctx.chapter.synopsis}\n` +
        (ctx.chapter.characters.length ? `characters: ${ctx.chapter.characters.join(', ')}\n` : '') +
        (ctx.chapter.characterArcs ? `character arcs: ${ctx.chapter.characterArcs}\n` : '') +
        (ctx.chapter.notes ? `notes from the planner: ${ctx.chapter.notes}\n` : '') +
        (ctx.chapter.scenes.length
          ? `scenes:\n${ctx.chapter.scenes
              .map(
                (s, i) =>
                  `${i + 1}. ${s.title}${s.pov ? ` (pov ${s.pov})` : ''}${s.location ? ` @ ${s.location}` : ''}` +
                  `${s.summary ? `: ${s.summary}` : ''}${s.adaptations ? `\n   adaptation: ${s.adaptations}` : ''}`,
              )
              .join('\n')}`
          : ''),
    );
  }

  if (ctx.sceneSummary) parts.push(`## SCENE TO WRITE\n${ctx.sceneSummary}`);

  if (ctx.preferences && Object.keys(ctx.preferences).length) {
    parts.push(
      `## WRITING PREFERENCES\n${Object.entries(ctx.preferences)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join('\n')}`,
    );
  }

  if (ctx.memory.trim()) parts.push(`## STORY MEMORY (existing story state)\n${ctx.memory}`);
  if ((ctx.connected ?? '').trim()) {
    parts.push(
      `## CONNECTED CONTEXT (who and what this scene touches, and how it all connects)\n` +
        `${ctx.connected ?? ''}\n\n` +
        'Use this to keep the scene consistent with what has already been established. ' +
        'It shows what is connected, not necessarily what happens next.',
    );
  }
  if (ctx.canon.trim()) {
    parts.push(
      `## CANON EVIDENCE (reference material from the source — facts and beats only)\n` +
        `Use these passages to get names, places, objects, rules and events right.\n` +
        `Do not reuse their sentences: rework every line in the story's own voice.\n\n` +
        ctx.canon,
    );
  }
  if (ctx.previousChapterTail.trim()) {
    parts.push(`## END OF THE PREVIOUS CHAPTER (for continuity)\n${ctx.previousChapterTail}`);
  }
  if (ctx.userInstructions.trim()) {
    parts.push(`## AUTHOR INSTRUCTIONS FOR THIS SCENE\n${ctx.userInstructions}`);
  }
  if (ctx.resumed) {
    parts.push(
      '## NOTE\nYour earlier attempt was interrupted. Continue the scene from where you stopped; ' +
        'do not restart it.',
    );
  }

  parts.push(
    '## OUTPUT\nWrite the prose now. End the scene when the scene is finished.\n' +
      'FORMAT: plain prose paragraphs only. No markdown headings, no "#" characters, no ' +
      'chapter titles, no scene titles, no horizontal rules, no commentary, no self-description ' +
      'of the writing process.\n' +
      'Do not summarise the scene and do not explain what you did. Do not request context unless ' +
      'you genuinely cannot continue without more information.',
  );
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------- writing */

export interface WriteOptions {
  chapterNumber: number;
  chapter?: ChapterOutline;
  outline?: Outline;
  memoryText: string;
  canonText: string;
  /** Connected context from the graph. */
  connectedText?: string;
  previousChapterTail?: string;
  userInstructions?: string;
  sceneSummary?: string;
  preferences?: OutlinePreferences;
  targetWords?: number;
  /** Stop asking for continuations once this share of the target is reached. */
  minLengthRatio?: number;
  /** Maximum number of "keep going" rounds. */
  maxContinuations?: number;
  /**
   * How similar two paragraphs have to be before the second is treated as a
   * repeat. Higher keeps more text; lower removes more.
   */
  dedupeThreshold?: number;
  /**
   * Write the chapter in this many parts.
   *
   * A local model asked for a whole chapter at once tends to loop: it writes
   * a scene, then writes the same scene again. Writing the chapter in parts —
   * each part continuing the one before — keeps the length predictable and
   * gives the model a smaller thing to hold in mind.
   */
  segments?: number;
  /** Optional diagnostic write trace. Tracing never changes writing behavior. */
  trace?: WriteTrace;
}

export interface WriteResult {
  prose: string;
  meta: Record<string, unknown> | null;
  requests: ContextRequest[];
  /** Human-readable trace of what the writer asked for and what it got. */
  trace: { request: ContextRequest; answer: ResolvedContext }[];
  /**
   * Total writer calls: one initial call per requested part plus additional
   * context-request calls. Continuation calls are counted separately.
   */
  rounds: number;
  words: number;
  stats: {
    /** Words before the near-duplicate sweep. */
    rawWords: number;
    /** Times the writer was asked to carry on. */
    continuations: number;
    /** Paragraphs removed as near-duplicates. */
    droppedParagraphs: number;
    /** Parts that received their guaranteed initial writer call. */
    initialCalls: number;
    /** Context-request writer calls beyond the initial part calls. */
    additionalCalls: number;
    /** Requests recorded unanswered because no additional call remained. */
    unansweredRequests: number;
  };
}

export type RequestResolver = (
  req: ContextRequest,
  trace?: RequestTraceContext,
) => Promise<ResolvedContext | null>;

/**
 * Write a chapter, resolving context requests along the way.
 *
 * The loop is bounded by both a round cap and a distinct-request cap; repeated
 * requests are answered from the cache rather than hitting the database again.
 */
/**
 * The beats a piece of prose has already covered.
 *
 * A model that is asked to continue will sometimes write the same moment
 * again in different words. Saying plainly what has already happened stops
 * that far more effectively than looking for duplicates afterwards.
 */
export function beatsSoFar(prose: string, limit = 12): string[] {
  const out: string[] = [];
  for (const paragraph of (prose ?? '').split(/\n{2,}/)) {
    const clean = paragraph.replace(/\s+/g, ' ').trim();
    if (clean.length < 18) continue;
    const sentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
    out.push(sentence.slice(0, 140));
    if (out.length >= limit) break;
  }
  return out;
}

/** Story text from one writer response, without context/meta protocol. */
function storyText(text: string): string {
  return stripTrailingMeta(stripProtocolBlocks(text)).trim();
}

function splitParagraphs(text: string): string[] {
  return (text ?? '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
}

function splitSentences(text: string): string[] {
  return (text ?? '').split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
}

function overlapNormal(text: string): string {
  return (text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Longest suffix of `existing` that equals the prefix of `next`. */
function suffixPrefixOverlap(existing: string[], next: string[]): number {
  const max = Math.min(existing.length, next.length);
  for (let count = max; count >= 1; count--) {
    let matches = true;
    for (let i = 0; i < count; i++) {
      if (overlapNormal(existing[existing.length - count + i]!) !== overlapNormal(next[i]!)) {
        matches = false;
        break;
      }
    }
    if (matches) return count;
  }
  return 0;
}

interface SinglePartContribution {
  text: string;
  addedText: string;
  addedChars: number;
  addedWords: number;
  overlapChars: number;
  disposition: 'included' | 'superseded' | 'empty';
  reason: string;
}

/**
 * Add a single-part response to the prose already written. Distinct story text
 * is retained; exact paragraph/sentence overlap is removed so a follow-up that
 * restates the previous paragraph does not duplicate it in the chapter.
 */
function appendSinglePartStory(existing: string, text: string): SinglePartContribution {
  const next = (text ?? '').trim();
  if (!next) {
    return {
      text: existing,
      addedText: '',
      addedChars: 0,
      addedWords: 0,
      overlapChars: 0,
      disposition: 'empty',
      reason: 'empty-or-protocol-only',
    };
  }
  if (!existing.trim()) {
    return {
      text: next,
      addedText: next,
      addedChars: next.length,
      addedWords: wordCount(next),
      overlapChars: 0,
      disposition: 'included',
      reason: 'single-part-contribution',
    };
  }
  const existingNorm = overlapNormal(existing);
  const nextNorm = overlapNormal(next);
  if (nextNorm && existingNorm.includes(nextNorm)) {
    return {
      text: existing,
      addedText: '',
      addedChars: 0,
      addedWords: 0,
      overlapChars: next.length,
      disposition: 'superseded',
      reason: 'duplicate-output',
    };
  }

  const existingParagraphs = splitParagraphs(existing);
  const nextParagraphs = splitParagraphs(next);
  const paragraphOverlap = suffixPrefixOverlap(existingParagraphs, nextParagraphs);
  const remainingParagraphs = nextParagraphs.slice(paragraphOverlap);
  const existingSentences = splitSentences(existing);
  if (remainingParagraphs.length) {
    const firstSentences = splitSentences(remainingParagraphs[0]!);
    const sentenceOverlap = suffixPrefixOverlap(existingSentences, firstSentences);
    if (sentenceOverlap) {
      const keptSentences = firstSentences.slice(sentenceOverlap);
      if (keptSentences.length) remainingParagraphs[0] = keptSentences.join(' ');
      else remainingParagraphs.shift();
    }
  }
  const remaining = remainingParagraphs.filter(Boolean).join('\n\n').trim();
  if (!remaining) {
    return {
      text: existing,
      addedText: '',
      addedChars: 0,
      addedWords: 0,
      overlapChars: next.length,
      disposition: 'superseded',
      reason: 'duplicate-output',
    };
  }
  return {
    text: `${existing.trimEnd()}\n\n${remaining}`,
    addedText: remaining,
    addedChars: remaining.length,
    addedWords: wordCount(remaining),
    overlapChars: Math.max(0, next.length - remaining.length),
    disposition: 'included',
    reason: 'single-part-contribution',
  };
}

export async function writeChapter(
  llm: LlmClient,
  opts: WriteOptions,
  resolve: RequestResolver,
  limits: ContextLimits = DEFAULT_CONTEXT_LIMITS,
): Promise<WriteResult> {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  const answered = new Map<string, ResolvedContext>();
  const trace: { request: ContextRequest; answer: ResolvedContext }[] = [];
  let writerCalls = 0;
  let initialCalls = 0;
  let additionalCalls = 0;
  let unansweredRequests = 0;
  let requestSeq = 0;
  let meta: Record<string, unknown> | null = null;
  let prose = '';
  let requests: ContextRequest[] = [];
  const traceSink = opts.trace;

  type MainOutput = {
    callId: string;
    disposition: 'included' | 'superseded' | 'empty';
    reason: string;
    contributedText: string;
    overlapChars: number;
  };
  const mainOutputs: MainOutput[] = [];
  const continuationOutputs: { callId: string; text: string; attempt: number }[] = [];

  const target = opts.targetWords ?? opts.chapter?.targetWords ?? 2500;
  // The chapter is written in one go by default: a single coherent generation
  // reads better than stitched-together parts. When the model loops, the
  // repetition is removed and the lost material is written again, so the
  // chapter comes out the right length. Parts are available for chapters that
  // need them.
  const segments = Math.max(1, Math.min(opts.segments ?? 1, 6));
  // Every part gets one initial call. These are follow-up calls caused by
  // context requests, capped across the whole chapter.
  const maxAdditionalCalls = Number.isFinite(limits.maxRounds)
    ? Math.max(0, Math.floor(limits.maxRounds))
    : 0;
  const maxRequests = Number.isFinite(limits.maxRequests)
    ? Math.max(0, Math.floor(limits.maxRequests))
    : 0;

  for (let part = 0; part < segments; part++) {
    const partTarget = Math.round(target / segments);
    const partNumber = part + 1;
    traceSink?.partStarted(partNumber, segments, target, partTarget);
    let partCalls = 0;
    initialCalls++;
    let needPrompt = true;

    // The first pass through this loop is the part's guaranteed initial call.
    // Later passes are context-request follow-ups and consume the chapter-wide
    // additional-call budget. Follow-ups continue the existing conversation:
    // they must not append a second fresh task prompt.
    while (true) {
      const roundNumber = ++writerCalls;
      const roundSpan = traceSink?.roundStarted(partNumber, roundNumber);
      if (needPrompt) {
        const partPrevious = segments > 1 && prose ? stripProtocolBlocks(prose).slice(-2400) : '';
        const partBeats = segments > 1 ? beatsSoFar(prose) : [];
        const prompt = buildWriterPrompt({
          chapter: opts.chapter,
          chapterNumber: opts.chapterNumber,
          outline: opts.outline,
          memory: opts.memoryText,
          canon: opts.canonText,
          connected: opts.connectedText ?? '',
          previousChapterTail: opts.previousChapterTail ?? '',
          userInstructions: opts.userInstructions ?? '',
          sceneSummary: opts.sceneSummary,
          preferences: opts.preferences ?? {},
          part:
            segments > 1
              ? {
                  index: partNumber,
                  total: segments,
                  target: partTarget,
                  previous: partPrevious,
                  beats: partBeats,
                }
              : undefined,
        });

        traceSink?.promptBuilt(roundSpan!, prompt, {
          part: partNumber,
          total: segments,
          round: roundNumber,
          messageCount: messages.length,
          previousChars: partPrevious.length,
          beatCount: partBeats.length,
        });
        messages.push({ role: 'user', content: prompt });
        traceSink?.promptMessage(roundSpan!, messages.length - 1, 'user', 'built', prompt, {
          part: partNumber,
          round: roundNumber,
        });
        needPrompt = false;
      }
      const request: ChatRequest = {
        system: WRITER_SYSTEM,
        messages,
        temperature: 0.85,
        maxTokens: Math.max(1200, Math.ceil(partTarget * 1.8)),
      };
      const callId = traceSink?.modelStarted(request, {
        role: 'writer',
        part: partNumber,
        round: roundNumber,
        parentSpanId: roundSpan ?? 'sp-write',
        llm,
      });
      let res;
      try {
        res = await llm.chat(request);
        if (callId) traceSink?.modelCompleted(callId, res);
      } catch (err) {
        if (callId) traceSink?.modelFailed(callId, err);
        throw err;
      }
      traceSink?.roundCompleted(partNumber, roundNumber);
      partCalls++;
      // Keep the actual assistant response in the conversation before any
      // answer/notice user message or next part prompt.
      messages.push({ role: 'assistant', content: res.text });

      const story = storyText(res.text);
      if (segments > 1) {
        // Clean each part before assembling it. Stripping metadata from the
        // concatenated raw responses can let an early bare metadata object
        // cut off every later part.
        if (story) prose = prose ? `${prose}\n\n${story}` : story;
        if (callId) {
          mainOutputs.push({
            callId,
            disposition: story ? 'included' : 'empty',
            reason: story ? 'part-output' : 'empty-part-output',
            contributedText: story,
            overlapChars: 0,
          });
        }
      } else {
        // Single-part writes must keep every distinct response. Replacing the
        // whole body here loses everything written before a context request.
        const contribution = appendSinglePartStory(prose, story);
        prose = contribution.text;
        if (callId) {
          mainOutputs.push({
            callId,
            disposition: contribution.disposition,
            reason: contribution.reason,
            contributedText: contribution.addedText,
            overlapChars: contribution.overlapChars,
          });
        }
      }

      const parsedMeta = parseMeta(res.text);
      if (parsedMeta) meta = parsedMeta;
      requests = parseContextRequests(res.text);
      if (!requests.length) break;

      const parsed = requests.map((req) => {
        const seq = ++requestSeq;
        const ctx: RequestTraceContext | undefined = traceSink
          ? {
              requestId: traceSink.requestKey(req),
              seq,
              part: partNumber,
              round: roundNumber,
              spanId: traceSink.requestSpan(partNumber, roundNumber, seq),
            }
          : undefined;
        if (ctx) traceSink?.requestParsed(ctx, req);
        return { req, ctx, key: requestKey(req) };
      });

      // Give every parsed request exactly one terminal disposition before
      // deciding whether another writer call is possible.
      const candidates: typeof parsed = [];
      let duplicateCount = 0;
      let overLimitCount = 0;
      for (const item of parsed) {
        if (answered.has(item.key)) {
          if (item.ctx) traceSink?.requestDisposition(item.ctx, item.req, 'duplicate', 'already-answered');
          duplicateCount++;
          continue;
        }
        if (answered.size >= maxRequests) {
          if (item.ctx) traceSink?.requestDisposition(item.ctx, item.req, 'over-limit', 'request-limit');
          overLimitCount++;
          continue;
        }
        candidates.push(item);
      }

      if (!candidates.length) {
        if (additionalCalls >= maxAdditionalCalls) break;
        const message = overLimitCount
          ? 'You have reached the context request limit for this scene. Continue with what you have ' +
            'and do not make any more requests.'
          : `Those requests were already answered. Here are the answers again:\n${[...answered.values()]
              .map((answer) => `--- ${answer.label} ---\n${answer.content}`)
              .join('\n\n')}\n\nContinue the scene now using this information.`;
        messages.push({ role: 'user', content: message });
        traceSink?.promptMessage(roundSpan!, messages.length - 1, 'user', overLimitCount ? 'request-limit' : 'duplicate-answers', message, {
          part: partNumber,
          round: roundNumber,
        });
        additionalCalls++;
        continue;
      }

      // Apply the distinct-request slots first. A request that exceeds the
      // slot limit is not-processed even when the follow-up budget is also
      // exhausted; only requests that would otherwise fit are unanswered.
      const processable = candidates.slice(0, Math.max(0, maxRequests - answered.size));
      const notProcessed = candidates.slice(processable.length);
      for (const item of notProcessed) {
        if (item.ctx) traceSink?.requestDisposition(item.ctx, item.req, 'not-processed', 'request-slot-limit');
      }
      if (additionalCalls >= maxAdditionalCalls) {
        // This is the final writer call the chapter budget allows. Requests
        // that would otherwise have been resolved are recorded unanswered.
        for (const item of processable) {
          if (item.ctx) traceSink?.requestDisposition(item.ctx, item.req, 'unanswered', 'round-budget');
        }
        unansweredRequests += processable.length;
        break;
      }

      const chunks: string[] = [];
      for (const item of processable) {
        const answer = await resolve(item.req, item.ctx);
        if (!answer) continue;
        answered.set(item.key, answer);
        trace.push({ request: item.req, answer });
        chunks.push(`--- ${answer.label} ---\n${answer.content}`);
        if (item.ctx) traceSink?.answerQueued(item.ctx, answer);
      }

      let source = 'context-answer';
      let message: string;
      if (chunks.length) {
        message =
          `Here is the information you requested. Use it and continue the scene from where you stopped.\n\n` +
          chunks.join('\n\n');
      } else if (overLimitCount) {
        source = 'request-limit';
        message =
          'You have reached the context request limit for this scene. Continue with what you have ' +
          'and do not make any more requests.';
      } else if (duplicateCount) {
        source = 'duplicate-answers';
        message =
          `Those requests were already answered. Here are the answers again:\n${[...answered.values()]
            .map((answer) => `--- ${answer.label} ---\n${answer.content}`)
            .join('\n\n')}\n\nContinue the scene now using this information.`;
      } else {
        source = 'no-matching-information';
        message = 'No matching information was found. Continue with the information you already have.';
      }
      messages.push({ role: 'user', content: message });
      traceSink?.promptMessage(roundSpan!, messages.length - 1, 'user', source, message, {
        part: partNumber,
        round: roundNumber,
      });
      additionalCalls++;
    }
    traceSink?.partCompleted(partNumber, wordCount(prose), partCalls);
  }

  let body = stripProtocolBlocks(prose).trim();

  // A chapter that stops at half its length is not a chapter, and a chapter
  // that says the same thing three times is worse than a short one. The writer
  // is asked to carry on when the chapter is thin, and — after the
  // near-duplicate sweep — when the chapter was mostly repetition, so the
  // material that was lost is written again properly.
  const minRatio = opts.minLengthRatio ?? 0.8;
  const maxContinuations = opts.maxContinuations ?? 3;
  const threshold = opts.dedupeThreshold ?? 0.8;
  let continuations = 0;

  while (segments === 1 && continuations < maxContinuations) {
    const swept = dedupeParagraphs(body, threshold);
    const have = wordCount(swept.text);
    const raw = wordCount(body);
    const wasRepetitive = raw > 0 && (raw - have) / raw > 0.25;
    const tooShort = have < target * minRatio;
    if (!tooShort && !wasRepetitive) {
      body = swept.text;
      break;
    }
    if (!tooShort && wasRepetitive) {
      // Keep only what survived, then ask for the rest again.
      body = swept.text;
    }
    continuations++;
    const reason = wasRepetitive ? 'repetitive' : 'too-short';
    const continuationSpan = traceSink?.continuationStarted(continuations, reason, have, target);
    const continuationInstruction =
      (wasRepetitive
        ? `The chapter so far says the same thing several times over; that repetition has been ` +
          `removed, and what is left is ${have} words. `
        : `The chapter so far is ${have} words; the target is about ${target}. It ends too early. `) +
      `Continue the same chapter from exactly where it stops — same scene, same voice. ` +
      `Do not repeat or restate anything already written: the next paragraphs must be new ` +
      `action, new information, or the consequence of what has just happened. Do not make a ` +
      `context request. Write until the chapter is complete.\n\n` +
      `THE CHAPTER SO FAR (do not repeat any of it):\n${body.slice(-2400)}`;
    messages.push({ role: 'user', content: continuationInstruction });
    const continuationRequest: ChatRequest = {
      system: WRITER_SYSTEM,
      messages,
      temperature: 0.85,
      maxTokens: Math.max(1200, Math.ceil((target - have) * 1.8)),
    };
    const callId = traceSink?.modelStarted(continuationRequest, {
      role: 'continuation',
      attempt: continuations,
      parentSpanId: continuationSpan ?? 'sp-write',
      llm,
    });
    let res;
    try {
      res = await llm.chat(continuationRequest);
      if (callId) traceSink?.modelCompleted(callId, res);
    } catch (err) {
      if (callId) traceSink?.modelFailed(callId, err);
      throw err;
    }
    messages.push({ role: 'assistant', content: res.text });
    const more = stripTrailingMeta(stripProtocolBlocks(res.text));
    if (!more) {
      if (callId) continuationOutputs.push({ callId, text: '', attempt: continuations });
      traceSink?.continuationEmpty(continuations);
      break;
    }
    if (callId) continuationOutputs.push({ callId, text: more, attempt: continuations });
    traceSink?.continuationCompleted(continuations, more);
    body = `${body}\n\n${more}`;
    prose = body;
  }

  const rawWords = wordCount(body);
  const finalSweep = dedupeParagraphs(body, threshold);
  if (finalSweep.removed) {
    body = finalSweep.text;
    prose = body;
  }
  traceSink?.pendingNotIncluded('round-limit');

  // Output provenance is emitted only after the final near-duplicate sweep.
  // Simulate the same paragraph dedupe over each output's contributed text so
  // the final attribution is tracked by provenance, not by substring presence.
  type TrackedOutput = {
    callId: string;
    kind: 'main' | 'continuation';
    text: string;
    disposition?: 'included' | 'superseded' | 'empty';
    reason?: string;
    overlapChars: number;
  };
  const trackedOutputs: TrackedOutput[] = [
    ...mainOutputs.map((output) => ({
      callId: output.callId,
      kind: 'main' as const,
      text: output.contributedText,
      disposition: output.disposition,
      reason: output.reason,
      overlapChars: output.overlapChars,
    })),
    ...continuationOutputs.map((output) => ({
      callId: output.callId,
      kind: 'continuation' as const,
      text: output.text,
      overlapChars: 0,
    })),
  ];
  const tagged: { outputIndex: number; text: string }[] = [];
  trackedOutputs.forEach((output, outputIndex) => {
    for (const paragraph of splitParagraphs(output.text)) {
      tagged.push({ outputIndex, text: paragraph });
    }
  });
  const kept: { outputIndex: number; text: string }[] = [];
  const removedTagged = new Set<number>();
  tagged.forEach((paragraph, index) => {
    const duplicate =
      paragraph.text.length >= 40 &&
      kept.some(
        (earlier) =>
          earlier.text.length >= 40 &&
          similarity(paragraph.text, earlier.text) >= threshold,
      );
    if (duplicate) removedTagged.add(index);
    else kept.push(paragraph);
  });
  const finalParagraphs = splitParagraphs(body);
  const sequenceProven =
    kept.length === finalParagraphs.length &&
    kept.every(
      (paragraph, index) => overlapNormal(paragraph.text) === overlapNormal(finalParagraphs[index]!),
    );

  const stats = trackedOutputs.map(() => ({
    chars: 0,
    words: 0,
    dedupedChars: 0,
    ambiguousChars: 0,
  }));
  if (sequenceProven) {
    tagged.forEach((paragraph, index) => {
      const output = stats[paragraph.outputIndex]!;
      if (removedTagged.has(index)) output.dedupedChars += paragraph.text.length;
      else {
        output.chars += paragraph.text.length;
        output.words += wordCount(paragraph.text);
      }
    });
  } else {
    // The assembled body cannot be reconciled with the tracked contributions.
    // Do not assert survival or removal; record the uncertainty explicitly.
    trackedOutputs.forEach((output, index) => {
      if (output.text) stats[index]!.ambiguousChars = output.text.length;
    });
  }

  const droppedParagraphs = removedTagged.size;
  traceSink?.outputDedupe(droppedParagraphs);
  traceSink?.outputFinal(body);

  trackedOutputs.forEach((output, index) => {
    const outputStats = stats[index]!;
    if (output.kind === 'main' && (output.disposition !== 'included' || !output.text)) {
      traceSink?.outputDisposition(output.callId, output.disposition ?? 'empty', output.reason ?? 'empty-output', {
        contributed_chars: 0,
        contributed_words: 0,
        overlap_chars: output.overlapChars,
        deduped_chars: 0,
        ambiguous_chars: 0,
      });
      return;
    }
    if (!output.text) {
      traceSink?.outputDisposition(output.callId, 'empty', 'continuation-empty', {
        contributed_chars: 0,
        contributed_words: 0,
        overlap_chars: 0,
        deduped_chars: 0,
        ambiguous_chars: 0,
      });
      return;
    }
    if (outputStats.chars > 0) {
      traceSink?.outputDisposition(
        output.callId,
        'included',
        output.kind === 'main' ? (output.reason ?? 'part-output') : 'continuation',
        {
          contributed_chars: outputStats.chars,
          contributed_words: outputStats.words,
          overlap_chars: output.overlapChars,
          deduped_chars: outputStats.dedupedChars,
          ambiguous_chars: 0,
        },
      );
      return;
    }
    if (outputStats.ambiguousChars > 0) {
      traceSink?.outputDisposition(output.callId, 'ambiguous', 'unproven-final-attribution', {
        contributed_chars: 0,
        contributed_words: 0,
        overlap_chars: output.overlapChars,
        deduped_chars: 0,
        ambiguous_chars: outputStats.ambiguousChars,
      });
      return;
    }
    if (outputStats.dedupedChars > 0) {
      traceSink?.outputDisposition(output.callId, 'superseded', 'dedupe-removed', {
        contributed_chars: 0,
        contributed_words: 0,
        overlap_chars: output.overlapChars,
        deduped_chars: outputStats.dedupedChars,
        ambiguous_chars: 0,
      });
      return;
    }
    traceSink?.outputDisposition(output.callId, 'empty', 'empty-contribution', {
      contributed_chars: 0,
      contributed_words: 0,
      overlap_chars: output.overlapChars,
      deduped_chars: 0,
      ambiguous_chars: 0,
    });
  });

  return {
    prose: body,
    meta,
    requests,
    trace,
    rounds: writerCalls,
    words: wordCount(body),
    stats: {
      rawWords,
      continuations,
      droppedParagraphs,
      initialCalls,
      additionalCalls,
      unansweredRequests,
    },
  };
}
