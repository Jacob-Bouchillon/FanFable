import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, seedProject, mockProvider } from './helpers.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import * as graph from '../../fanfable/src/graph.ts';
import { CLOSED_TIE_LABELS } from '../../fanfable/src/lorebook.ts';

function ents(db: any, projectId: number, names: string[]): Map<string, number> {
  const now = new Date().toISOString();
  const out = new Map<string, number>();
  for (const n of names) out.set(n, db.run('INSERT INTO canon_entity (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', projectId, n, now, now).lastInsertRowid);
  return out;
}
function chunkRefs(db: any, projectId: number) {
  const c = db.get('SELECT id, text FROM canon_chunk WHERE project_id = ? ORDER BY seq LIMIT 1', projectId) as { id: number; text: string };
  return { chunk: c, refs: JSON.stringify([{ source: 's', locator: 'p1', chunk: c.id }]) };
}

test('flagged rows are invisible to status and ranking', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'flag-invisible');
  const ids = ents(db, project.id, ['Asha', 'Bram']);
  const { refs } = chunkRefs(db, project.id);
  const now = new Date().toISOString();
  const a = ids.get('Asha')!, b = ids.get('Bram')!;
  db.run(`INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, created_at) VALUES (?, ?, ?, 'ally of', 'her ally quote', ?, 'accepted', ?)`, project.id, a, b, refs, now);
  db.run(`INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, created_at) VALUES (?, ?, ?, 'master of', 'capability quote', ?, 'needs_review', ?)`, project.id, a, b, refs, now);
  const h = lorebook.pairHistory(db, project.id, a, b);
  assert.equal(h.current?.evidence, 'her ally quote', 'pending guess never surfaces as current');
  const ranked = lorebook.rankedRelations(db, project.id);
  assert.ok(ranked.every((r) => r.reviewStatus !== 'needs_review'), 'ranking sees cleared rows only');
  const g = graph.loadGraph(db, project.id);
  assert.ok(![...g.edges].some((e) => e.id.includes('canon:relation') && e.reviewStatus === 'needs_review'), 'graph carries no flagged edges');
  db.close();
});

test('misattached proof stays pending; peer vocabulary is human-gated', async () => {
  assert.ok(CLOSED_TIE_LABELS.includes('peer of') && CLOSED_TIE_LABELS.includes('colleague of'));
  const { db } = tempDb();
  const project = seedProject(db, 'misattach');
  const now = new Date().toISOString();
  const ids = ents(db, project.id, ['Pax Teem', 'Kim', 'Aks Moe']);
  const pax = ids.get('Pax Teem')!, kim = ids.get('Kim')!;
  assert.equal(lorebook.quoteNamesBothEndpoints(db, project.id, pax, kim, 'Pax Teem and his aide Aks Moe'), false);
  assert.equal(lorebook.quoteNamesThirdParty(db, project.id, pax, kim, 'Pax Teem and his aide Aks Moe'), true);
  db.close();
});

test('terminal verbs bank events, never ties', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'terminal-verb');
  const { chunk } = chunkRefs(db, project.id);
  const SERENA = { kind: 'character', name: 'Serena Marsh', aliases: [], summary: '', attributes: {}, role: '', status: '', chunk_index: 0, evidence: chunk.text.slice(0, 80) };
  const KADE = { kind: 'character', name: 'Kade', aliases: [], summary: '', attributes: {}, role: '', status: '', chunk_index: 0, evidence: chunk.text.slice(0, 80) };
  const llm = mockProvider((req) => {
    const sys = (req.system ?? '').toLowerCase();
    if (sys.includes('"entities"')) return JSON.stringify({ entities: [SERENA, KADE], facts: [] });
    if (sys.includes('relationship')) return JSON.stringify({ relations: [{ from: 'Serena Marsh', to: 'Kade', kind: 'killed', description: 'She killed him.', chunk_index: 0, evidence: chunk.text.slice(0, 80) }] });
    return JSON.stringify({ timeline: [] });
  });
  await lorebook.extractLore(db, llm as never, project.id, { windowSize: 8, concurrency: 1, maxWindows: 1 } as never);
  const ties = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ? AND lower(kind) = 'killed'`, project.id)?.n ?? 0;
  assert.equal(ties, 0, 'killed never banks as a tie');
  const events = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM canon_event WHERE project_id = ? AND title LIKE '%kill%'`, project.id)?.n ?? 0;
  assert.ok(events >= 1, 'the happening lives on as an event');
  db.close();
});

test('directed status keeps arrows separate', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'directed');
  const ids = ents(db, project.id, ['Asha', 'Bram']);
  const { refs } = chunkRefs(db, project.id);
  const now = new Date().toISOString();
  const a = ids.get('Asha')!, b = ids.get('Bram')!;
  db.run(`INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, created_at) VALUES (?, ?, ?, 'master of', 'master quote here', ?, 'accepted', ?)`, project.id, a, b, refs, now);
  db.run(`INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, created_at) VALUES (?, ?, ?, 'apprentice of', 'apprentice quote here', ?, 'accepted', ?)`, project.id, b, a, refs, now);
  const d = lorebook.directedPairStatus(db, project.id, a, b);
  assert.equal(d.forward.current?.kind, 'master of');
  assert.equal(d.reverse.current?.kind, 'apprentice of');
  db.close();
});

test('directed status separates the two arrows (#8)', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'directed-sheet-8');
  const ids = ents(db, project.id, ['Asha', 'Bram']);
  const { refs } = chunkRefs(db, project.id);
  const now = new Date().toISOString();
  const p = ids.get('Asha')!, s = ids.get('Bram')!;
  db.run(`INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, created_at) VALUES (?, ?, ?, 'master of', 'master quote here', ?, 'accepted', ?)`, project.id, p, s, refs, now);
  db.run(`INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, created_at) VALUES (?, ?, ?, 'apprentice of', 'apprentice quote here', ?, 'accepted', ?)`, project.id, s, p, refs, now);
  const d = lorebook.directedPairStatus(db, project.id, p, s);
  assert.equal(d.forward.current?.kind, 'master of', 'forward reads as master, never apprentice');
  assert.equal(d.reverse.current?.kind, 'apprentice of', 'reverse reads as apprentice, never master');
  const u = lorebook.pairHistory(db, project.id, p, s);
  assert.ok(u.current, 'undirected history view still works');
  db.close();
});

test('open vocabulary is no longer a promotion verdict; missing score queues both', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'open-vocab');
  const { chunk } = chunkRefs(db, project.id);
  const quote = chunk.text.slice(0, 80);
  const SERENA = { kind: 'character', name: 'Serena Marsh', aliases: [], summary: '', attributes: {}, role: '', status: '', chunk_index: 0, evidence: quote };
  const KADE = { kind: 'character', name: 'Kade', aliases: [], summary: '', attributes: {}, role: '', status: '', chunk_index: 0, evidence: quote };
  const llm = mockProvider((req) => {
    const sys = (req.system ?? '').toLowerCase();
    if (sys.includes('"entities"')) return JSON.stringify({ entities: [SERENA, KADE], facts: [] });
    if (sys.includes('relationship')) return JSON.stringify({ relations: [
      { from: 'Serena Marsh', to: 'Kade', kind: 'encourager of', description: 'She encouraged him.', chunk_index: 0, evidence: quote },
      { from: 'Serena Marsh', to: 'Kade', kind: 'aide of', description: 'She aides him.', chunk_index: 0, evidence: quote },
    ] });
    return JSON.stringify({ timeline: [] });
  });
  await lorebook.extractLore(db, llm as never, project.id, { windowSize: 8, concurrency: 1, maxWindows: 1 } as never);
  const rows = db.all<{ kind: string; review_status: string }>(`SELECT kind, review_status FROM canon_relation WHERE project_id = ? ORDER BY kind`, project.id);
  const enc = rows.find((r) => r.kind === 'encourager of');
  const aide = rows.find((r) => r.kind === 'aide of');
  assert.equal(enc?.review_status, 'provisional', 'no model score, so it queues');
  assert.equal(aide?.review_status, 'provisional', 'no model score, so it queues');
  assert.equal(lorebook.isClosedRoleKind('encourager of'), false, 'the concept set still governs querying');
  const note = db.get<{ reason: string }>(`SELECT reason FROM canon_tie_note WHERE project_id = ? AND attempted_kind = 'encourager of'`, project.id);
  assert.equal(note, undefined, 'the old open-vocab note is gone');
  db.close();
});
