/**
 * Chapter derivation from the text itself.
 *
 * The stored heading/locator can lag behind a heading paragraph that sits
 * inside a chunk ("CHAPTER SEVEN" at the top of the first chapter-7 passage).
 * Read the heading paragraph first, fall back to the stored heading/locator,
 * then to a contents list, then to an even split. No book-specific names.
 */
export interface ChapterChunkInput {
  id: number;
  seq: number;
  heading: string;
  locator: string;
  text: string;
}

export interface ChapterAssignment {
  chapter: number;
  title: string;
}

const ROMAN: Record<string, number> = {
  i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000,
};

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

function fromRoman(value: string): number | null {
  const text = value.toLowerCase();
  if (!/^[ivxlcdm]+$/.test(text)) return null;
  let total = 0;
  let previous = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const current = ROMAN[text[i]!] ?? 0;
    if (!current) return null;
    if (current < previous) total -= current;
    else {
      total += current;
      previous = current;
    }
  }
  return total > 0 ? total : null;
}

function fromWords(value: string): number | null {
  const parts = value.toLowerCase().trim().split(/[\s-]+/).filter(Boolean);
  if (!parts.length) return null;
  let total = 0;
  for (const part of parts) {
    const n = WORD_NUMBERS[part];
    if (n === undefined) return null;
    total += n;
  }
  return total > 0 ? total : null;
}

function toNumber(value: string): number | null {
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const roman = fromRoman(text);
  if (roman !== null) return roman;
  return fromWords(text);
}

function looksLikeTitle(line: string): boolean {
  const text = line.trim();
  if (!text || text.length > 70) return false;
  if (/[.!?;:,]$/.test(text)) return false;
  return text.split(/\s+/).filter(Boolean).length <= 10;
}

/**
 * Parse a heading paragraph. Accepts "CHAPTER SEVEN", "Chapter 7", "7.",
 * "VII", and returns the title when it sits on the next line.
 */
export function parseChapterHeading(line: string, nextLine = ''): { number: number; title: string } | null {
  const text = String(line ?? '').trim().replace(/^#{1,6}\s+/, '');
  if (!text) return null;
  const named = /^(?:chapter|chap\.?|book|part)\s+([0-9]+|[ivxlcdm]+|[a-z]+(?:[\s-][a-z]+)?)\b[:.\-–—]?\s*(.*)$/i.exec(text);
  if (named) {
    const number = toNumber(named[1]!);
    if (number === null) return null;
    const rest = named[2]!.trim();
    const title = rest || (looksLikeTitle(nextLine) ? nextLine.trim() : '');
    return { number, title };
  }
  const dotted = /^([0-9]{1,3})[.)]\s*(.*)$/.exec(text);
  if (dotted && (dotted[2]!.trim() || looksLikeTitle(nextLine))) {
    return { number: Number(dotted[1]), title: dotted[2]!.trim() || nextLine.trim() };
  }
  // A bare roman numeral is a chapter only when it stands alone: followed by a
  // separator, end of line, or a title. Without this, any line beginning with
  // M, D, C, L, X, V or I ("Mr. Dursley", "Dudley") reads as 1000 or 500.
  const roman = /^([IVXLCDM]+)(?:[.)\]]|\s*$|\s{2,})\s*(.*)$/.exec(text);
  if (roman) {
    const number = fromRoman(roman[1]!);
    if (number !== null) {
      const rest = roman[2]!.trim();
      const title = rest || (looksLikeTitle(nextLine) ? nextLine.trim() : '');
      return { number, title };
    }
  }
  return null;
}

/** The chapter number stored in a locator or heading, when one is present. */
export function chapterNumberFromLocator(locator: string): number | null {
  const text = String(locator ?? '');
  const named = /(?:chapter|chap\.?|book|part)\s+([0-9]+|[ivxlcdm]+|[a-z]+(?:[\s-][a-z]+)?)\b/i.exec(text);
  if (named) return toNumber(named[1]!);
  const dotted = /^\s*([0-9]{1,3})[.)]\s+/.exec(text);
  if (dotted) return Number(dotted[1]);
  return null;
}

function firstLines(text: string, count: number): string[] {
  return String(text ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, count);
}

/**
 * Contents fallback: lines such as "1: The Boy Who Lived" in the opening
 * chunks. Returns titles in order; at least three entries are required.
 */
function contentsTitles(chunks: ChapterChunkInput[]): string[] {
  const titles: string[] = [];
  for (const chunk of chunks.slice(0, 12)) {
    for (const line of firstLines(chunk.text, 40)) {
      const match = /^([0-9]{1,3})[:.]\s+(\S.*)$/.exec(line);
      if (match) titles.push(match[2]!.trim().toLowerCase());
    }
  }
  return titles.length >= 3 ? titles : [];
}

function evenSplit(count: number, chapterCount?: number): number[] {
  const total = Math.max(1, Math.floor(chapterCount ?? Math.max(1, Math.round(count / 25))));
  return Array.from({ length: count }, (_, index) =>
    Math.min(total, Math.floor((index * total) / Math.max(1, count)) + 1));
}

/**
 * Assign every chunk a chapter number. The text heading wins over the stored
 * heading/locator, which is what fixes a chapter whose heading paragraph fell
 * inside the first passage.
 */
export function deriveChapterNumbers(
  chunks: ChapterChunkInput[],
  opts: { chapterCount?: number } = {},
): Map<number, ChapterAssignment> {
  const ordered = [...chunks].sort((left, right) => left.seq - right.seq || left.id - right.id);
  const out = new Map<number, ChapterAssignment>();
  let current = 0;
  let currentTitle = '';
  let sawTextHeading = false;

  for (const chunk of ordered) {
    const lines = firstLines(chunk.text, 4);
    let heading: { number: number; title: string } | null = null;
    for (let index = 0; index < Math.min(lines.length, 3); index++) {
      const parsed = parseChapterHeading(lines[index]!, lines[index + 1] ?? '');
      if (parsed) {
        heading = parsed;
        break;
      }
    }
    if (heading) {
      current = heading.number;
      currentTitle = heading.title;
      sawTextHeading = true;
    } else {
      const fallback = parseChapterHeading(chunk.heading)
        ?? (chapterNumberFromLocator(chunk.locator) === null
          ? null
          : { number: chapterNumberFromLocator(chunk.locator)!, title: '' });
      if (fallback && (current === 0 || fallback.number !== current)) {
        current = fallback.number;
        if (fallback.title) currentTitle = fallback.title;
      }
    }
    if (current === 0) current = 1;
    out.set(chunk.id, { chapter: current, title: currentTitle });
  }

  if (sawTextHeading) return out;

  // No chapter heading in the prose. Prefer a contents list, then even splits.
  const titles = contentsTitles(ordered);
  if (titles.length) {
    let chapter = 0;
    let titleIndex = -1;
    for (const chunk of ordered) {
      const hay = String(chunk.text ?? '').toLowerCase();
      for (let index = titleIndex + 1; index < titles.length; index++) {
        if (hay.includes(titles[index]!)) {
          chapter = index + 1;
          titleIndex = index;
          break;
        }
      }
      if (chapter === 0) chapter = 1;
      out.set(chunk.id, { chapter, title: titles[chapter - 1] ?? '' });
    }
    return out;
  }

  const numbers = evenSplit(ordered.length, opts.chapterCount);
  ordered.forEach((chunk, index) => out.set(chunk.id, { chapter: numbers[index]!, title: '' }));
  return out;
}
