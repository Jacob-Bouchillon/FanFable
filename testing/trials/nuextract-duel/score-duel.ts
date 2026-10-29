// Scores the duel: span-verified quotes per window, key-tie checklist.
// Reads duel-windows.json + outputs/<model>/w<index>.txt. Writes score.json + summary.md.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('./', import.meta.url));
const norm = (s: string) =>
  s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
const duel = JSON.parse(readFileSync(dir + 'duel-windows.json', 'utf8'));
const winText: Map<number, string> = new Map(duel.windows.map((w: any) => [w.index, norm(w.text)]));

const KEYS = ['gracus', 'tarkin', 'mentor', 'benefactor', 'grooming', 'darnada', 'cabra', 'ronhar', 'vidar kim', 'aide'];
const report: any = { models: {} };

for (const tag of ['nue3', 'nue15', 'qwen']) {
  let windows = 0, yielded = 0, extracted = 0, verbatim = 0, wall = 0, tokens = 0;
  const keyHits: Record<string, number> = Object.fromEntries(KEYS.map((k) => [k, 0]));
  const perWindow: any[] = [];
  let manifest: any[] = [];
  try { manifest = JSON.parse(readFileSync(dir + 'manifest.json', 'utf8')); } catch { /* */ }
  for (const w of duel.windows) {
    let resp = '';
    try { resp = readFileSync(`${dir}outputs/${tag}/w${w.index}.txt`, 'utf8'); } catch { continue; }
    windows++;
    const m = manifest.find((x) => x.model === tag && x.window === w.index);
    if (m) { wall += m.seconds ?? 0; tokens += m.tokens ?? 0; }
    const quotes = [...norm(resp).matchAll(/"([^"]{8,300})"/g)].map((x) => x[1]!.trim());
    extracted += quotes.length;
    const ok = quotes.filter((q) => winText.get(w.index)!.includes(q));
    verbatim += ok.length;
    if (ok.length) yielded++;
    const low = resp.toLowerCase();
    for (const k of KEYS) if (low.includes(k)) keyHits[k]!++;
    perWindow.push({ window: w.index, quotes: quotes.length, verbatim: ok.length });
  }
  report.models[tag] = { windows, yielded, extracted, verbatim, rate: extracted ? Math.round((verbatim / extracted) * 1000) / 10 : 0, wall: Math.round(wall), tokens, keyHits, perWindow };
}

writeFileSync(dir + 'score.json', JSON.stringify(report, null, 1));
const r3 = report.models.nue3, r15 = report.models.nue15, rq = report.models.qwen;
const row = (name: string, r: any) =>
  `| ${name} | ${r.windows} | ${r.yielded} | ${r.extracted} | ${r.verbatim} | ${r.rate}% | ${r.wall}s | ${r.tokens} |\n`;
const keys = (r: any) =>
  Object.entries(r.keyHits).filter(([, n]: any) => n).map(([k, n]: any) => `${k}×${n}`).join(', ') || 'none';
const md =
  `# NuExtract duel — v3 vs v1.5 vs qwen (frozen ground, 33 windows)\n\n` +
  `Ground: \`duel-windows.json\` — top-32 by scoreWindow + Tarkin window (index ${duel.tarkin}), windowSize 8, real chunk path. ` +
  `Prompt identical (free markdown list, think:false, temp 0, 2000 tokens). Concurrency 1.\n\n` +
  `| model | windows | yielded (≥1 verbatim) | extracted | verbatim | rate | wall | tokens |\n` +
  `|---|---|---|---|---|---|---|---|\n` +
  row('v3 Q4_K_M (3.5GB)', r3) + row('v1.5 Q4_K_M (2.4GB)', r15) + row('qwen2.5:7b (4.7GB)', rq) + `\n` +
  `Key-tie mentions (v3): ${keys(r3)}\n\n` +
  `Key-tie mentions (v1.5): ${keys(r15)}\n\n` +
  `Key-tie mentions (qwen): ${keys(rq)}\n\n` +
  `Scoring: quote counts as verifiable iff normalized substring of its own window text. ` +
  `Short fragments (e.g. "Just my luck,") count here but are not evidence-grade — see per-window table in score.json.\n`;
writeFileSync(dir + 'summary.md', md);
console.log(md);
