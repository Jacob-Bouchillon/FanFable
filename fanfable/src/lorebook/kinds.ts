/**
 * Relation kinds: the closed vocabulary, its glosses, and inverse pairs.
 *
 * A label names a concept; its description explains it and how it differs from
 * its neighbours. `CLOSED_ROLE_KINDS` is what the model may return,
 * `KIND_GLOSSES` says what each means and its direction, and the inverse pairs
 * let "master of" reach an apprentice row without a second vocabulary.
 *
 * Moved out of lorebook.ts on 2026-11-13, logic unchanged.
 */
import { Db, strList } from '../core/db.ts';
import { tokenize, normalise } from '../core/text.ts';
import { NAME_DF_CAP, buildRosterIndex, canonicalName } from '../identity/names.ts';
import { PROOF_TITLES } from '../core/vocab.ts';
import { NAME_TITLE_WORDS } from './roster.ts';
import { normaliseKind } from './shared.ts';
import { isMomentKind } from './timeline.ts';
import { KIND_PARTICLES } from '../core/vocab.ts';
import type { RosterIndex } from '../identity/names.ts';
import { explicitVariants } from '../gates/gates.ts';
import { nameTokens } from '../identity/names.ts';
import type { PromoteRow } from '../gates/gates.ts';

/**
 * The role noun at the front of a relation kind: "master of" → "master",
 * "partner with" → "partner", "married to" → "married", "partner" → "partner".
 * Kinds only; entity names never pass through this.
 */
export function kindHead(kind: string): string {
  const canonical = canonicalName(kind);
  for (const particle of KIND_PARTICLES) {
    if (canonical.endsWith(` ${particle}`)) {
      return canonical.slice(0, -(particle.length + 1)).trim();
    }
  }
  return canonical;
}

/**
 * One entry per unordered inverse pair. Both directions are built below, so a
 * new pair cannot accidentally be added one-way. Bare role heads only.
 */
export const INVERSE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['master', 'apprentice'],
  ['parent', 'child'],
  ['parent', 'son'],
  ['parent', 'daughter'],
  ['teacher', 'student'],
  ['mentor', 'student'],
  ['employer', 'aide'],
];

/**
 * Build the one-way lookup from the unordered pair list. Each side points at
 * every partner it appears with; a shared head such as "parent" accumulates
 * all of its children. The map and its lists are frozen at load.
 */
export function buildInverseMap(
  pairs: ReadonlyArray<readonly [string, string]>,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    const list = out.get(from);
    if (!list) out.set(from, [to]);
    else if (!list.includes(to)) list.push(to);
  };
  for (const [left, right] of pairs) {
    link(left, right);
    link(right, left);
  }
  const frozen = new Map<string, readonly string[]>();
  for (const [key, values] of out) frozen.set(key, Object.freeze(values));
  return Object.freeze(frozen);
}

const KIND_INVERSES: ReadonlyMap<string, readonly string[]> = buildInverseMap(INVERSE_PAIRS);

export function inverseKinds(kind: string): readonly string[] {
  return KIND_INVERSES.get(kindHead(kind)) ?? [];
}

export const CLOSED_TIE_LABELS = [
  'sister of', 'brother of', 'sibling of', 'mother of', 'father of', 'parent of',
  'son of', 'daughter of', 'child of', 'husband of', 'wife of', 'spouse of',
  'uncle of', 'aunt of', 'nephew of', 'niece of', 'cousin of',
  'relative of', 'friend of', 'enemy of', 'ally of', 'teacher of', 'student of',
  'mentor of', 'leader of', 'member of', 'peer of', 'colleague of',
];

/** Closed concept list for bankable tie kinds: the allow-list the prompt and the
 * guard share. Universal kin, titled roles, the human-gated peer/colleague set,
 * and the affect family. Anything outside it parks as needs_review with reason
 * open-vocab — never banks accepted. */
export const CLOSED_ROLE_KINDS = [
  ...CLOSED_TIE_LABELS,
  'aide of', 'apprentice of', 'master of', 'operative for', 'partner',
  'guardian of', 'employer of', 'customer of', 'owner of',
  'rival of', 'acquaintance',
  'disliked', 'resented', 'feared', 'admired', 'trusted', 'distrusted',
  'bullied', 'protective of', 'jealous of', 'loyal to', 'obeyed',
];

/** Whether a concept is asserted from one side or is the same claim in either
 * order. This is data on the concept, not a special case in the matcher. */
export type KindDirection = 'directional' | 'symmetric';

/**
 * One description per concept: what it is, and how it differs from its nearest
 * neighbour. The model maps a passage's wording onto one of these; no code lists
 * the English words that express it. Direction says whether a reversed claim is
 * refused or is the same claim stored once.
 */
export const KIND_GLOSSES: Readonly<Record<string, { says: string; direction: KindDirection }>> = {
  'sister of': {
    says: 'Is a female sibling of the other person; differs from sibling of in naming the sex, and from cousin of in sharing a parent.',
    direction: 'directional',
  },
  'brother of': {
    says: 'Is a male sibling of the other person; differs from sibling of in naming the sex, and from cousin of in sharing a parent.',
    direction: 'directional',
  },
  'sibling of': {
    says: 'Shares at least one parent with the other person; differs from cousin of in closeness of blood, and from relative of in being a parent\'s child.',
    direction: 'symmetric',
  },
  'mother of': {
    says: 'Is the female parent of the other person; differs from father of in sex, and from guardian of in a parental bond rather than a duty of care.',
    direction: 'directional',
  },
  'father of': {
    says: 'Is the male parent of the other person; differs from mother of in sex, and from guardian of in a parental bond rather than a duty of care.',
    direction: 'directional',
  },
  'parent of': {
    says: 'Is a parent of the other person when the sex is unknown or irrelevant; differs from mother of and father of in not naming the sex, and from guardian of in a blood or adoptive parental bond.',
    direction: 'directional',
  },
  'son of': {
    says: 'Is the male child of the other person; differs from daughter of in sex, and from child of in naming it.',
    direction: 'directional',
  },
  'daughter of': {
    says: 'Is the female child of the other person; differs from son of in sex, and from child of in naming it.',
    direction: 'directional',
  },
  'child of': {
    says: 'Is the offspring of the other person when the sex is unknown or irrelevant; differs from son of and daughter of in not naming the sex.',
    direction: 'directional',
  },
  'husband of': {
    says: 'Is the married man in the marriage with the other person; differs from wife of in sex, and from spouse of in naming it.',
    direction: 'directional',
  },
  'wife of': {
    says: 'Is the married woman in the marriage with the other person; differs from husband of in sex, and from spouse of in naming it.',
    direction: 'directional',
  },
  'spouse of': {
    says: 'Is the married partner of the other person when the sex is unknown or irrelevant; differs from husband of and wife of in not naming the sex.',
    direction: 'directional',
  },
  'uncle of': {
    says: 'Is a sibling of the other person\'s parent, or the husband of such a sibling; differs from aunt of in sex, and from cousin of in generation.',
    direction: 'directional',
  },
  'aunt of': {
    says: 'Is a sibling of the other person\'s parent, or the wife of such a sibling; differs from uncle of in sex, and from cousin of in generation.',
    direction: 'directional',
  },
  'nephew of': {
    says: 'Is the son of the other person\'s sibling; differs from niece of in sex, and from cousin of in generation.',
    direction: 'directional',
  },
  'niece of': {
    says: 'Is the daughter of the other person\'s sibling; differs from nephew of in sex, and from cousin of in generation.',
    direction: 'directional',
  },
  'cousin of': {
    says: 'Is the child of the other person\'s aunt or uncle; differs from sibling of in not sharing a parent, and from relative of in naming the degree.',
    direction: 'symmetric',
  },
  'relative of': {
    says: 'Is kin by blood or marriage when no closer term fits; differs from sibling of and cousin of in leaving the degree of kinship unspecified.',
    direction: 'symmetric',
  },
  'friend of': {
    says: 'Holds personal affection and companionable regard for the other person beyond a working tie; shared meals, lessons or company alone are not enough. Differs from acquaintance in closeness, and from ally of in affection rather than a shared cause.',
    direction: 'symmetric',
  },
  'enemy of': {
    says: 'Seeks to harm, injure, kill or destroy the other person: open violence, an attack, a curse or a plot is required. Differs from disliked, distrusted and rival of in requiring harm sought, not merely hatred, distrust, competition, bullying or teacher-student friction.',
    direction: 'directional',
  },
  'ally of': {
    says: 'Sides with the other person in a conflict or cause; differs from friend of in a shared cause rather than affection, and from colleague of in acting together under pressure rather than working alongside.',
    direction: 'symmetric',
  },
  'teacher of': {
    says: 'Instructs the other person in a subject or skill; differs from mentor of in teaching a discipline rather than guiding a life, and from student of in the direction of instruction.',
    direction: 'directional',
  },
  'student of': {
    says: 'Is instructed by the other person in a subject or skill; merely attending the same school or being in the same room is not enough. Differs from apprentice of in formal study rather than a trade bound to a master, and from teacher of in the direction of instruction.',
    direction: 'directional',
  },
  'mentor of': {
    says: 'Guides the other person over time, shaping judgment and character; a single act of help or protection is not mentorship. Differs from teacher of in guidance beyond instruction, and from guardian of in development rather than safety.',
    direction: 'directional',
  },
  'leader of': {
    says: 'Heads the group or body the other belongs to; differs from employer of in authority over a body rather than a contract, and from master of in leading free members rather than sworn servants.',
    direction: 'directional',
  },
  'member of': {
    says: 'Belongs to the group or organisation the other heads or embodies; differs from colleague of in membership of a body rather than a working peer, and from ally of in standing membership rather than a cause.',
    direction: 'directional',
  },
  'peer of': {
    says: 'Holds equal standing with the other person in the same body, rank or school; includes classmates and fellow students. Differs from colleague of in equal standing rather than shared work, and from friend of in station rather than affection.',
    direction: 'symmetric',
  },
  'colleague of': {
    says: 'Works alongside the other person in the same organisation or calling; schoolmates, classmates and fellow students are peer of, not colleague. Differs from peer of in shared work rather than equal standing, and from ally of in routine cooperation rather than a cause.',
    direction: 'symmetric',
  },
  'aide of': {
    says: 'Assists the other person in a subordinate personal role; differs from apprentice of in service rather than learning, and from colleague of in subordination.',
    direction: 'directional',
  },
  'apprentice of': {
    says: 'Is learning a trade or discipline from the other person under a binding arrangement; differs from student of in a trade bond, and from aide of in learning rather than service.',
    direction: 'directional',
  },
  'master of': {
    says: 'Has the other person bound as apprentice or sworn servant; differs from employer of in sworn or bound service rather than employment, and from teacher of in authority over a bond.',
    direction: 'directional',
  },
  'operative for': {
    says: 'Carries out assigned or covert tasks for the other person or organisation; differs from aide of in field work for an organisation rather than personal service, and from employee/employer in assigned operations.',
    direction: 'directional',
  },
  'partner': {
    says: 'Works with the other person as an equal over time in a chosen joint enterprise; differs from colleague of in a lasting joint bond, and from ally of in a working partnership rather than a cause.',
    direction: 'symmetric',
  },
  'guardian of': {
    says: 'Has a formal duty to care for and protect the other person; differs from protective of in a duty rather than a feeling, and from parent of in lacking a parental bond.',
    direction: 'directional',
  },
  'employer of': {
    says: 'Pays the other person for work and directs it; differs from master of in a working contract rather than sworn service, and from leader of in an employment relation rather than a body of followers.',
    direction: 'directional',
  },
  'customer of': {
    says: 'Buys goods or services from the other person; differs from employer of in receiving rather than directing work, and from acquaintance in being a commercial relation.',
    direction: 'directional',
  },
  'owner of': {
    says: 'Holds the other creature as property; differs from guardian of in ownership rather than care, and from employer of in owning rather than employing.',
    direction: 'directional',
  },
  'rival of': {
    says: 'Competes with the other person for the same goal, position or affection; differs from enemy of in seeking to outdo rather than to harm, and from peer of in contest rather than equal station.',
    direction: 'symmetric',
  },
  'acquaintance': {
    says: 'Knows the other person by name through repeated encounters and would recognise them; a single meeting, errand or confrontation is not enough. Differs from friend of in lacking affection, and from colleague of in lacking a shared working role.',
    direction: 'symmetric',
  },
  'disliked': {
    says: 'Holds a negative opinion of, or aversion toward, the other person without open conflict or harm sought; differs from enemy of in taking no side and pursuing no harm, and from distrusted in being about the person rather than their reliability.',
    direction: 'symmetric',
  },
  'resented': {
    says: 'Holds a lingering bitter grievance against the other person for a past wrong; differs from disliked in naming a specific injury, and from enemy of in seeking no active harm.',
    direction: 'symmetric',
  },
  'feared': {
    says: 'Feels threat or dread in the other person\'s presence; differs from distrusted in being about danger rather than honesty, and from bullied in being subjected to the threat rather than met with dread.',
    direction: 'symmetric',
  },
  'admired': {
    says: 'Regards the other person with approval and esteem for their qualities or deeds; differs from trusted in being an assessment of worth rather than reliance on conduct.',
    direction: 'symmetric',
  },
  'trusted': {
    says: 'Relies on the other person\'s conduct, honesty or competence; differs from loyal to in being confidence held by the truster rather than allegiance given by the other.',
    direction: 'symmetric',
  },
  'distrusted': {
    says: 'Doubts the other person\'s honesty or intentions; differs from feared in being doubt about reliability rather than dread of harm, and from disliked in being about trust rather than aversion.',
    direction: 'symmetric',
  },
  'bullied': {
    says: 'Subjects the other person to repeated intimidation or coercion from a position of greater power; differs from enemy of in being a pattern of domination rather than open opposition.',
    direction: 'directional',
  },
  'protective of': {
    says: 'Takes responsibility for shielding the other person from harm; differs from guardian of in acting from care or attachment rather than a formal duty, and from mentor of in safeguarding rather than developing.',
    direction: 'directional',
  },
  'jealous of': {
    says: 'Feels wounded or possessive envy toward the other person over attention, status or affection; differs from rival of in being a feeling rather than a competition, and from resented in centring on what the other has.',
    direction: 'symmetric',
  },
  'loyal to': {
    says: 'Gives steadfast allegiance to the other person and puts their interests first; differs from trusted in being allegiance given rather than reliance held.',
    direction: 'directional',
  },
  'obeyed': {
    says: 'Accepts the other person\'s authority and follows their commands; differs from loyal to in acting on orders rather than devotion, and from student of in obedience rather than learning.',
    direction: 'directional',
  },
};

/** The glossary as prompt text: one line per concept, with its direction. */
export function kindGlossaryBlock(): string {
  const lines = CLOSED_ROLE_KINDS.map((kind) => {
    const gloss = KIND_GLOSSES[kind];
    return `- ${kind} (${gloss?.direction ?? 'directional'}) — ${gloss?.says ?? ''}`;
  });
  return (
    'Defined relationship concepts. The kind must be exactly one of these labels; never invent a kind. ' +
    'A directional concept reads from the person it belongs to toward the other person, and a reversed ' +
    'claim is refused. A symmetric concept is the same claim in either order and is stored once. ' +
    'kind_source must be the passage\'s own words that express the concept, copied verbatim.\n' +
    lines.join('\n')
  );
}

/** True when the kind resolves to the closed role-noun list. */
export function isClosedRoleKind(kind: string): boolean {
  return CLOSED_ROLE_KINDS.includes((kind ?? '').trim().toLowerCase());
}

/** True when a concept's direction is enforced on promotion. A symmetric
 * concept is the same claim in either order; an unknown stored kind has no
 * direction claim (and cannot be promoted anyway). */
export function isDirectionalKind(kind: string): boolean {
  return KIND_GLOSSES[(kind ?? '').trim().toLowerCase()]?.direction === 'directional';
}

/** True when a concept is the same claim in either order. An unknown stored
 * kind has no symmetry claim. */
export function isSymmetricKind(kind: string): boolean {
  return KIND_GLOSSES[(kind ?? '').trim().toLowerCase()]?.direction === 'symmetric';
}


/** Kinds that record coverage only (who shared a passage), never a tie. */
export const COVERAGE_KINDS = new Set(['appears with', 'appears in', 'cooccurrence', 'co-occurrence']);

/** Relationship-grade kinds: closed, never coverage, never a moment. */
export const RELATIONSHIP_GRADE_KINDS: ReadonlySet<string> = new Set(
  CLOSED_ROLE_KINDS.filter((kind) => !COVERAGE_KINDS.has(kind) && !isMomentKind(kind)),
);

/** Build the per-command roster index: every entity row plus all chunk text. */
export function commandRosterIndex(db: Db, projectId: number): RosterIndex {
  return buildRosterIndex(
    db.all<{ name: string; aliases: string }>('SELECT name, aliases FROM canon_entity WHERE project_id = ?', projectId)
      .map((row) => ({ name: row.name, aliases: strList(row.aliases) })),
    db.all<{ text: string }>('SELECT text FROM canon_chunk WHERE project_id = ?', projectId)
      .map((row) => row.text)
      .join(' '),
  );
}

/** Kinds that restate the question instead of answering it. Never proof. */
export const GENERIC_PROOF_KINDS = new Set([
  'related to', 'relative of', 'relationship', 'kin', 'family', 'acquaintance', 'associate',
]);

export function canonicalKind(kind: string): string {
  return (kind ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ');
}

function endpointTokens(name: string, aliases: string[], index?: RosterIndex): Set<string> {
  const out = new Set<string>();
  for (const variant of explicitVariants(name, aliases, index)) {
    for (const token of nameTokens(variant)) if (token.length >= 2) out.add(token);
  }
  return out;
}

/**
 * Diagnostic only: the direction a sentence reads for a kind. Promotion does
 * not consult it (direction is the model's); the evidence-repair and audit
 * tools use it to describe what the text says.
 */
function quoteDirection(
  kind: string,
  evidence: string,
  row: PromoteRow,
  index?: RosterIndex,
): 'forward' | 'reverse' | 'unknown' {
  const words = normalise(evidence).split(' ').filter(Boolean);
  if (!words.length) return 'unknown';
  const kindWords = normalise(kind).split(' ').filter(Boolean)
    .filter((word) => !['of', 'to', 'with', 'for', 'a', 'an', 'the', 'in', 'on', 'as'].includes(word));
  const head = kindWords[0];
  if (!head) return 'unknown';
  const from = endpointTokens(row.fromName, row.fromAliases ?? [], index);
  const to = endpointTokens(row.toName, row.toAliases ?? [], index);
  const ownerOf = (token: string): 'from' | 'to' | null => {
    const base = token.replace(/['’]s$/, '');
    if (from.has(base)) return 'from';
    if (to.has(base)) return 'to';
    return null;
  };
  const bases = words.map((word) => word.replace(/['’]s$/, ''));
  const spansOf = (name: string, aliases: string[]): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (const variant of explicitVariants(name, aliases, index)) {
      const target = canonicalName(variant).split(' ').filter(Boolean);
      if (!target.length) continue;
      for (let i = 0; i + target.length <= bases.length; i++) {
        if (target.every((word, k) => bases[i + k] === word)) out.push([i, i + target.length - 1]);
      }
    }
    return out;
  };
  const fromSpans = spansOf(row.fromName, row.fromAliases ?? []);
  const toSpans = spansOf(row.toName, row.toAliases ?? []);
  const coordinatedBetween = (a: [number, number], b: [number, number]): boolean => {
    const lo = a[1] <= b[0] ? a[1] : b[1] <= a[0] ? b[1] : a[0];
    const hi = a[1] <= b[0] ? b[0] : b[1] <= a[0] ? a[0] : a[1];
    for (let at = lo; at <= hi; at++) if (words[at] === 'and' || words[at] === 'or') return true;
    return false;
  };
  const passive = new Set(['was', 'were', 'been', 'had', 'have', 'is', 'are', 'be', 'being']);
  let forward = false;
  for (let at = 0; at < words.length; at++) {
    if (words[at] !== head) continue;
    if (at > 0 && /['’]s$/.test(words[at - 1]!)) {
      const owner = ownerOf(words[at - 1]!);
      if (owner === 'to') forward = true;
      if (owner === 'from') return 'reverse';
    }
    if (words[at + 1] === 'of' && words[at + 2]) {
      const object = ownerOf(words[at + 2]!);
      if (object === 'to') forward = true;
      if (object === 'from') return 'reverse';
      continue;
    }
    let holderAt = at + 1;
    while (holderAt < words.length && (NAME_TITLE_WORDS.has(words[holderAt]!) || PROOF_TITLES.has(words[holderAt]!))) {
      holderAt++;
    }
    if (holderAt < words.length && holderAt > at + 1) {
      const holder = ownerOf(words[holderAt]!);
      if (holder === 'to') return 'reverse';
      if (holder === 'from') forward = true;
    }
    if (!passive.has(words[at - 1] ?? '') && !/['’]s$/.test(words[at - 1] ?? '')) {
      const subjectFrom = fromSpans.some(
        ([s, e]) => e >= at - 2 && e <= at - 1 && !coordinatedBetween([s, e], [at, at]),
      );
      const subjectTo = toSpans.some(
        ([s, e]) => e >= at - 2 && e <= at - 1 && !coordinatedBetween([s, e], [at, at]),
      );
      const otherInWindow = (spans: Array<[number, number]>): boolean =>
        spans.some(([s, e]) => s >= at + 1 && s <= at + 3 && !coordinatedBetween([at, at], [s, e]));
      if (subjectFrom && otherInWindow(toSpans)) forward = true;
      if (subjectTo && otherInWindow(fromSpans)) return 'reverse';
    }
  }
  return forward ? 'forward' : 'unknown';
}

/** Diagnostic only; see `quoteDirection`. */
export function relationSentenceDirection(
  kind: string,
  evidence: string,
  fromName: string,
  fromAliases: string[],
  toName: string,
  toAliases: string[],
  index?: RosterIndex,
): 'forward' | 'reverse' | 'unknown' {
  return quoteDirection(canonicalKind(kind), evidence, {
    fromId: 0,
    toId: 0,
    fromName,
    toName,
    fromAliases,
    toAliases,
    kind,
    evidence,
  }, index);
}

export function sameOrInverseKind(noteKind: string, rowKind: string): boolean {
  const note = canonicalKind(noteKind);
  const row = canonicalKind(rowKind);
  if (!note || !row) return false;
  if (note === row) return true;
  const noteHead = kindHead(note);
  const rowHead = kindHead(row);
  if (noteHead === rowHead) return true;
  return inverseKinds(note).includes(rowHead) || inverseKinds(row).includes(noteHead);
}

