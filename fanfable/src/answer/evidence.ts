/**
 * Deterministic evidence selection (SPEC-evidence-selection.md, steps 1–2).
 *
 * Pure: plain inputs and outputs. No database handle, no model call, no I/O.
 * Records are supplied by retrieval; validation is a separate, impure step.
 */
import { canonicalName, nameRelation } from '../identity/names.ts';
import { STOPWORDS } from '../core/vocab.ts';

export type ClaimKind = 'canon' | 'au';

/** One required claim. `kind` decides which event table may support it. */
export interface ClaimRequirement {
  text: string;
  kind?: ClaimKind | 'unknown';
}

/** What a scene needs before anything is retrieved. Stored in the outline JSON. */
export interface SceneRequirements {
  title: string;
  /** Roster names; unknown names are reported by retrieval, never guessed. */
  characters: string[];
  /** Short claims in plain language; the selector validates these. */
  requires: ClaimRequirement[];
  constraints?: string[];
  /** Ordering anchors: canon event ids, not dates. */
  timeline?: { after?: number | null; before?: number | null };
}

export type EvidenceSource = 'canon' | 'au';

/** A candidate event, as retrieval hands it to the selector. */
export interface EvidenceRecord {
  eventId: number;
  /** Which table the id belongs to. Ids collide across the two tables. */
  source: EvidenceSource;
  title: string;
  locator: string;
  /** Searchable event text (title and summary). */
  text: string;
  /** Resolved participant names and aliases; the selector matches scene characters. */
  participants: string[];
  /** Participant strings retrieval could not resolve to a roster id. */
  unresolvedParticipants?: string[];
  /** Reading order, used only for deterministic ordering. */
  seq?: number;
  /** True when the event was pulled in by a timeline window, not a participant match. */
  timelineWindow?: boolean;
}

export interface ClaimSupport {
  claim: string;
  source: EvidenceSource;
  eventId: number;
  title: string;
  locator: string;
  score: number;
  why: string;
}

export interface ContextEntry {
  source: EvidenceSource;
  eventId: number;
  title: string;
  locator: string;
  why: string;
}

export type GapReason =
  | 'no-event'
  | 'no-term-match'
  | 'au-dependent'
  | 'unclassified'
  | 'too-distant'
  | 'support-limit';

export interface Gap {
  claim: string;
  reason: GapReason;
}

export interface SuspiciousReuse {
  source: EvidenceSource;
  eventId: number;
  title: string;
  claims: string[];
}

export interface Packet {
  support: ClaimSupport[];
  context: ContextEntry[];
  gaps: Gap[];
  suspiciousReuse: SuspiciousReuse[];
}

/** The result of normalising a claim or an event's text. */
export interface NormalizedText {
  terms: string[];
}

/**
 * The explicit synonym table. Inflections and near-synonyms map onto one stem;
 * nothing else is stemmed. "sorted into" reduces to `sort` because `into` is a
 * stopword.
 */
const TERM_SYNONYMS: Readonly<Record<string, string>> = {
  sort: 'sort', sorts: 'sort', sorted: 'sort', sorting: 'sort',
  place: 'sort', places: 'sort', placed: 'sort', placing: 'sort', placement: 'sort', placements: 'sort',
  assign: 'sort', assigns: 'sort', assigned: 'sort', assigning: 'sort', assignment: 'sort',
  arrive: 'arriv', arrives: 'arriv', arrived: 'arriv', arriving: 'arriv', arrival: 'arriv', arrivals: 'arriv',
};

/** One trailing plural `s`, guarding `ss`; no other stemming. */
function plural(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/** Lowercase, possessives stripped, punctuation removed, stopwords dropped, synonyms stemmed, plurals folded. */
export function normalizeTerms(text: string): string[] {
  const out: string[] = [];
  const words = (text ?? '')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    const term = TERM_SYNONYMS[word] ?? plural(word);
    if (term.length < 2) continue;
    if (!out.includes(term)) out.push(term);
  }
  return out;
}

export function normalizeText(text: string): NormalizedText {
  return { terms: normalizeTerms(text) };
}

/** Do two names denote the same person under the shared naming layer? */
export function namesRelate(a: string, b: string): boolean {
  if (!(a ?? '').trim() || !(b ?? '').trim()) return false;
  return nameRelation(a, b) !== null || canonicalName(a) === canonicalName(b);
}

/** The scene characters an event shares, by stored/alias name. */
export function sharedCharacters(characters: string[], participants: string[]): string[] {
  return characters.filter((character) => participants.some((participant) => namesRelate(character, participant)));
}

function overlapLabel(count: number): string {
  return count >= 2 ? `both scene characters` : `a scene character`;
}

/** Split title+summary into sentences for the agent check. */
function sentences(text: string): string[][] {
  return (text ?? '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => normalizeTerms(sentence))
    .filter((tokens) => tokens.length > 0);
}

interface ClaimInfo {
  text: string;
  kind: 'canon' | 'au' | 'unknown';
  terms: string[];
  content: string[];
  /** Scene characters the claim names. */
  named: string[];
}

interface ScoredRecord {
  claim: string;
  record: EvidenceRecord;
  matched: string[];
  titleHits: number;
  score: number;
}

const MAX_SUPPORT = 6;
const MAX_CONTEXT = 6;

/**
 * Select a packet for one scene. Deterministic: equal inputs produce an equal
 * packet, ordered by rank (score) then id ascending.
 */
export function selectEvidence(requirements: SceneRequirements, records: EvidenceRecord[]): Packet {
  const characters = (requirements.characters ?? []).map((name) => name.trim()).filter(Boolean);
  const sceneNameTerms = new Set(characters.flatMap((name) => normalizeTerms(name)));
  const claims: ClaimInfo[] = (requirements.requires ?? []).map((requirement) => {
    const text = (requirement.text ?? '').trim();
    const kind: ClaimInfo['kind'] =
      requirement.kind === 'canon' || requirement.kind === 'au' ? requirement.kind : 'unknown';
    const terms = normalizeTerms(text);
    const tokenSet = new Set(terms);
    const named = characters.filter((character) =>
      normalizeTerms(character).some((token) => tokenSet.has(token)),
    );
    return { text, kind, terms, content: terms.filter((term) => !sceneNameTerms.has(term)), named };
  });
  const uniqueClaims: ClaimInfo[] = [];
  const seenClaims = new Set<string>();
  for (const claim of claims) {
    if (!claim.text || seenClaims.has(claim.text)) continue;
    seenClaims.add(claim.text);
    uniqueClaims.push(claim);
  }

  const byKey = new Map<string, EvidenceRecord>();
  for (const record of records) {
    const key = `${record.source}:${record.eventId}`;
    if (!byKey.has(key)) byKey.set(key, record);
  }
  const overlap = new Map<string, number>();
  for (const [key, record] of byKey) {
    overlap.set(key, sharedCharacters(characters, record.participants ?? []).length);
  }
  const hasAnchors = Boolean(requirements.timeline?.after != null || requirements.timeline?.before != null);

  const scored: ScoredRecord[] = [];
  const gaps: Gap[] = [];
  for (const info of uniqueClaims) {
    if (info.kind === 'unknown') {
      gaps.push({ claim: info.text, reason: 'unclassified' });
      continue;
    }
    const source: EvidenceSource = info.kind;
    const sourceRecords = [...byKey.entries()].filter(([, record]) => record.source === source);
    let sawOverlap = false;
    let sawEligible = false;
    let sawOutOfWindow = false;
    let best: ScoredRecord | null = null;
    for (const [key, record] of sourceRecords) {
      const participants = record.participants ?? [];
      // Character overlap: all characters the claim names, else the scene cast.
      if (info.named.length) {
        if (info.named.some((character) => !participants.some((p) => namesRelate(character, p)))) continue;
      } else if ((overlap.get(key) ?? 0) === 0) {
        continue;
      }
      sawOverlap = true;
      const recordTerms = new Set(normalizeTerms(record.text));
      const titleTerms = new Set(normalizeTerms(record.title));
      const participantTerms = new Set(participants.flatMap((name) => normalizeTerms(name)));
      // A match on a person's name is not claim support.
      const content = info.terms.filter(
        (term) => !sceneNameTerms.has(term) && !participantTerms.has(term),
      );
      const matched = content.filter((term) => recordTerms.has(term));
      const titleHits = matched.filter((term) => titleTerms.has(term)).length;
      // Two distinct non-name terms, or one that the event title carries.
      if (matched.length < 2 && titleHits < 1) continue;
      // Agent check: the matched terms must sit in a sentence that names the claim's character(s).
      if (info.named.length) {
        const sentencesOfRecord = sentences(record.text);
        const agentOk = info.named.every((character) => {
          const nameTokens = normalizeTerms(character);
          return sentencesOfRecord.some(
            (tokens) =>
              nameTokens.some((token) => tokens.includes(token)) &&
              matched.some((term) => tokens.includes(term)),
          );
        });
        if (!agentOk) continue;
      }
      sawEligible = true;
      // Proximity: canon events outside the scene's window cannot support it.
      if (hasAnchors && record.source === 'canon' && !record.timelineWindow) {
        sawOutOfWindow = true;
        continue;
      }
      const score = Math.round((matched.length / Math.max(1, content.length)) * 100) / 100;
      const candidate: ScoredRecord = { claim: info.text, record, matched, titleHits, score };
      if (
        !best ||
        score > best.score ||
        (score === best.score && titleHits > best.titleHits) ||
        (score === best.score && titleHits === best.titleHits &&
          record.source.localeCompare(best.record.source) < 0) ||
        (score === best.score && titleHits === best.titleHits &&
          record.source === best.record.source && record.eventId < best.record.eventId)
      ) {
        best = candidate;
      }
    }
    if (best) {
      scored.push(best);
      continue;
    }
    const reason: GapReason =
      info.kind === 'au'
        ? 'au-dependent'
        : sawEligible && sawOutOfWindow
          ? 'too-distant'
          : sawOverlap
            ? 'no-term-match'
            : 'no-event';
    gaps.push({ claim: info.text, reason });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.titleHits - a.titleHits ||
      a.record.source.localeCompare(b.record.source) ||
      a.record.eventId - b.record.eventId ||
      a.claim.localeCompare(b.claim),
  );
  const supported = scored.slice(0, MAX_SUPPORT);
  for (const dropped of scored.slice(MAX_SUPPORT)) gaps.push({ claim: dropped.claim, reason: 'support-limit' });

  const support: ClaimSupport[] = supported.map((entry) => ({
    claim: entry.claim,
    source: entry.record.source,
    eventId: entry.record.eventId,
    title: entry.record.title,
    locator: entry.record.locator,
    score: entry.score,
    why: `matched ${entry.matched.join(', ')}; shares ${overlapLabel(overlap.get(`${entry.record.source}:${entry.record.eventId}`) ?? 1)}`,
  }));

  const used = new Set(supported.map((entry) => `${entry.record.source}:${entry.record.eventId}`));
  const context: ContextEntry[] = [...byKey.entries()]
    .filter(([key]) => !used.has(key))
    .map(([key, record]) => ({ record, shared: overlap.get(key) ?? 0 }))
    .filter((entry) => entry.shared > 0 || (entry.record.source === 'canon' && entry.record.timelineWindow))
    .sort(
      (a, b) =>
        Number(Boolean(b.record.timelineWindow)) - Number(Boolean(a.record.timelineWindow)) ||
        b.shared - a.shared ||
        (a.record.seq ?? 0) - (b.record.seq ?? 0) ||
        a.record.source.localeCompare(b.record.source) ||
        a.record.eventId - b.record.eventId,
    )
    .slice(0, MAX_CONTEXT)
    .map(({ record, shared }) => ({
      source: record.source,
      eventId: record.eventId,
      title: record.title,
      locator: record.locator,
      why: shared > 0
        ? `shares ${overlapLabel(shared)}; background only`
        : `inside the scene's timeline window; background only`,
    }));

  // One event proving three unrelated claims is a catch-all, not reuse.
  const byEvent = new Map<string, ScoredRecord[]>();
  for (const entry of supported) {
    const key = `${entry.record.source}:${entry.record.eventId}`;
    byEvent.set(key, [...(byEvent.get(key) ?? []), entry]);
  }
  const suspiciousReuse: SuspiciousReuse[] = [];
  for (const [key, group] of [...byEvent.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (group.length < 3) continue;
    const contents = group.map(
      (entry) => new Set(uniqueClaims.find((info) => info.text === entry.claim)?.content ?? []),
    );
    let disjoint = true;
    for (let i = 0; i < contents.length && disjoint; i++) {
      for (let j = i + 1; j < contents.length; j++) {
        for (const term of contents[i]!) {
          if (contents[j]!.has(term)) {
            disjoint = false;
            break;
          }
        }
        if (!disjoint) break;
      }
    }
    if (disjoint) {
      suspiciousReuse.push({
        source: group[0]!.record.source,
        eventId: group[0]!.record.eventId,
        title: group[0]!.record.title,
        claims: group.map((entry) => entry.claim),
      });
    }
  }

  const seenGaps = new Set<string>();
  const dedupedGaps = gaps.filter((gap) => (seenGaps.has(gap.claim) ? false : (seenGaps.add(gap.claim), true)));
  return { support, context, gaps: dedupedGaps, suspiciousReuse };
}
