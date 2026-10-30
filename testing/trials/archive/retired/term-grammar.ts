import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';
import { baselineClient } from '/home/jacob/Documents/FanFable/testing/scripts/benchmark/corpus.ts';
const db = new Db('/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db');
const srcId = db.get<{ id: number }>("SELECT id FROM project WHERE name='bench-hp'")!.id;
const chunks = db.all<{ seq: number; text: string }>('SELECT seq, text FROM canon_chunk WHERE project_id = ? ORDER BY seq', srcId);
const fullText = chunks.slice(0, 192).map((c) => c.text).join('\n');
const entities = db.all<{ name: string }>("SELECT name FROM canon_entity WHERE project_id = ? AND kind='character'", srcId);
const TERMS = ['husband','wife','married','mother','mum','father','dad','son','sons','daughter','daughters','brother','brothers','sister','sisters','uncle','uncles','aunt','aunts','auntie','nephew','niece','cousin','cousins','friend','enemy','teacher','student','professor','headmaster','guardian','mentor'];
const normQ = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
const low = fullText.toLowerCase();
const nameHits: { name: string; pos: number }[] = [];
for (const e of entities) {
  const n = e.name.toLowerCase();
  if (n.length < 3) continue;
  let p = -1;
  while ((p = low.indexOf(n, p + 1)) >= 0 && nameHits.length < 8000) nameHits.push({ name: e.name, pos: p });
}
nameHits.sort((a, b) => a.pos - b.pos);
const cands: { from: string; to: string; term: string; pos: number; how: string }[] = [];
const seen = new Set<string>();
for (const t of TERMS) {
  let p = -1;
  const tl = t.toLowerCase();
  while ((p = low.indexOf(tl, p + 1)) >= 0 && cands.length < 20) {
    const winS = Math.max(0, p - 200), winE = Math.min(fullText.length, p + 200);
    const win = fullText.slice(winS, winE);
    const winLow = win.toLowerCase();
    // Pattern A: [Name]'s [term] within 40 chars before term.
    let owner: string | null = null, how = '';
    for (const h of nameHits) {
      if (h.pos < winS || h.pos > p) continue;
      const after = fullText.slice(h.pos + h.name.length, p);
      if (after.length > 40) continue;
      if (/'s\b/.test(after.toLowerCase()) && winLow.includes(h.name.toLowerCase() + "'s")) { owner = h.name; how = "poss"; break; }
    }
    // Pattern B: [term] of [Name] within 40 chars after.
    let anchor: string | null = null;
    if (!owner) {
      const afterTerm = fullText.slice(p + tl.length, p + tl.length + 60).toLowerCase();
      const m = afterTerm.match(/^\s*of\s+([a-z' ]{3,40})/);
      if (m) {
        const frag = m[1]!;
        for (const h of nameHits) {
          if (h.pos < p || h.pos > p + 100) continue;
          if (frag.includes(h.name.toLowerCase().split(' ')[0]!.slice(0, 4))) { anchor = h.name; how = 'of'; break; }
        }
        if (!anchor) {
          for (const h of nameHits) {
            if (h.pos >= p && h.pos <= p + 80) { anchor = h.name; how = 'of-near'; break; }
          }
        }
      }
    }
    const keyName = owner ?? anchor;
    if (!keyName) continue;
    // Other: nearest distinct name within 400 chars.
    let other: string | null = null, bestD = 1e9;
    for (const h of nameHits) {
      if (h.name === keyName) continue;
      const d = Math.abs(h.pos - p);
      if (d < 400 && d < bestD) { bestD = d; other = h.name; }
    }
    if (!other) continue;
    const k = [keyName, other].sort().join('|') + '|' + tl;
    if (seen.has(k)) continue;
    seen.add(k);
    cands.push({ from: keyName, to: other, term: t, pos: p, how });
    if (cands.length >= 20) break;
  }
  if (cands.length >= 20) break;
}
console.log('cands:' + cands.length);
const MENU = ['husband of','wife of','father of','mother of','son of','daughter of','brother of','sister of','uncle of','aunt of','nephew of','niece of','cousin of','friend of','enemy of','rival of','teacher of','student of','professor of','headmaster of','colleague of','teammate of','classmate of','neighbor of','servant of','master of','guardian of','mentor of','ally of','stranger to','not directly related'];
const llm = baselineClient();
let keep = 0;
const t0 = Date.now();
for (const c of cands) {
  const shown = fullText.slice(Math.max(0, c.pos - 500), Math.min(fullText.length, c.pos + 500));
  const flat = normQ(shown);
  let ok = false, rel: string | null = null;
  for (let a = 1; a <= 2 && !ok; a++) {
    try {
      const sys = 'Two people are named below, then book text with the word ' + c.term + ' (' + c.how + '). Reply JSON only: {"relationship": "exactly one of: ' + MENU.join(', ') + '", "signals": ["1 to 3 short exact quotes under 120 chars"], "evidence": "strongest quote"}. Copy quotes exactly. Start with {.';
      const res = await llm.chat({ system: sys, messages: [{ role: 'user', content: `PEOPLE: ${c.from} / ${c.to}\n\nTEXT:\n${shown.slice(0, 6000)}` }], temperature: 0.1, maxTokens: 400 });
      const raw = (res.text ?? '').replace(/```json|```/g, '');
      const si = raw.indexOf('{'), ei = raw.lastIndexOf('}');
      if (si < 0) continue;
      const b: any = JSON.parse(raw.slice(si, ei + 1));
      const r = String(b?.relationship ?? '').toLowerCase().trim();
      if (!MENU.includes(r)) continue;
      if (!Array.isArray(b.signals) || !b.signals.length) continue;
      const ev = normQ(String(b.evidence ?? ''));
      if (ev.length > 10 && flat.includes(ev) && b.signals.every((sg: unknown) => { const q = normQ(String(sg ?? '')); return q.length > 10 && flat.includes(q); })) { ok = true; rel = r; }
    } catch {}
  }
  if (ok) keep++;
  console.log(`${ok ? 'KEEP' : 'drop'} ${c.from} -> ${c.to} (${c.term}/${c.how}) ${rel ?? ''}`);
}
console.log(`GRAMMAR ${keep}/${cands.length} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
db.close();
