/**
 * The name roster: which names the relation prompt may see in a window, and how
 * a model-returned name is filtered back down to something real.
 *
 * The roster is built once per command from the bank and the source text, then
 * filtered. Nothing here is stored: a derived name form is never persisted,
 * displayed, merged on or written back.
 *
 * Moved out of lorebook.ts on 2026-11-13, logic unchanged.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Db, fromJson, nowIso, strList, toJson } from '../core/db.ts';
import { toStringArray } from '../core/json.ts';
import { compareText, findHeadings, normalise, splitSentences, truncate } from '../core/text.ts';
import { PROOF_FILLER, PROOF_TITLES, STOPWORDS } from '../core/vocab.ts';
import { newClaimUid } from '../court/claim-proof.ts';
import {
  NAME_DF_CAP,
  NAME_MIN_TOKEN,
  buildRosterIndex,
  canonicalName,
  isTitleToken,
  nameMentionedFromTokens,
  occursLowercaseInText,
} from '../identity/names.ts';
import {
  chunkAt,
  findEntityId,
  key,
  normaliseKind,
  refsFor,
  verifyQuote,
} from './shared.ts';
import { listEntities } from './bank.ts';
import { normaliseModality, resolveSubjectEntity } from './timeline.ts';
import {
  isConjoinedCharacterName,
  isDescriptiveCharacterName,
  isGroupCharacterName,
  loadOrderedChunks,
  verifySpan,
  type CanonEntity,
  type ChunkRow,
  type ExtractLoreResult,
  type SpanCheck,
  type VerificationStats,
} from '../lorebook.ts';

/** Ceiling for the relation prompt's name list, roster included. */
export const WINDOW_NAME_CAP = 80;
/** The list's pre-roster ceiling: bank and finder names keep their old size. */
const WINDOW_BANK_NAME_CAP = 60;

export interface NameRosterEntry {
  /** Representative surface: the most frequent form in the group. */
  surface: string;
  /** Every accepted surface form collapsed into this entry. */
  surfaces: string[];
  tokens: string[];
  count: number;
  trustedSource: 'mid-sentence' | 'sentence-start-matched';
}

export interface NameRosterDiagnostics {
  sentenceInitialCandidates: number;
  accepted: number;
  rejected: number;
  topRejected: { surface: string; count: number }[];
  /** Quote boundaries that began a new utterance segment. */
  quotedStarts: number;
  rejectedInvalid: number;
  rejectedContraction: number;
  rejectedFunctionWord: number;
  rejectedTitleOnly: number;
  rejectedCommonWord: number;
  rejectedStoplist: number;
  rejectedNoMidSentence: number;
}

export interface NameRoster {
  entries: NameRosterEntry[];
  diagnostics: NameRosterDiagnostics;
}

/**
 * Words that start sentences but are not names.
 *
 * Pronouns, determiners, conjunctions, common adverbs and prepositions, plus
 * the discourse starters prose leans on. Universal English function words:
 * extend only with the same classes, never with names.
 */
const NAME_STARTER_STOPLIST = new Set([
  'but', 'he', 'she', 'it', 'they', 'we', 'you', 'i', 'in', 'on', 'at', 'as', 'if',
  'then', 'how', 'what', 'when', 'where', 'why', 'who', 'his', 'her', 'their', 'the',
  'a', 'an', 'and', 'or', 'so', 'yet', 'for', 'not', 'no', 'yes', 'that', 'this',
  'these', 'those', 'there', 'here', 'now', 'later', 'before', 'after', 'once', 'still',
  'even', 'only', 'just', 'also', 'perhaps', 'maybe', 'suddenly', 'finally', 'however',
  'meanwhile', 'while', 'because', 'though', 'although', 'unless', 'until', 'since',
  // Same classes, for sentences opening on a preposition or connective.
  'about', 'above', 'across', 'afterwards', 'against', 'along', 'among', 'around',
  'behind', 'below', 'beneath', 'beside', 'besides', 'between', 'beyond', 'by',
  'despite', 'down', 'during', 'except', 'from', 'inside', 'into', 'near', 'of', 'off',
  'onto', 'out', 'outside', 'over', 'past', 'through', 'throughout', 'toward',
  'towards', 'under', 'up', 'upon', 'with', 'within', 'without', 'first', 'second',
  'third', 'next', 'last', 'another', 'each', 'every', 'both', 'few', 'many', 'most',
  'some', 'such', 'than', 'too', 'very', 'well', 'almost', 'already', 'always',
  'never', 'often', 'sometimes', 'soon', 'today', 'tomorrow', 'yesterday', 'again',
  'away', 'back', 'forward', 'instead', 'otherwise',
]);

/** Universal titles that name a role, not a person, when they stand alone. */
export const NAME_TITLE_WORDS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'sir', 'madam', 'lord', 'lady', 'captain', 'commander',
  'general', 'senator', 'master', 'darth', 'magister', 'count', 'duke', 'king',
  'queen', 'prince', 'father', 'mother', 'brother', 'sister',
]);

interface RosterToken {
  text: string;
  capitalized: boolean;
  usable: boolean;
}

interface RosterRun {
  tokens: RosterToken[];
  startIndex: number;
}

/** Words only: possessives stripped, punctuation used as run boundaries. */
function rosterSentenceTokens(sentence: string): RosterToken[] {
  const out: RosterToken[] = [];
  const re = /[A-Za-z0-9][A-Za-z0-9'’\-]*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sentence)) !== null) {
    const raw = match[0];
    const text = raw.replace(/['’]s$/i, '').replace(/['’]$/, '');
    const letters = text.replace(/[^A-Za-z]/g, '');
    const capitalized = /^[A-Z]/.test(text);
    const allCapsArtifact = letters.length > 1 && letters === letters.toUpperCase();
    const pureDigits = letters.length === 0;
    out.push({
      text,
      capitalized,
      usable: text.length >= 2 && capitalized && !allCapsArtifact && !pureDigits,
    });
  }
  return out;
}

/** Maximal runs of capitalized tokens; punctuation ends a run. */
function capitalizedRuns(tokens: RosterToken[]): RosterRun[] {
  const runs: RosterRun[] = [];
  let current: RosterToken[] = [];
  let start = 0;
  tokens.forEach((token, index) => {
    if (token.capitalized) {
      if (!current.length) start = index;
      current.push(token);
      return;
    }
    if (current.length) {
      runs.push({ tokens: current, startIndex: start });
      current = [];
    }
  });
  if (current.length) runs.push({ tokens: current, startIndex: start });
  return runs;
}

/**
 * Split one sentence at quotation boundaries.
 *
 * A capital right after an opening quote begins an utterance, so it is
 * sentence-initial, never mid-sentence. Straight single quotes count only at a
 * word edge; an apostrophe inside a word does not split.
 */
function quoteSegments(sentence: string): string[] {
  const segments: string[] = [];
  let current = '';
  for (let i = 0; i < sentence.length; i++) {
    const ch = sentence[i]!;
    const doubleQuote = ch === '"' || ch === '“' || ch === '”';
    const singleQuote =
      ch === "'" &&
      (i === 0 ||
        /[\s([{—–-]/.test(sentence[i - 1] ?? '') ||
        /[\s)\]},.;:!?—–-]/.test(sentence[i + 1] ?? ''));
    if (doubleQuote || singleQuote) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments.length ? segments : [sentence];
}

function sentenceKey(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^[#\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Heading surfaces for one chunk, from the same detection import used. */
function chunkHeadingKeys(chunk: ChunkRow): Set<string> {
  const keys = new Set<string>();
  const add = (text: string): void => {
    const key = sentenceKey(text);
    if (key) keys.add(key);
  };
  add(chunk.heading);
  for (const heading of findHeadings(chunk.text)) add(heading.heading);
  return keys;
}

type RunRejection =
  | 'invalid'
  | 'contraction'
  | 'function-word'
  | 'title-only'
  | 'common-word';

interface RunCheck {
  surface: string;
  tokens: string[];
  reason?: RunRejection;
}

/**
 * One capitalized run, checked against the universal exclusions.
 *
 * Function words are rejected in both passes, so the mid-sentence vocabulary
 * never contains "the" or "and". A lone title is a role, not a name; a lone
 * common word is only a name when the bank already knows it as one.
 */
function evaluateRosterRun(
  run: RosterRun,
  context: { lowercaseWords: Set<string>; bankedNames: Set<string> },
): RunCheck {
  const slice = run.tokens.slice(0, 4);
  const usable = slice.filter((token) => token.usable);
  const surface = (usable.length ? usable : slice).map((token) => token.text).join(' ');
  if (!usable.length || usable.length !== slice.length) {
    return { surface, tokens: [], reason: 'invalid' };
  }
  const tokens = usable.map((token) => token.text.toLowerCase());
  if (tokens.some((token) => /['’]/.test(token) && !/['’]s$/i.test(token))) {
    return { surface, tokens, reason: 'contraction' };
  }
  if (tokens.some((token) => STOPWORDS.has(token))) {
    return { surface, tokens, reason: 'function-word' };
  }
  if (tokens.every((token) => NAME_TITLE_WORDS.has(token))) {
    return { surface, tokens, reason: 'title-only' };
  }
  if (
    tokens.length === 1 &&
    context.lowercaseWords.has(tokens[0]!) &&
    !context.bankedNames.has(canonicalName(surface))
  ) {
    return { surface, tokens, reason: 'common-word' };
  }
  return { surface, tokens };
}

/**
 * Group exact variants that differ only by titles, e.g. "Ashaline" and
 * "Lady Ashaline". A distinctive token must be at least five letters; no
 * identity is decided, only candidate counting stops duplicating a form.
 */
function variantKey(entry: NameRosterEntry): string | null {
  const distinctive = entry.tokens.filter((token) => !NAME_TITLE_WORDS.has(token));
  if (!distinctive.length) return null;
  if (!distinctive.some((token) => token.length >= 5)) return null;
  return [...new Set(distinctive)].sort(compareText).join(' ');
}

function collapseVariants(entries: NameRosterEntry[]): NameRosterEntry[] {
  const groups = new Map<string, NameRosterEntry[]>();
  const collapsed: NameRosterEntry[] = [];
  for (const entry of entries) {
    const key = variantKey(entry);
    if (!key) {
      collapsed.push(entry);
      continue;
    }
    const list = groups.get(key);
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }
  for (const members of groups.values()) {
    const surfaces = [...members]
      .sort((a, b) => b.count - a.count || compareText(a.surface, b.surface))
      .map((member) => member.surface);
    collapsed.push({
      surface: surfaces[0]!,
      surfaces,
      tokens: [...new Set(members.flatMap((member) => member.tokens))].sort(compareText),
      count: members.reduce((sum, member) => sum + member.count, 0),
      trustedSource: members.some((member) => member.trustedSource === 'mid-sentence')
        ? 'mid-sentence'
        : 'sentence-start-matched',
    });
  }
  return collapsed.sort((a, b) => b.count - a.count || compareText(a.surface, b.surface));
}

/**
 * Book-wide name candidates from capitalization alone.
 *
 * Pass A records every capitalized run *inside* an utterance segment, so the
 * closed set of sentence starters never enters the vocabulary. Pass B revisits
 * segment starts and keeps a run only when one of its tokens was already seen
 * inside a segment. Two passes, no model calls, no persistence.
 */
export function buildNameRoster(
  db: Db,
  projectId: number,
  loaded?: ChunkRow[],
): NameRoster {
  const chunks = loaded ?? loadOrderedChunks(db, projectId);
  const bankedNames = new Set<string>();
  for (const row of db.all<{ name: string; aliases: string }>(
    'SELECT name, aliases FROM canon_entity WHERE project_id = ?',
    projectId,
  )) {
    const name = canonicalName(row.name);
    if (name) bankedNames.add(name);
    for (const alias of strList(row.aliases)) {
      const key = canonicalName(alias);
      if (key) bankedNames.add(key);
    }
  }
  const contextFor = (chunk: ChunkRow) => ({
    // Whole words that really appear lowercase, not the lowercase form of a
    // capitalized name elsewhere in the same chunk.
    lowercaseWords: new Set(chunk.text.match(/\b[a-z][a-z'’-]*\b/g) ?? []),
    bankedNames,
  });

  const midTokens = new Set<string>();
  const midSurfaces = new Map<string, { surface: string; tokens: string[]; count: number }>();

  for (const chunk of chunks) {
    const headings = chunkHeadingKeys(chunk);
    const context = contextFor(chunk);
    for (const sentence of splitSentences(chunk.text)) {
      if (headings.has(sentenceKey(sentence))) continue;
      for (const segment of quoteSegments(sentence)) {
        const runs = capitalizedRuns(rosterSentenceTokens(segment));
        for (const run of runs) {
          // Segment-initial capitalization is the thing Pass B judges.
          if (run.startIndex === 0) continue;
          const check = evaluateRosterRun(run, context);
          if (check.reason) continue;
          const tokens = check.tokens;
          for (const token of tokens) midTokens.add(token);
          const key = check.surface.toLowerCase();
          const existing = midSurfaces.get(key);
          if (existing) existing.count++;
          else midSurfaces.set(key, { surface: check.surface, tokens, count: 1 });
        }
      }
    }
  }

  const startedSurfaces = new Map<string, { surface: string; tokens: string[]; count: number }>();
  const rejectedSurfaces = new Map<string, number>();
  const diagnostics: NameRosterDiagnostics = {
    sentenceInitialCandidates: 0,
    accepted: 0,
    rejected: 0,
    topRejected: [],
    quotedStarts: 0,
    rejectedInvalid: 0,
    rejectedContraction: 0,
    rejectedFunctionWord: 0,
    rejectedTitleOnly: 0,
    rejectedCommonWord: 0,
    rejectedStoplist: 0,
    rejectedNoMidSentence: 0,
  };

  const reject = (reason: RunRejection | 'stoplist' | 'no-mid', surface: string): void => {
    diagnostics.rejected++;
    rejectedSurfaces.set(surface, (rejectedSurfaces.get(surface) ?? 0) + 1);
    if (reason === 'invalid') diagnostics.rejectedInvalid++;
    else if (reason === 'contraction') diagnostics.rejectedContraction++;
    else if (reason === 'function-word') diagnostics.rejectedFunctionWord++;
    else if (reason === 'title-only') diagnostics.rejectedTitleOnly++;
    else if (reason === 'common-word') diagnostics.rejectedCommonWord++;
    else if (reason === 'stoplist') diagnostics.rejectedStoplist++;
    else diagnostics.rejectedNoMidSentence++;
  };

  for (const chunk of chunks) {
    const headings = chunkHeadingKeys(chunk);
    const context = contextFor(chunk);
    for (const sentence of splitSentences(chunk.text)) {
      if (headings.has(sentenceKey(sentence))) continue;
      const segments = quoteSegments(sentence);
      diagnostics.quotedStarts += Math.max(0, segments.length - 1);
      for (const segment of segments) {
        const runs = capitalizedRuns(rosterSentenceTokens(segment));
        const initial = runs.find((run) => run.startIndex === 0);
        if (!initial) continue;
        diagnostics.sentenceInitialCandidates++;
        const check = evaluateRosterRun(initial, context);
        if (check.reason) {
          reject(check.reason, check.surface);
          continue;
        }
        const firstWord = check.tokens[0] ?? '';
        if (NAME_STARTER_STOPLIST.has(firstWord)) {
          reject('stoplist', check.surface);
          continue;
        }
        if (!check.tokens.some((token) => midTokens.has(token))) {
          reject('no-mid', check.surface);
          continue;
        }
        diagnostics.accepted++;
        const key = check.surface.toLowerCase();
        const existing = startedSurfaces.get(key);
        if (existing) existing.count++;
        else startedSurfaces.set(key, { surface: check.surface, tokens: check.tokens, count: 1 });
      }
    }
  }

  const exact = new Map<string, NameRosterEntry>();
  for (const [key, value] of midSurfaces) {
    exact.set(key, {
      surface: value.surface,
      surfaces: [value.surface],
      tokens: value.tokens,
      count: value.count,
      trustedSource: 'mid-sentence',
    });
  }
  for (const [key, value] of startedSurfaces) {
    const existing = exact.get(key);
    if (existing) {
      existing.count += value.count;
      continue;
    }
    exact.set(key, {
      surface: value.surface,
      surfaces: [value.surface],
      tokens: value.tokens,
      count: value.count,
      trustedSource: 'sentence-start-matched',
    });
  }

  diagnostics.topRejected = [...rejectedSurfaces.entries()]
    .map(([surface, count]) => ({ surface, count }))
    .sort((a, b) => b.count - a.count || compareText(a.surface, b.surface))
    .slice(0, 20);

  return { entries: collapseVariants([...exact.values()]), diagnostics };
}

/**
 * One surface for this entry in the window: the first variant actually present
 * whole-word, else the representative when one of its tokens occurs. Collapsed
 * variants never become two entries in the same list.
 */
function rosterEntryInWindow(
  entry: NameRosterEntry,
  hayCanonical: string,
  hayTokens: Set<string>,
): string[] {
  const present = entry.surfaces.find((surface) => {
    const canonical = canonicalName(surface);
    return !!canonical && ` ${hayCanonical} `.includes(` ${canonical} `);
  });
  if (present) return [present];
  const hit = entry.tokens.some((token) => hayTokens.has(token));
  return hit ? [entry.surface] : [];
}

/**
 * The entities this window actually mentions.
 *
 * The relations call is only allowed to use these names, so it cannot invent a
 * person and cannot attach a relation to a name it hallucinated.
 */
export function windowEntityNames(
  db: Db,
  projectId: number,
  window: ChunkRow[],
  roster?: NameRoster,
  entities?: Array<{ name: string; aliases: string[] }>,
): string[] {
  const hayCanonical = canonicalName(window.map((c) => c.text).join(' '));
  const hayTokens = new Set(hayCanonical.split(' ').filter(Boolean));
  const names: string[] = [];
  for (const entity of entities ?? listEntities(db, projectId)) {
    const variants = [entity.name, ...entity.aliases];
    if (
      variants.some((variant) =>
        nameMentionedFromTokens(variant, hayCanonical, hayTokens, { partial: true }),
      )
    ) {
      names.push(entity.name);
    }
  }
  // Finder spans ride along when a sidecar has recorded them: names the CPU
  // pointer saw in these passages, merged with the bank's names. Absent file
  // means today's behavior, exactly as before. Universal: names only, never
  // book-specific content in code.
  for (const n of finderNamesFor(db, window)) {
    if (!names.some((e) => e.toLowerCase() === n.toLowerCase())) names.push(n);
  }
  // The bank keeps exactly the list it had before the roster: the old 60-name
  // ceiling, deduped. Raising the total to 80 gives the roster room instead of
  // letting a saturated bank list squeeze every new name out.
  const bankNames = uniqueNames(names).slice(0, WINDOW_BANK_NAME_CAP);
  // Roster names are book-wide capitalization candidates, so a person the
  // entity call never banked can still be related inside a window that names
  // them. Whole-word only; the roster is names, never identities.
  const merged = [...bankNames];
  if (roster) {
    for (const entry of roster.entries) {
      const matched = rosterEntryInWindow(entry, hayCanonical, hayTokens);
      if (!matched.length) continue;
      merged.push(...matched);
    }
  }
  return uniqueNames(merged).slice(0, WINDOW_NAME_CAP);
}

/** The cleaned roster alone (no bank or finder names) for the window. */
export function windowRosterNames(window: ChunkRow[], roster: NameRoster): string[] {
  const hayCanonical = canonicalName(window.map((chunk) => chunk.text).join(' '));
  const hayTokens = new Set(hayCanonical.split(' ').filter(Boolean));
  const names: string[] = [];
  for (const entry of roster.entries) {
    for (const surface of rosterEntryInWindow(entry, hayCanonical, hayTokens)) names.push(surface);
  }
  return uniqueNames(names).slice(0, WINDOW_NAME_CAP);
}

/** Case-insensitive stable dedupe for one window's name list. */
function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of names) {
    const clean = name.trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    unique.push(clean);
  }
  return unique;
}

/** Trust order for automatic merges. A human confirmation is a label, not a
 * promotion: an accepted row and a confirmed accepted row are the same tier,
 * so a verdict can never change which claim survives or what it says. */
export function trustRank(status: string): number {
  return status === 'accepted' || status === 'user_confirmed' ? 1 : 0;
}

/** Cached finder-spans map: chunk seq -> names. Missing/unreadable = none. */
const finderCache = new Map<string, Map<number, string[]>>();
function finderNamesFor(db: Db, window: ChunkRow[]): string[] {
  const path = join(dirname(db.path), 'finder-spans.json');
  let bySeq = finderCache.get(path);
  if (bySeq === undefined) {
    bySeq = new Map();
    try {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string[]>;
        for (const [k, v] of Object.entries(raw)) {
          if (Array.isArray(v)) bySeq.set(Number(k), [...new Set(v.map((s) => String(s).trim()).filter(Boolean))].slice(0, 40));
        }
      }
    } catch {
      bySeq = new Map();
    }
    finderCache.set(path, bySeq);
  }
  const out: string[] = [];
  for (const c of window) {
    for (const n of bySeq.get(c.seq) ?? []) if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Check a quote, counting what the gate did with it when the gate is on. */
export function spanFor(
  raw: unknown,
  chunk: ChunkRow | undefined,
  neighbours: ChunkRow[],
  gate: boolean,
  verification: VerificationStats,
): SpanCheck {
  if (!gate) {
    // The pre-Phase-1 path keeps its lenient correction.
    return { ...verifyQuote(raw, chunk, neighbours), status: 'verified' };
  }
  const span = verifySpan(raw, chunk, neighbours);
  verification.claimed++;
  if (span.status === 'verified') verification.verified++;
  else if (span.status === 'repointed') verification.repointed++;
  else verification.dropped++;
  return span;
}

/** Write the entity section. Returns how many claims were accepted. */
export function applyEntities(
  db: Db,
  projectId: number,
  raws: Record<string, unknown>[],
  window: ChunkRow[],
  entityIdByName: Map<string, number>,
  stats: ExtractLoreResult,
  neighboursOf: (id: number | undefined) => ChunkRow[],
  gate: boolean,
): number {
  let accepted = 0;
  // The schema caps the list at 30, but the model fills it with props unless
  // people are ordered first. Backstop the ordering here: a dense window may
  // still return many items/rules, and those must not crowd out characters.
  let items = 0;
  let rules = 0;
  for (const raw of raws) {
    const name = String(raw.name ?? '').trim();
    if (!name) continue;
    const kind = normaliseKind(String(raw.kind ?? 'character'));
    if (kind === 'item') {
      if (items >= 5) continue;
      items++;
    } else if (kind === 'rule') {
      if (rules >= 3) continue;
      rules++;
    }
    // A description, a conjunction, or a group is never a new character.
    // Skipped here, relations naming it fall into the existing unresolved
    // path and are counted there.
    if (
      kind === 'character' &&
      (isDescriptiveCharacterName(name) || isConjoinedCharacterName(name) || isGroupCharacterName(name))
    ) {
      continue;
    }
    const chunk = chunkAt(window, raw.chunk_index);
    const span = spanFor(raw.evidence, chunk, neighboursOf(chunk?.id), gate, stats.verification);
    if (span.status === 'dropped') continue;
    const evidence = span.quote;
    const refs = span.chunkId !== null
      ? [{ source: span.source, locator: span.locator, chunk: span.chunkId }]
      : refsFor(chunk);
    const existing = entityIdByName.get(key(name)) ?? findEntityId(db, projectId, kind, name);
    const attributes = (raw.attributes ?? {}) as Record<string, unknown>;
    if (existing) {
      // Fill-only metadata: a repeat or a narrower follow-up must not replace a
      // richer summary/role/status/evidence, and a human-confirmed row stays
      // human-confirmed. New aliases and evidence links append once per
      // contribution; the caller's exact-repeat filter prevents double counts.
      const current = db.get<{
        aliases: string;
        source_refs: string;
        summary: string;
        role: string;
        status: string;
        attributes: string;
        evidence: string;
        review_status: string;
      }>(
        `SELECT aliases, source_refs, summary, role, status, attributes, evidence, review_status
           FROM canon_entity WHERE id = ? AND project_id = ?`,
        existing,
        projectId,
      );
      if (!current) {
        entityIdByName.set(key(name), existing);
        accepted++;
        continue;
      }
      const nextSummary = String(raw.summary ?? '').trim();
      const nextRole = String(raw.role ?? '').trim();
      const nextStatus = String(raw.status ?? '').trim();
      const nextAttributes = toJson(
        Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k, String(v)])),
      );
      const nextEvidence = evidence;
      const nonEmpty = (value: string): boolean => value.trim().length > 0;
      const attrsNonEmpty = (value: string): boolean => value.trim() !== '' && value.trim() !== '{}';
      const conflict =
        (nonEmpty(nextSummary) && nonEmpty(current.summary) && nextSummary !== current.summary) ||
        (nonEmpty(nextRole) && nonEmpty(current.role) && nextRole !== current.role) ||
        (nonEmpty(nextStatus) && nonEmpty(current.status) && nextStatus !== current.status) ||
        (attrsNonEmpty(nextAttributes) && attrsNonEmpty(current.attributes) && nextAttributes !== current.attributes) ||
        (nonEmpty(nextEvidence) && nonEmpty(current.evidence) && nextEvidence !== current.evidence);
      const aliases = [
        ...new Set([...strList(current.aliases), ...toStringArray(raw.aliases)]),
      ];
      const refsMerged = [
        ...new Map(
          [...fromJson<unknown[]>(current.source_refs, []), ...refs].map((item) => [
            JSON.stringify(item),
            item,
          ]),
        ).values(),
      ];
      db.run(
        `UPDATE canon_entity SET
           summary = CASE WHEN summary = '' THEN ? ELSE summary END,
           role = CASE WHEN role = '' THEN ? ELSE role END,
           status = CASE WHEN status = '' THEN ? ELSE status END,
           attributes = CASE WHEN attributes = '' OR attributes = '{}' THEN ? ELSE attributes END,
           evidence = CASE WHEN evidence = '' THEN ? ELSE evidence END,
           aliases = ?, source_refs = ?,
           review_status = CASE
             WHEN review_status = 'user_confirmed' THEN review_status
             WHEN ? THEN 'needs_review'
             ELSE review_status
           END,
           mentions = mentions + 1,
           updated_at = ?
         WHERE id = ? AND project_id = ?`,
        nextSummary,
        nextRole,
        nextStatus,
        nextAttributes,
        nextEvidence,
        toJson(aliases),
        toJson(refsMerged),
        conflict ? 1 : 0,
        nowIso(),
        existing,
        projectId,
      );
      entityIdByName.set(key(name), existing);
      accepted++;
      continue;
    }
    db.run(
      `INSERT OR IGNORE INTO canon_entity (project_id, claim_uid, kind, name, aliases, summary, attributes, role, status,
                                 first_chunk, evidence, source_refs, mentions, review_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'needs_review', ?, ?)`,
      projectId,
      newClaimUid('entity'),
      kind,
      name,
      toJson(toStringArray(raw.aliases)),
      String(raw.summary ?? '').trim(),
      toJson(Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k, String(v)]))),
      String(raw.role ?? '').trim(),
      String(raw.status ?? '').trim(),
      span.chunkId ?? chunk?.id ?? null,
      evidence,
      toJson(refs),
      nowIso(),
      nowIso(),
    );
    const row = db.get<{ id: number }>(
      'SELECT id FROM canon_entity WHERE project_id = ? AND kind = ? AND lower(name) = lower(?)',
      projectId,
      kind,
      name,
    );
    if (row) {
      entityIdByName.set(key(name), row.id);
      stats.entities++;
      accepted++;
    }
  }
  return accepted;
}

/** Write the fact section. Returns how many claims were accepted. */
export function applyFacts(
  db: Db,
  projectId: number,
  raws: Record<string, unknown>[],
  window: ChunkRow[],
  stats: ExtractLoreResult,
  neighboursOf: (id: number | undefined) => ChunkRow[],
  gate: boolean,
): number {
  let accepted = 0;
  for (const raw of raws) {
    const statement = String(raw.statement ?? '').trim();
    if (!statement) continue;
    const chunk = chunkAt(window, raw.chunk_index);
    const span = spanFor(raw.evidence, chunk, neighboursOf(chunk?.id), gate, stats.verification);
    if (span.status === 'dropped') continue;
    const subject = String(raw.subject ?? '').trim();
    const subjectLink = subject ? resolveSubjectEntity(db, projectId, subject) : { missing: true as const };
    const subjectEntityId = 'id' in subjectLink ? subjectLink.id : null;
    const dup = db.get<{ id: number; subject_entity_id: number | null }>(
      'SELECT id, subject_entity_id FROM canon_fact WHERE project_id = ? AND statement = ?',
      projectId,
      statement,
    );
    if (dup) {
      // A duplicate statement is an update opportunity, never a second row.
      // Only fill a missing link; an existing link is never overwritten.
      if (subjectEntityId !== null && dup.subject_entity_id === null) {
        db.run('UPDATE canon_fact SET subject_entity_id = ? WHERE id = ?', subjectEntityId, dup.id);
      }
      accepted++;
      continue;
    }
    const refs = span.chunkId !== null
      ? [{ source: span.source, locator: span.locator, chunk: span.chunkId }]
      : refsFor(chunk);
    // canon_fact.review_status is advisory: facts are context, never proof of a
    // claim, and there is no promotion path by design.
    db.run(
      `INSERT INTO canon_fact (project_id, claim_uid, topic, statement, kind, certainty, subject, evidence, source_refs, subject_entity_id, modality, review_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_review', ?)`,
      projectId,
      newClaimUid('fact'),
      String(raw.topic ?? '').trim(),
      statement,
      String(raw.kind ?? 'fact').trim(),
      String(raw.certainty ?? 'confirmed').trim(),
      subject,
      span.quote,
      toJson(refs),
      subjectEntityId,
      normaliseModality(raw.modality),
      nowIso(),
    );
    stats.facts++;
    accepted++;
  }
  return accepted;
}

export function proofTokens(text: string, minLen: number): Set<string> {
  return new Set(
    normalise(String(text ?? ''))
      .split(' ')
      .filter((w) => w.length >= minLen && !PROOF_TITLES.has(w) && !PROOF_FILLER.has(w)),
  );
}

/** Roster names with aliases for one project: id -> token set. */
export function rosterTokens(db: Db, projectId: number): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const row of db.all<{ id: number; name: string; aliases: string }>(
    'SELECT id, name, aliases FROM canon_entity WHERE project_id = ?',
    projectId,
  )) {
    const toks = proofTokens(row.name, 3);
    for (const a of strList(row.aliases)) for (const t of proofTokens(a, 3)) toks.add(t);
    out.set(row.id, toks);
  }
  return out;
}

/**
 * Proof relevance (soft cap: demote, never delete).
 *
 * A proving quote passes when it names at least one endpoint of its claim,
 * or when it names nobody at all (pronoun and scene-color quotes stay).
 * It fails only when it names a *third* roster person absent from the claim —
 * a quote about Neville attached to a Seamus-to-Ron claim. Same-subject
 * fiction, unjudged meaning: the row is still written, flagged for review.
 */
function proofRelevance(
  roster: Map<number, Set<string>>,
  fromId: number,
  toId: number,
  quote: string,
): boolean {
  const words = proofTokens(quote, 3);
  if (!words.size) return true;
  const endpoints = new Set<string>();
  for (const id of [fromId, toId]) for (const t of roster.get(id) ?? []) endpoints.add(t);
  if ([...endpoints].some((t) => words.has(t))) return true;
  for (const [id, toks] of roster) {
    if (id === fromId || id === toId) continue;
    for (const t of toks) {
      if (t.length >= 4 && words.has(t)) return false;
    }
  }
  return true;
}
