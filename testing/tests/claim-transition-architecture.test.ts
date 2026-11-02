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
    assignAttestedTiers: 2,
    promoteProvisionalWithEvidence: 1,
    evaluateTies: 1,
    mergeEntityPair: 1,
    replayRulings: 3,
  },
};

/** Existing direct confirmed_by_user writers. */
const AUTH_GRANDFATHERS: Counts = {
  'lorebook.ts': {
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
