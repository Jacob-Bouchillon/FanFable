/**
 * Format-aware importing.
 *
 * A story source is usually a book, so it arrives as a PDF, an EPUB or a DOCX
 * rather than as text. This module turns any of those into plain text with
 * page markers, so a citation can point at a page and a 200-page book can be
 * chunked, indexed and mined like any other source.
 *
 * Text is returned with a form feed (\f) between pages. That is the marker the
 * chunker uses to track which page a passage came from.
 */
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { promisify } from 'node:util';
import { basename, extname } from 'node:path';

const exec = promisify(execFile);

export interface ImportedText {
  text: string;
  pageCount: number;
  title: string;
  author: string;
  format: string;
  /** Which pages actually carried text (PDFs often have blank ones). */
  pages: number[];
}

export class ImportError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'ImportError';
    this.hint = hint;
  }
}

/* ------------------------------------------------------------------- pdf */

async function hasCommand(cmd: string): Promise<boolean> {
  try {
    await exec(cmd, ['-v'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Extract a PDF with poppler's pdftotext, keeping the layout where it helps. */
export async function extractPdf(path: string): Promise<ImportedText> {
  if (!(await hasCommand('pdftotext'))) {
    throw new ImportError(
      'pdftotext is not installed, so PDFs cannot be read.',
      'Install poppler-utils (Debian/Ubuntu: apt install poppler-utils, macOS: brew install poppler), ' +
        'or convert the file to text first: pdftotext -layout book.pdf book.txt',
    );
  }

  let text = '';
  try {
    // -layout keeps columns and line breaks, which matters for prose.
    const { stdout } = await exec('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-'], {
      maxBuffer: 256 * 1024 * 1024,
      timeout: 300_000,
    });
    text = stdout;
  } catch (err) {
    throw new ImportError(
      `pdftotext could not read this PDF: ${(err as Error).message}`,
      'If the PDF is scanned images rather than text, it has to be OCR-ed first.',
    );
  }

  const pages = text.split('\f');
  if (pages.length > 1) pages.pop(); // trailing form feed after the last page

  let title = basename(path).replace(/\.[a-z0-9]+$/i, '');
  let author = '';
  try {
    const { stdout } = await exec('pdfinfo', [path], { timeout: 15_000 });
    const t = /^Title:\s*(.+)$/m.exec(stdout);
    const a = /^Author:\s*(.+)$/m.exec(stdout);
    if (t?.[1]?.trim()) title = t[1].trim();
    if (a?.[1]?.trim()) author = a[1].trim();
  } catch {
    // pdfinfo is optional
  }

  return {
    text: pages.join('\f'),
    pageCount: pages.length,
    title,
    author,
    format: 'pdf',
    pages: pages.map((_, i) => i + 1),
  };
}

/* ------------------------------------------------------------------ zip */

/** Minimal zip reader: central directory + stored/deflated entries. */
function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  // find the end-of-central-directory record
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66_000; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ImportError('the file is not a readable archive');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    // local header
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    try {
      entries.set(name, method === 0 ? raw : inflateRawSync(raw));
    } catch {
      // skip an entry we cannot inflate
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Strip markup to readable text, keeping block structure. */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|tr|section|article)\s*>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ----------------------------------------------------------------- epub */

export async function extractEpub(path: string): Promise<ImportedText> {
  const buffer = readFileSync(path);
  const entries = readZipEntries(buffer);

  const container = entries.get('META-INF/container.xml');
  const opfPath = container
    ? /full-path="([^"]+)"/.exec(container.toString('utf8'))?.[1]
    : undefined;
  const opfName = opfPath ?? [...entries.keys()].find((k) => k.endsWith('.opf'));
  if (!opfName || !entries.has(opfName)) throw new ImportError('the EPUB has no readable content file');

  const opf = entries.get(opfName)!.toString('utf8');
  const base = opfName.includes('/') ? opfName.slice(0, opfName.lastIndexOf('/') + 1) : '';

  // The spine gives the reading order; fall back to every document.
  const spineRefs = [...opf.matchAll(/<itemref[^>]*idref="([^"]+)"/g)].map((m) => m[1]);
  const manifest = new Map<string, string>();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = /id="([^"]+)"/.exec(m[0])?.[1];
    const href = /href="([^"]+)"/.exec(m[0])?.[1];
    if (id && href) manifest.set(id, decodeURIComponent(href));
  }
  const files = spineRefs
    .map((id) => manifest.get(id))
    .filter((h): h is string => !!h)
    .map((h) => base + h);

  const title = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1]?.trim() ?? basename(path);
  const author = /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(opf)?.[1]?.trim() ?? '';

  const parts: string[] = [];
  for (const file of files) {
    const content = entries.get(file) ?? entries.get(decodeURIComponent(file));
    if (!content) continue;
    const text = htmlToText(content.toString('utf8'));
    if (text) parts.push(text);
  }
  if (!parts.length) throw new ImportError('no readable text was found in the EPUB');

  return {
    text: parts.join('\n\n\f\n\n'),
    pageCount: parts.length,
    title,
    author,
    format: 'epub',
    pages: parts.map((_, i) => i + 1),
  };
}

/* ----------------------------------------------------------------- docx */

export async function extractDocx(path: string): Promise<ImportedText> {
  const buffer = readFileSync(path);
  const entries = readZipEntries(buffer);
  const document = entries.get('word/document.xml');
  if (!document) throw new ImportError('the DOCX has no readable document body');

  const xml = document.toString('utf8');
  const paragraphs: string[] = [];
  for (const p of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
    const text = [...p[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((m) => m[1])
      .join('')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
    const isHeading = /<w:pStyle[^>]*w:val="(Heading[1-6]|Title)"/.test(p[0]);
    if (text.trim()) paragraphs.push(isHeading ? `\n${text.trim()}\n` : text.trim());
  }
  if (!paragraphs.length) throw new ImportError('the DOCX has no readable text');

  const core = entries.get('docProps/core.xml')?.toString('utf8') ?? '';
  const title = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(core)?.[1]?.trim() ?? basename(path).replace(/\.docx$/i, '');
  const author = /<dc:creator>([\s\S]*?)<\/dc:creator>/.exec(core)?.[1]?.trim() ?? '';

  return {
    text: paragraphs.join('\n\n'),
    pageCount: 0,
    title,
    author,
    format: 'docx',
    pages: [],
  };
}

/* ----------------------------------------------------------------- text */

export async function extractText(path: string): Promise<ImportedText> {
  const raw = readFileSync(path, 'utf8');
  return {
    text: raw,
    pageCount: raw.split('\f').length,
    title: basename(path).replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim(),
    author: '',
    format: (extname(path).slice(1) || 'txt').toLowerCase(),
    pages: [],
  };
}

/** Read a plain text or Markdown file, synchronously. */
export function readTextFile(path: string): ImportedText {
  const raw = readFileSync(path, 'utf8');
  return {
    text: raw,
    pageCount: raw.split('\f').length,
    title: basename(path).replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim(),
    author: '',
    format: (extname(path).slice(1) || 'txt').toLowerCase(),
    pages: [],
  };
}

/* --------------------------------------------------------------- dispatch */

export function isSupported(path: string): boolean {
  return ['.txt', '.md', '.markdown', '.text', '.pdf', '.epub', '.docx'].includes(
    extname(path).toLowerCase(),
  );
}

/** Read a source file of any supported format into text with page markers. */
export async function importFile(path: string): Promise<ImportedText> {
  if (!existsSync(path)) throw new ImportError(`file not found: ${path}`);
  const ext = extname(path).toLowerCase();
  if (ext === '.pdf') return extractPdf(path);
  if (ext === '.epub') return extractEpub(path);
  if (ext === '.docx') return extractDocx(path);
  if (['.txt', '.md', '.markdown', '.text'].includes(ext)) return extractText(path);
  // Unknown extension: try it as text.
  return extractText(path);
}
