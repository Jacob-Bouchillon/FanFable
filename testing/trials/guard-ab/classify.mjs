import { readFileSync, writeFileSync } from 'node:fs';
const DIR = '/home/jacob/Documents/FanFable/testing/trials/guard-ab';
const questions = JSON.parse(readFileSync(`${DIR}/questions.json`, 'utf8'));
const CITE = /\[S\d+\]|\[Lore:/i;
const KIND_WORDS = {
  apprentice: /\b(apprentice|student)\b/i,
  parent: /\b(parent|mother|father)\b/i,
  aide: /\b(aide|assistant|agent)\b/i,
  master: /\b(master|mentor|teacher)\b/i,
  married: /\b(married|husband|wife|spouse)\b/i,
  shepherd: /\b(shepherd|guide)\b/i,
  partnership: /\b(partner|partnership)\b/i,
};
const NEG = /\b(no|not|never|cannot|can't|does not|do not|isn't|wasn't|without|unsupported|unconfirmed|missing|none|insufficient|unknown)\b/i;
const CUE = /\b(is|was|are|were|has|had|become|became|relationship|tie)\b/i;
function assertsPair(answer, pair, kind) {
  if (/tie not established/i.test(answer)) return false;
  const sentences = answer.split(/[.!?\n]+/).map((s) => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (/^what is the status of/i.test(sentence)) continue;
    const lower = sentence.toLowerCase();
    if (!lower.includes(pair[0].toLowerCase()) || !lower.includes(pair[1].toLowerCase())) continue;
    if (NEG.test(sentence)) continue;
    if (kind) {
      if (!KIND_WORDS[kind]?.test(sentence)) continue;
    } else if (!CUE.test(sentence)) {
      continue;
    }
    return true;
  }
  return false;
}
const read = (arm, id) => readFileSync(`${DIR}/${arm}/${id}.md`, 'utf8');

const rows = questions.map((q) => {
  const guarded = read('guarded', q.id);
  const unguarded = read('unguarded', q.id);
  const gAssert = assertsPair(guarded, q.pair, q.kind);
  const uAssert = assertsPair(unguarded, q.pair, q.kind);
  const g = { assert: gAssert, cited: CITE.test(guarded), abstain: !gAssert };
  const u = { assert: uAssert, cited: CITE.test(unguarded), abstain: !uAssert };
  let verdict;
  if (q.expected === 'keeper') verdict = g.assert ? 'correct assertion' : 'over-refusal';
  else verdict = g.assert ? 'unsupported assertion' : 'correct abstain';
  return { ...q, guarded: g, unguarded: u, verdict };
});

const totals = (arm) => ({
  overRefusals: rows.filter((r) => r.expected === 'keeper' && r[arm].abstain).length,
  correctAssertions: rows.filter((r) => r.expected === 'keeper' && r[arm].assert).length,
  unsupportedAssertions: rows.filter((r) => r.expected !== 'keeper' && r[arm].assert).length,
  correctAbstains: rows.filter((r) => r.expected !== 'keeper' && r[arm].abstain).length,
});
const guardedTotals = totals('guarded');
const unguardedTotals = totals('unguarded');
const cost = rows.filter((r) => r.expected === 'keeper' && r.guarded.abstain && r.unguarded.assert).length;
const prevented = rows.filter((r) => r.expected !== 'keeper' && r.unguarded.assert).length;

const cell = (state) => `${state.assert ? 'assert' : 'abstain'}${state.cited ? ', cited' : ', uncited'}`;
const lines = [];
lines.push('# Answer guard A/B', '');
lines.push('| ID | Expected | Guarded | Unguarded | Verdict |');
lines.push('|---|---|---|---|---|');
for (const r of rows) lines.push(`| ${r.id} | ${r.expected} | ${cell(r.guarded)} | ${cell(r.unguarded)} | ${r.verdict} |`);
lines.push('');
lines.push('| Arm | Over-refusals | Correct assertions | Unsupported assertions | Correct abstains |');
lines.push('|---|---:|---:|---:|---:|');
lines.push(`| guarded | ${guardedTotals.overRefusals} | ${guardedTotals.correctAssertions} | ${guardedTotals.unsupportedAssertions} | ${guardedTotals.correctAbstains} |`);
lines.push(`| unguarded | ${unguardedTotals.overRefusals} | ${unguardedTotals.correctAssertions} | ${unguardedTotals.unsupportedAssertions} | ${unguardedTotals.correctAbstains} |`);
lines.push('');
lines.push(`Cost of the guard: **${cost}** guarded abstains would have been correct assertions.`);
lines.push(`Unsupported assertions in the unguarded arm: **${prevented}**.`);
const keep = guardedTotals.overRefusals <= unguardedTotals.unsupportedAssertions;
lines.push('');
lines.push(`**Verdict:** ${keep ? 'keep the guard' : 'the guard costs more than it prevents'} (guarded over-refusals ${guardedTotals.overRefusals} vs unguarded unsupported assertions ${unguardedTotals.unsupportedAssertions}).`);
writeFileSync(`${DIR}/report.md`, lines.join('\n') + '\n');
console.log(JSON.stringify({ rows: rows.map((r) => ({ id: r.id, expected: r.expected, guarded: r.guarded, unguarded: r.unguarded, verdict: r.verdict })), guardedTotals, unguardedTotals, cost, prevented, keep }, null, 2));
