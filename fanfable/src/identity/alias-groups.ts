/**
 * Deterministic alias-group proposals.
 *
 * Read-only: this module only reads names and aliases and returns groups that
 * two conservative rules would merge. It never writes, canonicalises or asks a
 * model.
 */

export interface AliasEntityInput {
  id: number;
  name: string;
  aliases: string[];
  kind: string;
}

export interface AliasGroup {
  canonicalId: number;
  memberIds: number[];
  reason: 'given-name' | 'title-only';
  forms: string[];
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

const DESCRIPTIVE_WORDS = new Set([
  'mother',
  'father',
  'son',
  'daughter',
  'wife',
  'husband',
  'brother',
  'sister',
  'aunt',
  'uncle',
  'cousin',
  'nephew',
  'niece',
  'guardian',
  'owner',
  'servant',
  'master',
  'mistress',
]);

function isDescriptiveAlias(alias: string): boolean {
  const value = String(alias ?? '');
  if (/\b\w+'s\b/i.test(value)) return true;
  return tokenize(value).some((token) => DESCRIPTIVE_WORDS.has(token));
}

interface FormInfo {
  value: string;
  raw: string[];
  tokens: string[];
  titles: string[];
  withoutTitles: string[];
}

function tokenize(value: string): string[] {
  return String(value ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function formInfo(value: string): FormInfo {
  const raw = tokenize(value);
  const titles = raw.filter((token) => HONOURIFICS.has(token));
  return {
    value: String(value ?? ''),
    raw,
    tokens: raw.filter((token) => !HONOURIFICS.has(token) && token.length > 2),
    titles,
    withoutTitles: raw.filter((token) => !HONOURIFICS.has(token)),
  };
}

function sameTokenSet(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const token of setA) if (!setB.has(token)) return false;
  return true;
}

function compatibleTitles(a: FormInfo, b: FormInfo): boolean {
  const titlesA = new Set(a.titles);
  const titlesB = new Set(b.titles);
  if (titlesA.size === 0 || titlesB.size === 0) return true;
  if (titlesA.size !== titlesB.size) return false;
  for (const title of titlesA) if (!titlesB.has(title)) return false;
  return true;
}

function sameWithoutTitles(a: FormInfo, b: FormInfo): boolean {
  if (a.withoutTitles.length !== b.withoutTitles.length) return false;
  const sortedA = [...a.withoutTitles].sort();
  const sortedB = [...b.withoutTitles].sort();
  return sortedA.every((token, index) => token === sortedB[index]);
}

function isStrictSubset(small: Set<string>, large: Set<string>): boolean {
  if (small.size === 0 || small.size >= large.size) return false;
  for (const token of small) if (!large.has(token)) return false;
  return true;
}

function matchesGivenName(a: FormInfo, b: FormInfo): boolean {
  const tokensA = new Set(a.tokens);
  const tokensB = new Set(b.tokens);
  if (isStrictSubset(tokensA, tokensB)) {
    const first = b.tokens[0];
    return first !== undefined && tokensA.has(first);
  }
  if (isStrictSubset(tokensB, tokensA)) {
    const first = a.tokens[0];
    return first !== undefined && tokensB.has(first);
  }
  return false;
}

function matchesTitleOnly(a: FormInfo, b: FormInfo): boolean {
  if (a.titles.length === 0 && b.titles.length === 0) return false;
  if (!sameTokenSet(a.tokens, b.tokens)) return false;
  if (!compatibleTitles(a, b)) return false;
  return sameWithoutTitles(a, b);
}

class UnionFind {
  private readonly parent = new Map<number, number>();

  add(id: number): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: number): number {
    const seen: number[] = [];
    let current = id;
    while (this.parent.get(current) !== current) {
      seen.push(current);
      current = this.parent.get(current)!;
    }
    for (const node of seen) this.parent.set(node, current);
    return current;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootB, rootA);
  }
}

export function proposeAliasGroups(entities: AliasEntityInput[]): AliasGroup[] {
  const byId = new Map<number, AliasEntityInput>();
  for (const entity of entities) {
    if (entity.kind !== 'character') continue;
    if (!byId.has(entity.id)) byId.set(entity.id, entity);
  }
  const records = [...byId.values()];
  const formById = new Map<number, FormInfo[]>();
  const unionFind = new UnionFind();
  const matchedForms = new Map<number, Set<string>>();
  const givenNameIds = new Set<number>();

  for (const entity of records) {
    unionFind.add(entity.id);
    const aliases = Array.isArray(entity.aliases) ? entity.aliases : [];
    const forms = [entity.name];
    for (const alias of aliases) {
      // A one-token alias is a surname or epithet and is too weak to group on.
      // A possessive or role phrase names a relation, not another name.
      if (tokenize(alias).length >= 2 && !isDescriptiveAlias(alias)) forms.push(alias);
    }
    formById.set(entity.id, forms.map(formInfo).filter((form) => form.raw.length > 0));
  }

  const remember = (id: number, form: string): void => {
    const forms = matchedForms.get(id);
    if (forms) forms.add(form);
    else matchedForms.set(id, new Set([form]));
  };

  for (let i = 0; i < records.length; i++) {
    const a = records[i];
    const formsA = formById.get(a.id) ?? [];
    for (let j = i + 1; j < records.length; j++) {
      const b = records[j];
      const formsB = formById.get(b.id) ?? [];
      for (const formA of formsA) {
        for (const formB of formsB) {
          let reason: 'given-name' | 'title-only' | null = null;
          if (matchesGivenName(formA, formB)) reason = 'given-name';
          else if (matchesTitleOnly(formA, formB)) reason = 'title-only';
          if (!reason) continue;
          unionFind.union(a.id, b.id);
          remember(a.id, formA.value);
          remember(b.id, formB.value);
          if (reason === 'given-name') {
            givenNameIds.add(a.id);
            givenNameIds.add(b.id);
          }
        }
      }
    }
  }

  const membersByRoot = new Map<number, number[]>();
  for (const entity of records) {
    const root = unionFind.find(entity.id);
    const members = membersByRoot.get(root);
    if (members) members.push(entity.id);
    else membersByRoot.set(root, [entity.id]);
  }

  const groups: AliasGroup[] = [];
  for (const members of membersByRoot.values()) {
    if (members.length < 2) continue;
    const memberIds = [...members].sort((a, b) => a - b);
    const canonical = memberIds.reduce((best, id) => {
      const candidate = byId.get(id)!;
      const bestEntity = byId.get(best)!;
      const length = String(candidate.name ?? '').length;
      const bestLength = String(bestEntity.name ?? '').length;
      if (length > bestLength) return id;
      if (length < bestLength) return best;
      return id < best ? id : best;
    }, memberIds[0]);
    const forms = new Set<string>();
    for (const id of memberIds) {
      for (const form of matchedForms.get(id) ?? []) forms.add(form);
    }
    const reason = memberIds.some((id) => givenNameIds.has(id)) ? 'given-name' : 'title-only';
    groups.push({
      canonicalId: canonical,
      memberIds,
      reason,
      forms: [...forms].sort(),
    });
  }

  groups.sort((a, b) => a.canonicalId - b.canonicalId);
  return groups;
}
