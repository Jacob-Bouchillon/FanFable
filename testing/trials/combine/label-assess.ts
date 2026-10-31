/**
 * Slate labeling + assessment (Q8, committed prompts only).
 *
 * Trial-only. Takes the kind-less provisional slate rows on the LIVE bank,
 * labels each with a closed kind via the committed relabel path scoped to
 * those row ids, then scores unassessed rows via the committed assess path
 * (already-assessed rows are skipped by the path itself). Q8 client built
 * explicitly (temp 0, seed 42, think false); live project settings untouched.
 * Counts only, never passage prose or names.
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/combine/label-assess.ts
 *
 * Writes assessments + kinds on live rows (backup pre-exists) and
 * testing/trials/combine/factory-label.json (gitignored). Keeper never
 * assigned; ties bank on the user's word next.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Db } from '../../../fanfable/src/core/db.ts';
import { clientFrom } from '../../../fanfable/src/core/llm.ts';
import { relabelRelations, assessRelations } from '../../../fanfable/src/lorebook.ts';

const LIVE = `${process.env.HOME}/.local/share/fanfable/fanfable.db`;
const PROJECT = 'halfbook';
const OUT = 'testing/trials/combine/factory-label.json';

function fail(message: string): never {
  throw new Error(`label-assess: ${message}`);
}

export async function run(): Promise<Record<string, unknown>> {
  const db = new Db(resolve(LIVE));
  try {
    const project = db.get<{ id: number; settings: string }>(
      'SELECT id, settings FROM project WHERE name = ?',
      PROJECT,
    );
    if (!project) fail(`no project ${PROJECT}`);
    const stored = JSON.parse(project.settings || '{}') as Record<string, unknown>;
    const llm = clientFrom({
      ...stored,
      provider: 'ollama',
      model: 'spark-x2-q8',
      temperature: 0,
      seed: 42,
      think: false,
    });
    const ids = db
      .all<{ id: number }>(
        "SELECT id FROM canon_relation WHERE project_id = ? AND review_status = 'needs_review' AND kind = '' ORDER BY id",
        project.id,
      )
      .map((r) => r.id);
    console.log(`slate rows to label: ${ids.length}`);
    const relabel = await relabelRelations(db, llm, project.id, {
      ids,
      write: true,
      onProgress: (message) => process.stdout.write(`  ${message.slice(0, 80)}\n`),
    });
    console.log(
      `relabel: checked ${relabel.checked} changed ${relabel.changed} ` +
        `skipped ${JSON.stringify(relabel.skipped)}`,
    );
    const assess = await assessRelations(db, llm, project.id, {
      write: true,
      onProgress: (message) => process.stdout.write(`  ${message.slice(0, 80)}\n`),
    });
    console.log(
      `assess: assessed ${assess.assessed} above ${assess.aboveThreshold} ` +
        `userAvg ${assess.userConfirmedAverage?.toFixed(3) ?? 'none'}`,
    );
    console.log(`assess bands: ${JSON.stringify(assess.bands)}`);
    const result = {
      slateIds: ids.length,
      relabel: { checked: relabel.checked, changed: relabel.changed, skipped: relabel.skipped },
      assess: {
        assessed: assess.assessed,
        skipped: assess.skipped,
        bands: assess.bands,
        aboveThreshold: assess.aboveThreshold,
        aboveByStatus: assess.aboveByStatus,
        userConfirmedAverage: assess.userConfirmedAverage,
      },
    };
    writeFileSync(OUT, JSON.stringify(result, null, 1));
    console.log(`manifest ${OUT}`);
    return result;
  } finally {
    db.close();
  }
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('label-assess.ts')) {
  run().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
