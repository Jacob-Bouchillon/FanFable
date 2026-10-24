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
import { extractJson } from './json.ts';
import type { LlmClient } from './llm.ts';
import type { ChapterOutline, Outline, OutlinePreferences } from './planner.ts';
import { dedupeParagraphs, wordCount } from './text.ts';

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
  /** Maximum request/answer round trips per scene. */
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
}

export interface WriteResult {
  prose: string;
  meta: Record<string, unknown> | null;
  requests: ContextRequest[];
  /** Human-readable trace of what the writer asked for and what it got. */
  trace: { request: ContextRequest; answer: ResolvedContext }[];
  rounds: number;
  words: number;
  stats: {
    /** Words before the near-duplicate sweep. */
    rawWords: number;
    /** Times the writer was asked to carry on. */
    continuations: number;
    /** Paragraphs removed as near-duplicates. */
    droppedParagraphs: number;
  };
}

export type RequestResolver = (
  req: ContextRequest,
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

export async function writeChapter(
  llm: LlmClient,
  opts: WriteOptions,
  resolve: RequestResolver,
  limits: ContextLimits = DEFAULT_CONTEXT_LIMITS,
): Promise<WriteResult> {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  const answered = new Map<string, ResolvedContext>();
  const trace: { request: ContextRequest; answer: ResolvedContext }[] = [];
  let rounds = 0;
  let meta: Record<string, unknown> | null = null;
  let prose = '';
  let requests: ContextRequest[] = [];

  const target = opts.targetWords ?? opts.chapter?.targetWords ?? 2500;
  // The chapter is written in one go by default: a single coherent generation
  // reads better than stitched-together parts. When the model loops, the
  // repetition is removed and the lost material is written again, so the
  // chapter comes out the right length. Parts are available for chapters that
  // need them.
  const segments = Math.max(1, Math.min(opts.segments ?? 1, 6));

  for (let part = 0; part < segments; part++) {
   const partTarget = Math.round(target / segments);
   // Within a part, the writer may ask for context and carry on. The loop is
   // bounded by the round cap and the distinct-request cap.
   while (rounds <= limits.maxRounds) {
    rounds++;
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
              index: part + 1,
              total: segments,
              target: partTarget,
              previous: prose ? stripProtocolBlocks(prose).slice(-2400) : '',
              beats: beatsSoFar(prose),
            }
          : undefined,
    });

    messages.push({ role: 'user', content: prompt });
    const res = await llm.chat({
      system: WRITER_SYSTEM,
      messages,
      temperature: 0.85,
      maxTokens: Math.max(1200, Math.ceil(partTarget * 1.8)),
    });
    messages.push({ role: 'assistant', content: res.text });

    const parsedMeta = parseMeta(res.text);
    if (parsedMeta) meta = parsedMeta;
    prose = segments > 1 ? (prose ? `${prose}\n\n${res.text}` : res.text) : res.text;
    requests = parseContextRequests(res.text);

    if (!requests.length) break;

    const fresh = requests.filter((r) => !answered.has(requestKey(r)));
    if (!fresh.length) {
      // The model is repeating itself: tell it the answers and move on.
      messages.push({
        role: 'user',
        content: `Those requests were already answered. Here are the answers again:\n${[...answered.values()]
          .map((a) => `--- ${a.label} ---\n${a.content}`)
          .join('\n\n')}\n\nContinue the scene now using this information.`,
      });
      continue;
    }
    if (answered.size >= limits.maxRequests) {
      messages.push({
        role: 'user',
        content:
          'You have reached the context request limit for this scene. Continue with what you have ' +
          'and do not make any more requests.',
      });
      continue;
    }

    const chunks: string[] = [];
    for (const req of fresh.slice(0, Math.max(0, limits.maxRequests - answered.size))) {
      const key = requestKey(req);
      const answer = await resolve(req);
      if (!answer) continue;
      answered.set(key, answer);
      trace.push({ request: req, answer });
      chunks.push(`--- ${answer.label} ---\n${answer.content}`);
    }
    if (!chunks.length) {
      messages.push({
        role: 'user',
        content: 'No matching information was found. Continue with the information you already have.',
      });
      continue;
    }
    messages.push({
      role: 'user',
      content:
        `Here is the information you requested. Use it and continue the scene from where you stopped.\n\n` +
        chunks.join('\n\n'),
    });
   }
  }

  let body = stripTrailingMeta(stripProtocolBlocks(prose));

  // A chapter that stops at half its length is not a chapter, and a chapter
  // that says the same thing three times is worse than a short one. The writer
  // is asked to carry on when the chapter is thin, and — after the
  // near-duplicate sweep — when the chapter was mostly repetition, so the
  // material that was lost is written again properly.
  const minRatio = opts.minLengthRatio ?? 0.8;
  const maxContinuations = opts.maxContinuations ?? 3;
  const threshold = opts.dedupeThreshold ?? 0.8;
  let continuations = 0;
  let removed = 0;

  while (segments === 1 && continuations < maxContinuations) {
    const swept = dedupeParagraphs(body, threshold);
    removed = swept.removed;
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
    const res = await llm.chat({
      system: WRITER_SYSTEM,
      messages: [
        ...messages,
        {
          role: 'user',
          content:
            (wasRepetitive
              ? `The chapter so far says the same thing several times over; that repetition has been ` +
                `removed, and what is left is ${have} words. `
              : `The chapter so far is ${have} words; the target is about ${target}. It ends too early. `) +
            `Continue the same chapter from exactly where it stops — same scene, same voice. ` +
            `Do not repeat or restate anything already written: the next paragraphs must be new ` +
            `action, new information, or the consequence of what has just happened. Do not make a ` +
            `context request. Write until the chapter is complete.\n\n` +
            `THE CHAPTER SO FAR (do not repeat any of it):\n${body.slice(-2400)}`,
        },
      ],
      temperature: 0.85,
      maxTokens: Math.max(1200, Math.ceil((target - have) * 1.8)),
    });
    messages.push({ role: 'assistant', content: res.text });
    const more = stripTrailingMeta(stripProtocolBlocks(res.text));
    if (!more) break;
    body = `${body}\n\n${more}`;
    prose = body;
  }

  const rawWords = wordCount(body);
  const swept = dedupeParagraphs(body, threshold);
  removed = swept.removed;
  if (removed) {
    body = swept.text;
    prose = body;
  }

  return {
    prose: body,
    meta,
    requests,
    trace,
    rounds,
    words: wordCount(body),
    stats: { rawWords, continuations, droppedParagraphs: removed },
  };
}
