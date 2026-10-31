/**
 * Evidence-selection measurement (trials only, read-only).
 *
 * Runs the pure selector over the real trial book for the seven scenes of
 * outline v5, with canon/AU claim routing. The outline stores scene titles
 * only (requirements arrive with planner step 5), so this script supplies the
 * seven-scene requirements fixture. Nothing is written and no model is called.
 *
 * usage: node --experimental-strip-types testing/trials/evidence/evidence-select.ts
 */
import { DatabaseSync } from 'node:sqlite';
import type { Db } from '../../../fanfable/src/core/db.ts';
import {
  selectEvidence,
  type ClaimRequirement,
  type Packet,
  type SceneRequirements,
} from '../../../fanfable/src/answer/evidence.ts';
import { loadEvidenceRecords, validatePacket } from '../../../fanfable/src/answer/evidence-retrieval.ts';

const DB_PATH = 'testing/trials/model-ab/hp3.db';
const raw = new DatabaseSync(DB_PATH, { readOnly: true });
const db = {
  all: (sql: string, ...params: unknown[]) => raw.prepare(sql).all(...(params as never[])),
  get: (sql: string, ...params: unknown[]) => raw.prepare(sql).get(...(params as never[])),
} as unknown as Db;

const project = (db.get("SELECT id FROM project WHERE name = 'ab'") as { id: number } | undefined)!;
const projectId = project.id;

const canon = (text: string): ClaimRequirement => ({ text, kind: 'canon' });
const au = (text: string): ClaimRequirement => ({ text, kind: 'au' });

/** The seven-scene requirements fixture, keyed by the v5 scene titles. */
const REQUIREMENTS: Record<string, SceneRequirements> = {
  'The Entrance': {
    title: 'The Entrance',
    characters: ['Harry Potter', 'Dudley Dursley', 'Rubeus Hagrid'],
    requires: [
      canon('the first years cross the lake by boat'),
      canon('Hagrid leads the first years to the castle'),
      au('Dudley is magical'),
    ],
    timeline: { after: 150, before: 154 },
  },
  'The Sort': {
    title: 'The Sort',
    characters: ['Harry Potter', 'Dudley Dursley'],
    requires: [canon('the Sorting ceremony places first years into houses'), au('Dudley is placed in Gryffindor')],
    timeline: { after: 149, before: 163 },
  },
  'The Reaction': {
    title: 'The Reaction',
    characters: ['Harry Potter', 'Dudley Dursley', 'Ron Weasley'],
    requires: [canon('the Gryffindor table welcomes the new students'), canon('the students celebrate their house')],
    timeline: { after: 161, before: 169 },
  },
  'Potions Class': {
    title: 'Potions Class',
    characters: ['Harry Potter', 'Severus Snape'],
    requires: [canon('Snape teaches Potions'), canon('Snape questions Harry in class')],
    timeline: { after: 178, before: 183 },
  },
  'The Common Room': {
    title: 'The Common Room',
    characters: ['Harry Potter', 'Ron Weasley', 'Hermione Granger'],
    requires: [canon('the Gryffindor common room is where students gather'), canon('the students discuss their classes')],
  },
  'The Incident': {
    title: 'The Incident',
    characters: ['Harry Potter', 'Draco Malfoy', 'Ron Weasley'],
    requires: [canon('Malfoy challenges Harry to a duel'), canon('a duel is arranged in the trophy room')],
    timeline: { after: 198, before: 203 },
  },
  Aftermath: {
    title: 'Aftermath',
    characters: ['Harry Potter', 'Hermione Granger', 'Neville Longbottom'],
    requires: [canon('the friends recover after the confrontation'), canon('the friends are rewarded for their courage')],
    timeline: { after: 203, before: 206 },
  },
};

const outline = db.get('SELECT chapters FROM outline WHERE project_id = ? AND version = 5', projectId) as
  | { chapters: string }
  | undefined;
const chapters = JSON.parse(outline?.chapters ?? '[]') as {
  number: number;
  scenes: { title: string }[];
}[];

interface ReportRow {
  chapter: number;
  scene: string;
  requirements: SceneRequirements;
  packet: Packet;
  validation: { ok: boolean; problems: string[] };
  unresolvedCharacters: string[];
  unresolvedParticipants: { eventId: number; source: 'canon' | 'au'; name: string }[];
}
const report: ReportRow[] = [];

for (const chapter of chapters) {
  for (const scene of chapter.scenes) {
    const requirements = REQUIREMENTS[scene.title];
    if (!requirements) continue;
    const retrieval = loadEvidenceRecords(db, projectId, requirements);
    const packet = selectEvidence(requirements, retrieval.records);
    report.push({
      chapter: chapter.number,
      scene: scene.title,
      requirements,
      packet,
      validation: validatePacket(db, projectId, packet),
      unresolvedCharacters: retrieval.unresolvedCharacters,
      unresolvedParticipants: retrieval.unresolvedParticipants,
    });
  }
}

for (const entry of report) {
  console.log(`\n## CH${entry.chapter} — ${entry.scene}`);
  console.log(`characters: ${entry.requirements.characters.join(', ')}`);
  console.log('requires:');
  for (const claim of entry.requirements.requires) console.log(`  - [${claim.kind}] ${claim.text}`);
  console.log('support:');
  if (!entry.packet.support.length) console.log('  (none)');
  for (const s of entry.packet.support) {
    console.log(`  - [${s.source}:${s.eventId}] "${s.title}" (score ${s.score}) — ${s.claim}`);
  }
  console.log(`context: ${entry.packet.context.length ? entry.packet.context.map((c) => `[${c.source}:${c.eventId}]`).join(', ') : '(none)'}`);
  console.log('gaps:');
  if (!entry.packet.gaps.length) console.log('  (none)');
  for (const g of entry.packet.gaps) console.log(`  - ${g.claim} (${g.reason})`);
  console.log(`suspiciousReuse: ${entry.packet.suspiciousReuse.length}`);
  if (entry.unresolvedCharacters.length) console.log(`unresolved characters: ${entry.unresolvedCharacters.join(', ')}`);
  if (entry.unresolvedParticipants.length) {
    const byName = new Map<string, string[]>();
    for (const p of entry.unresolvedParticipants) {
      const key = `${p.name}@${p.source}:${p.eventId}`;
      byName.set(key, []);
    }
    const shown = [...byName.keys()].slice(0, 10);
    console.log(
      `unresolved participants (${byName.size}): ${shown.join(', ')}${byName.size > shown.length ? ', …' : ''}`,
    );
  }
  if (!entry.validation.ok) console.log(`VALIDATION PROBLEMS: ${entry.validation.problems.join('; ')}`);
}

const gapReasons: Record<string, number> = {};
for (const entry of report) for (const gap of entry.packet.gaps) gapReasons[gap.reason] = (gapReasons[gap.reason] ?? 0) + 1;
const totalClaims = report.reduce((n, e) => n + e.requirements.requires.length, 0);
const gapCount = report.reduce((n, e) => n + e.packet.gaps.length, 0);
const sorting = report.find((entry) => entry.scene === 'The Sort')!;
const sortingCanon = sorting.packet.support.find((s) => s.claim === 'the Sorting ceremony places first years into houses');
const dudley = sorting.packet.support.find((s) => s.claim === 'Dudley is placed in Gryffindor');
const dudleyGap = sorting.packet.gaps.find((g) => g.claim === 'Dudley is placed in Gryffindor');

console.log('\n## Summary');
console.log(`scenes: ${report.length}, claims: ${totalClaims}, gaps: ${gapCount} (${JSON.stringify(gapReasons)})`);
console.log(`Sorting places first-years -> ${sortingCanon ? `[${sortingCanon.source}:${sortingCanon.eventId}] "${sortingCanon.title}"` : 'GAP'}`);
console.log(
  `Dudley placed in Gryffindor -> ${dudley ? `AU support [${dudley.source}:${dudley.eventId}] "${dudley.title}"` : `GAP ${dudleyGap?.reason ?? ''}`}`,
);
const printing = report.find((entry) => entry.scene === 'The Entrance')!;
const lakeClaim = 'the first years cross the lake by boat';
console.log(
  `lake-by-boat -> ${printing.packet.support.filter((s) => s.claim === lakeClaim).map((s) => `[${s.source}:${s.eventId}] "${s.title}"`).join(', ') || 'GAP'}`,
);
console.log('red cases still in support:');
const red: { scene: string; claim: string; eventId: number }[] = [
  { scene: 'The Entrance', claim: 'Dudley is magical', eventId: 29 },
  { scene: 'The Entrance', claim: lakeClaim, eventId: 150 },
  { scene: 'Potions Class', claim: 'Snape questions Harry in class', eventId: 70 },
  { scene: 'The Reaction', claim: 'the students celebrate their house', eventId: 317 },
  { scene: 'Aftermath', claim: 'the friends recover after the confrontation', eventId: 69 },
];
for (const item of red) {
  const entry = report.find((e) => e.scene === item.scene)!;
  const hit = entry.packet.support.some((s) => s.claim === item.claim && s.eventId === item.eventId);
  const source = entry.packet.support.find((s) => s.claim === item.claim);
  console.log(`  ${item.scene} — ${item.claim} → event ${item.eventId}: ${hit ? 'STILL SUPPORT' : `not support${source ? ` (now [${source.source}:${source.eventId}])` : ' (gap)'}`}`);
}
for (const entry of report) {
  for (const gap of entry.packet.gaps) console.log(`gap: ${entry.scene} — ${gap.claim} (${gap.reason})`);
}
raw.close();
