/**
 * The last uncovered seam: extraction refuses a citation and files a tie note;
 * that objection must appear in the court record, not only in canon_tie_note.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, seedProject, mockProvider } from './helpers.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import * as ruling from '../../fanfable/src/ruling.ts';

const ENTITIES = {
  entities: [
    {
      kind: 'character',
      name: 'Serena Marsh',
      aliases: [],
      summary: 'a watcher',
      attributes: {},
      role: '',
      status: '',
      chunk_index: 0,
      evidence: 'Serena Marsh watched it from the ridge',
    },
    {
      kind: 'character',
      name: 'Kade',
      aliases: [],
      summary: 'a man',
      attributes: {},
      role: '',
      status: '',
      chunk_index: 0,
      evidence: 'Serena Marsh watched it from the ridge',
    },
  ],
  facts: [],
};

function mockRelations(evidence: string, kind = 'apprentice of') {
  return mockProvider((req) => {
    const system = (req.system ?? '') as string;
    if (system.includes('KNOWN ENTITIES')) {
      return JSON.stringify({
        relations: [
          { from: 'Serena Marsh', to: 'Kade', kind, description: 'x', chunk_index: 0, evidence },
        ],
      });
    }
    if (system.includes('"entities"')) return JSON.stringify(ENTITIES);
    return JSON.stringify({ entities: [], facts: [], timeline: [] });
  });
}

test('an unsupported extraction citation writes an objection ruling', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'objection-e2e');
  await lorebook.extractLore(db, mockRelations('This sentence appears nowhere in the passage.'), project.id);
  const note = db.get<{ id: number; reason: string }>(
    'SELECT id, reason FROM canon_tie_note WHERE project_id = ? ORDER BY id LIMIT 1',
    project.id,
  );
  assert.ok(note, 'the refusal is filed as a tie note');
  assert.equal(note!.reason, 'unsupported-citation');
  const objections = ruling.listRulings(db, project.id, { role: 'objection' });
  assert.equal(objections.length, 1, 'the note is also a ruling');
  assert.equal(objections[0]!.actor, 'guard');
  assert.equal(objections[0]!.standard, 'tie-note');
  assert.equal(objections[0]!.to_status, 'pending');
  assert.match(objections[0]!.basis, /unsupported-citation/);
  db.close();
});

test('a moment from extraction writes an objection ruling too', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'moment-e2e');
  await lorebook.extractLore(db, mockRelations('Serena Marsh watched it from the ridge', 'met with'), project.id);
  const note = db.get<{ reason: string }>(
    'SELECT reason FROM canon_tie_note WHERE project_id = ? ORDER BY id LIMIT 1',
    project.id,
  );
  assert.ok(note, 'the moment is filed as a tie note');
  assert.equal(note!.reason, 'moment');
  const objections = ruling
    .listRulings(db, project.id, { role: 'objection' })
    .filter((r) => r.basis.includes('moment'));
  assert.equal(objections.length, 1);
  db.close();
});
