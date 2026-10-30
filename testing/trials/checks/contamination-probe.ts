/**
 * Contamination re-probe (model qwen3.5:9b).
 *
 * Procedure from docs/frozen/v1-relationships/contamination.md at HEAD~2:
 * 8 no-context QA (own knowledge, no passages), 4 confabulation controls
 * (entities/events that cannot be in the book), 3 verbatim completions.
 * Temperature 0.2 with an explicit "say I don't know when unsure" instruction.
 *
 * Count-only output: no book text and no model prose is printed or stored
 * beyond aggregate counts. The JSON output stays local (gitignored).
 *
 * Usage (repo root):
 *   node --no-warnings testing/trials/checks/contamination-probe.ts [out.json]
 *   CONTAM_MODEL=qwen3.5:9b node --no-warnings testing/trials/checks/contamination-probe.ts
 */
import { writeFileSync } from 'node:fs';
import { Db } from '../../../fanfable/src/db.ts';
import { clientFrom } from '../../../fanfable/src/llm.ts';

const outPath = process.argv[2] ?? 'testing/trials/checks/contamination-qwen3.5-9b.json';
const model = process.env.CONTAM_MODEL ?? 'qwen3.5:9b';
const llm = clientFrom({ provider: 'ollama', model, temperature: 0.2, seed: 42, maxTokens: 256 });

const SYSTEM = 'Answer from your own knowledge. No passages are provided. '
  + 'If you are unsure, reply exactly "I don\'t know". Do not invent details.';

const ABSTAIN = /i don'?t know|do not know|not sure|no idea|cannot answer|can'?t answer/i;

interface QA { id: string; ask: string; truth: RegExp; }
const QA: QA[] = [
  { id: 'Q1', ask: "Who was Plagueis's Sith Master?", truth: /tenebrous/i },
  { id: 'Q2', ask: "Who is Pax Teem's aide?", truth: /aks\s*moe/i },
  { id: 'Q3', ask: 'Bor Gracus is aide to whom?', truth: /tarkin/i },
  { id: 'Q4', ask: "Who is Boss Cabra's son?", truth: /darnada/i },
  { id: 'Q5', ask: 'What is 11-4D?', truth: /droid/i },
  { id: 'Q6', ask: "What planet is Kim from?", truth: /naboo/i },
  { id: 'Q7', ask: "What is Larsh Hill's affiliation?", truth: /banking/i },
  { id: 'Q8', ask: "What species is Plagueis?", truth: /muun/i },
];

const CONFAB: { id: string; ask: string }[] = [
  { id: 'C1', ask: 'Who is Captain Rexford in the novel Darth Plagueis?' },
  { id: 'C2', ask: 'What is the name of Tenebrous\'s flagship in the novel Darth Plagueis?' },
  { id: 'C3', ask: 'Describe Yoda\'s duel in the novel Darth Plagueis.' },
  { id: 'C4', ask: 'Who is Plagueis\'s wife in the novel Darth Plagueis?' },
];

// Verbatim prefixes are drawn at runtime from a local bank (read-only) so no
// book text is committed. Three fixed chunk offsets keep the probe stable.
function verbatimPrefixes(): { id: string; prefix: string }[] {
  const candidates = [
    process.env.CONTAM_DB ?? '/tmp/opencode/bench-20pair-20261029-203805.db',
    '/tmp/opencode/bench-20pair-audit.db',
  ];
  for (const path of candidates) {
    try {
      const db = new Db(path);
      try {
        const proj = db.get<{ id: number }>('SELECT id FROM project ORDER BY id LIMIT 1');
        if (!proj) continue;
        const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?', proj.id)?.n ?? 0;
        if (!n) continue;
        const offsets = [Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.75)];
        const out: { id: string; prefix: string }[] = [];
        for (let i = 0; i < offsets.length; i++) {
          const row = db.get<{ text: string }>(
            'SELECT text FROM canon_chunk WHERE project_id = ? ORDER BY seq LIMIT 1 OFFSET ?',
            proj.id, offsets[i]!,
          );
          const words = (row?.text ?? '').split(/\s+/).filter(Boolean).slice(0, 12).join(' ');
          if (words) out.push({ id: `P${i + 1}`, prefix: words });
        }
        if (out.length === 3) return out;
      } finally {
        db.close();
      }
    } catch {
      continue;
    }
  }
  return [];
}

async function ask(question: string): Promise<string> {
  const res = await llm.chat({ system: SYSTEM, messages: [{ role: 'user', content: question }], temperature: 0.2, maxTokens: 256 });
  return res.text ?? '';
}

const qaResults: { id: string; verdict: 'hit' | 'wrong' | 'abstain' }[] = [];
for (const q of QA) {
  const text = await ask(q.ask);
  if (ABSTAIN.test(text)) qaResults.push({ id: q.id, verdict: 'abstain' });
  else if (q.truth.test(text)) qaResults.push({ id: q.id, verdict: 'hit' });
  else qaResults.push({ id: q.id, verdict: 'wrong' });
}

const confabResults: { id: string; verdict: 'abstained' | 'confabulated' }[] = [];
for (const c of CONFAB) {
  const text = await ask(c.ask);
  confabResults.push({ id: c.id, verdict: ABSTAIN.test(text) ? 'abstained' : 'confabulated' });
}

// Verbatim: ask for the continuation without passages; a verbatim hit means the
// continuation (normalized presentation only) occurs in some local chunk.
const prefixes = verbatimPrefixes();
let verbatimHits = 0;
const verbatimDetails: { id: string; verbatim: boolean }[] = [];
{
  let db: Db | null = null;
  let chunkNorm: string[] = [];
  try {
    const path = process.env.CONTAM_DB ?? '/tmp/opencode/bench-20pair-20261029-203805.db';
    db = new Db(path);
    const proj = db.get<{ id: number }>('SELECT id FROM project ORDER BY id LIMIT 1');
    if (proj) {
      const rows = db.all<{ text: string }>('SELECT text FROM canon_chunk WHERE project_id = ?', proj.id);
      const norm = (t: string): string => t.replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'").replace(/[–—−]/g, '-').toLowerCase().replace(/\s+/g, ' ').trim();
      chunkNorm = rows.map((r) => norm(r.text));
    }
  } catch {
    chunkNorm = [];
  }
  const norm = (t: string): string => t.replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'").replace(/[–—−]/g, '-').toLowerCase().replace(/\s+/g, ' ').trim();
  for (const p of prefixes) {
    const completion = await ask(`Complete this passage verbatim from the novel Darth Plagueis: "${p.prefix}"`);
    const n = norm(completion).slice(0, 200);
    const hit = n.length > 20 && chunkNorm.some((c) => c.includes(n) || (n && n.includes(c.slice(0, 80))));
    // Strict verbatim requires the model's continuation to occur contiguously;
    // a paraphrase or abstention is not a hit.
    const verbatim = hit && !ABSTAIN.test(completion);
    if (verbatim) verbatimHits++;
    verbatimDetails.push({ id: p.id, verbatim });
  }
  db?.close();
}

const summary = {
  model,
  temperature: 0.2,
  qa: {
    total: qaResults.length,
    hits: qaResults.filter((r) => r.verdict === 'hit').length,
    wrong: qaResults.filter((r) => r.verdict === 'wrong').length,
    abstain: qaResults.filter((r) => r.verdict === 'abstain').length,
  },
  confabulation: {
    total: confabResults.length,
    abstained: confabResults.filter((r) => r.verdict === 'abstained').length,
    confabulated: confabResults.filter((r) => r.verdict === 'confabulated').length,
  },
  verbatim: {
    total: verbatimDetails.length,
    hits: verbatimHits,
    misses: verbatimDetails.length - verbatimHits,
  },
};
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
