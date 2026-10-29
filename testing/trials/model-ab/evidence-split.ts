/**
 * Evidence split (trials only).
 *
 * For every relation whose quote fails endpoint naming, classify *why*:
 *
 *   alias      — the quote names the endpoint by a surface the bank does not
 *                hold (surname, title, partial name)
 *   adjacent   — the endpoint is named in the sentence next to the quote, so
 *                the tie needs two sentences
 *   elsewhere  — both endpoints are in the passage but the model chose a
 *                different quote
 *   absent     — the endpoint is not in the passage at all
 *
 * Reads only; no model calls. usage: node evidence-split.ts <db> [project]
 */
import { Db } from '../../../fanfable/src/db.ts';
import { isUnsupportedKind } from '../../../fanfable/src/lorebook.ts';
import { nameMentionedExact } from '../../../fanfable/src/names.ts';

const dbPath = process.argv[2];
const projectName = process.argv[3] ?? 'ab';
if (!dbPath) {
  console.error('usage: evidence-split.ts <db> [project]');
  process.exit(2);
}

const db = new Db(dbPath);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName);
if (!proj) {
  console.error('no project', projectName);
  process.exit(2);
}

interface Row {
  id: number;
  kind: string;
  evidence: string;
  source_refs: string;
  from_name: string;
  from_aliases: string;
  to_name: string;
  to_aliases: string;
}

const rows = db.all<Row>(
  `SELECT r.id, r.kind, r.evidence, r.source_refs,
          a.name AS from_name, a.aliases AS from_aliases,
          b.name AS to_name, b.aliases AS to_aliases
     FROM canon_relation r
     JOIN canon_entity a ON a.id = r.from_entity
     JOIN canon_entity b ON b.id = r.to_entity
    WHERE r.project_id = ?`,
  proj.id,
);

const chunkText = new Map<number, string>();
for (const c of db.all<{ id: number; text: string }>('SELECT id, text FROM canon_chunk WHERE project_id = ?', proj.id)) {
  chunkText.set(c.id, c.text);
}

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const aliasList = (raw: string): string[] => {
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
};
const named = (name: string, aliases: string[], text: string) =>
  nameMentionedExact(name, text) || aliases.some((a) => nameMentionedExact(a, text));

// Loose presence: any distinctive token of the name (>=4 letters) in the text.
const loose = (name: string, text: string): boolean => {
  const t = new Set(norm(text).split(' '));
  return norm(name)
    .split(' ')
    .filter((w) => w.length >= 4)
    .some((w) => t.has(w));
};

const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+/).filter(Boolean);

const counts = { alias: 0, adjacent: 0, sameSentence: 0, splitAcrossSentences: 0, absent: 0, bothNamed: 0 };
const samples: Record<string, string[]> = { alias: [], adjacent: [], sameSentence: [], splitAcrossSentences: [], absent: [] };

for (const r of rows) {
  const from = aliasList(r.from_aliases);
  const to = aliasList(r.to_aliases);
  const ev = r.evidence ?? '';
  const fromOk = named(r.from_name, from, ev);
  const toOk = named(r.to_name, to, ev);
  if (fromOk && toOk) {
    counts.bothNamed++;
    continue;
  }

  const refs = (() => {
    try {
      const parsed = JSON.parse(r.source_refs || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })() as { chunk?: unknown }[];
  const text = typeof refs[0]?.chunk === 'number' ? chunkText.get(refs[0].chunk as number) ?? '' : '';

  const label = `${r.from_name} — ${r.kind} — ${r.to_name}`;
  const need = (!fromOk ? r.from_name : r.to_name);

  if ((!fromOk && loose(r.from_name, ev)) || (!toOk && loose(r.to_name, ev))) {
    counts.alias++;
    if (samples.alias!.length < 5) samples.alias!.push(label);
    continue;
  }

  // Does the next sentence carry the missing endpoint, together with the tie?
  const parts = sentences(text);
  let adjacent = false;
  for (let i = 0; i < parts.length; i++) {
    const pair = `${parts[i]} ${parts[i + 1] ?? ''}`;
    if (named(r.from_name, from, pair) && named(r.to_name, to, pair) && !isUnsupportedKind(r.kind, pair)) {
      adjacent = true;
      break;
    }
  }
  if (adjacent) {
    counts.adjacent++;
    if (samples.adjacent!.length < 5) samples.adjacent!.push(label);
    continue;
  }

  const inPassage = named(r.from_name, from, text) && named(r.to_name, to, text);
  // Two different structural problems hide behind "both names are in the
  // passage": a sentence names them together (the model quoted the wrong one),
  // or they never share a sentence (the tie cannot be proved by one quote).
  const together = inPassage
    ? sentences(text).some((s) => named(r.from_name, from, s) && named(r.to_name, to, s))
    : false;
  const bucket = together ? 'sameSentence' : inPassage ? 'splitAcrossSentences' : 'absent';
  counts[bucket]++;
  if (samples[bucket]!.length < 5) samples[bucket]!.push(`${label} (need ${need})`);
}

console.log(JSON.stringify({ db: dbPath, rows: rows.length, counts, samples }, null, 0));
db.close();
