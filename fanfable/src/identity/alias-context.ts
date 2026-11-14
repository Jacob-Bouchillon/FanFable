/**
 * Context alias resolution: candidates and verdict validation.
 *
 * NOT WIRED. No production module imports this file; it is exercised by tests
 * and by the trial scripts noted here, and nothing in the running product
 * reaches it. Read it as a built-and-tested candidate, not as live behaviour.
 *
 * Pure functions only. The caller supplies character entities and chunk texts;
 * this module never reads a database and never calls a model.
 */

export interface AliasCandidateEntity {
  id: number;
  name: string;
  aliases: string[];
}

export interface AliasCandidate {
  a: AliasCandidateEntity;
  b: AliasCandidateEntity;
  shared: string;
}

export interface AliasVerdictInput {
  same: unknown;
  quote?: unknown;
  reason?: unknown;
}

export type AliasVerdictRejection =
  | 'bad-shape'
  | 'quote-absent'
  | 'quote-not-found'
  | 'names-not-both'
  | 'alias-conflict';

export interface AliasVerdict {
  same: boolean;
  quote: string;
  reason: string;
  rejection?: AliasVerdictRejection;
}

const HONOURIFICS = new Set([
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
  'the',
]);

function tokenize(value: string): string[] {
  return String(value ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function nameTokens(value: string): Set<string> {
  return new Set(tokenize(value).filter((token) => !HONOURIFICS.has(token) && token.length > 2));
}

function normalizeName(value: string): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeWhitespace(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function hasNameAsAlias(entity: AliasCandidateEntity, other: AliasCandidateEntity): boolean {
  const otherName = normalizeName(other.name);
  return entity.aliases.some((alias) => normalizeName(alias) === otherName);
}

/**
 * Propose surname-only pairs for the context layer.
 *
 * `entities` is expected to contain character entities only; `groupOf` maps
 * each entity id already settled by the deterministic pass to its group id.
 */
export function proposeAliasCandidates(
  entities: AliasCandidateEntity[],
  groupOf: ReadonlyMap<number, number>,
): AliasCandidate[] {
  const byId = new Map<number, AliasCandidateEntity>();
  for (const entity of entities) {
    if (!byId.has(entity.id)) byId.set(entity.id, entity);
  }
  const records = [...byId.values()];
  const tokensById = new Map<number, Set<string>>();
  const frequency = new Map<string, number>();
  for (const entity of records) {
    const tokens = nameTokens(entity.name);
    tokensById.set(entity.id, tokens);
    for (const token of tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }

  const candidates = new Map<string, AliasCandidate>();
  for (let i = 0; i < records.length; i++) {
    const a = records[i];
    for (let j = i + 1; j < records.length; j++) {
      const b = records[j];
      if (a.id === b.id) continue;
      const groupA = groupOf.get(a.id);
      const groupB = groupOf.get(b.id);
      if (groupA !== undefined && groupB !== undefined && groupA === groupB) continue;
      if (hasNameAsAlias(a, b) || hasNameAsAlias(b, a)) continue;
      const aTokens = tokensById.get(a.id) ?? new Set<string>();
      const bTokens = tokensById.get(b.id) ?? new Set<string>();
      const shared = [...aTokens]
        .filter((token) => bTokens.has(token) && (frequency.get(token) ?? 0) <= 3)
        .sort((left, right) => {
          const byFrequency = (frequency.get(left) ?? 0) - (frequency.get(right) ?? 0);
          if (byFrequency !== 0) return byFrequency;
          return left < right ? -1 : left > right ? 1 : 0;
        })[0];
      if (!shared) continue;
      const first = a.id < b.id ? a : b;
      const second = a.id < b.id ? b : a;
      const key = `${first.id}:${second.id}`;
      if (!candidates.has(key)) candidates.set(key, { a: first, b: second, shared });
    }
  }
  return [...candidates.values()].sort((left, right) =>
    left.a.id - right.a.id || left.b.id - right.b.id);
}

function rejection(reason: AliasVerdictRejection, quote = '', text = ''): AliasVerdict {
  return { same: false, quote, reason: text, rejection: reason };
}

function appearsInChunks(quote: string, chunkTexts: string[]): boolean {
  const needle = normalizeWhitespace(quote);
  if (!needle) return false;
  return chunkTexts.some((chunk) => normalizeWhitespace(chunk).includes(needle));
}

function appearsInQuote(quote: string, form: string): boolean {
  const trimmed = normalizeWhitespace(form);
  if (!trimmed) return false;
  const haystack = normalizeWhitespace(quote).toLowerCase();
  const escaped = trimmed.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(haystack);
}

function sideAppears(quote: string, name: string, aliases: string[]): boolean {
  if (appearsInQuote(quote, name)) return true;
  return aliases
    .filter((alias) => tokenize(alias).length >= 2)
    .some((alias) => appearsInQuote(quote, alias));
}

function namesBothSides(
  quote: string,
  ctx: { aName: string; bName: string; aAliases: string[]; bAliases: string[] },
): boolean {
  return sideAppears(quote, ctx.aName, ctx.aAliases)
    && sideAppears(quote, ctx.bName, ctx.bAliases);
}

function aliasConflict(
  ctx: { aName: string; bName: string; aAliases: string[]; bAliases: string[] },
): boolean {
  const aName = normalizeName(ctx.aName);
  const bName = normalizeName(ctx.bName);
  return ctx.aAliases.some((alias) => normalizeName(alias) === bName)
    || ctx.bAliases.some((alias) => normalizeName(alias) === aName);
}

export function validateAliasVerdict(
  verdict: AliasVerdictInput,
  ctx: { chunkTexts: string[]; aName: string; bName: string; aAliases: string[]; bAliases: string[] },
): AliasVerdict {
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) {
    return rejection('bad-shape');
  }
  if (verdict.quote !== undefined && verdict.quote !== null && typeof verdict.quote !== 'string') {
    return rejection('bad-shape');
  }
  if (verdict.reason !== undefined && verdict.reason !== null && typeof verdict.reason !== 'string') {
    return rejection('bad-shape');
  }
  const answer = typeof verdict.same === 'string' ? verdict.same.trim().toLowerCase() : '';
  if (answer !== 'yes' && answer !== 'no' && answer !== 'unsure') {
    return rejection('bad-shape');
  }
  const quote = typeof verdict.quote === 'string' ? verdict.quote : '';
  const reason = typeof verdict.reason === 'string' ? verdict.reason : '';
  if (answer !== 'yes') {
    return { same: false, quote, reason };
  }
  if (!quote.trim()) return rejection('quote-absent', quote, reason);
  if (!appearsInChunks(quote, ctx.chunkTexts)) return rejection('quote-not-found', quote, reason);
  if (!namesBothSides(quote, ctx)) return rejection('names-not-both', quote, reason);
  if (aliasConflict(ctx)) return rejection('alias-conflict', quote, reason);
  return { same: true, quote, reason };
}
