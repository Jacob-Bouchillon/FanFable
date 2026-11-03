/**
 * Relationship-endpoint identity resolution through actual extraction intake.
 *
 * Synthetic names and passages only; temp databases, no model calls.
 * These fixtures measure the private relation resolver, not a book.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

interface WindowFixture {
  sentinel: string;
  firstChunk: string;
  entities: Record<string, unknown>[];
  relations: Record<string, unknown>[];
  retryReply?: string;
}

function setup(name: string, windows: WindowFixture[]) {
  const { db } = tempDb();
  const project = createProject(db, name);
  const source = Number(
    db.run(
      `INSERT INTO canon_source (project_id, path, title, sha256, imported_at)
       VALUES (?, ?, ?, ?, ?)`,
      project.id,
      '/synthetic-relationship-probe',
      'Synthetic Probe',
      'sha-synthetic-relationship-probe',
      AT,
    ).lastInsertRowid,
  );
  let seq = 0;
  for (const window of windows) {
    for (let i = 0; i < 8; i++) {
      seq++;
      const text = i === 0 ? window.firstChunk : `Filler passage ${seq} for ${window.sentinel}.`;
      db.run(
        `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
         VALUES (?, ?, ?, ?, '', ?, ?)`,
        source,
        project.id,
        seq,
        `p. ${seq}`,
        text,
        text.split(/\s+/).filter(Boolean).length,
      );
    }
  }
  return { db, projectId: project.id };
}

function mockFor(windows: WindowFixture[], retryCounter?: { retries: number }) {
  return mockProvider((req) => {
    const system = req.system ?? '';
    const content = req.messages[0]?.content ?? '';
    const window = windows.find((item) => content.includes(item.sentinel));
    if (!window) return JSON.stringify({ entities: [], facts: [], relations: [], timeline: [] });
    if (system.includes('You repair one relationship quote')) {
      if (retryCounter) retryCounter.retries++;
      return JSON.stringify({ quote: window.retryReply ?? 'NONE' });
    }
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: window.relations });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: window.entities, facts: [] });
  });
}

async function extract(
  name: string,
  windows: WindowFixture[],
  beforeExtract?: (db: Db, projectId: number) => void,
  opts: { strict?: boolean; retryCounter?: { retries: number } } = {},
) {
  const fixture = setup(name, windows);
  beforeExtract?.(fixture.db, fixture.projectId);
  const before = process.env.FANFABLE_REL_STRICT;
  if (opts.strict) process.env.FANFABLE_REL_STRICT = '1';
  try {
    const stats = await lorebook.extractLore(
      fixture.db,
      mockFor(windows, opts.retryCounter),
      fixture.projectId,
      {
        windowSize: 8,
        concurrency: 1,
        maxWindows: windows.length,
      },
    );
    return { ...fixture, stats };
  } finally {
    if (before === undefined) delete process.env.FANFABLE_REL_STRICT;
    else process.env.FANFABLE_REL_STRICT = before;
  }
}

function entityId(db: Db, projectId: number, name: string): number | undefined {
  return db.get<{ id: number }>(
    'SELECT id FROM canon_entity WHERE project_id = ? AND lower(name) = lower(?)',
    projectId,
    name,
  )?.id;
}

function relationRows(db: Db, projectId: number): {
  from_name: string;
  to_name: string;
  kind: string;
  review_status: string;
  evidence: string;
  source_refs: string;
}[] {
  return db.all(
    `SELECT a.name AS from_name, b.name AS to_name, r.kind, r.review_status, r.evidence, r.source_refs
       FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ? ORDER BY r.id`,
    projectId,
  );
}

function hintRows(db: Db, projectId: number): {
  from_name: string;
  to_name: string;
  kind: string;
  status: string;
}[] {
  return db.all(
    'SELECT from_name, to_name, kind, status FROM canon_tie_hint WHERE project_id = ? ORDER BY id',
    projectId,
  );
}

function assertBanksRelation(
  fixture: Awaited<ReturnType<typeof extract>>,
  expected: { from: string; to: string; kind: string },
): void {
  const rows = relationRows(fixture.db, fixture.projectId);
  const row = rows.find((item) => item.kind === expected.kind);
  assert.ok(row, `expected ${expected.kind} to bank`);
  assert.equal(row!.from_name, expected.from);
  assert.equal(row!.to_name, expected.to);
  assert.equal(row!.review_status, 'needs_review');
  assert.ok(row!.evidence.length > 0, 'evidence is retained');
  assert.ok(JSON.parse(row!.source_refs).length > 0, 'provenance is retained');
  assert.equal(
    fixture.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM claim_proof WHERE project_id = ?',
      fixture.projectId,
    )!.n,
    0,
    'intake does not fabricate a proof',
  );
}

const ENTITY = (name: string, evidence: string, aliases: string[] = [], kind = 'character') => ({
  kind,
  name,
  aliases,
  summary: '',
  attributes: {},
  role: '',
  status: '',
  chunk_index: 0,
  evidence,
});

const RELATION = (from: string, to: string, kind: string, evidence: string) => ({
  from,
  to,
  kind,
  description: '',
  chunk_index: 0,
  evidence,
});

test('multiword stored alias resolves a relationship endpoint', async () => {
  const fixture = await extract('relation-identity-alias', [{
    sentinel: 'WINDOW_ALIAS',
    firstChunk: 'The Bright One watched the bridge. The Bright One and Bram were friends.',
    entities: [
      ENTITY('Asha Var', 'The Bright One watched the bridge.', ['The Bright One']),
      ENTITY('Bram', 'Bram'),
    ],
    relations: [RELATION('The Bright One', 'Bram', 'friend of', 'The Bright One and Bram were friends.')],
  }]);
  assertBanksRelation(fixture, { from: 'Asha Var', to: 'Bram', kind: 'friend of' });
  assert.equal(fixture.stats.verification.unresolved, 0);
  assert.equal(hintRows(fixture.db, fixture.projectId).length, 0);
  fixture.db.close();
});

test('canonically equivalent name resolves a relationship endpoint', async () => {
  const fixture = await extract('relation-identity-canonical', [{
    sentinel: 'WINDOW_CANONICAL',
    firstChunk: "Veyra’lin watched the bridge. Veyra'lin and Bram were friends.",
    entities: [
      ENTITY('Veyra’lin', 'Veyra’lin watched the bridge.'),
      ENTITY('Bram', 'Bram'),
    ],
    relations: [RELATION("Veyra'lin", 'Bram', 'friend of', "Veyra'lin and Bram were friends.")],
  }]);
  assertBanksRelation(fixture, { from: 'Veyra’lin', to: 'Bram', kind: 'friend of' });
  assert.equal(fixture.stats.verification.unresolved, 0);
  fixture.db.close();
});

test('a unique short name still resolves', async () => {
  const fixture = await extract('relation-identity-unique-short', [{
    sentinel: 'WINDOW_UNIQUE_SHORT',
    firstChunk: 'Dorian Voss watched the bridge. Dorian and Bram were friends.',
    entities: [
      ENTITY('Dorian Voss', 'Dorian Voss watched the bridge.'),
      ENTITY('Bram', 'Bram'),
    ],
    relations: [RELATION('Dorian', 'Bram', 'friend of', 'Dorian and Bram were friends.')],
  }]);
  assertBanksRelation(fixture, { from: 'Dorian Voss', to: 'Bram', kind: 'friend of' });
  assert.equal(fixture.stats.verification.unresolved, 0);
  fixture.db.close();
});

test('an ambiguous short name stays unresolved and becomes a hint', async () => {
  const fixture = await extract('relation-identity-ambiguous-short', [{
    sentinel: 'WINDOW_AMBIGUOUS_SHORT',
    firstChunk: 'Asha Var watched the bridge. Asha Bel watched the river. Asha and Bram were friends.',
    entities: [
      ENTITY('Asha Var', 'Asha Var watched the bridge.'),
      ENTITY('Asha Bel', 'Asha Bel watched the river.'),
      ENTITY('Bram', 'Bram'),
    ],
    relations: [RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were friends.')],
  }]);
  assert.equal(relationRows(fixture.db, fixture.projectId).length, 0);
  const hints = hintRows(fixture.db, fixture.projectId);
  assert.equal(hints.length, 1);
  assert.equal(hints[0]!.from_name, 'Asha');
  assert.equal(hints[0]!.kind, 'friend of');
  assert.equal(hints[0]!.status, 'pending');
  fixture.db.close();
});

test('same-name different-kind entities fail closed instead of preferring character', async () => {
  const fixture = await extract(
    'relation-identity-cross-kind',
    [{
      sentinel: 'WINDOW_CROSS_KIND',
      firstChunk: 'Asha watched the bridge. Asha and Bram were friends.',
      entities: [ENTITY('Bram', 'Bram')],
      relations: [RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were friends.')],
    }],
    (db, projectId) => {
      for (const kind of ['character', 'location']) {
        db.run(
          `INSERT INTO canon_entity
             (project_id, kind, name, aliases, review_status, created_at, updated_at)
           VALUES (?, ?, 'Asha', '[]', 'accepted', ?, ?)`,
          projectId,
          kind,
          AT,
          AT,
        );
      }
    },
  );
  assert.equal(relationRows(fixture.db, fixture.projectId).length, 0);
  const hints = hintRows(fixture.db, fixture.projectId);
  assert.equal(hints.length, 1);
  assert.equal(hints[0]!.from_name, 'Asha');
  assert.equal(hints[0]!.kind, 'friend of');
  fixture.db.close();
});

test('an exact name colliding with another entity alias stays unresolved', async () => {
  const fixture = await extract('relation-identity-name-alias-collision', [{
    sentinel: 'WINDOW_NAME_ALIAS_COLLISION',
    firstChunk: 'Asha watched the bridge. Bram Var watched the bridge. Asha and Cora were friends.',
    entities: [
      ENTITY('Asha', 'Asha watched the bridge.', [], 'character'),
      ENTITY('Bram Var', 'Bram Var watched the bridge.', ['Asha'], 'location'),
      ENTITY('Cora', 'Cora'),
    ],
    relations: [RELATION('Asha', 'Cora', 'friend of', 'Asha and Cora were friends.')],
  }]);
  assert.equal(relationRows(fixture.db, fixture.projectId).length, 0);
  const hints = hintRows(fixture.db, fixture.projectId);
  assert.equal(hints.length, 1);
  assert.equal(hints[0]!.from_name, 'Asha');
  assert.equal(hints[0]!.kind, 'friend of');
  fixture.db.close();
});

test('one entity can match by its own name and alias without collision', async () => {
  const fixture = await extract('relation-identity-same-entity-alias', [{
    sentinel: 'WINDOW_SAME_ENTITY_ALIAS',
    firstChunk: "Veyra’lin watched the bridge. Veyra'lin and Cora were friends.",
    entities: [
      ENTITY('Veyra’lin', 'Veyra’lin watched the bridge.', ["Veyra'lin"]),
      ENTITY('Cora', 'Cora'),
    ],
    relations: [RELATION("Veyra'lin", 'Cora', 'friend of', "Veyra'lin and Cora were friends.")],
  }]);
  assertBanksRelation(fixture, { from: 'Veyra’lin', to: 'Cora', kind: 'friend of' });
  assert.equal(fixture.stats.verification.unresolved, 0);
  fixture.db.close();
});

test('a later same-short-name entity is not hidden by extraction cache', async () => {
  const fixture = await extract('relation-identity-cache', [
    {
      sentinel: 'WINDOW_CACHE_ONE',
      firstChunk: 'Asha Var watched the bridge. Asha and Bram were friends.',
      entities: [
        ENTITY('Asha Var', 'Asha Var watched the bridge.'),
        ENTITY('Bram', 'Bram'),
      ],
      relations: [RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were friends.')],
    },
    {
      sentinel: 'WINDOW_CACHE_TWO',
      firstChunk: 'Asha Bel watched the river. Asha and Bram were rivals.',
      entities: [ENTITY('Asha Bel', 'Asha Bel watched the river.')],
      relations: [RELATION('Asha', 'Bram', 'rival of', 'Asha and Bram were rivals.')],
    },
  ]);
  const kinds = relationRows(fixture.db, fixture.projectId).map((row) => row.kind);
  assert.deepEqual(kinds, ['friend of'], 'the later duplicate short name must not reuse the cached first identity');
  const hints = hintRows(fixture.db, fixture.projectId);
  assert.equal(hints.length, 1);
  assert.equal(hints[0]!.kind, 'rival of');
  fixture.db.close();
});

test('relationship resolution ignores a matching entity in another project when no local candidate exists', async () => {
  let otherProjectId = 0;
  let otherAshaId = 0;
  const fixture = await extract(
    'relation-identity-project-a',
    [{
      sentinel: 'WINDOW_PROJECT_A',
      firstChunk: 'Bram watched the bridge. Asha and Bram were friends.',
      entities: [ENTITY('Bram', 'Bram watched the bridge.')],
      relations: [RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were friends.')],
    }],
    (db) => {
      const other = createProject(db, 'relation-identity-project-b');
      otherProjectId = other.id;
      otherAshaId = Number(
        db.run(
          `INSERT INTO canon_entity
             (project_id, kind, name, aliases, review_status, created_at, updated_at)
           VALUES (?, 'character', 'Asha', '[]', 'accepted', ?, ?)`,
          other.id,
          AT,
          AT,
        ).lastInsertRowid,
      );
    },
  );
  assert.equal(relationRows(fixture.db, fixture.projectId).length, 0);
  assert.equal(hintRows(fixture.db, fixture.projectId).length, 1);
  assert.equal(entityId(fixture.db, otherProjectId, 'Asha'), otherAshaId, 'the other project is untouched');
  assert.equal(
    fixture.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?',
      otherProjectId,
    )!.n,
    0,
  );
  fixture.db.close();
});

test('relationship resolution uses the matching local candidate, not another project', async () => {
  let otherProjectId = 0;
  let otherAshaId = 0;
  let localAshaId = 0;
  const fixture = await extract(
    'relation-identity-project-local',
    [{
      sentinel: 'WINDOW_PROJECT_LOCAL',
      firstChunk: 'Bram watched the bridge. Asha and Bram were friends.',
      entities: [ENTITY('Bram', 'Bram watched the bridge.')],
      relations: [RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were friends.')],
    }],
    (db, projectId) => {
      localAshaId = Number(
        db.run(
          `INSERT INTO canon_entity
             (project_id, kind, name, aliases, review_status, created_at, updated_at)
           VALUES (?, 'character', 'Asha', '[]', 'accepted', ?, ?)`,
          projectId,
          AT,
          AT,
        ).lastInsertRowid,
      );
      const other = createProject(db, 'relation-identity-project-other');
      otherProjectId = other.id;
      otherAshaId = Number(
        db.run(
          `INSERT INTO canon_entity
             (project_id, kind, name, aliases, review_status, created_at, updated_at)
           VALUES (?, 'character', 'Asha', '[]', 'accepted', ?, ?)`,
          other.id,
          AT,
          AT,
        ).lastInsertRowid,
      );
    },
  );
  const row = fixture.db.get<{ from_entity: number; to_entity: number; review_status: string }>(
    "SELECT from_entity, to_entity, review_status FROM canon_relation WHERE project_id = ? AND kind = 'friend of'",
    fixture.projectId,
  );
  assert.ok(row);
  assert.equal(row!.from_entity, localAshaId);
  assert.notEqual(row!.from_entity, otherAshaId);
  assert.equal(row!.review_status, 'needs_review');
  assert.equal(entityId(fixture.db, otherProjectId, 'Asha'), otherAshaId, 'the other project is untouched');
  fixture.db.close();
});

test('an alias-resolved endpoint can repair evidence in strict retry and bank', async () => {
  const retryCounter = { retries: 0 };
  const fixture = await extract(
    'relation-identity-retry-alias',
    [{
      sentinel: 'WINDOW_RETRY_ALIAS',
      firstChunk: 'WINDOW_RETRY_ALIAS The Bright One waited by the gate. The Bright One and Bram were friends.',
      entities: [
        ENTITY('Asha Var', 'The Bright One waited by the gate.', ['The Bright One']),
        ENTITY('Bram', 'The Bright One and Bram were friends.'),
      ],
      relations: [RELATION('The Bright One', 'Bram', 'friend of', 'The Bright One waited by the gate.')],
      retryReply: 'The Bright One and Bram were friends.',
    }],
    undefined,
    { strict: true, retryCounter },
  );
  assert.equal(retryCounter.retries, 1);
  assert.equal(fixture.stats.verification.retried, 1);
  assert.equal(fixture.stats.verification.retriedFixed, 1);
  assert.equal(fixture.stats.verification.retriedFailed, 0);
  assertBanksRelation(fixture, { from: 'Asha Var', to: 'Bram', kind: 'friend of' });
  const row = fixture.db.get<{ evidence: string }>(
    "SELECT evidence FROM canon_relation WHERE project_id = ? AND kind = 'friend of'",
    fixture.projectId,
  );
  assert.equal(row?.evidence, 'The Bright One and Bram were friends.');
  fixture.db.close();
});

test('an ambiguous endpoint skips strict retry and stays unresolved', async () => {
  const retryCounter = { retries: 0 };
  const fixture = await extract(
    'relation-identity-retry-ambiguous',
    [{
      sentinel: 'WINDOW_RETRY_AMBIGUOUS',
      firstChunk: 'WINDOW_RETRY_AMBIGUOUS Asha waited by the gate. Asha and Bram were friends.',
      entities: [
        ENTITY('Asha Var', 'Asha waited by the gate.'),
        ENTITY('Asha Bel', 'Asha waited by the gate.'),
        ENTITY('Bram', 'Bram'),
      ],
      relations: [RELATION('Asha', 'Bram', 'friend of', 'Asha waited by the gate.')],
      retryReply: 'Asha and Bram were friends.',
    }],
    undefined,
    { strict: true, retryCounter },
  );
  assert.equal(retryCounter.retries, 0);
  assert.equal(fixture.stats.verification.retried, 0);
  assert.equal(relationRows(fixture.db, fixture.projectId).length, 0);
  const hints = hintRows(fixture.db, fixture.projectId);
  assert.equal(hints.length, 1);
  assert.equal(hints[0]!.from_name, 'Asha');
  assert.equal(hints[0]!.status, 'pending');
  fixture.db.close();
});
