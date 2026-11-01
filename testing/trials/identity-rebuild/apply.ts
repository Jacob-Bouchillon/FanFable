/**
 * Stage C of the rebuild: gated live apply.
 *
 * Trial-only. Steps (from the repo root):
 *   node --experimental-strip-types testing/trials/identity-rebuild/apply.ts [gate|dryrun|apply|restore]
 *
 * gate: copy must pass rebuild.ts verify + evidence.ts verifyEvidence.
 * dryrun: prints the before/after table without touching live.
 * apply: gate -> live-hash guard -> timestamped backup (under the track)
 *   -> file-copy the copy over live -> re-run integrity on live ->
 *   print applied table. Any integrity failure restores the backup.
 * restore: copies the newest backup-live-*.db back over live.
 *
 * No pushes. Reports print counts only.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const TRACK = 'testing/trials/identity-rebuild';
const LIVE = `${process.env.HOME}/.local/share/fanfable/fanfable.db`;
const COPY = `${TRACK}/copy.db`;
const PROJECT = 1;

function fail(message: string): never {
  throw new Error(`apply: ${message}`);
}

function runStep(file: string, step: string): void {
  const r = spawnSync('node', ['--experimental-strip-types', `${TRACK}/${file}`, step], { encoding: 'utf8' });
  process.stdout.write(String(r.stdout ?? '').split('\n').filter((l) => /^(verify|merge|cover|rekind|textmerge|apply)/.test(l)).join('\n') + '\n');
  if (r.status !== 0) {
    process.stderr.write(String(r.stderr ?? '').slice(-2000));
    fail(`gate step ${file} ${step} exited ${r.status}`);
  }
}

export function gate(): void {
  runStep('rebuild.ts', 'verify');
  runStep('evidence.ts', 'verify');
  console.log('gate: copy passes integrity');
}

function table(dbPath: string, readOnly: boolean): Record<string, unknown> {
  const db = new DatabaseSync(dbPath, { readOnly });
  try {
    const rel = (db.prepare('SELECT count(*) c FROM canon_relation WHERE project_id = ?').get(PROJECT) as { c: number }).c;
    const proof = (db.prepare("SELECT count(*) c FROM canon_relation WHERE project_id = ? AND review_status IN ('accepted','attested','user_confirmed')").get(PROJECT) as { c: number }).c;
    const uc = (db.prepare("SELECT count(*) c FROM canon_relation WHERE project_id = ? AND review_status = 'user_confirmed'").get(PROJECT) as { c: number }).c;
    const needs = db.prepare('SELECT review_status, count(*) c FROM canon_relation WHERE project_id = ? GROUP BY 1').all(PROJECT) as { review_status: string; c: number }[];
    const kinds = db.prepare('SELECT kind, count(*) c FROM canon_entity WHERE project_id = ? GROUP BY 1').all(PROJECT) as { kind: string; c: number }[];
    const chars = kinds.find((k) => k.kind === 'character')?.c ?? 0;
    const tied = new Set<number>();
    for (const r of db.prepare("SELECT from_entity, to_entity FROM canon_relation WHERE project_id = ? AND review_status IN ('accepted','attested','user_confirmed')").all(PROJECT) as { from_entity: number; to_entity: number }[]) {
      tied.add(r.from_entity);
      tied.add(r.to_entity);
    }
    const charIds = new Set((db.prepare("SELECT id FROM canon_entity WHERE project_id = ? AND kind = 'character'").all(PROJECT) as { id: number }[]).map((r) => r.id));
    let tiedChars = 0;
    for (const id of tied) if (charIds.has(id)) tiedChars++;
    let statusDist: Record<string, number> = {};
    try {
      const dist = db.prepare('SELECT relation_status, count(*) c FROM canon_relation WHERE project_id = ? GROUP BY 1').all(PROJECT) as { relation_status: string; c: number }[];
      statusDist = Object.fromEntries(dist.map((d) => [String(d.relation_status), d.c]));
    } catch { statusDist = { 'no-column': -1 }; }
    return { relations: rel, proofRows: proof, userConfirmed: uc, byStatus: Object.fromEntries(needs.map((n) => [n.review_status, n.c])), entityKinds: Object.fromEntries(kinds.map((k) => [k.kind, k.c])), characters: chars, tiedChars, statusDist };
  } finally {
    db.close();
  }
}

function regatherReasons(dbPath: string): Record<string, number> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT supporting_evidence FROM canon_relation WHERE project_id = ? AND review_status = 'needs_review'").all(PROJECT) as { supporting_evidence: string }[];
    const counts: Record<string, number> = {};
    for (const r of rows) {
      try {
        const arr = JSON.parse(r.supporting_evidence || '[]') as unknown[];
        for (const item of arr) {
          const g = (item as { regather?: { reason?: string } }).regather;
          if (g?.reason) counts[g.reason] = (counts[g.reason] ?? 0) + 1;
        }
      } catch { /* skip */ }
    }
    return counts;
  } finally {
    db.close();
  }
}

export function dryrun(): void {
  const before = table(LIVE, true);
  const after = table(COPY, true);
  const reasons = regatherReasons(COPY);
  const dropped = existsSync(`${TRACK}/merge-log.md`) ? readFileSync(`${TRACK}/merge-log.md`, 'utf8').split('\n').filter((l) => l.startsWith('- relfold') || l.startsWith('- tiefold') || l.startsWith('- selfloop') || l.startsWith('- textmerge-selfloop')).length : 0;
  console.log(`dryrun: relations ${before.relations}->${after.relations} proofRows ${before.proofRows}->${after.proofRows} uc ${before.userConfirmed}->${after.userConfirmed}`);
  console.log(`dryrun: tiedChars ${before.tiedChars}/${before.characters}->${after.tiedChars}/${after.characters} reasons=${JSON.stringify(reasons)} droppedLogged=${dropped}`);
  console.log(`dryrun: entityKinds=${JSON.stringify(after.entityKinds)} statusDist=${JSON.stringify(after.statusDist)}`);
}

function newestBackup(): string | null {
  const files = readdirSync(TRACK).filter((f) => f.startsWith('backup-live-') && f.endsWith('.db')).sort();
  return files.length ? `${TRACK}/${files[files.length - 1]!}` : null;
}

export function apply(): void {
  gate();
  const manifest = JSON.parse(readFileSync(`${TRACK}/manifest.json`, 'utf8')) as { liveSha: string };
  // Live-hash guard: refuse if live moved since Stage A backup.
  const h = spawnSync('node', ['--experimental-strip-types', '-e', `import('node:crypto').then(async m=>{const f=await import('node:fs');const h=m.createHash('sha256');h.update(f.readFileSync('${LIVE}'));console.log(h.digest('hex'))})`], { encoding: 'utf8' });
  const liveSha = String(h.stdout ?? '').trim();
  if (liveSha !== manifest.liveSha) fail(`live bank moved since backup (manifest ${manifest.liveSha.slice(0, 12)} vs live ${liveSha.slice(0, 12)})`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${TRACK}/backup-live-${stamp}.db`;
  copyFileSync(LIVE, backupPath);
  console.log(`apply: backup ${backupPath}`);
  dryrun();
  // Checkpoint the copy, then file-copy over live (no connections open).
  const cp = new DatabaseSync(COPY);
  try {
    cp.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run();
  } finally {
    cp.close();
  }
  copyFileSync(COPY, LIVE);
  removeSidecars();
  // Re-run integrity on live: point the gate at live via a temporary switch
  // is overkill; instead re-run the same checks inline on the live file.
  try {
    liveIntegrity();
    const live = table(LIVE, false);
    console.log(`apply: live now relations=${live.relations} proofRows=${live.proofRows} uc=${live.userConfirmed} tied=${live.tiedChars}/${live.characters}`);
  } catch (err) {
    const back = newestBackup();
    if (back) copyFileSync(back, LIVE);
    removeSidecars();
    fail(`live integrity failed, restored ${back}: ${(err as Error).message}`);
  }
  console.log('apply: done');
}

function liveIntegrity(): void {
  const db = new DatabaseSync(LIVE, { readOnly: true });
  try {
    const ids = new Set((db.prepare('SELECT id FROM canon_entity').all() as { id: number }[]).map((r) => r.id));
    const rels = db.prepare('SELECT id, from_entity, to_entity, evidence, review_status FROM canon_relation WHERE project_id = 1').all() as { id: number; from_entity: number; to_entity: number; evidence: string; review_status: string }[];
    let orphans = 0;
    let self = 0;
    for (const r of rels) {
      if (!ids.has(r.from_entity) || !ids.has(r.to_entity)) orphans++;
      if (r.from_entity === r.to_entity) self++;
    }
    if (orphans || self) fail(`live integrity: orphans=${orphans} self=${self}`);
  } finally {
    db.close();
  }
}

function removeSidecars(): void {
  for (const suf of ['-wal', '-shm', '-journal']) {
    const p = LIVE + suf;
    if (existsSync(p)) rmSync(p);
  }
}

export function restore(): void {
  const back = newestBackup();
  if (!back) fail('no backup-live file');
  copyFileSync(back, LIVE);
  removeSidecars();
  console.log(`restore: live restored from ${back}`);
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('apply.ts')) {
  const step = process.argv[2] ?? 'dryrun';
  try {
    if (step === 'gate') gate();
    else if (step === 'dryrun') dryrun();
    else if (step === 'apply') apply();
    else if (step === 'restore') restore();
    else {
      console.error('apply: use gate|dryrun|apply|restore');
      process.exit(1);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
