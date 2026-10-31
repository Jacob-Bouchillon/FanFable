/**
 * Deterministic evidence selection (SPEC-evidence-selection.md steps 1–3),
 * tightened support rules and claim routing. Generic names only; the selector
 * is exercised without any database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import {
  normalizeText,
  selectEvidence,
  type ClaimRequirement,
  type EvidenceRecord,
  type Packet,
  type SceneRequirements,
} from '../../fanfable/src/evidence.ts';
import { loadEvidenceRecords, validatePacket } from '../../fanfable/src/evidence-retrieval.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function record(
  eventId: number,
  title: string,
  text: string,
  participants: string[],
  extra: Partial<EvidenceRecord> = {},
): EvidenceRecord {
  return {
    eventId,
    source: 'canon',
    title,
    locator: `p. ${eventId}`,
    text: `${title}. ${text}`,
    participants,
    seq: eventId,
    ...extra,
  };
}

function au(
  eventId: number,
  title: string,
  text: string,
  participants: string[],
  extra: Partial<EvidenceRecord> = {},
): EvidenceRecord {
  return record(eventId, title, text, participants, { source: 'au', ...extra });
}

function claim(text: string, kind: ClaimRequirement['kind'] = 'canon'): ClaimRequirement {
  return { text, kind };
}

function addEntity(db: Db, projectId: number, name: string, aliases: string[] = []): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, 'character', ?, ?, '', '', 1, '', '[]', 'accepted', ?, ?)`,
      projectId,
      name,
      JSON.stringify(aliases),
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function addCanonEvent(
  db: Db,
  projectId: number,
  title: string,
  summary: string,
  participants: string[],
  locator = 'p. 1',
  seq = 1,
  id?: number,
): number {
  return Number(
    db.run(
      `INSERT INTO canon_event (id, project_id, locator, title, summary, participants, seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id ?? null,
      projectId,
      locator,
      title,
      summary,
      JSON.stringify(participants),
      seq,
      AT,
    ).lastInsertRowid,
  );
}

function addAuEvent(
  db: Db,
  projectId: number,
  title: string,
  summary: string,
  participants: string[],
  storyTime: string,
  seq = 1,
  id?: number,
): number {
  return Number(
    db.run(
      `INSERT INTO au_event (id, project_id, title, summary, participants, story_time, seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id ?? null,
      projectId,
      title,
      summary,
      JSON.stringify(participants),
      storyTime,
      seq,
      AT,
    ).lastInsertRowid,
  );
}

const SORT_SCENE: SceneRequirements = {
  title: 'The Sort',
  characters: ['Mara', 'Tor'],
  requires: [claim('Mara is placed in Gryffindor')],
};

/* ------------------------------------------------------------- core rules */

test('a claim is supported by a shared character and two normalised terms', () => {
  const packet = selectEvidence(SORT_SCENE, [
    record(1, 'The Sorting', 'Mara is sorted into Gryffindor.', ['Mara']),
    record(2, 'The Table', 'Mara and Tor sat at the table.', ['Mara', 'Tor']),
  ]);
  assert.equal(packet.support.length, 1);
  assert.equal(packet.support[0]!.eventId, 1);
  assert.equal(packet.support[0]!.source, 'canon');
  assert.equal(packet.support[0]!.score, 1);
  assert.deepEqual(packet.gaps, []);
  assert.deepEqual(packet.context.map((entry) => entry.eventId), [2]);
});

test('character overlap alone only reaches context', () => {
  const packet = selectEvidence(
    { ...SORT_SCENE, requires: [claim('the ceremony places first years into houses')] },
    [record(3, 'Waiting', 'Mara and Tor waited outside.', ['Mara', 'Tor'])],
  );
  assert.deepEqual(packet.support, []);
  assert.deepEqual(packet.gaps, [
    { claim: 'the ceremony places first years into houses', reason: 'no-term-match' },
  ]);
  assert.deepEqual(packet.context.map((entry) => entry.eventId), [3]);
  assert.match(packet.context[0]!.why, /background only/);
});

test('the normalisation table folds inflections and plurals', () => {
  assert.deepEqual(normalizeText('sorted sorting placed assigned').terms, ['sort']);
  assert.deepEqual(normalizeText('boats houses friends').terms, ['boat', 'house', 'friend']);
  assert.deepEqual(normalizeText('arrival arrived').terms, ['arriv']);
  assert.deepEqual(normalizeText("Mara's place").terms, ['mara', 'sort']);
  assert.deepEqual(normalizeText('Gryffindor').terms, ['gryffindor']);
});

test('a gap is reported when no event matches', () => {
  const packet = selectEvidence(SORT_SCENE, []);
  assert.deepEqual(packet.support, []);
  assert.deepEqual(packet.gaps, [{ claim: 'Mara is placed in Gryffindor', reason: 'no-event' }]);
});

test('unresolved characters and participants are reported with their source', () => {
  const { db } = tempDb();
  const project = createProject(db, 'evidence-unresolved');
  addEntity(db, project.id, 'Mara');
  const eventId = addCanonEvent(db, project.id, 'Waiting', 'Mara waited by the gate.', [
    'Mara',
    'Ghost of Nobody',
  ]);
  const result = loadEvidenceRecords(db, project.id, {
    title: 'probe',
    characters: ['Mara', 'Nobody Known'],
    requires: [],
  });
  assert.deepEqual(result.unresolvedCharacters, ['Nobody Known']);
  assert.deepEqual(result.unresolvedParticipants, [
    { eventId, source: 'canon', name: 'Ghost of Nobody' },
  ]);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]!.source, 'canon');
  assert.deepEqual(result.records[0]!.unresolvedParticipants, ['Ghost of Nobody']);
  db.close();
});

test('legitimate reuse passes and an event proving three disjoint claims is flagged', () => {
  const shared = record(
    9,
    'A busy day',
    'The Sorting ceremony sorts new students into houses. Mara is sorted into Gryffindor. Tor teaches Potions. The common room is warm.',
    ['Mara', 'Tor'],
  );
  const legitimate = selectEvidence(
    {
      ...SORT_SCENE,
      requires: [claim('the ceremony sorts students into houses'), claim('the sorting places students into houses')],
    },
    [shared],
  );
  assert.equal(legitimate.support.length, 2);
  assert.deepEqual(legitimate.suspiciousReuse, []);

  const packet = selectEvidence(
    {
      ...SORT_SCENE,
      requires: [
        claim('Mara is placed in Gryffindor'),
        claim('Tor teaches Potions'),
        claim('the common room is warm'),
      ],
    },
    [shared],
  );
  assert.equal(packet.support.length, 3);
  assert.equal(packet.suspiciousReuse.length, 1);
  assert.equal(packet.suspiciousReuse[0]!.source, 'canon');
  assert.equal(packet.suspiciousReuse[0]!.eventId, 9);
  assert.equal(packet.suspiciousReuse[0]!.claims.length, 3);
  assert.equal(packet.context.length, 0, 'support and context never share an event');
});

test('two calls produce identical packets and do not mutate their inputs', () => {
  const requirements: SceneRequirements = { ...SORT_SCENE, requires: [claim('Mara is placed in Gryffindor')] };
  const records = [
    Object.freeze(record(1, 'The Sorting', 'Mara is sorted into Gryffindor.', ['Mara'])),
    Object.freeze(record(2, 'The Table', 'Mara and Tor sat at the table.', ['Mara', 'Tor'])),
  ];
  const first = selectEvidence(requirements, records);
  const second = selectEvidence(requirements, records);
  assert.deepEqual(first, second);
  assert.deepEqual(requirements, SORT_SCENE);
  assert.equal(records.length, 2);
});

test('the selector is pure: records alone, no database', () => {
  const packet: Packet = selectEvidence(SORT_SCENE, [
    record(4, 'The Sorting', 'Mara is sorted into Gryffindor.', ['Mara']),
  ]);
  assert.equal(packet.support[0]!.eventId, 4);
});

/* --------------------------------------------------------- the red cases */

test('Dudley is magical is rejected: the term does not sit with Dudley', () => {
  const packet = selectEvidence(
    {
      title: 'The Entrance',
      characters: ['Harry Potter', 'Dudley Dursley'],
      requires: [claim('Dudley is magical')],
    },
    [
      record(
        29,
        "Harry's History of Magical Incidents",
        "Harry's hair grew back and his clothes shrank; Aunt Petunia and Dudley were present.",
        ['Harry Potter', 'Dudley Dursley', 'Aunt Petunia'],
      ),
    ],
  );
  assert.deepEqual(packet.support, []);
  assert.equal(packet.gaps.length, 1);
  assert.notEqual(packet.gaps[0]!.reason, 'unclassified');
});

test('Snape questions Harry is rejected when the event names only Harry', () => {
  const packet = selectEvidence(
    {
      title: 'Potions Class',
      characters: ['Harry Potter', 'Severus Snape'],
      requires: [claim('Snape questions Harry in class')],
    },
    [
      record(70, 'Harry Questions His Wizardry', 'Harry asks about his own magic in class.', [
        'Harry Potter',
      ]),
    ],
  );
  assert.deepEqual(packet.support, []);
  assert.equal(packet.gaps.length, 1);
});

test('cross the lake by boat picks the lake event, not the platform event', () => {
  const requirements: SceneRequirements = {
    title: 'The Entrance',
    characters: ['Harry Potter', 'Dudley Dursley'],
    requires: [claim('the first years cross the lake by boat')],
    timeline: { after: 1, before: 3 },
  };
  const packet = selectEvidence(requirements, [
    record(
      150,
      'Arrival at Hogwarts Platform',
      "Harry arrives at the platform of King's Cross. Hagrid leads the first years down a path to the edge of the lake.",
      ['Harry Potter'],
      { timelineWindow: false },
    ),
    record(
      151,
      'The Lake and the Castle',
      'Hagrid directs the students into little boats. They sail across a lake towards the castle.',
      ['Harry Potter', 'Rubeus Hagrid'],
      { timelineWindow: true },
    ),
  ]);
  assert.deepEqual(packet.support.map((entry) => entry.eventId), [151]);
  assert.ok(!packet.support.some((entry) => entry.eventId === 150));
});

test('a single-term event outside the window becomes a gap, not support', () => {
  const packet = selectEvidence(
    {
      title: 'The Reaction',
      characters: ['Harry Potter', 'Ron Weasley'],
      requires: [claim('students celebrate their house')],
      timeline: { after: 1, before: 2 },
    },
    [
      record(
        317,
        'Points Deduction Consequence',
        'Points are taken from the students of the house.',
        ['Harry Potter'],
        { timelineWindow: false },
      ),
    ],
  );
  assert.deepEqual(packet.support, []);
  assert.equal(packet.gaps[0]?.reason, 'too-distant');
});

test('friends recover is not supported by an unrelated single-term event', () => {
  const packet = selectEvidence(
    {
      title: 'Aftermath',
      characters: ['Harry Potter', 'Hermione Granger'],
      requires: [claim('the friends recover after the confrontation')],
    },
    [
      record(69, "Hagrid Explains Voldemort's Disappearance", 'Hagrid explains the confrontation.', [
        'Harry Potter',
      ]),
    ],
  );
  assert.deepEqual(packet.support, []);
  assert.equal(packet.gaps.length, 1);
});

/* ------------------------------------------------------------- routing */

test('an AU claim is supported by an AU event and never by a canon one', () => {
  const requirements: SceneRequirements = {
    ...SORT_SCENE,
    characters: ['Dudley Dursley', 'Harry Potter'],
    requires: [claim('Dudley is placed in Gryffindor', 'au')],
  };
  const canonLookalike = record(
    154,
    'Explanation of the Sorting Ceremony',
    'Students are sorted into Gryffindor.',
    ['Harry Potter', 'Dudley Dursley'],
  );
  const auEvent = au(
    3,
    'Sorting Ceremony',
    'Harry and Dudley are sorted into Gryffindor.',
    ['Harry Potter', 'Dudley Dursley'],
  );
  const packet = selectEvidence(requirements, [canonLookalike, auEvent]);
  assert.equal(packet.support.length, 1);
  assert.equal(packet.support[0]!.source, 'au');
  assert.equal(packet.support[0]!.eventId, 3);

  const onlyCanon = selectEvidence(requirements, [canonLookalike]);
  assert.deepEqual(onlyCanon.support, []);
  assert.deepEqual(onlyCanon.gaps, [{ claim: 'Dudley is placed in Gryffindor', reason: 'au-dependent' }]);
});

test('an unclassified claim searches nothing', () => {
  const packet = selectEvidence(
    { ...SORT_SCENE, requires: [claim('Mara is placed in Gryffindor', 'unknown')] },
    [record(1, 'The Sorting', 'Mara is sorted into Gryffindor.', ['Mara'])],
  );
  assert.deepEqual(packet.support, []);
  assert.deepEqual(packet.gaps, [{ claim: 'Mara is placed in Gryffindor', reason: 'unclassified' }]);
});

/* ------------------------------------------------------------ validation */

test('validatePacket re-checks the right table for each source', () => {
  const { db } = tempDb();
  const project = createProject(db, 'evidence-validate');
  addEntity(db, project.id, 'Mara');
  const canonId = addCanonEvent(db, project.id, 'The Sorting', 'Mara is sorted into Gryffindor.', ['Mara'], 'p. 7', 1, 1);
  addAuEvent(db, project.id, 'Sorting Again', 'Mara is sorted into Gryffindor here too.', ['Mara'], '3', 1, 1);
  const canonPacket = selectEvidence(SORT_SCENE, [
    record(canonId, 'The Sorting', 'Mara is sorted into Gryffindor.', ['Mara'], { locator: 'p. 7' }),
  ]);
  assert.deepEqual(validatePacket(db, project.id, canonPacket), { ok: true, problems: [] });

  const tampered: Packet = {
    ...canonPacket,
    support: [{ ...canonPacket.support[0]!, locator: 'p. 99' }],
  };
  assert.equal(validatePacket(db, project.id, tampered).ok, false);

  // A canon id cited as an AU source cannot validate on the AU table.
  const wrongSource: Packet = {
    ...canonPacket,
    support: [{ ...canonPacket.support[0]!, source: 'au' }],
  };
  const checked = validatePacket(db, project.id, wrongSource);
  assert.equal(checked.ok, false);
  assert.ok(checked.problems.some((problem) => problem.includes('au:1')), checked.problems.join('; '));

  const unknownId: Packet = {
    ...canonPacket,
    context: [{ source: 'canon', eventId: 999, title: 'Missing', locator: 'p. 1', why: 'x' }],
  };
  assert.equal(validatePacket(db, project.id, unknownId).ok, false);
  db.close();
});
