/** Small text utilities shared by import, retrieval and continuity checking. */

export function wordCount(text: string): number {
  const t = (text ?? '').trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
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
 * Front/back-matter trim, derived from the file's own contents page.
 *
 * Novels ship with non-novel pages: copyright, dedication, contents, and —
 * at the back — author bios, ads for other books, excerpts of other books,
 * timelines. Imported verbatim, those pages become quotable "canon": the
 * gates verify quotes against the file, not against the novel, so ad copy
 * banks as evidence. This trim blanks those pages before chunking, keeping
 * page numbers stable (blanked, never deleted).
 *
 * Universal and conservative: everything comes from a detected contents
 * list (a run of `N: Title` lines in the first 200 lines). The novel body
 * runs from its first chapter/prologue heading to its last; back matter
 * starts at the first trailing contents entry (author bio, excerpt,
 * timeline) seen after the body ends. No list of books, authors, or
 * publishers anywhere: books without a detectable contents list import
 * exactly as before.
 */
export interface MatterTrim {
  text: string;
  headPages: number;
  tailPages: number;
}

export function trimFrontBackMatter(text: string): MatterTrim {
  const noop = { text, headPages: 0, tailPages: 0 };
  if (!text.includes('\f')) return noop;
  const lines = text.split('\n');
  const zone = lines.slice(0, 200);
  // The contents list is the FIRST dense run of `N: Title` lines: chapters
  // of the story itself can fall inside the scan window in short inputs, so
  // a later sparse run must not move the block. Groups split on gaps wider
  // than a contents page turn.
  const hits: number[] = [];
  zone.forEach((ln, i) => {
    if (/^(\d{1,3}):\s+(\S.*)$/.exec(ln.trim())) hits.push(i);
  });
  const groups: number[][] = [];
  for (const h of hits) {
    const last = groups[groups.length - 1];
    if (last && h - last[last.length - 1]! <= 8) last.push(h);
    else groups.push([h]);
  }
  const run = groups.find((g) => g.length >= 3);
  if (!run) return noop;
  const numbered: string[] = [];
  for (const i of run) {
    const m = /^(\d{1,3}):\s+(\S.*)$/.exec(zone[i].trim());
    if (m) numbered.push(`${m[1]}: ${m[2]}`.toLowerCase());
  }
  const zoneEnd = run[run.length - 1]!;
  const runTitles = new Set<string>(numbered);
  // Trailing contents entries: the author bio, excerpts, timelines listed
  // after the last numbered chapter. The scan stops where the body begins:
  // a body heading (prologue/epilogue/part line, or a repeated chapter
  // number from the run) or a page turn (form feeds mid-line mean the
  // contents spread is over) ends the block. Prologue/epilogue/part lines
  // encountered before any back entry belong to the contents structure
  // itself and are skipped, not treated as back matter.
  const backEntries: string[] = [];
  let backEnd = zoneEnd;
  for (let i = zoneEnd + 1; i < Math.min(zone.length, zoneEnd + 60); i++) {
    const raw = zone[i];
    const t = raw.trim();
    if (!t) {
      if (backEntries.length) break;
      continue;
    }
    if (raw.includes('\f') && backEntries.length) break;
    const nm = /^(\d{1,3}):\s+(\S.*)$/.exec(t);
    if (nm) {
      if (runTitles.has(`${nm[1]}: ${nm[2]}`.toLowerCase())) break;
      continue;
    }
    if (/^(prologue|epilogue|part\s+.+)$/i.test(t)) {
      if (backEntries.length) break;
      continue;
    }
    backEntries.push(t.toLowerCase());
    backEnd = i;
  }
  const bodyTitles = new Set<string>(numbered);
  zone.forEach((ln) => {
    const t = ln.trim();
    if (/^(prologue|epilogue)$/i.test(t)) bodyTitles.add(t.toLowerCase());
  });
  // The search for the body starts after the contents block itself, not
  // after the last numbered line seen: in short inputs a story chapter can
  // fall inside the 200-line scan window, and must not move the start line.
  // The page is counted in form feeds before the block's end: a line can
  // hold several (blank pages leave back-to-back feeds), and the line a
  // feed sits on belongs to the page before it.
  const contentEnd = backEnd;
  const pages = text.split('\f');
  // The block's end is located by its own text in the page array (first
  // occurrence wins — the contents precedes everything else), which stays
  // exact no matter how form feeds bunch up on a line.
  const anchor = lines[contentEnd].trim();
  let zoneEndPage = 1;
  for (let p = 0; p < pages.length; p++) {
    if (pages[p].split('\n').some((raw) => raw.trim() === anchor)) {
      zoneEndPage = p + 1;
      break;
    }
  }
  const shaped = (t: string): boolean => t.length > 0 && t.length <= 120;
  let bodyStartPage = -1;
  let bodyEndPage = -1;
  pages.forEach((pageText, idx) => {
    const p = idx + 1;
    if (p <= zoneEndPage) return;
    for (const raw of pageText.split('\n')) {
      const t = raw.trim();
      if (!shaped(t)) continue;
      if (bodyTitles.has(t.toLowerCase())) {
        if (bodyStartPage < 0) bodyStartPage = p;
        bodyEndPage = p;
      }
    }
  });
  if (bodyStartPage < 0 || bodyEndPage < 0) return noop;
  let cutPage = -1;
  for (let p = bodyEndPage + 1; p <= pages.length; p++) {
    const pageText = pages[p - 1];
    const hit = pageText.split('\n').some((raw) => {
      const t = raw.trim();
      return shaped(t) && backEntries.includes(t.toLowerCase());
    });
    if (hit) {
      cutPage = p;
      break;
    }
  }
  const out = pages.slice();
  let head = 0;
  let tail = 0;
  // Head trim stops at the last blank page, and never eats a page that
  // carries contents-listed chapter material: a non-empty run immediately
  // before the body (opening crawl, epigraph, part title) belongs to the
  // novel. Back-matter entries are deliberately NOT a veto here — the walk
  // only runs over pre-body pages, where a matching line (title-page
  // epigraph, dedication quote) is front matter quoting the novel, not
  // back matter. The tail cut handles back matter separately.
  const pageHasContentsMaterial = (pageText: string): boolean =>
    pageText.split('\n').some((raw) => {
      const t = raw.trim();
      return /^\d{1,3}:\s+\S/.test(t) || /^(prologue|epilogue|part\s+.+)$/i.test(t);
    });
  let keepFrom = bodyStartPage;
  for (let p = bodyStartPage - 1; p >= 1; p--) {
    if (pages[p - 1].trim() === '' || pageHasContentsMaterial(pages[p - 1])) break;
    keepFrom = p;
  }
  for (let p = 1; p < keepFrom; p++) {
    if (out[p - 1].trim() !== '') head++;
    out[p - 1] = '';
  }
  if (cutPage > 0) {
    for (let p = cutPage; p <= pages.length; p++) {
      if (out[p - 1].trim() !== '') tail++;
      out[p - 1] = '';
    }
  }
  if (!head && !tail) return noop;
  return { text: out.join('\f'), headPages: head, tailPages: tail };
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
      // A line can hold several page breaks (blank pages leave back-to-back
      // form feeds with no newline between them); every one advances the
      // page, or later pages inherit earlier pages' numbers.
      let segStart = offset;
      const parts = line.split('\f');
      parts.forEach((part, k) => {
        if (k > 0) {
          flush();
          page++;
        }
        if (part.trim()) {
          if (!buffer.length) bufStart = segStart;
          buffer.push(part.trim());
          bufEnd = segStart + part.length;
        }
        segStart += part.length + 1;
      });
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
