import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Runs the free-prompt duel: both models, identical windows, concurrency 1.
// Outputs: outputs/<model>/w<index>.txt + manifest.json (all inside this dir).
const FREE =
  'Extract every person-to-person relationship stated in the text below.\n' +
  'For each, give subject, relation, object, and a quote copied VERBATIM from the text that states it.\n' +
  'Format as a markdown list: - SUBJECT | RELATION | OBJECT | "QUOTE".\n\nTEXT:\n';

const MODELS = [
  { tag: 'nue3', id: 'hf.co/numind/NuExtract3-GGUF:Q4_K_M' },
  { tag: 'nue15', id: 'hf.co/DevQuasar-3/numind.NuExtract-v1.5-GGUF:Q4_K_M' },
  { tag: 'qwen', id: 'qwen2.5:7b' },
];

const duel = JSON.parse(readFileSync(fileURLToPath(new URL('./duel-windows.json', import.meta.url)), 'utf8'));

const dir = fileURLToPath(new URL('./', import.meta.url));
const manifest: any[] = [];
try {
  const prev = JSON.parse(readFileSync(dir + 'manifest.json', 'utf8'));
  manifest.push(...prev);
} catch { /* fresh */ }
const done = new Set(manifest.filter((m) => m.ok).map((m) => `${m.model}@${m.window}`));

for (const w of duel.windows) {
  for (const m of MODELS) {
    const key = `${m.tag}@${w.index}`;
    if (done.has(key)) { console.log('skip', key); continue; }
    const body = JSON.stringify({ model: m.id, prompt: FREE + w.text, stream: false, think: false, options: { temperature: 0, num_predict: 2000 } });
    const t0 = Date.now();
    let ok = false, chars = 0, tokens = 0, err = '';
    try {
      const res = await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const out: any = await res.json();
      const text: string = out.response ?? '';
      chars = text.length; tokens = out.eval_count ?? 0;
      const d = dir + `outputs/${m.tag}`;
      mkdirSync(d, { recursive: true });
      writeFileSync(`${d}/w${w.index}.txt`, text);
      ok = true;
    } catch (e: any) { err = String(e).slice(0, 200); }
    const dt = (Date.now() - t0) / 1000;
    manifest.push({ model: m.tag, window: w.index, ok, seconds: Math.round(dt * 10) / 10, tokens, chars, err });
    writeFileSync(dir + 'manifest.json', JSON.stringify(manifest, null, 1));
    console.log(key, ok ? `${chars}ch ${tokens}tok ${dt.toFixed(1)}s` : `FAIL ${err}`);
  }
}
console.log('duel complete');
