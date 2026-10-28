/**
 * Blind rating packet.
 *
 * Automated measurements cannot tell whether a chapter is any good. This
 * builds a packet a person can read: the same chapter from each model, with
 * the model hidden, in an order that is shuffled with a fixed seed, and a form
 * to fill in.
 *
 * The key that says which passage is which model is written to a separate file
 * and is not part of the packet.
 *
 *   node testing/scripts/evaluate-blind.ts <run-id> [--out testing/benchmarks/blind]
 *   node testing/scripts/evaluate-blind.ts <run-id> --analyze
 *
 * The run id is always explicit: there is no "latest" run. A packet is built
 * once per run and an existing packet is never overwritten.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RunStore, isMain, type ScenarioResult } from './benchmark/harness.ts';
import { ProgressStore } from './benchmark/progress.ts';

/** The scales the rater is asked to use. */
export const CRITERIA: { key: string; label: string; higherIsBetter: boolean; note: string }[] = [
  { key: 'prose', label: 'Prose quality', higherIsBetter: true, note: 'Does the writing hold up as writing: sentence craft, rhythm, specificity.' },
  { key: 'voice', label: 'Character voice', higherIsBetter: true, note: 'Can you tell the characters apart? Does anyone sound like themselves?' },
  { key: 'dialogue', label: 'Dialogue', higherIsBetter: true, note: 'Do the characters talk like people, and do they talk to each other rather than to the reader?' },
  { key: 'pacing', label: 'Scene pacing', higherIsBetter: true, note: 'Does the scene move? Is anything padded or skipped?' },
  { key: 'emotion', label: 'Emotional credibility', higherIsBetter: true, note: 'Do the feelings land, or are they announced?' },
  { key: 'originality', label: 'Originality within the premise', higherIsBetter: true, note: 'Given the premise, is this an individual way of telling it?' },
  { key: 'outline', label: 'Outline adherence', higherIsBetter: true, note: 'Did the chapter do what the plan said it should do?' },
  { key: 'canon', label: 'Canon and AU consistency', higherIsBetter: true, note: 'Does it keep the divergence, and does it not contradict the source?' },
  { key: 'knowledge', label: 'Character knowledge consistency', higherIsBetter: true, note: 'Does anyone know something they could not know yet?' },
  { key: 'repetition', label: 'Freedom from repetition', higherIsBetter: true, note: 'Does the chapter say the same thing more than once?' },
];

function shuffle<T>(items: T[], seed: number): T[] {
  // A small deterministic shuffle, so the packet can be rebuilt exactly.
  const out = [...items];
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface PacketEntry {
  code: string;
  model: string;
  seed: number;
  repetition: number;
  body: string;
  metrics: Record<string, unknown>;
}

interface ParsedRatings {
  rows: Map<string, Map<string, number | null>>;
  scoreCount: number;
}

/** Validate a rating sheet before any code reads the answer key. */
function parseRatingsFile(path: string, runId: string, expectedCodes: string[]): ParsedRatings {
  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error(`ratings file for run "${runId}" is empty`);
  if (lines.length === 1) return { rows: new Map(), scoreCount: 0 };

  const expectedHeader = ['passage', ...CRITERIA.map((criterion) => criterion.key)];
  const header = lines[0]!.split(',').map((cell) => cell.trim());
  if (header.length !== expectedHeader.length || header.some((value, i) => value !== expectedHeader[i])) {
    throw new Error(`ratings file for run "${runId}" has an invalid header`);
  }

  const rows = new Map<string, Map<string, number | null>>();
  let scoreCount = 0;
  for (const [index, line] of lines.slice(1).entries()) {
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length !== expectedHeader.length) {
      throw new Error(`ratings row ${index + 2} for run "${runId}" has the wrong number of columns`);
    }
    const code = cells[0]!;
    if (!expectedCodes.includes(code)) throw new Error(`ratings file for run "${runId}" has unknown passage "${code}"`);
    if (rows.has(code)) throw new Error(`ratings file for run "${runId}" has duplicate passage "${code}"`);
    const scores = new Map<string, number | null>();
    for (let i = 0; i < CRITERIA.length; i++) {
      const key = CRITERIA[i]!.key;
      const raw = cells[i + 1]!;
      if (!raw) {
        scores.set(key, null);
        continue;
      }
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > 5) {
        throw new Error(`invalid rating for passage ${code}, ${key}: "${raw}" (expected integer 1–5 or blank)`);
      }
      scores.set(key, value);
      scoreCount++;
    }
    rows.set(code, scores);
  }

  const missing = expectedCodes.filter((code) => !rows.has(code));
  if (missing.length) throw new Error(`ratings file for run "${runId}" is missing passage rows: ${missing.join(', ')}`);
  return { rows, scoreCount };
}

/** One initial prompt signature per run, or null when prompts were not recorded. */
function assertSinglePrompt(label: string, results: ScenarioResult[]): string | null {
  const withPrompts = results.filter((result) => result.calls?.length);
  if (withPrompts.length && withPrompts.length !== results.length) {
    throw new Error(`${label} has writing outputs with missing recorded prompts; refusing a blind comparison`);
  }
  if (!withPrompts.length) return null;
  const signatures = new Set(
    withPrompts.map((result) => `${result.calls[0]!.system}\0${result.calls[0]!.prompt}`),
  );
  if (signatures.size > 1) {
    throw new Error(`writers in ${label} did not receive the same initial prompt; refusing a blind comparison`);
  }
  return [...signatures][0]!;
}

/** A packet is built once; rebuilding would replace a form someone is filling in. */
function assertFreshPacketDir(dir: string, id: string, kind: string): void {
  if (existsSync(dir) && readdirSync(dir).length) {
    throw new Error(`blind packet for "${id}" already exists at ${dir}; choose a new ${kind} id`);
  }
}

/** The packet, forms, brief, AI-rater input and answer key, in the one shared format. */
function writePacketArtifacts(dir: string, entries: PacketEntry[], key: Record<string, unknown>): void {
  // The packet: what the rater sees. No run id and no model details here:
  // run ids can name the corpus model, and a rater must not learn it.
  const lines: string[] = [];
  lines.push('# Blind chapter rating');
  lines.push('');
  lines.push('Blind writer comparison. Each passage is an output from the same story brief and chapter target.');
  lines.push('Model identities are hidden; a model may contribute multiple samples. Rate each passage independently.');
  lines.push('');
  lines.push('Scale: 1 (poor) to 5 (excellent). Rate only what you can see in the passage; the plan and');
  lines.push('the source are described in the brief below each passage.');
  lines.push('');
  for (const e of entries) {
    lines.push('---');
    lines.push('');
    lines.push(`## Passage ${e.code}`);
    lines.push('');
    lines.push(e.body.trim());
    lines.push('');
  }
  const packetText = lines.join('\n');
  writeFileSync(join(dir, 'packet.md'), packetText);

  // The form.
  const form: string[] = [];
  form.push('passage,' + CRITERIA.map((c) => c.key).join(','));
  for (const e of entries) form.push(`${e.code},` + CRITERIA.map(() => '').join(','));
  const ratingsTemplate = form.join('\n') + '\n';
  writeFileSync(join(dir, 'ratings.csv'), ratingsTemplate);
  writeFileSync(join(dir, 'ai-ratings.csv'), ratingsTemplate);

  // The notes a rater needs: what the chapter was supposed to be.
  const brief = entries
    .map((e) => {
      const m = e.metrics as Record<string, unknown>;
      return [
        `## Passage ${e.code}`,
        '',
        'The brief the writer was given:',
        '',
        '- premise: an alternate universe in which Harry Potter is sorted into Slytherin instead of Gryffindor.',
        '- chapter 1: the Sorting Ceremony. The hat hesitates over Harry, says something to him alone, and',
        '  places him in Slytherin. Ron is somewhere across the hall and does not come over; Hermione does come',
        '  over and does not know what to say. The house is polite rather than triumphant.',
        '- canon: the four houses, the ceremony, the hats, the points. The change is one decision made in public.',
        '',
        `Measured: ${m.words ?? '?'} words (target ${m.target ?? '?'}), repetition ${m.repetition ?? '?'}, ` +
          `invented names ${m.inventedNames ?? '?'}.`,
        '',
      ].join('\n');
    })
    .join('\n');
  const briefText = `# Brief\n\n${brief}`;
  writeFileSync(join(dir, 'brief.md'), briefText);

  // A self-contained input for a fresh AI rater. It includes no model mapping,
  // run identifier, human ratings or answer key, avoiding accidental leakage
  // when only this file is given to the independent evaluator.
  const aiRaterInput = [
    '# Independent AI rating task',
    '',
    'You are an independent evaluator. Score the anonymous passages using only this packet and brief. Do not infer model identities, consult external sources, or use ratings from another evaluator.',
    'Rate each passage independently on every criterion from 1 (poor) to 5 (excellent). Use an empty cell only when a criterion is genuinely not assessable. Return only CSV with the exact header below and one row per passage.',
    '',
    'CSV header: passage,' + CRITERIA.map((criterion) => criterion.key).join(','),
    '',
    '## Rating criteria',
    '',
    ...CRITERIA.map((criterion) => `- ${criterion.key}: ${criterion.label}. ${criterion.note}`),
    '',
    '## Shared brief',
    '',
    briefText,
    '',
    '## Blind passages',
    '',
    packetText,
    '',
  ].join('\n');
  writeFileSync(join(dir, 'ai-rater-input.md'), aiRaterInput);

  // The key: not part of the packet.
  writeFileSync(join(dir, 'key.json'), JSON.stringify(key, null, 2));
}

export function buildPacket(
  runId: string,
  outDir = 'testing/benchmarks/blind',
  role = 'writing',
  seed = 7,
  baseDir = 'testing/benchmarks/runs',
): { dir: string; entries: PacketEntry[] } {
  const { results } = RunStore.load(runId, baseDir);
  const written = results.filter((r) => r.role === role && r.ok && r.artefact?.trim());
  if (!written.length) throw new Error(`no writing results in run "${runId}"`);

  assertSinglePrompt(`run "${runId}"`, written);

  const shuffled = shuffle(written, seed);
  const entries: PacketEntry[] = shuffled.map((r, i) => ({
    code: String.fromCharCode(65 + i),
    model: r.model,
    seed: r.seed,
    repetition: r.repetition,
    body: r.artefact ?? '',
    metrics: r.metrics,
  }));

  const dir = join(outDir, runId);
  assertFreshPacketDir(dir, runId, 'run');
  mkdirSync(dir, { recursive: true });

  writePacketArtifacts(dir, entries, {
    runId,
    role,
    seed,
    entries: entries.map((e) => ({ code: e.code, model: e.model, seed: e.seed, repetition: e.repetition })),
  });

  return { dir, entries };
}

/* ------------------------------------------------------- paired extraction arms */

export type PairedArm = 'qwen' | 'gemma';

/** Each arm must carry the same three seeds for every writer. */
export const PAIRED_SEEDS_PER_ARM = 3;

export interface PairedPacketEntry extends PacketEntry {
  arm: PairedArm;
}

function assertMatchedSeeds(
  arms: { arm: PairedArm; runId: string; results: ScenarioResult[] }[],
): void {
  const qwenModels = new Set(arms.find((a) => a.arm === 'qwen')!.results.map((r) => r.model));
  const gemmaModels = new Set(arms.find((a) => a.arm === 'gemma')!.results.map((r) => r.model));
  const onlyQwen = [...qwenModels].filter((model) => !gemmaModels.has(model));
  const onlyGemma = [...gemmaModels].filter((model) => !qwenModels.has(model));
  if (onlyQwen.length || onlyGemma.length) {
    throw new Error(
      `paired arms must use the same writers; only in the Qwen arm: ${onlyQwen.join(', ') || 'none'}; ` +
        `only in the Gemma arm: ${onlyGemma.join(', ') || 'none'}`,
    );
  }

  for (const model of qwenModels) {
    const seedsByArm = new Map<PairedArm, number[]>();
    for (const { arm, runId, results } of arms) {
      const rows = results.filter((r) => r.model === model);
      if (rows.length !== PAIRED_SEEDS_PER_ARM) {
        throw new Error(
          `the ${arm} arm run "${runId}" needs exactly ${PAIRED_SEEDS_PER_ARM} writing samples for model ` +
            `"${model}"; found ${rows.length}`,
        );
      }
      const seeds = rows.map((r) => r.seed);
      if (new Set(seeds).size !== seeds.length) {
        throw new Error(`model "${model}" has duplicate seeds in the ${arm} arm; the three seeds must be distinct`);
      }
      seedsByArm.set(arm, [...seeds].sort((a, b) => a - b));
    }
    const qwenSeeds = seedsByArm.get('qwen')!;
    const gemmaSeeds = seedsByArm.get('gemma')!;
    if (qwenSeeds.some((seed, i) => seed !== gemmaSeeds[i])) {
      throw new Error(
        `model "${model}" seeds differ between arms: Qwen [${qwenSeeds.join(', ')}], ` +
          `Gemma [${gemmaSeeds.join(', ')}]; the paired arms must use the same seeds`,
      );
    }
  }
}

/**
 * A paired blind packet: one run written against the Qwen-extraction corpus and
 * one against the Gemma-extraction corpus.
 *
 * The two corpora legitimately give the writers two different initial prompts,
 * so up to two prompt signatures are allowed, one per arm. Within an arm the
 * signature must be single. Every writer must contribute the same three seeds
 * in both arms, otherwise the passages are not paired.
 */
export function buildPairedPacket(
  qwenRun: string,
  gemmaRun: string,
  pairedId: string,
  outDir = 'testing/benchmarks/blind',
  role = 'writing',
  seed = 7,
  baseDir = 'testing/benchmarks/runs',
): { dir: string; entries: PairedPacketEntry[] } {
  if (!pairedId?.trim()) throw new Error('a paired packet id is required');
  if (qwenRun === gemmaRun) throw new Error('the paired arms need two different runs');

  const arms: { arm: PairedArm; runId: string; results: ScenarioResult[] }[] = [];
  const signatures = new Set<string>();
  for (const [arm, runId] of [
    ['qwen', qwenRun],
    ['gemma', gemmaRun],
  ] as const) {
    const { results } = RunStore.load(runId, baseDir);
    const written = results.filter((r) => r.role === role && r.ok && r.artefact?.trim());
    if (!written.length) throw new Error(`no writing results in the ${arm} arm run "${runId}"`);
    const signature = assertSinglePrompt(`the ${arm} arm of run "${runId}"`, written);
    if (signature) signatures.add(signature);
    arms.push({ arm, runId, results: written });
  }
  if (signatures.size > 2) {
    throw new Error(
      `runs "${qwenRun}" and "${gemmaRun}" have more than two initial prompt signatures; ` +
        'the paired comparison allows one per arm',
    );
  }
  assertMatchedSeeds(arms);

  const collected = arms.flatMap(({ arm, results }) => results.map((result) => ({ arm, result })));
  const shuffled = shuffle(collected, seed);
  const entries: PairedPacketEntry[] = shuffled.map(({ arm, result }, i) => ({
    code: String.fromCharCode(65 + i),
    arm,
    model: result.model,
    seed: result.seed,
    repetition: result.repetition,
    body: result.artefact ?? '',
    metrics: result.metrics,
  }));

  const dir = join(outDir, pairedId);
  assertFreshPacketDir(dir, pairedId, 'paired packet');
  mkdirSync(dir, { recursive: true });

  writePacketArtifacts(dir, entries, {
    pairedId,
    arms: { qwen: qwenRun, gemma: gemmaRun },
    role,
    seed,
    entries: entries.map((e) => ({
      code: e.code,
      arm: e.arm,
      model: e.model,
      seed: e.seed,
      repetition: e.repetition,
    })),
  });

  return { dir, entries };
}

export function analyzeRatings(runId: string, outDir = 'testing/benchmarks/blind'): void {
  const dir = join(outDir, runId);
  const keyPath = join(dir, 'key.json');
  const ratingsPath = join(dir, 'ratings.csv');
  if (!existsSync(keyPath) || !existsSync(ratingsPath)) {
    const missing = [!existsSync(keyPath) ? keyPath : '', !existsSync(ratingsPath) ? ratingsPath : '']
      .filter(Boolean)
      .join(' and ');
    throw new Error(`cannot analyze run "${runId}": missing ${missing}`);
  }

  const packetPath = join(dir, 'packet.md');
  if (!existsSync(packetPath)) throw new Error(`cannot analyze run "${runId}": missing ${packetPath}`);
  const packet = readFileSync(packetPath, 'utf8');
  const passageCodes = [...packet.matchAll(/^## Passage ([A-Z]+)\s*$/gm)].map((match) => match[1]!);
  if (!passageCodes.length) throw new Error(`cannot analyze run "${runId}": packet has no passages`);

  // Validate ratings before touching key.json. A newly generated packet also
  // has an AI sheet; require that sheet to contain at least one score before
  // unblinding so the paired evaluation is locked first.
  const humanRatings = parseRatingsFile(ratingsPath, runId, passageCodes);
  if (!humanRatings.scoreCount) {
    console.log(`No scores in ratings.csv for run "${runId}"; nothing to analyze.`);
    return;
  }
  const aiRatingsPath = join(dir, 'ai-ratings.csv');
  if (existsSync(aiRatingsPath)) {
    const aiRatings = parseRatingsFile(aiRatingsPath, runId, passageCodes);
    if (!aiRatings.scoreCount) {
      throw new Error(`ai-ratings.csv for run "${runId}" has no scores yet; finalize both rating sets before unblinding`);
    }
  }

  const key = JSON.parse(readFileSync(keyPath, 'utf8')) as {
    runId?: string;
    pairedId?: string;
    entries: { code: string; model: string; arm?: string }[];
  };
  if (key.runId && key.runId !== runId) {
    throw new Error(`ratings in ${dir} belong to run "${key.runId}", not "${runId}"`);
  }
  if (key.pairedId && key.pairedId !== runId) {
    throw new Error(`ratings in ${dir} belong to paired packet "${key.pairedId}", not "${runId}"`);
  }
  // The arm is part of the label so the two extraction arms are never merged.
  const codeToModel = new Map(
    key.entries.map((e) => [e.code, e.arm ? `${e.model} [${e.arm}]` : e.model]),
  );
  const criteriaKeys = CRITERIA.map((criterion) => criterion.key);

  const modelScores = new Map<string, Map<string, number[]>>();
  for (const [code, row] of humanRatings.rows) {
    const model = codeToModel.get(code);
    if (!model) continue;
    if (!modelScores.has(model)) modelScores.set(model, new Map());
    const scores = modelScores.get(model)!;
    for (const k of criteriaKeys) {
      const v = row.get(k) ?? null;
      if (v === null) continue;
      if (!scores.has(k)) scores.set(k, []);
      scores.get(k)!.push(v);
    }
  }

  const totalScores = [...modelScores.values()].reduce(
    (sum, byCriterion) => sum + [...byCriterion.values()].reduce((n, v) => n + v.length, 0),
    0,
  );
  if (!totalScores) {
    console.log(`No scores in ratings.csv for run "${runId}"; nothing to analyze.`);
    return;
  }

  const mean = (arr: number[]): number | undefined => {
    if (!arr.length) return undefined;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  };
  /** "4.0 (3)" — the mean and how many valid ratings stand behind it. */
  const cell = (arr: number[], digits = 1): string => {
    const m = mean(arr);
    return m === undefined ? `n/a (0)` : `${m.toFixed(digits)} (${arr.length})`;
  };

  console.log(`\n# Blind human ratings — ${runId}\n`);
  console.log('Scores are means of the ratings that were given; blank cells are N/A and are never');
  console.log('counted as zero. Each cell is "mean (number of valid ratings)".\n');
  console.log(`| model | ${criteriaKeys.join(' | ')} | overall | writing* |`);
  console.log(`| --- | ${criteriaKeys.map(() => '---:').join(' | ')} | ---: | ---: |`);
  for (const [model, byCriterion] of modelScores) {
    const cells = criteriaKeys.map((k) => cell(byCriterion.get(k) ?? []));
    const all = criteriaKeys.flatMap((k) => byCriterion.get(k) ?? []);
    const writingKeys = criteriaKeys.filter((k) => k !== 'repetition');
    const writing = writingKeys.flatMap((k) => byCriterion.get(k) ?? []);
    console.log(`| ${model} | ${cells.join(' | ')} | ${cell(all, 2)} | ${cell(writing, 2)} |`);
  }
  console.log('\n*writing mean excludes the repetition scale.\n');
}

function main(): void {
  const runId = process.argv[2];
  if (!runId) {
    console.log('usage: node testing/scripts/evaluate-blind.ts <run-id> [--out testing/benchmarks/blind] [--progress-run <id>] [--analyze]');
    return;
  }
  const outArg = process.argv.indexOf('--out');
  const outDir = outArg >= 0 ? process.argv[outArg + 1] : 'testing/benchmarks/blind';
  const progressArg = process.argv.indexOf('--progress-run');
  const progressRun = progressArg >= 0 ? process.argv[progressArg + 1] : '';

  if (process.argv.includes('--analyze')) {
    analyzeRatings(runId, outDir);
    if (progressRun) {
      const progress = ProgressStore.open(progressRun);
      progress.setCounts('comparison', { completed: 1, total: 1, unit: 'step' });
      progress.completeStage('comparison', 'ratings unblinded after both sheets were final');
    }
    return;
  }

  const runsDir = process.env.FANFABLE_RUNS_DIR || 'testing/benchmarks/runs';
  const { dir, entries } = buildPacket(runId, outDir, 'writing', 7, runsDir);
  if (progressRun) {
    const progress = ProgressStore.open(progressRun);
    progress.setCounts('blind-packet', { completed: 1, total: 1, unit: 'packet' });
    progress.completeStage('blind-packet', `${entries.length} anonymous passages`);
    const cells = entries.length * CRITERIA.length;
    progress.setWaiting('ratings-human', {
      total: cells,
      completed: 0,
      unit: 'cells',
      detail: `${dir}/ratings.csv`,
    });
    progress.setWaiting('ratings-ai', {
      total: cells,
      completed: 0,
      unit: 'cells',
      detail: `${dir}/ai-ratings.csv`,
    });
  }
  console.log(`packet written to ${dir}`);
  console.log('\nRate the passages in ratings.csv. A separate AI evaluator may fill ai-ratings.csv; give it only ai-rater-input.md, not human ratings, run metadata, or the answer key.');
  console.log('Do not analyze until both rating sets are final.');
  console.log(`when both rating sets are final, run: node testing/scripts/evaluate-blind.ts ${runId} --analyze`);
}

if (isMain(import.meta.url)) {
  main();
}
