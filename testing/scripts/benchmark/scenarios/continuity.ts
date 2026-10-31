/**
 * Continuity scenario.
 *
 * A story state is set up by hand, a chapter is written with contradictions
 * planted in it, and the checker is run over it. The planted contradictions
 * are known, so detection can be counted exactly rather than guessed at.
 *
 * Every planted contradiction has a category from the checker's own
 * vocabulary and a sentence that carries the evidence, so a finding is
 * matched to a planted item by category and by word overlap. A finding that
 * matches nothing planted is a false positive, and is counted as one.
 */
import { Db } from '../../../../fanfable/src/core/db.ts';
import * as continuity from '../../../../fanfable/src/product/continuity.ts';
import * as graph from '../../../../fanfable/src/support/graph.ts';
import * as memory from '../../../../fanfable/src/product/memory.ts';
import type { RecordingClient } from '../harness.ts';

export interface Planted {
  id: string;
  category: string;
  /** The sentence that carries the contradiction. */
  sentence: string;
  note: string;
}

/** The contradictions planted in the probe chapter. */
export const PLANTED: Planted[] = [
  {
    id: 'knowledge-before-learning',
    category: 'knowledge',
    sentence:
      'Ron asked Harry what the Sorting Hat had whispered to him in the Great Hall, and Harry told him the exact words, though he had told nobody and had not understood them himself.',
    note: 'Harry uses the Hat\'s words before he has understood them, and gives them away before he learns what they mean.',
  },
  {
    id: 'canon-mix-gryffindor',
    category: 'canon-mix',
    sentence:
      'The Sorting Hat had placed Harry in Gryffindor, and the Gryffindor table had cheered until the rafters shook.',
    note: 'In this story Harry is in Slytherin. The canon event is reported unchanged.',
  },
  {
    id: 'location-snape',
    category: 'location',
    sentence:
      'Down in the Slytherin common room, Professor Snape stood by the fireplace with his arms folded, watching the firelight move on the green ceiling.',
    note: 'Snape is recorded in his own study; he is not in the Slytherin common room.',
  },
  {
    id: 'relationship-ron',
    category: 'relationship',
    sentence:
      'Ron told Harry they were still best friends, and Harry said nothing to argue, though the two of them had not spoken since the Sorting.',
    note: 'The story state records them as estranged with no cause recorded.',
  },
  {
    id: 'injury-arm',
    category: 'injury',
    sentence:
      'Harry pushed open the door with his right arm, untroubled, as though the fall down the stone stairs at the hut had never happened at all.',
    note: 'The story state records a broken arm from the hut.',
  },
  {
    id: 'repetition-train',
    category: 'repetition',
    sentence:
      'The Hogwarts Express left Platform Nine and Three-Quarters at noon, and the boy with the scar found the compartment with the two boys and the girl who read.',
    note: 'This repeats the prologue, which the story has already done.',
  },
  {
    id: 'outline-deviation',
    category: 'outline-deviation',
    sentence:
      'Draco Malfoy said the words aloud at the Slytherin table, so that the whole house heard the Hat\'s warning, exactly as the plan had said the scene must not happen.',
    note: 'The plan says the Hat\'s words are not repeated in public. The chapter has them repeated.',
  },
];

const CHAPTER_BODY = `CHAPTER ONE

The Great Hall had never looked so large, and Harry had never felt so small in it. Four long tables ran the length of the room, and the candles on the high table had not been lit yet, so that the enchanted sky above showed a night full of drifting cloud and no stars at all.

"Welcome," said Albus Dumbledore, and the hall went quiet in the way a crowd goes quiet when it has been told to.

Harry sat with the first years at the end of the table nearest the doors, between a girl with bushy hair who had already told him twice that the name was Hermione, not Hermone, and a red-haired boy who had told him that his name was Ron Weasley and that his family was mostly ginger. Beyond them, Neville Longbottom was crying quietly into his hands.

The Sorting Hat was old, and patched, and looked as though it had been mended too many times to be mended well. When it was placed on Harry's head, it spoke, and the hall laughed.

${PLANTED[0].sentence}

${PLANTED[1].sentence}

He sat down among a table of green and silver, and the faces around it were polite in the way that a room is polite when it has decided to be careful with you.

${PLANTED[2].sentence}

${PLANTED[3].sentence}

After the feast, Harry walked up the marble steps to the common room, thinking about his father, who had never told him anything about any of this.

${PLANTED[4].sentence}

${PLANTED[5].sentence}

${PLANTED[6].sentence}

He went to his bed without saying goodnight to anybody. The lake pressed against the glass, black and very far down, and somewhere in the school a door closed that he had not opened.

`;

/** The story state the checker is given: what the story already knows. */
export interface ContinuityState {
  projectId: number;
  chapterId: number;
  body: string;
  outlineText: string;
  memoryText: string;
  canonText: string;
  connectedText: string;
  /** The changes the story has recorded against canon. */
  canonChangeText: string;
}

/**
 * Build a project with a fixed story state and a chapter with the
 * contradictions planted in it.
 */
export function buildContinuityProject(db: Db, projectName = 'bench-continuity'): ContinuityState {
  // A fresh project each time, so nothing carries over between models.
  db.run('DELETE FROM canon_relation WHERE project_id IN (SELECT id FROM project WHERE name = ?)', projectName);
  db.run('DELETE FROM canon_fact WHERE project_id IN (SELECT id FROM project WHERE name = ?)', projectName);
  db.run('DELETE FROM canon_timeline WHERE project_id IN (SELECT id FROM project WHERE name = ?)', projectName);
  db.run('DELETE FROM canon_entity WHERE project_id IN (SELECT id FROM project WHERE name = ?)', projectName);
  db.run('DELETE FROM character WHERE project_id IN (SELECT id FROM project WHERE name = ?)', projectName);
  db.run('DELETE FROM character_knowledge WHERE project_id IN (SELECT id FROM project WHERE name = ?)', projectName);
  db.run('DELETE FROM relationship WHERE project_id IN (SELECT id FROM project WHERE name = ?)', projectName);
  db.run('DELETE FROM au_event WHERE project_id IN (SELECT id FROM project WHERE name = ?)', projectName);
  db.run('DELETE FROM plot_thread WHERE project_id IN (SELECT id FROM project WHERE name = ?)', projectName);
  db.run('DELETE FROM chapter WHERE project_id IN (SELECT id FROM project WHERE name = ?)', projectName);
  db.run('DELETE FROM project WHERE name = ?', projectName);

  const project = { id: 0 };
  db.run(
    "INSERT INTO project (id, name, created_at, updated_at) VALUES ((SELECT COALESCE(MAX(id),0)+1 FROM project), ?, datetime('now'), datetime('now'))",
    projectName,
  );
  project.id = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName)!.id;
  const pid = project.id;

  // The canon event the story diverges from: the Sorting.
  const event = db.run(
    `INSERT INTO canon_event (project_id, title, summary, locator, participants, location, time_label, kind, quote, created_at)
      VALUES (?, 'The Sorting Ceremony', 'The Sorting Hat places Harry Potter in Gryffindor.', 'CHAPTER SIX', '["Harry Potter"]', 'the Great Hall', 'the first night', 'event', 'The Sorting Hat placed Harry in Gryffindor.', datetime('now'))`,
    pid,
  ).lastInsertRowid;

  const harry = memory.upsertCharacter(db, pid, 'Harry Potter');
  const ron = memory.upsertCharacter(db, pid, 'Ron Weasley');
  memory.upsertCharacter(db, pid, 'Hermione Granger');
  const snape = memory.upsertCharacter(db, pid, 'Severus Snape');

  // What Harry knows: the Hat hesitated. What he does not know is what it said.
  const auEvent = db.run(
    `INSERT INTO au_event (project_id, seq, title, summary, story_time, story_order, participants, location, kind, divergence_note, created_at)
     VALUES (?, 1, 'Harry is sorted into Slytherin', 'The hat hesitates and places Harry in Slytherin.', 'the first night', 1, '["Harry Potter"]', 'the Great Hall', 'event', 'The canon Sorting put Harry in Gryffindor; here the hat hesitates and chooses Slytherin.', datetime('now'))`,
    pid,
  ).lastInsertRowid;
  db.run('UPDATE au_event SET adapts_canon_event_id = ? WHERE id = ?', event, auEvent);
  db.run(
    `INSERT INTO canon_change (project_id, au_event_id, canon_event_id, change_type, description, confirmed, created_at)
      VALUES (?, ?, ?, 'altered', 'The Sorting Hat places Harry in Slytherin instead of Gryffindor.', 1, datetime('now'))`,
    pid,
    auEvent,
    event,
  );

  // Ron does not know what the Hat said; he only knows Harry was in Slytherin.
  memory.addKnowledge(db, pid, {
    characterId: harry,
    fact: 'the Sorting Hat hesitated over him before choosing Slytherin',
    certainty: 'knows',
    source: 'au',
    auEventId: auEvent,
    chapterId: null,
  });
  memory.addKnowledge(db, pid, {
    characterId: ron,
    fact: 'Harry was sorted into Slytherin',
    certainty: 'knows',
    source: 'au',
    auEventId: auEvent,
    chapterId: null,
  });

  // A relationship that changed with nothing recorded to explain it.
  db.run(
    `INSERT INTO relationship (project_id, character_a, character_b, kind, description, sentiment, source, chapter_id, closed, updated_at)
     VALUES (?, ?, ?, 'estranged', 'they have not spoken since the Sorting', 'cold', 'au', NULL, 0, datetime('now'))`,
    pid,
    harry,
    ron,
  );

  // Harry's arm, broken at the hut.
  memory.addCharacterState(db, pid, harry, {
    location: 'the Great Hall',
    condition: 'broken right arm, from the fall down the stone stairs at the hut',
    emotional: 'numb',
    asOfEventId: auEvent,
    source: 'au',
    chapterId: null,
  });

  // Snape, in his own study.
  memory.addCharacterState(db, pid, snape, {
    location: 'his study on the first floor',
    condition: 'unremarkable',
    emotional: 'cold',
    asOfEventId: auEvent,
    source: 'au',
    chapterId: null,
  });

  // The prologue, already done: the train.
  const prologue = db.run(
    `INSERT INTO chapter (project_id, number, title, status, body, created_at, updated_at)
     VALUES (?, 0, 'The Train', 'approved', ?, datetime('now'), datetime('now'))`,
    pid,
    'The Hogwarts Express left Platform Nine and Three-Quarters at noon, and the boy with the scar found the compartment with the two boys and the girl who read.',
  ).lastInsertRowid;

  const chapter = db.run(
    `INSERT INTO chapter (project_id, number, title, status, body, created_at, updated_at)
     VALUES (?, 1, 'The Sorting Hat', 'draft', ?, datetime('now'), datetime('now'))`,
    pid,
    CHAPTER_BODY,
  ).lastInsertRowid;

  const slice = memory.buildContextSlice(db, pid, {});
  const outlineText = JSON.stringify(
    {
      number: 1,
      title: 'The Sorting Hat',
      goal: 'The Sorting Ceremony, and the moment the Hat hesitates over Harry and places him in Slytherin.',
      au: ['The Hat\'s words are given to Harry alone and are not repeated in public.'],
    },
    null,
    2,
  );
  const canonText =
    'CANON EVENT: The Sorting Ceremony — the Sorting Hat places Harry Potter in Gryffindor. ' +
    'The four houses are Gryffindor, Hufflepuff, Ravenclaw and Slytherin, and Slytherin has a reputation for producing dark wizards.';

  return {
    projectId: pid,
    chapterId: chapter,
    body: CHAPTER_BODY,
    outlineText,
    memoryText: memory.renderContextSlice(slice),
    canonText,
    connectedText: graph.buildGraphContext(db, pid, { query: 'Harry Potter Sorting Hat Slytherin', focus: ['Harry Potter', 'Severus Snape'], hops: 1, maxWords: 400 }).text,
    canonChangeText:
      'The Sorting Hat places Harry in Slytherin instead of Gryffindor. The canon Sorting is otherwise unchanged.',
  };
}

export interface ContinuityResult {
  planted: number;
  /** Planted items the model's own checks found. */
  detected: number;
  detectedIds: string[];
  missedIds: string[];
  /** Findings by the model that match no planted item. */
  falsePositives: number;
  falsePositiveList: string[];
  /** What the deterministic and graph checks find, which no model is involved in. */
  deterministicDetected: number;
  /** What the model and the deterministic checks find together. */
  combinedDetected: number;
  /** The share of the model's findings that were not planted. */
  falsePositiveRate: number;
  notes: number;
  errors: number;
  warnings: number;
  ms: number;
  promptTokens: number;
  completionTokens: number;
}

/** Content words, for matching a finding to a planted item. */
function words(text: string): string[] {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 4);
}

/**
 * Does this finding correspond to this planted contradiction?
 *
 * The category has to match, and the finding's evidence or message has to
 * share enough of the planted sentence's words. Requiring the category as
 * well as the words keeps a vague finding from being counted as a detection.
 */
export function matchesPlanted(issue: continuity.ContinuityIssue, planted: Planted): boolean {
  if (issue.category !== planted.category) return false;
  const haystack = `${issue.evidence} ${issue.message} ${issue.suggestion}`.toLowerCase();
  const needle = words(planted.sentence);
  const distinctive = needle.filter((w) => !['there', 'which', 'their', 'would', 'about'].includes(w));
  const hits = distinctive.filter((w) => haystack.includes(w)).length;
  return hits >= Math.max(2, Math.floor(distinctive.length * 0.25));
}

export async function runContinuity(
  db: Db,
  client: RecordingClient,
  state: ContinuityState,
): Promise<{ result: ContinuityResult; issues: continuity.ContinuityIssue[] }> {
  const chapter = db.get<{ id: number; number: number; title: string; body: string; status: string; summary: string }>(
    'SELECT id, number, title, body, status, summary FROM chapter WHERE id = ?',
    state.chapterId,
  )!;
  const slice = memory.buildContextSlice(db, state.projectId, {});

  const started = Date.now();
  // The deterministic and graph checks first: they are the same for every
  // model, and the model's own contribution has to be visible on its own.
  const deterministicIssues = await continuity.checkChapter(db, state.projectId, chapter, slice, {
    useModel: false,
    outlineText: state.outlineText,
    memoryText: state.memoryText,
    canonText: state.canonText,
    connectedText: state.connectedText,
  });
  const modelIssues = await continuity.modelChecks(client, {
    chapter,
    outlineText: state.outlineText,
    memoryText: state.memoryText,
    canonText: state.canonText,
    connectedText: state.connectedText,
    canonChangeText: state.canonChangeText,
  });
  const issues = continuity.mergeIssues(deterministicIssues, modelIssues);
  const ms = Date.now() - started;

  const score = (list: continuity.ContinuityIssue[]) => {
    const detectedIds: string[] = [];
    const used = new Set<number>();
    for (const planted of PLANTED) {
      const idx = list.findIndex((issue, i) => !used.has(i) && matchesPlanted(issue, planted));
      if (idx >= 0) {
        used.add(idx);
        detectedIds.push(planted.id);
      }
    }
    const falsePositives = list.filter((_, i) => !used.has(i));
    return { detectedIds, falsePositives };
  };

  const model = score(modelIssues);
  const det = score(deterministicIssues);
  const combined = score(issues);

  return {
    result: {
      planted: PLANTED.length,
      detected: model.detectedIds.length,
      detectedIds: model.detectedIds,
      missedIds: PLANTED.filter((p) => !model.detectedIds.includes(p.id)).map((p) => p.id),
      falsePositives: model.falsePositives.length,
      falsePositiveList: model.falsePositives.map((i) => `[${i.category}] ${i.message}`).slice(0, 6),
      deterministicDetected: det.detectedIds.length,
      combinedDetected: combined.detectedIds.length,
      falsePositiveRate: modelIssues.length ? model.falsePositives.length / modelIssues.length : 0,
      notes: modelIssues.filter((i) => i.severity === 'note').length,
      errors: modelIssues.filter((i) => i.severity === 'error').length,
      warnings: modelIssues.filter((i) => i.severity === 'warning').length,
      ms,
      promptTokens: client.promptTokens,
      completionTokens: client.completionTokens,
    },
    issues,
  };
}
