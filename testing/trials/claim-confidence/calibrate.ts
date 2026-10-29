/**
 * Claim-confidence calibration (trial only, read-only).
 *
 * Joins the blind-labelled rows already on disk to their stored `confidence`
 * and assessment, then reports predicted vs observed support per band.
 * It never writes a verdict, a row or a correction.
 *
 * Sources:
 *   - 226 gold verdicts, of which gold-map.json locates 42 in n.db / hp3.db;
 *   - the 30-row human sheet + labels.json;
 *   - the 30 delta rows + delta-verdicts.tsv.
 *
 * usage: node testing/trials/claim-confidence/calibrate.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const ROOT = 'testing/trials';
const DB = {
  n: process.env.FANFABLE_CALIB_N ?? `${ROOT}/model-ab/n.db`,
  hp3: process.env.FANFABLE_CALIB_HP3 ?? `${ROOT}/model-ab/hp3.db`,
};

interface Stored {
  db: string;
  id: number;
  from: string;
  to: string;
  kind: string;
  evidence: string;
  confidence: number;
  assessed: boolean;
}

interface Sample {
  source: 'gold' | 'human' | 'delta';
  id: string;
  pair: string;
  kind: string;
  supported: boolean;
  confidence: number | null;
  assessed: boolean;
}

const norm = (text: string): string =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Every relation in the two labelled banks, with its confidence/assessment. */
function loadStored(): Stored[] {
  const out: Stored[] = [];
  for (const [dbName, path] of Object.entries(DB)) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const project = db.prepare("SELECT id AS id FROM project WHERE name = 'ab'").get() as { id: number } | undefined;
      if (!project) continue;
      const rows = db
        .prepare(
          `SELECT r.id, a.name AS from_name, b.name AS to_name, r.kind, r.evidence,
                  r.confidence, r.supporting_evidence
             FROM canon_relation r
             JOIN canon_entity a ON a.id = r.from_entity
             JOIN canon_entity b ON b.id = r.to_entity
            WHERE r.project_id = ?`,
        )
        .all(project.id) as {
        id: number;
        from_name: string;
        to_name: string;
        kind: string;
        evidence: string;
        confidence: number;
        supporting_evidence: string;
      }[];
      for (const row of rows) {
        let assessed = false;
        try {
          const items = JSON.parse(row.supporting_evidence || '[]') as { assessment?: unknown }[];
          assessed = Array.isArray(items) && items.some((item) => !!item?.assessment);
        } catch {
          assessed = false;
        }
        out.push({
          db: dbName,
          id: row.id,
          from: row.from_name,
          to: row.to_name,
          kind: row.kind,
          evidence: row.evidence,
          confidence: Number(row.confidence),
          assessed,
        });
      }
    } catch {
      /* an absent bank contributes nothing */
    } finally {
      db?.close();
    }
  }
  return out;
}

const pairKey = (a: string, b: string): string => [norm(a), norm(b)].sort().join('|');

/** Match a labelled row to a stored relation by evidence prefix first, then
 * by pair/kind, tolerating the roster's fuller names. */
function match(stored: Stored[], pair: string, kind: string, evidence: string): Stored | undefined {
  const [a, b] = pair.split(/\s*\/\s*/);
  const wantPair = pairKey(a ?? '', b ?? '');
  const wantKind = norm(kind);
  const wantEvidence = norm(evidence).slice(0, 100);
  const byEvidence = stored.filter((row) => norm(row.evidence).startsWith(wantEvidence));
  if (byEvidence.length) {
    const exact = byEvidence.find((row) => pairKey(row.from, row.to) === wantPair && norm(row.kind) === wantKind)
      ?? byEvidence.find((row) => pairKey(row.from, row.to) === wantPair);
    if (exact) return exact;
    const tokensOf = (name: string): string[] => norm(name).split(' ').filter((token) => token.length >= 3);
    const named = byEvidence.find((row) => {
      const rowTokens = new Set([...norm(row.from).split(' '), ...norm(row.to).split(' ')]);
      return [a ?? '', b ?? ''].every((name) => tokensOf(name).some((token) => rowTokens.has(token)));
    });
    if (named) return named;
  }
  const samePair = stored.filter((row) => pairKey(row.from, row.to) === wantPair);
  return (
    samePair.find((row) => norm(row.kind) === wantKind && norm(row.evidence).startsWith(wantEvidence)) ??
    samePair.find((row) => norm(row.evidence).startsWith(wantEvidence)) ??
    samePair.find((row) => norm(row.kind) === wantKind)
  );
}

const samples: Sample[] = [];
const stored = loadStored();

// --- gold: 226 verdicts, 42 of them mapped to a stored relation -------------
const verdicts = new Map<number, string>();
for (const part of readFileSync(`${ROOT}/adjudication/gold-verdicts.txt`, 'utf8').split(/[,\n]/)) {
  const [id, verdict] = part.split(':');
  if (id) verdicts.set(Number(id), verdict?.trim() ?? '');
}
const goldMap = JSON.parse(readFileSync(`${ROOT}/adjudication/gold-map.json`, 'utf8')) as {
  gold: number;
  db: string;
  relId: number;
  kind: string;
}[];
for (const entry of goldMap) {
  const found = stored.find((row) => row.db === entry.db && row.id === entry.relId);
  const verdict = verdicts.get(entry.gold);
  if (!found || !verdict) continue;
  samples.push({
    source: 'gold',
    id: `G${entry.gold}`,
    pair: `${found.from} / ${found.to}`,
    kind: found.kind,
    supported: verdict === 'S',
    confidence: found.confidence,
    assessed: found.assessed,
  });
}

// --- human: 30-row sheet + labels.json --------------------------------------
const humanLabels = JSON.parse(readFileSync(`${ROOT}/adjudication/labels.json`, 'utf8')) as Record<
  string,
  { support: string; kind: string }
>;
const humanRows: { id: string; pair: string; kind: string; sentence: string }[] = [];
for (const line of readFileSync(`${ROOT}/adjudication/human-sheet.md`, 'utf8').split('\n')) {
  if (!/^\|\s*\d+\s*\|/.test(line)) continue;
  const cells = line.split('|').map((cell) => cell.trim());
  const id = cells[1] ?? '';
  const pair = cells[2] ?? '';
  const kind = cells[3] ?? '';
  const sentence = cells[4] ?? '';
  if (id && pair && humanLabels[id]) humanRows.push({ id, pair, kind, sentence });
}
for (const row of humanRows) {
  const found = match(stored, row.pair, row.kind, row.sentence);
  samples.push({
    source: 'human',
    id: `H${row.id}`,
    pair: row.pair,
    kind: row.kind,
    supported: humanLabels[row.id]!.support === 'S',
    confidence: found ? found.confidence : null,
    assessed: found?.assessed ?? false,
  });
}

// --- delta: 30 rows + delta-verdicts.tsv ------------------------------------
const deltaItems = (JSON.parse(readFileSync(`${ROOT}/name-variants/delta-key.json`, 'utf8')) as {
  items: { id: string; pair: string[]; kinds: string[]; sentence: string }[];
}).items;
const deltaVerdicts = new Map<string, { identity: string; connection: string; lasting: string; kind: string }>();
for (const line of readFileSync(`${ROOT}/name-variants/delta-verdicts.tsv`, 'utf8').trim().split('\n')) {
  const [id, identity, connection, lasting, kind] = line.split('\t');
  if (id) deltaVerdicts.set(id.trim(), { identity, connection, lasting, kind });
}
for (const item of deltaItems) {
  const verdict = deltaVerdicts.get(item.id);
  if (!verdict) continue;
  const pair = item.pair.join(' / ');
  const sentence = item.sentence.split('|').slice(0, -2).join('|');
  const found = match(stored, pair, item.kinds[0] ?? '', sentence);
  samples.push({
    source: 'delta',
    id: item.id,
    pair,
    kind: item.kinds[0] ?? '',
    supported: verdict.lasting === 'yes',
    confidence: found ? found.confidence : null,
    assessed: found?.assessed ?? false,
  });
}

// --- bands ------------------------------------------------------------------
const bandOf = (confidence: number): string => {
  if (confidence >= 0.9) return '0.9-1.0';
  if (confidence >= 0.8) return '0.8-0.9';
  if (confidence >= 0.7) return '0.7-0.8';
  if (confidence >= 0.6) return '0.6-0.7';
  if (confidence >= 0.5) return '0.5-0.6';
  return '<0.5';
};

interface BandRow {
  band: string;
  n: number;
  predicted: number;
  observed: number;
  supported: number;
}

function bands(list: Sample[]): BandRow[] {
  const groups = new Map<string, Sample[]>();
  for (const sample of list) {
    if (sample.confidence === null) continue;
    const band = bandOf(sample.confidence);
    groups.set(band, [...(groups.get(band) ?? []), sample]);
  }
  const order = ['<0.5', '0.5-0.6', '0.6-0.7', '0.7-0.8', '0.8-0.9', '0.9-1.0'];
  return order
    .filter((band) => groups.has(band))
    .map((band) => {
      const rows = groups.get(band)!;
      const supported = rows.filter((row) => row.supported).length;
      return {
        band,
        n: rows.length,
        predicted: Number((rows.reduce((sum, row) => sum + (row.confidence ?? 0), 0) / rows.length).toFixed(3)),
        observed: Number((supported / rows.length).toFixed(3)),
        supported,
      };
    });
}

const assessedSamples = samples.filter((sample) => sample.assessed);
const assessedBands = bands(assessedSamples);
const bySource = {
  gold: bands(samples.filter((sample) => sample.source === 'gold')),
  human: bands(samples.filter((sample) => sample.source === 'human')),
  delta: bands(samples.filter((sample) => sample.source === 'delta')),
  goldHuman: bands(samples.filter((sample) => sample.source === 'gold' || sample.source === 'human')),
  assessed: assessedBands,
  all: bands(samples),
};

const unjoined = samples.filter((sample) => sample.confidence === null).length;
const assessed = samples.filter((sample) => sample.assessed).length;
const unjoinedSupport = (['gold', 'human', 'delta'] as const).map((source) => {
  const rows = samples.filter((sample) => sample.source === source && sample.confidence === null);
  const supported = rows.filter((sample) => sample.supported).length;
  return { source, n: rows.length, supported };
});

// A correction is a proposal only; nothing is applied to a row or a verdict.
const correction = (assessedBands.length ? assessedBands : bySource.goldHuman)
  .filter((row) => row.n >= 5 && Math.abs(row.predicted - row.observed) >= 0.2)
  .map((row) => ({
    band: row.band,
    stored: row.predicted,
    observed: row.observed,
    suggested: row.observed,
    note: 'proposal only: do not apply without a re-run on assessed rows; the gold+human join is complete, the delta join is partial',
  }));

const report = {
  sources: {
    gold: {
      labelled: verdicts.size,
      mapped: goldMap.length,
      joined: samples.filter((sample) => sample.source === 'gold').length,
    },
    human: { labelled: Object.keys(humanLabels).length, sheetRows: humanRows.length, joined: samples.filter((s) => s.source === 'human' && s.confidence !== null).length },
    delta: { labelled: deltaItems.length, joined: samples.filter((s) => s.source === 'delta' && s.confidence !== null).length },
  },
  joined: samples.length - unjoined,
  unjoined,
  unjoinedSupport,
  assessed,
  assessedSamples: assessedSamples.length,
  legacySamples: samples.length - assessedSamples.length,
  note:
    assessed === 0
      ? 'The labelled rows predate the assessment prompt: every joined row carries the old default confidence 1.0 and no assessment. The 0.9-1.0 band is therefore not a model prediction; it is the pre-change default.'
      : undefined,
  bands: bySource,
  correction,
};

writeFileSync('/tmp/opencode/claim-confidence-calibration.json', JSON.stringify({ report, samples }, null, 1));

console.log(JSON.stringify(report, null, 1));
console.log('\nrows: source  band        n   predicted  observed');
for (const [source, rows] of Object.entries(bySource)) {
  for (const row of rows) {
    console.log(`${source.padEnd(6)} ${row.band.padEnd(10)} ${String(row.n).padStart(3)}  ${row.predicted.toFixed(2)}       ${row.observed.toFixed(2)}`);
  }
}
