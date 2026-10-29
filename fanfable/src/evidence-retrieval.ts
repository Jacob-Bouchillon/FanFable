/**
 * Evidence retrieval and packet validation (SPEC-evidence-selection.md, step 3).
 *
 * Impure: reads the project's entities and both event tables. The selector
 * stays pure.
 */
import { Db, fromJson } from './db.ts';
import * as lorebook from './lorebook.ts';
import { canonicalName } from './names.ts';
import {
  sharedCharacters,
  type EvidenceRecord,
  type EvidenceSource,
  type Packet,
  type SceneRequirements,
} from './evidence.ts';

export interface UnresolvedParticipant {
  eventId: number;
  source: EvidenceSource;
  name: string;
}

export interface EvidenceRetrieval {
  records: EvidenceRecord[];
  /** Requirement names that resolve to no roster entity (never guessed). */
  unresolvedCharacters: string[];
  /** Event participant strings that resolve to no roster entity. */
  unresolvedParticipants: UnresolvedParticipant[];
}

interface EventRow {
  id: number;
  title: string;
  summary: string;
  participants: string;
  seq: number;
  locator: string;
}

interface AuEventRow {
  id: number;
  title: string;
  summary: string;
  participants: string;
  seq: number;
  story_time: string;
}

/** The locator an AU event can honestly offer; no page exists for story events. */
function auLocator(storyTime: string): string {
  return storyTime ? `story time ${storyTime}` : '';
}

/**
 * Load candidate events for a scene: canon events whose participant strings
 * resolve to any scene character (or that sit inside the scene's timeline
 * window), plus the project's AU events. Unresolved names are reported.
 */
export function loadEvidenceRecords(
  db: Db,
  projectId: number,
  requirements: SceneRequirements,
): EvidenceRetrieval {
  const entities = lorebook.listEntities(db, projectId);
  const byName = new Map<string, typeof entities>();
  for (const entity of entities) {
    for (const key of [entity.name, ...entity.aliases]) {
      const canonical = canonicalName(key);
      if (!canonical) continue;
      byName.set(canonical, [...(byName.get(canonical) ?? []), entity]);
    }
  }
  const resolve = (name: string) => byName.get(canonicalName(name)) ?? [];

  const characters = requirements.characters ?? [];
  const unresolvedCharacters = characters.filter((name) => resolve(name).length === 0);

  const after = requirements.timeline?.after ?? null;
  const before = requirements.timeline?.before ?? null;
  const seqOf = (id: number | null): number | null => {
    if (id === null) return null;
    const row = db.get<{ seq: number }>(
      'SELECT seq FROM canon_event WHERE id = ? AND project_id = ?',
      id,
      projectId,
    );
    return row?.seq ?? null;
  };
  const afterSeq = seqOf(after);
  const beforeSeq = seqOf(before);
  const inWindow = (seq: number): boolean => {
    if (afterSeq === null && beforeSeq === null) return false;
    if (afterSeq !== null && seq <= afterSeq) return false;
    if (beforeSeq !== null && seq >= beforeSeq) return false;
    return true;
  };

  const records: EvidenceRecord[] = [];
  const unresolvedParticipants: UnresolvedParticipant[] = [];
  const participantNamesFor = (eventId: number, source: EvidenceSource, raw: string[]): {
    participants: string[];
    missing: string[];
  } => {
    const names = new Set<string>();
    const missing: string[] = [];
    for (const name of raw) {
      const matched = resolve(name);
      if (!matched.length) {
        missing.push(name);
        unresolvedParticipants.push({ eventId, source, name });
        continue;
      }
      for (const entity of matched) {
        names.add(entity.name);
        for (const alias of entity.aliases) names.add(alias);
      }
    }
    return { participants: [...names], missing };
  };

  const canonEvents = db.all<EventRow>(
    `SELECT id, title, summary, participants, seq, locator
       FROM canon_event WHERE project_id = ? ORDER BY seq, id`,
    projectId,
  );
  for (const event of canonEvents) {
    const raw = fromJson<string[]>(event.participants, []).map((name) => String(name).trim()).filter(Boolean);
    const { participants, missing } = participantNamesFor(event.id, 'canon', raw);
    const inTimelineWindow = inWindow(event.seq);
    if (!inTimelineWindow && sharedCharacters(characters, participants).length === 0) continue;
    records.push({
      eventId: event.id,
      source: 'canon',
      title: event.title,
      locator: event.locator,
      text: `${event.title}. ${event.summary}`,
      participants,
      ...(missing.length ? { unresolvedParticipants: missing } : {}),
      seq: event.seq,
      timelineWindow: inTimelineWindow,
    });
  }

  const auEvents = db.all<AuEventRow>(
    `SELECT id, title, summary, participants, seq, story_time
       FROM au_event WHERE project_id = ? ORDER BY seq, id`,
    projectId,
  );
  for (const event of auEvents) {
    const raw = fromJson<string[]>(event.participants, []).map((name) => String(name).trim()).filter(Boolean);
    const { participants, missing } = participantNamesFor(event.id, 'au', raw);
    records.push({
      eventId: event.id,
      source: 'au',
      title: event.title,
      locator: auLocator(event.story_time),
      text: `${event.title}. ${event.summary}`,
      participants,
      ...(missing.length ? { unresolvedParticipants: missing } : {}),
      seq: event.seq,
      timelineWindow: false,
    });
  }

  return { records, unresolvedCharacters, unresolvedParticipants };
}

/**
 * Re-check a packet against the project: every cited id must exist in the table
 * its `source` names, belong to the project, and carry the stored locator.
 * A canon id cited as an AU source (or the reverse) cannot pass on the other
 * table's row.
 */
export function validatePacket(
  db: Db,
  projectId: number,
  packet: Packet,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const cited = [
    ...packet.support.map((entry) => ({ source: entry.source, eventId: entry.eventId, locator: entry.locator })),
    ...packet.context.map((entry) => ({ source: entry.source, eventId: entry.eventId, locator: entry.locator })),
  ];
  for (const entry of cited) {
    let stored: string | undefined;
    if (entry.source === 'canon') {
      stored = db.get<{ locator: string }>(
        'SELECT locator FROM canon_event WHERE id = ? AND project_id = ?',
        entry.eventId,
        projectId,
      )?.locator;
    } else if (entry.source === 'au') {
      const row = db.get<{ story_time: string }>(
        'SELECT story_time FROM au_event WHERE id = ? AND project_id = ?',
        entry.eventId,
        projectId,
      );
      stored = row ? auLocator(row.story_time) : undefined;
    } else {
      problems.push(`event ${entry.eventId}: unknown source`);
      continue;
    }
    if (stored === undefined) {
      problems.push(`event ${entry.source}:${entry.eventId}: not found in project ${projectId}`);
      continue;
    }
    if (stored !== entry.locator) {
      problems.push(
        `event ${entry.source}:${entry.eventId}: locator mismatch (packet "${entry.locator}" vs stored "${stored}")`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}
