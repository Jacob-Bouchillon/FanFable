/** Small text utilities shared by import, retrieval and continuity checking. */

export function wordCount(text: string): number {
  const t = (text ?? '').trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

export function normalizeSpace(text: string): string {
  return (text ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Split text into sentences (good enough for chunking and repetition checks). */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?\n]+(?:[.!?]+["')\]]*|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text ?? '')) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  return out;
}

export const STOPWORDS = new Set(
  ('a an the and or but if then else of to in on at by for with from as is are was were be been being ' +
    'it its this that these those he she they them his her their we you i not no so such than too very ' +
    'can will just don should now do does did have has had into over under again more most other some ' +
    'what which who whom when where why how all any both each few own same s t d ll m o re ve y')
    .split(' '),
);

export function tokenize(text: string): string[] {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Jaccard similarity of token sets, used to spot repeated scenes. */
export function similarity(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Detect headings for a source file.
 *
 * Recognises markdown headings, common "CHAPTER N" forms and numbered section
 * markers. Returns a list of { heading, start } offsets in characters.
 */
export function findHeadings(text: string): { heading: string; start: number }[] {
  const out: { heading: string; start: number }[] = [];
  const lines = text.split('\n');
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      const md = /^#{1,6}\s+(.*)$/.exec(trimmed);
      const chapter =
        /^(chapter|book|part|section|act)\s+([0-9ivxlcdm]+|[a-z]+)\b[:.\-–—]?\s*(.*)$/i.exec(trimmed);
      // A numbered line is only a heading when it looks like a title, not a
      // numbered list item inside prose ("4. One winter cloak (black, ...)").
      const numbered = /^([0-9]{1,3})[.)]\s+(\S.*)$/.exec(trimmed);
      let heading: string | null = null;
      if (md) heading = md[1].trim();
      else if (chapter) heading = trimmed.replace(/:$/, '').trim();
      else if (numbered && looksLikeTitle(numbered[2])) heading = numbered[2].trim();
      if (heading) out.push({ heading, start: offset });
    }
    offset += line.length + 1;
  }
  return out;
}

/**
 * Chunk source text into passage-sized units.
 *
 * Paragraphs (blank-line separated) are the atomic unit: consecutive
 * paragraphs are merged until the chunk reaches maxWords, and chunks never
 * straddle a heading. A single oversized paragraph is split on sentence
 * boundaries. This keeps sentences intact for both hard-wrapped prose and
 * one-line-per-paragraph files.
 */
export interface Chunk {
  text: string;
  heading: string;
  charStart: number;
  charEnd: number;
  seq: number;
  /** Pages the chunk covers, when the source has pages. */
  pageStart: number;
  pageEnd: number;
}

export function chunkText(
  text: string,
  opts: { maxWords?: number; overlapWords?: number } = {},
): Chunk[] {
  const maxWords = opts.maxWords ?? 220;
  const overlapWords = opts.overlapWords ?? 40;
  const headings = findHeadings(text);

  interface Block {
    /** Nearest heading at or before this block, used as the source locator. */
    heading: string;
    /** True when this block is itself a heading and starts a new section. */
    startsHeading: boolean;
    charStart: number;
    charEnd: number;
    text: string;
    /** Page the block starts on (1-based), 0 when the source has no pages. */
    page: number;
  }

  // Paragraphs: runs of non-empty lines separated by one or more blank lines.
  // A form feed marks a page break, which is how PDFs and EPUBs arrive.
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let offset = 0;
  let buffer: string[] = [];
  let bufStart = 0;
  let bufEnd = 0;
  let lastHeading = '';
  let page = 0;

  const flush = () => {
    if (!buffer.length) return;
    const body = buffer.join(' ');
    const own = headings.find((h) => h.start >= bufStart && h.start <= bufEnd);
    const startsHeading = !!own;
    if (own) lastHeading = own.heading;
    blocks.push({
      heading: lastHeading,
      startsHeading,
      charStart: bufStart,
      charEnd: bufEnd,
      text: body,
      page: page + 1,
    });
    buffer = [];
  };

  for (const line of lines) {
    const lineEnd = offset + line.length;
    if (line.includes('\f')) {
      // Page break: the text before it belongs to the current page.
      const before = line.split('\f')[0];
      if (before.trim()) {
        if (!buffer.length) bufStart = offset;
        buffer.push(before.trim());
        bufEnd = offset + before.length;
      }
      flush();
      page++;
      const after = line.slice(line.indexOf('\f') + 1);
      if (after.trim()) {
        bufStart = offset + line.indexOf('\f') + 1;
        buffer.push(after.trim());
        bufEnd = lineEnd;
      }
    } else if (line.trim()) {
      if (!buffer.length) bufStart = offset;
      buffer.push(line.trim());
      bufEnd = lineEnd;
    } else {
      flush();
    }
    offset = lineEnd + 1;
  }
  flush();

  // Split oversized paragraphs on sentence boundaries.
  const pieces: Block[] = [];
  for (const block of blocks) {
    if (wordCount(block.text) <= maxWords) {
      pieces.push(block);
      continue;
    }
    const sentences = splitSentences(block.text);
    let group: string[] = [];
    let groupWords = 0;
    for (const sentence of sentences) {
      const w = wordCount(sentence);
      if (groupWords + w > maxWords && group.length) {
        pieces.push({ ...block, text: group.join(' ') });
        group = [];
        groupWords = 0;
      }
      group.push(sentence);
      groupWords += w;
    }
    if (group.length) pieces.push({ ...block, text: group.join(' ') });
  }

  const chunks: Chunk[] = [];
  let current: Block[] = [];
  let currentWords = 0;

  const flushChunk = (keepOverlap = true) => {
    if (!current.length) return;
    const body = current.map((b) => b.text).join('\n\n');
    chunks.push({
      text: body,
      heading: current[0].heading,
      charStart: current[0].charStart,
      charEnd: current[current.length - 1].charEnd,
      seq: chunks.length,
      pageStart: current[0].page,
      pageEnd: current[current.length - 1].page,
    });
    // Overlap: keep a little trailing context for the next chunk, but never so
    // much that the next chunk starts out already full (which would repeat it).
    if (!keepOverlap) {
      current = [];
      currentWords = 0;
      return;
    }
    const budget = Math.min(overlapWords, Math.floor(maxWords / 3));
    const keep: Block[] = [];
    let kept = 0;
    for (let i = current.length - 1; i >= 0 && kept < budget; i--) {
      if (current[i].startsHeading) break;
      keep.unshift(current[i]);
      kept += wordCount(current[i].text);
    }
    current = keep;
    currentWords = kept;
  };

  for (const block of pieces) {
    const w = wordCount(block.text);
    // never straddle a heading: a heading always starts a fresh chunk
    if (current.length && block.startsHeading) flushChunk(false);
    // Prefer to end a chunk on a page boundary, so a citation points at one
    // page rather than a spread. Only worth it once the chunk has some meat.
    if (current.length && block.page !== current[0].page && currentWords >= Math.min(50, maxWords * 0.5)) {
      flushChunk();
    }
    if (currentWords + w > maxWords && current.length) flushChunk();
    current.push(block);
    currentWords += w;
  }
  flushChunk();

  return chunks.map((c, i) => ({ ...c, seq: i }));
}

/**
 * Drop paragraphs that repeat an earlier one.
 *
 * Models often restate a beat when they continue a scene, and the reader
 * notices. Only near-duplicates of reasonably long paragraphs are removed, so
 * deliberate repetition (a refrain, a refrain answered) survives.
 */
export function dedupeParagraphs(text: string, threshold = 0.8): { text: string; removed: number } {
  const paragraphs = (text ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const kept: string[] = [];
  let removed = 0;
  for (const p of paragraphs) {
    if (p.length >= 40) {
      const dup = kept.some((k) => k.length >= 40 && similarity(p, k) >= threshold);
      if (dup) {
        removed++;
        continue;
      }
    }
    kept.push(p);
  }
  return { text: kept.join('\n\n'), removed };
}

export function truncate(text: string, maxChars: number): string {
  if ((text ?? '').length <= maxChars) return text ?? '';
  return `${(text ?? '').slice(0, maxChars)}\n[... truncated ...]`;
}

/** Does this text read like a section title rather than a sentence? */
function looksLikeTitle(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 50) return false;
  if (/[,.]$/.test(t)) return false;
  if (/[(),;:]/.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 6;
}

export function titleFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
}
