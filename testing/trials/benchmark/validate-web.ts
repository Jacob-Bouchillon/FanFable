/**
 * Validate the evidence web against a locked pair sheet.
 *
 * Read-only: this script opens a database copy and reports. It never writes a
 * row, never calls a model and never tunes a threshold. If the web is wrong,
 * the point is to say so.
 *
 * Usage:
 *   node --experimental-strip-types testing/trials/benchmark/validate-web.ts <db-copy> <project> <pairs.json>
 *
 * The pair sheet is local data (gitignored), so no book names live in this
 * file. Only pair names and counts are printed — never a quote or passage.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Db } from '../../../fanfable/src/db.ts';
import { NAME_DF_CAP, nameRelation } from '../../../fanfable/src/names.ts';
import {
  NAME_GROUP_CAP,
  containedCount,
  createResolver,
  entityForms,
  loadIdentityContext,
  usableShortForm,
  type IdentityContext,
  type ResolutionStatus,
} from '../../../fanfable/src/identity.ts';

export type Band = '0.0-0.2' | '0.2-0.5' | '0.5-0.8' | '0.8-1.0';
export const BANDS: Band[] = ['0.0-0.2', '0.2-0.5', '0.5-0.8', '0.8-1.0'];

export function bandOf(strength: number): Band {
  const s = Math.min(1, Math.max(0, Number(strength) || 0));
  if (s <= 0.2) return '0.0-0.2';
  if (s <= 0.5) return '0.2-0.5';
  if (s <= 0.8) return '0.5-0.8';
  return '0.8-1.0';
}

/**
 * Which way a claim reads, mechanically: the endpoint named first wins.
 * 'unordered' when only one (or neither) name appears — never a guess.
 */
export function directionFromClaim(
  claim: string,
  aName: string,
  bName: string,
): 'a_to_b' | 'b_to_a' | 'unordered' {
  const text = String(claim ?? '').toLowerCase();
  const a = aName.trim().toLowerCase();
  const b = bName.trim().toLowerCase();
  if (!a || !b || a === b) return 'unordered';
  const atA = text.indexOf(a);
  const atB = text.indexOf(b);
  if (atA < 0 || atB < 0) return 'unordered';
  return atA < atB ? 'a_to_b' : 'b_to_a';
}

export interface SheetPair {
  id: string;
  a: string;
  b: string;
  block: 'stable' | 'changing' | 'alias' | 'absent';
  expect: 'evidence' | 'no-birth' | 'collision' | 'none';
}

export interface PairReport {
  id: string;
  block: SheetPair['block'];
  expect: SheetPair['expect'];
  resolution: ResolutionStatus;
  /** Why a pair could not be resolved, with candidate ids. */
  candidates: string;
  aResolved: number | null;
  bResolved: number | null;
  samePerson: boolean;
  /** An absent name in a control block is the expected state, not an error. */
  expectedMiss: boolean;
  threads: number;
  rootThreads: number;
  periodThreads: number;
  bornThreads: number;
  periodLabels: string[];
  notes: number;
  notesByBand: Record<Band, number>;
  notesBySource: Record<string, number>;
  qualifyingNotes: number;
  earlyQualifyingNotes: number;
  births: number;
  birthsByTrigger: Record<string, number>;
  maxCombinedScore: number;
  openEnds: number;
  /** Collision computed from the names themselves, never from stored status. */
  collisionFlagged: boolean;
  /** The same question answered from `review_status` (reported, not scored). */
  collisionFlaggedDb: boolean;
  direction: 'a_to_b' | 'b_to_a' | 'unordered' | 'none';
}

export interface Criterion {
  id: string;
  title: string;
  pass: boolean;
  detail: string;
}

export interface Evaluation {
  criteria: Criterion[];
  pass: boolean;
}

/** The floor a note must clear to count as evidence for recall. */
export const EVIDENCE_FLOOR = 0.35;

/**
 * The four hard criteria.
 *
 * Unchanged from the milestone that introduced them. Each is evaluated from the
 * per-pair reports only, so the same function can be driven by synthetic rows in
 * a test — including a row that must fail.
 */
export function evaluateCriteria(reports: PairReport[]): Evaluation {
  const byId = new Map(reports.map((r) => [r.id, r]));
  const absent = reports.filter((r) => r.block === 'absent');
  const alias = reports.filter((r) => r.block === 'alias');

  const falsePositives = absent.filter((r) => r.births > 0);
  const c1: Criterion = {
    id: 'false-positives',
    title: 'zero births on absent controls',
    pass: absent.length > 0 && falsePositives.length === 0,
    detail:
      absent.length === 0
        ? 'no absent controls in the sheet'
        : falsePositives.length
          ? `births on ${falsePositives.map((r) => `${r.id}(${r.births})`).join(', ')}`
          : `0 births across ${absent.length} controls`,
  };

  const aliasBirths = alias.filter((r) => r.births > 0);
  const mustFlag = ['T3', 'T4'].filter((id) => {
    const row = byId.get(id);
    return row ? !row.collisionFlagged : true;
  });
  const c2: Criterion = {
    id: 'identity',
    title: 'alias traps never birth, and the same-person pairs are flagged',
    pass: alias.length > 0 && aliasBirths.length === 0 && mustFlag.length === 0,
    detail: [
      alias.length === 0 ? 'no alias traps in the sheet' : `0 births across ${alias.length} traps`,
      mustFlag.length ? `not flagged: ${mustFlag.join(', ')}` : 'T3/T4 flagged identity-collision',
      aliasBirths.length ? `births on ${aliasBirths.map((r) => r.id).join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; '),
  };

  const recall = ['S1', 'S2', 'S3'].map((id) => byId.get(id)).filter(Boolean) as PairReport[];
  const recallMisses = recall.filter((r) => r.qualifyingNotes < 1);
  const c3: Criterion = {
    id: 'recall-floor',
    title: 'S1-S3 each hold a note at or above the floor',
    pass: recall.length === 3 && recallMisses.length === 0,
    detail: recallMisses.length
      ? `no note >= ${EVIDENCE_FLOOR} on ${recallMisses.map((r) => r.id).join(', ')}`
      : recall.map((r) => `${r.id}:${r.qualifyingNotes}`).join(', '),
  };

  const early = byId.get('C1');
  const c4: Criterion = {
    id: 'early-evidence',
    title: 'C1 holds a note at or above the floor on the early book',
    pass: Boolean(early && early.earlyQualifyingNotes >= 1),
    detail: early
      ? `C1 early qualifying notes: ${early.earlyQualifyingNotes}`
      : 'C1 missing from the sheet',
  };

  const criteria = [c1, c2, c3, c4];
  return { criteria, pass: criteria.every((c) => c.pass) };
}

/* -------------------------------------------------------------------- main */

/** Mirrors the title list `identity-check` uses. Titles identify nobody. */
const TITLE_TOKENS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'sir', 'lady', 'lord', 'master', 'mistress', 'captain', 'commander',
  'general', 'admiral', 'colonel', 'major', 'sergeant', 'king', 'queen', 'prince', 'princess',
  'emperor', 'empress', 'count', 'countess', 'duke', 'duchess', 'baron', 'boss', 'senator',
  'chancellor', 'viceroy', 'magister', 'aunt', 'uncle', 'great', 'father', 'mother',
  'brother', 'sister', 'son', 'daughter', 'clan',
]);

/**
 * Are two entities the same identity, judged from their names alone?
 *
 * This is the read-only counterpart of the collision pass: it never looks at
 * `review_status`, so a copy scores the same whether or not `identity-check`
 * has run on it.
 */
export function sameIdentityByData(
  context: IdentityContext,
  leftId: number,
  rightId: number,
  memo: Map<string, number> = new Map(),
): boolean {
  const left = context.entities.find((entity) => entity.id === leftId);
  const right = context.entities.find((entity) => entity.id === rightId);
  if (!left || !right) return false;
  const leftForms = entityForms(left);
  const rightForms = entityForms(right);

  // One canonical form held by both rows is a collision on its face.
  const leftSet = new Set(leftForms);
  if (rightForms.some((form) => leftSet.has(form))) return true;

  for (const a of leftForms) {
    for (const b of rightForms) {
      if (nameRelation(a, b) !== 'containment') continue;
      const aTokens = a.split(' ').filter(Boolean);
      const bTokens = b.split(' ').filter(Boolean);
      const short = aTokens.length < bTokens.length ? a : b;
      const contained = containedCount(short, context.entities, memo);
      if (usableShortForm(short, context.index, contained, (token) => TITLE_TOKENS.has(token))) {
        return true;
      }
    }
  }
  return false;
}

export function validate(
  db: Db,
  projectId: number,
  sheet: SheetPair[],
): { reports: PairReport[]; evaluation: Evaluation } {
  const context = loadIdentityContext(db, projectId);
  const resolver = createResolver(context);
  const containedMemo = new Map<string, number>();
  const chunks = db.all<{ id: number; seq: number }>('SELECT id, seq FROM canon_chunk WHERE project_id = ?', projectId);
  const seqOf = new Map(chunks.map((c) => [c.id, c.seq]));
  const maxSeq = chunks.reduce((max, c) => Math.max(max, c.seq), 0);
  const earlyLimit = Math.ceil(maxSeq / 3);

  const reports: PairReport[] = [];
  for (const pair of sheet) {
    const resolved = resolver.resolvePair(pair.a, pair.b);
    const candidates = [resolved.a, resolved.b]
      .filter((side) => side.status === 'ambiguous')
      .map((side) => side.candidates.map((c) => `${c.id}:${c.name}`).join('|'))
      .join(' vs ');
    const emptyBands = (): Record<Band, number> =>
      ({ '0.0-0.2': 0, '0.2-0.5': 0, '0.5-0.8': 0, '0.8-1.0': 0 }) as Record<Band, number>;
    const report: PairReport = {
      id: pair.id,
      block: pair.block,
      expect: pair.expect,
      resolution: resolved.status,
      candidates,
      aResolved: resolved.a.id,
      bResolved: resolved.b.id,
      samePerson: resolved.a.id !== null && resolved.a.id === resolved.b.id,
      expectedMiss:
        resolved.status === 'absent' && (pair.block === 'absent' || pair.expect === 'none'),
      threads: 0,
      rootThreads: 0,
      periodThreads: 0,
      bornThreads: 0,
      periodLabels: [],
      notes: 0,
      notesByBand: emptyBands(),
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

    const entities = db.all<{ id: number; quarantine_reason: string | null }>(
      'SELECT id, quarantine_reason FROM canon_entity WHERE project_id = ? AND id IN (?, ?)',
      projectId,
      resolved.a.id ?? -1,
      resolved.b.id ?? -1,
    );
    report.collisionFlaggedDb = entities.some((entity) =>
      String(entity.quarantine_reason ?? '').includes('identity-collision'),
    );
    // Scored value: computed from the names, so pipeline order cannot change it.
    report.collisionFlagged =
      resolved.a.id !== null && resolved.b.id !== null && resolved.a.id !== resolved.b.id
        ? sameIdentityByData(context, resolved.a.id, resolved.b.id, containedMemo)
        : resolved.a.id !== null && resolved.a.id === resolved.b.id;

    // Ambiguous and absent pairs are reported and excluded from note/birth
    // evaluation: there is no pair thread to read until the name resolves.
    if (resolved.status === 'resolved' && resolved.a.id !== null && resolved.b.id !== null && !report.samePerson) {
      const lo = Math.min(resolved.a.id, resolved.b.id);
      const hi = Math.max(resolved.a.id, resolved.b.id);
      const threads = db.all<{ id: number; period_label: string; parent_a_thread: number | null }>(
        `SELECT id, period_label, parent_a_thread FROM canon_thread
          WHERE project_id = ? AND kind = 'pair' AND a_entity = ? AND b_entity = ?
          ORDER BY id`,
        projectId,
        lo,
        hi,
      );
      report.threads = threads.length;
      report.rootThreads = threads.filter((thread) => thread.parent_a_thread === null).length;
      report.bornThreads = threads.filter((thread) => thread.parent_a_thread !== null).length;
      report.periodThreads = report.rootThreads;
      report.periodLabels = threads.filter((t) => t.parent_a_thread === null).map((t) => t.period_label || '-');

      const threadIds = threads.map((thread) => thread.id);
      if (threadIds.length) {
        const placeholders = threadIds.map(() => '?').join(',');
        const notes = db.all<{
          id: number;
          strength: number;
          strength_source: string;
          is_context: number;
          claim: string;
          chunk_id: number | null;
        }>(
          `SELECT id, strength, strength_source, is_context, claim, chunk_id FROM canon_thread_note
            WHERE thread_id IN (${placeholders}) ORDER BY id`,
          ...threadIds,
        );
        report.notes = notes.length;
        for (const note of notes) {
          report.notesByBand[bandOf(note.strength)]++;
          report.notesBySource[note.strength_source] = (report.notesBySource[note.strength_source] ?? 0) + 1;
          if (note.is_context === 1) continue;
          if (note.strength >= EVIDENCE_FLOOR) {
            report.qualifyingNotes++;
            const seq = note.chunk_id === null ? null : seqOf.get(note.chunk_id) ?? null;
            if (seq !== null && seq <= earlyLimit) report.earlyQualifyingNotes++;
            const direction = directionFromClaim(note.claim, pair.a, pair.b);
            if (report.direction === 'none' && direction !== 'unordered') report.direction = direction;
          }
        }

        const births = db.all<{ trigger: string; combined_score: number }>(
          `SELECT trigger, combined_score FROM canon_birth
            WHERE project_id = ? AND parent_a_thread IN (${placeholders})`,
          projectId,
          ...threadIds,
        );
        report.births = births.length;
        for (const birth of births) {
          report.birthsByTrigger[birth.trigger] = (report.birthsByTrigger[birth.trigger] ?? 0) + 1;
          report.maxCombinedScore = Math.max(report.maxCombinedScore, Number(birth.combined_score) || 0);
        }

        report.openEnds =
          db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM canon_open_end WHERE thread_id IN (${placeholders})`,
            ...threadIds,
          )?.n ?? 0;
      }
    }

    reports.push(report);
  }

  return { reports, evaluation: evaluateCriteria(reports) };
}

/* -------------------------------------------------------------------- score */

export interface BornStats {
  bornThreads: number;
  bornSubjects: number;
  duplicateBornSubjects: number;
}

/** Counts of live born threads, their distinct subjects, and duplicates. */
export function bornStats(db: Db, projectId: number): BornStats {
  const rows = db.all<{ kind: string; a_entity: number; b_entity: number | null }>(
    `SELECT kind, a_entity, b_entity FROM canon_thread
      WHERE project_id = ? AND parent_a_thread IS NOT NULL AND status != 'dormant'`,
    projectId,
  );
  const subjects = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.kind}|${row.a_entity}|${row.b_entity ?? 0}`;
    subjects.set(key, (subjects.get(key) ?? 0) + 1);
  }
  return {
    bornThreads: rows.length,
    bornSubjects: subjects.size,
    duplicateBornSubjects: [...subjects.values()].filter((n) => n > 1).length,
  };
}

/**
 * The automated result, in a fixed key order and integers only.
 *
 * This is the number future runs compare against; the prose table above it is
 * for a human reading one run.
 */
export function buildScore(
  reports: PairReport[],
  evaluation: Evaluation,
  born: BornStats,
): Record<string, number> {
  const byId = new Map(reports.map((r) => [r.id, r]));
  const sum = (rows: PairReport[], pick: (row: PairReport) => number): number =>
    rows.reduce((total, row) => total + pick(row), 0);
  const counts = { resolved: 0, ambiguous: 0, absent: 0 };
  for (const report of reports) counts[report.resolution]++;
  const flaggedData = reports.filter((r) => r.block === 'alias' && r.collisionFlagged).length;
  return {
    criteriaPassed: evaluation.criteria.filter((c) => c.pass).length,
    criteriaTotal: evaluation.criteria.length,
    absentBirths: sum(reports.filter((r) => r.block === 'absent'), (r) => r.births),
    trapBirths: sum(reports.filter((r) => r.block === 'alias'), (r) => r.births),
    trapFlagged: flaggedData,
    recallS1S3: ['S1', 'S2', 'S3'].filter((id) => (byId.get(id)?.qualifyingNotes ?? 0) > 0).length,
    c1Evidence: byId.get('C1')?.earlyQualifyingNotes ?? 0,
    resolved: counts.resolved,
    ambiguous: counts.ambiguous,
    absent: counts.absent,
    bornThreads: born.bornThreads,
    bornSubjects: born.bornSubjects,
    duplicateBornSubjects: born.duplicateBornSubjects,
    // Reported after the fixed keys: the scored value and the stored one.
    trapFlaggedData: flaggedData,
    trapFlaggedDb: reports.filter((r) => r.block === 'alias' && r.collisionFlaggedDb).length,
  };
}

function fail(message: string): never {
  throw new Error(message);
}

function main(argv: string[]): void {
  const [dbRaw, projectName, sheetRaw] = argv;
  if (!dbRaw || !projectName || !sheetRaw) {
    fail('usage: validate-web.ts <db-copy> <project> <pairs.json>');
  }
  const sheetPath = resolve(sheetRaw);
  if (!existsSync(sheetPath)) fail(`no pair sheet at "${sheetRaw}"`);
  const sheet = JSON.parse(readFileSync(sheetPath, 'utf8')) as SheetPair[];
  if (!Array.isArray(sheet) || !sheet.length) fail('pair sheet holds no rows');

  const db = new Db(resolve(dbRaw));
  try {
    const project = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName);
    if (!project) fail(`no project named "${projectName}"`);
    const { reports, evaluation } = validate(db, project.id, sheet);

    console.log('criteria:');
    for (const criterion of evaluation.criteria) {
      console.log(`  ${criterion.pass ? 'PASS' : 'FAIL'}  ${criterion.title} — ${criterion.detail}`);
    }
    console.log(`overall: ${evaluation.pass ? 'PASS' : 'FAIL'}`);
    console.log('');

    const counts: Record<ResolutionStatus, number> = { resolved: 0, ambiguous: 0, absent: 0 };
    for (const report of reports) counts[report.resolution]++;
    console.log(
      `resolution: resolved ${counts.resolved}, ambiguous ${counts.ambiguous}, absent ${counts.absent}` +
        ` (of ${reports.length}); absent controls counted as expected: ` +
        `${reports.filter((r) => r.expectedMiss).length}`,
    );
    console.log('');
    console.log('id  res       threads(root/period/born) notes  qual  births  triggers              score   open  coll  dir');
    for (const r of reports) {
      const threadText =
        r.resolution === 'resolved' ? `${r.threads}(${r.rootThreads}/${r.periodThreads}/${r.bornThreads})` : '-';
      const triggers = Object.entries(r.birthsByTrigger)
        .map(([trigger, n]) => `${trigger}:${n}`)
        .join(',');
      console.log(
        `${r.id.padEnd(3)} ${r.resolution.padEnd(9)} ${threadText.padEnd(28)} ${String(r.notes).padEnd(5)} ` +
          `${String(r.qualifyingNotes).padEnd(5)} ${String(r.births).padEnd(7)} ${(triggers || '-').padEnd(21)} ` +
          `${r.maxCombinedScore.toFixed(3).padEnd(7)} ${String(r.openEnds).padEnd(5)} ` +
          `${(r.collisionFlagged ? 'yes' : 'no').padEnd(5)} ${r.direction}` +
          (r.candidates ? `  <- ambiguous: ${r.candidates}` : ''),
      );
    }

    const ambiguous = reports.filter((r) => r.resolution === 'ambiguous');
    if (ambiguous.length) {
      console.log(`\nambiguous pairs (excluded from note/birth evaluation): ${ambiguous.map((r) => r.id).join(', ')}`);
    }
    // The machine-readable result: one line, fixed keys, integers only.
    console.log(JSON.stringify(buildScore(reports, evaluation, bornStats(db, project.id))));
    process.exit(evaluation.pass ? 0 : 1);
  } finally {
    db.close();
  }
}

const entry = process.argv[1];
let invoked = false;
if (entry) {
  try {
    invoked = import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    invoked = false;
  }
}
if (invoked) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`validate-web: ${(err as Error).message}`);
    process.exit(1);
  }
}
