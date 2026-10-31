/**
 * Frozen-50 slot duel runner (local harness, any Ollama chat model).
 * usage: node --no-warnings testing/trials/nuextract-duel/duel-q8.mjs [model] [outDir]
 * Scores pair-correct (both bank names in the filled person spans, order-free)
 * + verbatim (tie span inside the quote). Counts only on stdout.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const model = process.argv[2] ?? 'nuextract3-q8';
const outDir = resolve(process.argv[3] ?? 'testing/trials/nuextract-duel/out-q8');
mkdirSync(outDir, { recursive: true });
const rows = JSON.parse(readFileSync('testing/trials/nuextract-duel/frozen50.json', 'utf8'));

const TEMPLATE = `{
    "person_a": "verbatim-string",
    "person_b": "verbatim-string",
    "tie": "verbatim-string",
    "label": "string"
}`;
const promptFor = (r) =>
  `<|input|>\n### Template:\n${TEMPLATE}\n### Text:\n${r.evidence}\n\n<|output|>\nperson_a is "${r.an}", person_b is "${r.bn}". Fill their exact name spans from the text, the exact words stating their tie (or null when the text states none), and a short label.`;

const chat = async (prompt) => {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, think: false,
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: 0.2, num_ctx: 16384 },
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data = await res.json();
  return (data.message?.content ?? '').trim();
};

const pick = (obj, keys) => {
  for (const k of keys) {
    const hit = Object.keys(obj).find((x) => x.toLowerCase() === k);
    if (hit !== undefined) return obj[hit];
  }
  return undefined;
};

const results = [];
let t0 = Date.now();
for (const [i, r] of rows.entries()) {
  let raw = '', err = '';
  try { raw = await chat(promptFor(r)); }
  catch (e) { err = String(e).slice(0, 120); }
  let obj = null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { obj = JSON.parse(m[0]); } catch { /* unparsable */ } }
  let pairOk = false, verbOk = false, abstain = false;
  let sa = '', sb = '', st = '';
  if (obj && typeof obj === 'object') {
    const a = pick(obj, ['person_a']);
    const b = pick(obj, ['person_b']);
    const tie = pick(obj, ['tie']);
    sa = a === null || a === undefined ? '' : String(a);
    sb = b === null || b === undefined ? '' : String(b);
    st = tie === null || tie === undefined ? '' : String(tie);
    abstain = !sa && !sb && !st;
    const spans = `${sa} ${sb}`.toLowerCase();
    const an = String(r.an).toLowerCase(), bn = String(r.bn).toLowerCase();
    pairOk = !abstain && spans.includes(an) && spans.includes(bn);
    verbOk = !abstain && !!st && String(r.evidence).toLowerCase().includes(st.toLowerCase());
  }
  results.push({ id: r.id, pairOk, verbOk, abstain, parsable: obj !== null, err });
  if ((i + 1) % 10 === 0) process.stderr.write(`${i + 1}/${rows.length}\n`);
}
const secs = (Date.now() - t0) / 1000;
const both = results.filter((x) => x.pairOk && x.verbOk).length;
writeFileSync(resolve(outDir, 'verdicts.json'), JSON.stringify({ model, secs, results }, null, 1));
console.log(JSON.stringify({
  model, n: results.length,
  pairOk: results.filter((x) => x.pairOk).length,
  verbOk: results.filter((x) => x.verbOk).length,
  both, abstain: results.filter((x) => x.abstain).length,
  wrong: results.filter((x) => x.parsable && !x.abstain && !x.pairOk).length,
  unparsable: results.filter((x) => !x.parsable).length,
  secPerCall: +(secs / results.length).toFixed(1),
}));
