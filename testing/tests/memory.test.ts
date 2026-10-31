import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as memory from '../../fanfable/src/product/memory.ts';
import { Db } from '../../fanfable/src/core/db.ts';
import { seedProject, tempDb } from './helpers.ts';

test('characters, states and knowledge are stored and retrieved', () => {
  const { db } = tempDb();
  const project = seedProject(db);

  const serena = memory.upsertCharacter(db, project.id, 'Serena Marsh', {
    aliases: ['Serena'],
    profile: 'watches the bridge from the ridge',
    traits: ['observant'],
  });
  const kade = memory.upsertCharacter(db, project.id, 'Kade');

  memory.addCharacterState(db, project.id, serena, {
    location: 'the ridge',
    condition: 'soaked',
    emotional: 'afraid',
    source: 'au',
  });
  memory.addCharacterState(db, project.id, serena, {
    location: 'the far bank',
    condition: 'soaked',
    emotional: 'resolute',
    source: 'au',
  });

  const states = memory.currentStates(db, project.id);
  const current = states.find((s) => s.characterId === serena);
  assert.equal(current?.location, 'the far bank', 'the latest state wins');

  memory.addKnowledge(db, project.id, {
    characterId: serena,
    fact: 'the third light was hers',
    topic: 'bridge',
    certainty: 'knows',
    source: 'au',
  });
  const knowledge = memory.listKnowledge(db, project.id, serena);
  assert.equal(knowledge.length, 1);
  assert.equal(knowledge[0].certainty, 'knows');

  const resolved = memory.resolveCharacter(db, project.id, 'Serena');
  assert.equal(resolved?.id, serena, 'aliases resolve to the same character');
  assert.ok(kade > 0);
  db.close();
});

test('relationships are symmetric and updated, not duplicated', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'merge');
  const a = memory.upsertCharacter(db, project.id, 'Serena');
  const b = memory.upsertCharacter(db, project.id, 'Ilsa');

  memory.upsertRelationship(db, project.id, a, b, { kind: 'friend' });
  memory.upsertRelationship(db, project.id, b, a, { kind: 'friend', description: 'share a secret' });

  let rels = memory.listRelationships(db, project.id);
  assert.equal(rels.length, 1, 'the same relationship is updated, not duplicated');
  assert.equal(rels[0].kind, 'friend');
  assert.equal(rels[0].description, 'share a secret');
  db.close();
});

test('a relationship that changes keeps its history', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'rel-history');
  const a = memory.upsertCharacter(db, project.id, 'Serena');
  const b = memory.upsertCharacter(db, project.id, 'Ilsa');

  memory.upsertRelationship(db, project.id, a, b, { kind: 'friend' });
  memory.upsertRelationship(db, project.id, a, b, { kind: 'estranged' });

  const rows = db.all<{ kind: string; closed: number; valid_to_event_id: number | null }>(
    'SELECT kind, closed, valid_to_event_id FROM relationship WHERE project_id = ? ORDER BY id',
    project.id,
  );
  assert.equal(rows.length, 2, 'the earlier state is kept');
  assert.equal(rows[0].kind, 'friend');
  assert.equal(rows[0].closed, 1, 'the earlier state is closed');
  assert.equal(rows[1].kind, 'estranged');
  assert.equal(rows[1].closed, 0, 'the current state is open');
  db.close();
});

test('context slice returns the relevant subset, not the whole story', () => {
  const { db } = tempDb();
  const project = seedProject(db);
  const serena = memory.upsertCharacter(db, project.id, 'Serena Marsh');
  const ilsa = memory.upsertCharacter(db, project.id, 'Ilsa Marrow');
  memory.addCharacterState(db, project.id, serena, { location: 'the ridge', source: 'au' });
  memory.addCharacterState(db, project.id, ilsa, { location: 'the wardens hall', source: 'au' });
  memory.addKnowledge(db, project.id, { characterId: serena, fact: 'the third light was hers', source: 'au' });
  memory.addKnowledge(db, project.id, { characterId: ilsa, fact: 'the ledger holds a promise', source: 'au' });
  memory.upsertThread(db, project.id, 'The third light', 'who carried the lantern');
  memory.addFact(db, project.id, { kind: 'decision', content: 'Serena crosses before dawn', subject: 'Serena' });

  const slice = memory.buildContextSlice(db, project.id, { focus: ['Serena'] });
  assert.ok(slice.characters.some((c) => c.name === 'Serena Marsh'));
  assert.ok(!slice.characters.some((c) => c.name === 'Ilsa Marrow'), 'unrelated characters are excluded');
  assert.ok(slice.knowledge.every((k) => k.characterName === 'Serena Marsh'));
  assert.ok(slice.facts.length === 1);

  const rendered = memory.renderContextSlice(slice);
  assert.match(rendered, /STORY MEMORY|CHARACTERS/);
  assert.match(rendered, /Serena Marsh/);
  db.close();
});

test('state extraction is applied to the story database', () => {
  const { db } = tempDb();
  const project = seedProject(db);
  const chapterId = 1;
  db.run(
    "INSERT INTO chapter (project_id, number, title, status, body, created_at, updated_at) VALUES (?, 1, 'One', 'draft', 'text', '2024-01-01', '2024-01-01')",
    project.id,
  );
  const realId = db.get<{ id: number }>('SELECT id FROM chapter WHERE project_id = ?', project.id)!.id;

  const extraction: memory.StateExtraction = {
    summary: 'Serena crosses the bridge in the rain.',
    events: [
      {
        id: 0,
        chapterId: null,
        chapterNumber: null,
        title: 'Serena crosses at dawn',
        summary: 'She crosses with the third lantern.',
        storyTime: 'day three',
        storyOrder: 1,
        participants: ['Serena'],
        location: 'Ardenne bridge',
        kind: 'event',
        adaptsCanonEventId: null,
        divergenceNote: '',
      },
    ],
    characters: [{ name: 'Serena Marsh', aliases: ['Serena'], profile: 'a watcher', traits: ['observant'] }],
    states: [{ character: 'Serena Marsh', location: 'the far bank', condition: 'wet', emotional: 'resolved' }],
    knowledge: [{ character: 'Serena Marsh', fact: 'Kade was watching from the ridge', certainty: 'knows' }],
    relationships: [{ a: 'Serena Marsh', b: 'Kade', kind: 'uneasy' }],
    threads: [{ title: 'The third light', description: 'who carried it', status: 'open' }],
    facts: [{ kind: 'decision', subject: 'Serena', content: 'She crossed before dawn' }],
    canonChanges: [],
  };

  memory.applyStateExtraction(db, project.id, realId, extraction);

  const events = memory.listAuEvents(db, project.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Serena crosses at dawn');
  assert.equal(events[0].chapterId, realId);

  const summaries = memory.listSummaries(db, project.id);
  assert.equal(summaries.length, 1);
  assert.match(summaries[0].summary, /crosses the bridge/);

  const threads = memory.listThreads(db, project.id);
  assert.equal(threads[0].title, 'The third light');
  db.close();
});

test('characters that are obviously the same person are merged', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'merge');
  const short = memory.upsertCharacter(db, project.id, 'Serena');
  const full = memory.upsertCharacter(db, project.id, 'Serena Marsh');
  const kade = memory.upsertCharacter(db, project.id, 'Kade');

  memory.addCharacterState(db, project.id, short, { location: 'the ridge' });
  memory.addCharacterState(db, project.id, full, { location: 'the far bank' });
  memory.addKnowledge(db, project.id, { characterId: short, fact: 'she took the lantern' });
  memory.upsertRelationship(db, project.id, short, kade, { kind: 'friend' });
  memory.upsertRelationship(db, project.id, full, kade, { kind: 'uneasy', description: 'he resents her' });

  const merged = memory.mergeSimilarCharacters(db, project.id);
  assert.deepEqual(merged, ['Serena -> Serena Marsh']);

  const chars = memory.listCharacters(db, project.id);
  assert.equal(chars.length, 2, 'the duplicate is gone');
  const serena = chars.find((c) => c.name === 'Serena Marsh')!;
  assert.ok(serena.aliases.includes('Serena'));
  assert.equal(memory.listCharacterStates(db, project.id, serena.id).length, 2, 'states are preserved');
  assert.equal(memory.listKnowledge(db, project.id, serena.id).length, 1, 'knowledge follows the character');

  const rels = memory.listRelationships(db, project.id);
  assert.equal(rels.length, 1, 'relationships are not duplicated');
  assert.equal(rels[0].kind, 'uneasy');
  db.close();
});

test('applying an extraction merges duplicate character names', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'merge-extract');
  const chapterId = 1;
  db.run(
    "INSERT INTO chapter (project_id, number, title, status, body, created_at, updated_at) VALUES (?, 1, 'One', 'draft', 'text', '2024-01-01', '2024-01-01')",
    project.id,
  );
  const realId = db.get<{ id: number }>('SELECT id FROM chapter WHERE project_id = ?', project.id)!.id;

  const extraction: memory.StateExtraction = {
    summary: 's',
    events: [],
    characters: [
      { name: 'Serena', profile: 'a watcher' },
      { name: 'Serena Marsh', profile: '' },
    ],
    states: [{ character: 'Serena', location: 'the ridge' }],
    knowledge: [],
    relationships: [],
    threads: [],
    facts: [],
    canonChanges: [],
  };

  memory.applyStateExtraction(db, project.id, realId, extraction);
  const chars = memory.listCharacters(db, project.id);
  assert.equal(chars.length, 1, 'the two names are one character');
  assert.equal(chars[0].name, 'Serena Marsh');
  assert.ok(chars[0].aliases.includes('Serena'));
  db.close();
});

test('threads and facts persist across project reopen', () => {
  const { db, path } = tempDb();
  const project = seedProject(db);
  memory.upsertThread(db, project.id, 'The third light');
  memory.addFact(db, project.id, { kind: 'promise', content: 'Ilsa will not tell Kade' });
  db.close();

  const reopened = new Db(path);
  const threads = memory.listThreads(reopened, project.id);
  assert.equal(threads.length, 1);
  const facts = memory.listFacts(reopened, project.id);
  assert.equal(facts[0].kind, 'promise');
  reopened.close();
});
