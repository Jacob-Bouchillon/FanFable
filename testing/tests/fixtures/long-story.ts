/**
 * A scripted multi-chapter alternate-universe story.
 *
 * The point of this fixture is that it is *repeatable*: the state each chapter
 * establishes is written down, so the tests can assert what the memory holds
 * without depending on what a model happens to say.
 *
 * The story:
 *
 *   Canon:      Serena takes the third lantern and crosses the bridge alone.
 *   This AU:   Kade takes it in her place, believing she asked him to.
 *
 * It carries the things a long story has to get right:
 *
 *   - a significant divergence, and its consequences
 *   - three characters who know different subsets of the truth
 *   - a secret revealed in the middle, which changes a relationship
 *   - a plot thread opened in chapter 1 and closed in chapter 5
 *   - a flashback in chapter 4 that happens before chapter 1
 *   - a motivation recorded in chapter 1 that chapter 3 depends on
 */
import type { StateExtraction } from '../../../fanfable/src/memory.ts';

export interface StoryChapter {
  number: number;
  title: string;
  /** What the author wrote, for the reader. */
  body: string;
  /** What the chapter establishes, as the memory manager would extract it. */
  extraction: StateExtraction;
  /** The canon event this chapter diverges from, if any. */
  canonEvent?: { title: string; summary: string; change: 'altered' | 'prevented' | 'reversed' | 'omitted'; note: string };
}

const EXTRACTION = (chapter: StoryChapter): StateExtraction => ({
  summary: chapter.extraction?.summary ?? '',
  events: [],
  characters: [],
  states: [],
  knowledge: [],
  relationships: [],
  threads: [],
  facts: [],
  canonChanges: [],
});

export const STORY: StoryChapter[] = [
  {
    number: 1,
    title: 'The Third Lantern',
    body:
      'Kade took the third lantern from the tower before dawn, because Serena asked him to.\n' +
      'She had not asked him. She had stood on the ridge and watched the rain and decided that ' +
      'the village had been lying about that night for eleven years, and that it should stop.\n' +
      'She said nothing. She let him take the light, and she let him believe she had sent him.\n' +
      'When the bell rang the third time, she did not count the lights.',
    canonEvent: {
      title: 'Serena takes the third lantern',
      summary: 'In the source, Serena takes the third lantern and crosses the bridge herself.',
      change: 'altered',
      note: 'Kade takes the lantern in her place, believing she asked him to.',
    },
    extraction: {
      summary:
        'Kade takes the third lantern across the bridge in Serena\'s place, believing she asked him to. ' +
        'Serena stays on the ridge and lets him believe it.',
      events: [
        {
          id: 0,
          chapterId: null,
          chapterNumber: null,
          title: 'Kade takes the third lantern',
          summary: 'He crosses before dawn with the lantern she was meant to carry.',
          storyTime: 'day three, before dawn',
          storyOrder: 10,
          participants: ['Kade', 'Serena Marsh'],
          location: 'the ridge',
          kind: 'event',
          adaptsCanonEventId: null,
          divergenceNote: 'In canon Serena takes the lantern herself.',
        },
      ],
      characters: [
        { name: 'Serena Marsh', aliases: ['Serena'], profile: 'who stays behind' },
        { name: 'Kade', aliases: [], profile: 'who crosses in her place' },
      ],
      states: [
        { character: 'Serena Marsh', location: 'the ridge', condition: 'soaked', emotional: 'resolved' },
        { character: 'Kade', location: 'the bridge at Ardenne', condition: 'wet', emotional: 'foolish' },
      ],
      knowledge: [
        { character: 'Serena Marsh', fact: 'Kade took the third lantern in her place', certainty: 'knows' },
        { character: 'Kade', fact: 'Serena asked him to take the third lantern', certainty: 'believes' },
      ],
      relationships: [{ a: 'Serena Marsh', b: 'Kade', kind: 'companions', description: 'unspoken understanding' }],
      threads: [{ title: 'The third lantern', description: 'why Serena let Kade take it', status: 'open' }],
      facts: [{ kind: 'decision', subject: 'Serena Marsh', content: 'She let Kade take the lantern without correcting him' }],
      canonChanges: [],
      motivations: [
        {
          character: 'Serena Marsh',
          kind: 'motive',
          statement: 'She wants the village to stop lying about the night her brother died.',
        },
      ],
      secrets: [
        {
          title: 'the third lantern',
          statement: 'Serena never asked Kade to take the lantern',
          knownBy: ['Serena Marsh'],
        },
      ],
      links: [],
      threadEvents: [{ thread: 'The third lantern', event: 'Kade takes the third lantern', kind: 'introduced' }],
    },
  },
  {
    number: 2,
    title: 'The Empty Cloak',
    body:
      'Ilsa Marrow saw the cloak on the far bank with nobody inside it, and she wrote the fact ' +
      'in the ledger under the third promise, because that is where the Corwins of this village ' +
      'keep the things that must not be said aloud.\n' +
      'She did not know why the cloak was empty. She knew only that it was.',
    canonEvent: {
      title: 'Serena crosses the bridge',
      summary: 'In the source, Serena crosses wearing her cloak.',
      change: 'altered',
      note: 'The cloak crosses empty; Serena does not.',
    },
    extraction: {
      summary:
        'Ilsa sees the cloak cross empty and records it in the ledger. She knows the cloak was empty, ' +
        'but not why.',
      events: [
        {
          id: 0,
          chapterId: null,
          chapterNumber: null,
          title: 'The cloak crosses empty',
          summary: 'Ilsa watches an empty cloak arrive on the far bank.',
          storyTime: 'day three, dawn',
          storyOrder: 11,
          participants: ['Ilsa Marrow', 'Kade'],
          location: 'the far bank',
          kind: 'event',
          adaptsCanonEventId: null,
          divergenceNote: 'Serena is not on the bridge.',
        },
      ],
      characters: [{ name: 'Ilsa Marrow', aliases: ['Ilsa'], profile: 'who keeps the ledger' }],
      states: [{ character: 'Ilsa Marrow', location: 'the far bank', condition: 'unsettled', emotional: 'troubled' }],
      knowledge: [
        { character: 'Ilsa Marrow', fact: 'the cloak crossed the bridge empty', certainty: 'knows' },
        { character: 'Ilsa Marrow', fact: 'the third lantern was not carried by Serena', certainty: 'suspects' },
      ],
      relationships: [],
      threads: [],
      facts: [{ kind: 'fact', subject: 'Ilsa Marrow', content: 'The cloak arrived on the far bank with nobody in it' }],
      canonChanges: [],
      motivations: [],
      secrets: [],
      links: [{ from: 'Kade takes the third lantern', to: 'The cloak crosses empty', kind: 'cause', description: 'his crossing left the cloak empty' }],
      threadEvents: [],
    },
  },
  {
    number: 3,
    title: 'What Kade Was Told',
    body:
      'Serena told him on the ridge, in the rain, that she had never asked him to take anything.\n' +
      'She had wanted the village to stop lying, and she had let him cross with the light so that ' +
      'the lie would be his and not hers, and now he knew it.\n' +
      'He did not shout. That was the worst of it. He looked at her for a long time and then he ' +
      'walked down towards the water, and he did not look back.',
    extraction: {
      summary:
        'Serena admits she never asked Kade to take the lantern. He learns he was used, and the ' +
        'companionship between them ends.',
      events: [
        {
          id: 0,
          chapterId: null,
          chapterNumber: null,
          title: 'Serena tells the truth',
          summary: 'She admits she never asked him to take the lantern.',
          storyTime: 'day three, afternoon',
          storyOrder: 12,
          participants: ['Serena Marsh', 'Kade'],
          location: 'the ridge',
          kind: 'event',
          adaptsCanonEventId: null,
          divergenceNote: '',
        },
      ],
      characters: [],
      states: [{ character: 'Kade', location: 'the water', condition: 'untouched', emotional: 'hurt' }],
      knowledge: [
        { character: 'Kade', fact: 'Serena never asked him to take the third lantern', certainty: 'knows' },
        { character: 'Kade', fact: 'Serena let him take it so the lie would be his', certainty: 'knows' },
        { character: 'Ilsa Marrow', fact: 'the third lantern was not carried by Serena', certainty: 'knows' },
      ],
      relationships: [{ a: 'Serena Marsh', b: 'Kade', kind: 'estranged', description: 'he knows she used him' }],
      threads: [],
      facts: [{ kind: 'decision', subject: 'Serena Marsh', content: 'She told Kade the truth and ended their friendship' }],
      canonChanges: [],
      motivations: [],
      secrets: [
        {
          title: 'the third lantern',
          statement: 'Serena never asked Kade to take the lantern',
          knownBy: ['Serena Marsh', 'Kade'],
        },
      ],
      links: [],
      threadEvents: [],
    },
  },
  {
    number: 4,
    title: 'The Night Before (flashback)',
    body:
      'Eleven years earlier, the same ridge, the same rain.\n' +
      'A boy of eleven had stood where she stood, and had been given a pocket full of nothing, ' +
      'and had been told that the people who should have come for him were frightened, and that ' +
      'the safest place for him was a cupboard under the stairs of people who did not want him.\n' +
      'She had not forgotten it. That was the whole of it, really: eleven years of a cupboard, and ' +
      'a village that had agreed to say nothing, and a brother under the bridge.',
    extraction: {
      summary:
        'A flashback to eleven years earlier: the night the Corwins were given Asha, and the reason ' +
        'Serena has never forgiven the village for it.',
      events: [
        {
          id: 0,
          chapterId: null,
          chapterNumber: null,
          title: 'The boy under the stairs',
          summary: 'Eleven years earlier, Asha is left with the Corwins, and nobody comes for him.',
          storyTime: 'eleven years earlier',
          storyOrder: 1,
          participants: ['Serena Marsh'],
          location: 'Number 4, Larkspur Lane',
          kind: 'flashback',
          adaptsCanonEventId: null,
          divergenceNote: '',
        },
      ],
      characters: [],
      states: [],
      knowledge: [{ character: 'Serena Marsh', fact: 'the village agreed to say nothing about Asha', certainty: 'knows' }],
      relationships: [],
      threads: [],
      facts: [],
      canonChanges: [],
      motivations: [
        {
          character: 'Serena Marsh',
          kind: 'wound',
          statement: 'She was a child when the village decided Asha was not worth fetching.',
        },
      ],
      secrets: [],
      links: [],
      threadEvents: [],
    },
  },
  {
    number: 5,
    title: 'The Ledger',
    body:
      'Ilsa Marrow crossed out the third promise and wrote a fourth, which was that the lantern ' +
      'had been carried by Kade, at Serena\'s word, and that the village would say so now, ' +
      'because there were three of them and one of the third promise, and she had been keeping ' +
      'it in a ledger for eleven years and she was finished keeping it.\n' +
      'Serena read it twice. The rain had stopped. The bell did not ring.',
    extraction: {
      summary:
        'Ilsa closes the third promise and records the truth in the ledger: Kade carried the lantern, ' +
        'at Serena\'s word. The thread is closed.',
      events: [
        {
          id: 0,
          chapterId: null,
          chapterNumber: null,
          title: 'The ledger is closed',
          summary: 'The truth is written down and the thread ends.',
          storyTime: 'day four, morning',
          storyOrder: 13,
          participants: ['Ilsa Marrow', 'Serena Marsh'],
          location: 'the wardens room',
          kind: 'event',
          adaptsCanonEventId: null,
          divergenceNote: '',
        },
      ],
      characters: [],
      states: [{ character: 'Serena Marsh', location: 'the wardens room', condition: 'dry', emotional: 'quiet' }],
      knowledge: [{ character: 'Serena Marsh', fact: 'the village will record the truth in the ledger', certainty: 'knows' }],
      relationships: [{ a: 'Serena Marsh', b: 'Ilsa Marrow', kind: 'allies', description: 'the ledger is on her side' }],
      threads: [{ title: 'The third lantern', description: 'why Serena let Kade take it', status: 'resolved' }],
      facts: [{ kind: 'decision', subject: 'Ilsa Marrow', content: 'The truth about the lantern is written in the ledger' }],
      canonChanges: [],
      motivations: [],
      secrets: [],
      links: [],
      threadEvents: [{ thread: 'The third lantern', event: 'The ledger is closed', kind: 'resolved' }],
    },
  },
];

export { EXTRACTION };
