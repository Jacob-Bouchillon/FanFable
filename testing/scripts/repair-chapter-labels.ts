/**
 * Re-label passages whose stored chapter heading disagrees with their own text.
 *
 *   node --no-warnings testing/scripts/repair-chapter-labels.ts --db <path> [--write]
 *
 * Two chunker defects put 40 passages under the wrong chapter in the hp1 bank:
 *
 *  - a line break before "the book had screamed" matched the chapter pattern
 *    ("book" + any word) and created a section that does not exist, which
 *    swallowed eleven passages of chapter twelve;
 *  - a chapter heading that opened a PDF page sat behind a form feed, so the
 *    heading's character offset fell outside its own block and the passage kept
 *    the previous chapter's label (chapter seven, labelled chapter six).
 *
 * Both are fixed in `findHeadings` / `chunkText`. This repairs the rows that
 * were written before the fix. The label is derived from the passage text and
 * the heading of the nearest earlier passage, so nothing is hard-coded: a
 * passage is corrected only when its text states its chapter and that chapter
 * differs from the stored one.
 *
 * Dry run by default. Nothing else is touched: no text, no mining flags, no
 * embeddings.
 */
import { DatabaseSync } from 'node:sqlite';
import { findHeadings } from '../../fanfable/src/core/text.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const dbPath = flag('db');
const write = args.includes('--write');
if (!dbPath) {
  console.error('usage: repair-chapter-labels.ts --db <path> [--write]');
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: !write });
const rows = db.prepare('SELECT id, seq, heading, text FROM canon_chunk ORDER BY seq').all() as Array<{
  id: number;
  seq: number;
  heading: string;
  text: string;
}>;

/** The chapter heading this passage states in its own opening, if any. */
const statedHeading = (text: string): string | null => {
  for (const heading of findHeadings(text)) {
    if (heading.start > 40) break;
    if (/^(chapter|book|part|section|act)\b/i.test(heading.heading)) return heading.heading;
  }
  return null;
};

const fixes: Array<{ id: number; seq: number; from: string; to: string }> = [];
let current = '';
for (const row of rows) {
  const stated = statedHeading(row.text);
  if (stated) current = stated;
  if (!current) continue;
  if ((row.heading || '').trim() === current) continue;
  fixes.push({ id: row.id, seq: row.seq, from: row.heading, to: current });
}

for (const fix of fixes) {
  console.log(`seq ${String(fix.seq).padStart(3)}  ${JSON.stringify(fix.from || '(empty)')} -> ${JSON.stringify(fix.to)}`);
}
console.log(`\n${fixes.length} passage(s) ${write ? 'corrected' : 'would be corrected'}${write ? '' : ' (dry run)'}`);

if (write && fixes.length) {
  const update = db.prepare('UPDATE canon_chunk SET heading = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const fix of fixes) update.run(fix.to, fix.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const after = db.prepare(
    `SELECT count(*) c FROM canon_chunk WHERE heading IS NULL OR trim(heading) = ''`,
  ).get() as { c: number };
  console.log(`written; passages with no heading now: ${after.c}`);
}
db.close();
