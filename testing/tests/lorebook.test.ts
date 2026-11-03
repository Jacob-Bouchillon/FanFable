import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import * as continuity from '../../fanfable/src/product/continuity.ts';
import { seedProject, tempDb, mockProvider } from './helpers.ts';
import type { ChatRequest } from '../../fanfable/src/core/llm.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as planner from '../../fanfable/src/plan/planner.ts';
import * as memory from '../../fanfable/src/product/memory.ts';
import * as trace from '../../fanfable/src/trace/trace.ts';
import { continuitySettings, filterBySeverity } from '../../fanfable/src/product/continuity-settings.ts';

const AT = '2024-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function insertEntity(db: Db, projectId: number, name: string): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, source_refs, review_status, created_at, updated_at)
       VALUES (?, 'character', ?, '[]', '[]', 'accepted', ?, ?)`,
      projectId,
      name,
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function insertRelation(
  db: Db,
  projectId: number,
  fromId: number,
  toId: number,
  kind: string,
  reviewStatus: string,
  description = '',
): number {
  return Number(
    db.run(
      `INSERT INTO canon_relation
         (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
          review_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      projectId,
      fromId,
      toId,
      kind,
      description,
      description || kind,
      reviewStatus,
      AT,
    ).lastInsertRowid,
  );
}

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
  // Intake banks nothing; this test is about search and the brief, so stand
  // in for the gate and accept the extracted rows.
  db.run("UPDATE canon_entity SET review_status = 'accepted' WHERE project_id = ?", project.id);
  db.run("UPDATE canon_fact SET review_status = 'accepted' WHERE project_id = ?", project.id);

  const hits = lorebook.searchLore(db, project.id, 'Serena');
  assert.ok(hits.entities.length > 0);
  assert.ok(hits.facts.length > 0);

  const brief = lorebook.buildLoreBrief(db, project.id, { names: ['Serena'] });
  assert.match(brief.entities, /Serena Marsh/);
  assert.match(brief.facts, /Three lights/);
  assert.doesNotMatch(brief.entities, /Kade\(companion\)/);

  const text = lorebook.formatLoreBrief(brief);
  assert.match(text, /PEOPLE, PLACES AND THINGS/);
  assert.match(text, /SOURCE-DERIVED FACTS \(VERIFY BEFORE ASSERTING\)/);
  db.close();
});

test('the lore brief exposes only accepted and user_confirmed relationships', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'lore-brief-status');
  const asha = insertEntity(db, project.id, 'Asha');
  const bram = insertEntity(db, project.id, 'Bram');
  const statuses = ['accepted', 'user_confirmed', 'needs_review', 'provisional', 'attested', 'rejected'];
  const ids = new Map(
    statuses.map((status) => [
      status,
      insertRelation(db, project.id, asha, bram, `relation-${status}`, status),
    ]),
  );

  // A different project must not leak through the brief.
  const other = seedProject(db, 'lore-brief-status-other');
  const otherAsha = insertEntity(db, other.id, 'Asha');
  const otherBram = insertEntity(db, other.id, 'Bram');
  insertRelation(db, other.id, otherAsha, otherBram, 'other-project-keeper', 'accepted');

  const brief = lorebook.buildLoreBrief(db, project.id, { names: ['Asha'] });
  assert.match(brief.relations, /relation-accepted/);
  assert.match(brief.relations, /relation-user_confirmed/);
  for (const status of ['needs_review', 'provisional', 'attested', 'rejected']) {
    assert.doesNotMatch(brief.relations, new RegExp(`relation-${status}`));
  }
  assert.doesNotMatch(brief.relations, /other-project-keeper/);
  assert.deepEqual(
    [...(brief.relationIds ?? [])].sort((a, b) => a - b),
    [ids.get('accepted')!, ids.get('user_confirmed')!].sort((a, b) => a - b),
  );

  const text = lorebook.formatLoreBrief(brief);
  assert.match(text, /RELATIONSHIPS IN THE SOURCE/);
  assert.match(text, /relation-accepted/);
  assert.match(text, /relation-user_confirmed/);
  assert.doesNotMatch(text, /relation-needs_review/);

  const noKeeper = seedProject(db, 'lore-brief-no-keeper');
  const noKeeperAsha = insertEntity(db, noKeeper.id, 'Asha');
  const noKeeperBram = insertEntity(db, noKeeper.id, 'Bram');
  insertRelation(db, noKeeper.id, noKeeperAsha, noKeeperBram, 'only-needs-review', 'needs_review');
  const empty = lorebook.buildLoreBrief(db, noKeeper.id, { names: ['Asha'] });
  assert.equal(empty.relations, '');
  assert.deepEqual(empty.relationIds, []);
  assert.doesNotMatch(lorebook.formatLoreBrief(empty), /RELATIONSHIPS IN THE SOURCE/);
  db.close();
});

test('keeper status is applied before the lore brief relation limit', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'lore-brief-status-limit');
  const asha = insertEntity(db, project.id, 'Asha');
  const bram = insertEntity(db, project.id, 'Bram');
  for (let i = 0; i < 30; i++) {
    insertRelation(db, project.id, asha, bram, `noise-${i}`, 'needs_review');
  }
  const accepted = insertRelation(db, project.id, asha, bram, 'keeper-accepted', 'accepted');
  const confirmed = insertRelation(db, project.id, asha, bram, 'keeper-user-confirmed', 'user_confirmed');

  const brief = lorebook.buildLoreBrief(db, project.id, { names: ['Asha'] });
  assert.deepEqual(
    [...(brief.relationIds ?? [])].sort((a, b) => a - b),
    [accepted, confirmed].sort((a, b) => a - b),
  );
  assert.match(brief.relations, /keeper-accepted/);
  assert.match(brief.relations, /keeper-user-confirmed/);
  assert.doesNotMatch(brief.relations, /noise-0/);
  db.close();
});

test('context assembly gives the writer only keeper relationships', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'lore-brief-assembly');
  const asha = insertEntity(db, project.id, 'Asha');
  const bram = insertEntity(db, project.id, 'Bram');
  const keeperId = insertRelation(db, project.id, asha, bram, 'keeper-accepted', 'accepted');
  insertRelation(db, project.id, asha, bram, 'review-only', 'needs_review');
  let traceId: string | undefined;

  const bundle = await controller.assembleContext(db, mockProvider(() => '{}'), project.id, {
    chapterNumber: 1,
    trace: true,
    onTraceId: (id) => {
      traceId = id;
    },
    chapter: {
      number: 1,
      title: 'One',
      goal: 'Asha meets Bram.',
      synopsis: 'They speak.',
      scenes: [],
      characters: ['Asha', 'Bram'],
      characterArcs: '',
      canonEventIds: [],
      notes: '',
      targetWords: 100,
    },
  });
  assert.match(bundle.canonText, /RELATIONSHIPS IN THE SOURCE/);
  assert.match(bundle.canonText, /keeper-accepted/);
  assert.doesNotMatch(bundle.canonText, /review-only/);
  assert.ok(traceId);
  const view = trace.showTrace(db, traceId!);
  assert.ok(view);
  const relationKeys = [
    ...new Set(
      view!.events
        .filter(
          (event) =>
            event.event === 'context.item.generated' &&
            event.subject.startsWith('brief:lore:relation:'),
        )
        .map((event) => event.subject),
    ),
  ];
  assert.deepEqual(relationKeys, [`brief:lore:relation:${keeperId}`]);
  db.close();
});

test('writer character context keeps keeper canon and the story record', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'character-context-status');
  const asha = insertEntity(db, project.id, 'Asha');
  const bram = insertEntity(db, project.id, 'Bram');
  const statuses = ['accepted', 'user_confirmed', 'needs_review', 'provisional', 'attested', 'rejected'];
  for (const status of statuses) {
    insertRelation(db, project.id, asha, bram, `canon-${status}`, status);
  }
  const before = db.all<{ kind: string; review_status: string }>(
    'SELECT kind, review_status FROM canon_relation WHERE project_id = ? ORDER BY id',
    project.id,
  );

  const storyAsha = memory.upsertCharacter(db, project.id, 'Asha');
  const storyBram = memory.upsertCharacter(db, project.id, 'Bram');
  memory.upsertRelationship(db, project.id, storyAsha, storyBram, {
    kind: 'story-ally',
    description: 'only in the story record',
    source: 'au',
  });

  const outline = planner.saveOutline(db, project.id, {
    premise: 'Asha meets Bram.',
    divergence: 'They meet earlier.',
    chapters: [{
      number: 1,
      title: 'One',
      goal: 'Asha meets Bram.',
      synopsis: 'They speak.',
      scenes: [],
      characters: ['Asha', 'Bram'],
      characterArcs: '',
      canonEventIds: [],
      notes: '',
      targetWords: 100,
    }],
    status: 'draft',
  });
  planner.approveOutline(db, project.id, outline.id);

  const calls: ChatRequest[] = [];
  let call = 0;
  const writer = mockProvider((req) => {
    calls.push(structuredClone(req) as ChatRequest);
    call++;
    if (call === 1) {
      return 'Asha waited.\n\n[[CONTEXT]]\n{"kind":"character","query":"Asha","character":"Asha"}\n[[END]]';
    }
    return 'Asha answered.';
  });
  await controller.writeChapter(db, writer, project.id, {
    chapterNumber: 1,
    bundle: { memoryText: '', canonText: '', connectedText: '', previousTail: '', focus: [], requests: [] },
    targetWords: 1,
    skipContinuity: true,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.messages.map((message) => message.role), ['user', 'assistant', 'user']);
  const answer = calls[1]!.messages[2]!.content;
  assert.match(answer, /WHAT THE SOURCE SAYS ABOUT ASHA/);
  assert.match(answer, /canon-accepted/);
  assert.match(answer, /canon-user_confirmed/);
  for (const status of ['needs_review', 'provisional', 'attested', 'rejected']) {
    assert.doesNotMatch(answer, new RegExp(`canon-${status}`));
  }
  assert.match(answer, /STORY RECORD for Asha/);
  assert.match(answer, /story-ally/);
  assert.match(answer, /only in the story record/);

  const after = db.all<{ kind: string; review_status: string }>(
    'SELECT kind, review_status FROM canon_relation WHERE project_id = ? ORDER BY id',
    project.id,
  );
  assert.deepEqual(after, before, 'candidate relation rows are not altered');
  db.close();
});

test('character context without keeper relations omits the source relationship section', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'character-context-no-keeper');
  const cora = insertEntity(db, project.id, 'Cora');
  const bram = insertEntity(db, project.id, 'Bram');
  insertRelation(db, project.id, cora, bram, 'review-only', 'needs_review');

  const result = await controller.resolveContextRequest(
    db,
    mockProvider(() => '{}'),
    project.id,
    { kind: 'character', query: 'Cora', character: 'Cora' },
    null,
    { maxRequests: 10 },
  );
  assert.ok(result.answer);
  assert.match(result.answer!.label, /WHAT THE SOURCE SAYS ABOUT CORA/);
  assert.doesNotMatch(result.answer!.content, /RELATIONSHIPS IN THE SOURCE/);
  assert.doesNotMatch(result.answer!.content, /review-only/);
  db.close();
});

test('character context fallback keeps only keeper relationships', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'character-context-fallback');
  const asha = insertEntity(db, project.id, 'Asha');
  const bram = insertEntity(db, project.id, 'Bram');
  insertRelation(db, project.id, asha, bram, 'keeper-accepted', 'accepted');
  insertRelation(db, project.id, asha, bram, 'review-only', 'needs_review');

  const result = await controller.resolveContextRequest(
    db,
    mockProvider(() => '{}'),
    project.id,
    { kind: 'character', query: 'Asha healer', character: 'Asha healer' },
    null,
    { maxRequests: 10 },
  );
  assert.ok(result.answer);
  assert.match(result.answer!.content, /keeper-accepted/);
  assert.doesNotMatch(result.answer!.content, /review-only/);
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
