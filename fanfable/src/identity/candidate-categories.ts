/**
 * Candidate categories: a closed ontology of meanings, not a vocabulary list.
 *
 * The model decides from the definition. The examples are illustrative only;
 * no code matches them and none of them come from the book being read.
 */
export interface CandidateCategory {
  id: string;
  definition: string;
  /** One line saying what separates it from its nearest category. */
  distinction: string;
  /** Illustration only. Never matched against a surface. */
  examples: string[];
  /** Entity kind for a bare or plural surface, when the category has one. */
  plural?: string;
  /** Entity kind for a proper name or possessive surface. */
  named?: string;
}

export const CANDIDATE_CATEGORIES: readonly CandidateCategory[] = [
  {
    id: 'animal',
    definition:
      'A non-sentient living creature that occurs naturally in the world and forms no relationships: it does not speak, hold office or own anything.',
    distinction: 'Differs from sentient-nonhuman in lacking speech, office and lasting ties.',
    examples: ['rabbit', 'fox', 'dog'],
    plural: 'species',
    named: 'creature',
  },
  {
    id: 'role',
    definition:
      'A position a person holds, such as a job, rank, office or duty; it is not the person.',
    distinction: 'Differs from honorific in naming the position itself rather than a title placed before a name.',
    examples: ['captain', 'healer', 'guard'],
  },
  {
    id: 'discipline',
    definition:
      'A field of study, body of knowledge or system of practice.',
    distinction: 'Differs from role in being knowledge rather than a position; differs from item in not being an object.',
    examples: ['mathematics', 'history', 'biology'],
  },
  {
    id: 'unit',
    definition:
      'A unit of exchange or measure used to count something else.',
    distinction: 'Differs from item in measuring or exchanging rather than being a discrete object.',
    examples: ['coin', 'credit', 'mile'],
  },
  {
    id: 'calendar',
    definition:
      'A month, weekday, season or festival used to locate a time.',
    distinction: 'Differs from unit in marking time rather than measuring an amount.',
    examples: ['january', 'monday', 'festival'],
  },
  {
    id: 'honorific',
    definition:
      'A title placed before a name, such as a form of address or rank.',
    distinction: 'Differs from role in sitting before a name rather than naming the position itself.',
    examples: ['mister', 'doctor', 'captain'],
  },
  {
    id: 'collective',
    definition:
      'A family, house, order or team named together as a group.',
    distinction: 'Differs from character in naming the group rather than one person; differs from role in being people rather than a position.',
    examples: ['family', 'council', 'team'],
    plural: 'faction',
    named: 'faction',
  },
];

const BY_ID = new Map(CANDIDATE_CATEGORIES.map((category) => [category.id, category]));

export function candidateCategory(id: string): CandidateCategory | null {
  return BY_ID.get(String(id ?? '').trim().toLowerCase()) ?? null;
}

/** Prompt block: definitions and distinctions, never a list to match. */
export function candidateCategoryGuidance(): string {
  return CANDIDATE_CATEGORIES
    .map((category) => `- ${category.id}: ${category.definition} ${category.distinction}`)
    .join('\n');
}
