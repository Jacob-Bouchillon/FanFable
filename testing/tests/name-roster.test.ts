/**
 * Name roster: capitalized runs harvested twice, no model calls.
 * Invented prose only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import * as controller from '../../fanfable/src/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

const EMPTY_DIAGNOSTICS: lorebook.NameRosterDiagnostics = {
  sentenceInitialCandidates: 0,
  accepted: 0,
  rejected: 0,
  topRejected: [],
  quotedStarts: 0,
  rejectedInvalid: 0,
  rejectedContraction: 0,
  rejectedFunctionWord: 0,
  rejectedTitleOnly: 0,
  rejectedCommonWord: 0,
  rejectedStoplist: 0,
  rejectedNoMidSentence: 0,
};

function addChunk(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  text: string,
  seq = 1,
): number {
  const existing = db.get<{ id: number }>('SELECT id FROM canon_source WHERE project_id = ? LIMIT 1', projectId);
  const sourceId = existing?.id ?? db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    projectId,
    '/probe-source',
    'Probe',
    'sha-probe',
    AT,
  ).lastInsertRowid;
  return db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId,
    projectId,
    seq,
    `p. ${seq}`,
    '',
    text,
    text.split(/\s+/).length,
  ).lastInsertRowid;
}

function projectWith(text: string, name = 'roster') {
  const { db } = tempDb();
  const project = controller.createProject(db, name);
  addChunk(db, project.id, text);
  return { db, project };
}

function entry(roster: lorebook.NameRoster, surface: string) {
  return roster.entries.find((row) => row.surface === surface);
}

test('a name seen mid-sentence is accepted at a later sentence start', () => {
  const { db, project } = projectWith(
    'Asha met Rook at the gate. Rook waited outside.',
  );
  const roster = lorebook.buildNameRoster(db, project.id);
  const rook = entry(roster, 'Rook');
  assert.ok(rook);
  assert.equal(rook!.count, 2);
  assert.equal(rook!.trustedSource, 'mid-sentence');
  assert.deepEqual(rook!.tokens, ['rook']);
  assert.equal(roster.diagnostics.sentenceInitialCandidates, 2);
  assert.equal(roster.diagnostics.accepted, 1);
  assert.equal(roster.diagnostics.rejected, 1);
  db.close();
});

test('a possessive harvests the base token', () => {
  const { db, project } = projectWith(
    "Asha borrowed Corin's lantern. Corin's answer was quick.",
  );
  const roster = lorebook.buildNameRoster(db, project.id);
  const corin = entry(roster, 'Corin');
  assert.ok(corin);
  assert.deepEqual(corin!.tokens, ['corin']);
  assert.equal(corin!.count, 2);
  db.close();
});

test('a multi-word run extends to the longest capitalized surface', () => {
  const { db, project } = projectWith(
    'They followed Bram Hollow north. Bram Hollow waited there.',
  );
  const roster = lorebook.buildNameRoster(db, project.id);
  const name = entry(roster, 'Bram Hollow');
  assert.ok(name);
  assert.deepEqual(name!.tokens, ['bram', 'hollow']);
  assert.equal(name!.count, 2);
  assert.equal(roster.diagnostics.accepted, 1);
  db.close();
});

test('a sentence start absent from the mid-sentence set is rejected', () => {
  const { db, project } = projectWith('Mara crossed the yard.');
  const roster = lorebook.buildNameRoster(db, project.id);
  assert.equal(roster.entries.length, 0);
  assert.deepEqual(
    {
      candidates: roster.diagnostics.sentenceInitialCandidates,
      accepted: roster.diagnostics.accepted,
      rejected: roster.diagnostics.rejected,
    },
    { candidates: 1, accepted: 0, rejected: 1 },
  );
  assert.deepEqual(roster.diagnostics.topRejected, [{ surface: 'Mara', count: 1 }]);
  db.close();
});

test('the starter stoplist rejects However even when its token was seen', () => {
  const { db, project } = projectWith(
    'Asha said However quietly. However Rook arrived.',
  );
  const roster = lorebook.buildNameRoster(db, project.id);
  assert.equal(roster.diagnostics.accepted, 0);
  assert.equal(entry(roster, 'However Rook'), undefined);
  assert.ok(roster.diagnostics.topRejected.some((row) => row.surface === 'However Rook'));
  db.close();
});

test('heading text is excluded from both passes', () => {
  const { db, project } = projectWith('# Mara Vell\n\nAsha met Mara Vell.');
  const roster = lorebook.buildNameRoster(db, project.id);
  const name = entry(roster, 'Mara Vell');
  assert.ok(name);
  assert.equal(name!.count, 1);
  assert.equal(name!.trustedSource, 'mid-sentence');
  assert.equal(roster.diagnostics.accepted, 0);
  assert.equal(roster.diagnostics.sentenceInitialCandidates, 1);
  db.close();
});

test('diagnostics add up and top rejected is ordered by count', () => {
  const { db, project } = projectWith(
    'Asha met Rook at the gate. Rook waited outside. However Bram Hollow arrived. Corin answered softly.',
  );
  const roster = lorebook.buildNameRoster(db, project.id);
  assert.equal(roster.diagnostics.sentenceInitialCandidates, 4);
  assert.equal(roster.diagnostics.accepted, 1);
  assert.equal(roster.diagnostics.rejected, 3);
  assert.equal(
    roster.diagnostics.accepted + roster.diagnostics.rejected,
    roster.diagnostics.sentenceInitialCandidates,
  );
  assert.ok(roster.diagnostics.topRejected.length <= 20);
  assert.equal(entry(roster, 'Rook')!.count, 2);
  db.close();
});

test('the window list adds a roster-only name with no banked entity', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'roster-window');
  addChunk(db, project.id, 'Asha met Rook at the gate.', 1);
  const windowChunk = addChunk(db, project.id, 'Rook waited outside.', 2);
  const roster = lorebook.buildNameRoster(db, project.id);
  const window = db.all<lorebook.ChunkRow>(
    `SELECT c.id, c.seq, c.heading, c.locator, c.text, s.title AS source_title, s.path, c.source_id
       FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id WHERE c.id = ?`,
    windowChunk,
  );
  const names = lorebook.windowEntityNames(db, project.id, window, roster);
  assert.deepEqual(names, ['Rook']);
  db.close();
});

test('the window list dedupes case-insensitively and caps at 80', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'roster-cap');
  const surfaces = Array.from({ length: 100 }, (_, i) => `Name${i}`);
  const chunk = addChunk(db, project.id, surfaces.join(' '));
  const window = db.all<lorebook.ChunkRow>(
    `SELECT c.id, c.seq, c.heading, c.locator, c.text, s.title AS source_title, s.path, c.source_id
       FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id WHERE c.id = ?`,
    chunk,
  );
  const roster: lorebook.NameRoster = {
    entries: surfaces.map((surface) => ({
      surface,
      surfaces: [surface],
      tokens: [surface.toLowerCase()],
      count: 1,
      trustedSource: 'mid-sentence' as const,
    })),
    diagnostics: EMPTY_DIAGNOSTICS,
  };
  const names = lorebook.windowEntityNames(db, project.id, window, roster);
  assert.equal(names.length, lorebook.WINDOW_NAME_CAP);
  assert.equal(lorebook.WINDOW_NAME_CAP, 80);
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length);
  db.close();
});

test('the bank list keeps its old 60 names and the roster fills the raised cap', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'roster-bank-cap');
  const keepers = Array.from({ length: 70 }, (_, i) => `Keeper${i}`);
  const extras = Array.from({ length: 30 }, (_, i) => `Extra${i}`);
  for (const name of keepers) {
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, 'character', ?, '[]', '', '', 1, '', '[]', 'accepted', ?, ?)`,
      project.id,
      name,
      AT,
      AT,
    );
  }
  const chunk = addChunk(db, project.id, [...keepers, ...extras].join(' '));
  const window = db.all<lorebook.ChunkRow>(
    `SELECT c.id, c.seq, c.heading, c.locator, c.text, s.title AS source_title, s.path, c.source_id
       FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id WHERE c.id = ?`,
    chunk,
  );
  const roster: lorebook.NameRoster = {
    entries: extras.map((surface, i) => ({
      surface,
      surfaces: [surface],
      tokens: [surface.toLowerCase()],
      count: 100 - i,
      trustedSource: 'mid-sentence' as const,
    })),
    diagnostics: EMPTY_DIAGNOSTICS,
  };
  const names = lorebook.windowEntityNames(db, project.id, window, roster);
  const bankOnly = lorebook.windowEntityNames(db, project.id, window);
  assert.equal(names.length, 80);
  assert.equal(bankOnly.length, 60);
  // The bank contribution is exactly the list it had before the roster.
  assert.deepEqual(names.slice(0, 60), bankOnly);
  assert.equal(names.filter((name) => name.startsWith('Keeper')).length, 60);
  for (let i = 0; i < 20; i++) assert.ok(names.includes(`Extra${i}`));
  assert.ok(!names.includes('Extra20'));
  db.close();
});

test('the CLI prints the roster and its diagnostics', () => {
  const { db, path } = tempDb();
  const project = controller.createProject(db, 'roster-cli');
  addChunk(db, project.id, 'Asha met Rook at the gate. Rook waited outside.');
  const cli = resolve(import.meta.dirname, '../../fanfable/src/cli.ts');
  const out = execFileSync(
    process.execPath,
    ['--no-warnings', cli, '--db', path, '--project', project.name, 'lore', 'names', '--limit', '5', '--diagnostics'],
    { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8' },
  );
  assert.match(out, /Name roster/);
  assert.match(out, /1 surfaces/);
  assert.match(out, /Rook/);
  assert.match(out, /sentence-initial candidates 2, accepted 1, rejected 1/);
  assert.match(out, /top rejected:/);
  db.close();
});

test('a capital after an opening quote is sentence-initial, not mid-sentence', () => {
  const { db, project } = projectWith('Asha said, "Quillon waited."');
  const roster = lorebook.buildNameRoster(db, project.id);
  assert.equal(entry(roster, 'Quillon'), undefined);
  assert.ok(roster.diagnostics.rejectedNoMidSentence >= 1);
  assert.ok(roster.diagnostics.quotedStarts >= 1);
  db.close();
});

test('function words are rejected in the mid-sentence pass', () => {
  const { db, project } = projectWith('Asha said, "And waited." Asha said, "The gate."');
  const roster = lorebook.buildNameRoster(db, project.id);
  assert.equal(entry(roster, 'And'), undefined);
  assert.equal(entry(roster, 'The'), undefined);
  assert.ok(roster.diagnostics.rejectedFunctionWord >= 2);
  db.close();
});

test("a contraction is rejected", () => {
  const { db, project } = projectWith('Asha said, "Don\'t wait."');
  const roster = lorebook.buildNameRoster(db, project.id);
  assert.equal(entry(roster, "Don't"), undefined);
  assert.ok(roster.diagnostics.rejectedContraction >= 1);
  db.close();
});

test('a lone title is rejected but a title followed by a name is kept', () => {
  const { db, project } = projectWith('Asha met Lord Asha at the gate. "Lord waited."');
  const roster = lorebook.buildNameRoster(db, project.id);
  assert.equal(entry(roster, 'Lord'), undefined);
  assert.ok(entry(roster, 'Lord Asha'));
  assert.ok(roster.diagnostics.rejectedTitleOnly >= 1);
  db.close();
});

test('a lone common word used lowercase in the chunk is rejected', () => {
  const { db, project } = projectWith('Asha said, "Bring the lantern. bring it here."');
  const roster = lorebook.buildNameRoster(db, project.id);
  assert.equal(entry(roster, 'Bring'), undefined);
  assert.ok(roster.diagnostics.rejectedCommonWord >= 1);
  db.close();
});

test('title variants collapse into one entry carrying every surface', () => {
  const { db, project } = projectWith('Asha met Ashaline at the gate. Lady Ashaline waited.');
  const roster = lorebook.buildNameRoster(db, project.id);
  const group = roster.entries.filter((row) => row.surfaces.some((surface) => surface.toLowerCase() === 'ashaline'));
  assert.equal(group.length, 1);
  assert.deepEqual([...group[0]!.surfaces].sort(), ['Ashaline', 'Lady Ashaline'].sort());
  assert.equal(group[0]!.count, 2);
  db.close();
});

test('per-rule rejection counts add up to the rejected candidates', () => {
  const { db, project } = projectWith(
    'Asha said, "And waited." "Don\'t wait." "Lord waited." "Bring the lantern. bring it here." "Quillon watched."',
  );
  const roster = lorebook.buildNameRoster(db, project.id);
  const d = roster.diagnostics;
  assert.equal(d.accepted + d.rejected, d.sentenceInitialCandidates);
  assert.equal(
    d.rejectedInvalid +
      d.rejectedContraction +
      d.rejectedFunctionWord +
      d.rejectedTitleOnly +
      d.rejectedCommonWord +
      d.rejectedStoplist +
      d.rejectedNoMidSentence,
    d.rejected,
  );
  assert.ok(d.rejectedFunctionWord >= 1);
  assert.ok(d.rejectedContraction >= 1);
  assert.ok(d.rejectedTitleOnly >= 1);
  assert.ok(d.rejectedCommonWord >= 1);
  assert.ok(d.rejectedNoMidSentence >= 1);
  db.close();
});
