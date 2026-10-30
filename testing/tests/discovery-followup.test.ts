/**
 * Discovery 4 follow-up math: weighted yields, ranking, seat allocation,
 * decision branches, packet spread and leakage checks.
 * Pure functions only — no DB, no model. Generic names throughout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateSeats,
  compareStrata,
  csvCell,
  decide,
  mulberry32,
  parseCsv,
  rankStrata,
  requiredN,
  selectFollowup,
  summarize,
  wilson,
  type SampleRow,
  type StratumYield,
  type Verdict,
} from '../trials/discovery/allocate-followup.ts';
import {
  JUDGE_BLOCK,
  findLeakage,
  renderPacket,
  spreadPick,
  type FollowupPacket,
} from '../trials/discovery/sample-followup.ts';

function mkRows(spec: string, weight = 1): { weight: number; verdict: Verdict }[] {
  return [...spec].map((ch) => {
    assert.ok(ch === 'A' || ch === 'B' || ch === 'C' || ch === 'D', `bad verdict ${ch}`);
    return { weight, verdict: ch as Verdict };
  });
}

function mkYield(stratum: string, abLo: number, aLo: number): StratumYield {
  return {
    stratum,
    judged: 10,
    weight: 10,
    counts: { A: 0, B: 0, C: 0, D: 0 },
    wsum: { A: 0, B: 0, C: 0, D: 0 },
    share: { A: 0, B: 0, C: 0, D: 0 },
    shareAB: 0,
    ciAB: { lo: abLo, hi: abLo + 0.1 },
    ciA: { lo: aLo, hi: aLo + 0.1 },
    ciB: { lo: 0, hi: 0.1 },
    ciC: { lo: 0.5, hi: 0.9 },
  };
}

function mkSampleRow(id: string, stratum: string): SampleRow {
  return { id, pair: `North ${id} / South ${id}`, stratum, weight: 1, locators: 'p. 1' };
}

test('wilson returns a null interval for n=0', () => {
  assert.deepEqual(wilson(0.5, 0), { lo: 0, hi: 0 });
});

test('wilson centers near one half for large n', () => {
  const v = wilson(0.5, 100);
  assert.ok(v.lo > 0.4 && v.lo < 0.41, `lo ${v.lo}`);
  assert.ok(v.hi > 0.59 && v.hi < 0.6, `hi ${v.hi}`);
});

test('wilson clamps perfect and empty sheets inside the unit range', () => {
  const hit = wilson(1, 80);
  assert.ok(hit.lo > 0.94 && hit.hi <= 1, `hit ${hit.lo}–${hit.hi}`);
  const miss = wilson(0, 80);
  assert.equal(miss.lo, 0);
  assert.ok(miss.hi < 0.05, `miss hi ${miss.hi}`);
});

test('summarize weights shares by pop_weight', () => {
  const y = summarize('s1', [
    { weight: 3, verdict: 'A' },
    { weight: 1, verdict: 'C' },
  ]);
  assert.equal(y.judged, 2);
  assert.equal(y.weight, 4);
  assert.equal(y.share.A, 0.75);
  assert.equal(y.share.C, 0.25);
  assert.equal(y.counts.A, 1);
});

test('compareStrata prefers the higher A+B lower bound', () => {
  assert.ok(compareStrata(mkYield('s2', 0.2, 0.1), mkYield('s1', 0.1, 0.05)) < 0);
  assert.ok(compareStrata(mkYield('s1', 0.1, 0.05), mkYield('s2', 0.2, 0.1)) > 0);
});

test('compareStrata breaks A+B ties on the A lower bound', () => {
  assert.ok(compareStrata(mkYield('s2', 0.2, 0.15), mkYield('s1', 0.2, 0.1)) < 0);
});

test('compareStrata breaks full ties on stratum name', () => {
  assert.ok(compareStrata(mkYield('s-a', 0.2, 0.1), mkYield('s-b', 0.2, 0.1)) < 0);
  assert.equal(compareStrata(mkYield('s-a', 0.2, 0.1), mkYield('s-a', 0.2, 0.1)), 0);
});

test('rankStrata orders productive strata before empty ones', () => {
  const ranked = rankStrata([
    summarize('aaa', mkRows('C'.repeat(10))),
    summarize('zzz', mkRows(`AA${'C'.repeat(8)}`)),
    summarize('mmm', mkRows(`B${'C'.repeat(19)}`)),
  ]);
  assert.deepEqual(
    ranked.map((y) => y.stratum),
    ['zzz', 'mmm', 'aaa'],
  );
});

test('allocateSeats splits proportionally by largest remainder', () => {
  const { seats, shortfall } = allocateSeats(
    [
      { stratum: 'a', weight: 50, rows: 50 },
      { stratum: 'b', weight: 30, rows: 30 },
      { stratum: 'c', weight: 20, rows: 20 },
    ],
    24,
  );
  assert.deepEqual(Object.fromEntries(seats), { a: 12, b: 7, c: 5 });
  assert.equal(shortfall, 0);
});

test('allocateSeats breaks remainder ties deterministically', () => {
  const cands = [
    { stratum: 'm', weight: 1, rows: 5 },
    { stratum: 'n', weight: 1, rows: 5 },
    { stratum: 'o', weight: 1, rows: 5 },
  ];
  const first = allocateSeats(cands, 4);
  const second = allocateSeats(cands, 4);
  assert.deepEqual(Object.fromEntries(first.seats), { m: 2, n: 1, o: 1 });
  assert.deepEqual(Object.fromEntries(first.seats), Object.fromEntries(second.seats));
});

test('allocateSeats caps by available rows and redistributes', () => {
  const { seats, shortfall } = allocateSeats(
    [
      { stratum: 'a', weight: 90, rows: 2 },
      { stratum: 'b', weight: 10, rows: 50 },
    ],
    24,
  );
  assert.deepEqual(Object.fromEntries(seats), { a: 2, b: 22 });
  assert.equal(shortfall, 0);
});

test('allocateSeats reports shortfall when strata are exhausted', () => {
  const { seats, shortfall } = allocateSeats(
    [
      { stratum: 'a', weight: 1, rows: 2 },
      { stratum: 'b', weight: 1, rows: 1 },
    ],
    10,
  );
  assert.deepEqual(Object.fromEntries(seats), { a: 2, b: 1 });
  assert.equal(shortfall, 7);
});

test('allocateSeats gives nothing outside the top-k', () => {
  const { seats, shortfall } = allocateSeats(
    [
      { stratum: 's1', weight: 10, rows: 50 },
      { stratum: 's2', weight: 10, rows: 50 },
      { stratum: 's3', weight: 10, rows: 50 },
      { stratum: 's4', weight: 1000, rows: 50 },
    ],
    24,
    3,
  );
  assert.ok(!seats.has('s4'), 'fourth stratum holds no seats');
  assert.equal((seats.get('s1') ?? 0) + (seats.get('s2') ?? 0) + (seats.get('s3') ?? 0), 24);
  assert.equal(shortfall, 0);
});

test('selectFollowup is byte-identical under seed 42', () => {
  const rows = new Map<string, SampleRow[]>([
    ['s1', ['s1-01', 's1-02', 's1-03', 's1-04', 's1-05'].map((id) => mkSampleRow(id, 's1'))],
    ['s2', ['s2-01', 's2-02', 's2-03', 's2-04', 's2-05'].map((id) => mkSampleRow(id, 's2'))],
  ]);
  const ranked = [mkYield('s1', 0.2, 0.1), mkYield('s2', 0.1, 0.05)];
  const seats = new Map([
    ['s1', 2],
    ['s2', 2],
  ]);
  const first = selectFollowup(rows, ranked, seats, mulberry32(42));
  const second = selectFollowup(rows, ranked, seats, mulberry32(42));
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((f) => f.fid),
    ['F001', 'F002', 'F003', 'F004'],
  );
  assert.equal(new Set(first.map((f) => f.sampleId)).size, 4);
});

test('selectFollowup never takes more than seated', () => {
  const rows = new Map<string, SampleRow[]>([
    ['s1', ['s1-01', 's1-02', 's1-03'].map((id) => mkSampleRow(id, 's1'))],
  ]);
  const out = selectFollowup(rows, [mkYield('s1', 0.2, 0.1)], new Map([['s1', 1]]), mulberry32(42));
  assert.equal(out.length, 1);
});

test('decide stops on an all-C sheet', () => {
  const d = decide(summarize('overall', mkRows('C'.repeat(80))), 0);
  assert.equal(d.branch, 'STOP');
  assert.match(d.detail, /80%/);
  assert.equal(d.requiredN, null);
});

test('decide stops when the A+B ceiling stays under five percent', () => {
  const d = decide(summarize('overall', mkRows(`B${'D'.repeat(40)}${'C'.repeat(159)}`)), 0);
  assert.equal(d.branch, 'STOP');
  assert.match(d.detail, /upper bound/);
});

test('decide singles out quotable yield with three quotes', () => {
  const d = decide(summarize('overall', mkRows(`${'A'.repeat(10)}${'C'.repeat(70)}`)), 10);
  assert.equal(d.branch, 'SINGLE');
  assert.match(d.detail, /single-sentence/);
});

test('decide withholds SINGLE when quotes fall short', () => {
  const d = decide(summarize('overall', mkRows(`${'A'.repeat(10)}${'C'.repeat(70)}`)), 2);
  assert.equal(d.branch, 'INCONCLUSIVE');
  assert.ok(d.requiredN !== null);
});

test('decide multis on multi-sentence yield while single stays low', () => {
  const d = decide(summarize('overall', mkRows(`${'B'.repeat(20)}${'C'.repeat(60)}`)), 0);
  assert.equal(d.branch, 'MULTI');
  assert.match(d.detail, /multi-sentence/);
});

test('decide stays inconclusive in the middle ground', () => {
  const d = decide(summarize('overall', mkRows(`${'A'.repeat(5)}${'B'.repeat(5)}${'C'.repeat(70)}`)), 5);
  assert.equal(d.branch, 'INCONCLUSIVE');
  assert.deepEqual(d.requiredN, { atObserved: 169, worstCase: 385 });
});

test('requiredN matches the textbook worst case', () => {
  assert.equal(requiredN(0.5), 385);
  assert.equal(requiredN(0.125), 169);
});

test('parseCsv round-trips quoted cells', () => {
  const head = ['id', 'pair', 'note'];
  const body = [
    ['a', 'North Rook / South Vey', 'plain'],
    ['b', 'East,Comma / West', 'with "quotes"'],
  ];
  const text = [head.join(','), ...body.map((r) => r.map(csvCell).join(','))].join('\n');
  const back = parseCsv(text);
  assert.deepEqual(
    back.map((r) => [r.id, r.pair, r.note]),
    body,
  );
});

test('spreadPick keeps short lists whole', () => {
  assert.deepEqual(spreadPick([4, 9]), [4, 9]);
});

test('spreadPick spans earliest to latest at cap 6', () => {
  const picks = spreadPick([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(picks.length, 6);
  assert.equal(picks[0], 1);
  assert.equal(picks[picks.length - 1], 12);
  assert.ok(picks.every((v, i) => i === 0 || v > picks[i - 1]!));
});

test('spreadPick is deterministic covering seven items', () => {
  const picks = spreadPick([1, 2, 3, 4, 5, 6, 7]);
  assert.equal(picks.length, 6);
  assert.ok(picks.includes(1) && picks.includes(7));
});

test('findLeakage clears the judge rubric', () => {
  assert.deepEqual(findLeakage(JUDGE_BLOCK), []);
});

test('findLeakage flags stratum vocabulary', () => {
  const found = findLeakage('stratum 4-9/t1 pop_weight 2');
  assert.ok(found.includes('stratum'));
  assert.ok(found.includes('pop_weight'));
});

test('rendered packets carry pair and locators without leakage', () => {
  const packet: FollowupPacket = {
    uid: 'F001',
    pair: 'Rook Hale / Sable Vey',
    blocks: [
      {
        locator: 'p. 1',
        chunkId: 1,
        seq: 1,
        before: '',
        beforeLocator: '',
        text: 'Rook Hale met Sable Vey at the gate.',
        after: '',
        afterLocator: '',
      },
    ],
  };
  const text = renderPacket(packet);
  assert.ok(text.includes('F001'));
  assert.ok(text.includes('Rook Hale / Sable Vey'));
  assert.ok(text.includes('p. 1'));
  assert.deepEqual(findLeakage(text), []);
});
