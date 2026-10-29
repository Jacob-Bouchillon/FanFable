// Smoke test for the unmuzzled relations prompt: drives the NEW
// EXTRACT_RELATIONS_SYSTEM text from lorebook.ts against w83 (Tarkin window)
// through qwen (incumbent) and v3, then checks: (1) output parses as JSON with
// a relations array (what parseSection needs), (2) the Gracus aide is emitted
// with a span-verified quote. No DB writes, no src changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXTRACT_RELATIONS_SYSTEM } from '../../../fanfable/src/lorebook.ts';

const dir = fileURLToPath(new URL('./', import.meta.url));
const duel = JSON.parse(readFileSync(dir + 'duel-windows.json', 'utf8'));
const w = duel.windows.find((x: any) => x.index === 83);
if (!w) throw new Error('w83 missing');

// passageBlock shape: [#i] title | locator + text (texts under 1400 chars here,
// so no truncation vs the chain). Title unknown to the harness; locator only.
const passages = 'PASSAGES:\n' + w.text.split('\n\n').map((t: string, i: number) => `[#${i}] Darth Plagueis | ${w.locators[i] ?? ''}\n${t.slice(0, 1400)}`).join('\n\n');
// Names the chain would supply: entities the window mentions (from the duel's
// key-tie surface — in production windowEntityNames provides these).
const names = ['Ranulph Tarkin', 'Bor Gracus', 'Pax Teem', 'Aks Moe', 'Boss Cabra', 'Darnada', 'Palpatine', 'Hego Damask', 'Vidar Kim', 'Ars Veruna', 'King Tapalo', 'Doriana'];
const system = `${EXTRACT_RELATIONS_SYSTEM}\n\nKNOWN ENTITIES:\n${names.map((n) => `- ${n}`).join('\n')}`;

const out: any = {};
for (const [tag, id] of [['qwen', 'qwen2.5:7b'], ['nue3', 'hf.co/numind/NuExtract3-GGUF:Q4_K_M']] as const) {
  const body = JSON.stringify({ model: id, prompt: undefined, system, messages: [{ role: 'user', content: passages }], stream: false, think: false, options: { temperature: 0, num_predict: 3000 } });
  const res = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const j: any = await res.json();
  const text: string = j.message?.content ?? '';
  writeFileSync(`${dir}prompt-smoke-${tag}.txt`, text);
  let parsed = 0, aide = false, quoteOk = false;
  try {
    const v = JSON.parse(text.replace(/```json|```/g, '').trim());
    parsed = (v.relations ?? []).length;
    for (const r of v.relations ?? []) {
      const s = JSON.stringify(r);
      if (/gracus/i.test(s) && /aide/i.test(s)) {
        aide = true;
        const q = String((r as any).evidence ?? '');
        if (q.length >= 8 && w.text.replace(/\s+/g, ' ').includes(q.replace(/\s+/g, ' ').slice(0, 60))) quoteOk = true;
      }
    }
  } catch { /* unparseable */ }
  out[tag] = { chars: text.length, parsed, aide, quoteOk };
  console.log(tag, JSON.stringify(out[tag]));
}
writeFileSync(dir + 'prompt-smoke.json', JSON.stringify(out, null, 1));
