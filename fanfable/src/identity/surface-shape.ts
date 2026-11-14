/**
 * Surface-shape classification.
 *
 * NOT WIRED. No production module imports this file; it is exercised by tests
 * and by the trial scripts noted here, and nothing in the running product
 * reaches it. Read it as a built-and-tested candidate, not as live behaviour.
 *
 * The failure this fixes: a word that only ever appears inside a capitalised
 * enumeration ("Tawny, Screech, Barn, Brown, and Snowy") was banked as an
 * individual creature. The shape of the text says otherwise: a list member
 * that also occurs lowercase elsewhere in the book is a common noun used as a
 * kind, not a name.
 *
 * No vocabulary lists. The rule is the same for owl breeds, dragon breeds and
 * starship classes.
 */
import { Db } from '../core/db.ts';

export interface SurfaceOccurrence {
  chunkId: number;
  listMember: boolean;
  capitalised: boolean;
}

export interface SurfaceShape {
  shape: 'individual' | 'kind-list' | 'unknown';
  occurrences: SurfaceOccurrence[];
  reason: string;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Split a sentence into comma/and segments and count capitalised single words. */
function listSegments(sentence: string): string[][] {
  const segments = sentence.split(/,\s*|\s+and\s+/).map((part) => part.trim()).filter(Boolean);
  const words = segments.map((segment) => segment.split(/\s+/));
  return words;
}

function isListMember(sentence: string, name: string): boolean {
  const words = listSegments(sentence);
  const isSingleCapitalised = (tokens: string[]) =>
    tokens.length === 1 && /^[A-Z][A-Za-z'’-]*$/.test(tokens[0]!);
  const members = words.filter(isSingleCapitalised).length;
  if (members < 3) return false;
  return words.some((tokens) => isSingleCapitalised(tokens) && tokens[0]!.toLowerCase() === name.toLowerCase());
}

export function surfaceShape(db: Db, projectId: number, name: string): SurfaceShape {
  const pattern = new RegExp(`(?<![A-Za-z0-9])${escape(name)}(?![A-Za-z0-9])`, 'gi');
  const chunks = db.all<{ id: number; text: string }>(
    'SELECT id, text FROM canon_chunk WHERE project_id = ? ORDER BY seq',
    projectId,
  );
  const occurrences: SurfaceOccurrence[] = [];
  for (const chunk of chunks) {
    const text = String(chunk.text ?? '');
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const capitalised = /[A-Z]/.test(match[0][0] ?? '');
      const start = text.lastIndexOf('.', match.index) + 1;
      const end = text.indexOf('.', match.index);
      const sentence = text.slice(start, end === -1 ? text.length : end + 1);
      occurrences.push({ chunkId: Number(chunk.id), listMember: isListMember(sentence, name), capitalised });
      if (occurrences.length > 200) break;
    }
    if (occurrences.length > 200) break;
  }
  const capitalised = occurrences.filter((occurrence) => occurrence.capitalised);
  const lowercase = occurrences.filter((occurrence) => !occurrence.capitalised);
  if (!occurrences.length) return { shape: 'unknown', occurrences, reason: 'surface does not occur in the text' };
  if (capitalised.length && capitalised.every((occurrence) => occurrence.listMember) && lowercase.length) {
    return {
      shape: 'kind-list',
      occurrences,
      reason: `every capitalised use is inside a kind list, and the lowercase word occurs ${lowercase.length} time(s)`,
    };
  }
  return {
    shape: 'individual',
    occurrences,
    reason: capitalised.some((occurrence) => !occurrence.listMember)
      ? 'occurs as a standalone capitalised word'
      : 'no lowercase use',
  };
}
