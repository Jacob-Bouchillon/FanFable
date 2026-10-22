import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as continuity from '../src/continuity.ts';
import { seedProject, tempDb, mockProvider } from './helpers.ts';
import * as memory from '../src/memory.ts';
import * as controller from '../src/controller.ts';

function chapterRecord(over: Partial<continuity.ChapterRecord> = {}): continuity.ChapterRecord {
  return {
    id: 1,
    number: 1,
    title: 'One',
    body: 'Serena crossed the bridge in the rain.',
    status: 'draft',
    summary: '',
    ...over,
  };
}

test('events that run backwards in story time are flagged', () => {
  const issues = continuity.deterministicChecks({
    chapter: chapterRecord(),
    previousChapters: [],
    events: [
      { id: 1, title: 'Later', storyOrder: 5, kind: 'event', chapterId: 1, adaptsCanonEventId: null, divergenceNote: '' },
      { id: 2, title: 'Earlier', storyOrder: 2, kind: 'event', chapterId: 1, adaptsCanonEventId: null, divergenceNote: '' },
    ],
    threads: [],
    knowledge: [],
    canonChanges: [],
  });
  assert.ok(issues.some((i) => i.category === 'chronology'));
});

test('a flashback must be placed in the past', () => {
  const issues = continuity.deterministicChecks({
    chapter: chapterRecord({ number: 5 }),
    previousChapters: [],
    events: [
      { id: 1, title: 'Memory', storyOrder: 5, kind: 'flashback', chapterId: 1, adaptsCanonEventId: null, divergenceNote: '' },
    ],
    threads: [],
    knowledge: [],
    canonChanges: [],
  });
  assert.ok(issues.some((i) => i.category === 'chronology' && i.message.includes('Flashback')));
});

test('repeated chapters are detected', () => {
  const body = 'Serena crossed the bridge in the rain and Kade watched from the ridge.';
  const issues = continuity.deterministicChecks({
    chapter: chapterRecord({ body }),
    previousChapters: [{ id: 0, number: 1, title: 'One', body, status: 'approved', summary: '' }],
    events: [],
    threads: [],
    knowledge: [],
    canonChanges: [],
  });
  assert.ok(issues.some((i) => i.category === 'repetition'));
});

test('an adaptation without a divergence note is flagged', () => {
  const issues = continuity.deterministicChecks({
    chapter: chapterRecord(),
    previousChapters: [],
    events: [
      { id: 1, title: 'The crossing', storyOrder: 1, kind: 'adaptation', chapterId: 1, adaptsCanonEventId: 7, divergenceNote: '' },
    ],
    threads: [],
    knowledge: [],
    canonChanges: [],
  });
  assert.ok(issues.some((i) => i.category === 'canon-mix'));
});

test('dormant open threads are noted', () => {
  const issues = continuity.deterministicChecks({
    chapter: chapterRecord({ body: 'Nothing of note happened on the road that day.' }),
    previousChapters: [
      { id: 0, number: 1, title: 'One', body: 'x', status: 'approved', summary: '' },
      { id: 0, number: 2, title: 'Two', body: 'y', status: 'approved', summary: '' },
    ],
    events: [],
    threads: [{ id: 1, title: 'The third lantern', status: 'open', events: [] }],
    knowledge: [],
    canonChanges: [],
  });
  assert.ok(issues.some((i) => i.category === 'thread'));
});

test('model issues are merged with deterministic ones', () => {
  const det: continuity.ContinuityIssue[] = [
    {
      severity: 'warning',
      category: 'chronology',
      message: 'time goes backwards',
      evidence: 'e1',
      suggestion: '',
      resolution: 'open',
    },
  ];
  const model: continuity.ContinuityIssue[] = [
    {
      severity: 'error',
      category: 'knowledge',
      message: 'Kade knows the plan but has not been told',
      evidence: 'quote',
      suggestion: 'fix',
      resolution: 'open',
    },
  ];
  const merged = continuity.mergeIssues(det, model);
  assert.equal(merged.length, 2);
});

test('issues are persisted and can be resolved', () => {
  const { db } = tempDb();
  const project = seedProject(db);
  const chapterId = 1;
  db.run(
    "INSERT INTO chapter (project_id, number, title, status, body, created_at, updated_at) VALUES (?, 1, 'One', 'draft', 'x', '2024-01-01', '2024-01-01')",
    project.id,
  );
  const id = db.get<{ id: number }>('SELECT id FROM chapter WHERE project_id = ?', project.id)!.id;
  continuity.saveIssues(db, project.id, id, [
    {
      severity: 'error',
      category: 'knowledge',
      message: 'problem',
      evidence: 'e',
      suggestion: 's',
      resolution: 'open',
    },
  ]);
  const open = continuity.listIssues(db, project.id, { openOnly: true });
  assert.equal(open.length, 1);
  continuity.setIssueResolution(db, project.id, open[0].id, 'accepted');
  assert.equal(continuity.listIssues(db, project.id, { openOnly: true }).length, 0);
  db.close();
});

test('the checker runs over a stored chapter', async () => {
  const { db } = tempDb();
  const project = seedProject(db);
  const llm = mockProvider(() => '{"issues":[]}');
  const chapter = controller.saveChapter(db, project.id, 1, {
    title: 'One',
    body: 'Serena crossed the bridge in the rain.',
  });
  const issues = await controller.runContinuityCheck(db, llm, project.id, chapter, undefined);
  assert.ok(Array.isArray(issues));
  db.close();
});

test('a character who knows too much is caught by the model check', async () => {
  const { db } = tempDb();
  const project = seedProject(db);
  const llm = mockProvider((req) => {
    if ((req.system ?? '').includes('Continuity Checker')) {
      return JSON.stringify({
        issues: [
          {
            severity: 'error',
            category: 'knowledge',
            message: 'Ilsa refers to the third light, which she cannot know about.',
            evidence: '"the third light," said Ilsa',
            suggestion: 'Have her learn of it in this chapter first.',
          },
        ],
      });
    }
    return '{}';
  });
  const chapter = controller.saveChapter(db, project.id, 1, {
    title: 'One',
    body: '"the third light," said Ilsa.',
  });
  const issues = await controller.runContinuityCheck(db, llm, project.id, chapter, undefined);
  assert.ok(issues.some((i) => i.category === 'knowledge'));
  const stored = continuity.listIssues(db, project.id, { chapterId: chapter.id });
  assert.equal(stored.length, issues.length);
  db.close();
});
