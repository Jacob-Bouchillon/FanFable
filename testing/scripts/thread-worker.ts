/**
 * Thread worker runner.
 *
 * Dry-run by default. --model asks the project's LlmClient for notes; --write
 * applies them. Nothing is written unless both the model and --write are given.
 */
import { Db } from '../../fanfable/src/core/db.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import {
  applyWorkerNotes,
  parseWorkerAnswer,
  planThreadWork,
  retrieveEvidence,
  validateWorkerNote,
  WORKER_NOTE_KINDS,
  type RetrievedPassage,
  type ThreadWorkItem,
  type WorkerNote,
} from '../../fanfable/src/web/thread-worker.ts';

const SYSTEM_PROMPT = `Answer only from the passages. Quote verbatim. Do not use outside knowledge.
Answer JSON only: {"notes":[{"quote":"...","claim":"...","kind":"observation"|"context","strength":0.0}]}`;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dbPath = flag('db') ?? process.argv[2];
const projectName = flag('project') ?? process.argv[3] ?? 'hp1';
const limitRaw = flag('limit');
const limit = limitRaw === undefined ? 20 : Math.max(1, Math.floor(Number(limitRaw)));
const maxAgeRaw = flag('max-age-days');
const parsedMaxAge = maxAgeRaw === undefined ? 0 : Number(maxAgeRaw);
const maxAgeDays = Number.isFinite(parsedMaxAge) ? Math.max(0, parsedMaxAge) : 0;
const model = flag('model');
const write = process.argv.includes('--write');
if (!dbPath) {
  console.error('usage: node --no-warnings testing/scripts/thread-worker.ts --db <path> --project <name> [--limit 20] [--max-age-days 0] [--model <model>] [--write]');
  process.exit(2);
}

function promptFor(item: ThreadWorkItem, passages: RetrievedPassage[]): string {
  const lines = [
    `Thread: ${item.label}`,
    `Kind: ${item.kind}`,
    item.openEnds.length
      ? `Open questions:\n${item.openEnds.map((open) => `- ${open.question} (would resolve: ${open.wouldResolve})`).join('\n')}`
      : 'Open questions: none',
    'Passages:',
    passages.length
      ? passages.map((passage, index) => `[${index + 1}] ${passage.locator}: ${passage.text}`).join('\n\n')
      : '(no passages found)',
  ];
  return lines.join('\n\n');
}

const db = new Db(dbPath);
try {
  const project = controller.getProjectByName(db, projectName);
  if (!project) {
    console.error(`no project named "${projectName}" in ${dbPath}`);
    db.close();
    process.exit(1);
  }

  const items = planThreadWork(db, project.id, limit, { olderThanDays: maxAgeDays });
  const client = model
    ? controller.createClient({ ...project.settings, model } as never)
    : null;
  const results: Array<{
    threadId: number;
    kind: string;
    label: string;
    noteCount: number;
    openEnds: ThreadWorkItem['openEnds'];
    passages: RetrievedPassage[];
    modelText?: string;
    notes: WorkerNote[];
    counts?: { added: number; duplicates: number; rejected: number; openEndsClosed: number };
  }> = [];

  for (const item of items) {
    const passages = retrieveEvidence(db, project.id, item, 6);
    let modelText: string | undefined;
    let notes: WorkerNote[] = [];
    if (client) {
      const response = await client.chat({
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: promptFor(item, passages) }],
        temperature: 0,
        maxTokens: 600,
        format: 'json',
      });
      modelText = response.text;
      notes = parseWorkerAnswer(response.text);
    }

    const pairs = notes.map((note) => {
      const chosen = passages.find((passage) => validateWorkerNote(note, passage, WORKER_NOTE_KINDS).ok);
      return {
        note,
        passage: chosen ?? passages[0] ?? {
          chunkId: 0,
          locator: '',
          seq: -1,
          text: '',
        },
      };
    });
    const counts = client
      ? applyWorkerNotes(db, project.id, item, pairs, { dryRun: !write })
      : undefined;

    results.push({
      threadId: item.threadId,
      kind: item.kind,
      label: item.label,
      noteCount: item.noteCount,
      openEnds: item.openEnds,
      passages,
      ...(modelText === undefined ? {} : { modelText }),
      notes,
      ...(counts === undefined ? {} : { counts }),
    });
  }

  console.log(JSON.stringify({
    project: { id: project.id, name: project.name },
    model: model ?? null,
    write,
    maxAgeDays,
    queueSize: items.length,
    results,
  }, null, 2));
} finally {
  db.close();
}
