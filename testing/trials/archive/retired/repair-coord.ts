import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/core/db.ts';
import { baselineClient } from '/home/jacob/Documents/FanFable/testing/scripts/benchmark/corpus.ts';
const db = new Db('/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db');
const srcId = db.get<{ id: number }>("SELECT id FROM project WHERE name='bench-hp'")!.id;
const coordId = db.get<{ id: number }>("SELECT id FROM project WHERE name='book-coord'")!.id;
const chunks = db.all<{ seq: number; text: string }>('SELECT seq, text FROM canon_chunk WHERE project_id = ? ORDER BY seq', srcId);
const fullText = chunks.map((c) => c.text).join('\n');
const rels = db.all<{ f: string; t: string }>(`SELECT fe.name AS f, te.name AS t FROM canon_relation r JOIN canon_entity fe ON fe.id=r.from_entity JOIN canon_entity te ON te.id=r.to_entity WHERE r.project_id = ?`, coordId);
const MENU = ['husband of','wife of','father of','mother of','son of','daughter of','brother of','sister of','uncle of','aunt of','nephew of','niece of','cousin of','friend of','enemy of','rival of','teacher of','student of','professor of','headmaster of','colleague of','teammate of','classmate of','neighbor of','servant of','master of','guardian of','mentor of','ally of','stranger to','not directly related'];
const llm = baselineClient();
const normQ = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
let keep = 0, repaired = 0;
const t0 = Date.now();
for (const r of rels) {
  const ia = fullText.indexOf(r.f), ib = fullText.indexOf(r.t);
  if (ia < 0 || ib < 0) continue;
  const s = Math.min(ia, ib), e2 = Math.max(ia, ib) + Math.max(r.f.length, r.t.length);
  const shown = fullText.slice(Math.max(0, s - 500), Math.min(fullText.length, e2 + 500));
  const flat = normQ(shown);
  let ok = false, fixed = false;
  for (let a = 1; a <= 2 && !ok; a++) {
    try {
      const sys = 'Two people are named below, then book text. Reply JSON only: {"relationship": "exactly one of: ' + MENU.join(', ') + '", "signals": ["1 to 3 short exact quotes under 120 chars, copied word for word"], "evidence": "strongest quote copied exactly"}. The label words must appear in the text. Copy quotes exactly, no rewording. Start with {.';
      const res = await llm.chat({ system: sys, messages: [{ role: 'user', content: `PEOPLE: ${r.f} / ${r.t}\n\nTEXT:\n${shown.slice(0, 6000)}` }], temperature: 0.1, maxTokens: 400 });
      const raw = (res.text ?? '').replace(/```json|```/g, '');
      const si = raw.indexOf('{'), ei = raw.lastIndexOf('}');
      if (si < 0) continue;
      const best: any = JSON.parse(raw.slice(si, ei + 1));
      if (!MENU.includes(String(best?.relationship ?? '').toLowerCase().trim())) continue;
      if (!Array.isArray(best.signals) || !best.signals.length) continue;
      const ev = normQ(String(best.evidence ?? ''));
      if (ev.length > 10 && flat.includes(ev) && best.signals.every((sg: unknown) => { const q = normQ(String(sg ?? '')); return q.length > 10 && flat.includes(q); })) { ok = true; }
    } catch {}
  }
  if (ok) { keep++; continue; }
  // Repair try: show model its miss, demand exact re-copy.
  try {
    const sys = 'Your last quotes were not word-for-word. Look at the TEXT and re-copy 1 to 3 exact snippets under 120 chars that prove the tie, and re-pick the label using only words that appear in the TEXT. Reply JSON only: {"relationship": "exactly one of: ' + MENU.join(', ') + '", "signals": [...], "evidence": "..."}. Start with {.';
    const res = await llm.chat({ system: sys, messages: [{ role: 'user', content: `PEOPLE: ${r.f} / ${r.t}\n\nTEXT:\n${shown.slice(0, 6000)}\n\nRe-copy exact quotes only.` }], temperature: 0.1, maxTokens: 400 });
    const raw = (res.text ?? '').replace(/```json|```/g, '');
    const si = raw.indexOf('{'), ei = raw.lastIndexOf('}');
    if (si >= 0) {
      const best: any = JSON.parse(raw.slice(si, ei + 1));
      if (MENU.includes(String(best?.relationship ?? '').toLowerCase().trim()) && Array.isArray(best.signals) && best.signals.length) {
        const ev = normQ(String(best.evidence ?? ''));
        if (ev.length > 10 && flat.includes(ev) && best.signals.every((sg: unknown) => { const q = normQ(String(sg ?? '')); return q.length > 10 && flat.includes(q); })) { repaired++; keep++; fixed = true; }
      }
    }
  } catch {}
  console.log(`${ok ? 'KEEP' : fixed ? 'FIXED' : 'drop'} ${r.f} -> ${r.t}`);
}
console.log(`KEEPERS ${keep}/${rels.length} (repaired ${repaired}) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
db.close();
