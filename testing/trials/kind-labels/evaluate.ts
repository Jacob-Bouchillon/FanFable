/**
 * §5 evaluation of kind labels as described concepts (trial only).
 *
 * Hand-written passages, generic names, no book terms. Each case is sent
 * through the real relations prompt with the configured local model; every
 * returned relation is checked by the same pure guard extraction uses.
 *
 * usage: node testing/trials/kind-labels/evaluate.ts [model] [out.json]
 *
 * Reports concept accuracy on the mapping cases, false proposals on the
 * co-occurrence and three-character cases, and labels chosen outside the
 * concept set (which the guard can only park, never bank).
 */
import { writeFileSync } from 'node:fs';
import { clientFrom } from '../../../fanfable/src/llm.ts';
import { CLOSED_ROLE_KINDS, provenRelation, relationsSystemPrompt } from '../../../fanfable/src/lorebook.ts';
import { extractJson } from '../../../fanfable/src/json.ts';

const MODEL = process.argv[2] ?? 'qwen3.5:9b';
const OUT = process.argv[3] ?? '/tmp/opencode/kind-labels-eval.json';

const llm = clientFrom({
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: MODEL,
  temperature: 0.1,
  maxTokens: 1200,
  contextTokens: 16384,
  timeoutMs: 600_000,
});

interface Expected {
  from: string;
  to: string;
  concepts: string[];
}

interface Case {
  id: string;
  type: 'mapping' | 'none' | 'bound' | 'negation' | 'uncertainty' | 'change';
  names: string[];
  text: string;
  expects: Expected[];
}

const CASES: Case[] = [
  {
    id: 'aversion-disliked',
    type: 'mapping',
    names: ['Mara', 'Tor'],
    text: 'Mara disliked Tor from the first day.',
    expects: [{ from: 'Mara', to: 'Tor', concepts: ['disliked'] }],
  },
  {
    id: 'aversion-loathed',
    type: 'mapping',
    names: ['Mara', 'Tor'],
    text: 'Mara loathed Tor in a quiet, patient way.',
    expects: [{ from: 'Mara', to: 'Tor', concepts: ['disliked'] }],
  },
  {
    id: 'aversion-detested',
    type: 'mapping',
    names: ['Mara', 'Tor'],
    text: 'Mara detested Tor and avoided him whenever she could.',
    expects: [{ from: 'Mara', to: 'Tor', concepts: ['disliked'] }],
  },
  {
    id: 'near-miss-aversion',
    type: 'mapping',
    names: ['Mara', 'Tor'],
    text: 'Mara disliked Tor but never lifted a finger against him.',
    expects: [{ from: 'Mara', to: 'Tor', concepts: ['disliked'] }],
  },
  {
    id: 'near-miss-enmity',
    type: 'mapping',
    names: ['Mara', 'Tor'],
    text: 'Mara hunted Tor through the pass, meaning to kill him.',
    expects: [{ from: 'Mara', to: 'Tor', concepts: ['enemy of'] }],
  },
  {
    id: 'cooccurrence-only',
    type: 'none',
    names: ['Mara', 'Tor'],
    text: 'Mara and Tor waited in the same line at the market.',
    expects: [],
  },
  {
    id: 'three-characters',
    type: 'bound',
    names: ['Mara', 'Tor', 'Corin'],
    text: 'Mara loathed Tor, and Corin watched from the doorway.',
    expects: [{ from: 'Mara', to: 'Tor', concepts: ['disliked'] }],
  },
  {
    id: 'negation',
    type: 'negation',
    names: ['Mara', 'Tor'],
    text: 'Mara did not trust Tor with the key.',
    expects: [],
  },
  {
    id: 'uncertainty',
    type: 'uncertainty',
    names: ['Mara', 'Tor'],
    text: 'Perhaps Mara feared Tor, though she never admitted it.',
    expects: [],
  },
  {
    id: 'change-over-time',
    type: 'change',
    names: ['Mara', 'Tor'],
    text: 'Mara and Tor were friends for years, until the quarrel ended it. After that they were enemies.',
    expects: [
      { from: 'Mara', to: 'Tor', concepts: ['friend of'] },
      { from: 'Mara', to: 'Tor', concepts: ['enemy of'] },
    ],
  },
];

interface Returned {
  from: string;
  to: string;
  kind: string;
  kindSource: string;
  evidence: string;
  modality: string;
  guard: 'ok' | string;
  inSet: boolean;
}

const keyOf = (a: string, b: string): string =>
  [a, b]
    .map((name) => name.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim())
    .sort()
    .join('|');

async function ask(testCase: Case): Promise<Returned[]> {
  const system = `${relationsSystemPrompt()}\n\nKNOWN ENTITIES:\n${testCase.names.map((name) => `- ${name}`).join('\n')}`;
  const res = await llm.chat({
    system,
    messages: [{ role: 'user', content: `PASSAGES:\n[#0] untitled | ${testCase.id}\n${testCase.text}` }],
    temperature: 0.1,
    maxTokens: 1200,
  });
  const parsed = extractJson<{ relations?: Record<string, unknown>[] }>(res.text ?? '') ?? {};
  const list = Array.isArray(parsed.relations) ? parsed.relations : [];
  return list
    .map((raw): Returned => {
      const from = String(raw.from ?? '').trim();
      const to = String(raw.to ?? '').trim();
      const kind = String(raw.kind ?? '').trim().toLowerCase();
      const kindSource = String(raw.kind_source ?? '').trim();
      const evidence = String(raw.evidence ?? '').trim() || testCase.text;
      const modality = String(raw.modality ?? 'asserted').trim().toLowerCase();
      const decision = from && to
        ? provenRelation(
            { fromId: 1, toId: 2, fromName: from, toName: to, kind, evidence, kindSource },
            { chunkText: testCase.text },
          )
        : { ok: false, reason: 'endpoint-unnamed' };
      return {
        from,
        to,
        kind,
        kindSource,
        evidence,
        modality,
        guard: decision.ok ? 'ok' : decision.reason ?? 'unproven',
        inSet: CLOSED_ROLE_KINDS.includes(kind),
      };
    })
    .filter((row) => row.from && row.to);
}

const rows: Record<string, unknown>[] = [];
const outOfSet = new Set<string>();
let mappingTotal = 0;
let mappingHit = 0;
let guardHit = 0;
let falseProposals = 0;
let cooccurrenceProposals = 0;
let threeCharacterWrong = 0;
let negationTrusted = 0;
let uncertaintyAsserted = 0;
let changeKinds: string[] = [];

for (const testCase of CASES) {
  const returned = await ask(testCase);
  for (const row of returned) if (!row.inSet) outOfSet.add(row.kind);

  const matched = new Set<number>();
  let caseHits = 0;
  let caseGuardHits = 0;
  for (const expected of testCase.expects) {
    const pair = keyOf(expected.from, expected.to);
    const hitAt = returned.findIndex((row, at) => {
      if (matched.has(at)) return false;
      return keyOf(row.from, row.to) === pair && expected.concepts.includes(row.kind);
    });
    if (hitAt >= 0) {
      matched.add(hitAt);
      caseHits++;
      if (returned[hitAt]!.guard === 'ok') caseGuardHits++;
    }
  }

  for (let at = 0; at < returned.length; at++) {
    if (matched.has(at)) continue;
    const row = returned[at]!;
    if (testCase.type === 'none') cooccurrenceProposals++;
    if (testCase.type === 'bound') {
      const expectedKeys = new Set(testCase.expects.map((e) => keyOf(e.from, e.to)));
      if (!expectedKeys.has(keyOf(row.from, row.to))) threeCharacterWrong++;
    }
    if (testCase.type === 'negation') {
      if (row.kind === 'trusted') negationTrusted++;
    }
    if (testCase.type === 'uncertainty') {
      if (row.guard === 'ok' && row.modality === 'asserted') uncertaintyAsserted++;
    }
    if (testCase.type === 'change') {
      changeKinds.push(row.kind);
    }
    // Any unmatched returned relation is a false proposal for the mapping and
    // bound cases (wrong pair or a concept the passage does not express).
    if (testCase.type === 'mapping') falseProposals++;
  }

  if (testCase.type === 'mapping') {
    mappingTotal += testCase.expects.length;
    mappingHit += caseHits;
    guardHit += caseGuardHits;
  }
  if (testCase.type === 'bound') {
    mappingTotal += testCase.expects.length;
    mappingHit += caseHits;
    guardHit += caseGuardHits;
  }

  rows.push({
    id: testCase.id,
    type: testCase.type,
    text: testCase.text,
    expected: testCase.expects,
    returned: returned.map((row) => ({
      from: row.from,
      to: row.to,
      kind: row.kind,
      kind_source: row.kindSource,
      modality: row.modality,
      guard: row.guard,
      inSet: row.inSet,
    })),
    conceptHit: caseHits,
    guardHit: caseGuardHits,
  });
}

const summary = {
  model: MODEL,
  cases: rows.length,
  mapping: {
    expected: mappingTotal,
    conceptHits: mappingHit,
    conceptAccuracy: mappingTotal ? Number((mappingHit / mappingTotal).toFixed(3)) : null,
    guardAcceptedHits: guardHit,
    guardAcceptedAccuracy: mappingTotal ? Number((guardHit / mappingTotal).toFixed(3)) : null,
  },
  falseProposals,
  cooccurrenceProposals,
  threeCharacterWrongPairs: threeCharacterWrong,
  negationStoredAsTrusted: negationTrusted,
  uncertaintyBankedAsserted: uncertaintyAsserted,
  changeOverTimeKinds: changeKinds,
  outsideConceptSet: [...outOfSet].sort(),
};

const report = { summary, cases: rows };
writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify(summary, null, 1));
console.log(`\nwritten ${OUT}`);
