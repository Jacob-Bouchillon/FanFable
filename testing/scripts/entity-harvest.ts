/**
 * Name harvest runner.
 *
 * Dry-run by default. With --model it classifies candidates; with --write it
 * inserts accepted entities through lorebook.insertEntityCandidate.
 */
import { Db, fromJson } from '../../fanfable/src/core/db.ts';
import { STOPWORDS } from '../../fanfable/src/core/vocab.ts';
import {
  harvestKind,
  parseHarvestAnswer,
  planNameHarvest,
  possessiveCreatureOwner,
  validateHarvestClassification,
  type HarvestCandidate,
} from '../../fanfable/src/identity/name-harvest.ts';
import { surfaceFacts } from '../../fanfable/src/identity/cleanup.ts';
import { candidateCategoryGuidance } from '../../fanfable/src/identity/candidate-categories.ts';
import { insertEntityCandidate, insertOwnedCreatureRelation } from '../../fanfable/src/lorebook.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';

const SYSTEM_PROMPT = `You classify names found in a book. For each CANDIDATE, decide whether it is an entity
and which kind, using only the SENTENCES. If it is not a named entity in these sentences, answer "none".
Do not use outside knowledge. For each entity give: surface, kind, name (the proper name as the
book gives it), quote (a verbatim sentence that names it), chunk_index, sentient, speaks, and a
reason. Reply JSON only: {"entities":[...]}.

Entity kinds:
- character — a being with a social role: holds an office or job, belongs to a group, has kinship
  or allegiance acknowledged by others, and acts among the other characters. Species is irrelevant:
  human, goblin, house-elf, ent, wookiee, droid.
- creature — an individual non-human being, named or possessed, that lives outside the story's
  social order. It may speak, reason, plan or use magic; that does not make it a character.
  A giant spider that talks, a hippogriff, an owl, a three-headed dog, a dragon.
- species — a kind or breed, never an individual: owls, goblins, dragons, wookiees.
- location — a place, region, world or building used as a setting.
- item — a named object, weapon, ship, artefact or substance.
- organization — an organisation, order, house, company or team; use faction.
- rule — a law, magic or system rule, custom or prophecy.
The deciding fact for character vs creature is social membership, not intelligence, speech or
biology. Say it in the reason: "holds no office or allegiance" or "member of the group".

For every entity set "sentient" and "speaks" to true, false, or null. Null means the sentences do
not say; never guess from species. A beast may be sentient and speak and still be a creature.

Before choosing an entity kind, decide whether the CANDIDATE is one of these categories. The
definition decides; the examples are illustration only, never a list to match.
${candidateCategoryGuidance()}
If the candidate is a category, set "category" to its id. For animal and collective also give the
resulting kind. For role, discipline, unit, calendar and honorific set "kind":"none". If a surface
could be either a name or a common noun, set "category":"ambiguous" and still give the best entity
kind. Never guess away a real name.

Funnels:
- A family group is not a person: a household or team named together is a collective, not a character.
- A role is a position, not an entity.
- A school subject is a discipline, not an item.
- A generic common noun is an animal or a collective, never a character or creature; a proper name
  or a possessive makes an individual.
- A possessive animal names an individual: the whole possessive phrase is the creature's surface.`;

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'professor', 'uncle', 'aunt', 'lord', 'madam', 'dr']);

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numberFlag(name: string, fallback: number): number {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function normalizeName(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function surfaceKeyOf(value: string): string {
  return normalizeName(value).replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

function mentions(text: string, form: string): boolean {
  const value = String(form ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(text);
}

function distinctiveTokens(value: string): string[] {
  return (String(value ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((token) => token.length > 2 && !STOPWORDS.has(token) && !HONORIFICS.has(token));
}

function bankIndex(db: Db, projectId: number): {
  isBanked: (name: string) => boolean;
  isFamilyGroup: (name: string) => boolean;
  add: (name: string) => void;
} {
  const names = new Set<string>();
  const tokens = new Set<string>();
  const characterTokens = new Set<string>();
  const add = (value: string): void => {
    const key = normalizeName(value);
    if (!key) return;
    names.add(key);
    for (const token of distinctiveTokens(value)) tokens.add(token);
  };
  const addCharacter = (value: string): void => {
    for (const token of distinctiveTokens(value)) characterTokens.add(token);
  };
  const rows = db.all<{ name: string; aliases: string; kind: string }>(
    'SELECT name, aliases, kind FROM canon_entity WHERE project_id = ?',
    projectId,
  );
  for (const row of rows) {
    const values = [row.name, ...fromJson<string[]>(row.aliases, [])];
    for (const value of values) add(value);
    if (row.kind === 'character') {
      for (const value of values) addCharacter(value);
    }
  }
  const isBanked = (value: string): boolean => {
    if (names.has(normalizeName(value))) return true;
    const values = distinctiveTokens(value);
    return values.length > 0 && values.every((token) => tokens.has(token));
  };
  // "Potters" is the household, not Harry Potter: a bare plural of a banked
  // person's surname is a group.
  const isFamilyGroup = (value: string): boolean => {
    const lower = normalizeName(value);
    if (!lower || lower.includes(' ') || !/s$/.test(lower)) return false;
    return characterTokens.has(lower.slice(0, -1)) && !names.has(lower);
  };
  return { isBanked, isFamilyGroup, add };
}

/** Resolve "Malfoy" to the banked person, preferring the full name (Draco Malfoy). */
function resolveOwnerEntity(
  db: Db,
  projectId: number,
  owner: string,
): { id: number; name: string } | null {
  const needle = normalizeName(owner);
  const rows = db.all<{ id: number; name: string }>(
    `SELECT id, name FROM canon_entity
      WHERE project_id = ? AND kind = 'character'
        AND (lower(name) = ? OR lower(name) LIKE ? OR lower(aliases) LIKE ?)`,
    projectId,
    needle,
    `% ${needle}`,
    `%${needle}%`,
  );
  const tokens = (name: string): number => name.trim().split(/\s+/).filter(Boolean).length;
  const full = rows
    .filter((row) => tokens(row.name) > 1 && normalizeName(row.name).endsWith(needle))
    .sort((left, right) => tokens(right.name) - tokens(left.name) || left.id - right.id);
  return full[0] ?? rows.find((row) => normalizeName(row.name) === needle) ?? rows[0] ?? null;
}

function promptForBatch(batch: HarvestCandidate[], contexts: Array<{ sentence: { chunkId: number; locator: string; text: string } }>): string {
  const lines = ['CANDIDATES:'];
  for (const [index, candidate] of batch.entries()) {
    lines.push(`CANDIDATE ${index + 1}: ${candidate.surface}`);
    lines.push('SENTENCES:');
    for (const sentence of candidate.sentences) {
      const flat = contexts.findIndex((ctx) => ctx.sentence === sentence);
      lines.push(`[${flat}] chunk ${sentence.chunkId} | ${sentence.locator}`);
      lines.push(sentence.text);
    }
  }
  lines.push('chunk_index is the [n] number shown before the cited sentence.');
  lines.push(`Schema: {"entities":[{"surface":"...","kind":"...","name":"...","quote":"...","chunk_index":0,"reason":"..."}]} (maxItems: ${batch.length})`);
  return lines.join('\n');
}

const dbPath = flag('db') ?? process.argv[2];
const projectName = flag('project') ?? process.argv[3] ?? 'hp1';
const limit = Math.max(1, Math.floor(numberFlag('limit', 200)));
const minCount = Math.max(1, Math.floor(numberFlag('min-count', 1)));
const batchSize = Math.max(1, Math.floor(numberFlag('batch', 12)));
const model = flag('model');
const write = process.argv.includes('--write');
if (!dbPath) {
  console.error('usage: node --no-warnings testing/scripts/entity-harvest.ts --db <path> --project <name> [--limit 200] [--batch 12] [--model <model>] [--write]');
  process.exit(2);
}

const db = new Db(dbPath);
try {
  const project = controller.getProjectByName(db, projectName);
  if (!project) {
    console.error(`no project named "${projectName}" in ${dbPath}`);
    db.close();
    process.exit(1);
  }

  const candidates = planNameHarvest(db, project.id, { limit, minCount });
  const bank = bankIndex(db, project.id);
  const facts = surfaceFacts(db, project.id);
  const client = model
    ? controller.createClient({ ...project.settings, model } as never)
    : null;
  const retryClient = model
    ? controller.createClient({ ...project.settings, model, seed: 43 } as never)
    : null;

  const accepted: Array<{
    surface: string;
    name: string;
    kind: string;
    chunkId: number;
    locator: string;
    quote: string;
    attributes?: { sentient: boolean | null; speaks: boolean | null };
    owner?: string;
    ownerEntity?: { id: number; name: string } | null;
    reason?: string;
  }> = [];
  const rejected: Array<{
    surface: string;
    name: string;
    kind: string;
    reason: string;
    category?: string;
    note?: string;
  }> = [];
  let recoveredQuotes = 0;
  const modelCounts: Record<string, number> = {
    character: 0, location: 0, item: 0, creature: 0, faction: 0, species: 0, rule: 0, none: 0, invalid: 0,
  };
  const errors: string[] = [];
  const batchReports: Array<{
    batch: number;
    candidates: string[];
    modelText?: string;
    accepted: number;
    rejected: number;
    none: number;
  }> = [];

  if (!client) {
    console.log(JSON.stringify({
      project: { id: project.id, name: project.name },
      model: null,
      write,
      limit,
      minCount,
      candidateCount: candidates.length,
      candidates,
    }, null, 2));
  } else {
    const chunkTexts = new Map<number, string>();
    const chunkText = (chunkId: number): string => {
      let text = chunkTexts.get(chunkId);
      if (text === undefined) {
        text = String(db.get<{ text: string }>(
          'SELECT text FROM canon_chunk WHERE id = ? AND project_id = ?',
          chunkId,
          project.id,
        )?.text ?? '');
        chunkTexts.set(chunkId, text);
      }
      return text;
    };

    for (let batchIndex = 0; batchIndex * batchSize < candidates.length; batchIndex++) {
      const batch = candidates.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
      const contexts = batch.flatMap((candidate) =>
        candidate.sentences.map((sentence) => ({ candidate, sentence, chunkText: chunkText(sentence.chunkId) })));
      const prompt = promptForBatch(batch, contexts);
      let modelText: string | null = null;
      for (const attempt of [client, retryClient]) {
        if (!attempt) continue;
        try {
          const response = await attempt.chat({
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            maxTokens: 4000,
            format: 'json',
          });
          modelText = response.text;
          break;
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      const batchAccepted = accepted.length;
      const batchRejected = rejected.length;
      let none = 0;
      const seen = new Set<string>();
      if (modelText !== null) {
        for (const entity of parseHarvestAnswer(modelText)) {
          const surfaceKey = surfaceKeyOf(entity.surface);
          const candidate = batch.find((entry) => surfaceKeyOf(entry.surface) === surfaceKey);
          if (!candidate) {
            modelCounts.invalid++;
            continue;
          }
          if (seen.has(surfaceKey)) continue;
          seen.add(surfaceKey);
          if (entity.kind.trim().toLowerCase() === 'none') {
            modelCounts.none++;
            none++;
            continue;
          }
          const kind = harvestKind(entity.kind);
          if (!kind) {
            modelCounts.invalid++;
            rejected.push({ surface: candidate.surface, name: entity.name || candidate.surface, kind: entity.kind, reason: 'kind-not-allowed' });
            continue;
          }
          const candidateContexts = contexts.filter((entry) => entry.candidate === candidate);
          let context = Number.isInteger(entity.chunkIndex) && entity.chunkIndex >= 0
            ? contexts[entity.chunkIndex]
            : undefined;
          if (!context || context.candidate !== candidate) {
            const wanted = String(entity.quote ?? '').replace(/\s+/g, ' ').trim();
            context = (wanted
              ? candidateContexts.find((entry) =>
                String(entry.chunkText ?? '').replace(/\s+/g, ' ').trim().includes(wanted))
              : undefined)
              ?? candidateContexts.find((entry) => mentions(entry.sentence.text, candidate.surface));
          }
          if (!context) {
            rejected.push({ surface: candidate.surface, name: entity.name || candidate.surface, kind, reason: 'bad-shape' });
            continue;
          }
          let quote = entity.quote;
          let verdict = validateHarvestClassification(
            entity,
            candidate,
            { ...context.sentence, chunkText: context.chunkText },
            bank.isBanked,
            bank.isFamilyGroup,
            facts.isCommonSurface,
            facts.isPlural,
          );
          // A model that paraphrases or truncates its quote still chose the
          // entity. Fall back to the verbatim sentence the candidate kept, so
          // the stored evidence is real text from the cited chunk.
          if (!verdict.ok && (verdict.reason === 'quote-not-found' || verdict.reason === 'surface-not-in-quote')) {
            const fallback = candidateContexts.find((entry) => mentions(entry.sentence.text, candidate.surface));
            if (fallback) {
              quote = fallback.sentence.text;
              context = fallback;
              verdict = validateHarvestClassification(
                { ...entity, quote: fallback.sentence.text },
                candidate,
                { ...fallback.sentence, chunkText: fallback.chunkText },
                bank.isBanked,
                bank.isFamilyGroup,
                facts.isCommonSurface,
                facts.isPlural,
              );
              if (verdict.ok) recoveredQuotes++;
            }
          }
          if (!verdict.ok) {
            if (verdict.reason === 'none') {
              modelCounts.none++;
              none++;
            } else {
              rejected.push({
                surface: candidate.surface,
                name: entity.name || candidate.surface,
                kind,
                reason: verdict.reason,
                ...(verdict.category === undefined ? {} : { category: verdict.category }),
                ...(verdict.note === undefined ? {} : { note: verdict.note }),
              });
            }
            continue;
          }
          modelCounts[verdict.kind] = (modelCounts[verdict.kind] ?? 0) + 1;
          const owner = possessiveCreatureOwner(candidate.surface);
          const ownerEntity = owner ? resolveOwnerEntity(db, project.id, owner) : null;
          const sourceRefs = JSON.stringify([{ locator: context.sentence.locator, chunk: context.sentence.chunkId }]);
          let insertedId: number | null = null;
          if (write) {
            insertedId = insertEntityCandidate(db, project.id, {
              kind: verdict.kind as never,
              name: verdict.name,
              evidence: quote,
              firstChunk: context.sentence.chunkId,
              sourceRefs,
              attributes: verdict.attributes,
            });
            if (insertedId === null) {
              rejected.push({ surface: candidate.surface, name: verdict.name, kind: verdict.kind, reason: 'already-banked' });
              continue;
            }
            if (ownerEntity) {
              insertOwnedCreatureRelation(db, project.id, ownerEntity.id, insertedId, quote, sourceRefs);
            }
          }
          bank.add(verdict.name);
          accepted.push({
            surface: candidate.surface,
            name: verdict.name,
            kind: verdict.kind,
            chunkId: context.sentence.chunkId,
            locator: context.sentence.locator,
            quote,
            attributes: verdict.attributes,
            ...(owner === null ? {} : { owner }),
            ...(ownerEntity === null ? {} : { ownerEntity }),
            ...(entity.reason === undefined ? {} : { reason: entity.reason }),
          });
        }
      }
      for (const candidate of batch) {
        if (!seen.has(surfaceKeyOf(candidate.surface))) {
          modelCounts.none++;
          none++;
        }
      }
      batchReports.push({
        batch: batchIndex + 1,
        candidates: batch.map((candidate) => candidate.surface),
        ...(modelText === null ? {} : { modelText }),
        accepted: accepted.length - batchAccepted,
        rejected: rejected.length - batchRejected,
        none,
      });
    }

    const acceptedByKind = Object.fromEntries(
      Object.entries(modelCounts).filter(([, value]) => value > 0),
    );
    console.log(JSON.stringify({
      project: { id: project.id, name: project.name },
      model,
      write,
      limit,
      minCount,
      candidateCount: candidates.length,
      batchCount: batchReports.length,
      modelCounts: acceptedByKind,
      acceptedCount: accepted.length,
      recoveredQuotes,
      rejectedCount: rejected.length,
      errors,
      accepted,
      rejected,
      batches: batchReports,
      candidates,
    }, null, 2));
  }
} finally {
  db.close();
}
