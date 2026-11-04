/**
 * Gate ablation switches: defaults are unchanged; each switch only loosens.
 *
 * Synthetic rows only. All switches unset = the current strict gate; an
 * ablated variant may add admissions but must never refuse a baseline accept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as gates from '../../fanfable/src/gates/gates.ts';

const SWITCHES = ['DIRECTION', 'DENIAL', 'SYMMETRIC_STRICT', 'VERBATIM_BOUNDARY', 'THRESHOLD'] as const;

function clearSwitches(): void {
  for (const name of SWITCHES) delete process.env[`FANFABLE_ABLATE_${name}`];
}

function decide(
  row: {
    fromName: string; toName: string; kind: string; evidence: string;
    kindSource?: string; anchorEvidence?: string; confidence?: number;
  },
  minConfidence = 0,
): boolean {
  clearSwitches();
  return gates.provenRelation(
    { fromId: 1, toId: 2, confidence: 1, ...row },
    {
      chunkText: row.anchorEvidence ? `${row.evidence} ${row.anchorEvidence}` : row.evidence,
      minConfidence,
    },
  ).ok;
}

function ablated(
  switchName: (typeof SWITCHES)[number],
  row: Parameters<typeof decide>[0],
  minConfidence = 0,
): boolean {
  clearSwitches();
  process.env[`FANFABLE_ABLATE_${switchName}`] = '1';
  try {
    return gates.provenRelation(
      { fromId: 1, toId: 2, confidence: 1, ...row },
      {
        chunkText: row.anchorEvidence ? `${row.evidence} ${row.anchorEvidence}` : row.evidence,
        minConfidence,
      },
    ).ok;
  } finally {
    clearSwitches();
  }
}

test('switches off: the keeper-precision probes keep their answers', () => {
  const golden: [Parameters<typeof decide>[0], boolean][] = [
    [{ fromName: 'Mara', toName: 'Tor', kind: 'master of', evidence: 'Mara was trained by Tor.' }, false],
    [{ fromName: 'Mara', toName: 'Tor', kind: 'master of', evidence: "Mara was Tor's student." }, false],
    [{ fromName: 'Mara', toName: 'Tor', kind: 'employer of', evidence: "Mara was Tor's employee." }, false],
    [{ fromName: 'Mara', toName: 'Tor', kind: 'parent of', evidence: 'Mara was born to Tor.' }, false],
    [{ fromName: 'Mara', toName: 'Tor', kind: 'servant of', evidence: "Mara was Tor's student." }, true],
    [{ fromName: 'Mara', toName: 'Tor', kind: 'friend of', evidence: 'Mara told Tor that her friend had arrived.' }, false],
    [{ fromName: 'Mara', toName: 'Tor', kind: 'enemy of', evidence: 'Mara protected Tor from his enemy.' }, false],
    [{ fromName: 'Mara', toName: 'Tor', kind: 'enemy of', evidence: "Mara admired Tor's enemy." }, false],
    [{ fromName: 'Mara', toName: 'Tor', kind: 'friend of', evidence: 'Mara did not trust Tor.' }, false],
    [{ fromName: 'Mara', toName: 'Tor', kind: 'ally of', kindSource: 'trusted', evidence: 'Mara did not trust Tor.' }, false],
    [{ fromName: 'Mara', toName: 'Tor', kind: 'friend of', evidence: 'Mara never trusted Tor.' }, false],
    [{ fromName: 'Mara', toName: 'Tor', kind: 'friend of', evidence: 'Mara and Tor are partners.' }, true],
    [{ fromName: 'Mara', toName: 'Tor', kind: 'friend of', evidence: "Mara is Tor's partner." }, true],
    [{ fromName: 'Mara', toName: 'Tor', kind: 'aunt of', evidence: 'Aunt Mara took Tor to the market.' }, true],
    [
      {
        fromName: 'Mara', toName: 'Tor', kind: 'feared',
        evidence: 'She feared him.', anchorEvidence: 'Mara was afraid of Tor.',
      },
      false,
    ],
  ];
  for (const [row, expected] of golden) assert.equal(decide(row), expected, JSON.stringify(row));
  for (const name of SWITCHES) assert.equal(process.env[`FANFABLE_ABLATE_${name}`], undefined);
});

test('each switch only loosens; it never refuses a baseline accept', () => {
  const rows: Parameters<typeof decide>[0][] = [
    { fromName: 'Mara', toName: 'Tor', kind: 'mentor of', evidence: "Mara was Tor's mentor.", confidence: 1 },
    { fromName: 'Mara', toName: 'Tor', kind: 'mentor of', evidence: "Tor was Mara's mentor.", confidence: 1 },
    { fromName: 'Mara', toName: 'Tor', kind: 'friend of', evidence: 'Mara did not trust Tor.', confidence: 1 },
    { fromName: 'Mara', toName: 'Tor', kind: 'enemy of', evidence: 'Mara felt hostile toward Tor.', confidence: 1 },
    { fromName: 'Mara', toName: 'Tor', kind: 'friend of', evidence: "Mara is Tor's friend", confidence: 1 },
    { fromName: 'Mara', toName: 'Tor', kind: 'mentor of', evidence: "Mara was Tor's mentor.", confidence: 0.2 },
  ];
  // A chunk that makes the verbatim-boundary row differ: the strict check
  // needs a word boundary after "friend"; the audit-style ablation uses includes.
  const chunkOverride = (row: Parameters<typeof decide>[0]): string => {
    if (row.evidence === "Mara is Tor's friend") return "Mara is Tor's friendship.";
    return row.evidence;
  };

  const run = (switchName: (typeof SWITCHES)[number] | null): boolean[] => {
    clearSwitches();
    if (switchName) process.env[`FANFABLE_ABLATE_${switchName}`] = '1';
    try {
      return rows.map((row) => gates.provenRelation(
        { fromId: 1, toId: 2, confidence: 1, ...row },
        { chunkText: chunkOverride(row), minConfidence: 0.7 },
      ).ok);
    } finally {
      clearSwitches();
    }
  };

  const baseline = run(null);
  assert.deepEqual(baseline, [true, false, false, false, false, false]);
  for (const name of SWITCHES) {
    const current = run(name);
    for (let index = 0; index < rows.length; index++) {
      if (baseline[index]) assert.equal(current[index], true, `${name} refused a baseline accept at row ${index}`);
    }
    assert.ok(current.some((value, index) => value && !baseline[index]), `${name} moved at least one admission`);
  }
});

test('direction ablation admits the reversed row', () => {
  assert.equal(
    ablated('DIRECTION', { fromName: 'Mara', toName: 'Tor', kind: 'mentor of', evidence: "Tor was Mara's mentor." }),
    true,
  );
});

test('denial ablation admits the denied row', () => {
  assert.equal(
    ablated('DENIAL', { fromName: 'Mara', toName: 'Tor', kind: 'friend of', evidence: 'Mara did not trust Tor.' }),
    true,
  );
});

test('symmetric-strict ablation restores the broad family noun', () => {
  assert.equal(
    ablated('SYMMETRIC_STRICT', { fromName: 'Mara', toName: 'Tor', kind: 'enemy of', evidence: 'Mara felt hostile toward Tor.' }),
    true,
  );
});

test('verbatim-boundary ablation uses audit-style includes', () => {
  clearSwitches();
  process.env.FANFABLE_ABLATE_VERBATIM_BOUNDARY = '1';
  try {
    assert.equal(
      gates.provenRelation(
        { fromId: 1, toId: 2, confidence: 1, fromName: 'Mara', toName: 'Tor', kind: 'friend of', evidence: "Mara is Tor's friend" },
        { chunkText: "Mara is Tor's friendship.", minConfidence: 0 },
      ).ok,
      true,
    );
  } finally {
    clearSwitches();
  }
});

test('threshold ablation admits a below-threshold claim', () => {
  assert.equal(
    ablated('THRESHOLD', { fromName: 'Mara', toName: 'Tor', kind: 'mentor of', evidence: "Mara was Tor's mentor.", confidence: 0.2 }, 0.7),
    true,
  );
});
