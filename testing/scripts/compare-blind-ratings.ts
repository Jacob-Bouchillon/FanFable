/** Compare human and independent AI ratings without consulting the blind key.
 *
 *   node testing/scripts/compare-blind-ratings.ts <run-id>
 *
 * Reads packet.md, ratings.csv and ai-ratings.csv from the named blind run.
 * Blank cells are N/A. The report stays at the anonymous passage level.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRITERIA } from './evaluate-blind.ts';
import { isMain } from './benchmark/harness.ts';
import { ProgressStore } from './benchmark/progress.ts';

type Rating = number | null;
type RatingRows = Map<string, Map<string, Rating>>;

export interface AgreementStats {
  humanN: number;
  aiN: number;
  pairedN: number;
  exactN: number;
  withinOneN: number;
  meanAbsoluteDifference: number | null;
}

export interface BlindRatingComparison {
  runId: string;
  passageCount: number;
  byCriterion: Record<string, AgreementStats>;
  overall: AgreementStats;
}

function parseRatings(csv: string, expectedCodes: string[], label: string): RatingRows {
  const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const expectedHeader = ['passage', ...CRITERIA.map((criterion) => criterion.key)];
  if (!lines.length) throw new Error(`${label} is empty`);
  const header = lines[0]!.split(',').map((cell) => cell.trim());
  if (header.length !== expectedHeader.length || header.some((value, i) => value !== expectedHeader[i])) {
    throw new Error(`${label} header does not match the benchmark rating criteria`);
  }

  const rows: RatingRows = new Map();
  for (const [index, line] of lines.slice(1).entries()) {
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length !== expectedHeader.length) {
      throw new Error(`${label} row ${index + 2} has ${cells.length} cells; expected ${expectedHeader.length}`);
    }
    const code = cells[0]!;
    if (!expectedCodes.includes(code)) throw new Error(`${label} has unexpected passage code "${code}"`);
    if (rows.has(code)) throw new Error(`${label} has duplicate passage row "${code}"`);

    const scores = new Map<string, Rating>();
    for (let i = 0; i < CRITERIA.length; i++) {
      const key = CRITERIA[i]!.key;
      const raw = cells[i + 1]!;
      if (raw === '') {
        scores.set(key, null);
        continue;
      }
      const score = Number(raw);
      if (!Number.isInteger(score) || score < 1 || score > 5) {
        throw new Error(`${label}: invalid score for passage ${code}, ${key}: "${raw}" (expected integer 1–5 or blank)`);
      }
      scores.set(key, score);
    }
    rows.set(code, scores);
  }

  const missing = expectedCodes.filter((code) => !rows.has(code));
  if (missing.length) throw new Error(`${label} is missing passage rows: ${missing.join(', ')}`);
  return rows;
}

function summarize(human: Rating[], ai: Rating[]): AgreementStats {
  const pairs = human.flatMap((score, i) => {
    const other = ai[i];
    return score !== null && other !== null && other !== undefined ? [[score, other] as const] : [];
  });
  const exactN = pairs.filter(([h, a]) => h === a).length;
  const withinOneN = pairs.filter(([h, a]) => Math.abs(h - a) <= 1).length;
  const meanAbsoluteDifference = pairs.length
    ? pairs.reduce((sum, [h, a]) => sum + Math.abs(h - a), 0) / pairs.length
    : null;
  return {
    humanN: human.filter((score) => score !== null).length,
    aiN: ai.filter((score) => score !== null).length,
    pairedN: pairs.length,
    exactN,
    withinOneN,
    meanAbsoluteDifference,
  };
}

export function compareBlindRatings(runId: string, blindRoot = 'testing/benchmarks/blind'): BlindRatingComparison {
  const dir = join(blindRoot, runId);
  const packetPath = join(dir, 'packet.md');
  const humanPath = join(dir, 'ratings.csv');
  const aiPath = join(dir, 'ai-ratings.csv');
  const missing = [packetPath, humanPath, aiPath].filter((path) => !existsSync(path));
  if (missing.length) throw new Error(`cannot compare ratings for "${runId}": missing ${missing.join(', ')}`);

  const packet = readFileSync(packetPath, 'utf8');
  const passageCodes = [...packet.matchAll(/^## Passage ([A-Z]+)\s*$/gm)].map((match) => match[1]!);
  if (!passageCodes.length || new Set(passageCodes).size !== passageCodes.length) {
    throw new Error(`packet for "${runId}" has no passages or duplicate passage codes`);
  }

  const human = parseRatings(readFileSync(humanPath, 'utf8'), passageCodes, 'ratings.csv');
  const ai = parseRatings(readFileSync(aiPath, 'utf8'), passageCodes, 'ai-ratings.csv');
  const byCriterion: Record<string, AgreementStats> = {};
  for (const criterion of CRITERIA) {
    byCriterion[criterion.key] = summarize(
      passageCodes.map((code) => human.get(code)!.get(criterion.key) ?? null),
      passageCodes.map((code) => ai.get(code)!.get(criterion.key) ?? null),
    );
  }
  const allHuman = passageCodes.flatMap((code) => CRITERIA.map((criterion) => human.get(code)!.get(criterion.key) ?? null));
  const allAi = passageCodes.flatMap((code) => CRITERIA.map((criterion) => ai.get(code)!.get(criterion.key) ?? null));
  return { runId, passageCount: passageCodes.length, byCriterion, overall: summarize(allHuman, allAi) };
}

function percent(n: number, total: number): string {
  return total ? `${((100 * n) / total).toFixed(0)}%` : 'n/a';
}

function report(result: BlindRatingComparison): void {
  console.log(`\nAI–human rating agreement — ${result.runId}`);
  console.log(`${result.passageCount} anonymous passages; no answer key or model mapping used.\n`);
  console.log('| criterion | human N | AI N | paired N | exact | within 1 | mean abs. diff. |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const criterion of CRITERIA) {
    const stats = result.byCriterion[criterion.key]!;
    console.log(
      `| ${criterion.label} | ${stats.humanN} | ${stats.aiN} | ${stats.pairedN} | ` +
        `${percent(stats.exactN, stats.pairedN)} | ${percent(stats.withinOneN, stats.pairedN)} | ` +
        `${stats.meanAbsoluteDifference === null ? 'n/a' : stats.meanAbsoluteDifference.toFixed(2)} |`,
    );
  }
  const stats = result.overall;
  console.log(
    `| **Overall** | **${stats.humanN}** | **${stats.aiN}** | **${stats.pairedN}** | ` +
      `**${percent(stats.exactN, stats.pairedN)}** | **${percent(stats.withinOneN, stats.pairedN)}** | ` +
      `**${stats.meanAbsoluteDifference === null ? 'n/a' : stats.meanAbsoluteDifference.toFixed(2)}** |`,
  );
  console.log('\nAgreement describes these ratings only; it does not establish a model winner.');
}

function main(): void {
  const runId = process.argv[2];
  if (!runId) {
    throw new Error('usage: node testing/scripts/compare-blind-ratings.ts <run-id> [--progress-run <id>]');
  }
  const progressArg = process.argv.indexOf('--progress-run');
  const progressRun = progressArg >= 0 ? process.argv[progressArg + 1] : '';
  const result = compareBlindRatings(runId);
  report(result);
  if (progressRun) {
    ProgressStore.open(progressRun).startStage('comparison', {
      detail: `agreement computed for ${result.passageCount} passages; still blinded`,
    });
  }
}

if (isMain(import.meta.url)) main();
