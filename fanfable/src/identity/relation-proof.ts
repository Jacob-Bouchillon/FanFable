/**
 * Relation proof rules.
 *
 * A banked tie must answer three questions, and this module answers all three
 * without a database or a model:
 *
 *   WHICH CONCEPT   the twelve families. A kind outside them is not a proof
 *                   kind: it parks for review and never banks.
 *   WHICH WAY       the arrow, read from the winning sentence's own grammar,
 *                   never from the order the extractor happened to emit.
 *   SINCE WHEN      current, past, suspected or unknown, read from the same
 *                   sentence.
 *
 * The vocabulary is general English. Nothing here is book-specific, and the
 * family keywords match bank kind labels, not passage prose.
 */

/** The twelve proof families. Family identity is what may enter the bank. */
export type RelationFamily =
  | 'parent'
  | 'child'
  | 'master'
  | 'ally'
  | 'enemy'
  | 'member'
  | 'servant'
  | 'spouse'
  | 'sibling'
  | 'debtor'
  | 'employer'
  | 'located';

export interface FamilyRule {
  family: RelationFamily;
  /** The family's own label, used when a kind must be given one. */
  canonical: string;
  /** The family that holds the same tie from the other side, when different. */
  inverseFamily: RelationFamily;
  /** Bank kind labels absorbed by this family (substring match, lowercase). */
  keys: readonly string[];
  /** Head nouns a sentence uses to state this family. */
  heads: readonly string[];
}

/**
 * Twelve families. `inverseFamily` names the family on the other side of an
 * asymmetric tie; symmetric families point at themselves.
 */
export const RELATION_FAMILIES: readonly FamilyRule[] = [
  {
    family: 'parent',
    canonical: 'parent_of',
    inverseFamily: 'child',
    keys: [
      'father of', 'mother of', 'parent of', 'father', 'mother', 'parent',
      // Extended kin one generation up, and a guardian who stands in a
      // parent's place. The twelve families are buckets for proof, not a
      // taxonomy: a grandparent and a guardian both hold the parent's side.
      'grandfather', 'grandmother', 'grandparent', 'guardian', 'ancestor',
    ],
    heads: ['father', 'mother', 'parent', 'grandfather', 'grandmother', 'guardian'],
  },
  {
    family: 'child',
    canonical: 'child_of',
    inverseFamily: 'parent',
    keys: [
      'son of', 'daughter of', 'child of', 'born to', 'offspring', 'clan', 'family',
      'grandson', 'granddaughter', 'grandchild', 'descendant', 'ward of',
    ],
    heads: ['son', 'daughter', 'child', 'grandson', 'granddaughter', 'ward'],
  },
  {
    family: 'master',
    canonical: 'master_of',
    inverseFamily: 'servant',
    keys: [
      'master', 'mentor', 'teacher', 'trainer', 'tutor', 'disciple', 'student', 'padawan',
      'trained by', 'shepherd of', 'guide to',
    ],
    heads: ['master', 'mentor', 'teacher', 'trainer', 'tutor'],
  },
  {
    family: 'ally',
    canonical: 'ally_of',
    inverseFamily: 'ally',
    keys: [
      'ally', 'friend', 'partner', 'acquaintance', 'peer', 'colleague', 'companion', 'associate',
      'contact', 'contacted', 'meeting', 'met with', 'collaborator', 'interacted', 'communicating', 'contacting',
      'congratulating', 'introduced', 'invited', 'linked', 'relationship', 'concerned about',
      // Moving and acting together is companionship.
      'accompanied by', 'accompanies', 'accompany', 'travels with', 'travel with', 'goes with',
      // The positive affect concepts from the same closed vocabulary.
      'trust', 'trusted', 'trusts', 'admire', 'admired', 'admires',
      'loyal', 'loyal to', 'protective', 'protective of', 'cared for', 'fond of',
    ],
    heads: ['ally', 'friend', 'partner', 'acquaintance', 'peer', 'colleague', 'companion'],
  },
  {
    family: 'enemy',
    canonical: 'enemy_of',
    inverseFamily: 'enemy',
    keys: [
      'enemy', 'opponent', 'rival', 'adversary', 'foe', 'nemesis', 'hated', 'suspected enemy',
      'threatened', 'choked', 'murderer', 'killer', 'skeptic', 'denigrated', 'criticized',
      'challenged', 'competes', 'tricked', 'saboteur', 'liability', 'estranged', 'affected by', 'refuses',
      // The negative affect concepts in the app's own closed vocabulary. They
      // are standing attitudes, not moments, and they belong to one side of
      // the ally/enemy split rather than to the open vocabulary.
      'hostile', 'fear', 'feared', 'fears', 'fearful', 'hate', 'dislike', 'disliked', 'dislikes',
      'resented', 'resents', 'resentment', 'distrust', 'distrusted', 'distrusts', 'jealous of',
      'bullied', 'bullies',
    ],
    heads: ['enemy', 'opponent', 'rival', 'adversary', 'foe'],
  },
  {
    family: 'member',
    canonical: 'member_of',
    inverseFamily: 'member',
    keys: ['member', 'inhabitant', 'resident', 'crew member', 'belongs to'],
    heads: ['member', 'inhabitant', 'resident'],
  },
  {
    family: 'servant',
    canonical: 'servant_of',
    inverseFamily: 'master',
    keys: [
      'servant', 'serves', 'service of', 'aide', 'assistant', 'apprentice', 'apprentice to', 'follower',
      'employee', 'hired', 'informant', 'lobbyist', 'valued', 'appreciates', 'acknowledged',
      'acknowledges', 'approved', 'sanctions', 'promotes', 'appointed ambassador', 'receives orders',
      'obeyed', 'obeys', 'operative for',
    ],
    heads: ['servant', 'aide', 'assistant', 'follower', 'apprentice', 'employee'],
  },
  {
    family: 'spouse',
    canonical: 'spouse_of',
    inverseFamily: 'spouse',
    keys: ['married', 'spouse', 'husband', 'wife', 'lover', 'widow', 'betrothed', 'partner of'],
    heads: ['spouse', 'husband', 'wife', 'lover', 'widow'],
  },
  {
    family: 'sibling',
    canonical: 'sibling_of',
    inverseFamily: 'sibling',
    keys: [
      'sibling', 'brother', 'sister', 'twin',
      // The wider kin circle: an aunt or uncle is a parent's sibling, a
      // cousin shares a grandparent, a nephew or niece is a sibling's child.
      // One family holds them so the table stays at twelve.
      'aunt', 'uncle', 'cousin', 'nephew', 'niece', 'relative', 'kin',
    ],
    heads: [
      'sibling', 'brother', 'sister', 'twin',
      'aunt', 'uncle', 'cousin', 'nephew', 'niece', 'relative',
    ],
  },
  {
    family: 'debtor',
    canonical: 'debtor_of',
    inverseFamily: 'debtor',
    keys: ['debtor', 'creditor', 'owes', 'beneficiary', 'gifted', 'indebted', 'customer of'],
    heads: ['debtor', 'creditor'],
  },
  {
    family: 'employer',
    canonical: 'employer_of',
    inverseFamily: 'servant',
    keys: [
      'employer', 'employee', 'leader', 'captain of', 'commander of', 'governs', 'governed',
      'brokered', 'dictates', 'owner of',
    ],
    heads: ['employer', 'leader', 'captain', 'commander', 'boss'],
  },
  {
    family: 'located',
    canonical: 'located_in',
    inverseFamily: 'located',
    keys: [
      'located', 'lives in', 'lives with', 'resident of', 'inhabitant of', 'homeworld', 'guest of',
    ],
    heads: ['resident', 'inhabitant', 'homeworld'],
  },
];

/** Matched when a kind names no family. Never a proof kind. */
export const OTHER_FAMILY = 'other' as const;
export type FamilyOfKind = RelationFamily | typeof OTHER_FAMILY;

/** Families whose arrow is not the same claim in either order. */
const ASYMMETRIC = new Set<RelationFamily>(['parent', 'child', 'master', 'servant', 'employer']);

const BY_NAME = new Map<string, FamilyRule>(RELATION_FAMILIES.map((f) => [f.family, f]));

const HEAD_FAMILY = new Map<string, RelationFamily>();
for (const rule of RELATION_FAMILIES) {
  for (const head of rule.heads) if (!HEAD_FAMILY.has(head)) HEAD_FAMILY.set(head, rule.family);
}
const ALL_HEADS = [...HEAD_FAMILY.keys()];

/** Normalise a bank kind for matching only: lowercase, single spaces. */
function foldKind(kind: string): string {
  return String(kind ?? '')
    .toLowerCase()
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The family a bank kind belongs to, or 'other'.
 *
 * Substring matching over the family keyword table: "was" or "mentioned in"
 * hit nothing and stay 'other'; "suspected of" stays 'other' because
 * suspicion is a status, not a tie.
 */
export function familyOfKind(kind: string): FamilyOfKind {
  const k = foldKind(kind);
  if (!k) return OTHER_FAMILY;
  // Whole-word matching, longest keyword first. Whole words stop a stem from
  // reading inside a longer word ("resented" must not match "represented"),
  // and the longest match lets a compound label ("resident of") win over a
  // shorter one in another family ("resident").
  let best: { family: RelationFamily; length: number } | null = null;
  for (const rule of RELATION_FAMILIES) {
    for (const key of rule.keys) {
      const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (!re.test(k)) continue;
      if (!best || key.length > best.length) best = { family: rule.family, length: key.length };
    }
  }
  return best?.family ?? OTHER_FAMILY;
}

/** Is this kind one of the twelve families' proof labels? */
export function isProofKind(kind: string): boolean {
  return familyOfKind(kind) !== OTHER_FAMILY;
}

/** The family on the other side of the same tie. */
export function inverseFamilyOf(family: RelationFamily): RelationFamily {
  return BY_NAME.get(family)?.inverseFamily ?? family;
}

/**
 * What intake must do with one model-proposed kind: bank it, or park it.
 *
 * A kind outside the twelve families is never a proof kind and never banks,
 * whatever confidence the model claimed. The reason string is the one the
 * review queue records, so a parked row says why it parked.
 */
export function proofIntake(kind: string): { action: 'bank'; family: RelationFamily } | { action: 'park'; reason: 'kind-unsupported' } {
  const family = familyOfKind(kind);
  if (family === OTHER_FAMILY) return { action: 'park', reason: 'kind-unsupported' };
  return { action: 'bank', family };
}

/** The canonical family label for a bank kind, or null when unsupported. */
export function canonicalProofKind(kind: string): string | null {
  const family = familyOfKind(kind);
  if (family === OTHER_FAMILY) return null;
  return BY_NAME.get(family)?.canonical ?? null;
}

/* ---------------------------------------------------------------- status */

export type RelationStatus = 'current' | 'past' | 'suspected' | 'unknown';

const SUSPECTED = /\b(?:suspect|suspects|suspected|suspicion|believes?|believed|rumou?rs?|rumou?red|appears? to|seems? to|seemed to|alleged|allegedly|reportedly|may have|might have|possibly|perhaps|could be)\b/i;
const PAST = /\b(?:was|were|had been|has been|once|formerly|former|previously|used to|no longer|late)\b/i;

/**
 * When the tie holds, read from the winning sentence.
 *
 * A sentence with no words cannot date anything: that is `unknown`, never a
 * default of `current`.
 */
export function relationStatusOf(sentence: string): RelationStatus {
  const s = String(sentence ?? '').trim();
  if (!s || !/[a-z]/i.test(s)) return 'unknown';
  if (SUSPECTED.test(s)) return 'suspected';
  if (PAST.test(s)) return 'past';
  return 'current';
}

/* -------------------------------------------------------------- direction */

export type SentenceDirection = 'forward' | 'reverse' | 'none';

function escapeRx(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Which family the sentence gives a name, by its own grammar.
 *
 * Four patterns, all general English:
 *   NAME (is|was) the HEAD            -> NAME holds HEAD's family
 *   NAME's HEAD                       -> NAME holds the inverse family
 *   HEAD of NAME                      -> NAME holds the inverse family
 *   NAME, the HEAD (of ...)           -> NAME holds HEAD's family
 *
 * A name the sentence never places returns nothing; guessing is how a mentor
 * becomes the mentee.
 */
function familiesOfName(sentence: string, name: string): Set<RelationFamily> {
  const out = new Set<RelationFamily>();
  const clean = String(name ?? '').trim();
  if (!clean) return out;
  const n = escapeRx(clean);
  const headAlt = ALL_HEADS.map(escapeRx).join('|');
  const headFamily = (head: string): RelationFamily | undefined => HEAD_FAMILY.get(head.toLowerCase());
  const add = (family: RelationFamily | undefined, invert: boolean): void => {
    if (!family) return;
    out.add(invert ? inverseFamilyOf(family) : family);
  };
  // NAME (is|was|were) [the|a|an] HEAD
  const copular = new RegExp(`\\b${n}\\b\\s*(?:,\\s*)?(?:is|was|were|remains|remained|became)\\s+(?:the\\s+|a\\s+|an\\s+)?(${headAlt})\\b`, 'i');
  const copularHit = copular.exec(sentence);
  if (copularHit) add(headFamily(copularHit[1] ?? ''), false);
  // NAME, the HEAD of ... / NAME the HEAD
  const appositive = new RegExp(`\\b${n}\\b\\s*,\\s*(?:the\\s+|a\\s+|an\\s+)?(${headAlt})\\b`, 'i');
  const appositiveHit = appositive.exec(sentence);
  if (appositiveHit) add(headFamily(appositiveHit[1] ?? ''), false);
  // NAME's HEAD
  const possessive = new RegExp(`\\b${n}\\s*(?:'s|\\u2019s|s')\\s+(?:own\\s+)?(${headAlt})\\b`, 'i');
  const possessiveHit = possessive.exec(sentence);
  if (possessiveHit) add(headFamily(possessiveHit[1] ?? ''), true);
  // HEAD of NAME
  const ofName = new RegExp(`\\b(${headAlt})\\s+of\\s+(?:the\\s+)?${n}\\b`, 'i');
  const ofNameHit = ofName.exec(sentence);
  if (ofNameHit) add(headFamily(ofNameHit[1] ?? ''), true);
  return out;
}

/**
 * The arrow for a directional kind, from the winning sentence.
 *
 * `forward` keeps the extractor's endpoints, `reverse` swaps them, and `none`
 * means the sentence does not place either name. Symmetric families and
 * unsupported kinds always answer `none`: their arrow carries no claim.
 */
export function directionOfSentence(
  sentence: string,
  fromName: string,
  toName: string,
  kind: string,
): SentenceDirection {
  const family = familyOfKind(kind);
  if (family === OTHER_FAMILY) return 'none';
  if (!ASYMMETRIC.has(family)) return 'none';
  const inverse = inverseFamilyOf(family);
  const fromFamilies = familiesOfName(sentence, fromName);
  const toFamilies = familiesOfName(sentence, toName);
  let forward = 0;
  let reverse = 0;
  if (fromFamilies.has(family)) forward++;
  if (toFamilies.has(family)) reverse++;
  if (toFamilies.has(inverse)) forward++;
  if (fromFamilies.has(inverse)) reverse++;
  if (forward > reverse) return 'forward';
  if (reverse > forward) return 'reverse';
  return 'none';
}

/** An endpoint as the caller holds it: an id plus the name the sentence uses. */
export interface NamedEndpoint<T> {
  id: T;
  name: string;
}

/**
 * The endpoints with the arrow the sentence asserts.
 *
 * Intake calls this before it writes: a backwards claim is stored the way the
 * passage says it, not the way the candidate listed it. `none` keeps the
 * caller's order, because a silent sentence is not evidence of a reversal.
 */
export function orientedEndpoints<T>(
  sentence: string,
  from: NamedEndpoint<T>,
  to: NamedEndpoint<T>,
  kind: string,
): { from: NamedEndpoint<T>; to: NamedEndpoint<T>; flipped: boolean } {
  const direction = directionOfSentence(sentence, from.name, to.name, kind);
  if (direction !== 'reverse') return { from, to, flipped: false };
  return { from: to, to: from, flipped: true };
}
