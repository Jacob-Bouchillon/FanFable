/**
 * Step 6 cost demo (local-only, mock model — counts, not prose).
 *
 * On a fresh import copy: full run vs budgeted run (windows mined, entities,
 * relations), then the lazy path (windows mined per query + follow-up).
 *
 *   node testing/scripts/phase1-step6-demo.ts
 */
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../fanfable/src/db.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as lore from '../../fanfable/src/answer/lore.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { retrieve } from '../../fanfable/src/answer/retrieval.ts';
import { MockProvider } from '../../fanfable/src/llm.ts';

const SERENA_QUOTE = 'Serena Marsh watched it from the ridge';
const KADE_QUOTE = 'said Kade behind her';

function mock(): MockProvider {
  const p = new MockProvider();
  p.handler = (req) => {
    const system = req.system ?? '';
    if (system.includes('search keywords')) return JSON.stringify({ terms: ['bridge'] });
    if (system.includes('KNOWN ENTITIES')) {
      return JSON.stringify({
        relations: [
          {
            from: 'Serena Marsh',
            to: 'Kade',
            kind: 'accompanied by',
            description: 'Kade stands behind her.',
            chunk_index: 0,
            evidence: SERENA_QUOTE,
          },
        ],
      });
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({
      entities: [
        {
          kind: 'character', name: 'Serena Marsh', aliases: [], summary: 'A woman on the ridge.',
          attributes: {}, role: '', status: '', chunk_index: 0, evidence: SERENA_QUOTE,
        },
        {
          kind: 'character', name: 'Kade', aliases: [], summary: 'A frightened man.',
          attributes: {}, role: '', status: '', chunk_index: 0, evidence: KADE_QUOTE,
        },
      ],
      facts: [],
    });
  };
  return p;
}

function freshImport(): { db: Db; projectId: number; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'step6-demo-'));
  const db = new Db(join(dir, 'demo.db'));
  const project = controller.createProject(db, 'demo');
  // Three copies of the sample book under different paths: 12 passages.
  for (let i = 0; i < 3; i++) {
    const path = join(dir, `book-${i}.txt`);
    copyFileSync('testing/tests/fixtures/sample-book.txt', path);
    lore.importSource(db, project.id, path);
  }
  const chunks = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?', project.id)?.n ?? 0;
  console.log(`imported ${chunks} passages`);
  return { db, projectId: project.id, dir };
}

const minedCount = (db: Db, projectId: number): number =>
  db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ? AND lore_mined = 1', projectId)?.n ?? 0;

// Full run.
{
  const { db, projectId } = freshImport();
  const stats = await lorebook.extractLore(db, mock(), projectId, { windowSize: 2 });
  const entities = lorebook.listEntities(db, projectId).length;
  const relations = lorebook.listRelations(db, projectId).length;
  console.log(`full: windows=${stats.windows} mined=${minedCount(db, projectId)} entities=${entities} relations=${relations}`);
  db.close();
}

// Budgeted run: 2 of 6 windows.
{
  const { db, projectId } = freshImport();
  const stats = await lorebook.extractLore(db, mock(), projectId, {
    windowSize: 2,
    maxWindows: 2,
    priorityFirst: 1,
    randomFloor: 1,
    seed: 7,
  });
  const entities = lorebook.listEntities(db, projectId).length;
  const relations = lorebook.listRelations(db, projectId).length;
  console.log(
    `budgeted: windows=${stats.windows} mined=${minedCount(db, projectId)} entities=${entities} relations=${relations} ` +
      `selection=${stats.selection?.selected}/${stats.selection?.total}`,
  );
  const names = lorebook.listEntities(db, projectId).map((e) => e.name).sort().join(',');
  console.log(`budgeted entities: ${names}`);
  db.close();
}

// Lazy path.
{
  const { db, projectId } = freshImport();
  const llm = mock();
  const first = await retrieve(db, llm, projectId, { query: 'the bridge and the lantern light' });
  console.log(`lazy q1: route=${first.stats.route} lazyMined=${JSON.stringify(first.stats.lazyMined ?? null)} mined=${minedCount(db, projectId)}`);
  const second = await retrieve(db, llm, projectId, { query: 'the bridge and the lantern light' });
  console.log(`lazy q2: lazyMined=${JSON.stringify(second.stats.lazyMined ?? null)} mined=${minedCount(db, projectId)}`);
  db.close();
}
