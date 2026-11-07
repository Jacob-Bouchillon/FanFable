/**
 * BookNLP inspector payload.
 *
 * Reads the three pipeline files (entities, quotes, tokens) plus the text they
 * were produced from, and returns mention spans in character offsets so a page
 * can highlight the book. Parsed once per file set and cached.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface BookNlpCluster {
  id: number;
  name: string;
  cat: string;
  mentions: number;
  proper: number;
  nominal: number;
  pronoun: number;
  forms: Array<[string, number]>;
  quotes: Array<{ start: number; end: number; text: string }>;
}

export interface BookNlpPayload {
  text: string;
  clusters: BookNlpCluster[];
  mentions: Array<{ c: number; s: number; e: number }>;
  quotes: Array<{ s: number; e: number; c: number }>;
  stats: { clusters: number; mentions: number; quotes: number };
}

interface CacheEntry {
  stamp: string;
  payload: BookNlpPayload;
}

let cache: CacheEntry | null = null;

function stampOf(files: string[]): string {
  return files.map((file) => {
    try {
      const stat = statSync(file);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return 'missing';
    }
  }).join('|');
}

function tabRows(file: string): string[][] {
  const text = readFileSync(file, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => line.split('\t'));
}

/** Byte offset -> character index, for UTF-8 text. */
function byteToCharMap(text: string): Uint32Array {
  const buffer = Buffer.from(text, 'utf8');
  const map = new Uint32Array(buffer.length + 1);
  let chars = 0;
  for (let index = 0; index < buffer.length; index++) {
    map[index] = chars;
    if ((buffer[index]! & 0xc0) !== 0x80) chars++;
  }
  map[buffer.length] = chars;
  return map;
}

export function loadBookNlp(dir: string): BookNlpPayload | null {
  const textFile = join(dir, 'hp1.txt');
  const entityFile = join(dir, 'hp1.entities');
  const quoteFile = join(dir, 'hp1.quotes');
  const tokenFile = join(dir, 'hp1.tokens');
  const files = [textFile, entityFile, quoteFile, tokenFile];
  const stamp = stampOf(files);
  if (cache && cache.stamp === stamp) return cache.payload;

  let text: string;
  try {
    text = readFileSync(textFile, 'utf8');
  } catch {
    return null;
  }
  const byteChar = byteToCharMap(text);

  // Token id -> [byte onset, byte offset].
  const tokenSpan = new Map<number, [number, number]>();
  try {
    for (const row of tabRows(tokenFile)) {
      if (row[0] === 'paragraph_ID') continue;
      const id = Number(row[3]);
      const onset = Number(row[6]);
      const offset = Number(row[7]);
      if (Number.isFinite(id) && Number.isFinite(onset) && Number.isFinite(offset)) {
        tokenSpan.set(id, [onset, offset]);
      }
    }
  } catch {
    return null;
  }

  const clusters = new Map<number, BookNlpCluster>();
  const mentions: BookNlpPayload['mentions'] = [];
  const ensure = (id: number): BookNlpCluster => {
    let cluster = clusters.get(id);
    if (!cluster) {
      cluster = { id, name: '', cat: 'PER', mentions: 0, proper: 0, nominal: 0, pronoun: 0, forms: [], quotes: [] };
      clusters.set(id, cluster);
    }
    return cluster;
  };
  const formCounts = new Map<number, Map<string, number>>();

  try {
    for (const row of tabRows(entityFile)) {
      if (row[0] === 'COREF') continue;
      const id = Number(row[0]);
      const startToken = Number(row[1]);
      const endToken = Number(row[2]);
      const prop = String(row[3] ?? '');
      const cat = String(row[4] ?? '');
      const surface = row.slice(5).join('\t').trim();
      if (!Number.isFinite(id) || !Number.isFinite(startToken) || !Number.isFinite(endToken)) continue;

      const cluster = ensure(id);
      cluster.cat = cat || cluster.cat;
      cluster.mentions++;
      if (prop === 'PROP') cluster.proper++;
      else if (prop === 'NOM') cluster.nominal++;
      else if (prop === 'PRON') cluster.pronoun++;
      if (prop === 'PROP' && surface) {
        const counts = formCounts.get(id) ?? new Map<string, number>();
        counts.set(surface, (counts.get(surface) ?? 0) + 1);
        formCounts.set(id, counts);
      }

      const start = tokenSpan.get(startToken);
      const end = tokenSpan.get(endToken);
      if (start && end) {
        mentions.push({
          c: id,
          s: byteChar[start[0]]!,
          e: byteChar[end[1]]!,
        });
      }
    }
  } catch {
    return null;
  }

  const quotes: BookNlpPayload['quotes'] = [];
  try {
    for (const row of tabRows(quoteFile)) {
      if (row[0] === 'quote_start') continue;
      const quoteStart = Number(row[0]);
      const quoteEnd = Number(row[1]);
      const charId = Number(row[5]);
      const quoteText = row.slice(6).join('\t');
      const startSpan = tokenSpan.get(quoteStart);
      const endSpan = tokenSpan.get(quoteEnd);
      if (!Number.isFinite(charId) || !startSpan || !endSpan) continue;
      const start = byteChar[startSpan[0]]!;
      const end = byteChar[endSpan[1]]!;
      quotes.push({ s: start, e: end, c: charId });
      const cluster = clusters.get(charId);
      if (cluster && cluster.quotes.length < 40) {
        cluster.quotes.push({ start, end, text: quoteText });
      }
    }
  } catch {
    return null;
  }

  for (const cluster of clusters.values()) {
    const counts = formCounts.get(cluster.id);
    const forms = counts ? [...counts.entries()].sort((a, b) => b[1] - a[1]) : [];
    cluster.forms = forms;
    cluster.name = forms[0]?.[0] ?? `cluster ${cluster.id}`;
  }

  const payload: BookNlpPayload = {
    text,
    clusters: [...clusters.values()].sort((a, b) => b.mentions - a.mentions),
    mentions,
    quotes,
    stats: { clusters: clusters.size, mentions: mentions.length, quotes: quotes.length },
  };
  cache = { stamp, payload };
  return payload;
}
