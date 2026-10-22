/**
 * A preliminary screen, not a verdict.
 *
 * The human rating in `benchmarks/blind/` is the measurement that counts. This
 * script is a cheap stand-in for it, used so that the comparison is not left
 * with no signal at all while a person finds time to read the passages.
 *
 * It has two known biases, and both are stated in the output:
 *
 *   - the judge is one of the candidates, so it may prefer its own style;
 *   - a model rating prose is not a reader rating prose.
 *
 * The numbers are therefore only ever read as: "here is a ranking, and here
 * is how much the judge disagrees with the objective measurements".
 */
import { RunStore, isMain, loadModels, makeClient, mean, table } from './benchmark/harness.ts';
import { CRITERIA } from './evaluate-blind.ts';
import { extractJson } from '../src/json.ts';

interface Judgement {
  code: string;
  scores: Record<string, number>;
  reason: string;
}

const JUDGE_PROMPT = `You are reading several drafts of the same chapter of a fanfiction story and
scoring them. The story is an alternate universe: Harry Potter is sorted into Slytherin
instead of Gryffindor, and the chapter is the Sorting Ceremony. The hat hesitates over him,
says something to him alone, and places him in Slytherin. Ron does not come over to his table;
Hermione does come over and does not know what to say.

Score every passage from 1 to 5 on each of these, and give one sentence of reasoning:

${CRITERIA.map((c) => `- ${c.key} (${c.label}): ${c.note}`).join('\n')}

Reply with JSON only:
{"passages":[{"code":"A","scores":{"prose":3,"voice":3,"dialogue":3,"pacing":3,"emotion":3,"originality":3,"outline":3,"canon":3,"knowledge":3,"repetition":5},"reason":"..."}]}

Judge the passage on its own merits. Do not reward length.`;

export async function judgeRun(
  runId: string,
  judgeKey: string,
): Promise<{ code: string; model: string; scores: Record<string, number> }[]> {
  const { results } = RunStore.load(runId);
  const written = results.filter((r) => r.role === 'writing' && r.ok && r.artefact?.trim());
  if (!written.length) throw new Error(`no writing results in run "${runId}"`);

  // The passages are shuffled and relabelled, so the judge cannot tell which
  // model wrote which.
  const entries = written.map((r, i) => ({
    code: String.fromCharCode(65 + i),
    model: r.model,
    body: r.artefact ?? '',
  }));
  const order = entries.map((_, i) => i).sort(() => 0.5 - Math.random());
  const shuffled = order.map((i) => entries[i]);

  const judge = makeClient(loadModels(true).find((m) => m.key === judgeKey)!);
  const prompt = shuffled
    .map((e) => `## PASSAGE ${e.code}\n${e.body.trim().slice(0, 12000)}`)
    .join('\n\n');
  const res = await judge.chat({
    system: JUDGE_PROMPT,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    maxTokens: 3000,
  });
  const parsed = extractJson<{ passages?: unknown }>(res.text);
  const list = Array.isArray(parsed?.passages) ? (parsed!.passages as Judgement[]) : [];
  const byCode = new Map(list.map((j) => [String(j.code), j]));

  return shuffled.map((e) => {
    const j = byCode.get(e.code);
    const scores: Record<string, number> = {};
    for (const c of CRITERIA) {
      const raw = Number(j?.scores?.[c.key]);
      scores[c.key] = Number.isFinite(raw) ? raw : 0;
    }
    return { code: e.code, model: e.model, scores };
  });
}

async function main(): Promise<void> {
  const runId = process.argv[2];
  const judgeKey = process.argv[3] ?? 'gemma4:12b-it-q4_K_M';
  if (!runId) {
    console.log('usage: node scripts/evaluate-judge.ts <run-id> [judge-model]');
    return;
  }
  const judgements = await judgeRun(runId, judgeKey);
  const rows: string[][] = [];
  for (const j of judgements) {
    const writing = CRITERIA.filter((c) => c.key !== 'repetition');
    const writingMean = mean(writing.map((c) => j.scores[c.key] ?? 0)) ?? 0;
    rows.push([
      j.model,
      ...CRITERIA.map((c) => (j.scores[c.key] ?? 0).toFixed(1)),
      writingMean.toFixed(2),
    ]);
  }
  console.log(`\njudge: ${judgeKey} (a candidate itself; treat this as a screen, not a verdict)\n`);
  table(['model', ...CRITERIA.map((c) => c.key), 'writing mean'], rows);
  console.log('\nThe writing mean leaves out the repetition scale, which runs the other way.');
  console.log('A real rating is still needed: benchmarks/blind/<run-id>/ratings.csv');
}

if (isMain(import.meta.url)) {
  void main();
}
