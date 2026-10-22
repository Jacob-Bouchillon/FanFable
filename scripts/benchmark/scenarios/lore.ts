/**
 * Lore extraction scenario.
 *
 * The scenario runs the *production* extraction path — the same prompt, the
 * same quote verification, the same neighbour correction, the same entity
 * merging — over a fixed window of passages, and scores the relations it
 * recorded against a hand-written gold set.
 *
 * The window is copied into a scratch project first, so the passage text, the
 * locator and the passage numbers are exactly the ones the corpus has, and so
 * that no two candidates can see each other's output.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Db } from '../../../src/db.ts';
import * as controller from '../../../src/controller.ts';
import * as lorebook from '../../../src/lorebook.ts';
import type { RecordingClient } from '../harness.ts';

export interface GoldRelation {
  from: string;
  to: string;
  kinds: string[];
  direction: 'either' | 'from';
  quote: string | string[];
}

export interface GoldWindow {
  id: string;
  seq: [number, number];
  title: string;
  relations: GoldRelation[];
}

export interface GoldSet {
  note: string;
  windows: GoldWindow[];
}

export function loadGold(): GoldSet {
  const path = resolve(import.meta.dirname, '../../../benchmarks/fixtures/lore-gold.json');
  return JSON.parse(readFileSync(path, 'utf8')) as GoldSet;
}

/* ------------------------------------------------------------- name matching */

const TITLES = /\b(mr|mrs|ms|miss|dr|sir|dame|uncle|aunt|professor|prof|madam|lord|lady)\b/g;

export function normaliseName(name: string): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(TITLES, ' ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does an extracted name refer to the gold entity?
 *
 * Equality is enough for most cases. A single-word name also matches a longer
 * one ("Dudley" for "Dudley Dursley"), but only when that word is not shared
 * with another gold entity — otherwise "Dursley" would match both
 * "Mr. Dursley" and "Dudley Dursley", which is exactly the mistake the alias
 * metric is meant to catch.
 */
export function nameMatches(extracted: string, goldNames: string[], allGoldNames: string[]): boolean {
  const e = normaliseName(extracted);
  if (!e) return false;
  for (const gold of goldNames) {
    const g = normaliseName(gold);
    if (!g) continue;
    if (e === g) return true;
    if (!g.includes(' ')) {
      // A single-word gold name: allowed to match a longer extracted name.
      const shared = allGoldNames.some((other) => {
        const o = normaliseName(other);
        return o !== g && o.includes(' ') && o.split(' ').includes(g);
      });
      if (!shared && e.split(' ').includes(g)) return true;
    }
  }
  return false;
}

/** Does the extracted relation kind say the same thing as the gold kind? */
export function kindMatches(extractedKind: string, goldKinds: string[]): boolean {
  const e = normaliseName(extractedKind);
  if (!e) return false;
  return goldKinds.some((k) => {
    const g = normaliseName(k);
    if (!g) return false;
    return e.includes(g) || g.includes(e);
  });
}

/* --------------------------------------------------------------- the scenario */

export interface ExtractedRelation {
  from: string;
  to: string;
  kind: string;
  description: string;
  evidence: string;
}

export interface LoreWindowResult {
  window: string;
  title: string;
  gold: number;
  matched: number;
  recall: number;
  /** Extracted relations that matched a gold relation. */
  correct: number;
  /** Extracted relations that matched no gold relation. */
  unmatched: number;
  /** The share of extracted relations that matched a gold relation. */
  precision: number;
  /** Relations that matched, but with the subject and object the wrong way round. */
  reversed: number;
  /** Gold relations with a fixed direction that were matched the right way round. */
  directionalChecked: number;
  directionalCorrect: number;
  extracted: number;
  /** Extracted relations whose quote is not in the source at all. */
  fabricatedQuotes: number;
  /** Extracted relations with no quote at all. */
  unbacked: number;
  /** Extracted relations whose quote is verbatim in the source. */
  quoted: number;
  /** Relations that repeat an earlier one: the same pair, the same kind. */
  duplicates: number;
  /** The same pair, two different kinds: a contradiction or a confusion. */
  conflicting: number;
  /** Extracted relations whose names are one of the accepted names of a gold entity. */
  nameAccuracy: number;
  /** The same, but using the canonical (first) name of the gold entity. */
  canonicalNameRate: number;
  entities: number;
  ms: number;
  /** The gold relations this window did not get. */
  missed: string;
}

/**
 * Copy a window of the corpus into a scratch project.
 */
function copyWindow(
  db: Db,
  sourceProjectId: number,
  seqStart: number,
  seqEnd: number,
  projectName: string,
): { projectId: number; text: string } {
  const source = db.get<{ id: number; path: string; title: string; author: string; format: string; sha256: string; byte_size: number; page_count: number }>(
    'SELECT id, path, title, author, format, sha256, byte_size, page_count FROM canon_source WHERE project_id = ? LIMIT 1',
    sourceProjectId,
  )!;
  const chunks = db.all<{ id: number; seq: number; locator: string; heading: string; text: string; char_start: number; char_end: number; words: number; page_start: number; page_end: number }>(
    'SELECT id, seq, locator, heading, text, char_start, char_end, words, page_start, page_end FROM canon_chunk WHERE project_id = ? AND seq BETWEEN ? AND ? ORDER BY seq',
    sourceProjectId,
    seqStart,
    seqEnd,
  );

  const project = controller.getProjectByName(db, projectName) ?? controller.createProject(db, projectName);
  // A scratch project is rebuilt from scratch each time.
  db.run('DELETE FROM canon_relation WHERE project_id = ?', project.id);
  db.run('DELETE FROM canon_fact WHERE project_id = ?', project.id);
  db.run('DELETE FROM canon_timeline WHERE project_id = ?', project.id);
  db.run('DELETE FROM canon_entity WHERE project_id = ?', project.id);
  db.run('DELETE FROM canon_chunk WHERE project_id = ?', project.id);
  db.run('DELETE FROM canon_source WHERE project_id = ?', project.id);

  const res = db.run(
    `INSERT INTO canon_source (project_id, path, title, author, format, sha256, byte_size, page_count, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    project.id,
    `${source.path}#${seqStart}-${seqEnd}`,
    source.title,
    source.author,
    source.format,
    source.sha256,
    source.byte_size,
    source.page_count,
  );
  const sourceId = res.lastInsertRowid;
  for (const c of chunks) {
    db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, char_start, char_end, words, page_start, page_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sourceId,
      project.id,
      c.seq,
      c.locator,
      c.heading,
      c.text,
      c.char_start,
      c.char_end,
      c.words,
      c.page_start,
      c.page_end,
    );
  }
  return { projectId: project.id, text: chunks.map((c) => c.text).join('\n') };
}

/** Read back the relations the extraction recorded. */
export function readRelations(db: Db, projectId: number): ExtractedRelation[] {
  return db
    .all<{ from_name: string; to_name: string; kind: string; description: string; evidence: string }>(
      `SELECT fe.name AS from_name, te.name AS to_name, r.kind, r.description, r.evidence
       FROM canon_relation r
       JOIN canon_entity fe ON fe.id = r.from_entity
       JOIN canon_entity te ON te.id = r.to_entity
       WHERE r.project_id = ?
       ORDER BY r.id`,
      projectId,
    )
    .map((r) => ({
      from: r.from_name,
      to: r.to_name,
      kind: r.kind,
      description: r.description,
      evidence: r.evidence,
    }));
}

/**
 * Run one window through the extraction path and score it.
 */
export async function runLoreWindow(
  db: Db,
  client: RecordingClient,
  sourceProjectId: number,
  gold: GoldWindow,
  modelKey: string,
  maxTokens = 3000,
): Promise<{ result: LoreWindowResult; relations: ExtractedRelation[] }> {
  const projectName = `lore-${gold.id}-${modelKey}`.replace(/[^a-zA-Z0-9-]/g, '-');
  const { projectId, text } = copyWindow(db, sourceProjectId, gold.seq[0], gold.seq[1], projectName);

  const started = Date.now();
  await lorebook.extractLore(db, client, projectId, { concurrency: 1, incremental: false, maxTokens });
  const ms = Date.now() - started;

  const relations = readRelations(db, projectId);
  const entities = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', projectId)?.n ?? 0;

  // A quote counts as verbatim when it appears in the window, ignoring the
  // whitespace the PDF importer leaves behind.
  const flat = text.replace(/\s+/g, ' ');
  const allGoldNames = gold.relations.flatMap((r) => [...r.from.split('|'), ...r.to.split('|')]);

  let matched = 0;
  let reversed = 0;
  let directionalChecked = 0;
  let directionalCorrect = 0;
  const usedGold = new Set<number>();

  for (const rel of relations) {
    for (let i = 0; i < gold.relations.length; i++) {
      if (usedGold.has(i)) continue;
      const g = gold.relations[i];
      const forward =
        nameMatches(rel.from, g.from.split('|'), allGoldNames) &&
        nameMatches(rel.to, g.to.split('|'), allGoldNames);
      const backward =
        nameMatches(rel.from, g.to.split('|'), allGoldNames) &&
        nameMatches(rel.to, g.from.split('|'), allGoldNames);
      if (!forward && !backward) continue;
      if (!kindMatches(rel.kind, g.kinds)) continue;
      usedGold.add(i);
      matched++;
      if (g.direction === 'from') {
        directionalChecked++;
        if (forward) directionalCorrect++;
        else reversed++;
      }
      break;
    }
  }

  let fabricated = 0;
  let unbacked = 0;
  let quoted = 0;
  for (const rel of relations) {
    const ev = (rel.evidence ?? '').trim();
    if (!ev) {
      unbacked++;
      continue;
    }
    if (flat.includes(ev.replace(/\s+/g, ' '))) quoted++;
    else fabricated++;
  }

  const seen = new Set<string>();
  let duplicates = 0;
  const pairs = new Map<string, Set<string>>();
  for (const rel of relations) {
    const key = `${rel.from}|${rel.to}|${rel.kind.toLowerCase()}`;
    if (seen.has(key)) duplicates++;
    seen.add(key);
    const pair = `${rel.from}|${rel.to}`;
    if (!pairs.has(pair)) pairs.set(pair, new Set());
    pairs.get(pair)!.add(rel.kind.toLowerCase());
  }
  let conflicting = 0;
  for (const kinds of pairs.values()) if (kinds.size > 1) conflicting++;

  // Name agreement: do the extracted names use the accepted names of a gold
  // entity, and the canonical one rather than an alias?
  let nameHits = 0;
  let canonicalHits = 0;
  let nameTotal = 0;
  for (const rel of relations) {
    for (const side of [rel.from, rel.to]) {
      nameTotal++;
      const goldSide = gold.relations.find(
        (g) =>
          nameMatches(side, g.from.split('|'), allGoldNames) ||
          nameMatches(side, g.to.split('|'), allGoldNames),
      );
      if (!goldSide) continue;
      const names = [
        ...goldSide.from.split('|'),
        ...goldSide.to.split('|'),
      ];
      const accepted = names.some((n) => normaliseName(side) === normaliseName(n));
      if (accepted) nameHits++;
      const canonical = normaliseName(side) === normaliseName(names[0]);
      if (canonical) canonicalHits++;
    }
  }

  return {
    result: {
      window: gold.id,
      title: gold.title,
      gold: gold.relations.length,
      matched,
      recall: gold.relations.length ? matched / gold.relations.length : 0,
      correct: matched,
      unmatched: Math.max(0, relations.length - matched),
      precision: relations.length ? matched / relations.length : 0,
      reversed,
      directionalChecked,
      directionalCorrect,
      extracted: relations.length,
      fabricatedQuotes: fabricated,
      unbacked,
      quoted,
      duplicates,
      conflicting,
      nameAccuracy: nameTotal ? nameHits / nameTotal : 0,
      canonicalNameRate: nameTotal ? canonicalHits / nameTotal : 0,
      entities,
      ms,
      missed: gold.relations
        .filter((_, i) => !usedGold.has(i))
        .map((g) => `${g.from.split('|')[0]} -${g.kinds[0]}-> ${g.to.split('|')[0]}`)
        .join('; '),
    },
    relations,
  };
}

/**
 * Check that the gold set itself is sound: every quote must appear in the
 * window it belongs to. A gold set with a wrong quote would silently
 * penalise every model, so this runs before the benchmark does.
 */
export function verifyGold(db: Db, sourceProjectId: number, gold: GoldSet): string[] {
  const problems: string[] = [];
  for (const w of gold.windows) {
    const text = db
      .all<{ text: string }>(
        'SELECT text FROM canon_chunk WHERE project_id = ? AND seq BETWEEN ? AND ? ORDER BY seq',
        sourceProjectId,
        w.seq[0],
        w.seq[1],
      )
      .map((r) => r.text)
      .join(' ');
    for (const rel of w.relations) {
      const quotes = Array.isArray(rel.quote) ? rel.quote : [rel.quote];
      if (!quotes.some((q) => text.includes(q))) {
        problems.push(`${w.id}: quote not found in the window: ${JSON.stringify(quotes[0])}`);
      }
    }
  }
  return problems;
}
