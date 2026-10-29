/**
 * Person folding for trial comparisons (no dependency on product code).
 *
 * The roster holds the same person more than once ("Harry", "Harry Potter",
 * "Ronald Weasley", "Ron Weasley"). Sweep output therefore names the same
 * person two ways, and any comparison that resolves names exactly will read
 * that as disagreement. This folds those rows into one person:
 *
 *   - one form's tokens are a subset of another's ("Harry" in "Harry Potter")
 *   - shared surname and compatible given name ("Ron" / "Ronald" Weasley)
 *
 * It never merges anything in the database. It is a reading aid for trials.
 */

export interface FoldInput {
  id: number;
  name: string;
  aliases: string;
  kind?: string;
}
export interface Person {
  id: number;
  name: string;
  forms: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s: string) => norm(s).split(' ').filter(Boolean);

const nested = (short: string[], long: string[]): boolean =>
  short.length > 0 && short.length < long.length && long.some((_, at) => short.every((w, k) => long[at + k] === w));

const sameSurnameGiven = (a: string[], b: string[]): boolean => {
  if (a.length < 2 || b.length < 2) return false;
  const sa = a[a.length - 1]!;
  const sb = b[b.length - 1]!;
  if (sa.length < 3 || sa !== sb) return false;
  const fa = a[0]!;
  const fb = b[0]!;
  if (fa.length < 3 || fb.length < 3) return false;
  return fa.startsWith(fb) || fb.startsWith(fa);
};

export function foldPeople(entities: FoldInput[]): {
  people: Person[];
  personOf: (id: number) => number;
  idOf: (name: string) => number | null;
  personCount: number;
  displayName: (person: number) => string;
} {
  const people: Person[] = entities.map((e) => ({
    id: e.id,
    name: e.name,
    forms: [e.name, ...(JSON.parse(e.aliases || '[]') as string[])].filter(Boolean),
  }));

  const parent = new Map<number, number>();
  const find = (x: number): number => {
    const p = parent.get(x);
    if (p === undefined || p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  };
  for (const p of people) parent.set(p.id, p.id);

  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const A = people[i]!;
      const B = people[j]!;
      let joined = false;
      for (const fa of A.forms) {
        if (joined) break;
        for (const fb of B.forms) {
          const ta = tokens(fa);
          const tb = tokens(fb);
          if (!ta.length || !tb.length) continue;
          if (ta.join(' ') === tb.join(' ') || nested(ta, tb) || nested(tb, ta) || sameSurnameGiven(ta, tb)) {
            union(A.id, B.id);
            joined = true;
            break;
          }
        }
      }
    }
  }

  const personOf = (id: number): number => find(id);
  const personCount = new Set(people.map((p) => personOf(p.id))).size;

  const byForm = new Map<string, number[]>();
  for (const p of people) {
    for (const f of p.forms) {
      const k = norm(f);
      if (!k) continue;
      byForm.set(k, [...(byForm.get(k) ?? []), p.id]);
    }
  }
  const idOf = (name: string): number | null => {
    const key = norm(name);
    const exact = byForm.get(key);
    if (exact && new Set(exact.map(personOf)).size === 1) return personOf(exact[0]!);
    const ids = new Set<number>();
    for (const [form, list] of byForm) {
      if (form.includes(key) || key.includes(form)) for (const id of list) ids.add(personOf(id));
    }
    return ids.size === 1 ? [...ids][0]! : null;
  };

  // Display name: the stored name of the lowest-id row in the group, never an
  // alias. Choosing the longest form picked text phrases stored as aliases
  // ("Dinky Duddydums", "hook-nosed teacher") and made a judging sheet ask
  // about a string instead of a person.
  const rep = new Map<number, Person & { kind?: string }>();
  for (const p of people) {
    const source = entities.find((e) => e.id === p.id);
    const person = personOf(p.id);
    const current = rep.get(person);
    if (!current || p.id < current.id) rep.set(person, { ...p, kind: source?.kind });
  }
  const display = new Map<number, string>();
  for (const [person, p] of rep) {
    display.set(person, p.kind && p.kind !== 'character' ? `${p.name} (${p.kind})` : p.name);
  }
  const displayName = (person: number): string => display.get(person) ?? String(person);

  return { people, personOf, idOf, personCount, displayName };
}
