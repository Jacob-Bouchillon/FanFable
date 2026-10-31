import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/core/db.ts';
import { baselineClient } from '/home/jacob/Documents/FanFable/testing/scripts/benchmark/corpus.ts';
const db = new Db('/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db');
const coordId = db.get<{ id: number }>("SELECT id FROM project WHERE name='book-coord'")!.id;
const chunks = db.all<{ seq: number; text: string }>('SELECT seq, text FROM canon_chunk WHERE project_id = ? ORDER BY seq', coordId);
const fullText = chunks.map((c) => c.text).join('\n');
const rels = db.all<{ f: string; t: string }>(`SELECT fe.name AS f, te.name AS t FROM canon_relation r JOIN canon_entity fe ON fe.id=r.from_entity JOIN canon_entity te ON te.id=r.to_entity WHERE r.project_id = ?`, coordId);
console.log('walktext chars:' + fullText.length + ' ties:' + rels.length);
const MENU = ['husband of','wife of','father of','mother of','son of','daughter of','brother of','sister of','uncle of','aunt of','nephew of','niece of','cousin of','friend of','enemy of','rival of','teacher of','student of','professor of','headmaster of','colleague of','teammate of','classmate of','neighbor of','servant of','master of','guardian of','mentor of','ally of','stranger to','not directly related'];
const TITLEWORDS = new Set(['mr','mrs','ms','miss','dr','professor','prof','aunt','uncle','madam','sir','lady','lord','and']);
const nameToks = (n: string) => new Set(n.toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter((t) => t.length >= 3 && !TITLEWORDS.has(t)));
function samePerson(a: string, b: string): boolean {
  const A = nameToks(a), B = nameToks(b);
  if (!A.size || !B.size) return false;
  const ap = a.toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter((t) => t.length >= 3 && !TITLEWORDS.has(t));
  const bp = b.toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter((t) => t.length >= 3 && !TITLEWORDS.has(t));
  if (ap.length === 1 && bp.length > 1 && ap[0] === bp[bp.length - 1]) return true;
  if (bp.length === 1 && ap.length > 1 && bp[0] === ap[ap.length - 1]) return true;
  const [s, l] = A.size <= B.size ? [A, B] : [B, A];
  if (![...s].every((t) => l.has(t))) return false;
  return true;
}
const SYN: Record<string,string[]> = {'husband of':['husband','wife','married','spouse'],'wife of':['wife','husband','married','spouse'],'mother of':['mother','mum','mummy','mom'],'father of':['father','dad','daddy'],'son of':['son','sons'],'daughter of':['daughter','daughters'],'brother of':['brother','brothers'],'sister of':['sister','sisters'],'uncle of':['uncle','uncles'] ,'aunt of':['aunt','aunts','auntie'] ,'nephew of':['nephew','nephews'] ,'niece of':['niece','nieces'] ,'cousin of':['cousin','cousins']};
const normQ = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
const norm = (s: string) => normQ(s).toLowerCase();
function groundedOwnTitle(label: string, flat: string, names: string[]): boolean {
  const key = label.toLowerCase().trim();
  if (key === 'not directly related') return true;
  const words = SYN[key] ?? [key.split(' ')[0]!];
  let scrubbed = norm(flat);
  for (const nm of names) { const full = norm(nm); if (full.length > 3) scrubbed = scrubbed.split(full).join(' '); }
  if (words.some((w) => scrubbed.includes(w))) return true;
  const base = key.split(' ')[0]!;
  for (const nm of names) { if (norm(nm).split(/[^a-z]+/).filter(Boolean).includes(base)) return true; }
  return false;
}
const llm = baselineClient();
const best: { f: string; t: string; rel: string }[] = [];
const t0 = Date.now();
for (const r of rels) {
  const low = fullText.toLowerCase();
  const ia = low.indexOf(r.f.toLowerCase()), ib = low.indexOf(r.t.toLowerCase());
  if (ia < 0 || ib < 0) continue;
  const s = Math.min(ia, ib), e2 = Math.max(ia, ib) + Math.max(r.f.length, r.t.length);
  const shown = fullText.slice(Math.max(0, s - 500), Math.min(fullText.length, e2 + 500));
  const flat = normQ(shown);
  let hit: { rel: string } | null = null;
  for (let a = 1; a <= 3 && !hit; a++) {
    try {
      const sys = 'Two people are named below, then book text. Reply JSON only: {"relationship": "exactly one of: ' + MENU.join(', ') + '", "signals": ["1 to 3 short exact quotes under 120 chars"], "evidence": "strongest quote"}. Copy quotes exactly. Start with {.';
      const res = await llm.chat({ system: sys, messages: [{ role: 'user', content: `PEOPLE: ${r.f} / ${r.t}\n\nTEXT:\n${shown.slice(0, 6000)}` }], temperature: 0.1, maxTokens: 400 });
      const raw = (res.text ?? '').replace(/```json|```/g, '');
      const si = raw.indexOf('{'), ei = raw.lastIndexOf('}');
      if (si < 0) continue;
      const b: any = JSON.parse(raw.slice(si, ei + 1));
      const rel = String(b?.relationship ?? '').toLowerCase().trim();
      if (!MENU.includes(rel)) continue;
      if (!Array.isArray(b.signals) || !b.signals.length) continue;
      const ev = normQ(String(b.evidence ?? ''));
      if (!(ev.length > 10 && flat.includes(ev) && b.signals.every((sg: unknown) => { const q = normQ(String(sg ?? '')); return q.length > 10 && flat.includes(q); }))) continue;
      if (!groundedOwnTitle(rel, flat, [r.f, r.t])) continue;
      hit = { rel };
    } catch {}
  }
  if (!hit) continue;
  let dup = false;
  for (const v of best) {
    if ((samePerson(v.f, r.f) && samePerson(v.t, r.t)) || (samePerson(v.f, r.t) && samePerson(v.t, r.f))) { dup = true; break; }
  }
  if (!dup) best.push({ f: r.f, t: r.t, rel: hit.rel });
}
console.log(`WALKTEXT ${best.length}/${rels.length} rows in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
for (const v of best) console.log(`KEEP ${v.f} -> ${v.t} (${v.rel})`);
db.close();
