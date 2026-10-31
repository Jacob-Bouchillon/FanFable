/**
 * Premise checking.
 *
 * Before a plan is approved, the premise is checked against what the canon
 * actually says. A story is allowed to change the canon — that is the point of
 * an alternate universe — but the author should know when they have, and a
 * premise that names someone who does not exist in the source is usually a
 * mistake rather than a choice.
 */
import { Db } from '../core/db.ts';
import * as lorebook from '../lorebook.ts';

export interface PremiseWarning {
  severity: 'error' | 'warning' | 'note';
  kind: 'unknown-character' | 'status-conflict' | 'dead-character' | 'unknown-event';
  message: string;
  evidence: string;
}

/**
 * Patterns that assert a person's state, with the name as a placeholder.
 *
 * These have to be anchored to the name, because "Serena kills Ilsa" says
 * something about Ilsa, not about Serena.
 */
const STATUS_PATTERNS: { source: string; status: string; alive?: boolean }[] = [
  { source: '\\b(?:is|was|are|were)\\s+dead\\b', status: 'dead' },
  { source: '\\b(?:dies|died|has died)\\b', status: 'dead' },
  { source: '\\b(?:is|was)\\s+(?:killed|murdered|assassinated)\\b', status: 'dead' },
  { source: '\\b(?:kills|killed|murders|murdered|stabs|stabbed|shoots|buries)\\s+(?:\\w+\\s+)?%NAME%', status: 'dead' },
  { source: '\\b(?:is|was)\\s+alive\\b', status: 'alive', alive: true },
  { source: '\\b(?:is|was|goes|went)\\s+missing\\b', status: 'missing' },
];

function contradicts(canonStatus: string, claimed: string): boolean {
  const a = canonStatus.toLowerCase();
  const b = claimed.toLowerCase();
  if (!a) return false;
  if (a.includes('dead') || a.includes('killed') || a.includes('deceased')) return b !== 'dead';
  if (a.includes('missing')) return b !== 'missing';
  if (a.includes('alive') || a.includes('living')) return b === 'dead';
  return false;
}

/**
 * Check a premise and divergence point against the canon.
 */
export function checkPremise(
  db: Db,
  projectId: number,
  premise: string,
  divergence = '',
): PremiseWarning[] {
  const warnings: PremiseWarning[] = [];
  const text = `${premise}\n${divergence}`;
  if (!text.trim()) return warnings;

  const all = lorebook.listEntities(db, projectId);
  const entities = all.filter((e) => e.kind === 'character');
  if (!entities.length) return warnings;

  const lower = text.toLowerCase();

  for (const entity of entities) {
    const names = [entity.name, ...entity.aliases];
    const mentioned = names.find((n) => n && lower.includes(n.toLowerCase()));
    if (!mentioned) continue;

    // What does the premise claim about this person? The patterns are anchored
    // to the name so that "Serena kills Ilsa" is read as a claim about Ilsa.
    const escaped = mentioned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const window = text.slice(Math.max(0, lower.indexOf(mentioned.toLowerCase()) - 60), lower.indexOf(mentioned.toLowerCase()) + 160);
    let claimed: { status: string; alive?: boolean } | null = null;
    for (const pattern of STATUS_PATTERNS) {
      const re = new RegExp(pattern.source.replace('%NAME%', escaped), 'i');
      if (!re.test(window)) continue;
      claimed = { status: pattern.status, alive: pattern.alive };
      break;
    }

    if (claimed) {
      if (contradicts(entity.status, claimed.status)) {
        warnings.push({
          severity: 'warning',
          kind: 'status-conflict',
          message: `The premise says ${mentioned} is ${claimed.status}, but the source material records ${entity.name} as "${entity.status}".`,
          evidence: entity.summary || entity.evidence || 'no summary recorded',
        });
      }
    } else if (/dead|killed|deceased/i.test(entity.status)) {
      warnings.push({
        severity: 'note',
        kind: 'dead-character',
        message: `${entity.name} is "${entity.status}" in the source material but appears in this premise.`,
        evidence: entity.summary || entity.evidence || 'no summary recorded',
      });
    }
  }

  // People and places the premise names that are not in the source at all.
  const known = new Set(
    all.flatMap((e) => [e.name.toLowerCase(), ...e.aliases.map((a) => a.toLowerCase())]),
  );
  // A first name on its own ("Serena" for "Serena Marsh") is still a name the
  // index knows, so it is not reported as missing.
  const isKnown = (name: string): boolean => {
    if (known.has(name)) return true;
    for (const candidate of known) {
      if (candidate.includes(name) || name.includes(candidate)) {
        const a = new Set(candidate.split(/\s+/));
        const b = new Set(name.split(/\s+/));
        if ([...b].every((w) => a.has(w))) return true;
      }
    }
    return false;
  };
  const properNames = [...text.matchAll(/\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)\b/g)].map((m) => m[1]);
  const seen = new Set<string>();
  for (const raw of properNames) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (isKnown(key)) continue;
    // Only complain about names that look like people, and only when the canon
    // index has enough people to be a meaningful comparison.
    if (all.length < 3) continue;
    if (!/^[A-Z][a-z]+$/.test(name)) continue;
    warnings.push({
      severity: 'note',
      kind: 'unknown-character',
      message: `"${name}" is not in the extracted canon. If this is a new character, that is fine; if it should be someone from the book, the lore index may be incomplete.`,
      evidence: `the canon index holds ${all.length} entries`,
    });
  }

  return warnings;
}
