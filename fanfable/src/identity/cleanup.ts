/**
 * General identity-cleanup rules.
 *
 * Every decision is derived from the bank and the source text: edit distance,
 * occurrence counts, dialogue context, ownership constructions and plurality.
 * No book-specific name lists live here.
 */
import { Db, fromJson } from '../core/db.ts';
import { canonicalName, isTitleToken, nameTokens } from './names.ts';

export interface EntityLite {
  id: number;
  name: string;
  aliases: string[];
  kind: string;
  reviewStatus: string;
}

export interface TypoVariant {
  entityId: number;
  name: string;
  occurrences: number;
  canonicalId: number;
  canonicalName: string;
  distance: number;
  reason: string;
}

export interface NicknameAlias {
  entityId: number;
  name: string;
  occurrences: number;
  personId: number | null;
  personName: string;
  evidence: string;
  chunkId: number;
  locator: string;
  ambiguous: string[];
}

export interface OwnershipClaim {
  owner: string;
  possessed: string;
  named: string;
  evidence: string;
  chunkId: number;
  locator: string;
  animalWords: string[];
}

export interface SurfaceFacts {
  lowercaseTokens: Set<string>;
  isCommonSurface: (surface: string) => boolean;
  isPlural: (surface: string) => boolean;
  hasPossessive: (surface: string) => boolean;
}

function collapseWhitespace(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function letters(value: string): string {
  return collapseWhitespace(value).toLowerCase().replace(/[^a-z]/g, '');
}

function tokens(value: string): string[] {
  return (String(value ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

export function editDistance(left: string, right: string, max = Infinity): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
      current[j] = value;
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[b.length]!;
}

function hasPossessive(surface: string): boolean {
  return /['’]s\b/.test(collapseWhitespace(surface));
}

export function surfaceFacts(db: Db, projectId: number): SurfaceFacts {
  const lowercaseTokens = new Set<string>();
  for (const row of db.all<{ text: string }>('SELECT text FROM canon_chunk WHERE project_id = ?', projectId)) {
    // Only true lowercase occurrences: a capitalised proper name must not
    // make its own lowercase form look like a common word.
    for (const match of String(row.text ?? '').matchAll(/\b[a-z][a-z'’\-]*\b/g)) {
      lowercaseTokens.add(match[0]!);
    }
  }
  const isCommonSurface = (surface: string): boolean => {
    const parts = tokens(surface);
    return parts.length > 0 && parts.every((part) => lowercaseTokens.has(part));
  };
  const isPlural = (surface: string): boolean => {
    const parts = tokens(surface);
    const last = parts[parts.length - 1] ?? '';
    if (last.length <= 3 || !last.endsWith('s') || last.endsWith('ss')) return false;
    const singular = last.slice(0, -1);
    return lowercaseTokens.has(singular) || lowercaseTokens.has(last);
  };
  return { lowercaseTokens, isCommonSurface, isPlural, hasPossessive };
}

export function loadEntities(db: Db, projectId: number): EntityLite[] {
  return db.all<{ id: number; name: string; aliases: string; kind: string; review_status: string }>(
    'SELECT id, name, aliases, kind, review_status FROM canon_entity WHERE project_id = ? ORDER BY id',
    projectId,
  ).map((row) => ({
    id: Number(row.id),
    name: String(row.name ?? ''),
    aliases: fromJson<string[]>(row.aliases, []),
    kind: String(row.kind ?? ''),
    reviewStatus: String(row.review_status ?? ''),
  }));
}

export interface Occurrence {
  count: number;
  chunks: Array<{ id: number; seq: number; locator: string; text: string; sentence: string }>;
}

export function occurrencesFor(db: Db, projectId: number, forms: string[]): Occurrence {
  const clean = forms.map(collapseWhitespace).filter(Boolean);
  if (!clean.length) return { count: 0, chunks: [] };
  const patterns = clean.map((form) =>
    new RegExp(`(?<![a-z0-9])${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i'));
  const chunks = db.all<{ id: number; seq: number; locator: string; text: string }>(
    'SELECT id, seq, locator, text FROM canon_chunk WHERE project_id = ? ORDER BY seq, id',
    projectId,
  );
  const hitChunks: Occurrence['chunks'] = [];
  let count = 0;
  for (const chunk of chunks) {
    const text = String(chunk.text ?? '');
    const sentence = text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((value) => value.trim())
      .find((value) => patterns.some((pattern) => pattern.test(value))) ?? '';
    const matches = patterns.reduce((total, pattern) =>
      total + (text.match(new RegExp(pattern.source, 'gi'))?.length ?? 0), 0);
    if (!matches) continue;
    count += matches;
    hitChunks.push({
      id: Number(chunk.id),
      seq: Number(chunk.seq),
      locator: String(chunk.locator ?? ''),
      text,
      sentence,
    });
  }
  return { count, chunks: hitChunks };
}

function containsName(a: string, b: string): boolean {
  const left = letters(a);
  const right = letters(b);
  return left.length > 0 && right.length > 0 && (left.includes(right) || right.includes(left));
}

function sameWordSequence(a: string, b: string): boolean {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.length || !right.length) return false;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return short.every((token) => long.includes(token));
}

function truncation(a: string, b: string): boolean {
  const left = letters(a);
  const right = letters(b);
  if (!left || !right) return false;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return long.length - short.length >= 1 && long.length - short.length <= 4 && long.startsWith(short);
}

export interface AliasMerge {
  keepId: number;
  dropId: number;
  keepName: string;
  dropName: string;
  basis: string;
  quote: string;
}

function titleless(name: string): string[] {
  return nameTokens(name).filter((token) => !isTitleToken(token));
}

function hasTitle(name: string): boolean {
  return nameTokens(name).some((token) => isTitleToken(token));
}

function preferName(a: EntityLite, b: EntityLite): { keep: EntityLite; drop: EntityLite } {
  const score = (entity: EntityLite): number[] => [
    hasTitle(entity.name) ? 0 : 1,
    titleless(entity.name).length,
    entity.name.length,
    -entity.id,
  ];
  const left = score(a);
  const right = score(b);
  for (let index = 0; index < left.length; index++) {
    if (left[index]! !== right[index]!) return left[index]! > right[index]! ? { keep: a, drop: b } : { keep: b, drop: a };
  }
  return { keep: a, drop: b };
}

function sameTokenSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((token, index) => token === right[index]);
}

function isStrictSubset(short: string[], long: string[]): boolean {
  if (short.length === 0 || short.length >= long.length) return false;
  return short.every((token) => long.includes(token));
}

/**
 * Title, surname-only and given-name-prefix variants. Bare given names with
 * no title are deliberately left for a model ruling.
 */
export function findAliasMerges(db: Db, projectId: number): AliasMerge[] {
  const characters = loadEntities(db, projectId).filter((entity) => entity.kind === 'character');
  const surnameOwners = new Map<string, number>();
  for (const entity of characters) {
    const parts = titleless(entity.name);
    if (parts.length < 2) continue;
    const surname = parts[parts.length - 1]!;
    surnameOwners.set(surname, (surnameOwners.get(surname) ?? 0) + 1);
  }
  const out: AliasMerge[] = [];
  const dropped = new Set<number>();
  for (let i = 0; i < characters.length; i++) {
    for (let j = i + 1; j < characters.length; j++) {
      const a = characters[i]!;
      const b = characters[j]!;
      if (a.name.toLowerCase() === b.name.toLowerCase()) continue;
      const ta = titleless(a.name);
      const tb = titleless(b.name);
      const titlesA = nameTokens(a.name).filter(isTitleToken).sort();
      const titlesB = nameTokens(b.name).filter(isTitleToken).sort();
      let basis = '';
      if (sameTokenSet(ta, tb)) {
        const sameTitles = titlesA.length === titlesB.length
          && titlesA.every((token, index) => token === titlesB[index]);
        const oneTitleless = titlesA.length === 0 || titlesB.length === 0;
        if (oneTitleless || sameTitles) basis = 'title variant';
      } else if (isStrictSubset(ta, tb) || isStrictSubset(tb, ta)) {
        const shortEntity = ta.length < tb.length ? a : b;
        const longEntity = shortEntity === a ? b : a;
        const shortParts = titleless(shortEntity.name);
        const longParts = titleless(longEntity.name);
        // Only a titled given name ("Aunt Petunia") joins its fuller form.
        if (
          shortParts.length === 1
          && longParts[0] === shortParts[0]
          && hasTitle(shortEntity.name)
        ) {
          basis = 'title and given-name variant';
        }
      }
      if (!basis) {
        const single = ta.length === 1 ? ta[0]! : tb.length === 1 ? tb[0]! : '';
        const longParts = ta.length > 1 ? ta : tb.length > 1 ? tb : [];
        if (single && longParts[longParts.length - 1] === single && (surnameOwners.get(single) ?? 0) === 1) {
          basis = 'surname-only variant';
        }
      }
      if (!basis && ta.length >= 2 && tb.length >= 2) {
        const surnameA = ta[ta.length - 1]!;
        const surnameB = tb[tb.length - 1]!;
        const givenA = ta[0]!;
        const givenB = tb[0]!;
        if (surnameA === surnameB && givenA !== givenB
          && (givenA.startsWith(givenB) || givenB.startsWith(givenA))
          && Math.min(givenA.length, givenB.length) >= 3) {
          basis = 'given-name variant';
        }
      }
      if (!basis) continue;
      const { keep, drop } = preferName(a, b);
      if (dropped.has(drop.id)) continue;
      dropped.add(drop.id);
      out.push({
        keepId: keep.id,
        dropId: drop.id,
        keepName: keep.name,
        dropName: drop.name,
        basis,
        quote: keep.name ? '' : drop.name,
      });
    }
  }
  return out;
}

/**
 * A low-frequency surface within edit distance 1-2 of a banked name, sharing
 * the first letter and a close length band, is an OCR/typo variant.
 */
export function findTypoVariants(db: Db, projectId: number): TypoVariant[] {
  const entities = loadEntities(db, projectId);
  const counts = new Map<number, number>();
  for (const entity of entities) {
    counts.set(entity.id, occurrencesFor(db, projectId, [entity.name, ...entity.aliases]).count);
  }
  const out: TypoVariant[] = [];
  for (const candidate of entities) {
    const occurrences = counts.get(candidate.id) ?? 0;
    if (occurrences < 1 || occurrences > 2) continue;
    const candidateLetters = letters(candidate.name);
    if (candidateLetters.length < 4) continue;
    let best: TypoVariant | null = null;
    for (const other of entities) {
      if (other.id === candidate.id) continue;
      const kinds = new Set([candidate.kind, other.kind]);
      if (![...kinds].every((kind) => kind === 'character' || kind === 'creature' || kind === 'species')) continue;
      const forms = [other.name, ...other.aliases];
      // A one-token typo is compared against the given name too: "Hermlone"
      // must reach "Hermione Granger", not only the full two-token form.
      const given = nameTokens(other.name).filter((token) => !isTitleToken(token))[0];
      if (given && !forms.some((form) => form.toLowerCase() === given.toLowerCase())) forms.push(given);
      for (const form of forms) {
        const cTokens = nameTokens(candidate.name);
        const oTokens = nameTokens(form);
        const cLetters = letters(candidate.name);
        const oLetters = letters(form);
        if (cLetters === `${oLetters}s` || oLetters === `${cLetters}s`) continue;
        let distance = 0;
        let truncated = false;
        if (cTokens.length !== oTokens.length) {
          if (!truncation(candidate.name, form)) continue;
          truncated = true;
          distance = Math.abs(letters(candidate.name).length - letters(form).length);
        } else {
          let okay = true;
          for (let index = 0; index < cTokens.length; index++) {
            const left = cTokens[index]!;
            const right = oTokens[index]!;
            if (left === right) continue;
            if (isTitleToken(left) || isTitleToken(right)) {
              okay = false;
              break;
            }
            const tokenDistance = editDistance(left, right, 2);
            if (tokenDistance > 2) {
              okay = false;
              break;
            }
            distance += tokenDistance;
          }
          if (!okay) continue;
          if (cTokens.length === 1 && distance > 1) continue;
          if (distance > 2) continue;
        }
        const otherOccurrences = counts.get(other.id) ?? 0;
        if (otherOccurrences < occurrences) continue;
        const value: TypoVariant = {
          entityId: candidate.id,
          name: candidate.name,
          occurrences,
          canonicalId: other.id,
          canonicalName: other.name,
          distance,
          reason: truncated ? 'truncated variant' : `edit distance ${distance}`,
        };
        if (
          !best
          || value.distance < best.distance
          || (value.distance === best.distance && otherOccurrences > (counts.get(best.canonicalId) ?? 0))
        ) {
          best = value;
        }
      }
    }
    if (best) out.push(best);
  }
  return out;
}

function insideDialogue(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const quotes = (before.match(/["“”]/g) ?? []).length;
  return quotes % 2 === 1;
}

function givenNamesOf(person: EntityLite): string[] {
  const out = new Set<string>();
  for (const form of [person.name, ...person.aliases]) {
    const first = nameTokens(form).filter((token) => !isTitleToken(token))[0];
    if (first) out.add(first.toLowerCase());
  }
  return [...out];
}

/** 4 = exact given name (leave for a model ruling); 3 = diminutive; 2 = near. */
function givenNameScore(nickname: string, givenNames: string[]): number {
  const nickTokens = tokens(nickname).filter((token) => token.length > 3 && !isTitleToken(token));
  let score = 0;
  for (const nick of nickTokens) {
    for (const given of givenNames) {
      if (nick === given) score = Math.max(score, 4);
      else if (given.length >= 3 && nick.length > given.length && nick.startsWith(given)) score = Math.max(score, 3);
      else if (nick.length >= 4 && given.length >= 4 && editDistance(nick, given, 2) <= 2) score = Math.max(score, 2);
    }
  }
  return score;
}

function isVocative(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const after = new RegExp(`(?:${escaped})['’]?\\s*[,!?]`, 'i');
  if (after.test(text)) return true;
  const speech = /\b(?:said|cried|asked|replied|answered|whispered|shouted|muttered|snapped|yelled|called)\s+$/i;
  const before = new RegExp(`(?:said|cried|asked|replied|answered|whispered|shouted|muttered|snapped|yelled|called)\\s+${escaped}`, 'i');
  return speech.test(text) || before.test(text);
}

/**
 * A surface that occurs only inside dialogue and is a diminutive of a banked
 * person's given name is an alias. Exact given names stay for a model ruling.
 */
export function findNicknameAliases(db: Db, projectId: number): NicknameAlias[] {
  const entities = loadEntities(db, projectId);
  const characters = entities.filter((entity) => entity.kind === 'character' && entity.reviewStatus !== 'quarantined');
  const out: NicknameAlias[] = [];
  for (const candidate of characters) {
    const occurrence = occurrencesFor(db, projectId, [candidate.name]);
    if (occurrence.count < 1 || occurrence.count > 3) continue;
    if (!occurrence.chunks.length) continue;
    if (!occurrence.chunks.every((chunk) => {
      const index = chunk.text.toLowerCase().indexOf(candidate.name.toLowerCase());
      return index < 0 || insideDialogue(chunk.text, index);
    })) continue;
    const scored = new Map<number, { entity: EntityLite; score: number }>();
    for (const chunk of occurrence.chunks) {
      for (const person of characters) {
        if (person.id === candidate.id) continue;
        const score = givenNameScore(candidate.name, givenNamesOf(person));
        // 4 means the candidate is the given name itself: leave it for a
        // model ruling rather than guessing that it is a diminutive.
        if (score <= 0 || score === 4) continue;
        if (score === 2 && !isVocative(chunk.text, candidate.name)) continue;
        const current = scored.get(person.id);
        if (!current || score > current.score) scored.set(person.id, { entity: person, score });
      }
    }
    const ranked = [...scored.values()].sort((left, right) => right.score - left.score || left.entity.id - right.entity.id);
    if (!ranked.length) continue;
    const best = ranked[0]!;
    const tied = ranked.filter((entry) => entry.score === best.score);
    out.push({
      entityId: candidate.id,
      name: candidate.name,
      occurrences: occurrence.count,
      personId: tied.length === 1 ? best.entity.id : null,
      personName: tied.length === 1 ? best.entity.name : '',
      evidence: occurrence.chunks[0]!.sentence,
      chunkId: occurrence.chunks[0]!.id,
      locator: occurrence.chunks[0]!.locator,
      ambiguous: tied.length === 1 ? [] : tied.map((entry) => entry.entity.name),
    });
  }
  return out;
}

/**
 * Animal words are read from the bank's creature/species rows, not a private
 * list. A possessive or "called" construction then yields an owner claim.
 */
export function findOwnershipClaims(db: Db, projectId: number): OwnershipClaim[] {
  const entities = loadEntities(db, projectId);
  const animalWords = new Set<string>();
  for (const entity of entities) {
    if (entity.kind !== 'creature' && entity.kind !== 'species') continue;
    for (const form of [entity.name, ...entity.aliases]) {
      for (const token of tokens(form)) if (token.length > 2) animalWords.add(token);
    }
  }
  const claims: OwnershipClaim[] = [];
  for (const chunk of db.all<{ id: number; seq: number; locator: string; text: string }>(
    'SELECT id, seq, locator, text FROM canon_chunk WHERE project_id = ? ORDER BY seq, id',
    projectId,
  )) {
    const text = String(chunk.text ?? '');
    for (const sentence of text.split(/(?<=[.!?])\s+|\n+/).map((value) => value.trim()).filter(Boolean)) {
      const possessive = /\b([A-Z][A-Za-z'’\-]+)['’]s\s+((?:[a-z]+\s+){0,2}[a-z]+)/g;
      let match: RegExpExecArray | null;
      while ((match = possessive.exec(sentence)) !== null) {
        const possessed = match[2]!.trim();
        const words = tokens(possessed);
        if (!words.some((word) => animalWords.has(word))) continue;
        claims.push({
          owner: match[1]!,
          possessed,
          named: '',
          evidence: sentence,
          chunkId: Number(chunk.id),
          locator: String(chunk.locator ?? ''),
          animalWords: words.filter((word) => animalWords.has(word)),
        });
      }
      const called = /\bcalled\s+([A-Z][A-Za-z'’\-]+)/.exec(sentence);
      if (called) {
        const words = tokens(sentence).filter((word) => animalWords.has(word));
        if (words.length) {
          const owner = /\b([A-Z][A-Za-z'’\-]+)['’]s\b/.exec(sentence)?.[1]
            ?? /\b([A-Z][A-Za-z'’\-]+)\s+(?:had|kept|owned)\b/.exec(sentence)?.[1]
            ?? '';
          claims.push({
            owner,
            possessed: words.join(' '),
            named: called[1]!,
            evidence: sentence,
            chunkId: Number(chunk.id),
            locator: String(chunk.locator ?? ''),
            animalWords: words,
          });
        }
      }
      const owned = /\b([A-Z][A-Za-z'’\-]+)\s+owned\s+a[n]?\s+((?:[a-z]+\s+){0,2}[a-z]+)/.exec(sentence);
      if (owned) {
        const words = tokens(owned[2]!);
        if (words.some((word) => animalWords.has(word))) {
          claims.push({
            owner: owned[1]!,
            possessed: owned[2]!.trim(),
            named: '',
            evidence: sentence,
            chunkId: Number(chunk.id),
            locator: String(chunk.locator ?? ''),
            animalWords: words.filter((word) => animalWords.has(word)),
          });
        }
      }
    }
  }
  return claims;
}
