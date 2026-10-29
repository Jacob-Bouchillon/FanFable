// Exports parsed ungated ties for external judging (Gemini).
// Two CSVs: v3 (typed blocks) + qwen (labelless pairs). Machine-parsed, not
// hand-cleaned: prose blocks and entity lists the parser rejects are excluded.
// Columns: model, window, locator (first of window), names, kind, quote.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('./', import.meta.url));
const norm = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
const duel = JSON.parse(readFileSync(dir + 'duel-windows.json', 'utf8'));
const firstLoc: Map<number, string> = new Map(duel.windows.map((w: any) => [w.index, w.locators[0] ?? '']));

const cell = (v: string): string => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function parseV3(): string[][] {
  const rows: string[][] = [];
  for (const w of duel.windows) {
    let raw = '';
    try { raw = readFileSync(`${dir}outputs/nue3-free/w${w.index}.txt`, 'utf8'); } catch { continue; }
    for (const block of raw.split(/\n\s*\n/)) {
      const lines = block.split('\n').map((l) => norm(l)).filter(Boolean);
      if (!lines.length) continue;
      const head = lines[0]!.replace(/^[-*\s>]+/, '');
      if (/^(here is|the |these |below|note:|i |for each|relationships)/i.test(head)) continue;
      if (head.length > 120) continue;
      const ci = head.lastIndexOf(':');
      if (ci < 0) continue;
      const names = head.slice(0, ci).trim().replace(/^\d+[.)]\s*/, '');
      const kind = head.slice(ci + 1).trim().split(/\s+/).slice(0, 4).join(' ');
      const quotes = [...norm(block).matchAll(/"([^"]{8,400})"/g)].map((m) => m[1]!.trim());
      if (!names || !quotes.length) continue;
      for (const quote of quotes) rows.push(['nue3', String(w.index), firstLoc.get(w.index)!, names, kind || '', quote]);
    }
  }
  return rows;
}

function parseQwen(): string[][] {
  const rows: string[][] = [];
  for (const w of duel.windows) {
    let raw = '';
    try { raw = readFileSync(`${dir}outputs/qwen-free/w${w.index}.txt`, 'utf8'); } catch { continue; }
    for (const e of raw.split(/\n(?=-\s)/)) {
      const t = norm(e);
      if (!t.startsWith('-')) continue;
      const firstLine = norm(e.split('\n')[0]!);
      const nm = firstLine.match(/^-\s*\**(.+?)\**\s*:/);
      const names = (nm?.[1] ?? '').replace(/\*/g, '').trim();
      if (!names || names.length > 120) continue;
      const quotes = [...t.matchAll(/"([^"]{8,400})"/g)].map((m) => m[1]!.trim());
      for (const quote of quotes) rows.push(['qwen', String(w.index), firstLoc.get(w.index)!, names, '', quote]);
    }
  }
  return rows;
}

for (const [tag, fn] of [['nue3', parseV3], ['qwen', parseQwen]] as const) {
  const rows = fn();
  const csv = ['model,window,locator,names,kind,quote', ...rows.map((r) => r.map(cell).join(','))].join('\n') + '\n';
  writeFileSync(`${dir}gemini-${tag}-claims.csv`, csv);
  console.log(tag, rows.length, 'rows ->', `testing/trials/nuextract-duel/gemini-${tag}-claims.csv`);
}
