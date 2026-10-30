/**
 * Watch a walk's live log. Read-only, safe to run mid-walk.
 *
 * Usage:
 *   node --no-warnings testing/trials/chain/watch-log.ts <run-prefix> [limit]
 */
import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';

const [prefix, limitRaw] = process.argv.slice(2);
if (!prefix) throw new Error('usage: watch-log.ts <run-prefix> [limit]');
const limit = Math.max(1, Math.min(Number(limitRaw ?? 8) || 8, 30));
const db = new Db('/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db');
try {
  const run = db.get<{ run: string }>(
    'SELECT run FROM chain_log WHERE run LIKE ? ORDER BY id DESC LIMIT 1',
    `${prefix}%`,
  );
  if (!run) {
    console.log('no log lines yet for ' + prefix);
  } else {
    const counts = db.all<{ kind: string; n: number }>(
      'SELECT kind, COUNT(*) AS n FROM chain_log WHERE run = ? GROUP BY kind ORDER BY n DESC',
      run.run,
    );
    console.log('run: ' + run.run);
    console.log('counts: ' + counts.map((c) => `${c.kind} ${c.n}`).join(' · '));
    const last = db.all<{ kind: string; msg: string }>(
      'SELECT kind, msg FROM chain_log WHERE run = ? ORDER BY id DESC LIMIT ?',
      run.run,
      limit,
    );
    last.reverse().forEach((r) => console.log(`[${r.kind}] ${r.msg.slice(0, 140)}`));
  }
} finally {
  db.close();
}
