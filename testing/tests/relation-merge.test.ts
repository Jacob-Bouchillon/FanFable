/**
 * Relation merging: one citation wins whole.
 *
 * A duplicate is folded into one row, but the surviving row takes every
 * primary field from a single bundle: quote, place, anchor, kind source,
 * description, confidence and status. The losing bundle is preserved as
 * supporting evidence. Directional kinds keep their arrow; symmetric kinds
 * merge from either side. A generic kinship row replaced by a specific one
 * leaves a court disposition before it is deleted.
 *
 * Invented names and prose only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import * as ruling from '../../fanfable/src/court/ruling.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function entity(db: Db, projectId: number, name: string): number {
  return Number(
    db.run(
      'INSERT INTO canon_entity (project_id, kind, name, aliases, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      projectId,
      'character',
      name,
      '[]',
      'accepted',
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function chunk(db: Db, projectId: number, text: string, seq: number): number {
  const sourceId = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      `/merge-${seq}`,
      'Merge',
      `sha-merge-${seq}`,
      AT,
    ).lastInsertRowid,
  );
  return Number(
    db.run(
      'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sourceId,
      projectId,
      seq,
      `p. ${seq}`,
      '',
      text,
      text.split(/\s+/).length,
    ).lastInsertRowid,
  );
}

function setup(name: string) {
  const { db } = tempDb();
  const project = createProject(db, name);
  return { db, project };
}

function insert(
  db: Db,
  projectId: number,
  from: number,
  to: number,
  kind: string,
  fields: {
    evidence: string;
    description?: string;
    chunkId: number;
    confidence?: number;
    status?: string;
    scope?: string;
    kindSource?: string;
    anchor?: string;
    supporting?: string;
    modality?: string;
    relationStatus?: string;
  },
): number {
  return Number(
    db.run(
      `INSERT INTO canon_relation
         (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
          confidence, modality, review_status, kind_source, anchor_evidence, supporting_evidence,
          relation_status, scope, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      from,
      to,
      kind,
      fields.description ?? '',
      fields.evidence,
      JSON.stringify([{ source: 'Merge', locator: `p. ${fields.chunkId}`, chunk: fields.chunkId }]),
      fields.confidence ?? 0.8,
      fields.modality ?? 'asserted',
      fields.status ?? 'needs_review',
      fields.kindSource ?? '',
      fields.anchor ?? '',
      fields.supporting ?? '[]',
      fields.relationStatus ?? 'unknown',
      fields.scope ?? '',
      AT,
    ).lastInsertRowid,
  );
}

test('dedupe takes every primary field from one bundle and keeps the other', () => {
  const { db, project } = setup('merge-bundle');
  const mara = entity(db, project.id, 'Mara');
  const tor = entity(db, project.id, 'Tor');
  const later = chunk(db, project.id, 'Mara is the aunt of Tor and has raised him since the fire.', 2);
  const earlier = chunk(db, project.id, 'Mara was the aunt of Tor and raised him after the fire.', 1);
  const survivor = insert(db, project.id, mara, tor, 'aunt of', {
    evidence: 'Mara is the aunt of Tor.',
    description: 'short',
    chunkId: later,
    confidence: 0.6,
    status: 'accepted',
    modality: 'asserted',
    relationStatus: 'current',
  });
  const stronger = insert(db, project.id, mara, tor, 'aunt of', {
    evidence: 'Mara was the aunt of Tor and raised him after the fire.',
    description: 'the longer account',
    chunkId: earlier,
    confidence: 0.9,
    status: 'accepted',
    scope: 'alt',
    kindSource: 'aunt',
    anchor: "Mara was Tor's aunt.",
    modality: 'possible',
    relationStatus: 'past',
  });

  lorebook.dedupeRelations(db, project.id);

  const rows = db.all<{
    id: number;
    description: string;
    evidence: string;
    source_refs: string;
    kind_source: string;
    anchor_evidence: string;
    modality: string;
    relation_status: string;
    confidence: number;
    review_status: string;
    supporting_evidence: string;
  }>('SELECT * FROM canon_relation WHERE project_id = ?', project.id);
  assert.equal(rows.length, 1, 'one row survives');
  const row = rows[0]!;
  assert.equal(row.id, survivor, 'the earliest row stays the case id');
  assert.equal(row.evidence, 'Mara was the aunt of Tor and raised him after the fire.');
  assert.equal(row.description, 'the longer account');
  assert.equal(row.kind_source, 'aunt');
  assert.equal(row.anchor_evidence, "Mara was Tor's aunt.");
  assert.equal(row.modality, 'possible', 'modality follows the winning bundle');
  assert.equal(row.relation_status, 'past', 'temporal status follows the winning quote');
  assert.equal(row.confidence, 0.9);
  assert.equal(row.review_status, 'accepted');
  assert.equal(
    (JSON.parse(row.source_refs) as { chunk: number }[])[0]!.chunk,
    earlier,
    'place comes from the same bundle as the quote',
  );

  const supporting = JSON.parse(row.supporting_evidence) as { quote: string; reason: string }[];
  assert.ok(
    supporting.some((item) => item.quote === 'Mara is the aunt of Tor.' && item.reason === 'merged'),
    'the losing bundle is preserved',
  );
  db.close();
});

test('dedupe keeps both directions of a directional kind and folds a symmetric one', () => {
  const { db, project } = setup('merge-direction');
  const mara = entity(db, project.id, 'Mara');
  const tor = entity(db, project.id, 'Tor');
  const c = chunk(db, project.id, 'Mara is the aunt of Tor. Mara and Tor are friends.', 1);

  insert(db, project.id, mara, tor, 'aunt of', { evidence: 'Mara is the aunt of Tor.', chunkId: c });
  insert(db, project.id, tor, mara, 'aunt of', { evidence: 'Mara is the aunt of Tor.', chunkId: c });
  insert(db, project.id, mara, tor, 'friend of', { evidence: 'Mara and Tor are friends.', chunkId: c });
  insert(db, project.id, tor, mara, 'friend of', { evidence: 'Mara and Tor are friends.', chunkId: c });

  lorebook.dedupeRelations(db, project.id);

  const counts = db.all<{ kind: string; n: number }>(
    'SELECT kind, COUNT(*) AS n FROM canon_relation WHERE project_id = ? GROUP BY kind ORDER BY kind',
    project.id,
  );
  assert.deepEqual(
    counts.map(({ kind, n }) => ({ kind, n })),
    [
      { kind: 'aunt of', n: 2 },
      { kind: 'friend of', n: 1 },
    ],
  );
  db.close();
});

/* ------------------------------------------------------------ extraction */

function relation(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    from: 'Asha',
    to: 'Bram',
    kind: 'sister of',
    kind_source: 'sister',
    description: '',
    chunk_index: 0,
    evidence: 'Asha is Bram’s sister.',
    strength: 0.8,
    asserted: true,
    names_both: true,
    other_person: 'named',
    hedge: 'certain',
    kind_fit: 'yes',
    why: 'the sentence says so',
    ...overrides,
  };
}

function setupExtraction(name: string, text: string) {
  const { db } = tempDb();
  const project = createProject(db, name);
  const sourceId = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      project.id,
      '/merge',
      'Merge',
      `sha-${name}`,
      AT,
    ).lastInsertRowid,
  );
  db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId,
    project.id,
    1,
    'p. 1',
    '',
    text,
    text.split(/\s+/).length,
  );
  return { db, project };
}

async function runPass(db: Db, projectId: number, rows: Record<string, unknown>[]) {
  const evidence = String(rows[0]?.evidence ?? '');
  const provider = mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: rows });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({
      entities: ['Asha', 'Bram'].map((name) => ({
        kind: 'character',
        name,
        aliases: [],
        summary: '',
        attributes: {},
        role: '',
        status: '',
        chunk_index: 0,
        evidence,
      })),
      facts: [],
    });
  });
  await lorebook.extractLore(db, provider as never, projectId, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
    fresh: true,
  } as never);
}

/* ---------------------------------------------------------------- tests */

test('extraction merge takes the winning bundle whole and preserves the other', async () => {
  const text = 'Asha is Bram’s sister. Asha was always Bram’s sister and she raised him.';
  const { db, project } = setupExtraction('merge-extract-bundle', text);
  await runPass(db, project.id, [
    relation({ evidence: 'Asha is Bram’s sister.', description: 'first', strength: 0.6 }),
  ]);
  // A second pass over the same passage folds the stronger claim in.
  await runPass(db, project.id, [
    relation({
      evidence: 'Asha was always Bram’s sister and she raised him.',
      description: 'second',
      strength: 0.9,
    }),
  ]);

  const rows = db.all<{
    description: string;
    evidence: string;
    relation_status: string;
    confidence: number;
    supporting_evidence: string;
  }>(
    'SELECT description, evidence, relation_status, confidence, supporting_evidence FROM canon_relation WHERE project_id = ?',
    project.id,
  );
  assert.equal(rows.length, 1, 'one claim survives');
  const row = rows[0]!;
  assert.equal(row.evidence, 'Asha was always Bram’s sister and she raised him.');
  assert.equal(row.description, 'second');
  assert.equal(row.relation_status, 'past', 'temporal status follows the winning quote');
  assert.equal(row.confidence, 0.9);
  const supporting = JSON.parse(row.supporting_evidence) as { quote?: string; reason?: string }[];
  assert.ok(
    supporting.some((item) => item.quote === 'Asha is Bram’s sister.' && item.reason === 'merged'),
    'the first bundle is preserved',
  );
  db.close();
});

test('a weaker incoming bundle does not displace the stronger primary', async () => {
  const text = 'Asha is Bram’s sister. Asha has always been Bram’s sister and she raised him.';
  const { db, project } = setupExtraction('merge-extract-weak', text);
  await runPass(db, project.id, [
    relation({ evidence: 'Asha is Bram’s sister.', description: 'strong', strength: 0.9 }),
  ]);
  await runPass(db, project.id, [
    relation({
      evidence: 'Asha has always been Bram’s sister and she raised him.',
      description: 'weak',
      strength: 0.4,
    }),
  ]);

  const rows = db.all<{ description: string; evidence: string; confidence: number; supporting_evidence: string }>(
    'SELECT description, evidence, confidence, supporting_evidence FROM canon_relation WHERE project_id = ?',
    project.id,
  );
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.evidence, 'Asha is Bram’s sister.');
  assert.equal(row.description, 'strong');
  assert.equal(row.confidence, 0.9);
  const supporting = JSON.parse(row.supporting_evidence) as { quote?: string; reason?: string }[];
  assert.ok(
    supporting.some(
      (item) => item.quote === 'Asha has always been Bram’s sister and she raised him.' && item.reason === 'merged',
    ),
    'the weaker bundle is preserved beside the stronger one',
  );
  db.close();
});

test('a generic kinship row leaves a disposition before a specific one replaces it', async () => {
  const text = 'Bram is Asha’s sibling. Bram is Asha’s brother.';
  const { db, project } = setupExtraction('merge-generic', text);
  await runPass(db, project.id, [
    relation({ from: 'Bram', to: 'Asha', kind: 'sibling of', kind_source: 'sibling', evidence: 'Bram is Asha’s sibling.' }),
    relation({ from: 'Bram', to: 'Asha', kind: 'brother of', kind_source: 'brother', evidence: 'Bram is Asha’s brother.' }),
  ]);
  const rows = db.all<{ id: number; kind: string }>('SELECT id, kind FROM canon_relation WHERE project_id = ?', project.id);
  assert.deepEqual(rows.map((row) => row.kind), ['brother of'], 'the specific stands; the generic drops');
  const disposition = ruling
    .listRulings(db, project.id)
    .find((entry) => entry.standard === 'generic-kinship');
  assert.ok(disposition, 'the dropped generic row has a disposition');
  assert.equal(disposition!.to_status, 'merged');
  assert.match(disposition!.basis, /brother of/);
  db.close();
});

test('a specific kinship row does not delete the generic row pointing the other way', async () => {
  const text = 'Bram is Asha’s parent. Asha is Bram’s father.';
  const { db, project } = setupExtraction('merge-generic-reverse', text);
  await runPass(db, project.id, [
    relation({ from: 'Bram', to: 'Asha', kind: 'parent of', kind_source: 'parent', evidence: 'Bram is Asha’s parent.' }),
    relation({ from: 'Asha', to: 'Bram', kind: 'father of', kind_source: 'father', evidence: 'Asha is Bram’s father.' }),
  ]);
  const rows = db.all<{ kind: string }>('SELECT kind FROM canon_relation WHERE project_id = ? ORDER BY kind', project.id);
  assert.deepEqual(rows.map((row) => row.kind), ['father of', 'parent of']);
  const dispositions = ruling.listRulings(db, project.id).filter((entry) => entry.standard === 'generic-kinship');
  assert.equal(dispositions.length, 0, 'the reverse claim is a different tie');
  db.close();
});
