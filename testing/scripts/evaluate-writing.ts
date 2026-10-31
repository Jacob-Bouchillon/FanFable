/**
 * Writing quality, measured.
 *
 * Three things went wrong repeatedly in the generated chapters, and all three
 * can be measured without a judge model:
 *
 *   length       the chapter came out far short of the target
 *   repetition   the same beat was written more than once
 *   copying      the prose reproduced the source instead of reworking it
 *
 * It also checks the two things the writer is supposed to get right: that the
 * approved outline was followed, and that the canon was used rather than
 * restated.
 *
 *   node testing/scripts/evaluate-writing.ts <db> <project>
 */
import { Db } from '../../fanfable/src/core/db.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as planner from '../../fanfable/src/plan/planner.ts';
import { createClient } from '../../fanfable/src/core/llm.ts';
import { copiedRate, inventedNameRate, repetitionRate, words } from './benchmark/measure.ts';

interface Measurement {
  chapter: number;
  words: number;
  target: number;
  /** The share of paragraph pairs that are near-duplicates. */
  repetition: number;
  /** The share of eight-word sequences the chapter shares with the source. */
  copied: number;
  /** Did the chapter mention the people the outline names? */
  followed: boolean;
  /** Did the chapter stay inside the canon it was given? */
  invented: number;
}

function measure(
  db: Db,
  projectId: number,
  chapterNumber: number,
  body: string,
  outline: planner.ChapterOutline | undefined,
): Measurement {
  const target = outline?.targetWords ?? 2500;

  // The source text, for the copying and invented-name checks.
  const source = db
    .all<{ text: string }>('SELECT text FROM canon_chunk WHERE project_id = ?', projectId)
    .map((r) => r.text)
    .join('\n');

  // The outline: were the people it names present?
  const names = outline?.characters ?? [];
  const followed = names.length === 0 || names.some((n) => body.toLowerCase().includes(n.toLowerCase()));

  return {
    chapter: chapterNumber,
    words: words(body),
    target,
    repetition: repetitionRate(body),
    copied: copiedRate(body, source),
    followed,
    invented: inventedNameRate(body, source),
  };
}

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  const projectName = process.argv[3];
  if (!dbPath || !projectName) {
    console.log('usage: node testing/scripts/evaluate-writing.ts <db> <project>');
    return;
  }
  const db = new Db(dbPath);
  const project = db.get<{ id: number; name: string }>('SELECT id, name FROM project WHERE name = ?', projectName);
  if (!project) {
    console.log(`no project "${projectName}"`);
    return;
  }
  const llm = createClient({ provider: 'ollama', model: 'qwen2.5:7b' });

  const outline = planner.approvedOutline(db, project.id);
  const chapters = controller.listChapters(db, project.id);
  const results: Measurement[] = [];

  for (const chapter of chapters) {
    const chapterOutline = outline?.chapters.find((c) => c.number === chapter.number);
    results.push(measure(db, project.id, chapter.number, chapter.body, chapterOutline));
  }

  // Optionally write a fresh chapter through the real pipeline, so the
  // effect of a prompt change can be measured against the ones already stored.
  const writeNumber = Number(process.env.EVAL_WRITE ?? 0);
  if (writeNumber) {
    const written = await controller.writeChapter(db, llm, project.id, { chapterNumber: writeNumber });
    const chapterOutline = outline?.chapters.find((c) => c.number === writeNumber);
    results.push(measure(db, project.id, writeNumber, written.chapter.body, chapterOutline));
  }

  console.log(`project: ${project.name}`);
  console.log(
    'chapter   words/target   repetition   copied   outline   invented-names',
  );
  console.log('------------------------------------------------------------');
  for (const r of results) {
    console.log(
      `${String(r.chapter).padStart(7)}   ${String(r.words).padStart(5)}/${String(r.target).padEnd(6)}` +
        `  ${(r.repetition * 100).toFixed(0).padStart(8)}%  ${(r.copied * 100).toFixed(0).padStart(6)}%` +
        `  ${(r.followed ? '  yes  ' : '  no   ')}  ${(r.invented * 100).toFixed(0).padStart(8)}%`,
    );
  }
  const avg = (f: (m: Measurement) => number) =>
    results.length ? (results.reduce((a, r) => a + f(r), 0) / results.length) * 100 : 0;
  console.log('\naverages');
  console.log(`  words as a share of target: ${avg((r) => r.words / r.target).toFixed(0)}%`);
  console.log(`  repeated paragraphs:       ${avg((r) => r.repetition).toFixed(0)}%`);
  console.log(`  copied from the source:    ${avg((r) => r.copied).toFixed(1)}%`);
  console.log(`  names not in the canon:    ${avg((r) => r.invented).toFixed(0)}%`);
  db.close();
}

void main();
