/**
 * How a chapter is measured.
 *
 * These definitions are shared by the old writing evaluation and the model
 * benchmark, so that "repeated paragraphs" means the same thing in both. They
 * are deliberately simple and checkable:
 *
 *   repetition   the share of paragraphs that are near-duplicates of another
 *                paragraph, where near-duplicate means a similarity above 0.55
 *   copied       the share of the chapter's eight-word sequences that also
 *                appear in the source material
 *   invented     the share of the chapter's capitalised words that appear
 *                nowhere in the source material
 *   length       the chapter's word count against the target it was given
 */
import { similarity } from '../../src/text.ts';

/** Eight-word sequences, lower-cased, ignoring punctuation. */
export function shingles(text: string, n = 8): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

export function words(text: string): number {
  return (text ?? '').split(/\s+/).filter(Boolean).length;
}

/** The share of paragraphs that are near-duplicates of an earlier paragraph. */
export function repetitionRate(body: string, threshold = 0.55): number {
  const paragraphs = (body ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 80);
  let dupes = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    for (let j = i + 1; j < paragraphs.length; j++) {
      if (similarity(paragraphs[i], paragraphs[j]) > threshold) {
        dupes++;
        break;
      }
    }
  }
  return paragraphs.length ? dupes / paragraphs.length : 0;
}

/** The share of the chapter's eight-word sequences that are copied from the source. */
export function copiedRate(body: string, sourceText: string): number {
  const sourceShingles = shingles(sourceText);
  const chapterShingles = shingles(body);
  if (!chapterShingles.size) return 0;
  let copied = 0;
  for (const shingle of chapterShingles) if (sourceShingles.has(shingle)) copied++;
  return copied / chapterShingles.size;
}

/** The share of the chapter's capitalised words that are not in the source at all. */
export function inventedNameRate(body: string, sourceText: string): number {
  const proper = [...new Set([...body.matchAll(/\b[A-Z][a-z]{2,}\b/g)].map((m) => m[0]))];
  if (!proper.length) return 0;
  const sourceLower = sourceText.toLowerCase();
  return proper.filter((n) => !sourceLower.includes(n.toLowerCase())).length / proper.length;
}

/** The capitalised words in the chapter that are not in the source. */
export function inventedNames(body: string, sourceText: string): string[] {
  const proper = [...new Set([...body.matchAll(/\b[A-Z][a-z]{2,}\b/g)].map((m) => m[0]))];
  const sourceLower = sourceText.toLowerCase();
  return proper.filter((n) => !sourceLower.includes(n.toLowerCase()));
}

/** Objective prose statistics. None of these measure quality; they measure shape. */
export interface ProseStats {
  words: number;
  paragraphs: number;
  sentences: number;
  meanSentenceWords: number;
  /** The share of words that are inside quotation marks. */
  dialogueShare: number;
  /** The share of distinct words: a crude lexical variety measure. */
  typeTokenRatio: number;
  /** The share of sentences that start with the same word as the one before. */
  repeatedOpenings: number;
  /** Sentences that run on for more than 45 words: a rough run-on measure. */
  longSentences: number;
  /** Words that the chapter made up, with no trace in the source. */
  inventedNames: string[];
}

export function proseStats(body: string, sourceText = ''): ProseStats {
  const text = body ?? '';
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const totalWords = words(text);
  const dialogue = text.match(/["“][^"”]{0,400}["”]/g) ?? [];
  const dialogueWords = dialogue.reduce((a, d) => a + words(d), 0);
  const tokens = text.toLowerCase().match(/[a-z']+/g) ?? [];
  const distinct = new Set(tokens);
  const openings = sentences.map((s) => (s.split(/\s+/)[0] ?? '').toLowerCase());
  let repeated = 0;
  for (let i = 1; i < openings.length; i++) if (openings[i] && openings[i] === openings[i - 1]) repeated++;
  return {
    words: totalWords,
    paragraphs: paragraphs.length,
    sentences: sentences.length,
    meanSentenceWords: sentences.length ? totalWords / sentences.length : 0,
    dialogueShare: totalWords ? dialogueWords / totalWords : 0,
    typeTokenRatio: tokens.length ? distinct.size / tokens.length : 0,
    repeatedOpenings: sentences.length > 1 ? repeated / (sentences.length - 1) : 0,
    longSentences: sentences.filter((s) => words(s) > 45).length,
    inventedNames: sourceText ? inventedNames(text, sourceText) : [],
  };
}
