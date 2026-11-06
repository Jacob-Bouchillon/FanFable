/**
 * Character sweep: the web walking one character through the whole book.
 *
 * Planning and validation are read-only. applySweep inserts needs_review
 * relations and one character-sweep ruling per accepted tie.
 */
import { Db, fromJson } from '../core/db.ts';
import { extractJson } from '../core/json.ts';
import { STOPWORDS } from '../core/vocab.ts';
import { insertRelation } from '../lorebook.ts';
import { recordRuling } from '../court/ruling.ts';
import { citationNamesBothEndpoints } from '../gates/gates.ts';
import {
  chapterCharacters,
  characterChapters,
  type ChapterAppearance,
} from './chapter-index.ts';

export interface SweepPassage {
  chunkId: number;
  locator: string;
  seq: number;
  text: string;
  /** Source title when the plan loaded it; used by the extractor passage format. */
  sourceTitle?: string;
}

export interface SweepTarget {
  entityId: number;
  name: string;
  aliases: string[];
  passages: SweepPassage[];
}

export interface SweepTie {
  other: string;
  kind: string;
  direction: 'out' | 'in';
  quote: string;
  chunkIndex: number;
  reason?: string;
  anchor?: string;
}

export type SweepRejection =
  | 'bad-shape'
  | 'unknown-other'
  | 'self'
  | 'quote-absent'
  | 'quote-not-found'
  | 'substitution'
  | 'names-not-both'
  | 'kind-not-allowed'
  | 'duplicate';

export const SWEEP_KINDS = new Set([
  'friend of',
  'enemy of',
  'rival of',
  'disliked',
  'trusted',
  'distrusted',
  'ally of',
  'mentor of',
  'student of',
  'colleague of',
  'parent of',
  'child of',
  'sibling of',
  'spouse of',
  'relative of',
  'member of',
  'leader of',
  'protective of',
  'peer of',
]);

function collapseWhitespace(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeName(value: string): string {
  return collapseWhitespace(value).toLowerCase();
}

const NAME_NOISE = new Set([
  ...STOPWORDS,
  'mr',
  'mrs',
  'ms',
  'miss',
  'professor',
  'uncle',
  'aunt',
  'lord',
  'madam',
  'dr',
]);

function nameForms(name: string, aliases: string[]): string[] {
  const forms = new Set<string>();
  for (const value of [name, ...aliases]) {
    const full = collapseWhitespace(value);
    if (!full) continue;
    forms.add(full);
    for (const token of full.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      if (token.length > 2 && !NAME_NOISE.has(token)) forms.add(token);
    }
  }
  return [...forms];
}

export function namedCharacterIds(text: string, known: Map<string, number>): Set<number> {
  const forms: Array<{ form: string; id: number }> = [];
  for (const [name, id] of known) {
    for (const form of nameForms(name, [])) forms.push({ form, id });
  }
  const ids = new Set<number>();
  for (const { form, id } of forms) {
    if (quoteMentions(text, [form])) ids.add(id);
  }
  return ids;
}

function knownFormsForId(known: Map<string, number>, id: number): string[] {
  const forms = new Set<string>();
  for (const [name, candidate] of known) {
    if (candidate !== id) continue;
    for (const form of nameForms(name, [])) forms.add(form);
  }
  return [...forms];
}

function quoteMentions(quote: string, forms: string[]): boolean {
  const text = collapseWhitespace(quote);
  return forms.some((form) => {
    const escaped = collapseWhitespace(form).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(text);
  });
}

function chapterKey(appearance: ChapterAppearance): string {
  const heading = appearance.heading.trim();
  if (heading) return heading.toLowerCase();
  const locator = appearance.locator;
  return locator
    .replace(/\s*\(p\.[^)]*\).*$/i, '')
    .replace(/\s*#\d+$/, '')
    .trim()
    .toLowerCase();
}

function resolveCharacter(
  rows: Array<{ id: number; name: string; aliases: string }>,
  selector: string,
): { id: number; name: string; aliases: string } | null {
  const target = normalizeName(selector);
  if (!target) return null;
  for (const row of rows) {
    if (normalizeName(row.name) === target) return row;
  }
  for (const row of rows) {
    const aliases = fromJson<string[]>(row.aliases, []).map(normalizeName);
    if (aliases.includes(target)) return row;
  }
  // Cast names are often the short form ("Harry" for "Harry Potter").
  // Treat a whole-word occurrence in the name or an alias as a match.
  const escaped = collapseWhitespace(selector).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');
  for (const row of rows) {
    const forms = [row.name, ...fromJson<string[]>(row.aliases, []).map(String)];
    if (forms.some((form) => pattern.test(String(form ?? '')))) return row;
  }
  return null;
}

export function planSweep(
  db: Db,
  projectId: number,
  opts: { cast?: string[]; minAppearances?: number; maxPassages?: number },
): SweepTarget[] {
  const minAppearances = Math.max(0, Math.floor(opts.minAppearances ?? 3));
  const maxPassages = Math.max(1, Math.floor(opts.maxPassages ?? 20));
  const rows = db.all<{ id: number; name: string; aliases: string }>(
    `SELECT id, name, aliases FROM canon_entity
      WHERE project_id = ? AND kind = 'character' ORDER BY id`,
    projectId,
  );
  if (!rows.length) return [];

  const chunkTexts = new Map<number, { text: string; sourceTitle: string }>();
  const chunks = db.all<{ id: number; text: string; source_title: string }>(
    `SELECT c.id, c.text, s.title AS source_title
       FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id
      WHERE c.project_id = ?`,
    projectId,
  );
  for (const chunk of chunks) {
    chunkTexts.set(Number(chunk.id), {
      text: String(chunk.text ?? ''),
      sourceTitle: String(chunk.source_title ?? ''),
    });
  }

  const characterCache = new Map<number, Array<{ entityId: number }>>();
  const charactersIn = (chunkId: number): Array<{ entityId: number }> => {
    let faces = characterCache.get(chunkId);
    if (!faces) {
      faces = chapterCharacters(db, projectId, chunkId);
      characterCache.set(chunkId, faces);
    }
    return faces;
  };

  const cast = (opts.cast ?? []).map((name) => String(name ?? '').trim()).filter(Boolean);
  const chosen = new Map<number, { row: { id: number; name: string; aliases: string }; extras: Set<string> }>();
  if (cast.length) {
    for (const selector of cast) {
      const row = resolveCharacter(rows, selector);
      if (!row) continue;
      const entry = chosen.get(row.id);
      if (entry) entry.extras.add(selector);
      else chosen.set(row.id, { row, extras: new Set([selector]) });
    }
  } else {
    for (const row of rows) chosen.set(row.id, { row, extras: new Set() });
  }

  const targets: SweepTarget[] = [];
  for (const { row, extras } of chosen.values()) {
    const appearances = characterChapters(db, projectId, row.id, 10_000, [...extras]);
    if (!appearances.length) continue;
    if (!cast.length && appearances.length < minAppearances) continue;

    const candidates = appearances.map((appearance) => {
      const chunk = chunkTexts.get(appearance.chunkId);
      const text = chunk?.text ?? appearance.quote;
      const coMentions = charactersIn(appearance.chunkId)
        .filter((face) => face.entityId !== row.id).length;
      return {
        passage: {
          chunkId: appearance.chunkId,
          locator: appearance.locator,
          seq: appearance.seq,
          text: text.slice(0, 1800),
          sourceTitle: chunk?.sourceTitle ?? '',
        } satisfies SweepPassage,
        coMentions,
        chapter: chapterKey(appearance),
      };
    });

    const buckets = new Map<string, typeof candidates>();
    for (const candidate of candidates) {
      const bucket = buckets.get(candidate.chapter);
      if (bucket) bucket.push(candidate);
      else buckets.set(candidate.chapter, [candidate]);
    }
    const orderedBuckets = [...buckets.values()].map((bucket) =>
      bucket.sort((left, right) => right.coMentions - left.coMentions || left.passage.seq - right.passage.seq));
    orderedBuckets.sort((left, right) =>
      right[0].coMentions - left[0].coMentions || left[0].passage.seq - right[0].passage.seq);

    const passages: SweepPassage[] = [];
    let round = 0;
    while (passages.length < maxPassages) {
      let added = false;
      for (const bucket of orderedBuckets) {
        const entry = bucket[round];
        if (!entry) continue;
        passages.push(entry.passage);
        added = true;
        if (passages.length >= maxPassages) break;
      }
      if (!added) break;
      round++;
    }
    if (!passages.length) continue;
    targets.push({
      entityId: row.id,
      name: row.name,
      aliases: fromJson<string[]>(row.aliases, []).map(String),
      passages,
    });
  }
  return targets;
}

function asSweepTie(value: unknown): SweepTie | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.other !== 'string' || !entry.other.trim()) return null;
  if (typeof entry.kind !== 'string' || !entry.kind.trim()) return null;
  const direction = typeof entry.direction === 'string' ? entry.direction.trim().toLowerCase() : '';
  if (direction !== 'out' && direction !== 'in') return null;
  if (typeof entry.quote !== 'string') return null;
  const rawIndex = entry.chunk_index ?? entry.chunkIndex;
  const chunkIndex = Number(rawIndex);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) return null;
  const reason = typeof entry.reason === 'string' ? entry.reason : undefined;
  return {
    other: entry.other.trim(),
    kind: entry.kind.trim(),
    direction,
    quote: entry.quote,
    chunkIndex,
    ...(reason === undefined ? {} : { reason }),
  };
}

export function parseSweepAnswer(text: string): SweepTie[] {
  const parsed = extractJson<unknown>(text);
  let entries: unknown[] = [];
  if (Array.isArray(parsed)) entries = parsed;
  else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { ties?: unknown }).ties)) {
    entries = (parsed as { ties: unknown[] }).ties;
  }
  const ties: SweepTie[] = [];
  for (const entry of entries) {
    const tie = asSweepTie(entry);
    if (tie) ties.push(tie);
  }
  return ties;
}

function resolveKnownId(name: string, known: Map<string, number>): number | undefined {
  const key = normalizeName(name);
  let id = known.get(key);
  if (id !== undefined) return id;
  for (const [candidate, candidateId] of known) {
    if (normalizeName(candidate) === key) return candidateId;
  }
  return undefined;
}

/**
 * Parse the extractor's relations JSON for one sweep target.
 *
 * The extractor shape is { relations: [{ from, to, kind, evidence,
 * chunk_index, anchor, description, why }] }. Only entries naming the target on
 * one side become sweep ties; the other endpoint is kept by name even when it
 * does not resolve, so validation can report unknown-other.
 */
export function parseRelationSweepAnswer(
  text: string,
  target: SweepTarget,
  known: Map<string, number>,
): SweepTie[] {
  const parsed = extractJson<unknown>(text);
  let entries: unknown[] = [];
  if (Array.isArray(parsed)) entries = parsed;
  else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { relations?: unknown }).relations)) {
    entries = (parsed as { relations: unknown[] }).relations;
  }

  const ties: SweepTie[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.from !== 'string' || typeof entry.to !== 'string') continue;
    if (typeof entry.kind !== 'string' || !entry.kind.trim()) continue;
    if (typeof entry.evidence !== 'string') continue;
    const chunkIndex = Number(entry.chunk_index ?? entry.chunkIndex);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) continue;

    const fromId = resolveKnownId(entry.from, known);
    const toId = resolveKnownId(entry.to, known);
    let other: string;
    let direction: 'out' | 'in';
    if (fromId === target.entityId) {
      other = entry.to;
      direction = 'out';
    } else if (toId === target.entityId) {
      other = entry.from;
      direction = 'in';
    } else {
      continue;
    }

    const anchorRaw = entry.anchor ?? entry.anchor_evidence;
    const reasonRaw = entry.description ?? entry.why;
    const anchor = typeof anchorRaw === 'string' && anchorRaw.trim() ? anchorRaw : undefined;
    const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw : undefined;
    ties.push({
      other: other.trim(),
      kind: entry.kind.trim(),
      direction,
      quote: entry.evidence,
      chunkIndex,
      ...(reason === undefined ? {} : { reason }),
      ...(anchor === undefined ? {} : { anchor }),
    });
  }
  return ties;
}

function quotePassage(tie: SweepTie, passages: SweepPassage[]): SweepPassage | null {
  const quote = collapseWhitespace(tie.quote);
  if (!quote) return null;
  const indexed = passages[tie.chunkIndex];
  if (indexed && collapseWhitespace(indexed.text).includes(quote)) return indexed;
  return passages.find((passage) => collapseWhitespace(passage.text).includes(quote)) ?? null;
}

export function sweepRelationKey(fromId: number, toId: number, kind: string): string {
  return `${Math.min(fromId, toId)}:${Math.max(fromId, toId)}:${String(kind ?? '').trim().toLowerCase()}`;
}

export interface SweepTieProposal {
  tie: SweepTie;
  toId: number;
  bothInQuote: boolean;
}

export interface SweepTieRejection {
  tie: SweepTie;
  reason: SweepRejection;
}

export interface SweepTieValidation {
  proposals: SweepTieProposal[];
  rejections: SweepTieRejection[];
}

export function batchSweepPassages(passages: SweepPassage[], batchSize: number): SweepPassage[][] {
  const size = Math.max(1, Math.floor(batchSize));
  const batches: SweepPassage[][] = [];
  for (let index = 0; index < passages.length; index += size) {
    batches.push(passages.slice(index, index + size));
  }
  return batches;
}

export function validateSweepTies(
  ties: SweepTie[],
  target: SweepTarget,
  known: Map<string, number>,
  existing: Set<string>,
  allowedKinds: Set<string> = SWEEP_KINDS,
): SweepTieValidation {
  const proposals: SweepTieProposal[] = [];
  const rejections: SweepTieRejection[] = [];
  for (const tie of ties) {
    const verdict = validateSweepTie(tie, target, target.passages, known, allowedKinds, existing);
    if (!verdict.ok) {
      rejections.push({ tie, reason: verdict.reason });
      continue;
    }
    const quoteIds = namedCharacterIds(tie.quote, known);
    proposals.push({
      tie,
      toId: verdict.toId,
      bothInQuote: quoteIds.has(target.entityId) && quoteIds.has(verdict.toId),
    });
    const kind = tie.kind.trim().toLowerCase();
    const fromId = tie.direction === 'out' ? target.entityId : verdict.toId;
    const toId = tie.direction === 'out' ? verdict.toId : target.entityId;
    existing.add(sweepRelationKey(fromId, toId, kind));
  }
  return { proposals, rejections };
}

export function validateSweepTie(
  tie: SweepTie,
  target: SweepTarget,
  passages: SweepPassage[],
  known: Map<string, number>,
  allowedKinds: Set<string>,
  existing: Set<string>,
): { ok: true; toId: number } | { ok: false; reason: SweepRejection } {
  if (
    !tie
    || typeof tie.other !== 'string'
    || typeof tie.kind !== 'string'
    || (tie.direction !== 'out' && tie.direction !== 'in')
    || typeof tie.quote !== 'string'
    || !Number.isInteger(tie.chunkIndex)
    || tie.chunkIndex < 0
  ) {
    return { ok: false, reason: 'bad-shape' };
  }

  const otherName = normalizeName(tie.other);
  let otherId = known.get(otherName);
  if (otherId === undefined) {
    for (const [name, id] of known) {
      if (normalizeName(name) === otherName) {
        otherId = id;
        break;
      }
    }
  }
  if (otherId === undefined) return { ok: false, reason: 'unknown-other' };
  if (otherId === target.entityId) return { ok: false, reason: 'self' };

  const kind = tie.kind.trim().toLowerCase();
  const quote = collapseWhitespace(tie.quote);
  if (!quote) return { ok: false, reason: 'quote-absent' };
  if (!quotePassage(tie, passages)) return { ok: false, reason: 'quote-not-found' };

  const targetForms = nameForms(target.name, target.aliases);
  const citedBoth = citationNamesBothEndpoints({
    fromId: target.entityId,
    toId: otherId,
    fromName: targetForms[0] ?? target.name,
    toName: tie.other,
    fromAliases: targetForms.slice(1),
    toAliases: knownFormsForId(known, otherId),
    kind,
    evidence: tie.quote,
    anchorEvidence: tie.anchor ?? '',
  });
  if (!citedBoth) return { ok: false, reason: 'names-not-both' };
  if (!allowedKinds.has(kind)) return { ok: false, reason: 'kind-not-allowed' };

  const fromId = tie.direction === 'out' ? target.entityId : otherId;
  const toId = tie.direction === 'out' ? otherId : target.entityId;
  if (existing.has(sweepRelationKey(fromId, toId, kind))) {
    return { ok: false, reason: 'duplicate' };
  }
  return { ok: true, toId: otherId };
}

function knownCharacters(db: Db, projectId: number): Map<string, number> {
  const rows = db.all<{ id: number; name: string; aliases: string }>(
    `SELECT id, name, aliases FROM canon_entity
      WHERE project_id = ? AND kind = 'character' ORDER BY id`,
    projectId,
  );
  const known = new Map<string, number>();
  for (const row of rows) {
    const names = [row.name, ...fromJson<string[]>(row.aliases, []).map(String)];
    for (const name of names) {
      const key = normalizeName(name);
      if (key && !known.has(key)) known.set(key, Number(row.id));
    }
  }
  return known;
}

function existingRelations(db: Db, projectId: number): Set<string> {
  const rows = db.all<{ from_entity: number; to_entity: number; kind: string }>(
    'SELECT from_entity, to_entity, kind FROM canon_relation WHERE project_id = ?',
    projectId,
  );
  const existing = new Set<string>();
  for (const row of rows) {
    existing.add(sweepRelationKey(Number(row.from_entity), Number(row.to_entity), row.kind));
  }
  return existing;
}

export function applySweep(
  db: Db,
  projectId: number,
  target: SweepTarget,
  ties: SweepTie[],
  opts: { dryRun: boolean; allowedKinds?: Set<string> },
): { added: number; duplicates: number; rejected: number; byReason: Record<string, number> } {
  const allowedKinds = opts.allowedKinds ?? SWEEP_KINDS;
  const run = (): { added: number; duplicates: number; rejected: number; byReason: Record<string, number> } => {
    const counts = { added: 0, duplicates: 0, rejected: 0, byReason: {} as Record<string, number> };
    const known = knownCharacters(db, projectId);
    const existing = existingRelations(db, projectId);

    for (const tie of ties) {
      const verdict = validateSweepTie(tie, target, target.passages, known, allowedKinds, existing);
      if (!verdict.ok) {
        counts.byReason[verdict.reason] = (counts.byReason[verdict.reason] ?? 0) + 1;
        if (verdict.reason === 'duplicate') counts.duplicates++;
        else counts.rejected++;
        continue;
      }
      const passage = quotePassage(tie, target.passages);
      if (!passage) {
        counts.rejected++;
        counts.byReason['quote-not-found'] = (counts.byReason['quote-not-found'] ?? 0) + 1;
        continue;
      }
      const kind = tie.kind.trim().toLowerCase();
      const otherId = verdict.toId;
      const fromId = tie.direction === 'out' ? target.entityId : otherId;
      const toId = tie.direction === 'out' ? otherId : target.entityId;
      const key = sweepRelationKey(fromId, toId, kind);
      if (existing.has(key)) {
        counts.duplicates++;
        counts.byReason['duplicate'] = (counts.byReason['duplicate'] ?? 0) + 1;
        continue;
      }
      counts.added++;
      existing.add(key);
      if (opts.dryRun) continue;

      // The one relation insert, so the architecture rule holds: the sweep
      // proposes candidates, the owner writes them with a charge ruling.
      const relationId = insertRelation(db, projectId, {
        fromEntity: fromId,
        toEntity: toId,
        kind,
        description: tie.reason ?? '',
        evidence: tie.quote,
        sourceRefs: JSON.stringify([{ locator: passage.locator, chunk: passage.chunkId }]),
        anchorEvidence: tie.anchor ?? '',
        reviewStatus: 'needs_review',
        confidence: 1.0,
      });
      recordRuling(db, projectId, {
        relationId,
        role: 'clue',
        actor: 'character-sweep' as never,
        standard: 'sweep',
        toStatus: 'needs_review',
        basis: `sweep: ${target.name}`,
        quote: tie.quote,
      });
    }
    return counts;
  };

  return opts.dryRun ? run() : db.transaction(run);
}
