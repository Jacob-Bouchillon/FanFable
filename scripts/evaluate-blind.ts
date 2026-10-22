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
 *   node scripts/evaluate-blind.ts <run-id> [--out benchmarks/blind]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RunStore, isMain } from './benchmark/harness.ts';

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
  body: string;
  metrics: Record<string, unknown>;
}

export function buildPacket(
  runId: string,
  outDir = 'benchmarks/blind',
  role = 'writing',
  seed = 7,
): { dir: string; entries: PacketEntry[] } {
  const { results } = RunStore.load(runId);
  const written = results.filter((r) => r.role === role && r.ok && r.artefact?.trim());
  if (!written.length) throw new Error(`no writing results in run "${runId}"`);

  const shuffled = shuffle(written, seed);
  const entries: PacketEntry[] = shuffled.map((r, i) => ({
    code: String.fromCharCode(65 + i),
    model: r.model,
    body: r.artefact ?? '',
    metrics: r.metrics,
  }));

  const dir = join(outDir, runId);
  mkdirSync(dir, { recursive: true });

  // The packet: what the rater sees.
  const lines: string[] = [];
  lines.push('# Blind chapter rating');
  lines.push('');
  lines.push(`Run: ${runId}. Each passage is the same chapter of the same story, written by a different`);
  lines.push('model. The models are not identified. Rate every passage on every scale.');
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
  writeFileSync(join(dir, 'packet.md'), lines.join('\n'));

  // The form.
  const form: string[] = [];
  form.push('passage,' + CRITERIA.map((c) => c.key).join(','));
  for (const e of entries) form.push(`${e.code},` + CRITERIA.map(() => '').join(','));
  writeFileSync(join(dir, 'ratings.csv'), form.join('\n') + '\n');

  // The notes a rater needs: what the chapter was supposed to be.
  const brief = entries
    .map((e) => {
      const m = e.metrics as Record<string, unknown>;
      return [
        `## Passage ${e.code}`,
        '',
        'The brief the writer was given:',
        '',
        '- premise: an alternate universe in which Harry Potter is sorted into Slytherin instead of Gryffindin.',
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
  writeFileSync(join(dir, 'brief.md'), `# Brief\n\n${brief}`);

  // The key: not part of the packet.
  writeFileSync(
    join(dir, 'key.json'),
    JSON.stringify(
      {
        runId,
        role,
        seed,
        entries: entries.map((e) => ({ code: e.code, model: e.model })),
      },
      null,
      2,
    ),
  );

  return { dir, entries };
}

function analyzeRatings(runId: string, outDir = 'benchmarks/blind'): void {
  const dir = join(outDir, runId);
  const keyPath = join(dir, 'key.json');
  const ratingsPath = join(dir, 'ratings.csv');
  if (!existsSync(keyPath) || !existsSync(ratingsPath)) {
    console.log(`missing ${keyPath} or ${ratingsPath}`);
    return;
  }

  const key = JSON.parse(readFileSync(keyPath, 'utf8')) as {
    entries: { code: string; model: string }[];
  };
  const codeToModel = new Map(key.entries.map((e) => [e.code, e.model]));

  const lines = readFileSync(ratingsPath, 'utf8').trim().split('\n');
  if (lines.length < 2) {
    console.log('ratings.csv is empty');
    return;
  }
  const header = lines[0].split(',');
  const criteriaKeys = header.slice(1);
  const rows = lines.slice(1).map((l) => l.split(','));

  const modelScores = new Map<string, Map<string, number[]>>();
  for (const row of rows) {
    const code = row[0];
    const model = codeToModel.get(code);
    if (!model) continue;
    if (!modelScores.has(model)) modelScores.set(model, new Map());
    const scores = modelScores.get(model)!;
    for (let i = 0; i < criteriaKeys.length; i++) {
      const v = Number(row[i + 1]);
      if (!Number.isFinite(v)) continue;
      const k = criteriaKeys[i]!;
      if (!scores.has(k)) scores.set(k, []);
      scores.get(k)!.push(v);
    }
  }

  const mean = (arr: number[]): number | undefined => {
    if (!arr.length) return undefined;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  };

  console.log(`\n# Blind human ratings — ${runId}\n`);
  console.log(`| model | ${criteriaKeys.join(' | ')} | overall | writing* |`);
  console.log(`| --- | ${criteriaKeys.map(() => '---:').join(' | ')} | ---: | ---: |`);
  for (const [model, byCriterion] of modelScores) {
    const cells = criteriaKeys.map((k) => {
      const m = mean(byCriterion.get(k) ?? []);
      return m === undefined ? '-' : m.toFixed(1);
    });
    const all = criteriaKeys.flatMap((k) => byCriterion.get(k) ?? []);
    const writingKeys = criteriaKeys.filter((k) => k !== 'repetition');
    const writing = writingKeys.flatMap((k) => byCriterion.get(k) ?? []);
    const overall = mean(all);
    const writingMean = mean(writing);
    console.log(
      `| ${model} | ${cells.join(' | ')} | ${overall === undefined ? '-' : overall.toFixed(2)} | ${writingMean === undefined ? '-' : writingMean.toFixed(2)} |`,
    );
  }
  console.log('\n*writing mean excludes the repetition scale.\n');
}

function main(): void {
  const runId = process.argv[2];
  if (!runId) {
    console.log('usage: node scripts/evaluate-blind.ts <run-id> [--out benchmarks/blind] [--analyze]');
    return;
  }
  const outArg = process.argv.indexOf('--out');
  const outDir = outArg >= 0 ? process.argv[outArg + 1] : 'benchmarks/blind';

  if (process.argv.includes('--analyze')) {
    analyzeRatings(runId, outDir);
    return;
  }

  const { dir, entries } = buildPacket(runId, outDir);
  console.log(`packet written to ${dir}`);
  for (const e of entries) console.log(`  passage ${e.code}: ${e.model}`);
  console.log('\nrate the passages with the form in ratings.csv, then read key.json to see the result.');
  console.log(`when ratings are final, run: node scripts/evaluate-blind.ts ${runId} --analyze`);
}

if (isMain(import.meta.url)) {
  main();
}
