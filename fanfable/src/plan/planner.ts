/**
 * Story Planner.
 *
 * Owns the premise, the AU divergence point, the plot structure, chapter
 * outlines and character arcs. It talks to the user before anything is treated
 * as established, and it never throws away approved material when the plan is
 * revised — revisions create a new version that copies approved chapters
 * forward unchanged.
 */
import { Db, fromJson, nowIso, toJson } from '../core/db.ts';
import { extractJson, toStringArray } from '../core/json.ts';
import type { LlmClient } from '../core/llm.ts';
import { truncate } from '../core/text.ts';

export interface SceneOutline {
  title: string;
  summary: string;
  pov: string;
  location: string;
  canonEventIds: number[];
  adaptations: string;
}

export interface ChapterOutline {
  number: number;
  title: string;
  goal: string;
  synopsis: string;
  scenes: SceneOutline[];
  characters: string[];
  characterArcs: string;
  canonEventIds: number[];
  notes: string;
  targetWords: number;
  /** The canon facts this chapter relies on. */
  canon?: string[];
  /** What this story does differently from the canon. */
  au?: string[];
  /** Decisions the author still has to make. */
  openQuestions?: string[];
}

export interface OutlinePreferences {
  [key: string]: string;
}

export interface Outline {
  id: number;
  version: number;
  status: 'draft' | 'approved' | 'superseded';
  premise: string;
  divergence: string;
  divergenceRef: string;
  canonRefs: number[];
  structure: string[];
  chapters: ChapterOutline[];
  preferences: OutlinePreferences;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
}

/* ------------------------------------------------------------------ storage */

interface OutlineRow {
  id: number;
  version: number;
  status: string;
  premise: string;
  divergence: string;
  divergence_ref: string;
  canon_refs: string;
  structure: string;
  chapters: string;
  preferences: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
}

function rowToOutline(r: OutlineRow): Outline {
  return {
    id: r.id,
    version: r.version,
    status: r.status as Outline['status'],
    premise: r.premise,
    divergence: r.divergence,
    divergenceRef: r.divergence_ref,
    canonRefs: fromJson<number[]>(r.canon_refs, []),
    structure: fromJson<string[]>(r.structure, []),
    chapters: fromJson<ChapterOutline[]>(r.chapters, []),
    preferences: fromJson<OutlinePreferences>(r.preferences, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    approvedAt: r.approved_at,
  };
}

export function saveOutline(
  db: Db,
  projectId: number,
  data: {
    premise?: string;
    divergence?: string;
    divergenceRef?: string;
    canonRefs?: number[];
    structure?: string[];
    chapters?: ChapterOutline[];
    preferences?: OutlinePreferences;
    status?: Outline['status'];
  },
): Outline {
  const ts = nowIso();
  const maxV = db.get<{ v: number }>(
    'SELECT COALESCE(MAX(version), 0) AS v FROM outline WHERE project_id = ?',
    projectId,
  );
  const version = (maxV?.v ?? 0) + 1;
  const r = db.run(
    `INSERT INTO outline (project_id, version, status, premise, divergence, divergence_ref, canon_refs, structure, chapters, preferences, created_at, updated_at, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    projectId,
    version,
    data.status ?? 'draft',
    data.premise ?? '',
    data.divergence ?? '',
    data.divergenceRef ?? '',
    toJson(data.canonRefs ?? []),
    toJson(data.structure ?? []),
    toJson(data.chapters ?? []),
    toJson(data.preferences ?? {}),
    ts,
    ts,
    null,
  );
  return getOutline(db, projectId, r.lastInsertRowid)!;
}

export function getOutline(db: Db, projectId: number, outlineId: number): Outline | undefined {
  const r = db.get<OutlineRow>('SELECT * FROM outline WHERE id = ? AND project_id = ?', outlineId, projectId);
  return r ? rowToOutline(r) : undefined;
}

export function latestOutline(db: Db, projectId: number): Outline | undefined {
  const r = db.get<OutlineRow>(
    'SELECT * FROM outline WHERE project_id = ? ORDER BY version DESC LIMIT 1',
    projectId,
  );
  return r ? rowToOutline(r) : undefined;
}

export function approvedOutline(db: Db, projectId: number): Outline | undefined {
  const r = db.get<OutlineRow>(
    "SELECT * FROM outline WHERE project_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1",
    projectId,
  );
  return r ? rowToOutline(r) : undefined;
}

/** Mark the outline as approved and supersede older versions. */
export function approveOutline(db: Db, projectId: number, outlineId: number): Outline {
  const outline = getOutline(db, projectId, outlineId);
  if (!outline) throw new Error(`outline ${outlineId} not found`);
  db.transaction(() => {
    db.run(
      "UPDATE outline SET status = 'superseded' WHERE project_id = ? AND status = 'approved' AND id != ?",
      projectId,
      outlineId,
    );
    db.run("UPDATE outline SET status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), outlineId);
  });
  return getOutline(db, projectId, outlineId)!;
}

export function updateOutline(
  db: Db,
  projectId: number,
  outlineId: number,
  patch: Partial<Outline>,
): Outline {
  const current = getOutline(db, projectId, outlineId);
  if (!current) throw new Error(`outline ${outlineId} not found`);
  db.run(
    `UPDATE outline SET premise = ?, divergence = ?, divergence_ref = ?, canon_refs = ?, structure = ?,
            chapters = ?, preferences = ?, updated_at = ? WHERE id = ?`,
    patch.premise ?? current.premise,
    patch.divergence ?? current.divergence,
    patch.divergenceRef ?? current.divergenceRef,
    toJson(patch.canonRefs ?? current.canonRefs),
    toJson(patch.structure ?? current.structure),
    toJson(patch.chapters ?? current.chapters),
    toJson(patch.preferences ?? current.preferences),
    nowIso(),
    outlineId,
  );
  return getOutline(db, projectId, outlineId)!;
}

/* ------------------------------------------------------------- LLM drafting */

const PLANNER_SYSTEM = `You are the Story Planner for a fanfiction project. You develop the premise,
the alternate-universe divergence point, the plot structure, chapter outlines and character arcs.

You collaborate with the author. You propose; the author decides. When you propose a plan
you present it as a proposal, not as established fact.

Reply with JSON only when asked for a plan. Use exactly this shape:
{
  "premise": "the one-paragraph premise",
  "divergence": "the specific point where this story departs from the source material",
  "divergence_ref": "canon event id / locator this divergence is anchored to",
  "canon_refs": [canon event ids the story depends on],
  "structure": ["act 1 ...", "act 2 ...", "act 3 ..."],
  "chapters": [{
     "number": 1,
     "title": "chapter title",
     "goal": "what this chapter must accomplish",
     "synopsis": "3-6 sentences describing what happens",
     "canon": ["the canon facts this chapter relies on"],
     "au": ["what this story does differently from the canon"],
     "open_questions": ["something the author must decide before this chapter is written"],
     "scenes": [{"title":"","summary":"","pov":"","location":"","canon_event_ids":[1],"adaptations":"how a canon scene changes here"}],
     "characters": ["names appearing"],
     "character_arcs": "how the characters change in this chapter",
     "canon_event_ids": [1,2],
     "notes": "risks, open questions for the author, or things to verify against canon",
     "target_words": 2500
  }],
  "preferences": {"tone":"","pov":"","tense":"","chapter_words":"2500","style_notes":""}
}

Rules:
- Anchor every change to the source material; do not invent canon facts.
- Use the connected context: if the premise changes something, work out what
  else that change touches, and put those consequences in the chapter outlines.
- If the premise contradicts the canon, do not silently accept it: put it in
  the chapter "notes" as something the author must decide.
- canon_refs, canon_event_ids and canon_event_ids inside scenes may ONLY contain ids that
  appear in the CANON EVENTS INDEX below. If no index is supplied, leave them empty.
- If a canon fact is uncertain, put it in "notes" instead of asserting it.
- For each chapter, separate what the canon establishes ("canon") from what this story
  changes ("au"), and list anything the author still has to decide ("open_questions").
  Do not invent canon to fill a gap: an open question is the honest answer.
- Keep the number of chapters to what the author asked for.
- No prose outside the JSON.`;

export interface PlanRequest {
  premise: string;
  divergence?: string;
  chapterCount?: number;
  preferences?: OutlinePreferences;
  canonBrief?: string;
  /** Rendered evidence web: graded ties, open questions, contradictions. */
  webBrief?: string;
  /** Established ties among the named cast, pre-rendered one per line. */
  castRelationships?: string;
  canonEvents?: { id: number; title: string; summary: string }[];
  /** Connected information: what the premise touches, and what it leads to. */
  graphContext?: string;
  userNotes?: string;
}

export async function draftOutline(llm: LlmClient, req: PlanRequest): Promise<Omit<Outline, 'id' | 'version' | 'status' | 'createdAt' | 'updatedAt' | 'approvedAt'>> {
  const canonEvents = (req.canonEvents ?? [])
    .map((c) => `- ${c.id}: ${c.title}${c.summary ? ` — ${truncate(c.summary, 220)}` : ''}`)
    .join('\n');

  const user = [
    `PREMISE:\n${req.premise}`,
    req.divergence ? `PROPOSED DIVERGENCE POINT:\n${req.divergence}` : '',
    `CHAPTER COUNT: ${req.chapterCount ?? 6}`,
    req.canonBrief ? `CANON CONTEXT (from the source material, treat as evidence):\n${truncate(req.canonBrief, 4500)}` : '',
    req.castRelationships
      ? `CAST RELATIONSHIPS (established ties between the named cast; user-confirmed ties are the author's own rulings and are not backed by a passage):\n${req.castRelationships}`
      : '',
    req.webBrief ? req.webBrief : '',
    canonEvents ? `CANON EVENTS INDEX:\n${canonEvents}` : '',
    req.graphContext ? `CONNECTED CONTEXT (what the premise touches, and what leads from it):\n${truncate(req.graphContext, 3500)}` : '',
    req.preferences && Object.keys(req.preferences).length
      ? `AUTHOR PREFERENCES:\n${JSON.stringify(req.preferences)}`
      : '',
    req.userNotes ? `AUTHOR NOTES:\n${req.userNotes}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const res = await llm.chat({
    system: PLANNER_SYSTEM,
    messages: [{ role: 'user', content: user }],
    temperature: 0.3,
    // An outline for a whole story is long. A model that writes more than the
    // default gets the room it needs; the rest are unaffected.
    maxTokens: Math.max(4000, llm.settings.maxTokens ?? 0),
  });

  const parsed = extractJson<Record<string, unknown>>(res.text) ?? {};
  const chapters = (Array.isArray(parsed.chapters) ? parsed.chapters : []).map((c: any, i: number) => ({
    number: Number(c.number ?? i + 1),
    title: String(c.title ?? `Chapter ${i + 1}`),
    goal: String(c.goal ?? ''),
    synopsis: String(c.synopsis ?? ''),
    scenes: (Array.isArray(c.scenes) ? c.scenes : []).map((s: any) => ({
      title: String(s.title ?? ''),
      summary: String(s.summary ?? ''),
      pov: String(s.pov ?? ''),
      location: String(s.location ?? ''),
      canonEventIds: (Array.isArray(s.canon_event_ids) ? s.canon_event_ids : []).map(Number),
      adaptations: String(s.adaptations ?? ''),
    })),
    characters: toStringArray(c.characters),
    characterArcs: String(c.character_arcs ?? ''),
    canonEventIds: (Array.isArray(c.canon_event_ids) ? c.canon_event_ids : []).map(Number),
    notes: String(c.notes ?? ''),
    targetWords: Number(c.target_words ?? 2500),
    canon: toStringArray(c.canon),
    au: toStringArray(c.au),
    openQuestions: toStringArray(c.open_questions),
  }));

  const prefs = (parsed.preferences ?? {}) as Record<string, unknown>;
  return {
    premise: String(parsed.premise ?? req.premise),
    divergence: String(parsed.divergence ?? req.divergence ?? ''),
    divergenceRef: String(parsed.divergence_ref ?? ''),
    canonRefs: (Array.isArray(parsed.canon_refs) ? parsed.canon_refs : []).map(Number),
    structure: toStringArray(parsed.structure),
    chapters,
    preferences: Object.fromEntries(
      Object.entries({ ...(req.preferences ?? {}), ...prefs }).map(([k, v]) => [k, String(v)]),
    ),
  };
}

/**
 * Revise an outline. Approved chapters that the instruction does not target are
 * copied over untouched.
 */
export async function reviseOutline(
  llm: LlmClient,
  outline: Outline,
  instruction: string,
  opts: { chapterNumber?: number } = {},
): Promise<Outline> {
  const focus = opts.chapterNumber
    ? outline.chapters.filter((c) => c.number === opts.chapterNumber)
    : outline.chapters;

  const user = [
    `CURRENT PLAN (version ${outline.version}, status ${outline.status}):`,
    toJson({
      premise: outline.premise,
      divergence: outline.divergence,
      structure: outline.structure,
      chapters: outline.chapters,
      preferences: outline.preferences,
    }),
    '',
    `REVISION INSTRUCTION FROM THE AUTHOR: ${instruction}`,
    opts.chapterNumber ? `ONLY revise chapter ${opts.chapterNumber}. Keep every other chapter exactly as it is.` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const res = await llm.chat({
    system: PLANNER_SYSTEM,
    messages: [{ role: 'user', content: user }],
    temperature: 0.6,
    maxTokens: Math.max(4000, llm.settings.maxTokens ?? 0),
  });

  const parsed = extractJson<Record<string, unknown>>(res.text) ?? {};
  const revisedChapters = (Array.isArray(parsed.chapters) ? parsed.chapters : []).map((c: any, i: number) => ({
    number: Number(c.number ?? focus[i]?.number ?? i + 1),
    title: String(c.title ?? focus[i]?.title ?? `Chapter ${i + 1}`),
    goal: String(c.goal ?? ''),
    synopsis: String(c.synopsis ?? ''),
    scenes: (Array.isArray(c.scenes) ? c.scenes : []).map((s: any) => ({
      title: String(s.title ?? ''),
      summary: String(s.summary ?? ''),
      pov: String(s.pov ?? ''),
      location: String(s.location ?? ''),
      canonEventIds: (Array.isArray(s.canon_event_ids) ? s.canon_event_ids : []).map(Number),
      adaptations: String(s.adaptations ?? ''),
    })),
    characters: toStringArray(c.characters),
    characterArcs: String(c.character_arcs ?? ''),
    canonEventIds: (Array.isArray(c.canon_event_ids) ? c.canon_event_ids : []).map(Number),
    notes: String(c.notes ?? ''),
    targetWords: Number(c.target_words ?? 2500),
    canon: toStringArray(c.canon),
    au: toStringArray(c.au),
    openQuestions: toStringArray(c.open_questions),
  }));

  // Merge: only chapters the model returned replace the old ones; everything
  // else (including approved chapters the author did not ask to change) stays.
  const merged = outline.chapters.map((old) => {
    const next = revisedChapters.find((c) => c.number === old.number);
    return next ?? old;
  });
  for (const next of revisedChapters) {
    if (!merged.some((c) => c.number === next.number)) merged.push(next);
  }
  merged.sort((a, b) => a.number - b.number);

  return {
    ...outline,
    premise: String(parsed.premise ?? outline.premise),
    divergence: String(parsed.divergence ?? outline.divergence),
    structure: toStringArray(parsed.structure).length ? toStringArray(parsed.structure) : outline.structure,
    chapters: merged,
    preferences: {
      ...outline.preferences,
      ...Object.fromEntries(
        Object.entries((parsed.preferences ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      ),
    },
  };
}

/* ------------------------------------------------------------- discussion */

export function addMessage(
  db: Db,
  projectId: number,
  role: 'user' | 'assistant' | 'system',
  content: string,
  kind = 'chat',
): void {
  db.run(
    'INSERT INTO message (project_id, role, kind, content, created_at) VALUES (?, ?, ?, ?, ?)',
    projectId,
    role,
    kind,
    content,
    nowIso(),
  );
}

export function listMessages(db: Db, projectId: number, limit = 40): { role: string; content: string; createdAt: string }[] {
  const rows = db.all<{ role: string; content: string; created_at: string }>(
    'SELECT role, content, created_at FROM message WHERE project_id = ? ORDER BY id DESC LIMIT ?',
    projectId,
    limit,
  );
  return rows.reverse().map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at }));
}

const DISCUSS_SYSTEM = `You are the Story Planner collaborating with an author on a fanfiction project.
You help sharpen the premise, choose the AU divergence point, work out structure and character arcs,
and you flag when an idea contradicts the source material or an established story decision.

Be concise and concrete. Offer options with trade-offs when the author is deciding. Do not draft
full chapters here. If the author asks for a plan, say that they can run the plan command to
generate a structured outline for approval.`;

/** One turn of planner conversation with the author. */
export async function discuss(
  llm: LlmClient,
  db: Db,
  projectId: number,
  userMessage: string,
  context: { canonBrief?: string; outline?: Outline } = {},
): Promise<string> {
  const history = listMessages(db, projectId, 12);
  const msgs = [
    ...history.map((m) => ({ role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: m.content })),
    { role: 'user' as const, content: userMessage },
  ];
  const sys = context.outline
    ? `${DISCUSS_SYSTEM}\n\nCURRENT APPROVED PLAN:\n${toJson({
        premise: context.outline.premise,
        divergence: context.outline.divergence,
        structure: context.outline.structure,
        chapters: context.outline.chapters.map((c) => ({ number: c.number, title: c.title, goal: c.goal })),
      })}`
    : DISCUSS_SYSTEM;

  const res = await llm.chat({
    system: sys,
    messages: msgs,
    temperature: 0.7,
  });

  const extra = context.canonBrief ? `\n\n[Canon context available on request: ${truncate(context.canonBrief, 400)}]` : '';
  const reply = res.text.trim() + extra;
  addMessage(db, projectId, 'user', userMessage);
  addMessage(db, projectId, 'assistant', reply);
  return reply;
}
