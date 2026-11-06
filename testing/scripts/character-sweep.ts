/**
 * Character sweep runner.
 *
 * Dry-run by default. --model asks the project's LlmClient for ties; --write
 * applies them. No model call happens without --model.
 */
import { Db, fromJson } from '../../fanfable/src/core/db.ts';
import { formatKnownEntities } from '../../fanfable/src/extract/extract-prompts.ts';
import { RELATION_FAMILIES } from '../../fanfable/src/identity/relation-proof.ts';
import { listEntities, relationsSystemPrompt } from '../../fanfable/src/lorebook.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import {
  applySweep,
  batchSweepPassages,
  parseRelationSweepAnswer,
  planSweep,
  sweepRelationKey,
  validateSweepTies,
  type SweepPassage,
  type SweepTarget,
  type SweepTie,
} from '../../fanfable/src/web/character-sweep.ts';

const EXTRACTOR_KINDS = new Set(
  RELATION_FAMILIES.flatMap((rule) => [rule.canonical.replace(/_/g, ' '), ...rule.keys]),
);

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numberFlag(name: string, fallback: number): number {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function knownCharacters(db: Db, projectId: number): Map<string, number> {
  const rows = db.all<{ id: number; name: string; aliases: string }>(
    `SELECT id, name, aliases FROM canon_entity
      WHERE project_id = ? AND kind = 'character' ORDER BY id`,
    projectId,
  );
  const known = new Map<string, number>();
  for (const row of rows) {
    const names = [row.name, ...fromJson<string[]>(row.aliases, []).map(String)];
    for (const name of names) {
      const key = String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (key && !known.has(key)) known.set(key, Number(row.id));
    }
  }
  return known;
}

function existingRelations(db: Db, projectId: number): Set<string> {
  const rows = db.all<{ from_entity: number; to_entity: number; kind: string }>(
    'SELECT from_entity, to_entity, kind FROM canon_relation WHERE project_id = ?',
    projectId,
  );
  const existing = new Set<string>();
  for (const row of rows) {
    existing.add(sweepRelationKey(Number(row.from_entity), Number(row.to_entity), row.kind));
  }
  return existing;
}

function mentions(text: string, form: string): boolean {
  const value = String(form ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(text);
}

function batchNames(
  entities: ReturnType<typeof listEntities>,
  target: SweepTarget,
  batch: SweepPassage[],
): string[] {
  const text = batch.map((passage) => passage.text).join(' ');
  const names = entities
    .filter((entity) => [entity.name, ...entity.aliases].some((form) => mentions(text, form)))
    .map((entity) => entity.name);
  if (!names.includes(target.name)) names.unshift(target.name);
  if (!names.length) names.push(target.name);
  if (!names.slice(0, 80).includes(target.name)) names.unshift(target.name);
  return [...new Set(names)].slice(0, 80);
}

function passageBlockFor(batch: SweepPassage[]): string {
  return 'PASSAGES:\n' + batch
    .map((passage, index) =>
      `[#${index}] ${passage.sourceTitle ?? ''} | ${passage.locator}\n${passage.text.slice(0, 1400)}`)
    .join('\n\n');
}

const dbPath = flag('db') ?? process.argv[2];
const projectName = flag('project') ?? process.argv[3] ?? 'hp1';
const castRaw = flag('cast');
const cast = castRaw === undefined ? undefined : castRaw.split(',').map((name) => name.trim()).filter(Boolean);
const minAppearances = Math.max(0, Math.floor(numberFlag('min-appearances', 3)));
const maxPassages = Math.max(1, Math.floor(numberFlag('max-passages', 30)));
const batchSize = Math.max(1, Math.floor(numberFlag('batch-size', 6)));
const model = flag('model');
const write = process.argv.includes('--write');
if (!dbPath) {
  console.error('usage: node --no-warnings testing/scripts/character-sweep.ts --db <path> --project <name> [--cast "Harry,Ron,Snape"] [--min-appearances 3] [--max-passages 30] [--batch-size 6] [--model <model>] [--write]');
  process.exit(2);
}

const db = new Db(dbPath);
try {
  const project = controller.getProjectByName(db, projectName);
  if (!project) {
    console.error(`no project named "${projectName}" in ${dbPath}`);
    db.close();
    process.exit(1);
  }

  const targets = planSweep(db, project.id, { cast, minAppearances, maxPassages });
  const allEntities = listEntities(db, project.id);
  const client = model
    ? controller.createClient({ ...project.settings, model } as never)
    : null;
  const retryClient = model
    ? controller.createClient({ ...project.settings, model, seed: 43 } as never)
    : null;
  const results: Array<{
    entityId: number;
    name: string;
    aliases: string[];
    passageCount: number;
    passages: SweepTarget['passages'];
    calls: number;
    errors?: string[];
    modelTexts?: string[];
    proposals: Array<{ tie: SweepTie; toId: number; bothInQuote: boolean }>;
    rejections: Array<{ tie: SweepTie; reason: string }>;
    counts?: { added: number; duplicates: number; rejected: number; byReason: Record<string, number> };
  }> = [];

  for (const target of targets) {
    let calls = 0;
    const errors: string[] = [];
    let modelTexts: string[] = [];
    let ties: SweepTie[] = [];
    let proposals: Array<{ tie: SweepTie; toId: number; bothInQuote: boolean }> = [];
    let rejections: Array<{ tie: SweepTie; reason: string }> = [];
    let counts: { added: number; duplicates: number; rejected: number; byReason: Record<string, number> } | undefined;

    if (client) {
      const known = knownCharacters(db, project.id);
      const existing = existingRelations(db, project.id);
      const batches = batchSweepPassages(target.passages, batchSize);
      let offset = 0;
      for (const batch of batches) {
        const system = `${relationsSystemPrompt()}\n\n${formatKnownEntities(batchNames(allEntities, target, batch), allEntities)}`;
        let responseText: string | null = null;
        for (const attempt of [client, retryClient]) {
          if (!attempt) continue;
          calls++;
          try {
            const response = await attempt.chat({
              system,
              messages: [{ role: 'user', content: passageBlockFor(batch) }],
              temperature: 0,
              maxTokens: 2000,
              format: 'json',
            });
            responseText = response.text;
            break;
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }
        if (responseText === null) continue;
        modelTexts.push(responseText);
        const batchTies = parseRelationSweepAnswer(responseText, target, known).map((tie) => ({
          ...tie,
          chunkIndex: offset + tie.chunkIndex,
        }));
        ties.push(...batchTies);
        const validation = validateSweepTies(batchTies, target, known, existing, EXTRACTOR_KINDS);
        proposals.push(...validation.proposals);
        rejections.push(...validation.rejections);
        offset += batch.length;
      }
      counts = applySweep(db, project.id, target, ties, { dryRun: !write, allowedKinds: EXTRACTOR_KINDS });
    }

    results.push({
      entityId: target.entityId,
      name: target.name,
      aliases: target.aliases,
      passageCount: target.passages.length,
      passages: target.passages,
      calls,
      ...(errors.length ? { errors } : {}),
      ...(modelTexts.length ? { modelTexts } : {}),
      proposals,
      rejections,
      ...(counts === undefined ? {} : { counts }),
    });
  }

  console.log(JSON.stringify({
    project: { id: project.id, name: project.name },
    model: model ?? null,
    write,
    cast: cast ?? null,
    minAppearances,
    maxPassages,
    batchSize,
    targetCount: targets.length,
    results,
  }, null, 2));
} finally {
  db.close();
}
