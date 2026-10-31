/**
 * Benchmark harness logic: banding, direction, and the four hard criteria.
 * Generic names only — the real pair sheet is local data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bandOf,
  buildScore,
  directionFromClaim,
  evaluateCriteria,
  validate,
  EVIDENCE_FLOOR,
  type PairReport,
  type SheetPair,
} from '../trials/benchmark/validate-web.ts';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import { tempDb } from './helpers.ts';

function report(patch: Partial<PairReport> & { id: string; block: PairReport['block'] }): PairReport {
  const base: PairReport = {
    id: patch.id,
    block: patch.block,
    expect: 'none',
    aResolved: 1,
    bResolved: 2,
    samePerson: false,
    resolution: 'resolved' as const,
    candidates: '',
    expectedMiss: false,
    threads: 1,
    rootThreads: 1,
    periodThreads: 1,
    bornThreads: 0,
    periodLabels: ['-'],
    notes: 0,
    notesByBand: { '0.0-0.2': 0, '0.2-0.5': 0, '0.5-0.8': 0, '0.8-1.0': 0 },
    notesBySource: {},
    qualifyingNotes: 0,
    earlyQualifyingNotes: 0,
    births: 0,
    birthsByTrigger: {},
    maxCombinedScore: 0,
    openEnds: 0,
    collisionFlagged: false,
    collisionFlaggedDb: false,
    direction: 'none',
  };
  return { ...base, ...patch };
}

/** The sheet's shape: three stable, one early, five traps, five controls. */
function sheet(overrides: Partial<Record<string, Partial<PairReport>>> = {}): PairReport[] {
  const rows = [
    report({ id: 'S1', block: 'stable', expect: 'evidence', qualifyingNotes: 2 }),
    report({ id: 'S2', block: 'stable', expect: 'evidence', qualifyingNotes: 1 }),
    report({ id: 'S3', block: 'stable', expect: 'evidence', qualifyingNotes: 1 }),
    report({ id: 'C1', block: 'changing', expect: 'evidence', earlyQualifyingNotes: 1, qualifyingNotes: 1 }),
    report({ id: 'T1', block: 'alias', expect: 'no-birth' }),
    report({ id: 'T2', block: 'alias', expect: 'no-birth' }),
    report({ id: 'T3', block: 'alias', expect: 'collision', collisionFlagged: true }),
    report({ id: 'T4', block: 'alias', expect: 'collision', collisionFlagged: true }),
    report({ id: 'T5', block: 'alias', expect: 'no-birth' }),
    report({ id: 'A1', block: 'absent', expect: 'no-birth' }),
    report({ id: 'A2', block: 'absent', expect: 'no-birth' }),
    report({ id: 'A3', block: 'absent', expect: 'no-birth' }),
    report({ id: 'A4', block: 'absent', expect: 'no-birth' }),
    report({ id: 'A5', block: 'absent', expect: 'no-birth' }),
  ];
  return rows.map((row) => ({ ...row, ...(overrides[row.id] ?? {}) }));
}

test('bands are half-open and cover the unit range', () => {
  assert.equal(bandOf(0), '0.0-0.2');
  assert.equal(bandOf(0.2), '0.0-0.2');
  assert.equal(bandOf(0.21), '0.2-0.5');
  assert.equal(bandOf(0.5), '0.2-0.5');
  assert.equal(bandOf(0.51), '0.5-0.8');
  assert.equal(bandOf(0.8), '0.5-0.8');
  assert.equal(bandOf(0.81), '0.8-1.0');
  assert.equal(bandOf(1), '0.8-1.0');
  assert.equal(bandOf(-3), '0.0-0.2', 'clamped');
  assert.equal(bandOf(Number.NaN), '0.0-0.2', 'a missing number is never strong');
});

test('direction reads the endpoint named first, and never guesses', () => {
  assert.equal(directionFromClaim('Mara Voss met Corin Hale', 'Mara Voss', 'Corin Hale'), 'a_to_b');
  assert.equal(directionFromClaim('Corin Hale met Mara Voss', 'Mara Voss', 'Corin Hale'), 'b_to_a');
  assert.equal(directionFromClaim('the wall stood', 'Mara Voss', 'Corin Hale'), 'unordered');
  assert.equal(directionFromClaim('Mara Voss stood', 'Mara Voss', 'Corin Hale'), 'unordered');
  assert.equal(directionFromClaim('Mara Voss met Mara Voss', 'Mara Voss', 'Mara Voss'), 'unordered');
});

test('a clean sheet passes every criterion', () => {
  const evaluation = evaluateCriteria(sheet());
  assert.equal(evaluation.pass, true, evaluation.criteria.filter((c) => !c.pass).map((c) => c.detail).join('; '));
  assert.deepEqual(
    evaluation.criteria.map((c) => c.id),
    ['false-positives', 'identity', 'recall-floor', 'early-evidence'],
  );
});

test('a birth on an absent control fails the run', () => {
  const evaluation = evaluateCriteria(sheet({ A3: { births: 1, birthsByTrigger: { pooled_evidence: 1 } } }));
  assert.equal(evaluation.pass, false);
  const criterion = evaluation.criteria.find((c) => c.id === 'false-positives')!;
  assert.equal(criterion.pass, false);
  assert.match(criterion.detail, /A3/);
});

test('a birth on an alias trap fails the identity criterion', () => {
  const evaluation = evaluateCriteria(sheet({ T5: { births: 1 } }));
  assert.equal(evaluation.pass, false);
  assert.equal(evaluation.criteria.find((c) => c.id === 'identity')!.pass, false);
});

test('an unflagged same-person pair fails the identity criterion', () => {
  const evaluation = evaluateCriteria(sheet({ T4: { collisionFlagged: false } }));
  assert.equal(evaluation.pass, false);
  const criterion = evaluation.criteria.find((c) => c.id === 'identity')!;
  assert.match(criterion.detail, /T4/);
});

test('a missing recall floor fails', () => {
  const evaluation = evaluateCriteria(sheet({ S2: { qualifyingNotes: 0 } }));
  assert.equal(evaluation.pass, false);
  assert.equal(evaluation.criteria.find((c) => c.id === 'recall-floor')!.pass, false);
});

test('missing early evidence fails', () => {
  const evaluation = evaluateCriteria(sheet({ C1: { earlyQualifyingNotes: 0 } }));
  assert.equal(evaluation.pass, false);
  assert.equal(evaluation.criteria.find((c) => c.id === 'early-evidence')!.pass, false);
});

test('a sheet with no controls cannot pass vacuously', () => {
  const evaluation = evaluateCriteria([report({ id: 'S1', block: 'stable', qualifyingNotes: 1 })]);
  assert.equal(evaluation.pass, false);
  assert.equal(evaluation.criteria.find((c) => c.id === 'false-positives')!.pass, false);
});

test('the evidence floor is the documented value', () => {
  assert.equal(EVIDENCE_FLOOR, 0.35);
});

test('an ambiguous pair is excluded from note and birth evaluation', () => {
  const evaluation = evaluateCriteria(
    sheet({ S2: { resolution: 'ambiguous', notes: 0, qualifyingNotes: 0, births: 0, threads: 0 } }),
  );
  // Ambiguity never manufactures a birth, so precision still holds; the recall
  // floor is what an unresolved pair costs.
  assert.equal(evaluation.criteria.find((c) => c.id === 'false-positives')!.pass, true);
  assert.equal(evaluation.criteria.find((c) => c.id === 'recall-floor')!.pass, false);
});

test('an absent control is an expected miss, not a failure', () => {
  const evaluation = evaluateCriteria(
    sheet({ A4: { resolution: 'absent', expectedMiss: true, threads: 0, notes: 0, births: 0 } }),
  );
  assert.equal(evaluation.criteria.find((c) => c.id === 'false-positives')!.pass, true);
  assert.equal(evaluation.pass, true);
});

test('an absent name on a recall pair still fails the floor', () => {
  const evaluation = evaluateCriteria(
    sheet({ S3: { resolution: 'absent', qualifyingNotes: 0, notes: 0 } }),
  );
  assert.equal(evaluation.criteria.find((c) => c.id === 'recall-floor')!.pass, false);
});

test('the score line has exactly the named keys and integers only', () => {
  const reports = sheet();
  const evaluation = evaluateCriteria(reports);
  const score = buildScore(reports, evaluation, { bornThreads: 3, bornSubjects: 2, duplicateBornSubjects: 1 });
  assert.deepEqual(Object.keys(score), [
    'criteriaPassed',
    'criteriaTotal',
    'absentBirths',
    'trapBirths',
    'trapFlagged',
    'recallS1S3',
    'c1Evidence',
    'resolved',
    'ambiguous',
    'absent',
    'bornThreads',
    'bornSubjects',
    'duplicateBornSubjects',
    'trapFlaggedData',
    'trapFlaggedDb',
  ]);
  assert.ok(Object.values(score).every((value) => Number.isInteger(value)));
  const parsed = JSON.parse(JSON.stringify(score)) as Record<string, number>;
  assert.deepEqual(parsed, score);
  assert.equal(score.criteriaTotal, 4);
  assert.equal(score.criteriaPassed, 4);
  assert.equal(score.duplicateBornSubjects, 1);
});

test('criteriaPassed drops when a criterion fails, so the exit rule follows', () => {
  const reports = sheet({ A2: { births: 1 } });
  const evaluation = evaluateCriteria(reports);
  const score = buildScore(reports, evaluation, { bornThreads: 0, bornSubjects: 0, duplicateBornSubjects: 0 });
  assert.equal(score.criteriaPassed, 3);
  assert.equal(score.absentBirths, 1);
  assert.equal(score.criteriaPassed === score.criteriaTotal, false);
  assert.equal(evaluation.pass, false);
});

/* ------------------------------------------- order independence (read-only) */

const AT2 = '2026-01-01T00:00:00.000Z';

function fixtureDb(
  name: string,
  entities: { name: string; reviewStatus?: string; reason?: string }[],
): { db: ReturnType<typeof tempDb>['db']; project: number } {
  const { db } = tempDb();
  const project = createProject(db, name);
  const source = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      project.id,
      '/web-validate-probe',
      'Probe',
      'sha-webvalidate',
      AT2,
    ).lastInsertRowid,
  );
  db.run(
    `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
     VALUES (?, ?, 1, 'p. 1', '', 'The order kept its own counsel.', 6)`,
    source,
    project.id,
  );
  for (const entity of entities) {
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, quarantine_reason, created_at, updated_at)
       VALUES (?, 'character', ?, '[]', '', '', 1, '', '[]', ?, ?, ?, ?)`,
      project.id,
      entity.name,
      entity.reviewStatus ?? 'accepted',
      entity.reason ?? '',
      AT2,
      AT2,
    );
  }
  return { db, project: project.id };
}

const ALIAS_SHEET: SheetPair[] = [
  { id: 'T1', a: 'Voss', b: 'Captain Voss', block: 'alias', expect: 'collision' },
];

test('a clean copy with colliding names still counts as flagged', () => {
  const { db, project } = fixtureDb('order-clean-flag', [
    { name: 'Voss', reviewStatus: 'accepted' },
    { name: 'Captain Voss', reviewStatus: 'accepted' },
  ]);
  const { reports } = validate(db, project, ALIAS_SHEET);
  assert.equal(reports[0]!.collisionFlagged, true, 'the names collide');
  assert.equal(reports[0]!.collisionFlaggedDb, false, 'nothing was written');
  const score = buildScore(reports, evaluateCriteria(reports), {
    bornThreads: 0,
    bornSubjects: 0,
    duplicateBornSubjects: 0,
  });
  assert.equal(score.trapFlagged, 1);
  assert.equal(score.trapFlaggedData, 1);
  assert.equal(score.trapFlaggedDb, 0);
  db.close();
});

test('a written flag on names that do not collide is not counted', () => {
  const { db, project } = fixtureDb('order-stale-flag', [
    { name: 'Mara Voss', reviewStatus: 'needs_review', reason: 'identity-collision: 2' },
    { name: 'Corin Hale', reviewStatus: 'needs_review', reason: 'identity-collision: 1' },
  ]);
  const { reports } = validate(db, project, [
    { id: 'T1', a: 'Mara Voss', b: 'Corin Hale', block: 'alias', expect: 'no-birth' },
  ]);
  assert.equal(reports[0]!.collisionFlagged, false, 'the data says distinct people');
  assert.equal(reports[0]!.collisionFlaggedDb, true, 'the stored flag is still reported');
  const score = buildScore(reports, evaluateCriteria(reports), {
    bornThreads: 0,
    bornSubjects: 0,
    duplicateBornSubjects: 0,
  });
  assert.equal(score.trapFlagged, 0);
  assert.equal(score.trapFlaggedData, 0);
  assert.equal(score.trapFlaggedDb, 1);
  db.close();
});
