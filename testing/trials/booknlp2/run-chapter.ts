/**
 * booknlp2 fork test — E1 (binding accuracy) + E3 (speaker attribution).
 *
 * Same chapter, same pipeline, same scoring as the upstream probe; only the
 * model code differs (blueprintparadise/booknlp2 in this track's own venv).
 * The chapter input is the upstream export, reused byte-for-byte: this track
 * never re-exports and the select step is verify-only (no writes anywhere).
 *
 * Trial-only. The bank is opened READ-ONLY and never written; fork outputs
 * are blind-review candidates and NOTHING banks (no relation, note, ruling or
 * status row is created by this script).
 *
 * usage (from the repo root):
 *   node --experimental-strip-types testing/trials/booknlp2/run-chapter.ts [select|run|score|all]
 *
 * Steps:
 *   select  verify the upstream chapter export exists (no writes)
 *   run     run the fork venv pipeline (entity,quote,event,coref; small
 *           model; no supersense) with a 60-minute cap into out/
 *   score   score the outputs read-only against the bank roster and write
 *           out/manifest.json (counts only, never passage prose)
 *   all     verify, then run, then score
 *
 * Writes only under testing/trials/booknlp2/ (gitignored data). The bank must
 * be byte-identical before and after: size + mtime are recorded and compared.
 * Scoring logic is identical to testing/trials/booknlp/run-chapter.ts; only
 * paths, the select step, and manifest identity fields differ.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TRACK = 'testing/trials/booknlp2';
const UPSTREAM = 'testing/trials/booknlp';
const DB_PATH = 'testing/trials/halfbook-run/plagueis-half.db';
const PROJECT = 'halfbook';
const VENV_PY = `${TRACK}/.venv/bin/python`;
// The fork runs on the upstream chapter export byte-for-byte; never re-exported here.
const CHAPTER_TXT = `${UPSTREAM}/chapter.txt`;
const SELECT_JSON = `${UPSTREAM}/select.json`;
const OUT_DIR = `${TRACK}/out`;
const BOOK_ID = 'chapter';
const RUN_CAP_SECS = 3600;

function fail(message: string): never {
  throw new Error(`run-chapter: ${message}`);
}

function dbStat(): { size: number; mtimeMs: number } {
  const st = statSync(DB_PATH);
  return { size: st.size, mtimeMs: st.mtimeMs };
}

function openRo(): DatabaseSync {
  return new DatabaseSync(resolve(DB_PATH), { readOnly: true });
}

interface BlockPick {
  block: number;
  seqFrom: number;
  seqTo: number;
  chunks: number;
  quoteMarks: number;
  density: number;
}

export function selectChapter(): { pick: BlockPick; markers: number; dbBefore: unknown; dbAfter: unknown } {
  // Verify-only: the fork reuses the upstream export byte-for-byte, so this
  // step reads the upstream metadata and writes nothing anywhere.
  const dbBefore = dbStat();
  if (!existsSync(CHAPTER_TXT)) fail(`no upstream chapter at ${CHAPTER_TXT}`);
  const sel = JSON.parse(readFileSync(SELECT_JSON, 'utf8')) as {
    pick: BlockPick;
    markers: number;
  };
  const bytes = readFileSync(CHAPTER_TXT, 'utf8').length;
  console.log(
    `select: upstream block ${sel.pick.block} seq ${sel.pick.seqFrom}-${sel.pick.seqTo} chunks ${sel.pick.chunks} chars ${bytes} (verify-only, no writes)`,
  );
  const dbAfter = dbStat();
  if (dbAfter.size !== dbBefore.size || dbAfter.mtimeMs !== dbBefore.mtimeMs) {
    fail('bank changed during select (size/mtime moved)');
  }
  console.log(`select: bank untouched (size ${dbBefore.size})`);
  return { pick: sel.pick, markers: sel.markers, dbBefore, dbAfter };
}

const DRIVER = `
import sys
import torch

# Bridge for stale 2021-era checkpoints under a modern transformers: the
# stored state includes bert.*.position_ids buffers that current BERT keeps
# as non-persistent (recomputed identically on the fly). Anything beyond
# position_ids drift still raises. No vendored file is modified.
_orig_load = torch.nn.Module.load_state_dict

def _tolerant_load(self, state_dict, strict=True, *a, **k):
    try:
        return _orig_load(self, state_dict, strict, *a, **k)
    except RuntimeError as e:
        if "position_ids" not in str(e):
            raise
        own = set(self.state_dict().keys())
        incoming = set(state_dict.keys())
        diff = (incoming - own) | (own - incoming)
        if diff and all("position_ids" in key for key in diff):
            print(f"NOTE: ignoring position_ids key drift: {sorted(diff)}", flush=True)
            return _orig_load(self, state_dict, False, *a, **k)
        raise

torch.nn.Module.load_state_dict = _tolerant_load

from booknlp.english.english_booknlp import EnglishBookNLP
inp, outdir, book_id = sys.argv[1], sys.argv[2], sys.argv[3]
nlp = EnglishBookNLP({"pipeline": "entity,quote,event,coref", "model": "small"})
nlp.process(inp, outdir, book_id)
`;

export function runPipeline(): { exit: number | null; secs: number; capped: boolean } {
  if (!existsSync(VENV_PY)) fail(`no venv python at ${VENV_PY} (run setup first)`);
  if (!existsSync(CHAPTER_TXT)) fail(`no ${CHAPTER_TXT} (run select first)`);
  mkdirSync(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  const res = spawnSync('timeout', [`${RUN_CAP_SECS}`, VENV_PY, '-c', DRIVER, resolve(CHAPTER_TXT), resolve(OUT_DIR), BOOK_ID], {
    stdio: 'inherit',
  });
  const secs = Math.round((Date.now() - t0) / 1000);
  const capped = res.status === 124;
  console.log(`run: exit ${res.status} secs ${secs}${capped ? ' (60-min cap hit)' : ''}`);
  if (capped) fail('pipeline hit the 60-minute cap');
  if (res.status !== 0) fail(`pipeline exited ${res.status}`);
  writeFileSync(`${OUT_DIR}/run.json`, JSON.stringify({ exit: res.status, secs, capped }, null, 1));
  return { exit: res.status, secs, capped };
}

const norm = (s: string): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function scoreOutputs(): Record<string, unknown> {
  const dbBefore = dbStat();
  const freeze = ((): Record<string, string> => {
    const res = spawnSync(VENV_PY, ['-m', 'pip', 'freeze'], { encoding: 'utf8' });
    const out: Record<string, string> = {};
    for (const line of String(res.stdout ?? '').split('\n')) {
      const m = line.match(/^(booknlp2|booknlp|spacy|torch|transformers|tensorflow|en-core-web-sm|en_core_web_sm)==(.+)$/i);
      if (m) out[m[1]!.toLowerCase()] = m[2]!;
      // PEP 610 direct references (e.g. the git-installed fork) carry no ==.
      const at = line.match(/^(booknlp2) @ (\S+)$/i);
      if (at) out[at[1]!.toLowerCase()] = at[2]!;
    }
    return out;
  })();
  let spacyModel = '';
  try {
    const res = spawnSync(VENV_PY, ['-c', 'import en_core_web_sm; print(en_core_web_sm.__version__)'], {
      encoding: 'utf8',
    });
    spacyModel = String(res.stdout ?? '').trim();
  } catch {
    spacyModel = 'unknown';
  }
  const sel = JSON.parse(readFileSync(SELECT_JSON, 'utf8')) as { pick: BlockPick };

  const entitiesPath = `${OUT_DIR}/${BOOK_ID}.entities`;
  const quotesPath = `${OUT_DIR}/${BOOK_ID}.quotes`;
  const tokensPath = `${OUT_DIR}/${BOOK_ID}.tokens`;
  const bookPath = `${OUT_DIR}/${BOOK_ID}.book`;
  for (const p of [entitiesPath, quotesPath, tokensPath, bookPath]) {
    if (!existsSync(p)) fail(`missing output ${p} (run the pipeline first)`);
  }

  // .book characters: proper names live in mentions.proper[{c,n}].
  const book = JSON.parse(readFileSync(bookPath, 'utf8')) as {
    characters?: { id: number; mentions?: { proper?: { c: number; n: string }[] } }[];
  };
  const clusters: { id: number; names: string[] }[] = (book.characters ?? []).map((c) => ({
    id: Number(c.id),
    names: (c.mentions?.proper ?? []).map((m) => String(m.n)),
  }));
  const namedIds = new Set(clusters.map((c) => c.id));

  function bodyRows(path: string): string[][] {
    const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
    const rows = lines.map((line) => line.split('\t'));
    // Every BookNLP TSV opens with a header row (non-numeric first cell).
    if (rows.length && !/^-?\d+$/.test((rows[0]![0] ?? '').trim())) rows.shift();
    return rows;
  }

  // .entities: coref, start, end, prop(NOM/PROP/PRON), cat, text.
  const entRows = bodyRows(entitiesPath);
  const pronTotal = entRows.filter((r) => (r[3] ?? '').toUpperCase() === 'PRON').length;
  const pronLinked = entRows.filter(
    (r) => (r[3] ?? '').toUpperCase() === 'PRON' && namedIds.has(Number(r[0])),
  ).length;

  // .quotes: quote span, mention span, mention text, coref, quote text.
  const quoteRows = bodyRows(quotesPath);
  const quotesTotal = quoteRows.length;
  const quotesAttributed = quoteRows.filter((r) => (r[4] ?? '').trim().length > 0).length;

  // .tokens: last column is the event tag; count tagged tokens.
  const tokenRows = bodyRows(tokensPath);
  const eventTokens = tokenRows.filter((r) => {
    const tag = (r[r.length - 1] ?? '').trim();
    return tag.length > 0 && tag.toUpperCase() !== 'O';
  }).length;

  // Bank side, read-only.
  const db = openRo();
  let rosterPersons: { id: number; forms: string[] }[];
  let bankEventsInRange: number;
  try {
    const project = db.prepare('SELECT id AS id FROM project WHERE name = ?').get(PROJECT) as { id: number };
    rosterPersons = (
      db
        .prepare("SELECT id AS id, name AS name, aliases AS aliases FROM canon_entity WHERE project_id = ? AND kind = 'character'")
        .all(project.id) as { id: number; name: string; aliases: string }[]
    ).map((r) => {
      let aliases: string[] = [];
      try {
        aliases = JSON.parse(r.aliases || '[]') as string[];
      } catch {
        aliases = [];
      }
      return { id: r.id, forms: [r.name, ...aliases].map(norm).filter(Boolean) };
    });
    const selChunks = db
      .prepare('SELECT id AS id FROM canon_chunk WHERE project_id = ? AND seq >= ? AND seq <= ?')
      .all(project.id, sel.pick.seqFrom, sel.pick.seqTo) as { id: number }[];
    const ids = selChunks.map((r) => r.id);
    bankEventsInRange =
      ids.length === 0
        ? 0
        : (db
            .prepare(`SELECT COUNT(*) AS n FROM canon_event WHERE chunk_id IN (${ids.map(() => '?').join(',')})`)
            .get(...ids) as { n: number }).n;
  } finally {
    db.close();
  }

  // Cluster <-> roster matching (counts only).
  const formToPersons = new Map<string, Set<number>>();
  for (const p of rosterPersons) {
    for (const f of p.forms) {
      const set = formToPersons.get(f) ?? new Set<number>();
      set.add(p.id);
      formToPersons.set(f, set);
    }
  }
  let exactOne = 0;
  let badMerges = 0;
  const matchedPersons = new Set<number>();
  for (const c of clusters) {
    const persons = new Set<number>();
    for (const n of c.names) {
      for (const id of formToPersons.get(norm(n)) ?? []) persons.add(id);
    }
    for (const id of persons) matchedPersons.add(id);
    if (persons.size === 1) exactOne++;
    else if (persons.size >= 2) badMerges++;
  }
  const rosterMissed = rosterPersons.filter((p) => !matchedPersons.has(p.id)).length;

  const manifest = {
    track: 'booknlp2',
    repo: 'booknlp2-fork',
    recipe: 'pip install git+https://github.com/blueprintparadise/booknlp2.git; python -m spacy download en_core_web_sm (fork README adapted)',
    envAdaptations:
      'quota-safe CPU-only variant, all in the track venv: torch from the CPU index (no CUDA libs), ' +
      'fork --no-deps (bypasses its transformers==4.11.3 pin and tensorflow floor; same playbook as upstream), ' +
      'transformers kept modern (5.22.1) with a harness-side strict-load bridge that ignores only ' +
      'stale bert position_ids keys (recomputed identically on the fly; any other drift still raises); ' +
      'no vendored file modified, no system interpreter touched',
    pipeline: 'entity,quote,event,coref (supersense skipped)',
    pipelineRun: existsSync(`${OUT_DIR}/run.json`)
      ? JSON.parse(readFileSync(`${OUT_DIR}/run.json`, 'utf8'))
      : null,
    modelSize: 'small (big only if small fails)',
    versions: { ...freeze, en_core_web_sm: spacyModel },
    booknlpModel: 'small',
    chapter: sel.pick,
    chapterFile: CHAPTER_TXT,
    outputs: [entitiesPath, quotesPath, tokensPath, bookPath],
    scores: {
      clusters: clusters.length,
      clusterExactOnePerson: exactOne,
      clusterBadTwoPersonMerges: badMerges,
      rosterPersons: rosterPersons.length,
      rosterMissed: rosterMissed,
      pronounMentions: pronTotal,
      pronounLinkedToNamed: pronLinked,
      quotes: quotesTotal,
      quotesAttributed: quotesAttributed,
      quotesAttributedPct: quotesTotal ? Number(((100 * quotesAttributed) / quotesTotal).toFixed(1)) : 0,
      eventTokens: eventTokens,
      bankEventsInChapterRange: bankEventsInRange,
    },
    reviewStatus: 'NOTHING banks — outputs are blind-review candidates',
    dbUntouched: dbStat(),
    dbBefore,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/manifest.json`, JSON.stringify(manifest, null, 1));
  const dbAfter = dbStat();
  if (dbAfter.size !== dbBefore.size || dbAfter.mtimeMs !== dbBefore.mtimeMs) {
    fail('bank changed during scoring (size/mtime moved)');
  }
  const s = manifest.scores as Record<string, number>;
  console.log(
    `score: clusters ${s.clusters} exactOne ${s.clusterExactOnePerson} badMerges ${s.clusterBadTwoPersonMerges} ` +
      `roster ${s.rosterPersons} missed ${s.rosterMissed} pron ${s.pronounLinkedToNamed}/${s.pronounMentions} ` +
      `quotes ${s.quotesAttributed}/${s.quotes} (${s.quotesAttributedPct}%) eventTokens ${s.eventTokens} bankEvents ${s.bankEventsInChapterRange}`,
  );
  console.log(`score: bank untouched (size ${dbBefore.size}); manifest ${OUT_DIR}/manifest.json`);
  console.log('NOTHING banks — outputs are blind-review candidates');
  return manifest;
}

function main(argv: string[]): void {
  const step = argv[0] ?? 'all';
  if (step === 'select') selectChapter();
  else if (step === 'run') runPipeline();
  else if (step === 'score') scoreOutputs();
  else if (step === 'all') {
    selectChapter();
    runPipeline();
    scoreOutputs();
  } else fail(`unknown step "${step}" (select|run|score|all)`);
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('run-chapter.ts')) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
