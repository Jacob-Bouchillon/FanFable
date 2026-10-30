/**
 * Lasting-vs-moment check, count-only.
 *
 * Scores one bank's ties without opening quotes: how many labels are
 * lasting (family, lasting roles, friend/enemy) vs moments (met, gave,
 * refused...), plus how many character entities are descriptive phrases
 * the new gate blocks ("the Potters' son" pattern). Read-only, no model.
 *
 * Usage:
 *   node --no-warnings testing/trials/checks/lasting-moment-check.ts <bank-name>
 */
import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';
import { isDescriptiveCharacterName, isMomentKind, isUnsupportedKind } from '/home/jacob/Documents/FanFable/fanfable/src/lorebook.ts';

const bank = process.argv[2];
if (!bank) throw new Error('usage: lasting-moment-check.ts <bank-name>');

const db = new Db('/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db');
try {
  const id = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', bank)?.id;
  if (!id) throw new Error(`no bank named "${bank}"`);
  const rels = db.all<{ kind: string; evidence: string }>('SELECT kind, evidence FROM canon_relation WHERE project_id = ?', id);
  let lasting = 0;
  let unsupported = 0;
  const momentKinds = new Map<string, number>();
  for (const r of rels) {
    if (isMomentKind(r.kind)) momentKinds.set(r.kind, (momentKinds.get(r.kind) ?? 0) + 1);
    else if (isUnsupportedKind(r.kind, r.evidence)) unsupported++;
    else lasting++;
  }
  const entities = db.all<{ name: string; kind: string }>(
    'SELECT name, kind FROM canon_entity WHERE project_id = ?',
    id,
  );
  const descriptive = entities.filter(
    (e) => e.kind === 'character' && isDescriptiveCharacterName(e.name),
  );
  console.log(JSON.stringify({
    bank,
    ties: rels.length,
    lasting,
    moments: [...momentKinds.values()].reduce((a, b) => a + b, 0),
    momentLabels: momentKinds.size,
    unsupported,
    entities: entities.length,
    descriptiveEntities: descriptive.length,
    descriptiveNames: descriptive.map((d) => d.name).slice(0, 10),
  }));
} finally {
  db.close();
}
