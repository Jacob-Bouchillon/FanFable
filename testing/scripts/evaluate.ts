/**
 * Retrieval evaluation.
 *
 * Coverage of a word is a weak measure: a book mentions its own characters on
 * every page, so "does the context contain the name" passes for a plain text
 * search. This measures the things a text search cannot do:
 *
 *   multi-hop recall     the answer is two connections away from the focus
 *   connection recall    the *type* of relationship, not just the name
 *   story recall         what the story knows, believes and wants
 *   evidence rate        how much of what is asserted is backed by a passage
 *   cost                 words in the context, and time to build it
 *
 * Three variants are compared:
 *   A  FTS5 only           passages a text search returns
 *   B  FTS5 + fact sheet   passages plus the name-filtered lore brief
 *                            (what the system did before the graph)
 *   C  graph enhanced      passages plus graph traversal, the connections
 *                            they hang from, and the evidence behind them
 *
 *   node testing/scripts/evaluate.ts <db> <project> [questions.json]
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Db } from '../../fanfable/src/core/db.ts';
import * as lore from '../../fanfable/src/answer/lore.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import * as graph from '../../fanfable/src/graph.ts';
import * as retrieval from '../../fanfable/src/answer/retrieval.ts';
import { MockProvider } from '../../fanfable/src/core/llm.ts';

interface Question {
  q: string;
  focus: string[];
  /** Terms that answer the question. */
  expect: string[][];
  /** The relationship type the answer requires, if any. */
  relation?: string[];
  /** Two hops away: the answer is reached through an intermediate node. */
  twoHops?: boolean;
  /** About what the story knows, believes or wants. */
  story?: boolean;
}

interface EvalResult {
  variant: string;
  coverage: number;
  relationRecall: number;
  /** Recall on the questions whose answer is two connections away. */
  twoHopRecall: number;
  /** Recall on questions about what the story knows, believes and wants. */
  storyRecall: number;
  words: number;
  ms: number;
  /** Claims that carry a quotation or a source location. */
  evidence: number;
  /** Claims that carry a verbatim quotation. */
  quoted: number;
  /** Quotations that really appear in the passage they point at. */
  correct: number;
  /** Claims the context marks as unbacked rather than passing off as fact. */
  disclosed: number;
}

function coverage(text: string, expect: string[][]): number {
  const lower = text.toLowerCase();
  let covered = 0;
  for (const group of expect) {
    if (group.some((term) => lower.includes(term.toLowerCase()))) covered++;
  }
  return expect.length ? covered / expect.length : 1;
}

/**
 * Words that name the same relationship, so "leads" counts for "headmaster
 * of" and "mother" for "parent". Without this the metric measures the
 * extractor's vocabulary rather than whether the relationship was found.
 */
const RELATION_SYNONYMS: Record<string, string[]> = {
  aunt: ['aunt of', 'relative', 'niece', 'nephew'],
  uncle: ['uncle of', 'relative'],
  cousin: ['cousin of', 'relative'],
  nephew: ['nephew of', 'niece', 'relative', 'sibling'],
  niece: ['niece of', 'nephew', 'relative', 'sibling'],
  grandmother: ['mother', 'parent', 'grandmother'],
  grandfather: ['father', 'parent', 'grandfather'],
  mother: ['grandmother', 'parent', 'mother'],
  father: ['grandfather', 'parent', 'father'],
  parent: ['mother', 'father', 'parent'],
  headmaster: ['leads', 'headmaster'],
  leads: ['headmaster', 'leads'],
  serves: ['works for', 'serves', 'leads'],
  enemy: ['hates', 'opponent', 'enemy'],
  antagonist: ['enemy', 'opponent', 'antagonist'],
  'best friend': ['friend', 'best friend'],
  friend: ['friend', 'best friend', 'companion'],
  sibling: ['brother', 'sister', 'sibling'],
  brother: ['sibling', 'brother'],
  'son of': ['son of', 'child of', 'nephew', 'niece'],
  'child of': ['child of', 'son of', 'daughter of'],
};

function relationScore(text: string, relations: string[]): number {
  if (!relations.length) return 1;
  const lower = text.toLowerCase();
  const hit = relations.filter((r) => {
    if (lower.includes(r.toLowerCase())) return true;
    const family = RELATION_SYNONYMS[r.toLowerCase()] ?? [];
    return family.some((alt) => lower.includes(alt.toLowerCase()));
  }).length;
  return hit / relations.length;
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Measure the evidence behind the claims in a context.
 *
 * A claim is a line that asserts something: a connection, a fact, a motive, a
 * piece of knowledge, a description of a person. Each is checked for:
 *
 *   evidence  — a quotation or a source location (page, chapter, passage)
 *   quoted    — a verbatim quotation
 *   correct   — a quotation that really appears in the passage it points at
 *
 * A claim that is explicitly marked as unbacked or inferred counts as
 * *honest* rather than as evidence: the point is not to hide it, but to
 * report it as what it is.
 */
function evidenceReport(
  text: string,
  db: Db,
  projectId: number,
  verbose = false,
): { evidence: number; quoted: number; correct: number; claims: number; disclosed: number } {
  const claims = text
    .split('\n')
    .filter((l) => l.trim().startsWith('- '))
    .filter((l) => l.includes('-->') || /:/.test(l.slice(2)));
  if (!claims.length) return { evidence: 1, quoted: 1, correct: 1, claims: 0, disclosed: 0 };

  // The passages the context points at, so a quotation can be checked.
  const passages = db.all<{ id: number; text: string; locator: string }>(
    'SELECT id, text, locator FROM canon_chunk WHERE project_id = ?',
    projectId,
  );
  const haystacks = passages.map((p) => p.text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' '));
  const hasLocation = /\bp\. ?\d+|\(chapter \d+\)|chapter [a-z0-9]+ \(p\. ?\d+\)/i;

  let withEvidence = 0;
  let withQuote = 0;
  let correct = 0;
  let checkedQuotes = 0;
  let asserted = 0;
  let disclosed = 0;

  for (const line of claims) {
    // A quotation may contain a straight quote inside it, so the curly marks
    // are the reliable ones.
    const quote = /“([^”]{8,})”/.exec(line)?.[1] ?? /"([^"]{12,})"/.exec(line)?.[1];
    const located = hasLocation.test(line);
    const hasQuoteMark = /“[^”]{6,}”/.test(line) || /"[^"]{12,}"/.test(line);
    // A claim that says outright that it is unbacked, inferred or uncertain
    // is not being passed off as fact, so it is counted as a disclosed gap
    // rather than as an unsupported claim.
    const gap = /\[unbacked claim\]|\[inferred\]|\[uncertain\]|\[needs_review\]|\[rejected\]/i.test(line);
    if (gap) {
      disclosed++;
      continue;
    }
    asserted++;
    if (quote || located || hasQuoteMark) withEvidence++;
    else if (verbose) console.log(`    no evidence: ${line.slice(0, 150)}`);
    if (quote || hasQuoteMark) {
      withQuote++;
      const needle = (quote ?? '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (needle.length > 8) {
        checkedQuotes++;
        if (haystacks.some((h) => h.includes(needle))) correct++;
      }
    }
  }

  return {
    evidence: asserted ? withEvidence / asserted : 1,
    quoted: asserted ? withQuote / asserted : 1,
    correct: checkedQuotes ? correct / checkedQuotes : 1,
    claims: claims.length,
    disclosed: claims.length ? disclosed / claims.length : 0,
  };
}

async function evaluate(
  db: Db,
  projectId: number,
  llm: MockProvider,
  questions: Question[],
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];

  for (const variant of ['A fts5 only', 'B fts5 + fact sheet', 'C graph enhanced'] as const) {
    let covered = 0;
    let relationHit = 0;
    let relationTotal = 0;
    let twoHopHit = 0;
    let twoHopTotal = 0;
    let storyHit = 0;
    let storyTotal = 0;
    let wordCount = 0;
    let evidence = 0;
    let quoted = 0;
    let correct = 0;
    let disclosed = 0;
    const started = Date.now();

    for (const question of questions) {
      let text = '';
      if (variant === 'A fts5 only') {
        const passages = lore.searchCanon(db, projectId, `${question.q} ${question.focus.join(' ')}`, {
          limit: 6,
        });
        text = lore.formatPassages(passages);
      } else if (variant === 'B fts5 + fact sheet') {
        const passages = lore.searchCanon(db, projectId, `${question.q} ${question.focus.join(' ')}`, {
          limit: 6,
        });
        const brief = lorebook.buildLoreBrief(db, projectId, { names: question.focus });
        text = `${lore.formatPassages(passages)}\n\n${lorebook.formatLoreBrief(brief)}`;
      } else {
        const pkg = await retrieval.retrieve(db, llm, projectId, {
          query: question.q,
          focus: question.focus,
          ...(process.env.EVAL_BUDGET ? { maxWords: Number(process.env.EVAL_BUDGET) } : {}),
          hops: question.twoHops ? 2 : 1,
        });
        text = pkg.text;
      }
      covered += coverage(text, question.expect);
      if (question.relation?.length) {
        const score = relationScore(text, question.relation);
        relationHit += score;
        relationTotal++;
        if (question.twoHops) {
          twoHopHit += score;
          twoHopTotal++;
        }
      }
      if (question.story) {
        storyHit += coverage(text, question.expect);
        storyTotal++;
      }
      wordCount += words(text);
      const report = evidenceReport(text, db, projectId, process.env.EVAL_VERBOSE === '1');
      evidence += report.evidence;
      quoted += report.quoted;
      correct += report.correct;
      disclosed += report.disclosed;
    }

    const ms = Date.now() - started;
    const n = questions.length || 1;
    results.push({
      variant,
      coverage: covered / n,
      relationRecall: relationTotal ? relationHit / relationTotal : 1,
      twoHopRecall: twoHopTotal ? twoHopHit / twoHopTotal : 1,
      storyRecall: storyTotal ? storyHit / storyTotal : 1,
      words: Math.round(wordCount / n),
      ms: Math.round(ms / n),
      evidence: evidence / n,
      quoted: quoted / n,
      correct: correct / n,
      disclosed: disclosed / n,
    });
  }

  return results;
}

/**
 * Build a project with a story in it and evaluate the story-side questions.
 */
async function evaluateStory(): Promise<void> {
  const { buildStoryProject, STORY_QUESTIONS } = await import('./story-fixture.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'fanfable-eval-'));
  const db = new Db(join(dir, 'eval.db'));
  const fixture = resolve(import.meta.dirname, '../tests/fixtures/sample-book.txt');
  const projectId = await buildStoryProject(db, fixture);

  const llm = new MockProvider();
  llm.handler = (req) => {
    if ((req.system ?? '').includes('expand a lore question')) {
      return JSON.stringify({ terms: ['lantern', 'ledger', 'bridge', 'promise'] });
    }
    return '{}';
  };

  const g = graph.loadGraph(db, projectId);
  const storyNodes = [...g.nodes.values()].filter((n) => n.scope === 'story').length;
  console.log(`story project: graph ${g.nodes.size} nodes (${storyNodes} story), ${g.edges.length} connections\n`);

  const results = await evaluate(db, projectId, llm, STORY_QUESTIONS as Question[]);
  console.log(
    'variant                 answer   relation  2-hop    story   evidence   quoted  correct  gaps  words    ms',
  );
  console.log('-------------------------------------------------------------------------------------------');
  for (const r of results) {
    console.log(
      `${r.variant.padEnd(22)} ${(r.coverage * 100).toFixed(0).padStart(5)}%  ${(r.relationRecall * 100)
        .toFixed(0)
        .padStart(7)}%  ${(r.twoHopRecall * 100).toFixed(0).padStart(6)}%  ${(r.storyRecall * 100)
        .toFixed(0)
        .padStart(5)}%  ${(r.evidence * 100).toFixed(0).padStart(8)}%  ${(r.quoted * 100)
        .toFixed(0)
        .padStart(6)}%  ${(r.correct * 100).toFixed(0).padStart(6)}%  ${(r.disclosed * 100)
        .toFixed(0)
        .padStart(4)}%  ${String(r.words).padStart(6)}  ${String(r.ms).padStart(4)}`,
    );
  }
  db.close();
}

async function main(): Promise<void> {
  const dbPath = process.argv[2] ?? process.env.FANFABLE_DB ?? '';
  const projectName = process.argv[3] ?? '';
  const questionFile = process.argv[4] ?? '';
  if (!dbPath || !projectName) {
    console.log('usage: node testing/scripts/evaluate.ts <db-path> <project> [questions.json]');
    return;
  }
  if (projectName === '--story') {
    await evaluateStory();
    return;
  }
  const db = new Db(dbPath);
  const project = db.get<{ id: number; name: string }>('SELECT id, name FROM project WHERE name = ?', projectName);
  if (!project) {
    console.log(`no project "${projectName}" in ${dbPath}`);
    return;
  }
  const questions: Question[] = questionFile
    ? (JSON.parse(readFileSync(questionFile, 'utf8')) as Question[])
    : [];

  const llm = new MockProvider();
  llm.handler = (req) => {
    if ((req.system ?? '').includes('expand a lore question')) {
      return JSON.stringify({ terms: ['bridge', 'lantern', 'ledger', 'promise'] });
    }
    return '{}';
  };

  const g = graph.loadGraph(db, project.id);
  const canonNodes = [...g.nodes.values()].filter((n) => n.scope === 'canon').length;
  const storyNodes = [...g.nodes.values()].filter((n) => n.scope === 'story').length;
  console.log(`project: ${project.name}  (${dbPath})`);
  console.log(`graph: ${g.nodes.size} nodes (${canonNodes} canon, ${storyNodes} story), ${g.edges.length} connections`);
  console.log(`questions: ${questions.length}\n`);

  const results = await evaluate(db, project.id, llm, questions);
  console.log(
    'variant                 answer   relation  2-hop    story   evidence   quoted  correct  gaps  words    ms',
  );
  console.log('-------------------------------------------------------------------------------------------');
  for (const r of results) {
    console.log(
      `${r.variant.padEnd(22)} ${(r.coverage * 100).toFixed(0).padStart(5)}%  ${(r.relationRecall * 100)
        .toFixed(0)
        .padStart(7)}%  ${(r.twoHopRecall * 100).toFixed(0).padStart(6)}%  ${(r.storyRecall * 100)
        .toFixed(0)
        .padStart(5)}%  ${(r.evidence * 100).toFixed(0).padStart(8)}%  ${(r.quoted * 100)
        .toFixed(0)
        .padStart(6)}%  ${(r.correct * 100).toFixed(0).padStart(6)}%  ${(r.disclosed * 100)
        .toFixed(0)
        .padStart(4)}%  ${String(r.words).padStart(6)}  ${String(r.ms).padStart(4)}`,
    );
  }
  db.close();
}

void main();
