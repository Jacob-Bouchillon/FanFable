// Scores the ungated run: same span-gate as score-duel.ts, plus truncation flags.
// Reads duel-windows.json + outputs/<tag>-free/w<index>.txt + manifest-free.json.
// Writes score-free.json + summary-free.md (this dir only).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('./', import.meta.url));
const norm = (s: string) =>
  s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
const duel = JSON.parse(readFileSync(dir + 'duel-windows.json', 'utf8'));
const winText: Map<number, string> = new Map(duel.windows.map((w: any) => [w.index, norm(w.text)]));

const KEYS = ['gracus', 'tarkin', 'mentor', 'benefactor', 'grooming', 'darnada', 'cabra', 'ronhar', 'vidar kim', 'aide'];
const report: any = { models: {} };

for (const tag of ['nue3', 'nue15', 'qwen']) {
  let windows = 0, yielded = 0, extracted = 0, verbatim = 0, wall = 0, tokens = 0, truncated = 0;
  const keyHits: Record<string, number> = Object.fromEntries(KEYS.map((k) => [k, 0]));
  const perWindow: any[] = [];
  let manifest: any[] = [];
  try { manifest = JSON.parse(readFileSync(dir + 'manifest-free.json', 'utf8')); } catch { /* */ }
  for (const w of duel.windows) {
    let resp = '';
    try { resp = readFileSync(`${dir}outputs/${tag}-free/w${w.index}.txt`, 'utf8'); } catch { continue; }
    windows++;
    const m = manifest.find((x) => x.model === tag && x.window === w.index);
    if (m) { wall += m.seconds ?? 0; tokens += m.tokens ?? 0; if (m.err === 'TRUNCATED-AT-CAP') truncated++; }
    const quotes = [...norm(resp).matchAll(/"([^"]{8,300})"/g)].map((x) => x[1]!.trim());
    extracted += quotes.length;
    const ok = quotes.filter((q) => winText.get(w.index)!.includes(q));
    verbatim += ok.length;
    if (ok.length) yielded++;
    const low = resp.toLowerCase();
    for (const k of KEYS) if (low.includes(k)) keyHits[k]!++;
    perWindow.push({ window: w.index, quotes: quotes.length, verbatim: ok.length });
  }
  report.models[tag] = { windows, yielded, extracted, verbatim, rate: extracted ? Math.round((verbatim / extracted) * 1000) / 10 : 0, wall: Math.round(wall), tokens, truncated, keyHits, perWindow };
}

writeFileSync(dir + 'score-free.json', JSON.stringify(report, null, 1));
const names: Record<string, string> = { nue3: 'v3 Q4_K_M (3.5GB)', nue15: 'v1.5 Q4_K_M (2.4GB)', qwen: 'qwen2.5:7b (4.7GB)' };
const row = (tag: string) => {
  const r = report.models[tag];
  return `| ${names[tag]} | ${r.windows} | ${r.yielded} | ${r.extracted} | ${r.verbatim} | ${r.rate}% | ${r.wall}s | ${r.tokens} | ${r.truncated} |\n`;
};
const keys = (tag: string) => {
  const kh = report.models[tag].keyHits;
  return Object.entries(kh).filter(([, n]: any) => n).map(([k, n]: any) => `${k}×${n}`).join(', ') || 'none';
};
const md =
  `# Ungated recall run — all 3 (frozen ground, 33 windows)\n\n` +
  `No format imposed, cap 8000 tokens (vs 2000 gated), quote requirement kept, temp 0. ` +
  `Compare against the gated table: does lifting the muzzle recover the missing ties?\n\n` +
  `| model | windows | yielded | extracted | verbatim | rate | wall | tokens | truncated |\n` +
  `|---|---|---|---|---|---|---|---|---|\n` +
  row('nue3') + row('nue15') + row('qwen') + `\n` +
  `Key-tie mentions (v3): ${keys('nue3')}\n\n` +
  `Key-tie mentions (v1.5): ${keys('nue15')}\n\n` +
  `Key-tie mentions (qwen): ${keys('qwen')}\n\n` +
  `Scoring: quote counts iff normalized substring of its own window. ` +
  `Per-window table in score-free.json.\n`;
writeFileSync(dir + 'summary-free.md', md);
console.log(md);
