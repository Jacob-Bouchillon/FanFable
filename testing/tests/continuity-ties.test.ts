/** Keeper-tie denials, verified model evidence, and uncertain dead findings. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as continuity from '../../fanfable/src/product/continuity.ts';
import * as memory from '../../fanfable/src/product/memory.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function chapter(body: string, number = 2): continuity.ChapterRecord {
  return { id: 1, number, title: 'Two', body, status: 'draft', summary: '' };
}

function baseInput(body: string) {
  return {
    chapter: chapter(body),
    previousChapters: [],
    events: [],
    threads: [],
    knowledge: [],
    canonChanges: [],
  };
}

const tie: continuity.KeeperTie = {
  fromName: 'Asha',
  fromAliases: ['Ash'],
  toName: 'Bram',
  toAliases: [],
  kind: 'aide of',
  evidence: 'Asha served Bram at the gate.',
  locator: 'p. 12',
};

test('a denial of a keeper tie is an error carrying both quotes and locator', () => {
  const issues = continuity.deterministicChecks({
    ...baseInput('Asha never served Bram.'),
    keeperTies: [tie],
  });
  const issue = issues.find((item) => item.category === 'relationship');
  assert.ok(issue);
  assert.equal(issue!.severity, 'error');
  assert.equal(issue!.evidence, 'Asha never served Bram.');
  assert.match(issue!.message, /Asha/);
  assert.match(issue!.message, /aide of/);
  assert.match(issue!.suggestion, /Asha served Bram at the gate/);
  assert.match(issue!.suggestion, /p\. 12/);
});

test('omitting the relationship produces no issue', () => {
  const issues = continuity.deterministicChecks({
    ...baseInput('Asha crossed the bridge in the rain.'),
    keeperTies: [tie],
  });
  assert.equal(issues.filter((item) => item.category === 'relationship').length, 0);
});

test('denial of a provisional tie is a note, not an error', () => {
  const issues = continuity.deterministicChecks({
    ...baseInput('Asha never served Bram.'),
    provisionalTies: [tie],
  });
  const issue = issues.find((item) => item.category === 'relationship');
  assert.ok(issue);
  assert.equal(issue!.severity, 'note');
  assert.match(issue!.message, /unverified evidence/);
});

test('aliases are enough to detect the denial', () => {
  const issues = continuity.deterministicChecks({
    ...baseInput('Ash never served Bram.'),
    keeperTies: [tie],
  });
  assert.ok(issues.some((item) => item.category === 'relationship' && item.severity === 'error'));
});

test('a dead-character finding is a note that asks for confirmation', () => {
  const issues = continuity.deterministicChecks({
    ...baseInput('Asha crossed the bridge.'),
    canonEntities: [{ name: 'Asha', kind: 'character', status: 'dead', summary: 'She died.' }],
  });
  const issue = issues.find((item) => item.severity !== 'note' && /dead/i.test(item.message));
  assert.equal(issue, undefined);
  const note = issues.find((item) => /dead in the source/i.test(item.message));
  assert.ok(note);
  assert.equal(note!.severity, 'note');
  assert.match(note!.suggestion, /Confirm whether this scene predates/);
});

test('a pronoun denial only matches with speech attribution to the other endpoint', () => {
  const withAttribution = continuity.deterministicChecks({
    ...baseInput('Bram said quietly. "Asha and I have no tie."'),
    keeperTies: [tie],
  });
  assert.equal(withAttribution.filter((item) => item.category === 'relationship').length, 1);

  const withoutAttribution = continuity.deterministicChecks({
    ...baseInput('Bram waited by the gate. "Asha and I have no tie."'),
    keeperTies: [tie],
  });
  assert.equal(withoutAttribution.filter((item) => item.category === 'relationship').length, 0);
});

test('a nearby third name does not create a second finding', () => {
  const second: continuity.KeeperTie = {
    fromName: 'Corin',
    fromAliases: [],
    toName: 'Dane',
    toAliases: [],
    kind: 'ally of',
    evidence: 'Corin allied with Dane.',
    locator: 'p. 30',
  };
  const issues = continuity.deterministicChecks({
    ...baseInput('Bram said, "Asha and I have no tie with Corin."'),
    keeperTies: [tie, second],
  });
  const relationship = issues.filter((item) => item.category === 'relationship');
  assert.equal(relationship.length, 1, 'only the attributed pair matches');
  assert.match(relationship[0]!.message, /Asha/);
  assert.doesNotMatch(relationship[0]!.message, /Corin/);
});

test('every note is stored even when minSeverity hides it', async () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'continuity-notes');
  const chapter = controller.saveChapter(db, project.id, 2, {
    title: 'Two',
    body: 'Asha crossed the bridge.',
    status: 'draft',
  });
  const llm = mockProvider(() => JSON.stringify({
    issues: [{
      severity: 'note', category: 'relationship', message: 'A stored note',
      evidence: 'Asha crossed the bridge.', suggestion: 'review',
    }],
  }));
  const visible = await controller.runContinuityCheck(
    db, llm, project.id, chapter, undefined,
  );
  assert.equal(visible.length, 0, 'note is below the default warning threshold');
  const stored = continuity.listIssues(db, project.id, {});
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.severity, 'note');
  const filtered = continuity.listIssues(db, project.id, { minSeverity: 'warning' });
  assert.equal(filtered.length, 0);
  db.close();
});

test('model issues whose evidence is absent from the chapter are dropped and counted', async () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'continuity-evidence');
  const llm = mockProvider(() => JSON.stringify({
    issues: [
      { severity: 'warning', category: 'relationship', message: 'Invented finding', evidence: 'This sentence is not in the chapter.', suggestion: 'x' },
    ],
  }));
  const stats = { droppedModelIssues: 0 };
  const issues = await continuity.checkChapter(
    db,
    project.id,
    chapter('Asha crossed the bridge in the rain.'),
    memory.buildContextSlice(db, project.id),
    { useModel: true, llm, stats },
  );
  assert.equal(stats.droppedModelIssues, 1);
  assert.equal(issues.some((item) => item.message === 'Invented finding'), false);
  db.close();
});
