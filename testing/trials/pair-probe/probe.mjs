/**
 * Pair-probing prototype. Read-only on the rescan bank; writes only its CSV.
 * One model call per candidate pair; no pipeline or bank changes.
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { CLOSED_ROLE_KINDS, buildNameRoster, isUnsupportedKind } from '../../../fanfable/src/lorebook.ts';
import { canonicalName, nameMentionedExact } from '../../../fanfable/src/names.ts';
import { splitSentences } from '../../../fanfable/src/text.ts';
import { createClient } from '../../../fanfable/src/llm.ts';
import { PROOF_TITLES, STOPWORDS } from '../../../fanfable/src/vocab.ts';

const DB = '/home/jacob/Documents/FanFable/testing/trials/rescan/rescan.db';
const OUT = '/home/jacob/Documents/FanFable/testing/trials/pair-probe/results.csv';
const MODEL = 'qwen2.5:7b';
const TEMPERATURE = 0.1;
const PAIR_CAP = 12;
const SCENE_CHUNKS = 8;
const STARTS = [20, 300, 600];
const NON_PERSON = new Set(['faction', 'rule', 'location', 'item', 'creature', 'species']);
// Roster surfaces also catch capitalized function words from quoted speech; a
// person's name is not a pronoun, conjunction, contraction or bare title.
const BARE_TITLES = new Set([
  'master', 'senator', 'lord', 'lady', 'captain', 'commander', 'doctor', 'general',
  'admiral', 'officer', 'padawan', 'apprentice', 'chancellor', 'supreme', 'vigo', 'vigos',
]);
// Function words and bare common nouns that the roster's quoted-speech pass
// also harvests. Universal vocabulary, no source text.
const FUNCTIONISH = new Set([
  ...STOPWORDS,
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'first', 'last', 'next', 'many', 'much', 'more', 'most', 'your', 'my', 'our',
  'their', 'its', 'whose', 'which', 'what', 'who', 'whom', 'had', 'was', 'were',
  'been', 'being', 'done', 'enough', 'everything', 'anything', 'nothing', 'something',
  'time', 'times', 'death', 'life', 'rule', 'order', 'force', 'side', 'tell', 'stop',
  'realizing', 'beings', 'temple', 'way', 'thing', 'things', 'people', 'man', 'woman',
  'king', 'queen', 'prince', 'princess', 'majesty', 'dark', 'remember', 'bring', 'perhaps',
  'true', 'well', 'already', 'another', 'even', 'great', 'holding', 'mining', 'deep', 'get',
  'reserve', 'there', 'following',
]);
const DRY = process.argv.includes('--dry');

const raw = new DatabaseSync(DB, { readOnly: true });
const db = {
  path: DB,
  get: (sql, ...params) => raw.prepare(sql).get(...params),
  all: (sql, ...params) => raw.prepare(sql).all(...params),
  run: () => { throw new Error('read-only'); },
  transaction: (fn) => fn(),
};
const projectId = db.get('SELECT id FROM project ORDER BY id LIMIT 1').id;
const chunks = db.all(`SELECT c.id, c.seq, c.heading, c.locator, c.text, s.title AS source_title, s.path, c.source_id
  FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id
  WHERE c.project_id = ? ORDER BY c.source_id, c.seq`, projectId);
const entities = db.all('SELECT id, name, aliases, kind FROM canon_entity WHERE project_id = ?', projectId);
const entityByKey = new Map();
for (const entity of entities) {
  for (const variant of [entity.name, ...JSON.parse(entity.aliases || '[]')]) {
    const key = canonicalName(variant);
    if (key && !entityByKey.has(key)) entityByKey.set(key, entity);
  }
}
const entityByName = new Map();
const characterTokens = new Set();
const nonPersonTokens = new Set();
for (const entity of entities) {
  const key = canonicalName(entity.name);
  if (key && !entityByName.has(key)) entityByName.set(key, entity);
  for (const variant of [entity.name, ...JSON.parse(entity.aliases || '[]')]) {
    for (const token of canonicalName(variant).split(' ')) {
      if (token.length < 3 || BARE_TITLES.has(token) || PROOF_TITLES.has(token) || token === 'darth') continue;
      if (entity.kind === 'character') characterTokens.add(token);
      else if (NON_PERSON.has(entity.kind)) nonPersonTokens.add(token);
    }
  }
}
const roster = buildNameRoster(db, projectId, chunks);
const closed = new Set(CLOSED_ROLE_KINDS.map((kind) => kind.toLowerCase()));

function sceneFrom(startSeq) {
  const startIndex = chunks.findIndex((chunk) => chunk.seq === startSeq);
  if (startIndex < 0) throw new Error(`no chunk at seq ${startSeq}`);
  const run = chunks.slice(startIndex, startIndex + SCENE_CHUNKS);
  const joined = run.map((chunk) => chunk.text).join('\n\n');
  const cut = joined.lastIndexOf('\n\n');
  const text = cut > joined.length * 0.5 ? joined.slice(0, cut) : joined;
  return { label: `seq${startSeq}`, run, text, sentences: splitSentences(text) };
}

function castOf(scene) {
  const seen = new Set();
  const cast = [];
  const lowercaseWords = new Set((scene.text.toLowerCase().match(/[a-z][a-z'’-]*/g) ?? []));
  for (const entry of roster.entries) {
    if (!nameMentionedExact(entry.surface, scene.text)) continue;
    const key = entry.surface.toLowerCase();
    if (seen.has(key)) continue;
    const words = key.split(/[^a-z]+/).filter(Boolean);
    if (!words.length || words.some((word) => FUNCTIONISH.has(word))) continue;
    if (/['’](?:s|t|re|ve|ll|d|m)$/i.test(entry.surface)) continue;
    if (words.length === 1 && (PROOF_TITLES.has(words[0]) || BARE_TITLES.has(words[0]))) continue;
    seen.add(key);
    const canonical = canonicalName(entry.surface);
    const entity = entityByKey.get(canonical);
    if (entity) {
      if (NON_PERSON.has(entity.kind)) continue;
    } else {
      // A run that swallowed a known character ("Plagueis Tenebrous") or a
      // known people/place/thing is not another person.
      if (words.some((word) => characterTokens.has(word))) continue;
      if (words.some((word) => nonPersonTokens.has(word))) continue;
      // A lone word the scene also uses in lowercase is a common word or a
      // title, not a proper name. Multi-word runs are kept so titles attached
      // to a real name ("Darth Bane") survive.
      if (words.length === 1 && lowercaseWords.has(words[0])) continue;
    }
    cast.push(entry.surface);
  }
  return cast;
}

function occurrences(surface, sentences) {
  const out = [];
  sentences.forEach((sentence, index) => {
    if (nameMentionedExact(surface, sentence)) out.push(index);
  });
  return out;
}

function personKey(surface) {
  const words = canonicalName(surface).split(' ').filter(Boolean);
  const useful = words.filter((word) => !BARE_TITLES.has(word) && !PROOF_TITLES.has(word) && word !== 'darth');
  return useful[useful.length - 1] ?? canonicalName(surface);
}

function pairsOf(cast, sentences) {
  const where = new Map(cast.map((surface) => [surface, occurrences(surface, sentences)]));
  const pairs = [];
  const byPairKey = new Set();
  for (let i = 0; i < cast.length; i++) {
    for (let j = i + 1; j < cast.length; j++) {
      let count = 0;
      for (const a of where.get(cast[i])) {
        for (const b of where.get(cast[j])) {
          if (Math.abs(a - b) <= 3) count++;
        }
      }
      if (count <= 0) continue;
      const ca = canonicalName(cast[i]);
      const cb = canonicalName(cast[j]);
      if (ca === cb || ca.includes(cb) || cb.includes(ca)) continue;
      const ea = entityByKey.get(ca);
      const eb = entityByKey.get(cb);
      if (ea && eb && ea.id === eb.id) continue;
      const pairKey = [personKey(cast[i]), personKey(cast[j])].sort().join('|');
      if (byPairKey.has(pairKey)) continue;
      byPairKey.add(pairKey);
      pairs.push({ a: cast[i], b: cast[j], count, pairKey });
    }
  }
  pairs.sort((x, y) =>
    y.count - x.count ||
    `${x.a}\u0000${x.b}`.localeCompare(`${y.a}\u0000${y.b}`, 'en', { sensitivity: 'variant' }),
  );
  return { pairs, where };
}

function thirdParty(sentence, a, b, cast) {
  return cast.some(
    (surface) => surface !== a && surface !== b && nameMentionedExact(surface, sentence),
  );
}

function locatorFor(scene, sentence) {
  const chunk = scene.run.find((row) => row.text.includes(sentence)) ??
    scene.run.find((row) => row.text.replace(/\s+/g, ' ').includes(sentence.replace(/\s+/g, ' ')));
  return chunk?.locator ?? scene.run[0]?.locator ?? '';
}

function csv(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const SYSTEM = `You judge one pair in a scene from a book.

Allowed kinds (choose exactly one, never invent one): ${CLOSED_ROLE_KINDS.join(', ')}

If this scene states a lasting tie between the pair, reply with the kind from the allowed list and the number of the single sentence that states it.
If the scene only shows them together, or the tie is stated about someone else, reply {"kind":"NONE"}.
Do not use outside knowledge. Do not return a sentence that does not name or clearly refer to this pair.

Reply with JSON only:
{"kind":"one allowed kind","sentence":1,"why":"at most eight words"}
or
{"kind":"NONE"}

Sentence numbers are 1-based in the scene as shown.`;

function numberedScene(sentences) {
  return sentences.map((sentence, index) => `${index + 1}. ${sentence}`).join('\n');
}

function parseAnswer(text) {
  const body = String(text ?? '').replace(/```json|```/g, '').trim();
  try {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end < start) return null;
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

const scenes = STARTS.map((start) => {
  const scene = sceneFrom(start);
  const cast = castOf(scene);
  const { pairs } = pairsOf(cast, scene.sentences);
  return { ...scene, cast, pairs, asked: pairs.slice(0, PAIR_CAP) };
});

// Existing rescan relations, matched by the same distinctive-name key.
const relations = db.all(`SELECT r.id, r.kind, r.review_status, a.name fn, a.aliases fa, b.name tn, b.aliases ta
  FROM canon_relation r JOIN canon_entity a ON a.id = r.from_entity JOIN canon_entity b ON b.id = r.to_entity
  WHERE r.project_id = ?`, projectId);
function keysOf(name, aliases) {
  return new Set([name, ...JSON.parse(aliases || '[]')].map((variant) => personKey(variant)));
}
function existingFor(pair) {
  const ka = personKey(pair.a);
  const kb = personKey(pair.b);
  return relations.filter((row) => {
    const kf = keysOf(row.fn, row.fa);
    const kt = keysOf(row.tn, row.ta);
    return (kf.has(ka) && kt.has(kb)) || (kf.has(kb) && kt.has(ka));
  });
}

if (DRY) {
  for (const scene of scenes) {
    console.log(JSON.stringify({
      scene: scene.label,
      sentences: scene.sentences.length,
      words: scene.text.split(/\s+/).length,
      cast: scene.cast.length,
      castSample: scene.cast.slice(0, 20),
      pairs: scene.pairs.length,
      asked: scene.asked.length,
      topPairs: scene.asked.slice(0, 12).map((p) => `${p.a} + ${p.b} (${p.count})`),
    }, null, 2));
  }
  raw.close();
  process.exit(0);
}

const llm = createClient({
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: MODEL,
  temperature: TEMPERATURE,
  maxTokens: 400,
  contextTokens: 16384,
  timeoutMs: 600_000,
});

const rows = [['scene', 'pair', 'answer kind', 'sentence index', 'sentence text', 'verdict', 'reason']];
const summary = [];
const startedAt = Date.now();
let calls = 0;
writeFileSync(OUT, rows.map((row) => row.map(csv).join(',')).join('\n') + '\n');

const writeRow = (row) => {
  rows.push(row);
  writeFileSync(OUT, rows.map((cells) => cells.map(csv).join(',')).join('\n') + '\n');
};

for (const scene of scenes) {
  const stats = { scene: scene.label, cast: scene.cast.length, enumerated: scene.pairs.length, asked: scene.asked.length, yes: 0, verified: 0, ambiguous: 0, none: 0, rejected: {} };
  for (const pair of scene.asked) {
    calls++;
    let answer = null;
    try {
      const res = await llm.chat({
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: `PAIR: ${pair.a} + ${pair.b}\n\nSCENE (numbered sentences):\n${numberedScene(scene.sentences)}`,
        }],
        temperature: TEMPERATURE,
        maxTokens: 400,
        format: 'json',
      });
      answer = parseAnswer(res.text);
    } catch (err) {
      answer = null;
    }
    const kindRaw = answer && typeof answer.kind === 'string' ? answer.kind.trim().toLowerCase() : '';
    if (!answer || !kindRaw) {
      stats.rejected['unparseable answer'] = (stats.rejected['unparseable answer'] ?? 0) + 1;
      writeRow([scene.label, `${pair.a} + ${pair.b}`, '', '', '', 'rejected', 'unparseable answer']);
      continue;
    }
    if (kindRaw === 'none') {
      stats.none++;
      writeRow([scene.label, `${pair.a} + ${pair.b}`, 'NONE', '', '', 'none', '']);
      continue;
    }
    stats.yes++;
    const kind = kindRaw;
    if (!closed.has(kind)) {
      stats.rejected['kind not closed'] = (stats.rejected['kind not closed'] ?? 0) + 1;
      writeRow([scene.label, `${pair.a} + ${pair.b}`, kind, String(answer.sentence ?? ''), '', 'rejected', 'kind not closed']);
      continue;
    }
    const index = Number(answer.sentence);
    if (!Number.isInteger(index) || index < 1 || index > scene.sentences.length) {
      stats.rejected['sentence out of range'] = (stats.rejected['sentence out of range'] ?? 0) + 1;
      writeRow([scene.label, `${pair.a} + ${pair.b}`, kind, String(answer.sentence ?? ''), '', 'rejected', 'sentence out of range']);
      continue;
    }
    const sentence = scene.sentences[index - 1];
    if (isUnsupportedKind(kind, sentence)) {
      stats.rejected['tie word absent'] = (stats.rejected['tie word absent'] ?? 0) + 1;
      writeRow([scene.label, `${pair.a} + ${pair.b}`, kind, String(index), sentence, 'rejected', 'tie word absent']);
      continue;
    }
    if (thirdParty(sentence, pair.a, pair.b, scene.cast)) {
      stats.ambiguous++;
      writeRow([scene.label, `${pair.a} + ${pair.b}`, kind, String(index), sentence, 'ambiguous', 'third cast member named']);
      continue;
    }
    stats.verified++;
    writeRow([scene.label, `${pair.a} + ${pair.b}`, kind, String(index), sentence, 'verified', locatorFor(scene, sentence)]);
  }
  summary.push(stats);
}

const minutes = Math.round((Date.now() - startedAt) / 600) / 100;
console.log(JSON.stringify({
  model: MODEL,
  temperature: TEMPERATURE,
  scenes: summary,
  calls,
  minutes,
  verifiedPerCall: calls ? +(summary.reduce((n, s) => n + s.verified, 0) / calls).toFixed(3) : 0,
  verified: summary.reduce((n, s) => n + s.verified, 0),
}, null, 2));
raw.close();
