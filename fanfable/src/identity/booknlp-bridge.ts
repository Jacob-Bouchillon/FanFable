/**
 * Name-cluster mapping for reader outputs: cluster names in, bank persons out.
 *
 * NOT WIRED. No production module imports this file; it is exercised by tests
 * and by the trial scripts noted here, and nothing in the running product
 * reaches it. Read it as a built-and-tested candidate, not as live behaviour.
 *
 * A reader groups mentions into clusters ("Lah", "Captain Lah"); the bank
 * holds roster persons. This bridge walks each cluster's names through the
 * bank's own identity rules — exact stored name, then stored alias (every
 * stored alias rides, including any a confirmation added), then guarded
 * containment — and reports one verdict per cluster. It never merges, never
 * guesses, never invents a form: a cluster naming two roster persons is
 * reported merged and left alone; a cluster with an unresolvable name is
 * ambiguous when something resolved and absent when nothing did. Fuzzy
 * matching at read time invents family; this bridge does none.
 *
 * The bridge banks nothing and judges no tie. It tells the next stage which
 * clusters name exactly one roster person and which need a human.
 */
import type { Db } from '../core/db.ts';
import {
  createResolver,
  loadIdentityContext,
  type ResolutionHow,
} from './identity.ts';

/** One reader cluster: an opaque key plus the proper names it carries. */
export interface NameCluster {
  key: string;
  names: string[];
}

export type ClusterStatus = 'resolved' | 'ambiguous' | 'absent' | 'merged';

/** How one name fared, kept for the report. */
export interface NameVerdict {
  name: string;
  status: 'resolved' | 'ambiguous' | 'absent';
  entityId: number | null;
  how: ResolutionHow | null;
}

/** One cluster's verdict: at most one roster person, or an honest reason. */
export interface ClusterMapping {
  key: string;
  entityId: number | null;
  status: ClusterStatus;
  /** The weakest tier any name needed (exact beats alias beats containment). */
  how: ResolutionHow | null;
  names: NameVerdict[];
}

export interface MappingCoverage {
  clusters: number;
  resolved: number;
  byHow: Record<ResolutionHow, number>;
  ambiguous: number;
  absent: number;
  merged: number;
  /** Share of clusters naming exactly one roster person. */
  coverage: number;
}

const TIER_RANK: Record<ResolutionHow, number> = { exact: 0, alias: 1, containment: 2 };

/**
 * Map every cluster to at most one roster person of kind `character`.
 *
 * Non-person entities never answer: a cluster naming a place is absent, not
 * a person. Persons quarantined as identity collisions still resolve — the
 * collision flag travels with the row for the reviewer, and refusing to map
 * a flagged name would hide the very rows quarantine exists to surface.
 */
export function mapClusters(db: Db, projectId: number, clusters: NameCluster[]): ClusterMapping[] {
  const context = loadIdentityContext(db, projectId);
  const resolver = createResolver(context);
  const personIds = new Set(context.entities.filter((e) => e.kind === 'character').map((e) => e.id));
  return clusters.map((cluster) => {
    const names: NameVerdict[] = [];
    const persons = new Set<number>();
    const hows = new Set<ResolutionHow>();
    for (const name of cluster.names) {
      const r = resolver.resolve(String(name ?? ''));
      const person = r.status === 'resolved' && r.id !== null && personIds.has(r.id) ? r.id : null;
      if (person !== null) {
        persons.add(person);
        if (r.how) hows.add(r.how);
        names.push({ name, status: 'resolved', entityId: person, how: r.how });
      } else if (r.status === 'ambiguous') {
        names.push({ name, status: 'ambiguous', entityId: null, how: null });
      } else {
        names.push({ name, status: 'absent', entityId: null, how: null });
      }
    }
    const ranked = [...hows].sort((a, b) => TIER_RANK[b]! - TIER_RANK[a]!) as ResolutionHow[];
    const how = ranked[0] ?? null;
    const anyAmbiguous = names.some((n) => n.status === 'ambiguous');
    if (persons.size === 1 && names.every((n) => n.status === 'resolved')) {
      return { key: cluster.key, entityId: [...persons][0]!, status: 'resolved', how, names };
    }
    if (persons.size > 1) {
      return { key: cluster.key, entityId: null, status: 'merged', how, names };
    }
    // One resolved name beside an unresolvable one is still a guess about the
    // cluster; so is a name the roster holds twice. Only all-absent is absent.
    if (anyAmbiguous || persons.size === 1) {
      return { key: cluster.key, entityId: null, status: 'ambiguous', how, names };
    }
    return { key: cluster.key, entityId: null, status: 'absent', how, names };
  });
}

/** Count the verdicts. Coverage is resolved clusters over all clusters. */
export function mappingCoverage(mappings: ClusterMapping[]): MappingCoverage {
  const byHow: Record<ResolutionHow, number> = { exact: 0, alias: 0, containment: 0 };
  let resolved = 0;
  let ambiguous = 0;
  let absent = 0;
  let merged = 0;
  for (const m of mappings) {
    if (m.status === 'resolved') {
      resolved++;
      if (m.how) byHow[m.how]++;
    } else if (m.status === 'ambiguous') ambiguous++;
    else if (m.status === 'absent') absent++;
    else merged++;
  }
  return {
    clusters: mappings.length,
    resolved,
    byHow,
    ambiguous,
    absent,
    merged,
    coverage: mappings.length ? Number((resolved / mappings.length).toFixed(3)) : 0,
  };
}
