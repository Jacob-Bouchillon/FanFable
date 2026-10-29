/**
 * Match-time derived name variants (SPEC-name-variants.md, §5).
 *
 * Variants are derived on demand from an entity's stored name and explicit
 * aliases; nothing is written to canon_entity, and explicit forms are never
 * filtered. Invented names and prose only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import {
  buildRosterIndex,
  deriveNameVariants,
  NAME_DF_CAP,
  occursLowercaseInText,
  type RosterIndex,
} from '../../fanfable/src/names.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

type Db = ReturnType<typeof tempDb>['db'];

function entity(
  db: Db,
  projectId: number,
  name: string,
  aliases: string[] = [],
  kind = 'character',
): number {
  return Number(
    db.run(
      'INSERT INTO canon_entity (project_id, kind, name, aliases, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      projectId,
      kind,
      name,
      JSON.stringify(aliases),
      'accepted',
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function chunk(db: Db, projectId: number, text: string, seq = 1): number {
  const sourceId = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      `s-${Math.random().toString(36).slice(2)}.txt`,
      'source',
      'sha',
      AT,
    ).lastInsertRowid,
  );
  return Number(
    db.run(
      'INSERT INTO canon_chunk (source_id, project_id, seq, text, locator) VALUES (?, ?, ?, ?, ?)',
      sourceId,
      projectId,
      seq,
      text,
      `p. ${seq}`,
    ).lastInsertRowid,
  );
}

function setup(name: string) {
  const { db } = tempDb();
  const project = controller.createProject(db, name);
  return { db, project };
}

/** The per-command index: every entity row plus all chunk text. */
function indexFor(db: Db, projectId: number): RosterIndex {
  const rows = db
    .all<{ name: string; aliases: string }>('SELECT name, aliases FROM canon_entity WHERE project_id = ?', projectId)
    .map((row) => {
      let aliases: string[] = [];
      try {
        const parsed = JSON.parse(row.aliases || '[]');
        if (Array.isArray(parsed)) aliases = parsed.map(String);
      } catch {
        aliases = [];
      }
      return { name: row.name, aliases };
    });
  const text = db
    .all<{ text: string }>('SELECT text FROM canon_chunk WHERE project_id = ?', projectId)
    .map((row) => row.text)
    .join(' ');
  return buildRosterIndex(rows, text);
}

/* --------------------------------------------------------------- positive */

test('a titled full name yields its stripped, given and surname forms', () => {
  const row = { name: 'Aunt Petunia Dursley', aliases: [] };
  const index = buildRosterIndex([row], '');
  const variants = deriveNameVariants(row, index);
  assert.deepEqual(variants, ['aunt petunia dursley', 'petunia dursley', 'dursley', 'petunia']);
  // §5.1: the derived forms are exactly the stripped name, given, surname.
  assert.deepEqual(new Set(variants.slice(1)), new Set(['petunia dursley', 'petunia', 'dursley']));
});

test('a df title token is stripped only above NAME_DF_CAP', () => {
  // "warden" is not in the universal title set, so its document frequency
  // decides. df counts entities whose stored name or alias contains the token.
  const others = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ name: `Warden Marker${i}`, aliases: [] }));
  const subject = { name: 'Warden Verity Quill', aliases: [] };

  const atCap = buildRosterIndex([...others(NAME_DF_CAP - 1), subject], '');
  const atCapVariants = deriveNameVariants(subject, atCap);
  assert.ok(!atCapVariants.includes('verity quill'), 'no strip at the cap');

  const overCap = buildRosterIndex([...others(NAME_DF_CAP), subject], '');
  const overCapVariants = deriveNameVariants(subject, overCap);
  assert.ok(overCapVariants.includes('verity quill'), 'above the cap the token is a title and is stripped');
  assert.ok(overCapVariants.includes('verity'), 'given name comes from the stripped list');
  assert.ok(!atCapVariants.includes('verity'), 'without a strip there is no stripped given name');
});

test('a quote naming only the given name satisfies the full stored name', () => {
  const { db, project } = setup('variants-proof');
  const fromId = entity(db, project.id, 'Aunt Petunia Dursley');
  const toId = entity(db, project.id, 'Lily Potter');
  const quote = 'Petunia was the sister of Lily.';
  chunk(db, project.id, quote);
  const index = indexFor(db, project.id);
  const row = {
    fromId,
    toId,
    fromName: 'Aunt Petunia Dursley',
    toName: 'Lily Potter',
    kind: 'sister of',
    evidence: quote,
  };

  const without = lorebook.canPromote(row, { db, projectId: project.id, chunkText: quote });
  assert.deepEqual(without, { ok: false, reason: 'endpoint-unnamed' });

  const withVariants = lorebook.canPromote(row, { db, projectId: project.id, chunkText: quote, index });
  assert.deepEqual(withVariants, { ok: true });
  db.close();
});

test('a sentence naming only the given name yields a scan candidate', () => {
  const { db, project } = setup('variants-scan');
  entity(db, project.id, 'Harry Potter');
  entity(db, project.id, 'Ron Weasley');
  chunk(db, project.id, 'Harry was a loyal friend of Ron.');

  const candidates = lorebook.scanSentenceCandidates(db, project.id);
  assert.equal(candidates.length, 1);
  assert.deepEqual(
    { from: candidates[0]!.fromName, to: candidates[0]!.toName },
    { from: 'Harry Potter', to: 'Ron Weasley' },
  );
  db.close();
});

/* --------------------------------------------------------------- negative */

test('a leading title is still not an assertion with variants enabled', () => {
  // §5.5: the regression that matters most.
  const { db, project } = setup('variants-negative');
  const fromId = entity(db, project.id, 'Aunt Petunia Dursley');
  const toId = entity(db, project.id, 'Dudley Dursley');
  const quote = 'Aunt Petunia looked over at Dudley.';
  chunk(db, project.id, quote);
  const index = indexFor(db, project.id);

  const decision = lorebook.canPromote(
    { fromId, toId, fromName: 'Aunt Petunia Dursley', toName: 'Dudley Dursley', kind: 'aunt of', evidence: quote },
    { db, projectId: project.id, chunkText: quote, index },
  );
  assert.deepEqual(decision, { ok: false, reason: 'assertion-missing' });

  const sentence = 'Aunt Petunia looked over at Dudley.';
  assert.equal(
    lorebook.assertsRelationship(
      sentence,
      'Aunt Petunia Dursley',
      [],
      'Dudley Dursley',
      [],
      'aunt of',
      '',
      index,
    ),
    false,
  );
  db.close();
});

test('two distinct people sharing a given name both lose it, without merging', () => {
  const { db, project } = setup('variants-collision');
  entity(db, project.id, 'Harry Potter');
  entity(db, project.id, 'Harry Smith');
  chunk(db, project.id, 'Harry Potter met Harry Smith at the gate.');
  const index = indexFor(db, project.id);

  const potter = deriveNameVariants({ name: 'Harry Potter', aliases: [] }, index);
  assert.ok(!potter.includes('harry'), 'the shared given name collides with another person');
  assert.ok(potter.includes('harry potter'), 'the full name survives');
  assert.ok(potter.includes('potter'), 'the surname survives');

  const smith = deriveNameVariants({ name: 'Harry Smith', aliases: [] }, index);
  assert.ok(!smith.includes('harry'), 'the other side loses it too');
  assert.ok(smith.includes('harry smith'));

  // No merge: both rows still exist, and both still match their full names.
  const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', project.id);
  assert.equal(count?.n, 2);
  assert.equal(
    lorebook.namesBothDistinctly(
      'Harry Potter is the friend of Harry Smith.',
      'Harry Potter',
      [],
      'Harry Smith',
      [],
      index,
    ),
    true,
  );
  db.close();
});

test('a surname shared by distinct people is dropped for all of them', () => {
  const rows = [
    { name: 'Aunt Petunia Dursley', aliases: [] },
    { name: 'Vernon Dursley', aliases: [] },
    { name: 'Dudley Dursley', aliases: [] },
    { name: 'Ron Weasley', aliases: [] },
    { name: 'Fred Weasley', aliases: [] },
    { name: 'Harry Potter', aliases: [] },
    { name: 'James Potter', aliases: [] },
    { name: 'Lily Potter', aliases: [] },
  ];
  const index = buildRosterIndex(rows, '');
  const variantsFor = (name: string) => deriveNameVariants({ name, aliases: [] }, index);

  for (const name of ['Aunt Petunia Dursley', 'Vernon Dursley', 'Dudley Dursley']) {
    assert.ok(!variantsFor(name).includes('dursley'), `shared surname on ${name}`);
  }
  for (const name of ['Ron Weasley', 'Fred Weasley']) {
    assert.ok(!variantsFor(name).includes('weasley'), `shared surname on ${name}`);
  }
  for (const name of ['Harry Potter', 'James Potter', 'Lily Potter']) {
    assert.ok(!variantsFor(name).includes('potter'), `shared surname on ${name}`);
  }
  // The personal given name is untouched, and each full name still works.
  assert.ok(variantsFor('Aunt Petunia Dursley').includes('petunia'));
  assert.ok(variantsFor('Ron Weasley').includes('ron'));
  assert.ok(variantsFor('Harry Potter').includes('harry'));
  assert.ok(variantsFor('Lily Potter').includes('lily'));
  for (const row of rows) assert.ok(variantsFor(row.name).includes(row.name.toLowerCase()));
});

test('a name-variant row of the same person keeps the shared given name', () => {
  // nameRelation treats "Aunt Petunia" inside "Aunt Petunia Dursley" as one
  // split identity, so the given name stays usable for both rows.
  const rows = [
    { name: 'Aunt Petunia', aliases: [] },
    { name: 'Aunt Petunia Dursley', aliases: [] },
  ];
  const index = buildRosterIndex(rows, '');
  for (const row of rows) {
    assert.ok(deriveNameVariants(row, index).includes('petunia'), `${row.name} keeps the given name`);
  }
});

test('a variant whose lowercase form occurs in the text is dropped', () => {
  const { db, project } = setup('variants-common-word');
  entity(db, project.id, 'Dean Thomas');
  const text = 'The dean of the college called for quiet.';
  chunk(db, project.id, text);
  const index = indexFor(db, project.id);

  assert.equal(occursLowercaseInText(text, 'dean'), true);
  const variants = deriveNameVariants({ name: 'Dean Thomas', aliases: [] }, index);
  assert.ok(!variants.includes('dean'), 'lowercase "dean" is a common word here');
  assert.ok(variants.includes('thomas'));
  assert.ok(variants.includes('dean thomas'));
  db.close();
});

test('namesBothDistinctly still refuses one surface string as both endpoints', () => {
  const { db, project } = setup('variants-one-surface');
  entity(db, project.id, 'Mara', ['The Captain']);
  entity(db, project.id, 'The Captain');
  chunk(db, project.id, 'The Captain gave the order.');
  const index = indexFor(db, project.id);

  assert.equal(
    lorebook.namesBothDistinctly(
      'The Captain gave the order.',
      'Mara',
      ['The Captain'],
      'The Captain',
      [],
      index,
    ),
    false,
  );
  db.close();
});

test('the promotion command resolves given names through the index', () => {
  const { db, project } = setup('variants-promote');
  const petunia = entity(db, project.id, 'Aunt Petunia Dursley');
  const lily = entity(db, project.id, 'Lily Potter');
  const dudley = entity(db, project.id, 'Dudley Dursley');
  const good = 'Petunia was the sister of Lily.';
  const bad = 'Aunt Petunia looked over at Dudley.';
  const goodChunk = chunk(db, project.id, good, 1);
  const badChunk = chunk(db, project.id, bad, 2);
  const relation = (fromId: number, toId: number, kind: string, evidence: string, chunkId: number) =>
    Number(
      db.run(
        `INSERT INTO canon_relation
           (project_id, from_entity, to_entity, kind, description, evidence, source_refs, review_status, modality, created_at)
         VALUES (?, ?, ?, ?, '', ?, ?, 'provisional', 'asserted', ?)`,
        project.id,
        fromId,
        toId,
        kind,
        evidence,
        JSON.stringify([{ source: 'source', locator: 'p. 1', chunk: chunkId }]),
        AT,
      ).lastInsertRowid,
    );
  const goodId = relation(petunia, lily, 'sister of', good, goodChunk);
  const badId = relation(petunia, dudley, 'aunt of', bad, badChunk);

  const result = lorebook.promoteProvisional(db, project.id);
  assert.equal(result.promoted, 1);
  const goodRow = db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', goodId);
  assert.equal(goodRow?.review_status, 'accepted', 'given names satisfy both endpoints');
  const badRow = db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', badId);
  assert.equal(badRow?.review_status, 'provisional', 'the leading title still asserts nothing');
  assert.deepEqual(result.still, [{ id: badId, reason: 'assertion-missing' }]);
  db.close();
});

test('without an index the proof functions behave exactly as before', () => {
  // §5.9: the existing fixtures, called with no index at all.
  assert.equal(lorebook.namesBothDistinctly('Mara was an ally of Captain Mara.', 'Mara', [], 'Captain Mara', []), true);
  assert.equal(lorebook.namesBothDistinctly('Mara was an ally of the house.', 'Mara', [], 'Captain Mara', ['Mara']), false);
  assert.equal(lorebook.namesBothDistinctly('The son of Hego Damask took the seat.', 'Damask', [], 'Hego Damask', []), false);
  assert.equal(lorebook.assertsRelationship('Aunt Mara took Tor to the market.', 'Mara', [], 'Tor', [], 'aunt of'), false);
  assert.equal(lorebook.assertsRelationship("Tor's aunt, Mara, took him.", 'Mara', [], 'Tor', [], 'aunt of'), true);
  assert.equal(lorebook.assertsRelationship('Mara was the aunt of Tor.', 'Mara', [], 'Tor', [], 'aunt of'), true);
  assert.equal(
    lorebook.relationSentenceDirection('sister of', "Asha is Bram's sister.", 'Asha', [], 'Bram', []),
    'forward',
  );
  assert.equal(
    lorebook.relationSentenceDirection('sister of', "Bram is Asha's sister.", 'Asha', [], 'Bram', []),
    'reverse',
  );
});

/* --------------------------------------------------------------- hygiene */

test('a full matching pass leaves every stored name and alias untouched', () => {
  const { db, project } = setup('variants-hygiene');
  entity(db, project.id, 'Aunt Petunia Dursley', ['Petunia']);
  entity(db, project.id, 'Dudley Dursley');
  chunk(db, project.id, 'Aunt Petunia looked over at Dudley. Petunia smiled. Dudley waved.');
  chunk(db, project.id, 'The dean of the college called for quiet.');
  const snapshot = () =>
    db.all<{ id: number; name: string; aliases: string }>(
      'SELECT id, name, aliases FROM canon_entity WHERE project_id = ? ORDER BY id',
      project.id,
    );
  const before = snapshot();

  // The read-only matching paths: quarantine, scan, note resolution, variants.
  lorebook.quarantineSuspectCharacters(db, project.id);
  lorebook.scanSentenceCandidates(db, project.id);
  lorebook.resolveAccumulatedNotes(db, project.id);
  const index = indexFor(db, project.id);
  for (const row of index.rows) deriveNameVariants(row, index);

  assert.deepEqual(snapshot(), before);
  db.close();
});

test('two runs over the same database produce identical variant maps', () => {
  const { db, project } = setup('variants-determinism');
  entity(db, project.id, 'Aunt Petunia Dursley');
  entity(db, project.id, 'Petunia Dursley');
  entity(db, project.id, 'Harry Potter');
  chunk(db, project.id, 'Petunia Dursley watched the gate. Aunt Petunia took tea.');
  const first = indexFor(db, project.id);
  const second = indexFor(db, project.id);
  const mapFor = (index: RosterIndex) =>
    Object.fromEntries(index.rows.map((row) => [row.name, deriveNameVariants(row, index)]));
  assert.deepEqual(mapFor(first), mapFor(second));
  db.close();
});

test('The Ticket Inspector derives nothing that occurs in the text', () => {
  const { db, project } = setup('variants-ticket');
  entity(db, project.id, 'The Ticket Inspector');
  entity(db, project.id, 'Mara');
  chunk(db, project.id, 'Mara bought a ticket at the station.', 1);
  chunk(db, project.id, 'The ticket inspector was a friend of Mara.', 2);
  const index = indexFor(db, project.id);

  const variants = deriveNameVariants({ name: 'The Ticket Inspector', aliases: [] }, index);
  assert.deepEqual(variants, ['ticket inspector'], 'no derived form survives the common-word filter');

  // A bare "ticket" does not sweep the character; the explicit full form still
  // matches when the text actually uses it.
  const ticketCandidates = lorebook.scanSentenceCandidates(db, project.id);
  assert.ok(
    ticketCandidates.every((candidate) => candidate.fromName !== 'The Ticket Inspector' || candidate.sentence.includes('ticket inspector')),
    'no candidate driven by the bare common word',
  );
  assert.ok(
    ticketCandidates.some(
      (candidate) =>
        (candidate.fromName === 'The Ticket Inspector' && candidate.sentence.includes('ticket inspector')) ||
        (candidate.toName === 'The Ticket Inspector' && candidate.sentence.includes('ticket inspector')),
    ),
    'the explicit full form still matches its own sentence',
  );
  db.close();
});
