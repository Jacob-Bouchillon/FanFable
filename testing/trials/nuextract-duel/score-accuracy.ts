// Accuracy proxy: which model's output would survive the bank gates?
// Parses both models' UNGATED outputs (v3 typed blocks, qwen labelless pairs)
// and applies the project's own gate logic per tie: kind present, closed
// vocab, not a moment, quote verbatim in its window, quote naming the
// endpoints (cap-words proxy), kin word spoken for kin kinds.
// No model calls, no DB writes. Writes score-accuracy.json + prints table.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isClosedRoleKind, isMomentKind, isUnsupportedKind } from '../../../fanfable/src/lorebook.ts';

const dir = fileURLToPath(new URL('./', import.meta.url));
const norm = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
const duel = JSON.parse(readFileSync(dir + 'duel-windows.json', 'utf8'));
const winText: Map<number, string> = new Map(duel.windows.map((w: any) => [w.index, norm(w.text)]));
const capWords = (s: string): string[] => (norm(s).match(/\b[A-Z][a-z']+\b/g) ?? []);

interface Tie { window: number; names: string; kind: string | null; quote: string }

function parseV3(tag: string): Tie[] {
  const out: Tie[] = [];
  for (const w of duel.windows) {
    let raw = '';
    try { raw = readFileSync(`${dir}outputs/${tag}-free/w${w.index}.txt`, 'utf8'); } catch { continue; }
    for (const block of raw.split(/\n\s*\n/)) {
      const lines = block.split('\n').map((l) => norm(l)).filter(Boolean);
      if (!lines.length) continue;
      const head = lines[0]!.replace(/^[-*\s>]+/, '');
      if (/^(here is|the |these |below|note:|i |for each|relationships)/i.test(head)) continue;
      if (head.length > 120) continue;
      const ci = head.lastIndexOf(':');
      if (ci < 0) continue;
      const names = head.slice(0, ci).trim();
      const kind = head.slice(ci + 1).trim().split(/\s+/).slice(0, 4).join(' ');
      const quotes = [...norm(block).matchAll(/"([^"]{8,400})"/g)].map((m) => m[1]!.trim());
      if (!names || !quotes.length) continue;
      for (const quote of quotes) out.push({ window: w.index, names, kind: kind || null, quote });
    }
  }
  return out;
}

function parseQwen(tag: string): Tie[] {
  const out: Tie[] = [];
  for (const w of duel.windows) {
    let raw = '';
    try { raw = readFileSync(`${dir}outputs/${tag}-free/w${w.index}.txt`, 'utf8'); } catch { continue; }
    const entries = raw.split(/\n(?=-\s)/);
    for (const e of entries) {
      const t = norm(e);
      if (!t.startsWith('-')) continue;
      const firstLine = norm(e.split('\n')[0]!);
      const nm = firstLine.match(/^-\s*\**(.+?)\**\s*:/);
      const names = (nm?.[1] ?? '').replace(/\*/g, '').trim();
      if (!names || names.length > 120) continue;
      const quotes = [...t.matchAll(/"([^"]{8,400})"/g)].map((m) => m[1]!.trim());
      for (const quote of quotes) out.push({ window: w.index, names, kind: null, quote });
    }
  }
  return out;
}

function grade(ties: Tie[]) {
  let verbatim = 0, endpointOk = 0, closedKind = 0, momentKind = 0, silentNoun = 0, bankable = 0;
  for (const t of ties) {
    const win = winText.get(t.window)!;
    const v = win.includes(t.quote);
    if (v) verbatim++;
    const cw = capWords(t.names);
    const ep = cw.length > 0 && cw.every((w) => win.includes(t.quote) && t.quote.includes(w));
    if (ep) endpointOk++;
    let closed = false, moment = false, silent = false;
    if (t.kind) {
      const k = t.kind.trim().toLowerCase();
      closed = isClosedRoleKind(t.kind) || isClosedRoleKind(k + ' of');
      if (closed) closedKind++;
      moment = isMomentKind(t.kind);
      if (moment) momentKind++;
      silent = isUnsupportedKind(t.kind, t.quote);
      if (silent) silentNoun++;
    }
    if (v && ep && closed && !moment && !silent) bankable++;
  }
  const n = ties.length || 1;
  return { ties: ties.length, verbatim, verbatimRate: pct(verbatim, n), endpointOk, closedKind, momentKind, silentNoun, bankable, bankableRate: pct(bankable, n) };
}
const pct = (a: number, b: number) => Math.round((a / b) * 1000) / 10;

const v3 = grade(parseV3('nue3'));
const qw = grade(parseQwen('qwen'));
console.log('V3  ', JSON.stringify(v3));
console.log('QWEN', JSON.stringify(qw));
writeFileSync(dir + 'score-accuracy.json', JSON.stringify({ v3, qwen: qw }, null, 1));
