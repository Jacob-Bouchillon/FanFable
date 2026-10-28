import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempDb, seedProject, mockProvider } from './helpers.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import * as checker from '../../fanfable/src/rule-checker.ts';

test('v12 migrates old rows as verified with empty scope', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'ledger-migrate');
  const row = db.get<{ ledger_state: string; scope: string }>('SELECT ledger_state, scope FROM canon_relation LIMIT 1');
  // Seed book may have zero relations if unmined; insert one legacy-style row.
  if (!row) {
    const now = new Date().toISOString();
    const a = db.run('INSERT INTO canon_entity (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', project.id, 'Asha', now, now).lastInsertRowid;
    const b = db.run('INSERT INTO canon_entity (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', project.id, 'Bram', now, now).lastInsertRowid;
    db.run('INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      project.id, a, b, 'friend of', 'quote here', JSON.stringify([]), now);
  }
  const after = db.get<{ ledger_state: string; scope: string }>('SELECT ledger_state, scope FROM canon_relation LIMIT 1')!;
  assert.equal(after.ledger_state, 'verified');
  assert.equal(after.scope, '');
  const idx = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='index' AND name='canon_relation_pair_kind_scope'`);
  assert.equal(idx.length, 1, 'scoped unique index exists');
  db.close();
});

test('prioritise pages with afterId and never writes', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'ledger-cursor');
  const now = new Date().toISOString();
  const mk = (n: string) => db.run('INSERT INTO canon_entity (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', project.id, n, now, now).lastInsertRowid;
  const a = mk('Asha'); const b = mk('Bram');
  const chunk = db.get<{ id: number; text: string }>('SELECT id, text FROM canon_chunk WHERE project_id = ? ORDER BY seq LIMIT 1', project.id)!;
  const refs = JSON.stringify([{ source: 's', locator: 'p1', chunk: chunk.id }]);
  db.run(`INSERT INTO canon_tie_note (project_id, from_entity, to_entity, attempted_kind, reason, evidence, source_refs, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`, project.id, a, b, 'friend of', 'unsupported', 'Asha stood beside Bram.', refs, now);
  db.run(`INSERT INTO canon_tie_note (project_id, from_entity, to_entity, attempted_kind, reason, evidence, source_refs, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`, project.id, a, b, 'met', 'moment', chunk.text.slice(0, 80), refs, now);
  db.run(`INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'needs_review', ?)`, project.id, b, a, 'friend of', 'Asha stood beside Bram.', refs, now);
  const first = db.get<{ id: number }>('SELECT id FROM canon_tie_note WHERE project_id = ? ORDER BY id LIMIT 1', project.id)!;
  const r1 = lorebook.prioritiseTieNotes(db, project.id, { limit: 1 });
  assert.equal(r1.length, 1, 'one page of the queue');
  const r2 = lorebook.prioritiseTieNotes(db, project.id, { limit: 10, afterId: first.id });
  assert.ok(r2.length >= 1, 'second page reached via afterId');
  assert.ok(r2.every((row) => row.id > first.id));
  const pending = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM canon_tie_note WHERE project_id = ? AND status = 'pending'", project.id)!.n;
  assert.equal(pending, 2, 'nothing is resolved or written');
  const row = db.get<{ review_status: string }>("SELECT review_status FROM canon_relation WHERE project_id = ? AND kind = 'friend of'", project.id)!;
  assert.equal(row.review_status, 'needs_review', 'the parked relation stays parked');
  db.close();
});

test('judge sees the whole file: pair rows, entity files, quarantine, passage', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'judge-dossier');
  const now = new Date().toISOString();
  const a = db.run('INSERT INTO canon_entity (project_id, name, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', project.id, 'Asha', 'a watcher', now, now).lastInsertRowid;
  const b = db.run('INSERT INTO canon_entity (project_id, name, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', project.id, 'Bram', 'a guard', now, now).lastInsertRowid;
  const chunk = db.get<{ id: number; text: string }>('SELECT id, text FROM canon_chunk WHERE project_id = ? ORDER BY seq LIMIT 1', project.id)!;
  const refs = JSON.stringify([{ source: 's', locator: 'p1', chunk: chunk.id }]);
  db.run(`INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, created_at)
    VALUES (?, ?, ?, 'friend of', 'Asha stood beside Bram', ?, 'accepted', ?)`, project.id, a, b, refs, now);
  db.run(`INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, created_at)
    VALUES (?, ?, ?, 'ally of', 'Asha nodded', ?, 'needs_review', ?)`, project.id, a, b, refs, now);
  db.run(`INSERT INTO quarantine_alias (project_id, name, candidate, reason, status, created_at)
    VALUES (?, ?, ?, 'looks alike', 'pending', ?)`, project.id, 'Asha', 'Bram', now);
  const seen: string[] = [];
  const llm = mockProvider((req) => {
    const user = (req.messages ?? []).map((m: { content: string }) => m.content).join('\n');
    seen.push((req.system ?? '') + '\n' + user);
    return JSON.stringify({ verdict: 'keep', reason: 'ok' });
  });
  const r = await lorebook.evaluateTies(db, llm, project.id, { maxTies: 10 });
  assert.equal(r.checked, 2);
  const dossier = seen.join('\n');
  assert.ok(dossier.includes('OTHER BANKED CLAIMS FOR THIS PAIR'), 'rival labels shown');
  assert.ok(dossier.includes('ENTITY FILES'), 'entity files shown');
  assert.ok(dossier.includes('OPEN IDENTITY QUESTIONS'), 'pending quarantine shown');
  assert.ok(dossier.includes('PASSAGE'), 'full passage shown, not just the quote');
  db.close();
});

test('prioritise surfaces a closed-kind note without writing a tie', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'relabel-role');
  const now = new Date().toISOString();
  const mk = (n: string) => db.run('INSERT INTO canon_entity (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', project.id, n, now, now).lastInsertRowid;
  const a = mk('Serena Marsh'); const b = mk('Kade');
  const src = db.get<{ id: number }>('SELECT id FROM canon_source WHERE project_id = ?', project.id)!;
  const seq = db.get<{ n: number }>('SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM canon_chunk WHERE project_id = ?', project.id)!.n;
  const passage = 'Serena Marsh stood as aide of Kade before the crossing.';
  const chunkId = db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, char_start, char_end, words, page_start, page_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    src.id, project.id, seq, 'p. 9', 'The Bridge', passage, 0, passage.length, 10, 9, 9,
  ).lastInsertRowid;
  const refs = JSON.stringify([{ source: 's', locator: 'p. 9', chunk: chunkId }]);
  db.run(`INSERT INTO canon_tie_note (project_id, from_entity, to_entity, attempted_kind, reason, evidence, source_refs, status, created_at)
    VALUES (?, ?, ?, 'aide of', 'unsupported', 'Serena smiled', ?, 'pending', ?)`, project.id, a, b, refs, now);
  const queue = lorebook.prioritiseTieNotes(db, project.id);
  assert.equal(queue.length, 1, 'the note enters the review queue');
  assert.equal(queue[0].decision.ok, false, 'the guard refuses a quote that is not in the passage');
  const row = db.get<{ kind: string }>('SELECT kind FROM canon_relation WHERE project_id = ? AND kind = ?', project.id, 'aide of');
  assert.equal(row, undefined, 'no relation is written');
  const pending = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM canon_tie_note WHERE project_id = ? AND status = 'pending'", project.id)!.n;
  assert.equal(pending, 1, 'the note stays pending for a human');
  db.close();
});

test('judge never re-judges human-confirmed ties', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'ledger-human');
  const now = new Date().toISOString();
  const mk = (n: string) => db.run('INSERT INTO canon_entity (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', project.id, n, now, now).lastInsertRowid;
  const a = mk('Asha'); const b = mk('Bram');
  const chunk = db.get<{ id: number }>('SELECT id FROM canon_chunk WHERE project_id = ? ORDER BY seq LIMIT 1', project.id)!;
  const refs = JSON.stringify([{ source: 's', locator: 'p1', chunk: chunk.id }]);
  db.run(`INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, created_at)
    VALUES (?, ?, ?, 'trusted with life', 'ridge quote here', ?, 'user_confirmed', ?)`, project.id, a, b, refs, now);
  let calls = 0;
  const llm = mockProvider(() => { calls++; return JSON.stringify({ verdict: 'drop', reason: 'x' }); });
  const r = await lorebook.evaluateTies(db, llm, project.id, { maxTies: 10 });
  assert.equal(calls, 0, 'human ruling untouched');
  assert.equal(r.checked, 0);
  db.close();
});

test('rule checker flags seeded violations, writes no facts', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'rules-seed');
  const now = new Date().toISOString();
  const mk = (n: string, kind = 'character') => db.run('INSERT INTO canon_entity (project_id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', project.id, kind, n, now, now).lastInsertRowid;
  const a = mk('Asha'); const b = mk('Bram'); const loc = mk('Ardenne Bridge', 'location');
  const chunk = db.get<{ id: number }>('SELECT id FROM canon_chunk WHERE project_id = ? ORDER BY seq LIMIT 1', project.id)!;
  const refs = JSON.stringify([{ source: 's', locator: 'p1', chunk: chunk.id }]);
  const factsBefore = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = ?', project.id)?.n ?? 0;
  const relBefore = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project.id)?.n ?? 0;
  db.run('INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    project.id, a, a, 'friend of', 'self quote', refs, now);
  db.run('INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, evidence, source_refs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    project.id, a, loc, 'father of', 'place as child', 'father quote', refs, now);
  db.run('INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    project.id, a, b, 'met', 'they met quote', refs, now);
  const hits = checker.checkRelations(db, project.id);
  const rules = new Set(hits.map((h) => h.rule));
  assert.ok(rules.has('self-tie'), 'self tie flagged');
  assert.ok(rules.has('kinship-vs-kind') || rules.has('moment-as-tie') || rules.has('empty-evidence') || rules.has('silent-noun'), 'seeded violation flagged');
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project.id)?.n, relBefore + 3, 'flags only, no rows added or removed');
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = ?', project.id)?.n, factsBefore, 'never writes facts');
  db.close();
});

test('audit notes are written by default', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'audit-default');
  const path = lorebook.writeAuditNote(project.id, 'probe-test', ['windows visited: 1', 'ties banked: 0'], db);
  db.close();
  assert.ok(path && existsSync(path), 'note file exists alongside DB writes');
  const text = readFileSync(path!, 'utf8');
  assert.ok(text.includes('windows visited'));
  rmSync(path!, { force: true });
});

test('temp-DB runs do not pollute the repo dir', async () => {
  const repoDir = join(process.cwd(), '.audits');
  const countRepo = (): number => {
    try { return readdirSync(repoDir).length; } catch { return 0; }
  };
  const { db, path: dbPath } = tempDb();
  const project = seedProject(db, 'audit-nopollute');
  const before = countRepo();
  const llm = mockProvider(() => JSON.stringify({ entities: [], facts: [], relations: [], timeline: [] }));
  await lorebook.extractLore(db, llm, project.id, { windowSize: 8, concurrency: 1, maxWindows: 1 } as never);
  db.close();
  assert.equal(countRepo(), before, 'no new files in repo .audits from temp-DB runs');
  const { dirname } = await import('node:path');
  const { tmpdir } = await import('node:os');
  void dirname; void tmpdir;
  void dbPath;
});
