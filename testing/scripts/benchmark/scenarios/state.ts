/**
 * State extraction scenario.
 *
 * The long-story test showed that the models differ most in what they record
 * about a chapter they have just written, and not in the chapter itself. A
 * writer whose context is the story memory is only as good as the memory, so
 * this measures the memory directly.
 *
 * One fixed chapter, written once, read by every model. The state that
 * chapter establishes is written by hand, and the extraction is scored
 * against it.
 */
import { Db } from '../../../../fanfable/src/core/db.ts';
import * as memory from '../../../../fanfable/src/product/memory.ts';
import type { RecordingClient } from '../harness.ts';

/** What the chapter establishes, written by hand. */
export const GOLD_STATE = {
  events: [
    { keywords: ['wakes', 'privet drive', 'dursleys'], label: 'Harry wakes at the Dursleys house' },
    { keywords: ['cage', 'broken wand', 'bedroom'], label: 'Harry finds an open cage and a broken wand' },
    { keywords: ['green eyes', 'window', 'figure'], label: 'Harry sees a figure with bright green eyes' },
    { keywords: ['hagrid', 'bag', 'dumbledore'], label: 'Hagrid brings Harry his things, from Dumbledore' },
    { keywords: ['station', 'ron', 'hermione'], label: 'Harry finds Ron and Hermione at the station' },
    { keywords: ['neville', 'joins', 'station'], label: 'Neville joins them at the station' },
    { keywords: ['wand', 'broke', 'floorboard'], label: 'Neville says he broke the wand' },
    { keywords: ['train', 'express', 'compartment'], label: 'They board the Hogwarts Express' },
    { keywords: ['bridge', 'lake', 'castle'], label: 'They cross the bridge over the black lake' },
  ],
  knowledge: [
    { character: 'Harry Potter', keywords: ['dumbledore', 'bag', 'blessing'], label: 'Harry knows Dumbledore sent the bag' },
    { character: 'Harry Potter', keywords: ['green eyes', 'figure', 'window'], label: 'Harry knows about the figure with the green eyes' },
    { character: 'Ron Weasley', keywords: ['station', 'holiday', 'train'], label: 'Ron knows he is going with Harry' },
  ],
  threads: [
    { keywords: ['wand', 'broken'], label: 'The broken wand' },
    { keywords: ['green eyes', 'figure', 'reflection'], label: 'The man with the green eyes' },
  ],
};

const STOP = new Set([
  'the', 'and', 'that', 'with', 'from', 'they', 'have', 'been', 'were', 'his', 'her', 'him', 'she',
  'its', 'their', 'into', 'than', 'then', 'when', 'what', 'will', 'would', 'could', 'should',
  'about', 'which', 'there', 'here', 'this', 'these', 'those', 'said', 'says', 'say', 'after',
  'before', 'because', 'while', 'where', 'every', 'never', 'always', 'under', 'over', 'through',
  'himself', 'herself', 'themselves', 'toward', 'towards', 'along', 'around', 'across',
]);

function words(text: string): string[] {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
}

/** How many of the gold's distinctive words appear in the text. */
function overlap(goldKeywords: string[], text: string): number {
  const lower = (text ?? '').toLowerCase();
  return goldKeywords.filter((k) => lower.includes(k.toLowerCase())).length;
}

export interface StateResult {
  events: number;
  eventsFound: number;
  knowledge: number;
  knowledgeFound: number;
  threads: number;
  threadsFound: number;
  /** Records the model recorded that match nothing in the gold. */
  unmatched: number;
  totalRecorded: number;
  summaryWords: number;
  ms: number;
  promptTokens: number;
  completionTokens: number;
}

export async function runStateExtraction(
  db: Db,
  client: RecordingClient,
  projectId: number,
  chapterNumber: number,
): Promise<{ result: StateResult; extraction: memory.StateExtraction }> {
  const chapter = db.get<{ id: number; number: number; title: string; body: string }>(
    'SELECT id, number, title, body FROM chapter WHERE project_id = ? AND number = ?',
    projectId,
    chapterNumber,
  );
  if (!chapter) throw new Error(`no chapter ${chapterNumber} in the project`);

  const canonEvents = db.all<{ id: number; title: string; summary: string }>(
    'SELECT id, title, summary FROM canon_event WHERE project_id = ? ORDER BY id DESC LIMIT 60',
    projectId,
  );

  const started = Date.now();
  const extraction = await memory.extractState(client, chapter.body, { canonEvents });
  const ms = Date.now() - started;

  const eventText = extraction.events.map((e) => `${e.title} ${e.summary}`).join(' | ');
  const knowledgeText = extraction.knowledge.map((k) => `${k.character} ${k.fact}`).join(' | ');
  const threadText = extraction.threads.map((t) => `${t.title} ${t.description}`).join(' | ');

  const matchedEvents = new Set<number>();
  for (const gold of GOLD_STATE.events) {
    extraction.events.forEach((e, i) => {
      if (matchedEvents.has(i)) return;
      if (overlap(gold.keywords, `${e.title} ${e.summary}`) >= 2) matchedEvents.add(i);
    });
  }
  const matchedKnowledge = new Set<number>();
  for (const gold of GOLD_STATE.knowledge) {
    extraction.knowledge.forEach((k, i) => {
      if (matchedKnowledge.has(i)) return;
      const sameCharacter = k.character.toLowerCase().includes(gold.character.split(' ')[0].toLowerCase());
      if (sameCharacter && overlap(gold.keywords, k.fact) >= 2) matchedKnowledge.add(i);
    });
  }
  const matchedThreads = new Set<number>();
  for (const gold of GOLD_STATE.threads) {
    extraction.threads.forEach((t, i) => {
      if (matchedThreads.has(i)) return;
      if (overlap(gold.keywords, `${t.title} ${t.description}`) >= 1) matchedThreads.add(i);
    });
  }

  const totalRecorded = extraction.events.length + extraction.knowledge.length + extraction.threads.length;
  const unmatched =
    extraction.events.length - matchedEvents.size +
    (extraction.knowledge.length - matchedKnowledge.size) +
    (extraction.threads.length - matchedThreads.size);

  return {
    result: {
      events: GOLD_STATE.events.length,
      eventsFound: matchedEvents.size,
      knowledge: GOLD_STATE.knowledge.length,
      knowledgeFound: matchedKnowledge.size,
      threads: GOLD_STATE.threads.length,
      threadsFound: matchedThreads.size,
      unmatched,
      totalRecorded,
      summaryWords: words(extraction.summary).length,
      ms,
      promptTokens: client.promptTokens,
      completionTokens: client.completionTokens,
    },
    extraction,
  };
}
