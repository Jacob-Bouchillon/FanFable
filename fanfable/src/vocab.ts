/**
 * Shared vocabulary.
 *
 * These sets are the single source for token filtering, relation cues, proof
 * words, and kind particles. Paths import the set they need instead of keeping
 * a private copy; adding a word here must be a deliberate cross-path change.
 * Universal words only; no book-specific content.
 */

/** Very common words that carry no search or cue signal. */
export const STOPWORDS = new Set(
  ('a an the and or but if then else of to in on at by for with from as is are was were be been being ' +
    'it its this that these those he she they them his her their we you i not no so such than too very ' +
    'can will just don should now do does did have has had into over under again more most other some ' +
    'what which who whom when where why how all any both each few own same s t d ll m o re ve y')
    .split(' '),
);

/** Graph term filtering uses the same stopword set. */
export const GRAPH_STOPWORDS = STOPWORDS;

/** Flat relation cues used by the retrieval router. */
export const RELATION_CUES: readonly string[] = [
  'sibling', 'brother', 'sister', 'parent', 'mother', 'father', 'son', 'daughter',
  'child', 'aunt', 'uncle', 'cousin', 'nephew', 'niece', 'grandfather', 'grandmother',
  'husband', 'wife', 'spouse', 'married', 'related', 'relation', 'relationship',
  'friend', 'enemy', 'ally', 'mentor', 'teacher', 'student', 'member', 'belongs',
  'leads', 'leader', 'knows', 'know', 'knew', 'works', 'serves', 'owes',
  'met', 'married', 'killed', 'gave', 'took', 'joined', 'fought', 'betrayed',
];

/** Regex relation cues used by missing-lore diagnostics. */
export const DIAGNOSTIC_RELATION_CUES: readonly { re: RegExp; kind: string }[] = [
  { re: /\b(?:his|her|their) (?:son|daughter)\b/i, kind: 'child of' },
  { re: /\b(?:son|daughter) of\b/i, kind: 'child of' },
  { re: /\b(?:brother|sister|sibling) of\b/i, kind: 'sibling of' },
  { re: /\b(?:mother|father) of\b/i, kind: 'child of' },
  { re: /\b(?:uncle|aunt) of\b/i, kind: 'relative of' },
  { re: /\b(?:cousin|nephew|niece) of\b/i, kind: 'relative of' },
  { re: /\b(?:wife|husband|spouse) of\b/i, kind: 'married to' },
  { re: /\bhead(?:master|mistress) of\b/i, kind: 'leads' },
  { re: /\bstudent of\b/i, kind: 'student of' },
  { re: /\bmember of\b/i, kind: 'member of' },
  { re: /\bworks? for\b/i, kind: 'works for' },
  { re: /\bbelongs? to\b/i, kind: 'member of' },
  { re: /\bfriend of\b/i, kind: 'friend of' },
  { re: /\benemy of\b/i, kind: 'enemy of' },
  { re: /\bmarried to\b/i, kind: 'married to' },
];

/** Words that state a relationship or role worth extracting. */
export const KINSHIP_CUES: readonly string[] = [
  'sibling', 'brother', 'sister', 'mother', 'father', 'son', 'daughter',
  'parent', 'child', 'aunt', 'uncle', 'cousin', 'nephew', 'niece',
  'husband', 'wife', 'spouse', 'married', 'widow',
  'king', 'queen', 'prince', 'princess', 'lord', 'lady',
  'master', 'servant', 'knight', 'captain', 'commander', 'heir',
];

/** Titles that do not distinguish one named person from another. */
export const PROOF_TITLES = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'professor', 'prof', 'aunt', 'uncle',
  'madam', 'sir', 'dame', 'lady', 'lord',
]);

/** Filler words ignored while checking whether a quote names an endpoint. */
export const PROOF_FILLER = new Set([
  'and', 'the', 'she', 'his', 'her', 'you', 'our', 'for', 'are', 'was', 'were',
  'has', 'have', 'had', 'that', 'this', 'with', 'from', 'they', 'them', 'its', 'our',
]);

/** Glue words never make a relation the asked relation. */
export const ANSWER_CUE_STOPWORDS = new Set(['of', 'the', 'a', 'an']);

/** Closed particle set for relation kinds; a kind's head is the role noun. */
export const KIND_PARTICLES = ['of', 'with', 'to', 'for'] as const;

/** Glue words inside a kind label that carry no meaning ("aunt of" -> "aunt"). */
export const KIND_FILLER = new Set(['of', 'to', 'with', 'for', 'a', 'the', 'an', 'in', 'on', 'as']);

/** The head noun of a kind: "aunt of" gives "aunt". Morphology, never a synonym list. */
export function kindHeadWord(kind: string): string {
  for (const word of (kind ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    if (!KIND_FILLER.has(word)) return word;
  }
  return '';
}

/** The head word and its ordinary inflections ("aunt" -> aunts, etc.). */
export function headForms(head: string): Set<string> {
  const forms = new Set([head, `${head}s`, `${head}es`, `${head}ed`, `${head}ing`, `${head}d`]);
  if (head.endsWith('e')) forms.add(`${head.slice(0, -1)}ing`);
  if (head.endsWith('y')) {
    forms.add(`${head.slice(0, -1)}ies`);
    forms.add(`${head.slice(0, -1)}ied`);
  }
  // Irregular plurals among the closed kinship concepts.
  if (head === 'child') forms.add('children');
  if (head === 'wife') forms.add('wives');
  return forms;
}

/** Verbs that describe a moment rather than a standing tie. */
export const MOMENT_WORDS = new Set(
  ('met meet gave give told tell saw see heard hear wished wish refused refuse ' +
    'offered offer asked ask asks winked winks wink annoyed annoy punished punish ' +
    'target follower follow questioned question explained explain disagreed disagree ' +
    'comforted comfort admired admire disappointed disappoint proud shook shake ' +
    'dropped drop talking talk rumored rumor signalled signaled signal watched watch ' +
    'knows knew know known observed observe seen afraid frightened feared fear fears scared ' +
    'killed kill kills killing murdered murder murders murdering assassinated assassinate assassinates assassinating')
    .split(' '),
);
