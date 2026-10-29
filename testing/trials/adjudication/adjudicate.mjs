/**
 * Adjudicate 30 parked ties with two narrow judges. Read-only on the bank;
 * writes only its CSV/Markdown under testing/trials/adjudication/.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '../../../fanfable/src/llm.ts';
import { CLOSED_ROLE_KINDS, isClosedRoleKind, isUnsupportedKind } from '../../../fanfable/src/lorebook.ts';
import { nameMentionedExact } from '../../../fanfable/src/names.ts';
import { splitSentences } from '../../../fanfable/src/text.ts';
import { strList } from '../../../fanfable/src/db.ts';

const DB = '/home/jacob/Documents/FanFable/testing/trials/halfbook-run/plagueis-half.db';
const DIR = '/home/jacob/Documents/FanFable/testing/trials/adjudication';
const GATE = 'hf.co/mradermacher/RAG-Gate-4B-GGUF:latest';
const OLLAMA = 'http://127.0.0.1:11434';
const TARGET = 30;

const raw = new DatabaseSync(DB, { readOnly: true });
const projectId = raw.prepare('SELECT id FROM project ORDER BY id LIMIT 1').get().id;
const parked = raw.prepare(`SELECT r.id, r.kind, r.evidence, r.source_refs, r.from_entity, r.to_entity,
    a.name fn, a.aliases fa, b.name tn, b.aliases ta
  FROM canon_relation r JOIN canon_entity a ON a.id = r.from_entity JOIN canon_entity b ON b.id = r.to_entity
  WHERE r.project_id = ? AND r.review_status = 'needs_review' ORDER BY r.id`).all(projectId);
const chunkOf = (row) => {
  let refs = [];
  try { refs = JSON.parse(row.source_refs || '[]'); } catch { refs = []; }
  const chunkId = refs.find((ref) => ref && ref.chunk)?.chunk;
  if (!chunkId) return null;
  return raw.prepare('SELECT id, text, locator FROM canon_chunk WHERE id = ?').get(chunkId) ?? null;
};
const usable = new Set(parked.filter((row) => chunkOf(row)).map((row) => row.id));
const selected = [];
const taken = new Set();
const base = [];
for (let i = 0; i < parked.length; i += 10) base.push(i);
for (const index of base) {
  let pick = null;
  for (let j = index; j < parked.length; j++) {
    if (usable.has(parked[j].id) && !taken.has(parked[j].id)) { pick = parked[j]; break; }
  }
  if (!pick) {
    for (let j = index - 1; j >= 0; j--) {
      if (usable.has(parked[j].id) && !taken.has(parked[j].id)) { pick = parked[j]; break; }
    }
  }
  if (!pick) continue;
  taken.add(pick.id);
  const chunk = chunkOf(pick);
  selected.push({
    ...pick,
    chunkId: chunk.id,
    chunkText: chunk.text,
    locator: chunk.locator,
    sentences: splitSentences(chunk.text),
  });
  if (selected.length >= TARGET) break;
}

const characters = raw.prepare("SELECT id, name, aliases FROM canon_entity WHERE project_id = ? AND kind = 'character'").all(projectId)
  .map((row) => ({ id: row.id, name: row.name, aliases: strList(row.aliases) }));
const pairsOf = (row) => new Set([row.from_entity, row.to_entity]);
const thirdParty = (row, sentence) => characters.some((person) =>
  !pairsOf(row).has(person.id) &&
  (nameMentionedExact(person.name, sentence) || person.aliases.some((alias) => nameMentionedExact(alias, sentence))),
);

const judge1Client = createClient({
  provider: 'ollama', baseUrl: OLLAMA, model: 'qwen2.5:7b',
  temperature: 0.1, maxTokens: 200, contextTokens: 16384, timeoutMs: 300_000, seed: 42,
});

async function judge1(row) {
  try {
    const res = await judge1Client.chat({
      system: `You verify one relationship claim against one passage.
Reply with JSON only: {"sentence": 1} or {"sentence":"NONE"}.
Does this passage state that A is B's ${row.kind}? Return the number of the single sentence that states it, or "NONE".
Sentence numbers are 1-based in the passage as shown.
Do not use outside knowledge.`,
      messages: [{
        role: 'user',
        content: `CLAIM: ${row.fn} is ${row.tn}'s ${row.kind}.\n\nPASSAGE (numbered sentences):\n${row.sentences.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
      }],
      temperature: 0.1,
      maxTokens: 200,
      format: 'json',
    });
    const body = String(res.text ?? '').replace(/```json|```/g, '').trim();
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    const parsed = start >= 0 && end >= start ? JSON.parse(body.slice(start, end + 1)) : null;
    const answer = parsed?.sentence;
    if (typeof answer === 'string' && /^none$/i.test(answer.trim())) return { verdict: 'none', reason: 'NONE' };
    const index = Number(answer);
    if (!Number.isInteger(index) || index < 1 || index > row.sentences.length) return { verdict: 'none', reason: 'sentence out of range' };
    const sentence = row.sentences[index - 1];
    if (isUnsupportedKind(row.kind, sentence)) return { verdict: 'none', reason: 'tie word absent' };
    if (thirdParty(row, sentence)) return { verdict: 'ambiguous', reason: 'third banked person named' };
    return { verdict: 'verified', reason: '' };
  } catch {
    return { verdict: 'none', reason: 'call failed' };
  }
}

async function judge2(row) {
  const user = `Claim: ${row.fn} is ${row.kind} ${row.tn}.

Retrieved evidence:
[1] ${row.chunkText}

Retrieval available: NO

Policy: answer only if the retrieved evidence above contains a complete support chain for the claim. Do not use prior knowledge when judging whether the evidence is sufficient. If the evidence is insufficient and retrieval is available, retrieve more. If the evidence is insufficient and retrieval is not available, stop without answering.
Actions: Answer = the evidence supports the claim; Retrieve = the evidence is insufficient to decide; Stop = the evidence does not support the claim.
Reply with the action word only, on one line of the form 'Final action: '.`;
  try {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GATE, stream: false, think: false, messages: [{ role: 'user', content: user }], options: { temperature: 0, num_predict: 10 } }),
    });
    const json = await res.json();
    const text = String(json?.message?.content ?? '').trim();
    const match = text.match(/(answer|retrieve|stop)/i);
    const action = match ? match[1].toLowerCase() : '';
    if (action === 'answer') return 'supports';
    if (action === 'stop') return 'does-not';
    return 'unsure';
  } catch {
    return 'unsure';
  }
}

const results = [];
const startedAt = Date.now();
let calls = 0;
const csv = (value) => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const header = ['id', 'pair', 'kind', 'judge1', 'judge2', 'agree', 'promoted', 'locator'];
writeFileSync(`${DIR}/results.csv`, header.map(csv).join(',') + '\n');

for (const row of selected) {
  const one = await judge1(row);
  calls++;
  const two = await judge2(row);
  calls++;
  const promoted = one.verdict === 'verified' && two === 'supports';
  const agree = (one.verdict === 'verified' && two === 'supports') || (one.verdict === 'none' && two === 'does-not');
  const result = {
    id: row.id,
    pair: `${row.fn} — ${row.tn}`,
    kind: row.kind,
    judge1: one.verdict,
    judge1Reason: one.reason,
    judge2: two,
    agree,
    promoted,
    locator: row.locator,
    fromId: row.from_entity,
    toId: row.to_entity,
  };
  results.push(result);
  writeFileSync(`${DIR}/results.csv`, [header, ...results.map((r) => [r.id, r.pair, r.kind, r.judge1, r.judge2, r.agree, r.promoted, r.locator])]
    .map((line) => line.map(csv).join(',')).join('\n') + '\n');
  console.log(`${row.id} ${row.fn} — ${row.tn} | ${row.kind} | ${one.verdict}${one.reason ? `(${one.reason})` : ''} | ${two} | ${promoted ? 'PROMOTED' : ''}`);
}
const seconds = Math.round((Date.now() - startedAt) / 100) / 10;

const count = (key, value) => results.filter((r) => r[key] === value).length;
const promoted = results.filter((r) => r.promoted);
const judge1Only = results.filter((r) => r.judge1 === 'verified' && r.judge2 !== 'supports').length;
const judge2Only = results.filter((r) => r.judge2 === 'supports' && r.judge1 !== 'verified').length;
const agreedAgainst = results.filter((r) => r.judge1 === 'none' && r.judge2 === 'does-not').length;
const disagreed = results.length - promoted.length - judge1Only - judge2Only - agreedAgainst;
const openPromoted = promoted.filter((r) => !isClosedRoleKind(r.kind)).length;
const otherPromoted = promoted.length - openPromoted;
const alreadyKeeper = promoted.filter((r) => {
  const row = raw.prepare('SELECT review_status FROM canon_relation WHERE id = ?').get(r.id);
  return row && (row.review_status === 'accepted' || row.review_status === 'user_confirmed');
}).length;
const promotionRate = +((promoted.length / results.length) * 100).toFixed(1);
const disagreementRate = +(((judge1Only + judge2Only + disagreed) / results.length) * 100).toFixed(1);
const verdictLine = promoted.length < 6 || disagreementRate > 33.3
  ? 'Adjudication is NOT the lever on this sample.'
  : 'Adjudication is a promising lever on this sample.';
const projected = Math.round((promoted.length / results.length) * 291);

const summary = `# Parked-tie adjudication (read-only)

Sample: ${results.length} parked relations from \`halfbook\` — every 10th row by id; picks whose cited chunk is missing were replaced by the next row with a chunk (77 of 291 parked rows lack one).

| Metric | Value |
|---|---:|
| Items | ${results.length} |
| Promoted (both agree + judge1 verified) | **${promoted.length}** |
| Judge 1 only | ${judge1Only} |
| Judge 2 only | ${judge2Only} |
| Agreed against | ${agreedAgainst} |
| Disagreed (other) | ${disagreed} |
| Promotion rate | ${promotionRate}% |
| Disagreement rate | ${disagreementRate}% |
| Calls | ${calls} |
| Seconds | ${seconds} |

Judge 1: qwen2.5:7b, 1-based sentence index, tie word checked with \`isUnsupportedKind\`, third banked character → ambiguous.
Judge 2: RAG-Gate 4B, temperature 0, 10 tokens; Answer→supports, Stop→does-not, Retrieve/unparseable→unsure.

Promoted rows already keepers: **${alreadyKeeper}**.
Promoted parked reasons: open-vocab kind **${openPromoted}**, endpoint/proof (closed kind) **${otherPromoted}**.

Kill rule: fewer than 6 promoted or disagreement above one third → not the lever.
Projected keeper gain across all 291 parked ties: **${projected}** (${promoted.length}/${results.length} × 291), writing relation status only (no new rows).

**Verdict:** ${verdictLine}
`;
writeFileSync(`${DIR}/summary.md`, summary);

const review = [['pair', 'kind', 'locator'], ...promoted.slice(0, 20).map((r) => [r.pair, r.kind, r.locator])];
writeFileSync(`${DIR}/review-20.csv`, review.map((line) => line.map(csv).join(',')).join('\n') + '\n');

console.log(JSON.stringify({
  items: results.length,
  promoted: promoted.length,
  judge1Only,
  judge2Only,
  agreedAgainst,
  disagreed,
  promotionRate,
  disagreementRate,
  calls,
  seconds,
  alreadyKeeper,
  openPromoted,
  otherPromoted,
  projected,
  verdict: verdictLine,
}, null, 2));
raw.close();
