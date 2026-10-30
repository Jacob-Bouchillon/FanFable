/**
 * Name sweep: propose ties from a character's mentions into the review queue.
 *
 * Ported from the trial sweep. The model answers with line numbers, never
 * retyped quotes; the sentence is fetched by index, so every quote is verbatim
 * by construction. A proposal is a `canon_tie_note` row — never a relation and
 * never a promotion.
 */
import { Db, fromJson, nowIso } from './db.ts';
import * as lorebook from './lorebook.ts';
import type { LlmClient } from './llm.ts';
import { nameRelation } from './names.ts';

const norm = (text: string): string =>
  (text ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

interface LedgerLine {
  locator: string;
  source: string;
  chunk: number;
  sentence: string;
}

interface Tie {
  to: string;
  kind: string;
  line: number;
  quote: string;
}

interface Note {
  name: string;
  says: string;
  line: number;
  quote: string;
}

interface RawTie {
  to: string;
  kind: string;
  line: number;
}

interface RawNote {
  name: string;
  says: string;
  line: number;
}

interface ChunkRow {
  id: number;
  locator: string;
  source: string;
  text: string;
}

interface CharacterRow {
  id: number;
  name: string;
  aliases: string;
  mentions: number;
}

export interface SweepOptions {
  batchSize?: number;
  /** Only sweep characters whose stored name contains this substring. */
  name?: string;
  /** Maximum characters to sweep (all by default). */
  limit?: number;
  onProgress?: (message: string) => void;
}

export interface SweepCharacterResult {
  id: number;
  name: string;
  mentions: number;
  batches: number;
  ties: number;
  notes: number;
  proposals: number;
  skippedKeeper: number;
  skippedPending: number;
  unresolvedTargets: string[];
}

export interface SweepResult {
  characters: SweepCharacterResult[];
  proposals: number;
  distinctPairs: number;
  skippedKeeper: number;
  skippedPending: number;
  unresolvedTargets: string[];
  queueBefore: number;
  queueAfter: number;
}

const BATCH_SYSTEM =
  'You track one character in a novel. Each sentence is numbered. ' +
  'Reply with JSON only: {"notes":[{"name":"other person","says":"what is said about them","line":12}],' +
  '"ties":[{"to":"name","kind":"short phrase","line":12}]}. ' +
  'Use the line number of the sentence that says it; never retype the sentence.';

const DERIVE_SYSTEM = 'Reply with JSON only: {"ties":[{"to":"name","kind":"short phrase","line":12}]}.';

/** One batch: sentences are numbered; the model returns line numbers only. */
async function askBatch(
  llm: LlmClient,
  name: string,
  ledger: LedgerLine[],
  known: Tie[],
  from: number,
  to: number,
  prior: Note[],
): Promise<{ ties: RawTie[]; notes: RawNote[] }> {
  const batch = ledger
    .slice(from, to)
    .map((line, offset) => `#${from + offset} ${line.sentence}`)
    .join('\n');
  const knownLines = known.map((tie) => `- ${tie.to} (${tie.kind}) — ${tie.quote}`).join('\n') || '(none yet)';
  const priorLines = prior.map((note) => `- ${note.name}: ${note.says} — ${note.quote}`).join('\n') || '(none)';
  const res = await llm.chat({
    system: BATCH_SYSTEM,
    messages: [
      {
        role: 'user',
        content:
          `Character: ${name}\n` +
          `Known ties so far:\n${knownLines}\n\n` +
          `Notes from other characters:\n${priorLines}\n\n` +
          `Sentences mentioning ${name}:\n${batch}\n\n` +
          'List every other named person here with what is said about them (notes), and every lasting ' +
          'relationship this character has with another named person (ties). Family, marriage, lasting ' +
          'roles, lasting friendship or enmity only. Give the line number for each.',
      },
    ],
    temperature: 0.1,
    maxTokens: 1200,
  });
  const raw = res.text ?? '';
  try {
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
      ties?: { to?: unknown; kind?: unknown; line?: unknown }[];
      notes?: { name?: unknown; says?: unknown; line?: unknown }[];
    };
    const asLine = (value: unknown): number => {
      const n = Number(String(value ?? '').replace(/[^0-9]/g, ''));
      return Number.isFinite(n) ? n : -1;
    };
    return {
      ties: (parsed.ties ?? [])
        .map((tie) => ({ to: String(tie.to ?? '').trim(), kind: String(tie.kind ?? '').trim(), line: asLine(tie.line) }))
        .filter((tie) => tie.to && tie.line >= 0 && tie.line < ledger.length),
      notes: (parsed.notes ?? [])
        .map((note) => ({ name: String(note.name ?? '').trim(), says: String(note.says ?? '').trim(), line: asLine(note.line) }))
        .filter((note) => note.name && note.line >= 0 && note.line < ledger.length),
    };
  } catch {
    return { ties: [], notes: [] };
  }
}

/** One final call over the accumulated notes, as the trial sweep does. */
async function deriveTies(llm: LlmClient, name: string, notes: Note[]): Promise<RawTie[]> {
  const body = notes.map((note) => `#${note.line} ${note.name}: ${note.says}`).join('\n');
  const res = await llm.chat({
    system: DERIVE_SYSTEM,
    messages: [
      {
        role: 'user',
        content:
          `Notes about ${name}, gathered from every mention of them:\n${body}\n\n` +
          `Which other named people does ${name} have a lasting relationship with? One entry per relationship, ` +
          'with the line number of the note that shows it. Ignore one-off meetings.',
      },
    ],
    temperature: 0.1,
    maxTokens: 1000,
  });
  const raw = res.text ?? '';
  try {
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
      ties?: { to?: unknown; kind?: unknown; line?: unknown }[];
    };
    return (parsed.ties ?? [])
      .map((tie) => ({ to: String(tie.to ?? '').trim(), kind: String(tie.kind ?? '').trim(), line: Number(tie.line) }))
      .filter((tie) => tie.to && Number.isFinite(tie.line));
  } catch {
    return [];
  }
}

/**
 * Sweep the project's non-quarantined characters and propose derived ties.
 *
 * Every proposal is a pending `canon_tie_note` (`reason = 'sweep-proposal'`).
 * A pair that already holds a keeper, or already has a pending note for the
 * same pair and kind, is skipped; nothing is overwritten and `canon_relation`
 * is never written.
 */
export async function runNameSweep(
  db: Db,
  llm: LlmClient,
  projectId: number,
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? 60));
  const characters = (
    opts.name
      ? db.all<CharacterRow>(
          `SELECT id, name, aliases, mentions FROM canon_entity
            WHERE project_id = ? AND kind = 'character' AND review_status != 'quarantined' AND name LIKE ?
            ORDER BY mentions DESC, id`,
          projectId,
          `%${opts.name}%`,
        )
      : db.all<CharacterRow>(
          `SELECT id, name, aliases, mentions FROM canon_entity
            WHERE project_id = ? AND kind = 'character' AND review_status != 'quarantined'
            ORDER BY mentions DESC, id`,
          projectId,
        )
  ).slice(0, opts.limit === undefined ? undefined : Math.max(0, Math.floor(opts.limit)));

  const chunks = db.all<ChunkRow>(
    `SELECT c.id, c.locator, s.title AS source, c.text
       FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id
      WHERE c.project_id = ? ORDER BY c.seq, c.id`,
    projectId,
  );
  const wholeText = norm(chunks.map((chunk) => chunk.text).join(' \n '));

  // Target names the model reports resolve to roster rows by name or alias; a
  // unique same-person match is accepted, an ambiguous one is not guessed.
  const entities = lorebook.listEntities(db, projectId);
  const byCanonical = new Map<string, (typeof entities)[number]>();
  for (const entity of entities) {
    for (const key of [entity.name, ...entity.aliases]) {
      const canonical = norm(key);
      if (!canonical) continue;
      const previous = byCanonical.get(canonical);
      if (!previous || entity.mentions > previous.mentions) byCanonical.set(canonical, entity);
    }
  }
  const resolveTarget = (name: string): (typeof entities)[number] | undefined => {
    const canonical = norm(name);
    const exact = byCanonical.get(canonical);
    if (exact) return exact;
    const related = entities.filter((entity) => nameRelation(name, entity.name) !== null);
    return related.length === 1 ? related[0] : undefined;
  };

  const queueCount = (): number =>
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_tie_note WHERE project_id = ?', projectId)?.n ?? 0;
  const queueBefore = queueCount();

  const runNotes: Note[] = [];
  const results: SweepCharacterResult[] = [];
  const writtenPairs = new Set<string>();
  let proposals = 0;
  let skippedKeeper = 0;
  let skippedPending = 0;
  const unresolvedTargets: string[] = [];

  for (const character of characters) {
    const variants = [character.name, ...fromJson<string[]>(character.aliases, [])];
    const forms = [
      ...new Set(
        variants
          .flatMap((variant) => [variant, ...variant.split(/\s+/)])
          .map((form) => form.trim())
          .filter((form) => form.length >= 3 && /^[A-Z]/.test(form)),
      ),
    ];
    if (!forms.length) continue;
    const formRe = new RegExp(`\\b(${forms.map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`);
    const ledger: LedgerLine[] = [];
    for (const chunk of chunks) {
      for (const sentence of chunk.text.split(/(?<=[.!?])\s+/)) {
        if (formRe.test(sentence)) {
          ledger.push({ locator: chunk.locator, source: chunk.source, chunk: chunk.id, sentence: sentence.trim() });
        }
      }
    }
    if (!ledger.length) continue;

    const prior = runNotes.filter((note) => formRe.test(note.name));
    let known: Tie[] = [];
    let notes: Note[] = [];
    let batches = 0;
    for (let i = 0; i < ledger.length; i += batchSize) {
      opts.onProgress?.(`${character.name}: lines ${i + 1}-${Math.min(i + batchSize, ledger.length)} of ${ledger.length}`);
      const out = await askBatch(llm, character.name, ledger, known, i, Math.min(i + batchSize, ledger.length), prior);
      known = out.ties.map((tie) => ({ ...tie, quote: ledger[tie.line]!.sentence }));
      notes = [...notes, ...out.notes.map((note) => ({ ...note, quote: ledger[note.line]!.sentence }))];
      batches++;
    }

    notes = notes.filter((note) => wholeText.includes(norm(note.quote)));
    let ties: Tie[] = known.filter((tie) => wholeText.includes(norm(tie.quote)));
    if (notes.length) {
      const derived = await deriveTies(llm, character.name, notes);
      const fromNotes = derived
        .filter((tie) => tie.line >= 0 && tie.line < ledger.length)
        .map((tie) => ({ to: tie.to, kind: tie.kind, line: tie.line, quote: ledger[tie.line]!.sentence }));
      const merged = new Map<string, Tie>();
      for (const tie of [...ties, ...fromNotes]) {
        const key = `${norm(tie.to)}|${norm(tie.kind)}`;
        const previous = merged.get(key);
        if (!previous || tie.quote.length > previous.quote.length) merged.set(key, tie);
      }
      ties = [...merged.values()];
    }

    const characterResult: SweepCharacterResult = {
      id: character.id,
      name: character.name,
      mentions: ledger.length,
      batches,
      ties: ties.length,
      notes: notes.length,
      proposals: 0,
      skippedKeeper: 0,
      skippedPending: 0,
      unresolvedTargets: [],
    };
    for (const tie of ties) {
      const target = resolveTarget(tie.to);
      if (!target) {
        characterResult.unresolvedTargets.push(`${character.name} -> ${tie.to}`);
        unresolvedTargets.push(`${character.name} -> ${tie.to}`);
        continue;
      }
      if (target.id === character.id) continue;
      const keeper = db.get<{ id: number }>(
        `SELECT id FROM canon_relation
          WHERE project_id = ?
            AND ((from_entity = ? AND to_entity = ?) OR (from_entity = ? AND to_entity = ?))
            AND review_status IN ('accepted','user_confirmed')
          LIMIT 1`,
        projectId,
        character.id,
        target.id,
        target.id,
        character.id,
      );
      if (keeper) {
        characterResult.skippedKeeper++;
        skippedKeeper++;
        continue;
      }
      const pending = db.get<{ id: number }>(
        `SELECT id FROM canon_tie_note
          WHERE project_id = ? AND attempted_kind = ? AND status = 'pending'
            AND ((from_entity = ? AND to_entity = ?) OR (from_entity = ? AND to_entity = ?))
          LIMIT 1`,
        projectId,
        tie.kind,
        character.id,
        target.id,
        target.id,
        character.id,
      );
      if (pending) {
        characterResult.skippedPending++;
        skippedPending++;
        continue;
      }
      const line = ledger[tie.line] ?? ledger.find((entry) => entry.sentence === tie.quote);
      const sourceRefs = line
        ? JSON.stringify([{ source: line.source, locator: line.locator, chunk: line.chunk }])
        : '[]';
      db.run(
        `INSERT INTO canon_tie_note
           (project_id, from_entity, to_entity, attempted_kind, reason, evidence, source_refs,
            status, ruling, ruled_at, created_at)
         VALUES (?, ?, ?, ?, 'sweep-proposal', ?, ?, 'pending', '', '', ?)`,
        projectId,
        character.id,
        target.id,
        tie.kind,
        tie.quote,
        sourceRefs,
        nowIso(),
      );
      characterResult.proposals++;
      proposals++;
      writtenPairs.add([character.id, target.id].sort((a, b) => a - b).join('|'));
    }
    runNotes.push(...notes);
    results.push(characterResult);
    opts.onProgress?.(
      `${character.name}: ${ledger.length} mentions, ${ties.length} ties, ${characterResult.proposals} proposals`,
    );
  }

  return {
    characters: results,
    proposals,
    distinctPairs: writtenPairs.size,
    skippedKeeper,
    skippedPending,
    unresolvedTargets,
    queueBefore,
    queueAfter: queueCount(),
  };
}
