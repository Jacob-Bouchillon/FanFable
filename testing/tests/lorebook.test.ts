import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import * as continuity from '../../fanfable/src/continuity.ts';
import { seedProject, tempDb, mockProvider } from './helpers.ts';
import * as controller from '../../fanfable/src/controller.ts';
import { continuitySettings, filterBySeverity } from '../../fanfable/src/continuity-settings.ts';

const EXTRACTION_JSON = {
  entities: [
    {
      kind: 'character',
      name: 'Serena Marsh',
      aliases: ['Serena'],
      summary: 'A woman who watches the bridge from the ridge.',
      attributes: { coat: 'her brother’s' },
      role: 'protagonist',
      status: 'alive',
      chunk_index: 0,
      evidence: 'Serena Marsh watched it from the ridge',
    },
    {
      kind: 'character',
      name: 'Kade',
      aliases: [],
      summary: 'A frightened man who counts the lights.',
      attributes: {},
      role: 'companion',
      status: 'alive',
      chunk_index: 0,
      evidence: '"Two hundred yards," said Kade behind her.',
    },
    {
      kind: 'location',
      name: 'the bridge at Ardenne',
      aliases: ['Ardenne bridge'],
      summary: 'A crossing over the river.',
      attributes: {},
      role: '',
      status: 'standing',
      chunk_index: 0,
      evidence: 'the bridge at Ardenne still stood',
    },
    {
      kind: 'rule',
      name: 'the lantern signal',
      aliases: [],
      summary: 'Three lights mean the bridge is held, one means the wardens are coming.',
      attributes: {},
      role: '',
      status: '',
      chunk_index: 0,
      evidence: 'Three lights meant the bridge was held',
    },
  ],
  relations: [
    {
      from: 'Serena Marsh',
      to: 'Kade',
      kind: 'accompanied by',
      description: 'Kade stands behind her on the ridge.',
      chunk_index: 0,
      evidence: '"Two hundred yards," said Kade behind her.',
    },
  ],
  facts: [
    {
      topic: 'the bridge signal',
      statement: 'Three lights mean the bridge is held and one light means the wardens are coming.',
      kind: 'rule',
      certainty: 'confirmed',
      subject: 'Serena Marsh',
      chunk_index: 0,
      evidence: 'Three lights meant the bridge was held',
    },
  ],
  timeline: [
    {
      title: 'Serena watches the bridge',
      summary: 'She counts the lights from the ridge.',
      when: 'three days of rain',
      participants: ['Serena Marsh', 'Kade'],
      location: 'the ridge',
      chunk_index: 0,
      evidence: 'Serena Marsh watched it from the ridge',
    },
  ],
};

test('lore extraction records entities, relations, facts and timeline with evidence', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'lore');
  const llm = mockProvider(() => JSON.stringify(EXTRACTION_JSON));

  const stats = await lorebook.extractLore(db, llm, project.id);
  assert.equal(stats.entities, 4);
  assert.equal(stats.relations, 1);
  assert.equal(stats.facts, 1);
  assert.equal(stats.timeline, 1);

  const entities = lorebook.listEntities(db, project.id);
  assert.equal(entities.length, 4);
  const serena = entities.find((e) => e.name === 'Serena Marsh')!;
  assert.equal(serena.kind, 'character');
  assert.equal(serena.status, 'alive');
  assert.deepEqual(serena.aliases, ['Serena']);
  assert.ok(serena.evidence.length > 0, 'the evidence is kept');
  assert.ok(serena.sourceRefs.length > 0, 'the source reference is kept');

  const relations = lorebook.listRelations(db, project.id);
  assert.equal(relations[0].fromName, 'Serena Marsh');
  assert.equal(relations[0].toName, 'Kade');

  const facts = lorebook.listFacts(db, project.id);
  assert.match(facts[0].statement, /Three lights/);

  const timeline = lorebook.listTimeline(db, project.id);
  assert.equal(timeline[0].title, 'Serena watches the bridge');
  assert.deepEqual(timeline[0].participants, ['Serena Marsh', 'Kade']);
  db.close();
});

test('extraction does not duplicate entities when run twice', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'lore-twice');
  const llm = mockProvider(() => JSON.stringify(EXTRACTION_JSON));
  await lorebook.extractLore(db, llm, project.id);
  const before = lorebook.listEntities(db, project.id).length;
  await lorebook.extractLore(db, llm, project.id);
  const after = lorebook.listEntities(db, project.id).length;
  assert.equal(after, before, 'the same entity is updated, not duplicated');
  db.close();
});

test('an answer that runs out of tokens still gives up what it finished', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'lore-truncated');
  // A model that ran out of tokens half way through: the entities it finished
  // are complete, the last one is cut in half, and the relations never start.
  const truncated = `{
  "entities": [
    {
      "kind": "character",
      "name": "Serena Marsh",
      "summary": "A woman who watches the bridge from the ridge.",
      "chunk_index": 0,
      "evidence": "Serena Marsh watched it from the ridge"
    },
    {
      "kind": "character",
      "name": "Kade",
      "summary": "A frightened man who counts the lights.",
      "chunk_index": 0,
      "evidence": "Two hundred yards"
    },
    {
      "kind": "creature",
      "name": "the half-written one"`;
  const llm = mockProvider(() => truncated);
  const stats = await lorebook.extractLore(db, llm, project.id);

  assert.equal(stats.entities, 2, 'the two complete entities are kept');
  const names = lorebook.listEntities(db, project.id).map((e) => e.name);
  assert.deepEqual(names.sort(), ['Kade', 'Serena Marsh']);
  assert.ok(!names.includes('the half-written one'), 'the broken record is dropped');
  db.close();
});

test('lore can be searched and rendered as a brief', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'lore-search');
  const llm = mockProvider(() => JSON.stringify(EXTRACTION_JSON));
  await lorebook.extractLore(db, llm, project.id);

  const hits = lorebook.searchLore(db, project.id, 'Serena');
  assert.ok(hits.entities.length > 0);
  assert.ok(hits.facts.length > 0);

  const brief = lorebook.buildLoreBrief(db, project.id, { names: ['Serena'] });
  assert.match(brief.entities, /Serena Marsh/);
  assert.match(brief.facts, /Three lights/);
  assert.doesNotMatch(brief.entities, /Kade\(companion\)/);

  const text = lorebook.formatLoreBrief(brief);
  assert.match(text, /PEOPLE, PLACES AND THINGS/);
  assert.match(text, /ESTABLISHED BY THE SOURCE/);
  db.close();
});

test('a character dead in the source but acting in the story is flagged', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'dead-check');
  const llm = mockProvider(() => JSON.stringify(EXTRACTION_JSON));
  await lorebook.extractLore(db, llm, project.id);
  // mark Kade dead in the index
  db.run("UPDATE canon_entity SET status = 'dead' WHERE name = 'Kade'");

  const issues = continuity.deterministicChecks({
    chapter: {
      id: 1,
      number: 1,
      title: 'One',
      body: 'Kade stood behind her and spat into the river.',
      status: 'draft',
      summary: '',
    },
    previousChapters: [],
    events: [],
    threads: [],
    knowledge: [],
    canonChanges: [],
    canonEntities: lorebook.listEntities(db, project.id).map((e) => ({
      name: e.name,
      kind: e.kind,
      status: e.status,
      summary: e.summary,
    })),
  });

  const flag = issues.find((i) => i.message.includes('Kade'));
  assert.ok(flag, 'the dead-in-canon character is flagged');
  assert.equal(flag?.category, 'canon-mix');
  db.close();
});

test('a recorded divergence silences that flag', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'dead-check-2');
  const llm = mockProvider(() => JSON.stringify(EXTRACTION_JSON));
  await lorebook.extractLore(db, llm, project.id);
  db.run("UPDATE canon_entity SET status = 'dead' WHERE name = 'Kade'");

  const issues = continuity.deterministicChecks({
    chapter: {
      id: 1,
      number: 1,
      title: 'One',
      body: 'Kade stood behind her and spat into the river.',
      status: 'draft',
      summary: '',
    },
    previousChapters: [],
    events: [],
    threads: [],
    knowledge: [],
    canonChanges: [],
    canonEntities: lorebook.listEntities(db, project.id).map((e) => ({
      name: e.name,
      kind: e.kind,
      status: e.status,
      summary: e.summary,
    })),
    knownDivergences: [{ description: 'Kade survives the crossing in this story', subject: 'Kade' }],
  });

  assert.ok(!issues.some((i) => i.message.includes('Kade')), 'an explained change is not flagged');
  db.close();
});

test('the continuity checker can be switched off', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'checker-off');
  const llm = mockProvider(() => '{"issues":[]}');

  controller.updateProjectSettings(db, project.id, {
    continuity: { enabled: false, modelChecks: true, minSeverity: 'warning', onDraft: true },
  });
  const settings = continuitySettings(controller.getProject(db, project.id)!);
  assert.equal(settings.enabled, false);

  const chapter = controller.saveChapter(db, project.id, 1, { title: 'One', body: 'Something happened.' });
  const issues = await controller.runContinuityCheck(db, llm, project.id, chapter, undefined);
  assert.equal(issues.length, 0, 'a disabled checker reports nothing');
  db.close();
});

test('the severity floor filters what is reported', () => {
  const issues = [
    { severity: 'error', message: 'a' },
    { severity: 'warning', message: 'b' },
    { severity: 'note', message: 'c' },
  ];
  const errorsOnly = filterBySeverity(issues, {
    enabled: true,
    modelChecks: true,
    minSeverity: 'error',
    onDraft: true,
  });
  assert.equal(errorsOnly.length, 1);
  assert.equal(errorsOnly[0].severity, 'error');

  const all = filterBySeverity(issues, {
    enabled: true,
    modelChecks: true,
    minSeverity: 'note',
    onDraft: true,
  });
  assert.equal(all.length, 3);
});
