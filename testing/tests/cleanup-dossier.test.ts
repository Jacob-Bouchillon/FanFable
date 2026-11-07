/**
 * Synthetic, book-neutral cleanup and dossier proof.
 *
 * The fixture uses different names, a heading paragraph that disagrees with
 * the stored chapter, a pet, a nickname, a typo and a card-only figure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import { deriveChapterNumbers, parseChapterHeading } from '../../fanfable/src/answer/chapters.ts';
import { characterDossier, entityMentionStatus } from '../../fanfable/src/answer/dossier.ts';
import { findNicknameAliases, findOwnershipClaims, findTypoVariants } from '../../fanfable/src/identity/cleanup.ts';
import { insertRelation } from '../../fanfable/src/lorebook.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function source(db: ReturnType<typeof tempDb>['db'], projectId: number): number {
  return Number(db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    projectId, '/synthetic', 'Synthetic Book', 'sha', AT,
  ).lastInsertRowid);
}

function chunk(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  sourceId: number,
  seq: number,
  locator: string,
  heading: string,
  text: string,
): number {
  return Number(db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId, projectId, seq, locator, heading, text, text.split(/\s+/).length,
  ).lastInsertRowid);
}

function entity(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  name: string,
  kind = 'character',
): number {
  return Number(db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    projectId, kind, name, '[]', AT, AT,
  ).lastInsertRowid);
}

function event(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  seq: number,
  title: string,
  participants: string[],
  evidence: string,
  chunkId: number,
): void {
  db.run(
    `INSERT INTO canon_timeline
       (project_id, seq, title, summary, participants, evidence, source_refs, created_at)
     VALUES (?, ?, ?, '', ?, ?, ?, ?)`,
    projectId, seq, title, JSON.stringify(participants), evidence,
    JSON.stringify([{ locator: 'Chapter 1', chunk: chunkId }]), AT,
  );
}

function synthetic(): {
  db: ReturnType<typeof tempDb>['db'];
  projectId: number;
  ids: Record<string, number>;
} {
  const { db } = tempDb();
  const project = createProject(db, 'synthetic-cleanup');
  const sourceId = source(db, project.id);
  const first = chunk(
    db, project.id, sourceId, 1, 'Chapter 1', 'Chapter 1',
    "Chapter 1\nA Quiet Road\n\nAlderic's old cat Bramble slept. Alderic Vane watched. \"Bramble, stay close,\" he said.\nHermione Granger watched. Hermione Granger waited. Hermione Granger left.",
  );
  const second = chunk(
    db, project.id, sourceId, 2, 'Chapter 1', 'Chapter 1',
    '2.\nThe Long Night\n\nCorin Vale met Alderic Vane. "Corinikins, wait!" said Corin.\nHermlone followed.',
  );
  const third = chunk(
    db, project.id, sourceId, 3, 'Chapter 1', 'Chapter 1',
    'The card showed Saint Rook, a figure from legend.',
  );
  const fourth = chunk(
    db, project.id, sourceId, 4, 'Chapter 3', 'Chapter 3',
    'Chapter 3\nA Bright Morning\n\nAlderic Vane and Bramble slept.',
  );

  const ids = {
    alderic: entity(db, project.id, 'Alderic Vane'),
    bramble: entity(db, project.id, 'Bramble', 'creature'),
    corin: entity(db, project.id, 'Corin Vale'),
    corinikins: entity(db, project.id, 'Corinikins'),
    rook: entity(db, project.id, 'Saint Rook'),
    hermione: entity(db, project.id, 'Hermione Granger'),
    hermlone: entity(db, project.id, 'Hermlone'),
    cat: entity(db, project.id, 'cat', 'species'),
  };

  event(db, project.id, 1, 'Alderic Vane walks with Bramble', ['Alderic Vane', 'Bramble'], "Alderic's old cat Bramble slept.", first);
  event(db, project.id, 2, 'Sorting ceremony', ['Alderic Vane', 'Bramble', 'Corin Vale', 'Saint Rook', 'Hermione Granger'], 'The hall filled.', second);
  event(db, project.id, 3, 'Alderic Vane meets Corin Vale', ['Alderic Vane', 'Corin Vale', 'Bramble'], 'Corin Vale met Alderic Vane.', second);

  insertRelation(db, project.id, {
    fromEntity: ids.alderic,
    toEntity: ids.bramble,
    kind: 'owner of',
    evidence: "Alderic's old cat Bramble slept.",
    sourceRefs: JSON.stringify([{ locator: 'Chapter 1', chunk: first }]),
    reviewStatus: 'needs_review',
  });
  return { db, projectId: project.id, ids };
}

test('heading paragraphs win over a stale stored chapter, and even splits exist', () => {
  assert.deepEqual(parseChapterHeading('Chapter 7'), { number: 7, title: '' });
  assert.deepEqual(parseChapterHeading('VII', 'The Long Night'), { number: 7, title: 'The Long Night' });
  assert.deepEqual(parseChapterHeading('2.', 'The Long Night'), { number: 2, title: 'The Long Night' });

  const { db, projectId } = synthetic();
  const chunks = db.all<{ id: number; seq: number; heading: string; locator: string; text: string }>(
    'SELECT id, seq, heading, locator, text FROM canon_chunk WHERE project_id = ? ORDER BY seq',
    projectId,
  );
  const map = deriveChapterNumbers(chunks);
  assert.equal(map.get(chunks[0]!.id)!.chapter, 1);
  assert.equal(map.get(chunks[1]!.id)!.chapter, 2, '2. in the text wins over the stored Chapter 1');
  assert.equal(map.get(chunks[3]!.id)!.chapter, 3);

  const plain = Array.from({ length: 40 }, (_, index) => ({
    id: index + 1, seq: index + 1, heading: '', locator: '', text: `Plain passage ${index + 1}.`,
  }));
  const split = deriveChapterNumbers(plain, { chapterCount: 4 });
  assert.equal(split.get(1)!.chapter, 1);
  assert.equal(split.get(40)!.chapter, 4);
  db.close();
});

test('typo, nickname and ownership rules are text-driven, not name lists', () => {
  const { db, projectId } = synthetic();
  const typos = findTypoVariants(db, projectId);
  const hermlone = typos.find((entry) => entry.name === 'Hermlone');
  assert.equal(hermlone?.canonicalName, 'Hermione Granger');

  const nicknames = findNicknameAliases(db, projectId);
  const corinikins = nicknames.find((entry) => entry.name === 'Corinikins');
  assert.equal(corinikins?.personName, 'Corin Vale');

  const claims = findOwnershipClaims(db, projectId);
  const cat = claims.find((claim) => claim.possessed.includes('cat'));
  assert.equal(cat?.owner, 'Alderic');
  db.close();
});

test('the dossier computes events, chapters and appears/mentioned without stored roles', () => {
  const { db, projectId, ids } = synthetic();
  const alderic = characterDossier(db, projectId, ids.alderic);
  assert.equal(alderic?.status, 'appears');
  assert.equal(alderic?.firstChapter, 1);
  assert.equal(alderic?.lastChapter, 3);
  assert.ok(alderic!.relations.some((relation) => relation.kind === 'owner of'));
  assert.ok(alderic!.events.some((entry) => entry.title.includes('walks with Bramble')));
  assert.ok(!alderic!.events.some((entry) => entry.title === 'Sorting ceremony'), 'generic events are dropped');

  const rook = characterDossier(db, projectId, ids.rook);
  assert.equal(rook?.status, 'mentioned');
  assert.equal(entityMentionStatus(db, projectId, ids.rook), 'mentioned');
  assert.equal(entityMentionStatus(db, projectId, ids.alderic), 'appears');
  db.close();
});
