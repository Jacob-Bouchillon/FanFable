/**
 * Name harvest: find capitalised names the window extractor never banked.
 *
 * Read-only. Candidates are proposals; classification and entity writing happen
 * outside this module.
 */
import { Db, fromJson } from '../core/db.ts';
import { extractJson } from '../core/json.ts';
import { STOPWORDS } from '../core/vocab.ts';
import { candidateCategory } from './candidate-categories.ts';

export interface HarvestCandidate {
  surface: string;
  count: number;
  firstChunkId: number;
  firstLocator: string;
  sentences: Array<{ chunkId: number; locator: string; text: string }>;
}

export interface HarvestClassification {
  surface: string;
  kind: string;
  name: string;
  quote: string;
  chunkIndex: number;
  category?: string;
  sentient?: boolean | null;
  speaks?: boolean | null;
  reason?: string;
}

export const HARVEST_KINDS = new Set([
  'character', 'location', 'item', 'creature', 'faction', 'species', 'rule',
]);

/** A generic surface is one whose words are all ordinary lowercase words. */
function normalizeName(value: string): string {
  return collapseWhitespace(value).toLowerCase();
}

/** Compare surfaces without surrounding quotes or exclamation marks. */
function surfaceKey(value: string): string {
  return normalizeName(value).replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

/**
 * The owner in a possessive surface: "Malfoy's eagle owl" -> "Malfoy".
 * Whether the possessed thing is an animal is the classifier's decision.
 */
export function possessiveCreatureOwner(surface: string): string | null {
  const text = collapseWhitespace(surface);
  const match = /^([A-Z][A-Za-z'’\-]+)['’]s\s+(.+)$/.exec(text);
  return match ? match[1]! : null;
}

export function harvestKind(value: string): string | null {
  const kind = String(value ?? '').trim().toLowerCase();
  if (kind === 'organization' || kind === 'organisation') return 'faction';
  return HARVEST_KINDS.has(kind) ? kind : null;
}

function mentions(text: string, form: string): boolean {
  const value = collapseWhitespace(form);
  if (!value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(text);
}

/** "Brown, Lavender" is a sorting-list form; the name is "Lavender Brown". */
function properName(value: string): string {
  const trimmed = collapseWhitespace(value);
  const match = /^([^,]+),\s*(\S.*)$/.exec(trimmed);
  return match ? `${match[2]} ${match[1]}` : trimmed;
}

export function parseHarvestAnswer(text: string): HarvestClassification[] {
  const parsed = extractJson<unknown>(text);
  let entries: unknown[] = [];
  if (Array.isArray(parsed)) entries = parsed;
  else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { entities?: unknown }).entities)) {
    entries = (parsed as { entities: unknown[] }).entities;
  }
  const entities: HarvestClassification[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.surface !== 'string' || !entry.surface.trim()) continue;
    if (typeof entry.kind !== 'string' || !entry.kind.trim()) continue;
    const name = typeof entry.name === 'string' ? entry.name : '';
    const quote = typeof entry.quote === 'string' ? entry.quote : '';
    const category = typeof entry.category === 'string'
      ? entry.category
      : typeof entry.category_id === 'string' ? entry.category_id : undefined;
    const sentient = typeof entry.sentient === 'boolean' ? entry.sentient : null;
    const speaks = typeof entry.speaks === 'boolean' ? entry.speaks : null;
    const rawIndex = entry.chunk_index ?? entry.chunkIndex;
    const chunkIndex = rawIndex === undefined ? -1 : Number(rawIndex);
    const reason = typeof entry.reason === 'string' && entry.reason.trim() ? entry.reason : undefined;
    entities.push({
      surface: entry.surface.trim(),
      kind: entry.kind.trim(),
      name,
      quote,
      chunkIndex: Number.isInteger(chunkIndex) ? chunkIndex : -1,
      ...(category === undefined ? {} : { category }),
      sentient,
      speaks,
      ...(reason === undefined ? {} : { reason }),
    });
  }
  return entities;
}

export type HarvestRejection =
  | 'bad-shape'
  | 'unknown-surface'
  | 'none'
  | 'kind-not-allowed'
  | 'quote-absent'
  | 'quote-not-found'
  | 'surface-not-in-quote'
  | 'generic-noun'
  | 'group-not-person'
  | 'category'
  | 'already-banked';

export type HarvestVerdict =
  | {
    ok: true;
    kind: string;
    name: string;
    category?: string;
    attributes: { sentient: boolean | null; speaks: boolean | null };
  }
  | { ok: false; reason: HarvestRejection; category?: string; note?: string };

export function validateHarvestClassification(
  entity: HarvestClassification,
  candidate: HarvestCandidate,
  sentence: { chunkId: number; locator: string; text: string; chunkText: string },
  isBanked: (name: string) => boolean,
  isFamilyGroup: (name: string) => boolean = () => false,
  isCommonSurface: (name: string) => boolean = () => false,
  isPlural: (name: string) => boolean = () => false,
): HarvestVerdict {
  if (!entity || typeof entity.surface !== 'string' || typeof entity.kind !== 'string') {
    return { ok: false, reason: 'bad-shape' };
  }
  if (surfaceKey(entity.surface) !== surfaceKey(candidate.surface)) {
    return { ok: false, reason: 'unknown-surface' };
  }
  const owner = possessiveCreatureOwner(candidate.surface);
  const category = entity.category ? candidateCategory(entity.category) : null;
  let kind = harvestKind(entity.kind);
  let name = properName(collapseWhitespace(entity.name) || candidate.surface);

  if (category && category.id !== 'ambiguous') {
    if (category.id === 'role' || category.id === 'discipline' || category.id === 'unit'
      || category.id === 'calendar' || category.id === 'honorific') {
      return { ok: false, reason: 'category', category: category.id, note: category.distinction };
    }
    const named = owner !== null || !isCommonSurface(candidate.surface);
    const mapped = named ? category.named : category.plural;
    if (mapped) {
      kind = harvestKind(mapped);
      if (named) name = candidate.surface;
    }
  }
  if (!category && entity.kind.trim().toLowerCase() === 'none') {
    return { ok: false, reason: 'none' };
  }
  if (!kind) return { ok: false, reason: 'kind-not-allowed' };
  if (!entity.quote.trim()) return { ok: false, reason: 'quote-absent' };
  const quote = collapseWhitespace(entity.quote);
  if (!collapseWhitespace(sentence.chunkText).includes(quote)) {
    return { ok: false, reason: 'quote-not-found' };
  }
  if (!mentions(quote, candidate.surface)) {
    return { ok: false, reason: 'surface-not-in-quote' };
  }

  // A possessive surface names one individual. Whether it is a creature is
  // the classifier's decision; "Harry's wand" stays an item.
  if (!category && owner && (kind === 'character' || kind === 'creature')) {
    kind = 'creature';
    name = candidate.surface;
  } else if (
    !category
    && !owner
    && (kind === 'character' || kind === 'creature')
    && isCommonSurface(candidate.surface)
  ) {
    return { ok: false, reason: 'generic-noun' };
  }
  // A plural creature surface is a species/breed, not an individual.
  if (!category && kind === 'creature' && !owner && isPlural(candidate.surface)) {
    kind = 'species';
  }
  if (kind === 'character' && isFamilyGroup(name)) {
    return { ok: false, reason: 'group-not-person' };
  }
  if (isBanked(name) || isBanked(candidate.surface)) {
    return { ok: false, reason: 'already-banked' };
  }
  return {
    ok: true,
    kind,
    name,
    ...(category ? { category: category.id } : {}),
    attributes: {
      sentient: typeof entity.sentient === 'boolean' ? entity.sentient : null,
      speaks: typeof entity.speaks === 'boolean' ? entity.speaks : null,
    },
  };
}

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'professor', 'uncle', 'aunt', 'lord', 'madam', 'dr']);
/** Kinship qualifiers that sit before the actual name ("Great Uncle Algie"). */
const KINSHIP_TITLES = new Set([
  'uncle', 'aunt', 'great', 'grand', 'grandma', 'grandpa', 'granny',
  'grandmother', 'grandfather', 'cousin',
]);
const PRONOUN_BASES = new Set([
  'i', 'he', 'she', 'it', 'that', 'there', 'what', 'who', 'this', 'here',
  'we', 'you', 'they', 'everyone', 'everybody', 'someone', 'somebody',
  'nobody', 'none',
]);
const ARTICLES = new Set(['the', 'a', 'an']);
/**
 * Frequent sentence-initial and dialogue words. Capitalised only because they
 * open a sentence or sit after a quote mark; they are never the name.
 */
const COMMON_WORDS = new Set([
  'i', 'me', 'my', 'mine', 'myself', 'we', 'us', 'our', 'ours', 'you', 'your', 'yours',
  'he', 'him', 'his', 'she', 'her', 'hers', 'it', 'its', 'they', 'them', 'their', 'theirs',
  'this', 'that', 'these', 'those', 'who', 'whom', 'whose', 'which', 'what',
  'when', 'where', 'why', 'how', 'there', 'here',
  'everyone', 'everybody', 'someone', 'somebody', 'anyone', 'anybody', 'nobody',
  'yes', 'yeah', 'yep', 'no', 'nope', 'oh', 'ah', 'er', 'um', 'uh', 'okay', 'ok',
  'please', 'thanks', 'thank', 'well', 'so', 'then', 'now', 'just', 'only', 'also',
  'still', 'even', 'ever', 'again', 'once', 'too', 'very', 'really', 'quite', 'rather',
  'perhaps', 'maybe', 'anyway', 'anyhow', 'somehow', 'however', 'therefore',
  'come', 'came', 'go', 'goes', 'going', 'went', 'gone', 'look', 'looked', 'looking',
  'see', 'saw', 'seen', 'get', 'got', 'gotten', 'give', 'gave', 'given', 'let',
  'left', 'right', 'good', 'bad', 'one', 'two', 'three', 'four', 'five',
  'after', 'before', 'during', 'while', 'since', 'until',
  'never', 'nothing', 'something', 'anything', 'everything', 'always', 'sometimes', 'often',
  'people', 'person', 'man', 'woman', 'boy', 'girl', 'mom', 'mum', 'dad', 'mother', 'father',
  'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'many', 'much',
  'do', 'does', 'did', 'done', 'doing', 'have', 'has', 'had', 'having',
  'be', 'am', 'is', 'are', 'was', 'were', 'been', 'being',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'say', 'says', 'said', 'ask', 'asks', 'asked', 'tell', 'tells', 'told',
  'think', 'thinks', 'thought', 'know', 'knows', 'knew', 'known',
  'want', 'wants', 'wanted', 'need', 'needs', 'needed',
  'make', 'makes', 'made', 'take', 'takes', 'took', 'taken', 'put', 'puts',
  'keep', 'keeps', 'kept',
]);
const NOISE = new Set([
  ...HONORIFICS,
  ...KINSHIP_TITLES,
  ...COMMON_WORDS,
  'chapter', 'chapters', 'part', 'book', 'volume', 'page', 'pages',
]);

interface WordToken {
  text: string;
  start: number;
  end: number;
  lower: string;
  capitalized: boolean;
  allCaps: boolean;
}

interface NormalizedWord {
  surface: string;
  possessive: boolean;
}

function collapseWhitespace(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeWord(text: string): NormalizedWord | null {
  if (text.includes("'") || text.includes('’')) {
    if (/['’]s$/i.test(text)) {
      const base = text.slice(0, -2);
      if (PRONOUN_BASES.has(base.toLowerCase())) return null;
      return { surface: base, possessive: true };
    }
    if (/['’](?:t|m|re|ve|ll|d)$/i.test(text)) return null;
    // Dialect elisions ("An'", "somethin'") are not names.
    const trimmed = text.replace(/['’]+$/, '');
    if (trimmed !== text) return { surface: trimmed, possessive: false };
  }
  return { surface: text, possessive: false };
}

function tokenizeSentence(sentence: string): WordToken[] {
  const out: WordToken[] = [];
  const re = /[A-Za-z][A-Za-z'’\-]*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sentence)) !== null) {
    const text = match[0];
    const lower = text.toLowerCase();
    out.push({
      text,
      start: match.index,
      end: match.index + text.length,
      lower,
      capitalized: /^[A-Z]/.test(text),
      allCaps: text.length > 1 && text === text.toUpperCase() && /[A-Z]/.test(text),
    });
  }
  return out;
}

/**
 * Line-aware sentences. splitSentences() drops a line that runs into a newline
 * without terminal punctuation, which is exactly how long dialogue and
 * commentary paragraphs are printed. Keep that remainder as its own sentence.
 */
function harvestSentences(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of String(text ?? '').split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let last = 0;
    const re = /[.!?]+["')\]]*/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      const end = match.index + match[0].length;
      const piece = line.slice(last, end).trim();
      if (piece) out.push(piece);
      last = end;
    }
    const rest = line.slice(last).trim();
    if (rest) out.push(rest);
  }
  return out;
}

function distinctiveTokens(value: string): string[] {
  return (String(value ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((token) => token.length > 2 && !STOPWORDS.has(token) && !NOISE.has(token));
}

function isNoiseWord(token: string): boolean {
  return token.length <= 2 || STOPWORDS.has(token) || NOISE.has(token);
}

function headingContains(heading: string, surface: string): boolean {
  const h = normalizeName(heading);
  const s = normalizeName(surface);
  if (!h || !s) return false;
  return h.includes(s) || s.includes(h);
}

/**
 * Sorting lists write "Surname, Given". The quoted form is a reliable signal:
 * an ordinary list ("Harry, Ron") is not quoted and stays out.
 */
function findReversedPairs(text: string): Array<{ surface: string; start: number; end: number }> {
  const out: Array<{ surface: string; start: number; end: number }> = [];
  const re = /"\s*([A-Z][A-Za-z'’\-]+),\s+([A-Z][A-Za-z'’\-]+)!?"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    out.push({
      surface: `${match[1]}, ${match[2]}`,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return out;
}

/**
 * A possessive animal names one individual: "Malfoy's eagle owl" is the
 * creature, not a generic owl and not an owl owned by nobody.
 */
function findPossessiveCreatures(text: string): Array<{ surface: string; owner: string }> {
  const out: Array<{ surface: string; owner: string }> = [];
  const re = /\b([A-Z][A-Za-z'’\-]+)['’]s\s+((?:[a-z]+\s+){0,2}[a-z]+)\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const owner = match[1]!;
    // "He's a centaur" is a contraction, not an owner.
    if (PRONOUN_BASES.has(owner.toLowerCase())) continue;
    const words = match[2]!.trim().split(/\s+/).filter(Boolean);
    while (words.length && STOPWORDS.has(words[words.length - 1]!)) words.pop();
    const head = words[words.length - 1] ?? '';
    if (head.length < 3 || STOPWORDS.has(head)) continue;
    out.push({ surface: `${owner}'s ${words.join(' ')}`, owner });
  }
  return out;
}

export function planNameHarvest(
  db: Db,
  projectId: number,
  opts: { limit?: number; minCount?: number } = {},
): HarvestCandidate[] {
  const limit = Math.max(1, Math.floor(opts.limit ?? 200));
  const minCount = Math.max(1, Math.floor(opts.minCount ?? 1));

  const bankedNames = new Set<string>();
  const bankedTokens = new Set<string>();
  const entities = db.all<{ name: string; aliases: string }>(
    'SELECT name, aliases FROM canon_entity WHERE project_id = ?',
    projectId,
  );
  for (const entity of entities) {
    for (const value of [entity.name, ...fromJson<string[]>(entity.aliases, [])]) {
      const name = collapseWhitespace(value);
      if (!name) continue;
      bankedNames.add(normalizeName(name));
      for (const token of distinctiveTokens(name)) bankedTokens.add(token);
    }
  }
  const isBanked = (surface: string): boolean => {
    if (bankedNames.has(normalizeName(surface))) return true;
    const tokens = distinctiveTokens(surface);
    return tokens.length > 0 && tokens.every((token) => bankedTokens.has(token));
  };

  const chunks = db.all<{ id: number; seq: number; locator: string; heading: string; text: string }>(
    'SELECT id, seq, locator, heading, text FROM canon_chunk WHERE project_id = ? ORDER BY seq, id',
    projectId,
  );
  const candidates = new Map<string, HarvestCandidate & { firstSeq: number }>();

  const addCandidate = (
    surface: string,
    sentence: string,
    chunk: { id: number; seq: number; locator: string; heading: string },
  ): void => {
    const clean = collapseWhitespace(surface);
    if (!clean || headingContains(chunk.heading, clean) || isBanked(clean)) return;
    const key = normalizeName(clean);
    const existing = candidates.get(key);
    if (existing) {
      existing.count++;
      if (existing.sentences.length < 3) {
        const text = collapseWhitespace(sentence);
        if (text && !existing.sentences.some((entry) => entry.chunkId === chunk.id && entry.text === text)) {
          existing.sentences.push({ chunkId: Number(chunk.id), locator: chunk.locator, text });
        }
      }
      return;
    }
    candidates.set(key, {
      surface: clean,
      count: 1,
      firstChunkId: Number(chunk.id),
      firstLocator: chunk.locator,
      firstSeq: Number(chunk.seq),
      sentences: [{ chunkId: Number(chunk.id), locator: chunk.locator, text: collapseWhitespace(sentence) }],
    });
  };

  for (const chunk of chunks) {
    const sentences = harvestSentences(String(chunk.text ?? ''));
    for (const sentence of sentences) {
      const tokens = tokenizeSentence(sentence);
      if (!tokens.length) continue;

      // A quoted "Surname, Given" is a sorting-list name. Add the text form as
      // the candidate (so the quote matches) and keep its two tokens out of the
      // ordinary runs, which would otherwise see two unrelated surnames.
      const pairs = findReversedPairs(sentence);
      for (const pair of pairs) addCandidate(pair.surface, sentence, chunk);
      // A possessive animal is one named individual; keep the whole surface.
      for (const owned of findPossessiveCreatures(sentence)) {
        addCandidate(owned.surface, sentence, chunk);
      }
      const inPair = (token: WordToken): boolean =>
        pairs.some((pair) => token.start >= pair.start && token.end <= pair.end);

      let run: Array<{ token: WordToken; word: NormalizedWord }> = [];
      const flush = (): void => {
        if (!run.length) return;
        let entries = run;
        run = [];

        // Sentence-initial capitalisation is not a name. Titles in that
        // position ("Professor", "Aunt") are capitalisation too.
        while (
          entries.length
          && entries[0]!.token === tokens[0]
          && isNoiseWord(entries[0]!.word.surface.toLowerCase())
        ) {
          entries = entries.slice(1);
        }
        while (entries.length > 1 && ARTICLES.has(entries[0]!.word.surface.toLowerCase())) {
          entries = entries.slice(1);
        }
        if (!entries.length) return;
        // A long run ends in the name; keep the tail.
        if (entries.length > 3) entries = entries.slice(-3);
        // Kinship qualifiers sit before the name ("Great Uncle Algie").
        while (
          entries.length > 1
          && KINSHIP_TITLES.has(entries[0]!.word.surface.toLowerCase())
        ) {
          entries = entries.slice(1);
        }
        if (!entries.length) return;

        const words = entries.map((entry) => entry.word.surface);
        const kept = words.map((word) => word.toLowerCase());
        if (kept.every(isNoiseWord)) return;
        if (entries.length === 1) {
          const single = kept[0]!;
          if (entries[0]!.token === tokens[0]) return;
          if (isNoiseWord(single) || /\d/.test(single)) return;
          if (inPair(entries[0]!.token)) return;
        }
        addCandidate(words.join(' '), sentence, chunk);
      };

      let previous: WordToken | null = null;
      for (const token of tokens) {
        const word = !token.allCaps && token.capitalized ? normalizeWord(token.text) : null;
        const gap = previous ? sentence.slice(previous.end, token.start) : '';
        const contiguous = !previous || /^\s+$/.test(gap);
        if (!word || !contiguous) {
          flush();
          previous = token;
          if (word) run.push({ token, word });
          if (word?.possessive) flush();
          continue;
        }
        run.push({ token, word });
        previous = token;
        if (word.possessive) flush();
      }
      flush();
    }
  }

  return [...candidates.values()]
    .filter((candidate) => candidate.count >= minCount)
    .sort((left, right) =>
      right.count - left.count
      || left.firstSeq - right.firstSeq
      || left.firstChunkId - right.firstChunkId)
    .slice(0, limit)
    .map(({ firstSeq: _firstSeq, ...candidate }) => candidate);
}
