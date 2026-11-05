/**
 * Gate ablation harness (trials only, not in npm test).
 *
 * Frozen candidate pool from a disposable copy; runs provenRelation under the
 * baseline and one switch at a time. Read-only, no model, no writes.
 *
 * usage: node testing/trials/claim-confidence/gate-ablation.ts --db <copy.db>
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as gates from '../../../fanfable/src/gates/gates.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const OUT = '/tmp/opencode/gate-ablation';
const CAP = 2000;
const SWITCHES = ['DIRECTION', 'DENIAL', 'SYMMETRIC_STRICT', 'VERBATIM_BOUNDARY', 'THRESHOLD', 'ENDPOINT', 'ENTAILMENT'] as const;
const ENV_NAMES = SWITCHES.map((name) => `FANFABLE_ABLATE_${name}`);

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = args[at + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function clearSwitches(): void {
  for (const name of ENV_NAMES) delete process.env[name];
}

interface PoolRow {
  relId: number;
  row: gates.PromoteRow;
  chunkText?: string;
}

function main(): void {
  const args = process.argv.slice(2);
  const dbPath = flag(args, 'db');
  if (!dbPath) {
    process.stderr.write('usage: gate-ablation.ts --db <copy.db>\n');
    process.exit(2);
  }
  if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let pool: PoolRow[];
  let minConfidence = 0.7;
  try {
    const project = db.prepare('SELECT id, settings FROM project ORDER BY id LIMIT 1').get() as
      | { id: number; settings: string }
      | undefined;
    if (!project) throw new Error('database has no project');
    try {
      const settings = JSON.parse(project.settings || '{}') as { minConfidence?: unknown };
      const value = Number(settings.minConfidence);
      if (Number.isFinite(value)) minConfidence = Math.min(1, Math.max(0, value));
    } catch {
      /* default */
    }
    const rows = db
      .prepare(
        `SELECT r.id, r.from_entity, r.to_entity, r.kind, r.kind_source, r.anchor_evidence,
                r.evidence, r.source_refs, r.confidence,
                a.name AS from_name, a.aliases AS from_aliases,
                b.name AS to_name, b.aliases AS to_aliases
           FROM canon_relation r
           JOIN canon_entity a ON a.id = r.from_entity
           JOIN canon_entity b ON b.id = r.to_entity
          WHERE r.project_id = ?
          ORDER BY r.id
          LIMIT ?`,
      )
      .all(project.id, CAP) as {
      id: number;
      from_entity: number;
      to_entity: number;
      kind: string;
      kind_source: string;
      anchor_evidence: string;
      evidence: string;
      source_refs: string;
      confidence: number;
      from_name: string;
      from_aliases: string;
      to_name: string;
      to_aliases: string;
    }[];
    const aliases = (raw: string): string[] => {
      try {
        const parsed = JSON.parse(raw || '[]');
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    };
    const chunkOf = (refs: string): string | undefined => {
      let parsed: unknown = [];
      try {
        parsed = JSON.parse(refs || '[]');
      } catch {
        return undefined;
      }
      if (!Array.isArray(parsed)) return undefined;
      for (const ref of parsed) {
        const id = Number((ref as { chunk?: unknown })?.chunk);
        if (!Number.isInteger(id) || id <= 0) continue;
        const chunk = db.prepare('SELECT text FROM canon_chunk WHERE id = ? AND project_id = ?').get(id, project.id) as
          | { text: string }
          | undefined;
        if (chunk) return chunk.text;
      }
      return undefined;
    };
    pool = rows.map((row) => ({
      relId: row.id,
      chunkText: chunkOf(row.source_refs),
      row: {
        fromId: row.from_entity,
        toId: row.to_entity,
        fromName: row.from_name,
        toName: row.to_name,
        fromAliases: aliases(row.from_aliases),
        toAliases: aliases(row.to_aliases),
        kind: row.kind,
        kindSource: row.kind_source || undefined,
        anchorEvidence: row.anchor_evidence || undefined,
        evidence: row.evidence,
        confidence: row.confidence,
      },
    }));
  } finally {
    db.close();
  }

  const admitted = (variant: string): Set<number> => {
    clearSwitches();
    if (variant !== 'baseline') process.env[`FANFABLE_ABLATE_${variant}`] = '1';
    const out = new Set<number>();
    for (const entry of pool) {
      if (gates.provenRelation(entry.row, { chunkText: entry.chunkText, minConfidence }).ok) out.add(entry.relId);
    }
    return out;
  };

  const baseline = admitted('baseline');
  clearSwitches();

  // Refusal reasons for baseline-refused rows. Each gate check is evaluated
  // independently so a row can report more than one fired reason.
  const buckets = [
    'direction-mismatch',
    'assertion-missing',
    'relationship-not-entailed',
    'quote-not-verbatim',
    'below-threshold',
    'endpoint-unnamed',
    'other',
  ] as const;
  type Bucket = (typeof buckets)[number];
  const countsPerReason: Record<Bucket, number> = Object.fromEntries(buckets.map((key) => [key, 0])) as Record<Bucket, number>;
  let rowsRefused = 0;
  let rowsWithSingleReason = 0;
  let rowsWithMultipleReasons = 0;
  let rowsWithNoReason = 0;
  for (const entry of pool) {
    if (baseline.has(entry.relId)) continue;
    rowsRefused++;
    const fired = new Set<Bucket>();
    const bucketOf = (reason: string | null | undefined): Bucket => {
      if (!reason) return 'other';
      if (reason === 'assertion-missing') return 'assertion-missing';
      if (reason === 'direction-mismatch') return 'direction-mismatch';
      if (reason === 'relationship-not-entailed') return 'relationship-not-entailed';
      if (reason === 'quote-not-verbatim') return 'quote-not-verbatim';
      if (reason === 'below-threshold') return 'below-threshold';
      if (reason === 'endpoint-unnamed') return 'endpoint-unnamed';
      return 'other';
    };
    const quote = gates.quoteVerbatimReason(entry.row, entry.chunkText);
    if (quote) fired.add(bucketOf(quote));
    const keeper = gates.keeperQuoteReason(entry.row, entry.chunkText);
    if (keeper) fired.add(bucketOf(keeper));
    if (!gates.citationNamesBothEndpoints(entry.row)) fired.add('endpoint-unnamed');
    const entailment = gates.relationEntailmentReason(entry.row);
    if (entailment) fired.add(bucketOf(entailment));
    if (gates.claimTier(entry.row.confidence ?? 0, minConfidence) !== 'accepted') fired.add('below-threshold');
    if (fired.size === 0) {
      rowsWithNoReason++;
      fired.add('other');
    }
    if (fired.size === 1) rowsWithSingleReason++;
    else rowsWithMultipleReasons++;
    for (const reason of fired) countsPerReason[reason]++;
  }
  const refusalHistogram = {
    rowsRefused,
    rowsWithSingleReason,
    rowsWithMultipleReasons,
    rowsWithNoReason,
    countsPerReason,
  };

  const matrix = [
    { variant: 'baseline', admitted: baseline.size, newlyAdmittedVsBaseline: [] as number[], newlyRefusedVsBaseline: [] as number[] },
  ];
  for (const variant of SWITCHES) {
    const current = admitted(variant);
    matrix.push({
      variant,
      admitted: current.size,
      newlyAdmittedVsBaseline: [...current].filter((id) => !baseline.has(id)).sort((a, b) => a - b),
      newlyRefusedVsBaseline: [...baseline].filter((id) => !current.has(id)).sort((a, b) => a - b),
    });
  }
  clearSwitches();

  mkdirSync(OUT, { recursive: true });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  writeFileSync(
    `${OUT}/manifest.json`,
    `${JSON.stringify({
      schema: 'fanfable-gate-ablation/1',
      model: null,
      seed: 42,
      commit,
      cap: CAP,
      poolSize: pool.length,
      sourceDb: dbPath,
      predicate: 'all canon_relation rows, any status',
      variants: ['baseline', ...SWITCHES],
    }, null, 2)}\n`,
  );
  writeFileSync(`${OUT}/matrix.json`, `${JSON.stringify(matrix, null, 2)}\n`);
  writeFileSync(`${OUT}/refusal-histogram.json`, `${JSON.stringify(refusalHistogram, null, 2)}\n`);
  console.log(JSON.stringify({ poolSize: pool.length, minConfidence, matrix, refusalHistogram }));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
