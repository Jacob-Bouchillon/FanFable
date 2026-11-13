/**
 * The relation status owner is the only production writer of relation
 * review_status/confirmed_by_user. Existing writers are named grandfathers;
 * a new function or an extra write in a grandfathered function fails.
 *
 * Proof and ruling imports stay in their court modules. The owner module is
 * allowed to call those modules but does not insert their rows directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { seedProject, tempDb } from './helpers.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { readRelationClaimState } from '../../fanfable/src/court/claim-transition.ts';

const ROOT = resolve(import.meta.dirname, '../../fanfable/src');

const RELATION_INSERT = /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+canon_relation\b/gi;
const PROOF_INSERT = /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+claim_proof\b/gi;
const RULING_INSERT = /INSERT\s+INTO\s+canon_ruling\b/gi;

type Counts = Record<string, Record<string, number>>;

/**
 * Existing direct relation-status writers, by function. The counts are exact
 * so adding another write inside an already-grandfathered function fails too.
 */
const RELATION_STATUS_GRANDFATHERS: Counts = {
  'lorebook.ts': {
    insertRelation: 1,
    applyRelations: 2,
    dedupeRelations: 1,
    promoteProvisional: 1,
    reclassifyAccepted: 1,
    auditAcceptedRelations: 1,
    // The keeper promotion branch now goes through transitionClaim; only the
    // passage-proof attestation update remains a direct write here.
    assignAttestedTiers: 1,
    promoteProvisionalWithEvidence: 1,
    evaluateTies: 1,
    mergeEntityPair: 1,
    // A rejected row keeps its evidence for audit; the write records a ruling.
    rejectRelation: 1,
  },
  // Rulings export/replay was split out of lorebook.ts on 2026-11-13, logic
  // unchanged. The same three writes now live here; the count is still exact.
  'lorebook/rulings.ts': {
    replayRulings: 3,
  },
};

/** Existing direct confirmed_by_user writers. */
const AUTH_GRANDFATHERS: Counts = {
  'lorebook/rulings.ts': {
    replayRulings: 3,
  },
  'answer/lore-diagnostics.ts': {
    correctRelation: 1,
  },
};

/** SQL backfills/column defaults outside a named function. */
const AUTH_FILE_GRANDFATHERS: Record<string, number> = {
  'core/migrations.ts': 1,
};

const OWNER = 'court/claim-transition.ts';
const PROOF_MODULES = new Set([OWNER, 'court/claim-proof.ts']);
const RULING_MODULES = new Set([OWNER, 'court/ruling.ts']);
const RELATION_MODULES = new Set([OWNER]);

interface WriteSite {
  file: string;
  fn: string | null;
  index: number;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function enclosingFunction(source: string, index: number): string | null {
  const before = source.slice(0, index);
  const rx = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let last: string | null = null;
  for (const match of before.matchAll(rx)) last = match[1] ?? last;
  return last;
}

function sites(source: string, file: string, pattern: RegExp, predicate?: (statement: string) => boolean): WriteSite[] {
  const out: WriteSite[] = [];
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (predicate) {
      const end = source.indexOf(';', index);
      const statement = source.slice(index, end === -1 ? index + 1200 : end);
      if (!predicate(statement)) continue;
    }
    out.push({ file, fn: enclosingFunction(source, index), index });
  }
  return out;
}

/** Find UPDATE table statements whose SET clause assigns the named column. */
function updateSites(source: string, file: string, table: string, column: string): WriteSite[] {
  const out: WriteSite[] = [];
  const rx = new RegExp(`UPDATE\\s+${table}\\b`, 'gi');
  for (const match of source.matchAll(rx)) {
    const index = match.index ?? 0;
    const end = source.indexOf(';', index);
    const statement = source.slice(index, end === -1 ? index + 1200 : end);
    const setMatch = /\bSET\b/i.exec(statement);
    if (!setMatch) continue;
    const whereIndex = statement.search(/\bWHERE\b/i);
    const setClause = statement.slice(
      setMatch.index,
      whereIndex === -1 ? statement.length : whereIndex,
    );
    if (!new RegExp(`\\b${column}\\s*=`, 'i').test(setClause)) continue;
    out.push({ file, fn: enclosingFunction(source, index), index });
  }
  return out;
}

function add(actual: Counts, write: WriteSite): void {
  const key = write.fn ?? '<top-level>';
  actual[write.file] ??= {};
  actual[write.file]![key] = (actual[write.file]![key] ?? 0) + 1;
}

function compare(
  label: string,
  actual: Counts,
  expected: Counts,
  fileExpected: Record<string, number> = {},
): string[] {
  const problems: string[] = [];
  for (const [file, functions] of Object.entries(expected)) {
    for (const [fn, count] of Object.entries(functions)) {
      const found = actual[file]?.[fn] ?? 0;
      if (found !== count) {
        problems.push(`${label}: ${file} ${fn} expected ${count} direct write(s), found ${found}`);
      }
    }
  }
  for (const [file, count] of Object.entries(fileExpected)) {
    const found = actual[file]?.['<top-level>'] ?? 0;
    if (found !== count) {
      problems.push(`${label}: ${file} <top-level> expected ${count} direct write(s), found ${found}`);
    }
  }
  for (const [file, functions] of Object.entries(actual)) {
    for (const [fn, count] of Object.entries(functions)) {
      const expectedCount = expected[file]?.[fn];
      const fileCount = fn === '<top-level>' ? fileExpected[file] : undefined;
      if (expectedCount === undefined && fileCount === undefined) {
        problems.push(`${label}: new direct writer ${file} ${fn} (${count}) is not in the named grandfather list`);
      } else if (expectedCount !== undefined && count !== expectedCount) {
        // already reported above; keep the output deterministic
      } else if (fileCount !== undefined && count !== fileCount) {
        // already reported above
      }
    }
  }
  return problems;
}

test('relation status, authorization, proof and ruling writes stay behind the owner or named grandfathers', () => {
  const files = sourceFiles(ROOT);
  const relationWrites: Counts = {};
  const authWrites: Counts = {};
  const proofProblems: string[] = [];
  const rulingProblems: string[] = [];

  for (const absolute of files) {
    const file = relative(ROOT, absolute).replaceAll('\\', '/');
    const source = readFileSync(absolute, 'utf8');

    if (!RELATION_MODULES.has(file)) {
      for (const write of updateSites(source, file, 'canon_relation', 'review_status')) add(relationWrites, write);
      for (const write of sites(source, file, RELATION_INSERT)) add(relationWrites, write);
    }

    if (!RELATION_MODULES.has(file)) {
      const fileLevel = AUTH_FILE_GRANDFATHERS[file] !== undefined;
      for (const write of updateSites(source, file, 'canon_relation', 'confirmed_by_user')) {
        add(authWrites, fileLevel ? { ...write, fn: null } : write);
      }
      for (const write of sites(source, file, RELATION_INSERT, (statement) => statement.includes('confirmed_by_user'))) {
        add(authWrites, fileLevel ? { ...write, fn: null } : write);
      }
    }

    if (!PROOF_MODULES.has(file)) {
      for (const write of sites(source, file, PROOF_INSERT)) {
        proofProblems.push(`claim_proof insert outside court modules: ${file} ${write.fn ?? '<top-level>'}`);
      }
    }
    if (!RULING_MODULES.has(file)) {
      for (const write of sites(source, file, RULING_INSERT)) {
        rulingProblems.push(`canon_ruling insert outside court modules: ${file} ${write.fn ?? '<top-level>'}`);
      }
    }
  }

  const problems = [
    ...compare('relation status', relationWrites, RELATION_STATUS_GRANDFATHERS),
    ...compare('authorization', authWrites, AUTH_GRANDFATHERS, AUTH_FILE_GRANDFATHERS),
    ...proofProblems,
    ...rulingProblems,
  ];
  assert.deepEqual(problems, []);
});

test('exactly one production module adopts transitionClaim', () => {
  const adopters = sourceFiles(ROOT)
    .filter((absolute) => relative(ROOT, absolute).replaceAll('\\', '/') !== OWNER)
    .filter((absolute) => /\btransitionClaim\s*\(/.test(readFileSync(absolute, 'utf8')))
    .map((absolute) => relative(ROOT, absolute).replaceAll('\\', '/'));
  assert.deepEqual(adopters, ['lorebook.ts']);
});

const AT = '2026-01-01T00:00:00.000Z';

function entity(db: ReturnType<typeof tempDb>['db'], projectId: number, name: string): number {
  return Number(db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    projectId, 'character', name, '[]', 'accepted', AT, AT,
  ).lastInsertRowid);
}

function chunk(db: ReturnType<typeof tempDb>['db'], projectId: number, text: string): number {
  const source = Number(db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    projectId, `/court-${Math.random().toString(36).slice(2)}`, 'Court', 'sha-court', AT,
  ).lastInsertRowid);
  return Number(db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    source, projectId, 1, 'p. 1', '', text, text.split(/\s+/).length,
  ).lastInsertRowid);
}

function provisionalRelation(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  from: number,
  to: number,
  kind: string,
  text: string,
  chunkId: number,
): number {
  return Number(db.run(
    `INSERT INTO canon_relation
       (project_id, from_entity, to_entity, kind, description, evidence, source_refs, confidence,
        review_status, supporting_evidence, created_at)
     VALUES (?, ?, ?, ?, '', ?, ?, 0.8, 'provisional', ?, ?)`,
    projectId,
    from,
    to,
    kind,
    text,
    JSON.stringify([{ source: 'Court', locator: 'p. 1', chunk: chunkId }]),
    lorebook.assessmentSupporting({
      names_both: false,
      other_person: 'pronoun',
      asserted: true,
      hedge: 'certain',
      kind_fit: 'yes',
      strength: 0.8,
      why: 'test assessment',
    }),
    AT,
  ).lastInsertRowid);
}

test('the wired promotion writes proof and a ruling; an unwired writer stays not_evaluated', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'court-adoption');
  const mara = entity(db, project.id, 'Mara');
  const tor = entity(db, project.id, 'Tor');
  const passage = chunk(db, project.id, 'Mara is the aunt of Tor. The gate was cold.');
  const wired = provisionalRelation(db, project.id, mara, tor, 'aunt of', 'Mara is the aunt of Tor.', passage);

  const result = lorebook.assignAttestedTiers(db, project.id, { write: true, promoteKeeper: true });
  assert.equal(result.changed, 1);
  const row = db.get<{ review_status: string; claim_uid: string }>(
    'SELECT review_status, claim_uid FROM canon_relation WHERE id = ?',
    wired,
  )!;
  assert.equal(row.review_status, 'accepted');
  const state = readRelationClaimState(db, project.id, row.claim_uid)!;
  assert.equal(state.sourceProof, 'verified', 'the promotion now appends a proof attempt');
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM claim_proof WHERE claim_type = 'relation' AND claim_uid = ?", row.claim_uid)!.n,
    1,
  );
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM canon_ruling WHERE relation_id = ? AND standard = 'sentence-proof'", wired)!.n,
    1,
  );

  // A grandfathered direct writer still leaves the claim unevaluated.
  const unwired = provisionalRelation(db, project.id, mara, tor, 'friend of', 'Mara is the aunt of Tor.', passage);
  db.run("UPDATE canon_relation SET claim_uid = 'rel-unwired-test' WHERE id = ?", unwired);
  db.run("UPDATE canon_relation SET review_status = 'accepted' WHERE id = ?", unwired);
  const unwiredUid = db.get<{ claim_uid: string }>('SELECT claim_uid FROM canon_relation WHERE id = ?', unwired)!.claim_uid;
  const untouched = readRelationClaimState(db, project.id, unwiredUid)!;
  assert.equal(untouched.sourceProof, 'not_evaluated', 'the unwired writer adds no proof');
  db.close();
});

test('a gate-failing row is refused with no status or proof change', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'court-adoption-refusal');
  const mara = entity(db, project.id, 'Mara');
  const tor = entity(db, project.id, 'Tor');
  const passage = chunk(db, project.id, 'Mara and Tor waited by the gate. The gate was cold.');
  const row = provisionalRelation(
    db,
    project.id,
    mara,
    tor,
    'aunt of',
    'Mara and Tor waited by the gate.',
    passage,
  );

  const result = lorebook.assignAttestedTiers(db, project.id, { write: true, promoteKeeper: true });
  assert.equal(result.keeperPromoted, 0, 'the gate refused the tie');
  assert.equal(result.changed, 0);
  const saved = db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', row)!;
  assert.equal(saved.review_status, 'provisional');
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM claim_proof WHERE claim_type = 'relation'")!.n,
    0,
    'no proof row without a gate pass',
  );
  db.close();
});
