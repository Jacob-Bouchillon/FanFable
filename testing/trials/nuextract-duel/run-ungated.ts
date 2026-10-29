// Ungated recall run: same 33 frozen windows, all 3 models, no format dictation.
// What "ungated" lifts vs run-duel.ts: (1) no output format imposed — any shape,
// list everything, longer lists welcome; (2) num_predict 2000 -> 8000 so long
// lists are never truncated mid-window (the suspected suffocation); (3) quote
// requirement KEPT — without a verbatim quote a tie is unscorable, and that is
// evidence, not a gate. temp stays 0: ungating the prompt, not the sampling,
// so the comparison stays deterministic.
// Outputs: outputs/<tag>-free/w<index>.txt + manifest-free.json (this dir only).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FREE =
  'Read the text below and extract EVERY person-to-person relationship stated in it — ' +
  'family, allies, aides, mentors, masters, benefactors, rivals, colleagues, any kind. ' +
  'Do not hold back: a long list is good, missing one is bad. Any format you like, ' +
  'one tie per line. For each tie include a quote copied VERBATIM from the text that states it.\n\nTEXT:\n';

const MODELS = [
  { tag: 'nue3', id: 'hf.co/numind/NuExtract3-GGUF:Q4_K_M' },
  { tag: 'nue15', id: 'hf.co/DevQuasar-3/numind.NuExtract-v1.5-GGUF:Q4_K_M' },
  { tag: 'qwen', id: 'qwen2.5:7b' },
];

const dir = fileURLToPath(new URL('./', import.meta.url));
const duel = JSON.parse(readFileSync(dir + 'duel-windows.json', 'utf8'));
const manifest: any[] = [];
try {
  const prev = JSON.parse(readFileSync(dir + 'manifest-free.json', 'utf8'));
  manifest.push(...prev);
} catch { /* fresh */ }
const done = new Set(manifest.filter((m) => m.ok).map((m) => `${m.model}@${m.window}`));

for (const w of duel.windows) {
  for (const m of MODELS) {
    const key = `${m.tag}@${w.index}`;
    if (done.has(key)) { console.log('skip', key); continue; }
    const body = JSON.stringify({ model: m.id, prompt: FREE + w.text, stream: false, think: false, options: { temperature: 0, num_predict: 8000 } });
    const t0 = Date.now();
    let ok = false, chars = 0, tokens = 0, err = '';
    try {
      const res = await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const out: any = await res.json();
      const text: string = out.response ?? '';
      chars = text.length; tokens = out.eval_count ?? 0;
      if (out.done_reason === 'length' || tokens >= 7900) err = 'TRUNCATED-AT-CAP';
      const d = dir + `outputs/${m.tag}-free`;
      mkdirSync(d, { recursive: true });
      writeFileSync(`${d}/w${w.index}.txt`, text);
      ok = true;
    } catch (e: any) { err = String(e).slice(0, 200); }
    const dt = (Date.now() - t0) / 1000;
    manifest.push({ model: m.tag, window: w.index, ok, seconds: Math.round(dt * 10) / 10, tokens, chars, err });
    writeFileSync(dir + 'manifest-free.json', JSON.stringify(manifest, null, 1));
    console.log(key, ok ? `${chars}ch ${tokens}tok ${dt.toFixed(1)}s ${err}` : `FAIL ${err}`);
  }
}
console.log('ungated run complete');
