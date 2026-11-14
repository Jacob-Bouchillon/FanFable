#!/usr/bin/env node
/**
 * fanfable — local AI fanfiction generator.
 *
 * Command line interface. Everything the prototype can do is reachable here:
 * create/reopen a project, import sources, search lore, plan collaboratively,
 * write and approve chapters, inspect warnings and memory.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Db } from './core/db.ts';
import {
  DEFAULT_LLM_SETTINGS,
  LlmError,
  configPath,
  loadGlobalConfig,
  resolveSettings,
  saveGlobalConfig,
} from './core/llm.ts';
import { clientFrom } from './core/llm.ts';
import type { LlmSettings } from './core/llm.ts';
import * as lore from './answer/lore.ts';
import * as lorebook from './lorebook.ts';
import * as embeddings from './support/embeddings.ts';
import * as graph from './support/graph.ts';
import * as loreDiag from './answer/lore-diagnostics.ts';
import { listConflicts, resolveConflict } from './product/state-conflicts.ts';
import * as memory from './product/memory.ts';
import * as planner from './plan/planner.ts';
import * as continuity from './product/continuity.ts';
import { continuitySettings, filterBySeverity } from './product/continuity-settings.ts';
import * as controller from './plan/controller.ts';
import * as retrieval from './answer/retrieval.ts';
import * as sweep from './extract/sweep.ts';
import * as ruling from './court/ruling.ts';
import * as traceLog from './trace/trace.ts';
import { openTraceReadConnection } from './trace/trace-readonly.ts';
import * as pairThreads from './web/pair-threads.ts';
import * as threadWeb from './web/threads.ts';
import * as meetingWeb from './web/meetings.ts';
import * as noteIngest from './web/note-ingest.ts';
import * as briefWeb from './plan/brief.ts';
import * as identityCheck from './identity/identity-check.ts';
import { characterDossier } from './answer/dossier.ts';
import type { PassageTrail } from './support/graph.ts';
import { truncate } from './core/text.ts';
import { buildTrailsHtml, trailText } from './product/trail-html.ts';
import {
  ageLabel,
  app,
  budgetFlag,
  C,
  defaultDbPath,
  flagNumber,
  flagString,
  globalState,
  heading,
  parseArgs,
  prompt,
  requireProject,
  setGlobalState,
  type Args,
} from './cli/shared.ts';
import { cmdState } from './cli/commands/state.ts';
import { cmdTrace } from './cli/commands/trace.ts';
import { cmdCheck, cmdContinuity, cmdIssues, printIssues } from './cli/commands/checks.ts';
import { cmdConflicts, cmdGraph } from './cli/commands/graph.ts';
import { cmdLlm, maskApiKey } from './cli/commands/llm.ts';

/* ------------------------------------------------------------------- args */

/* ------------------------------------------------------------------- help */

const HELP = `
${C.bold('fanfable')} — local AI fanfiction generator

${C.bold('USAGE')}
  fanfable [--db <path>] [--project <name>] <command> [args]

${C.bold('PROJECT')}
  project create <name>            Create a project
  project list                     List projects
  project use <name>               Set the active project
  project settings [--provider p] [--model m] [--base-url u] [--temperature t]
                   [--recognition on|off]   Show or change project settings

${C.bold('SOURCE MATERIAL')}
  import <file...>                 Import source files into canon
  sources                          List imported sources
  lore search <query>              Search canon, show passages with references
  lore ask <question>              Answer a lore question with citations
  lore extract [--model m] [--max-windows n] [--max-tokens n] [--starved-first n] [--starved-reserve n] [--priority-first n] [--random-floor f] [--seed n] [--full] [--retry] [--legacy] [--trace]
                           Extract the book's lore: people, places, rules, facts.
                           No budget flags mines everything; --max-windows caps it (top priority
                           first, seeded sample of the rest); --full ignores the budget.
                           In staged fragment mode the budget counts bounded fragments.
                           --starved-reserve n orders starved windows first on full runs (default 0).
                           --retry resets an exhausted/deferred recovery backoff; it never steals an active lease.
                           --legacy explicitly uses the old canon-publishing extraction path.
                           --trace requires --legacy; stage-only extraction does not write traces.
                           --legacy publishes to canon, so use it only on a disposable database.
  lore embed [--model m]           Embed passages, entities and triples for dense retrieval
  lore trails --query "..." [--out f]  Draw how each top passage connects to the query
                           [--web] show the association layer too (default off)
  lore hints [--limit n]           List ties whose endpoints are not in the bank
  lore scan [--max n] [--dry-run]  Judge sentences that name two people and a tie word
  lore sweep [--name substring] [--batch 60] [--limit n]
                           Propose ties from characters' mentions into the review queue
  lore pair-threads --build  Build code-only co-occurrence threads for every pair (no model)
  lore pair-threads --status Count pair threads (no writes)
  lore threads --sync              Create investigation threads for people and pairs (no model)
  lore threads [--kind person|pair] [--status open|resolved|dormant] [--period p1|--period] [--limit n]
                           List threads: kind, period, notes, open ends, age
  lore thread <id>                 Show one thread: passages, notes, open ends
  lore meet [--reconcile] [--write] [--min-admission n] Run meetings; reconcile reports or deletes refused meetings (copy only)
  lore births --reconcile [--write] Mark duplicate born threads dormant (copy only)
  lore conflicts [--thread id] [--dismiss id] [--all]  Show or dismiss visible contradictions
  lore brief --for "Name, Name" [--limit n]  Print the evidence web brief for a cast
  lore notes-ingest [--dry-run]    Turn bank rows into thread notes (verbatim-checked, deduped)
  lore identity-check [--write]     Flag entities whose canonical names collide (dry run by default)
  lore meetings [--status] [--limit n]  List meetings, newest first
  lore meeting <id>                Show one meeting: exchanges, resolutions, child
  lore link-facts [--dry-run] [--limit n]  Attach fact subjects to entities
  lore capacity [--dry-run] [--limit n]  Park unproven entities, funnel proven nouns
  lore names [--limit n] [--diagnostics]  List the capitalization name roster (no writes)
  lore rulings export [--out path]  Export keepers, note rulings and alias identities by name
  lore rulings replay --in path [--write] [--dry-run] [--limit n]
                           Reapply an exported ruling file to this project
  lore audit [--write] [--limit n]  Recheck accepted ties against the guard; demote failures
  lore attest [--write] [--limit n] [--no-keeper] [--no-repair] [--on-copy]
                           Move passage-proof rows to the attested tier (dry run by default);
                           --write needs a temp copy, or --on-copy (backup still written first)
  lore docket [--role r] [--actor a] [--limit n] [--backfill]
                           Who decided what, on which standard, and what overruled what
  lore anchors [--write] [--limit n]  Fill the sentence naming the other person (dry run by default)
  lore assess [--limit n] [--min-confidence x] [--write] [--refresh]
                           Score existing ties against their quotes; dry run by default
  lore ties --from A --to B [--at n] [--supporting] [--assessment] [--brief]
                           What two people are to each other now, and before
  lore merge                       Merge entries that are the same under two names
  lore judge-aliases [--max n]     Rule on quarantined nickname pairs (one model call)
  lore dossier <name> [--json]      Show a character dossier (relations, events, chapters)
  lore diagnose                    Report what the index is probably missing
  lore enrich <name> [--handoff f] Re-read the passages about one character
  lore notes [--prioritise] [--max n]  Rank parked ties for human review (no writes)
  lore promote [--dry-run] [--limit n] [--find-evidence]
                           Re-check provisional ties; only the proven rule decides
  lore regather [--write] [--limit n]
                           Attach a stating passage to keepers missing one, or park them (dry run by default; use a disposable copy first)
  lore integrity [--limit n]  List keepers whose evidence is not verbatim (exit 1 if any)
  lore evaluate [--max n]        Judge each banked tie with understanding; failures park as notes
  lore status [--watch [secs]]     How much of the book is read, banked, and waiting
  lore correct relation <id>       Correct a relation by hand
  lore correct entity <id> [--kind k]
                                   Correct an entity by hand; kind is normalised
  lore remove relation <id>       Remove a relation you do not believe
  lore show [--kind k]            Show the extracted lore
  lore events [--extract]         List or build the canon event index

${C.bold('PLANNING')}
  plan discuss <message>           Talk to the planner
  plan chat                        Interactive planner conversation
  plan draft [--premise p] [--divergence d] [--chapters n]
  plan show                        Show the current outline
  plan approve [version]           Approve the outline
  plan revise <instruction> [--chapter n]

${C.bold('WRITING')}
  write next [--notes "..."]       Write the next chapter as a draft
  write chapter <n> [--notes "..."]
  write show <n>                   Print a chapter
  write edit <n> --file <path>     Replace a chapter body
  write regenerate <n> [--notes "..."]
  write approve <n>                Approve a chapter (updates memory)
  write list                       List chapters

${C.bold('CONTINUITY')}
  check <n>                        Run the continuity checker
  issues [--all]                   List continuity issues
  issues resolve <id> [--accept|--fix|--open]
  continuity [--on|--off]          Show or change how the checker behaves
                                  [--model on|off] [--drafts on|off]
                                  [--severity error|warning|note]

${C.bold('CONFLICTS')}
  conflicts                       Chapters that disagree with established state
  conflicts resolve <id>          Accept or resolve a conflict

${C.bold('GRAPH')}
  graph                          Node and connection counts
  graph <name> [--hops n]        What a person or thing is connected to

${C.bold('MEMORY')}
  state                            Overview of the story state
  state characters                 Characters, states and knowledge
  state timeline                   The AU timeline and its canon links
  state threads                    Plot threads
  state facts                      Established facts and decisions
  state requests                   Dynamic context request log
  state set-character <name> [--location l] [--condition c] [--emotional e]
  state set-event <id> [--order n] [--kind flashback] [--note "changed from canon: ..."]
  state add-fact --content "..." [--kind fact] [--subject s]

${C.bold('TRACE')}
  trace show <trace-id> [--json]   Show one trace chain, completeness and drops
  trace audit <trace-id> [--json]  Audit required events, proof refs and outcomes

${C.bold('MODEL')}
  llm status                       Check that the model server is reachable
  llm config --provider ollama --model llama3.1:8b --base-url http://127.0.0.1:11434
  llm config --provider openai --base-url https://openrouter.ai/api --model qwen/qwen2.5-7b-instruct --api-key sk-...
                                   --embedding-base-url http://127.0.0.1:11434 (keep embeddings local)

${C.bold('UI')}
  serve [--port 8123]               Open the browser interface (everything, in one place)
`;

/* -------------------------------------------------------------- utilities */

/* ------------------------------------------------------------- commands */

async function cmdProject(args: Args): Promise<void> {
  const sub = args._[1] ?? '';
  switch (sub) {
    case 'create': {
      const name = args._[2];
      if (!name) throw new Error('project name required');
      if (controller.getProjectByName(db, name)) throw new Error(`project "${name}" already exists`);
      const p = controller.createProject(db, name);
      setGlobalState({ lastProject: p.name });
      heading(`Created project "${p.name}"`);
      console.log(`id: ${p.id}`);
      console.log(`Next: fanfable --project ${p.name} import <your book files>`);
      return;
    }
    case 'list': {
      const projects = controller.listProjects(db);
      heading('Projects');
      if (!projects.length) {
        console.log('(none — create one with "fanfable project create <name>")');
        return;
      }
      const active = globalState().lastProject;
      for (const p of projects) {
        const marker = p.name === active ? C.green('*') : ' ';
        const chapters = db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM chapter WHERE project_id = ?',
          p.id,
        );
        const sources = db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM canon_source WHERE project_id = ?',
          p.id,
        );
        console.log(
          `${marker} ${C.bold(p.name)}  ${C.dim(
            `${sources?.n ?? 0} sources, ${chapters?.n ?? 0} chapters`,
          )}`,
        );
      }
      return;
    }
    case 'use': {
      const name = args._[2];
      if (!name) throw new Error('project name required');
      const p = controller.getProjectByName(db, name);
      if (!p) throw new Error(`no project named "${name}"`);
      setGlobalState({ lastProject: p.name });
      console.log(`Active project: ${C.bold(p.name)}`);
      return;
    }
    case 'settings': {
      const p = requireProject(db, args);
      const patch: Record<string, unknown> = {};
      for (const key of ['provider', 'baseUrl', 'model'] as const) {
        const v = flagString(args, key);
        if (v) patch[key === 'baseUrl' ? 'baseUrl' : key] = v;
      }
      const temp = flagNumber(args, 'temperature', NaN);
      if (Number.isFinite(temp)) patch.temperature = temp;
      const recognition = flagString(args, 'recognition').toLowerCase();
      if (recognition) {
        if (!['on', 'off', 'true', 'false'].includes(recognition)) {
          throw new Error('--recognition must be on or off');
        }
        patch.recognition = recognition === 'on' || recognition === 'true';
      }
      const show = (settings: Record<string, unknown>): string =>
        JSON.stringify(
          {
            ...maskApiKey({ ...DEFAULT_LLM_SETTINGS, ...loadGlobalConfig(), ...settings }),
            recognition: settings.recognition === true,
          },
          null,
          2,
        );
      if (Object.keys(patch).length) {
        const updated = controller.updateProjectSettings(db, p.id, patch);
        console.log(`Updated settings for ${C.bold(p.name)}`);
        console.log(show(updated.settings));
        return;
      }
      console.log(show(p.settings));
      return;
    }
    default:
      throw new Error(`unknown project subcommand "${sub}"`);
  }
}

async function cmdImport(args: Args): Promise<void> {
  const project = requireProject(db, args);
  const files = args._.slice(1).filter((f) => !f.startsWith('--'));
  if (!files.length) throw new Error('no files given');
  heading('Importing sources');
  for (const f of files) {
    const path = resolve(f);
    if (!existsSync(path)) {
      console.log(`${C.red('skip')} ${f} ${C.dim('(not found)')}`);
      continue;
    }
    const res = await lore.importSourceAsync(db, project.id, path, {
      title: flagString(args, 'title') || undefined,
      author: flagString(args, 'author') || undefined,
      overwrite: args.flags.overwrite === true,
    });
    console.log(
      `${C.green('imported')} ${res.source.title} ${C.dim(
        `(${res.source.format}, ${res.chunks} passages${
          res.source.pageCount ? `, ${res.source.pageCount} pages` : ''
        }${res.trimmed ? `, front/back matter skipped (${res.trimmed.headPages}+${res.trimmed.tailPages} pages)` : ''}${res.replaced ? ', replaced previous import' : ''})`,
      )}`,
    );
  }
}

async function cmdSources(args: Args): Promise<void> {
  const project = requireProject(db, args);
  const sources = lore.listSources(db, project.id);
  heading('Sources');
  if (!sources.length) {
    console.log('(none imported)');
    return;
  }
  for (const s of sources) {
    const chunks = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM canon_chunk WHERE source_id = ?',
      s.id,
    );
    console.log(`${C.bold(s.title)} ${C.dim(s.path)}`);
    console.log(`  ${chunks?.n ?? 0} passages, ${(s.byteSize / 1024).toFixed(1)} KB`);
  }
}

async function cmdLore(args: Args): Promise<void> {
  if (args._[1] === 'extract' && args.flags.trace === true && args.flags.legacy !== true) {
    throw new Error(
      '--trace requires --legacy: stage-only extraction does not write traces. ' +
        '--legacy publishes through the canon path, so use it only on a disposable database.',
    );
  }
  const project = requireProject(db, args);
  const sub = args._[1] ?? '';
  const a = app(db, args);

  if (sub === 'search') {
    const query = args._.slice(2).join(' ');
    if (!query) throw new Error('query required');
    const expanded = await lore.expandQuery(a.llm, query);
    const passages = lore.searchCanon(db, project.id, query, { limit: flagNumber(args, 'limit', 8), expand: expanded });
    heading(`Passages for "${query}"`);
    if (!passages.length) {
      console.log('(no passages matched)');
      return;
    }
    passages.forEach((p, i) => {
      console.log(`\n${C.cyan(`[S${i + 1}]`)} ${C.bold(p.sourceTitle)} ${C.dim(`${p.path} :: ${p.locator}`)}`);
      console.log(truncate(p.text, 900));
    });
    return;
  }

  if (sub === 'ask') {
    const question = args._.slice(2).join(' ');
    if (!question) throw new Error('question required');
    const res = await lore.answerLoreQuestion(db, a.llm, project.id, question, {
      limit: flagNumber(args, 'limit', 8),
      trace: { enabled: true },
    });
    heading('Lore answer');
    console.log(res.answer);
    if (res.passages.length) {
      console.log(`\n${C.dim('sources:')}`);
      res.passages.forEach((p, i) => console.log(`  [S${i + 1}] ${p.sourceTitle} :: ${p.locator}`));
    }
    if (res.traceId) console.log(`\n${C.dim(`trace ${res.traceId}`)}`);
    return;
  }

  if (sub === 'audit') {
    const write = args.flags.write === true;
    const limit = flagNumber(args, 'limit', 0);
    const result = lorebook.auditAcceptedRelations(db, project.id, {
      write,
      limit: limit > 0 ? limit : undefined,
    });
    heading(write ? 'Accepted relation audit (write)' : 'Accepted relation audit (dry run)');
    console.log(`${C.dim('id    from — kind — to').padEnd(64)}  ${C.dim('guard')}  ${C.dim('action')}`);
    for (const row of result.rows) {
      const pair = `${row.fromName} — ${row.kind} — ${row.toName}`;
      const action = row.action === 'demote'
        ? 'demote'
        : row.cannotJudge
          ? 'keep (cannot judge direction)'
          : 'keep';
      const guard = row.guard === 'ok' ? 'ok' : row.guard;
      console.log(`${String(row.id).padEnd(5)} ${pair.padEnd(58)}  ${guard.padEnd(18)}  ${action}`);
    }
    const failed = Object.entries(result.failing).reduce((sum, [, n]) => sum + n, 0);
    console.log(
      `\naudited ${result.audited}, passing ${result.passing}, failing ${failed}, ` +
        `cannot-judge ${result.cannotJudge}`,
    );
    if (failed) {
      console.log(`  failing by reason: ${Object.entries(result.failing).map(([reason, n]) => `${reason} ${n}`).join(', ')}`);
      console.log(`  direction unknown: ${result.cannotJudge} (kept, not proved)`);
    }
    if (write) {
      if (result.backupPath) console.log(`  backup: ${result.backupPath}`);
      console.log(`  changed ${result.changed}`);
    } else {
      console.log(C.dim('  dry run: nothing written. Re-run with --write to demote failures.'));
    }
    return;
  }

  if (sub === 'assess') {
    const write = args.flags.write === true;
    const refresh = args.flags.refresh === true;
    const limit = flagNumber(args, 'limit', 0);
    const threshold = args.flags['min-confidence'] === undefined
      ? 0.7
      : flagNumber(args, 'min-confidence', 0.7);
    heading(write ? 'Assess relations (write)' : 'Assess relations (dry run)');
    const result = await lorebook.assessRelations(db, a.llm, project.id, {
      write,
      refresh,
      limit: limit > 0 ? limit : undefined,
      minConfidence: threshold,
      onProgress: (message) => process.stdout.write(`  ${C.dim(message)}\n`),
    });
    console.log(
      `assessed ${result.assessed}; skipped: no quote ${result.skipped['no-quote']}, ` +
        `already assessed ${result.skipped['already-assessed']}, ` +
        `entity unresolved ${result.skipped['entity-unresolved']}, ` +
        `quote not verbatim ${result.skipped['quote-not-verbatim']}` +
        (result.skipped['model-error'] ? `, model error ${result.skipped['model-error']}` : ''),
    );
    console.log(`\n${C.dim('band       rows')}`);
    for (const [band, count] of Object.entries(result.bands)) {
      console.log(`${band.padEnd(10)} ${count}`);
    }
    console.log(`\nat or above ${result.threshold}: ${result.aboveThreshold}`);
    for (const [status, count] of Object.entries(result.aboveByStatus).sort()) {
      console.log(`  ${status.padEnd(16)} ${count}`);
    }
    console.log(
      `\naverage strength of user_confirmed rows: ` +
        (result.userConfirmedAverage === null ? 'none' : result.userConfirmedAverage.toFixed(3)),
    );
    if (write) {
      console.log(`wrote ${result.wrote} assessment(s); review_status untouched.`);
    } else {
      console.log(C.dim('dry run: nothing written. Re-run with --write to store the assessments.'));
    }
    return;
  }

  if (sub === 'sweep') {
    const name = flagString(args, 'name');
    const batchSize = flagNumber(args, 'batch', 60);
    const limit = flagNumber(args, 'limit', 0);
    heading('Name sweep');
    const result = await sweep.runNameSweep(db, a.llm, project.id, {
      name: name || undefined,
      batchSize,
      limit: limit > 0 ? limit : undefined,
      onProgress: (message) => process.stdout.write(`  ${C.dim(message)}\n`),
    });
    for (const character of result.characters) {
      console.log(
        `${character.name}: ${character.mentions} mentions, ${character.ties} ties, ` +
          `${character.proposals} proposals ` +
          C.dim(
            `(keeper skips ${character.skippedKeeper}, pending skips ${character.skippedPending})` +
              (character.unresolvedTargets.length ? `, unknown targets ${character.unresolvedTargets.join(', ')}` : ''),
          ),
      );
    }
    console.log(
      `\nproposals ${result.proposals} (${result.distinctPairs} distinct pairs); ` +
        `queue ${result.queueBefore} → ${result.queueAfter}`,
    );
    if (result.skippedKeeper || result.skippedPending) {
      console.log(
        C.dim(`skipped ${result.skippedKeeper} pair(s) with a keeper, ${result.skippedPending} with a pending note`),
      );
    }
    return;
  }

  if (sub === 'pair-threads') {
    if (args.flags.build === true) {
      heading('Pair threads');
      const result = pairThreads.buildPairThreads(db, project.id);
      console.log(
        `people ${result.people}, co-occurring pairs ${result.cooccurringPairs}`,
      );
      console.log(
        `threads ${result.pairsWithRows} ` +
          `(${result.threadsCreated} created, ${result.threadsUpdated} updated); ` +
          `unproposed ${result.unproposedPairs}`,
      );
      return;
    }
    if (args.flags.status === true) {
      const counts = pairThreads.pairThreadCounts(db, project.id);
      heading('Pair threads');
      console.log(`threads ${counts.threads}; unproposed ${counts.unproposed}`);
      return;
    }
    throw new Error('pair-threads needs --build or --status');
  }

  if (sub === 'threads') {
    if (args.flags.sync === true) {
      heading('Threads');
      const result = threadWeb.syncThreads(db, project.id);
      console.log(
        `person threads ${result.personThreadsCreated} created, ` +
          `pair threads ${result.pairThreadsCreated} created ` +
          `(${result.pairPeriodsCreated} later periods)`,
      );
      console.log(`threads ${result.threadsTotal}; open ends ${result.openEndsTotal}`);
      return;
    }
    const kind = flagString(args, 'kind');
    const status = flagString(args, 'status');
    const period = flagString(args, 'period');
    const limit = flagNumber(args, 'limit', 0);
    if (kind && kind !== 'person' && kind !== 'pair') throw new Error('--kind must be person or pair');
    if (status && status !== 'open' && status !== 'resolved' && status !== 'dormant') {
      throw new Error('--status must be open, resolved or dormant');
    }
    const rows = threadWeb.listThreads(db, project.id, {
      kind: kind ? (kind as 'person' | 'pair') : undefined,
      status: status ? (status as 'open' | 'resolved' | 'dormant') : undefined,
      period: args.flags.period === true ? '' : period || undefined,
      limit: limit > 0 ? limit : undefined,
    });
    heading('Threads');
    if (!rows.length) {
      console.log('(none — run "fanfable lore threads --sync" to create them)');
      return;
    }
    console.log(C.dim('id    kind    period  notes  open  age   thread'));
    for (const t of rows) {
      const label = t.kind === 'pair' ? `${t.aName} / ${t.bName ?? ''}` : t.aName;
      const periodLabel = t.period_label === '' ? '-' : t.period_label;
      console.log(
        `${String(t.id).padEnd(5)} ${t.kind.padEnd(7)} ${periodLabel.padEnd(7)} ` +
          `${String(t.noteCount).padEnd(6)} ${String(t.openEndCount).padEnd(5)} ` +
          `${ageLabel(t.created_at).padEnd(5)} ${label}`,
      );
    }
    return;
  }

  if (sub === 'thread') {
    const id = Number(args._[2]);
    if (!Number.isInteger(id) || id <= 0) throw new Error('usage: lore thread <id>');
    const loaded = threadWeb.loadThread(db, project.id, id);
    if (!loaded) throw new Error(`no thread ${id}`);
    heading(`Thread ${id}`);
    const who = loaded.bName ? `${loaded.aName} / ${loaded.bName}` : loaded.aName;
    console.log(`kind: ${loaded.thread.kind}; status: ${loaded.thread.status}`);
    console.log(`people: ${who || '(unknown)'}`);
    console.log(`created: ${loaded.thread.created_at} (age ${ageLabel(loaded.thread.created_at)})`);
    console.log(
      `passages ${loaded.counts.passages}, notes ${loaded.counts.notes}, ` +
        `open ends ${loaded.counts.openEndsOpen} open of ${loaded.counts.openEnds}`,
    );
    if (loaded.passages.length) {
      console.log(`\n${C.dim('passages')}`);
      for (const p of loaded.passages) {
        console.log(`  seq ${p.seq}: ${p.locator || '(no locator)'} ${C.dim(`[chunk ${p.chunkId}]`)}`);
      }
    }
    if (loaded.notes.length) {
      console.log(`\n${C.dim('notes')}`);
      for (const n of loaded.notes) {
        const flags = [
          n.isContext ? 'context' : '',
          n.supersedesNoteId ? `supersedes #${n.supersedesNoteId}` : '',
        ]
          .filter(Boolean)
          .join(', ');
        console.log(
          `  #${n.id} ${n.noteKind}, strength ${n.strength.toFixed(2)}` + (flags ? C.dim(` (${flags})`) : ''),
        );
        console.log(`    quote: "${n.quote}" ${C.dim(`[${n.locator || 'no locator'}]`)}`);
        if (n.claim) console.log(`    claim: ${n.claim}`);
        if (n.why) console.log(`    why: ${n.why}`);
        if (n.missing) console.log(`    missing: ${n.missing}`);
      }
    }
    if (loaded.openEnds.length) {
      console.log(`\n${C.dim('open ends')}`);
      for (const o of loaded.openEnds) {
        const carried = o.carriedFromOpenEndId ? C.dim(` (carried from #${o.carriedFromOpenEndId})`) : '';
        console.log(`  #${o.id} [${o.status}] ${o.question}${carried}`);
        if (o.origin) console.log(`    origin: ${o.origin}`);
        if (o.wouldResolve) console.log(`    would resolve: ${o.wouldResolve}`);
        if (o.resolvedByNoteId) {
          console.log(`    resolved by note #${o.resolvedByNoteId} at ${o.resolvedAt ?? '(no time)'}`);
        }
      }
    }
    if (loaded.parents.a || loaded.parents.b) {
      console.log(`\n${C.dim('born from')}`);
      console.log(
        `  #${loaded.thread.parent_a_thread ?? '?'} ${loaded.parents.a?.label ?? '(unknown)'} / ` +
          `#${loaded.thread.parent_b_thread ?? '?'} ${loaded.parents.b?.label ?? '(unknown)'}`,
      );
      if (loaded.birth) {
        console.log(
          `  trigger: ${loaded.birth.trigger}` +
            (loaded.birth.combinedScore ? `, combined support ${loaded.birth.combinedScore.toFixed(3)}` : ''),
        );
      }
      if (loaded.thread.birth_reason) console.log(`  reason: ${loaded.thread.birth_reason}`);
    }
    if (loaded.noteRefs.length) {
      console.log(`\n${C.dim('referenced notes (not copied)')}`);
      for (const ref of loaded.noteRefs) {
        console.log(`  #${ref.noteId} [${ref.role}] ${ref.note.claim || '(no claim)'}`);
      }
    }
    {
      const conflicts = db.all<{
        id: number;
        note_low: number;
        note_high: number;
        kind_low: string;
        kind_high: string;
        status: string;
      }>(
        `SELECT id, note_low, note_high, kind_low, kind_high, status
           FROM canon_thread_conflict WHERE thread_id = ? ORDER BY id`,
        id,
      );
      if (conflicts.length) {
        console.log(`\n${C.dim('conflicts (both stances stay visible)')}`);
        for (const conflict of conflicts) {
          const low = loaded.notes.find((note) => note.id === conflict.note_low);
          const high = loaded.notes.find((note) => note.id === conflict.note_high);
          console.log(
            `  #${conflict.id} [${conflict.status}] ${conflict.kind_low} vs ${conflict.kind_high}`,
          );
          if (low) console.log(`    #${low.id} (${low.strength.toFixed(2)}): ${low.claim}`);
          if (high) console.log(`    #${high.id} (${high.strength.toFixed(2)}): ${high.claim}`);
        }
      }
    }
    if (!loaded.counts.passages && !loaded.counts.notes && !loaded.counts.openEnds) {
      console.log(C.dim('\nempty thread: no evidence gathered yet (not a statement of no relationship)'));
    }
    return;
  }

  if (sub === 'identity-check') {
    const write = args.flags.write === true;
    const limit = flagNumber(args, 'limit', 0);
    heading(write ? 'Identity collisions (write)' : 'Identity collisions (dry run)');
    const result = identityCheck.flagIdentityCollisions(db, project.id, { write });
    console.log(
      `collisions ${result.collisions.length} ` +
        `(same-form edges ${result.sameFormEdges}, containment edges ${result.containmentEdges})`,
    );
    console.log(
      `entities flagged ${result.flagged}, already flagged ${result.alreadyFlagged}, ` +
        `quarantined skipped ${result.quarantinedSkipped}, too-generic pairs skipped ${result.skippedByGroupCap}`,
    );
    const shown = limit > 0 ? result.collisions.slice(0, limit) : result.collisions.slice(0, 10);
    for (const collision of shown) {
      console.log(`  ${collision.edge}: ids ${collision.ids.join(',')} (${collision.kinds.join('/')})`);
    }
    if (result.collisions.length > shown.length) {
      console.log(C.dim(`  … ${result.collisions.length - shown.length} more`));
    }
    if (write) console.log('review_status and quarantine_reason updated; nothing merged, renamed or re-kinded.');
    else console.log(C.dim('dry run: nothing written. Re-run with --write to flag the rows.'));
    return;
  }

  if (sub === 'notes-ingest') {
    const dryRun = args.flags['dry-run'] === true;
    heading(dryRun ? 'Notes ingest (dry run)' : 'Notes ingest');
    const counts = noteIngest.backfillThreadNotes(db, project.id, { dryRun });
    console.log(
      `notes ${counts.notes} (pair ${counts.pairNotes}, identity ${counts.identityNotes}, ` +
        `context ${counts.contextNotes}); deduplicated ${counts.deduplicated}; open ends ${counts.openEnds}`,
    );
    console.log(
      `strength source: assessed ${counts.strengthSource.assessed}, derived ${counts.strengthSource.derived}, ` +
        `context ${counts.strengthSource.context}, default ${counts.strengthSource.default}`,
    );
    console.log(
      `strength bands: ${Object.entries(counts.strengthBands)
        .map(([band, n]) => `${band} ${n}`)
        .join(', ')}`,
    );
    const skipped = Object.entries(counts.skipped).filter(([, n]) => n > 0);
    console.log(
      `skipped: ${skipped.length ? skipped.map(([reason, n]) => `${reason} ${n}`).join(', ') : 'none'}`,
    );
    if (counts.traceId) console.log(`trace ${counts.traceId}`);
    if (dryRun) console.log(C.dim('dry run: nothing written. Re-run without --dry-run to store the notes.'));
    return;
  }

  if (sub === 'births') {
    if (args.flags.reconcile === true) {
      const write = args.flags.write === true;
      heading(write ? 'Born threads reconcile (write)' : 'Born threads reconcile (report)');
      const result = meetingWeb.reconcileBornThreads(db, project.id, { write });
      console.log(
        `duplicate subjects ${result.duplicateSubjects}; extra born threads ${result.extraThreads}; ` +
          `marked dormant ${result.markedDormant}`,
      );
      if (write) console.log('the lowest id of each group stays live; nothing deleted, notes untouched.');
      else console.log(C.dim('report only: nothing written. Re-run with --write on a copy to mark the extras.'));
      return;
    }
    throw new Error('births needs --reconcile [--write]');
  }

  if (sub === 'brief') {
    const forRaw = flagString(args, 'for');
    const names = forRaw.split(',').map((name) => name.trim()).filter(Boolean);
    if (!names.length) throw new Error('usage: lore brief --for "Name, Name" [--limit n]');
    const limit = flagNumber(args, 'limit', 12);
    const brief = briefWeb.buildWebBrief(db, project.id, { entities: names, limitPerSection: limit });
    heading('Evidence web brief');
    console.log(
      `proven ${brief.proven.length}, attested ${brief.attested.length}, provisional ${brief.provisional.length}, ` +
        `open questions ${brief.openQuestions.length}, conflicts ${brief.conflicts.length}, ` +
        `threads ${brief.threads.length}, unresolved ${brief.unresolved.length}`,
    );
    if (Object.keys(brief.truncated).length) {
      console.log(C.dim(`truncated: ${Object.entries(brief.truncated).map(([k, n]) => `${k} ${n}`).join(', ')}`));
    }
    for (const tie of brief.proven) {
      console.log(`  proven   #${tie.id} ${tie.from} ${tie.kind} ${tie.to} ${tie.citation ? `[${tie.citation.locator}]` : '(uncited)'}`);
    }
    for (const tie of brief.attested) {
      console.log(`  attested #${tie.id} ${tie.from} ${tie.kind} ${tie.to} ${tie.citation ? `[${tie.citation.locator}]` : '(uncited)'}`);
    }
    for (const tie of brief.provisional) {
      console.log(
        `  provisional #${tie.id} ${tie.from} ${tie.kind} ${tie.to} strength ${(tie.strength ?? 0).toFixed(2)}` +
          (tie.uncited ? ' (uncited)' : ''),
      );
    }
    for (const question of brief.openQuestions) {
      console.log(`  question #${question.id} thread ${question.threadId}`);
    }
    for (const conflict of brief.conflicts) {
      console.log(`  conflict #${conflict.id} ${conflict.kindLow} vs ${conflict.kindHigh}`);
    }
    for (const unresolved of brief.unresolved) {
      console.log(
        `  unresolved ${unresolved.status}: ${unresolved.name}` +
          (unresolved.candidates.length ? ` (${unresolved.candidates.map((c) => `${c.id}:${c.name}`).join(', ')})` : ''),
      );
    }
    return;
  }

  if (sub === 'attest') {
    const write = args.flags.write === true;
    const limit = flagNumber(args, 'limit', 0);
    const promoteKeeper = args.flags['no-keeper'] !== true;
    const repairQuotes = args.flags['no-repair'] !== true;
    const onCopy = args.flags['on-copy'] === true;
    if (write) meetingWeb.attestWriteGuard(db.path, onCopy);
    heading(write ? 'Attested tier assignment (write)' : 'Attested tier assignment (dry run)');
    const before = db.all<{ status: string; n: number }>(
      'SELECT review_status AS status, COUNT(*) AS n FROM canon_relation WHERE project_id = ? GROUP BY review_status ORDER BY review_status',
      project.id,
    );
    const result = lorebook.assignAttestedTiers(db, project.id, {
      write,
      limit: limit > 0 ? limit : undefined,
      promoteKeeper,
      repairQuotes,
    });
    console.log(
      `checked ${result.checked}; attested ${result.attested}; keeper-track ${result.keeperTrack}` +
        ` (accepted ${result.keeperPromoted}); quotes repaired ${result.repaired}`,
    );
    const blocked = Object.entries(result.still).filter(([, n]) => n > 0);
    console.log(
      `blocked: ${blocked.length ? blocked.map(([reason, n]) => `${reason} ${n}`).join(', ') : 'none'}`,
    );
    if (write) {
      console.log(
        C.dim('a snapshot backup is written beside the database before any row moves.'),
      );
      console.log(`changed ${result.changed}`);
    } else {
      console.log(C.dim('dry run: nothing written. Re-run with --write on a copy to move the rows.'));
    }
    const after = db.all<{ status: string; n: number }>(
      'SELECT review_status AS status, COUNT(*) AS n FROM canon_relation WHERE project_id = ? GROUP BY review_status ORDER BY review_status',
      project.id,
    );
    const tally = (rows: { status: string; n: number }[]): string =>
      rows.length ? rows.map((row) => `${row.status} ${row.n}`).join(', ') : 'none';
    console.log(`status before: ${tally(before)}`);
    console.log(`status after:  ${tally(after)}`);
    return;
  }

  if (sub === 'docket') {
    const role = flagString(args, 'role') || undefined;
    const actor = flagString(args, 'actor') || undefined;
    const limit = Math.max(1, Math.floor(flagNumber(args, 'limit', 40)));
    if (args.flags.backfill === true) {
      const written = ruling.backfillCharges(db, project.id);
      console.log(C.dim(`backfilled ${written} opening charge(s)`));
    }
    const rows = ruling.docket(db, project.id, { limit, role, actor });
    heading('Court docket');
    if (!rows.length) {
      console.log(C.dim('(no rulings recorded)'));
      return;
    }
    for (const row of rows) {
      const pair = row.pair || row.subject;
      const status = row.status ? C.dim(` [${row.status}]`) : '';
      console.log(`${C.bold(pair)}${status} — ${row.role} by ${row.actor}${row.standard ? ` (${row.standard})` : ''}`);
      const marks: string[] = [];
      if (row.objections) marks.push(`${row.objections} objection${row.objections === 1 ? '' : 's'}`);
      if (row.openEnds) marks.push(`${row.openEnds} open want${row.openEnds === 1 ? '' : 's'}`);
      if (row.contested) marks.push('contested');
      console.log(
        `  ${row.kind ? C.dim(`${row.kind}: `) : ''}${row.basis || '(no basis)'} ` +
          C.dim(`(${row.rulings} ruling${row.rulings === 1 ? '' : 's'}, ${row.at})`) +
          (marks.length ? ` ${C.yellow(`[${marks.join(', ')}]`)}` : ''),
      );
    }
    return;
  }

  if (sub === 'anchors') {
    const write = args.flags.write === true;
    const limit = args.flags.limit === undefined
      ? undefined
      : Math.max(1, Math.floor(flagNumber(args, 'limit', 0)));
    heading(write ? 'Anchor sentences (write)' : 'Anchor sentences (dry run)');
    const result = lorebook.populateAnchors(db, project.id, { write, limit });
    console.log(`checked ${result.checked}, filled ${result.filled}, changed ${result.changed}`);
    const skipped = Object.entries(result.skipped).filter(([, n]) => n > 0);
    if (skipped.length) {
      console.log(`skipped: ${skipped.map(([reason, n]) => `${reason} ${n}`).join(', ')}`);
    }
    if (write) {
      if (result.backupPath) console.log(`backup: ${result.backupPath}`);
    } else {
      console.log(C.dim('dry run: nothing written. Re-run with --write to store the anchors.'));
    }
    return;
  }

  if (sub === 'conflicts') {
    const dismiss = flagNumber(args, 'dismiss', 0);
    if (dismiss > 0) {
      const changed = noteIngest.dismissConflict(db, project.id, dismiss);
      console.log(changed ? `dismissed conflict ${dismiss}` : `conflict ${dismiss} was already dismissed`);
      return;
    }
    const threadId = flagNumber(args, 'thread', 0);
    const all = args.flags.all === true;
    const where = [`project_id = ?`];
    const params: unknown[] = [project.id];
    if (threadId > 0) {
      where.push('thread_id = ?');
      params.push(threadId);
    }
    const rows = db.all<{
      id: number;
      thread_id: number;
      note_low: number;
      note_high: number;
      kind_low: string;
      kind_high: string;
      status: string;
    }>(
      `SELECT id, thread_id, note_low, note_high, kind_low, kind_high, status
         FROM canon_thread_conflict WHERE ${where.join(' AND ')} ORDER BY thread_id, id`,
      ...params,
    );
    heading('Thread conflicts');
    const visible = rows.filter((row) => row.status === 'visible').length;
    console.log(`${rows.length} conflict(s): visible ${visible}, dismissed ${rows.length - visible}`);
    if (all) {
      for (const row of rows) {
        console.log(
          `  #${row.id} thread ${row.thread_id}: notes ${row.note_low}/${row.note_high} ` +
            `${row.kind_low} vs ${row.kind_high} [${row.status}]`,
        );
      }
    }
    return;
  }

  if (sub === 'meet') {
    if (args.flags.reconcile === true) {
      const write = args.flags.write === true;
      heading(write ? 'Meetings reconcile (write)' : 'Meetings reconcile (report)');
      const result = meetingWeb.reconcileMeetings(db, project.id, { write });
      console.log(`examined ${result.examined}; would refuse ${result.wouldRefuse}`);
      console.log(
        `by reason: ${Object.entries(result.byReason)
          .map(([reason, n]) => `${reason} ${n}`)
          .join(', ')}`,
      );
      if (write) console.log(`deleted ${result.deleted} meeting(s) and their exchanges and resolutions`);
      else console.log(C.dim('report only: nothing deleted. Re-run with --write on a copy to delete.'));
      return;
    }
    heading('Meetings');
    const minAdmission = budgetFlag(args, 'min-admission');
    const result = meetingWeb.runMeetings(db, project.id, { minAdmissionStrength: minAdmission });
    console.log(
      `candidates ${result.candidatesConsidered} in ${result.enumerationMs}ms` +
        (result.groupsSkippedForDepth ? ` (${result.groupsSkippedForDepth} deep branches stopped)` : '') +
        `; meetings ${result.meetingsCreated} created, ${result.meetingsReused} reused`,
    );
    console.log(`refused ${result.meetingsRefused}: ` + Object.entries(result.refusedByReason)
      .map(([reason, n]) => `${reason} ${n}`)
      .join(', '));
    console.log(
      `exchanges ${result.exchangesAdded}; wants resolved ${result.wantsResolved}; ` +
        `births ${result.birthsCreated}` +
        (result.birthsDeferred ? `, ${result.birthsDeferred} deferred to the next run` : ''),
    );
    const byTrigger = Object.entries(result.birthsByTrigger).filter(([, n]) => n > 0);
    if (byTrigger.length) {
      console.log(`births by trigger: ${byTrigger.map(([trigger, n]) => `${trigger} ${n}`).join(', ')}`);
    }
    const skipped = Object.entries(result.birthsSkipped).filter(([, n]) => n > 0);
    console.log(
      `births skipped: ${skipped.length ? skipped.map(([reason, n]) => `${reason} ${n}`).join(', ') : 'none'}`,
    );
    return;
  }

  if (sub === 'meetings') {
    const status = flagString(args, 'status');
    const limit = flagNumber(args, 'limit', 0);
    if (status && status !== 'open' && status !== 'resolved' && status !== 'dormant') {
      throw new Error('--status must be open, resolved or dormant');
    }
    const rows = meetingWeb.listMeetings(db, project.id, {
      status: status ? (status as 'open' | 'resolved' | 'dormant') : undefined,
      limit: limit > 0 ? limit : undefined,
    });
    heading('Meetings');
    if (!rows.length) {
      console.log('(none — run "fanfable lore meet" to hold meetings)');
      return;
    }
    console.log(C.dim('id    kind          rev  notes  wants  child  threads       subject'));
    for (const m of rows) {
      console.log(
        `${String(m.id).padEnd(5)} ${m.match_kind.padEnd(13)} ${String(m.revision).padEnd(4)} ` +
          `${String(m.notes_exchanged).padEnd(6)} ${String(m.wants_resolved).padEnd(6)} ` +
          `${String(m.child_thread ?? '-').padEnd(6)} ${`${m.thread_a}/${m.thread_b}`.padEnd(13)} ${m.match_key}`,
      );
    }
    return;
  }

  if (sub === 'meeting') {
    const id = Number(args._[2]);
    if (!Number.isInteger(id) || id <= 0) throw new Error('usage: lore meeting <id>');
    const loaded = meetingWeb.loadMeeting(db, project.id, id);
    if (!loaded) throw new Error(`no meeting ${id}`);
    const m = loaded.meeting;
    heading(`Meeting ${id}`);
    console.log(`subject: ${m.match_key} (${m.match_kind})`);
    console.log(`threads: #${m.thread_a} / #${m.thread_b}; status ${m.status}; revision ${m.revision}`);
    console.log(
      `exchanges ${loaded.exchanges.length}, wants resolved ${loaded.resolutions.filter((r) => !r.supersededBy).length}, ` +
        `child ${m.child_thread ? `#${m.child_thread}` : 'none'}`,
    );
    if (m.remaining) console.log(C.dim(`remaining: ${m.remaining}`));
    if (loaded.exchanges.length) {
      console.log(`\n${C.dim('exchanges')}`);
      for (const x of loaded.exchanges) {
        console.log(`  note #${x.noteId} from thread #${x.threadId} (${x.direction}), scope ${x.scope}`);
      }
    }
    if (loaded.resolutions.length) {
      console.log(`\n${C.dim('resolutions')}`);
      for (const r of loaded.resolutions) {
        const state = r.supersededBy ? C.dim(` superseded by #${r.supersededBy}`) : '';
        console.log(
          `  #${r.id} open end #${r.openEndId} resolved by note #${r.resolvedByNoteId}` +
            ` [${r.matchTokens || 'no tokens'}]${state}`,
        );
      }
    }
    if (loaded.child) {
      console.log(`\n${C.dim('birth')}`);
      console.log(`  child thread #${loaded.child.threadId}; trigger ${loaded.child.trigger}`);
      if (loaded.child.combinedScore) {
        console.log(`  combined support ${loaded.child.combinedScore.toFixed(3)}`);
      }
      console.log(`  reason: ${loaded.child.reason}`);
    }
    return;
  }

  if (sub === 'extract') {
    heading('Extracting book lore');
    const extractionModel = flagString(args, 'model');
    const llm = extractionModel
      ? controller.createClient({ ...(project.settings as object), model: extractionModel } as never)
      : a.llm;
    const stats = await lorebook.extractLore(db, llm, project.id, {
      sourceId: flagNumber(args, 'source', 0) || undefined,
      windowSize: flagNumber(args, 'window', 8),
      concurrency: flagNumber(args, 'concurrency', 3),
      // Output budget per window. The 3000 default truncates the
      // entities+facts answer on nearly every window, which silently drops
      // the tail of each entity list.
      maxTokens: flagNumber(args, 'max-tokens', 0) || undefined,
      fresh: args.flags.fresh === true,
      maxWindows: budgetFlag(args, 'max-windows'),
      starvedFirst: budgetFlag(args, 'starved-first'),
      starvedReserve: budgetFlag(args, 'starved-reserve'),
      priorityFirst: budgetFlag(args, 'priority-first'),
      randomFloor: budgetFlag(args, 'random-floor'),
      seed: budgetFlag(args, 'seed'),
      full: args.flags.full === true,
      recovery: args.flags.legacy === true
        ? { enabled: false }
        : { explicitRetry: args.flags.retry === true, stageOnly: true },
      trace: args.flags.trace === true ? { enabled: true } : undefined,
      onProgress: (m) => process.stdout.write(`  ${C.dim(m)}\n`),
    });
    const staged = stats.stageOnly === true || stats.recovery?.readiness === 'staged_only';
    const fragmentCoverage = stats.fragmentCoverage;
    const partialSource =
      fragmentCoverage?.status === 'partial' || stats.recovery?.status === 'partial';
    const incompleteSource =
      fragmentCoverage?.status === 'none' ||
      stats.recovery?.status === 'failed' ||
      stats.recovery?.status === 'deferred';
    if (stats.legacyStagedContributions?.count) {
      console.log(
        C.yellow(
          `  warning: ${stats.legacyStagedContributions.count} pre-namespace staged contribution(s) ` +
            'are incompatible; they are not reused as staging and need manual review before publication. ' +
            'No automatic repair was performed.',
        ),
      );
    }
    if (stats.emptySource) {
      console.log(
        C.yellow(
          staged
            ? 'nothing to stage: no imported passages are available'
            : 'nothing to extract: no imported passages are available',
        ),
      );
      return;
    }
    if (stats.recoveryNoEligibleWork) {
      console.log(
        `${C.yellow('nothing staged')} every candidate is already complete or deferred; ` +
          'completed work is reused and deferred work needs --retry after review.',
      );
    } else {
      console.log(
        staged
          ? `${C.yellow(
              incompleteSource
                ? 'staging incomplete (not canon)'
                : partialSource
                  ? 'staged partially (not canon)'
                  : 'staged only (not canon)',
            )} ${stats.entities} entities, ${stats.relations} relationships, ` +
              `${stats.facts} facts, ${stats.timeline} timeline entries. ` +
              'Nothing was published to canon, lore_mined or embeddings; publication is not implemented.'
          : `${C.green('extracted')} ${stats.entities} entities, ${stats.relations} relationships, ` +
              `${stats.facts} facts, ${stats.timeline} timeline entries` +
              (stats.provisional ? ` (${stats.provisional} provisional)` : ''),
      );
    }
    if (fragmentCoverage) {
      console.log(
        C.dim(
          `  source coverage: ${fragmentCoverage.status}; ` +
            `${fragmentCoverage.completeFragments}/${fragmentCoverage.plannedFragments} fragments complete; ` +
            `${fragmentCoverage.completeSourceChunks}/${fragmentCoverage.totalSourceChunks} source chunk(s) complete, ` +
            `${fragmentCoverage.partialSourceChunks} partial, ${fragmentCoverage.uncoveredSourceChunks} uncovered`,
        ),
      );
      if (fragmentCoverage.status === 'none' || incompleteSource) {
        console.log(
          C.yellow(
            '  warning: source coverage is incomplete; this run is not a complete source-coverage claim',
          ),
        );
      } else if (fragmentCoverage.status === 'partial') {
        console.log(
          C.yellow(
            '  warning: source coverage is partial; this run is not a complete source-coverage claim',
          ),
        );
      }
      if (fragmentCoverage.staleRelationFragments) {
        console.log(
          C.dim(
            `  ${fragmentCoverage.staleRelationFragments} fragment(s) need relationship revalidation against the final staged roster`,
          ),
        );
      }
    } else if (stats.recoveryRelationStale) {
      console.log(
        C.dim(
          `  ${stats.recoveryRelationStale} window(s) need relationship revalidation against the final staged roster`,
        ),
      );
    }
    if (!fragmentCoverage && incompleteSource) {
      console.log(
        C.yellow(
          '  warning: source coverage is incomplete; this run is not a complete source-coverage claim',
        ),
      );
    }
    if (stats.truncatedPassages) {
      console.log(
        C.yellow(
          `  warning: ${stats.truncatedPassages} passage(s) exceeded ` +
            `${stats.promptPassageChars ?? 1400} characters; only the prefix was read, ` +
            'so this run is not exhaustive source coverage',
        ),
      );
    }
    if (stats.traceId) console.log(C.dim(`trace ${stats.traceId}`));
    if (stats.recovery) {
      console.log(
        C.dim(
          `  recovery parent ${stats.recovery.parentId}: ${stats.recovery.status}; ` +
            `${stats.recovery.completeChildren}/${stats.recovery.children} ` +
            `${stats.fragmentMode ? 'fragment' : 'window'}(s) complete` +
            (stats.recovery.deferredChildren
              ? `, ${stats.recovery.deferredChildren} deferred (retry with --retry after reviewing)`
              : ''),
        ),
      );
      console.log(
        C.dim(
          `  recovery readiness: ${stats.recovery.readiness}; ` +
            `optional: notes ${String((stats.recovery.optional as Record<string, unknown>).noteIngestion ?? 'unknown')}, ` +
            `close-loop ${String((stats.recovery.optional as Record<string, unknown>).closeTheLoop ?? 'unknown')}, ` +
            `embeddings ${String((stats.recovery.optional as Record<string, unknown>).embeddings ?? 'unknown')}`,
        ),
      );
    }
    if (stats.legacyBlockedFragments || stats.legacyBlockedWindows) {
      const blocked = stats.fragmentMode
        ? stats.legacyBlockedFragments ?? 0
        : stats.legacyBlockedWindows ?? 0;
      console.log(
        C.yellow(
          `  ${blocked} ${stats.fragmentMode ? 'fragment' : 'window'}(s) left untouched: legacy mined rows block recovery; old canon was not changed`,
        ),
      );
    }
    if (stats.recoverySkippedComplete || stats.recoverySkippedDeferred) {
      console.log(
        C.dim(
          `  budget skipped ${stats.recoverySkippedComplete ?? 0} complete and ` +
            `${stats.recoverySkippedDeferred ?? 0} deferred ${stats.fragmentMode ? 'fragment' : 'window'}(s)`,
        ),
      );
    }
    if (stats.selection) {
      console.log(
        C.dim(
          `  budget: mined ${stats.selection.selected} of ${stats.selection.total} ` +
            `${stats.fragmentMode ? 'fragments' : 'windows'}, ` +
            `${stats.selection.skipped} left unmined (re-run with --full for the rest)`,
        ),
      );
      if (stats.starvedReserved) {
        console.log(
          C.dim(
            `  starved: ${stats.starvedReserved} window(s) reserved, ${stats.starvedUsed} used, ` +
              `${stats.threadsCovered ?? 0} starved thread(s) covered`,
          ),
        );
      }
    }
    const v = stats.verification;
    if (v.claimed) {
      console.log(
        C.dim(
          `  quotes: ${v.verified} verified, ${v.repointed} repointed, ${v.dropped} dropped` +
            (v.unresolved ? `, ${v.unresolved} relations named an unknown entity` : '') +
            (v.hinted ? `, ${v.hinted} hints kept` : '') +
            (v.retried
              ? `, ${v.retried} strict quote retries (${v.retriedFixed} fixed, ${v.retriedFailed} failed)`
              : ''),
        ),
      );
    }
    if (stats.executionFailures) {
      console.log(
        C.yellow(
          `  ${stats.executionFailures} ${stats.fragmentMode ? 'fragment' : 'window'}(s) failed before producing an outcome; see diagnostics`,
        ),
      );
    }
    if (stats.emptyWindows.length) {
      const unit = stats.fragmentMode ? 'fragment' : 'window';
      console.log(C.dim(`  ${stats.emptyWindows.length} ${unit}(s) produced nothing:`));
      for (const w of stats.emptyWindows) console.log(C.dim(`    #${w.index} ${w.locator}: ${w.reason}`));
    }
    if (stats.windowIssues.length) {
      const unit = stats.fragmentMode ? 'fragment' : 'window';
      console.log(C.dim(`  ${stats.windowIssues.length} ${unit}(s) incomplete and left unmined:`));
      for (const w of stats.windowIssues) {
        const sections = [...w.failedSections, ...(w.incompleteSections ?? [])].join(', ');
        console.log(C.dim(`    #${w.index} ${w.locator}: ${w.state} (${sections}) — ${w.detail}`));
      }
    }
    if (stats.contested && (stats.contested.facts || stats.contested.relations)) {
      console.log(
        C.dim(
          `  contested: ${stats.contested.facts} fact(s), ${stats.contested.relations} relation(s) flagged rivals (see "fanfable lore diagnose")`,
        ),
      );
    }
    if (stats.quarantinedAliases.length) {
      console.log(
        C.dim(`  ${stats.quarantinedAliases.length} near-duplicate name(s) left for review; see "fanfable lore merge"`),
      );
    }
    console.log(C.dim(staged ? '  staged work is not visible to retrieval, writer or canon; a separate publication path is required' : '  review them with "fanfable lore show"'));
    return;
  }

  if (sub === 'embed') {
    heading('Embedding book lore');
    const cfg = embeddings.resolveEmbedConfig(db, project.id, {
      model: flagString(args, 'model') || undefined,
      fallbackBaseUrl: a.llm.settings.baseUrl,
    });
    const stats = await embeddings.embedBackfill(
      db,
      project.id,
      { ...cfg, batchSize: flagNumber(args, 'batch', 32) },
      (m) => process.stdout.write(`  ${C.dim(m)}\n`),
    );
    console.log(
      `${C.green('embedded')} ${stats.embedded} vectors for ${C.bold(stats.model)} ` +
        `(${stats.skipped} already embedded, ${stats.dims} dims)`,
    );
    return;
  }

  if (sub === 'trails') {
    const query = flagString(args, 'query');
    if (!query) throw new Error('query required: lore trails --query "..."');
    const slug = query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    const out = flagString(args, 'out') || `trails-${slug || 'query'}.html`;
    const web = args.flags.web === true;
    heading(`Answer trails for "${query}"`);
    const traceStartedAt = new Date().toISOString();
    const queryHash = createHash('sha256').update(query, 'utf8').digest('hex');
    let traceId: string | undefined;
    let traceBuffer: ReturnType<typeof traceLog.createRetrievalTraceBuffer> | undefined;
    let retrieveTrace: traceLog.RetrievalTraceSink | undefined;
    let trailsTrace: traceLog.RetrievalTraceSink | undefined;
    try {
      const trace = traceLog.startTrace(db, {
        projectId: project.id,
        startedAt: traceStartedAt,
        metadata: {
          command: 'lore trails',
          query_sha256: queryHash,
          query_length: query.length,
          web,
        },
      });
      traceId = trace.id;
      traceBuffer = traceLog.createRetrievalTraceBuffer({ candidateDetailLimit: 24 });
      retrieveTrace = traceLog.withRetrievalTraceSpan(traceBuffer, 'sp-retrieve');
      trailsTrace = traceLog.withRetrievalTraceSpan(traceBuffer, 'sp-trails');
    } catch {
      // Diagnostic tracing must never block the trails command.
    }
    const finishTrailTrace = (interrupted = false): void => {
      if (!traceId || !traceBuffer) return;
      const flushed = traceLog.flushRetrievalTrace(db, project.id, traceId, traceBuffer);
      traceLog.finishTrace(
        db,
        traceId,
        interrupted
          ? { interrupted: true }
          : flushed.sampled
            ? { completeness: 'sampled' }
            : {},
      );
    };
    try {
      // The same retrieval the app uses; trails ride along on it. A lookup
      // route answers from words alone, so its passages are merged with any
      // graph passages before the shared bank ranker picks the four to draw.
      const pkg = await retrieval.retrieve(db, a.llm, project.id, {
        query,
        web,
        trace: retrieveTrace,
      });
      const graphTrails = pkg.graph.trails ?? [];
      const byChunk = new Map(graphTrails.map((t) => [t.chunkId, t]));
      const candidates: lore.Passage[] = [];
      const seen = new Set<number>();
      const origins = new Map<number, Set<string>>();
      const remember = (chunkId: number, origin: string): void => {
        const set = origins.get(chunkId) ?? new Set<string>();
        set.add(origin);
        origins.set(chunkId, set);
      };
      const add = (passage: lore.Passage, origin: string): void => {
        remember(passage.chunkId, origin);
        if (seen.has(passage.chunkId)) return;
        seen.add(passage.chunkId);
        candidates.push(passage);
      };
      // The package is budgeted for a prompt; trails are a diagnostic and want
      // the keyword hits the budget trimmed away, plus every graph passage.
      const trailSource = lore.searchCanon(db, project.id, query, {
        limit: 4,
        trace: trailsTrace,
        traceSubject: 'search:fts:trail-source',
      });
      for (const passage of trailSource) add(passage, 'fts-trail-source');
      for (const passage of pkg.passages) add(passage, 'package');
      for (const passage of pkg.graph.passages) {
        add({ ...passage, sourceId: 0, sourceTitle: '', path: '', heading: '', score: 0 }, 'graph');
      }
      const ranked = lorebook.rankWithBank(db, project.id, query, candidates);
      const trails: PassageTrail[] = ranked.slice(0, 4).map((passage) => {
        const known = byChunk.get(passage.chunkId);
        if (known) return known;
        return { chunkId: passage.chunkId, locator: passage.locator, score: 0, steps: [] };
      });
      if (trailsTrace) {
        for (let i = 0; i < trails.length; i++) {
          const trail = trails[i]!;
          for (const origin of origins.get(trail.chunkId) ?? []) {
            trailsTrace.emit({
              event: 'retrieval.candidate.generated',
              subject: `chunk:${trail.chunkId}`,
              decision: 'candidate',
              reasonCode: origin,
              refs: { chunk_id: trail.chunkId, rank: i + 1, stage: 'final-bank-rank' },
            });
          }
          trailsTrace.emit({
            event: 'retrieval.candidate.disposition',
            subject: `chunk:${trail.chunkId}`,
            decision: 'selected',
            reasonCode: 'selected',
            refs: { chunk_id: trail.chunkId, rank: i + 1, score: trail.score, stage: 'final-bank-rank' },
          });
          trailsTrace.emit({
            event: 'retrieval.trail.recorded',
            subject: `chunk:${trail.chunkId}`,
            decision: 'selected',
            reasonCode: trail.steps.length ? 'trail' : 'word-only',
            refs: {
              chunk_id: trail.chunkId,
              rank: i + 1,
              score: trail.score,
              step_count: trail.steps.length,
              stage: 'trail-score',
            },
          });
        }
        const budgeted = Math.max(0, ranked.length - trails.length);
        if (budgeted) {
          trailsTrace.emit({
            event: 'retrieval.budget.cutoff',
            subject: 'budget:trails',
            decision: 'budgeted',
            reasonCode: 'trail-cap',
            refs: { count: budgeted, stage: 'final-bank-rank' },
          });
        }
        trailsTrace.emit({
          event: 'retrieval.summary',
          subject: 'trails:final',
          decision: 'completed',
          reasonCode: trails.length ? 'ok' : 'empty',
          refs: {
            raw_count: [...origins.values()].reduce((n, set) => n + set.size, 0),
            dedup_count: candidates.length,
            ranked_count: ranked.length,
            selected_count: trails.length,
            budgeted_count: budgeted,
            excluded_count: 0,
            stage: 'final-bank-rank',
          },
        });
        trailsTrace.emit({
          event: 'retrieval.completed',
          subject: 'retrieval:trails',
          decision: 'completed',
          reasonCode: trails.length ? 'ok' : 'empty',
          refs: { count: trails.length, stage: 'trails' },
        });
      }
      for (const trail of trails) {
        console.log(`\n${C.cyan(trail.locator)} ${C.dim(`(score ${trail.score.toFixed(3)})`)}`);
        console.log(`  ${trailText(trail) || C.dim('(no passages matched)')}`);
      }
      writeFileSync(out, buildTrailsHtml(query, trails));
      console.log(`\n${C.green('wrote')} ${out}`);
      finishTrailTrace();
      if (traceId) console.log(`${C.dim(`trace ${traceId}`)}`);
      return;
    } catch (error) {
      finishTrailTrace(true);
      throw error;
    }
  }

  if (sub === 'ties') {
    const fromName = flagString(args, 'from');
    const toName = flagString(args, 'to');
    if (!fromName || !toName) throw new Error('names required: lore ties --from "Harry Potter" --to "Ron"');
    const from = lorebook.findEntity(db, project.id, fromName);
    if (!from) throw new Error(`no one called "${fromName}" (the --from side)`);
    const to = lorebook.findEntity(db, project.id, toName);
    if (!to) throw new Error(`no one called "${toName}" (the --to side)`);
    const showSupporting = args.flags.supporting === true || args.flags.assessment === true;
    const showAssessment = args.flags.assessment === true;
    const atRaw = flagNumber(args, 'at', NaN);
    const atSeq = Number.isFinite(atRaw) ? atRaw : undefined;
    const directed = lorebook.directedPairStatus(db, project.id, from.id, to.id, atSeq);
    const corroborated = lorebook.relationCorroboration(db, project.id);
    if (args.flags.brief === true) {
      const plain = (status: string): string =>
        status === 'user_confirmed'
          ? 'confirmed by you'
          : status === 'accepted'
            ? 'confirmed'
            : status === 'attested'
              ? 'attested'
              : status === 'provisional'
                ? 'uncertain'
                : status === 'needs_review'
                  ? 'uncertain (held for review)'
                  : status;
      const one = (r: lorebook.StatusRow): string =>
        `${r.fromName} — ${r.kind} — ${r.toName}  [${plain(r.reviewStatus)}]` +
        (r.locator ? `  (${r.locator})` : '');
      const lines: string[] = [];
      if (directed.forward.current) lines.push(one(directed.forward.current));
      if (directed.reverse.current) lines.push(one(directed.reverse.current));
      if (!lines.length) {
        const earlier = directed.forward.history.length + directed.reverse.history.length;
        console.log(
          `no current tie banked between ${from.name} and ${to.name}` +
            (earlier ? ` (${earlier} earlier claim${earlier === 1 ? '' : 's'})` : ''),
        );
      } else {
        for (const line of lines) console.log(line);
      }
      return;
    }
    heading(
      `Ties: ${from.name} ↔ ${to.name}` + (atSeq !== undefined ? C.dim(` (at passage ${atSeq})`) : ''),
    );
    if (!directed.forward.current && !directed.forward.history.length && !directed.reverse.current && !directed.reverse.history.length) {
      console.log(C.dim('(no ties banked between them)'));
      return;
    }
    const show = (r: lorebook.StatusRow): void => {
      const promotion = r.reviewStatus === 'needs_review' ? lorebook.canPromoteRelation(db, project.id, r.id) : null;
      const promoteBadge = promotion
        ? promotion.ok
          ? C.green(' [promotable]')
          : C.dim(` [parked: ${promotion.reason}]`)
        : '';
      const badge = (r.conflictStatus !== 'none' ? C.dim(` [${r.conflictStatus}]`) : '') + promoteBadge;
      const support = (corroborated.get(r.id) ?? 1) > 1 ? C.dim(` [×${corroborated.get(r.id)} windows]`) : '';
      const where = r.locator ? C.dim(` [${r.locator}]`) : r.seq !== null ? C.dim(` (passage ${r.seq})`) : C.dim(' (unplaced)');
      console.log(`\n${C.bold(`${r.fromName} → ${r.toName}: ${r.kind}`)}${badge}${support}${where}`);
      if (r.description) console.log(`  ${r.description}`);
      if (r.evidence) console.log(`  ${C.dim(`"${r.evidence}"`)}`);
      const supporting = r.supportingEvidence ?? [];
      if (supporting.length) {
        console.log(C.dim(`  supporting: ${supporting.length}${showSupporting ? '' : ' (use --supporting for quotes)'}`));
        if (showSupporting) {
          for (const item of supporting) {
            const quote = item.quote || r.evidence;
            console.log(C.dim(`    "${quote}"${item.reason ? ` (${item.reason})` : ''}`));
            if (showAssessment) {
              const a = item.assessment;
              if (a) {
                console.log(
                  C.dim(
                    `      assessed: names_both ${a.names_both} · other ${a.other_person || '-'} · ` +
                      `asserted ${a.asserted} · hedge ${a.hedge || '-'} · kind_fit ${a.kind_fit || '-'} · ` +
                      `strength ${Number(a.strength).toFixed(2)}${a.why ? ` · ${a.why}` : ''}`,
                  ),
                );
              } else {
                console.log(C.dim('      (no assessment)'));
              }
            }
          }
        }
      }
      if (r.modality !== 'asserted') console.log(`  ${C.dim(`framed as: ${r.modality}`)}`);
    };
    if (directed.forward.current) {
      console.log(C.green(`Current ${from.name} → ${to.name}:`));
      show(directed.forward.current);
    }
    if (directed.forward.history.length) {
      console.log(C.dim(`${directed.forward.current ? '\nBefore:' : 'Only:'}`));
      for (const r of directed.forward.history) show(r);
    }
    if (directed.reverse.current || directed.reverse.history.length) {
      console.log(C.dim(`\nReverse ${to.name} → ${from.name}:`));
      if (directed.reverse.current) show(directed.reverse.current);
      for (const r of directed.reverse.history) show(r);
    }
    return;
  }

  if (sub === 'diagnose') {
    heading('Lore diagnostics');
    const gaps = loreDiag.diagnose(db, project.id, { limit: flagNumber(args, 'limit', 25) });
    if (!gaps.length) {
      console.log(C.green('No gaps found: every character has relations, and no obvious relationship is missing.'));
      return;
    }
    console.log(C.dim(`${gaps.length} possible gaps — nothing here has been changed.`));
    for (const g of gaps) {
      const colour = g.severity === 'warning' ? C.yellow : C.dim;
      console.log(`\n${colour(`[${g.severity}]`)} ${C.bold(g.subject)} — ${g.message}`);
      if (g.evidence) console.log(`   ${C.dim(g.evidence)}`);
      if (g.locator) console.log(`   ${C.dim('at ' + g.locator)}`);
      console.log(`   ${C.dim(g.suggestion)}`);
    }
    return;
  }

  if (sub === 'enrich') {
    const name = args._[2];
    if (!name) throw new Error('a name is required: fanfable lore enrich <name>');
    heading(`Re-reading the passages about ${name}`);
    // Handoff by default: an explicit --handoff path wins, else a handoff.json
    // sitting next to the database is used when present. Absent means plain order.
    const explicitHandoff = flagString(args, 'handoff') || undefined;
    let handoffPath = explicitHandoff;
    if (!handoffPath) {
      const conventional = join(dirname(resolve(flagString(args, 'db') || defaultDbPath())), 'handoff.json');
      if (existsSync(conventional)) handoffPath = conventional;
    }
    if (handoffPath) process.stdout.write(`  ${C.dim(`handoff: ${handoffPath}`)}\n`);
    const result = await loreDiag.enrichEntity(db, a.llm, project.id, name, {
      maxPassages: flagNumber(args, 'passages', 12),
      handoffPath,
      onProgress: (m) => process.stdout.write(`  ${C.dim(m)}\n`),
    });
    console.log(
      `${C.green('added')} ${result.relations} relations, ${result.facts} facts ` +
        `from ${result.passages} passages (new entries are marked as needing review)`,
    );
    const d = result.dropped ?? {};
    const droppedTotal = Object.values(d).reduce((a, b) => a + (b as number), 0);
    if (droppedTotal > 0) {
      console.log(
        `  ${C.dim(`dropped: ${Object.entries(d).filter(([, n]) => (n as number) > 0).map(([k, n]) => `${n} ${k}`).join(', ')}`)}`,
      );
    }
    return;
  }

  if (sub === 'names') {
    const limit = Math.max(1, Math.floor(flagNumber(args, 'limit', 25)));
    const roster = lorebook.buildNameRoster(db, project.id);
    heading('Name roster');
    console.log(`  ${roster.entries.length} surfaces`);
    for (const entry of roster.entries.slice(0, limit)) {
      const variants = entry.surfaces.length > 1 ? C.dim(` [+${entry.surfaces.length - 1} variant${entry.surfaces.length > 2 ? 's' : ''}]`) : '';
      console.log(
        `  ${String(entry.count).padStart(4)}  ${entry.surface}${variants} ${C.dim(`(${entry.trustedSource})`)}`,
      );
    }
    if (args.flags.diagnostics === true) {
      const diagnostics = roster.diagnostics;
      console.log('');
      console.log(
        `  sentence-initial candidates ${diagnostics.sentenceInitialCandidates}, ` +
          `accepted ${diagnostics.accepted}, rejected ${diagnostics.rejected}`,
      );
      console.log('  top rejected:');
      for (const row of diagnostics.topRejected) {
        console.log(`    ${String(row.count).padStart(4)}  ${row.surface}`);
      }
    }
    return;
  }

  if (sub === 'capacity') {
    const dryRun = args.flags['dry-run'] === true;
    const limit = args.flags.limit === undefined
      ? undefined
      : Math.max(0, Math.floor(flagNumber(args, 'limit', 0)));
    const ids = limit === undefined
      ? db.all<{ id: number }>('SELECT id FROM canon_entity WHERE project_id = ? ORDER BY id', project.id)
      : db.all<{ id: number }>('SELECT id FROM canon_entity WHERE project_id = ? ORDER BY id LIMIT ?', project.id, limit);
    const result = lorebook.checkEntityCapacity(db, project.id, ids.map((row) => row.id), { write: !dryRun });
    heading(dryRun ? 'Entity capacity (dry run)' : 'Entity capacity');
    console.log(
      `scanned ${result.scanned}, parked ${result.parked}, funneled ${result.funneled}, skipped ${result.skipped}, skippedReferenced ${result.skippedReferenced}`,
    );
    return;
  }

  if (sub === 'rulings') {
    const action = args._[2] ?? '';
    if (action === 'export') {
      const out = resolve(flagString(args, 'out') || 'testing/trials/rulings-export.json');
      const payload = lorebook.exportRulings(db, project.id);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
      heading('Rulings export');
      console.log(`  project ${C.bold(payload.counters.project)}`);
      console.log(
        `  keepers ${payload.counters.keepers}, note_rulings ${payload.counters.note_rulings}, identities ${payload.counters.identities}`,
      );
      console.log(C.dim(`  wrote ${out}`));
      return;
    }
    if (action === 'replay') {
      const input = flagString(args, 'in');
      if (!input) throw new Error('--in <path> required');
      const inputPath = resolve(input);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(inputPath, 'utf8'));
      } catch (err) {
        throw new Error(`cannot read rulings export at ${inputPath}: ${(err as Error).message}`);
      }
      const write = args.flags.write === true && args.flags['dry-run'] !== true;
      const limit = args.flags.limit === undefined
        ? undefined
        : Math.max(0, Math.floor(flagNumber(args, 'limit', 0)));
      const result = lorebook.replayRulings(db, project.id, raw, { write, limit });
      heading(write ? 'Rulings replay' : 'Rulings replay (dry run)');
      const table: [string, lorebook.RulingReplayCategory][] = [
        ['keepers', result.keepers],
        ['note_rulings', result.note_rulings],
        ['identities', result.identities],
        ['total', result.total],
      ];
      for (const [label, row] of table) {
        console.log(
          `  ${label.padEnd(12)} total ${row.total}, resolved ${row.resolved}, applied ${row.applied}, ` +
            `already_present ${row.already_present}, unresolved ${row.unresolved}`,
        );
      }
      for (const issue of result.issues) {
        const kind = issue.kind ? ` (${issue.kind})` : '';
        console.log(`  ${C.yellow('unresolved')} ${issue.category} ${issue.from} -> ${issue.to}${kind}: ${issue.reason}`);
      }
      return;
    }
    throw new Error('rulings action required: export or replay');
  }

  if (sub === 'link-facts') {
    const dryRun = args.flags['dry-run'] === true;
    const limit = args.flags.limit === undefined
      ? undefined
      : Math.max(0, Math.floor(flagNumber(args, 'limit', 0)));
    const result = lorebook.linkFactSubjects(db, project.id, { dryRun, limit });
    heading(dryRun ? 'Fact subject links (dry run)' : 'Fact subject links');
    console.log(
      `scanned ${result.scanned}, linked ${result.linked}, ambiguous ${result.ambiguous}, unmatched ${result.unmatched}`,
    );
    return;
  }

  if (sub === 'scan') {
    heading('Scanning sentences');
    const candidates = lorebook.scanSentenceCandidates(db, project.id);
    const max = Math.max(1, Math.floor(flagNumber(args, 'max', 0) || candidates.length));
    console.log(C.dim(`  ${candidates.length} candidate sentence(s); checking ${Math.min(max, candidates.length)}`));
    const result = await lorebook.verifySentenceCandidates(db, a.llm, project.id, candidates, {
      max,
      dryRun: args.flags['dry-run'] === true,
      onProgress: (message) => process.stdout.write(`  ${C.dim(message)}\n`),
    });
    console.log(
      `${C.green('scan')} checked ${result.checked}, accepted ${result.accepted}, ` +
        `parked ${result.parked}, refused ${result.refused}`,
    );
    return;
  }

  if (sub === 'hints') {
    const limit = Math.max(1, Math.floor(flagNumber(args, 'limit', 50)));
    const pending = lorebook.countTieHints(db, project.id, 'pending');
    const hints = lorebook.listTieHints(db, project.id, { status: 'pending', limit });
    heading('Unresolved-endpoint hints');
    if (!hints.length) {
      console.log(C.dim('(none)'));
    } else {
      for (const h of hints) {
        console.log(`  #${h.id} ${C.bold(h.fromName)} -> ${C.bold(h.toName)}: ${h.kind} ${C.dim(h.locator || 'unplaced')}`);
      }
    }
    console.log(C.dim(`${pending} pending`));
    return;
  }

  if (sub === 'regather') {
    const dryRun = args.flags['dry-run'] === true || args.flags.write !== true;
    const limit = args.flags.limit === undefined
      ? undefined
      : Math.max(0, Math.floor(flagNumber(args, 'limit', 0)));
    heading(dryRun ? 'Evidence regather (dry run)' : 'Evidence regather');
    const unverified = lorebook.regatherRelationEvidence(db, project.id, { dryRun, limit });
    const unproving = lorebook.regatherUnprovingEvidence(db, project.id, { dryRun, limit });
    console.log(JSON.stringify({
      keepers: unverified.keepers,
      unverified: unverified.unverified,
      unproving: unproving.unproving,
      repointed: unverified.repointed + unproving.repointed,
      parked: unverified.parked + unproving.parked,
      untouched: unverified.untouched + unproving.untouched,
    }));
    if (dryRun) console.log(C.dim('dry run: nothing written. Run with --write on a disposable copy.'));
    return;
  }

  if (sub === 'integrity') {
    const limit = Math.max(1, Math.floor(flagNumber(args, 'limit', 50)));
    const rows = lorebook.findUnverifiedKeepers(db, project.id);
    heading('Evidence integrity');
    if (!rows.length) {
      console.log(C.green('every keeper quote is verbatim in a cited chunk'));
      return;
    }
    for (const row of rows.slice(0, limit)) {
      console.log(
        `  ${C.yellow(row.reason)} ${C.bold(row.fromName)} / ${C.bold(row.toName)} — ${row.kind}` +
          ` ${C.dim(`[${row.reviewStatus}]`)}`,
      );
    }
    console.log(C.dim(`${rows.length} unverified keeper(s); nothing has been changed`));
    process.exitCode = 1;
    return;
  }

  if (sub === 'promote') {
    const dryRun = args.flags['dry-run'] === true;
    const limit = args.flags.limit === undefined
      ? undefined
      : Math.max(1, Math.floor(flagNumber(args, 'limit', 0)));
    const findEvidence = args.flags['find-evidence'] === true;
    heading(dryRun ? 'Provisional ties (dry run)' : 'Provisional ties');
    if (findEvidence) {
      const result = await lorebook.promoteProvisionalWithEvidence(db, a.llm, project.id, {
        limit: limit ?? 5,
        dryRun,
      });
      console.log(
        `  checked ${result.checked}, returned ${result.returned}, verified ${result.verified}, ` +
          `promoted ${result.promoted}, still provisional ${result.still.length}`,
      );
      for (const row of result.failed) {
        console.log(`  ${C.yellow('unverified')} #${row.id}: ${row.reason}`);
      }
      return;
    }
    const result = lorebook.promoteProvisional(db, project.id, { dryRun, limit });
    const reasons = new Map<string, number>();
    for (const row of result.still) reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1);
    console.log(`  checked ${result.checked}, promoted ${result.promoted}, still provisional ${result.still.length}`);
    for (const [reason, count] of [...reasons.entries()].sort((x, y) => y[1] - x[1])) {
      console.log(`  ${C.dim(`${count} ${reason}`)}`);
    }
    return;
  }

  if (sub === 'notes') {
    if (args.flags.prioritise === true || args.flags.resolve === true) {
      const queue = lorebook.prioritiseTieNotes(db, project.id, {
        limit: flagNumber(args, 'max', 25),
      });
      heading('Prioritising parked tie notes');
      if (!queue.length) {
        console.log(C.dim('(no pending notes)'));
        return;
      }
      for (const row of queue) {
        const mark = row.decision.ok
          ? C.green('promotable')
          : C.yellow(row.decision.reason ?? 'review');
        console.log(
          `  ${mark} ${C.bold(row.fromName)} / ${C.bold(row.toName)} — ${row.kind}` +
            (row.locator ? C.dim(` [${row.locator}]`) : ''),
        );
        console.log(C.dim(`    anchor: ${row.anchor || '(none)'}`));
        console.log(C.dim(`    why: ${row.why} (score ${row.score})`));
      }
      const ready = queue.filter((row) => row.decision.ok).length;
      console.log(C.dim(`${ready} promotable, ${queue.length - ready} need another look; nothing changed`));
      return;
    }
    const rows = db.all<{ reason: string; status: string; n: number }>(
      `SELECT reason, status, COUNT(*) AS n FROM canon_tie_note WHERE project_id = ? GROUP BY reason, status ORDER BY reason, status`,
      project.id,
    );
    if (!rows.length) {
      console.log(C.dim('(no parked tie notes)'));
      return;
    }
    heading('Parked tie notes');
    for (const r of rows) console.log(`  ${r.n} ${r.reason} / ${r.status}`);
    console.log(C.dim('run "fanfable lore notes --prioritise" to rank the pending ones for review'));
    return;
  }

  if (sub === 'evaluate') {
    heading('Evaluating banked ties');
    const result = await lorebook.evaluateTies(db, a.llm, project.id, {
      maxTies: flagNumber(args, 'max', 50),
      onProgress: (m) => process.stdout.write(`  ${C.dim(m)}\n`),
    });
    console.log(
      `${C.green('kept')} ${result.kept} ties, parked ${result.parked} for relabeling, ` +
        `${result.unproven} left untouched (${result.checked} judged)`,
    );
    return;
  }

  if (sub === 'status') {
    const watchFlag = args.flags.watch;
    const watchSecs = watchFlag === true ? 5 : watchFlag !== undefined ? Math.max(1, Number(watchFlag) || 5) : 0;
    const showStatus = (): number => {
      const total = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?', project.id)?.n ?? 0;
      const mined = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ? AND lore_mined = 1', project.id)?.n ?? 0;
      const counts = db.get<{ entities: number; relations: number; facts: number; timeline: number }>(
        `SELECT (SELECT COUNT(*) FROM canon_entity WHERE project_id = ?) AS entities,
                (SELECT COUNT(*) FROM canon_relation WHERE project_id = ?) AS relations,
                (SELECT COUNT(*) FROM canon_fact WHERE project_id = ?) AS facts,
                (SELECT COUNT(*) FROM canon_timeline WHERE project_id = ?) AS timeline`,
        project.id, project.id, project.id, project.id,
      )!;
      const notes = db.all<{ status: string; n: number }>(
        `SELECT status, COUNT(*) AS n FROM canon_tie_note WHERE project_id = ? GROUP BY status`,
        project.id,
      );
      const pct = total ? Math.round((mined / total) * 100) : 0;
      const filled = Math.round(pct / 5);
      heading(`Lore status: ${project.name}`);
      console.log(`  mined [${'#'.repeat(filled)}${'-'.repeat(20 - filled)}] ${pct}% (${mined}/${total} passages)`);
      console.log(`  bank: ${counts.entities} people, ${counts.relations} ties, ${counts.facts} facts, ${counts.timeline} events`);
      if (notes.length) {
        console.log(`  notes: ${notes.map((r) => `${r.n} ${r.status}`).join(', ')}`);
      } else {
        console.log(`  notes: ${C.dim('none parked')}`);
      }
      const last = lorebook.lastExtractionReport(db, project.id);
      if (last) {
        const v = last.verification;
        console.log(`  last run: ${v.verified} verified, ${v.repointed} repointed, ${v.dropped} dropped` +
          (v.moment ? `, ${v.moment} moments` : '') +
          (v.unsupported ? `, ${v.unsupported} unsupported` : '') +
          (v.redundant ? `, ${v.redundant} redundant` : '') +
          (last.windowIssues?.length ? `, ${last.windowIssues.length} incomplete window(s)` : ''));
      }
      return pct;
    };
    if (watchSecs > 0) {
      for (let i = 0; i < 3600; i++) {
        if (i > 0) console.clear();
        const pct = showStatus();
        if (pct >= 100) {
          console.log(C.green('  fully read'));
          break;
        }
        if (pct <= 0 && (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?', project.id)?.n ?? 0) === 0) {
          console.log(C.dim('  nothing imported yet'));
          break;
        }
        console.log(C.dim(`  refreshing every ${watchSecs}s (Ctrl-C to stop)`));
        await new Promise((r) => setTimeout(r, watchSecs * 1000));
      }
      return;
    }
    showStatus();
    return;
  }

  if (sub === 'correct') {
    const what = args._[2];
    if (what === 'relation') {
      const id = Number(args._[3]);
      if (!Number.isFinite(id)) throw new Error('a relation id is required');
      const ok = loreDiag.correctRelation(db, project.id, id, {
        kind: flagString(args, 'kind') || undefined,
        description: flagString(args, 'description') || undefined,
        evidence: flagString(args, 'evidence') || undefined,
        confirm: args.flags.unconfirmed !== true,
      });
      console.log(ok ? C.green('Relation updated.') : C.red('No such relation.'));
      return;
    }
    if (what === 'entity') {
      const id = Number(args._[3]);
      if (!Number.isFinite(id)) throw new Error('an entity id is required');
      const kind = flagString(args, 'kind');
      lorebook.updateEntity(db, project.id, id, {
        name: flagString(args, 'name') || undefined,
        summary: flagString(args, 'summary') || undefined,
        role: flagString(args, 'role') || undefined,
        status: flagString(args, 'status') || undefined,
        kind: kind ? (kind as never) : undefined,
      });
      console.log(C.green('Entity updated.'));
      return;
    }
    throw new Error('correct what? "relation" or "entity"');
  }

  if (sub === 'remove') {
    const what = args._[2];
    if (what === 'relation') {
      const id = Number(args._[3]);
      if (!Number.isFinite(id)) throw new Error('a relation id is required');
      const ok = loreDiag.removeRelation(db, project.id, id);
      console.log(ok ? C.green('Relation removed.') : C.red('No such relation.'));
      return;
    }
    if (what === 'entity') {
      const id = Number(args._[3]);
      if (!Number.isFinite(id)) throw new Error('an entity id is required');
      lorebook.deleteEntity(db, project.id, id);
      console.log(C.green('Entity removed.'));
      return;
    }
    throw new Error('remove what? "relation" or "entity"');
  }

  if (sub === 'judge-aliases') {
    heading('Judging quarantined aliases');
    const maxPairs = Math.max(1, flagNumber(args, 'max', 20));
    const { rulings, checked, pending } = await lorebook.judgeQuarantine(a.llm, db, project.id, { maxPairs });
    if (!rulings.length) {
      console.log(
        C.dim(pending ? `no rulings recorded; ${pending} pair(s) stay pending.` : 'nothing to judge: no pending pairs.'),
      );
      return;
    }
    for (const r of rulings) {
      const mark = r.verdict === 'merged' ? C.green('merged') : r.verdict === 'ruled' ? C.yellow('different') : C.dim(r.verdict);
      console.log(`${mark} ${C.bold(r.name)} / ${C.bold(r.candidate)} — ${r.reason}${r.quote ? ` — "${truncate(r.quote, 120)}"` : ''}`);
    }
    const merged = rulings.filter((r) => r.verdict === 'merged').length;
    console.log(C.dim(`${checked} pair(s) judged, ${merged} merged.`));
    return;
  }

  if (sub === 'dossier') {
    const name = args._.slice(2).join(' ').trim() || flagString(args, 'name') || '';
    if (!name) throw new Error('usage: lore dossier <name> [--json]');
    const entity = lorebook.findEntity(db, project.id, name);
    if (!entity) throw new Error(`no one called "${name}"`);
    const dossier = characterDossier(db, project.id, entity.id);
    if (!dossier) throw new Error(`no dossier for "${name}"`);
    if (args.flags.json === true) {
      console.log(JSON.stringify(dossier, null, 2));
      return;
    }
    heading(`${dossier.name} — ${dossier.kind}`);
    const span = dossier.firstChapter
      ? (dossier.lastChapter && dossier.lastChapter !== dossier.firstChapter
        ? `chapters ${dossier.firstChapter}-${dossier.lastChapter}`
        : `chapter ${dossier.firstChapter}`)
      : 'no chapter';
    console.log(C.dim(`${dossier.status} · ${span} · ${dossier.counts.relations} ties · ${dossier.counts.events} scenes`));
    if (dossier.aliases.length) console.log(C.dim(`also called: ${dossier.aliases.join(', ')}`));
    if (dossier.attributes && Object.keys(dossier.attributes).length) {
      console.log(C.dim(`facts: ${Object.entries(dossier.attributes).map(([k, v]) => `${k}=${String(v)}`).join(', ')}`));
    }
    if (dossier.relations.length) {
      console.log(`
${C.bold('Relations')}`);
      for (const relation of dossier.relations) {
        const arrow = relation.direction === 'out' ? '->' : '<-';
        console.log(`  ${relation.kind} ${arrow} ${relation.other.name} [${relation.status}]${relation.locator ? ` ${C.dim(relation.locator)}` : ''}`);
        if (relation.quote) console.log(`    "${truncate(relation.quote, 160)}"`);
      }
    }
    if (dossier.events.length) {
      console.log(`
${C.bold('Scenes')}`);
      for (const event of dossier.events) {
        console.log(`  ${event.title}${event.locator ? ` ${C.dim(event.locator)}` : ''}`);
        if (event.summary) console.log(`    ${C.dim(truncate(event.summary, 160))}`);
      }
    }
    return;
  }

  if (sub === 'merge') {
    heading('Merging duplicate lore entries');
    const result = lorebook.mergeCanonEntities(db, project.id);
    console.log(
      result.merged.length
        ? `${C.green('merged')} ${result.merged.length} entries:\n  ${result.merged.join('\n  ')}`
        : 'nothing to merge',
    );
    if (result.quarantined.length) {
      console.log(
        C.dim(
          `\n${result.quarantined.length} near-matches were left alone:\n  ` +
            result.quarantined.map((q) => `${q.name} / ${q.candidate} (${q.reason})`).join('\n  '),
        ),
      );
    }
    return;
  }

  if (sub === 'show') {
    const stats = lorebook.loreStats(db, project.id);
    heading('Book lore');
    console.log(
      `${stats.entities} entities (${stats.characters} characters, ${stats.locations} places, ${stats.rules} rules), ` +
        `${stats.relations} relationships, ${stats.facts} facts, ${stats.timeline} timeline entries`,
    );
    const kindFlag = flagString(args, 'kind');
    const kind = (['character', 'species', 'location', 'item', 'rule', 'faction', 'creature'] as const).find(
      (k) => k === kindFlag,
    );
    const entities = lorebook.listEntities(db, project.id, kind);
    if (entities.length) {
      heading('Entities');
      for (const e of entities) {
        console.log(
          `\n${C.bold(e.name)} ${C.dim(`[${e.kind}]${e.role ? ` ${e.role}` : ''}${e.status ? ` · ${e.status}` : ''}`)}`,
        );
        if (e.summary) console.log(`  ${e.summary}`);
        if (e.aliases.length) console.log(`  ${C.dim('also: ' + e.aliases.join(', '))}`);
        if (e.evidence) console.log(`  ${C.dim('evidence: ' + e.evidence)}`);
      }
    }
    const relations = lorebook.listRelations(db, project.id);
    if (relations.length) {
      heading('Relationships');
      for (const r of relations) {
        console.log(`  ${r.fromName} → ${r.toName}: ${r.kind}${r.description ? ` — ${r.description}` : ''}`);
      }
    }
    const facts = lorebook.listFacts(db, project.id, flagString(args, 'topic') || undefined);
    if (facts.length) {
      heading('Facts');
      for (const f of facts) {
        console.log(`  ${C.dim(`[${f.topic || f.kind}]`)} ${f.statement}`);
      }
    }
    const timeline = lorebook.listTimeline(db, project.id);
    if (timeline.length) {
      heading('Book timeline');
      for (const t of timeline) {
        console.log(`  ${C.dim(String(t.seq).padStart(3))} ${t.when ? C.dim(t.when + ' — ') : ''}${t.title}`);
      }
    }
    return;
  }

  if (sub === 'events') {
    if (args.flags.extract) {
      heading('Building canon event index');
      const chunkLimit =
        args.flags.limit === undefined ? undefined : Math.max(0, Math.floor(flagNumber(args, 'limit', 0)));
      const sourceId = flagNumber(args, 'source', undefined as unknown as number) || undefined;
      // Passages that exist, not passages this run chose to read: the limited
      // total would otherwise call an 8-passage slice of a 527-passage book
      // "complete".
      const available = sourceId
        ? db.get<{ n: number }>('SELECT count(*) AS n FROM canon_chunk WHERE project_id = ? AND source_id = ?', project.id, sourceId)?.n ?? 0
        : db.get<{ n: number }>('SELECT count(*) AS n FROM canon_chunk WHERE project_id = ?', project.id)?.n ?? 0;
      let progress = { passagesDone: 0, passagesTotal: 0 };
      const events = await lore.extractCanonEvents(db, a.llm, project.id, {
        sourceId,
        ...(chunkLimit === undefined ? {} : { chunkLimit }),
        onWindow: (p) => {
          progress = { passagesDone: p.passagesDone, passagesTotal: p.passagesTotal };
        },
      });
      // A partial index must never read like a finished one: the old line said
      // "indexed N events" after reading half the book and looked successful.
      const partial = progress.passagesDone < available;
      const report = partial ? 'Truncated' : 'Complete';
      const limitNote = partial && chunkLimit !== undefined ? ' Limit reached.' : '';
      console.log(
        `${report}: processed ${progress.passagesDone}/${available} passages; indexed ${events.length} events.${limitNote}`,
      );
      return;
    }
    const events = lore.listCanonEvents(db, project.id, flagNumber(args, 'limit', 50));
    heading('Canon events');
    if (!events.length) {
      console.log('(no index yet — run "fanfable lore events --extract")');
      return;
    }
    for (const e of events) {
      console.log(`${C.bold(`#${e.id}`)} ${e.title} ${C.dim(`${e.sourceTitle} :: ${e.locator}`)}`);
      if (e.summary) console.log(`  ${truncate(e.summary, 220)}`);
      if (e.participants.length) console.log(`  ${C.dim('participants: ' + e.participants.join(', '))}`);
    }
    return;
  }

  if (sub === 'relationships') {
    const wanted = flagString(args, 'status')?.trim();
    const pairs = lorebook.listRelationshipPairs(db, project.id).filter(
      (pair) => !wanted || pair.status === wanted,
    );
    const counts = new Map<string, number>();
    for (const pair of pairs) counts.set(pair.status, (counts.get(pair.status) ?? 0) + 1);
    heading('Relationship pairs');
    console.log(
      [...counts.entries()].map(([status, n]) => `${n} ${status}`).join(' · ') || '(none)',
    );
    for (const pair of pairs) {
      const locator = pair.locator ? C.dim(`  (${pair.locator})`) : '';
      const extra = pair.rows > 1 ? C.dim(`  +${pair.rows - 1} more`) : '';
      console.log(`  ${C.dim('[' + pair.status + ']')} ${pair.fromName} — ${pair.kind} — ${pair.toName}${locator}${extra}`);
    }
    return;
  }

  if (sub === 'proposals') {
    const proposals = lorebook.listTieProposals(db, project.id);
    heading('Tie proposals (not in the bank)');
    console.log(`${proposals.length} pairs proposed · ${proposals.reduce((n, p) => n + p.notes, 0)} notes`);
    for (const p of proposals.slice(0, flagNumber(args, 'limit', 40))) {
      const locator = p.locator ? C.dim(`  (${p.locator})`) : '';
      const extra = p.notes > 1 ? C.dim(`  +${p.notes - 1} notes`) : '';
      console.log(`  ${p.fromName} — ${p.kind} — ${p.toName}  ${C.dim('[' + p.reason + ']')}${locator}${extra}`);
    }
    return;
  }

  throw new Error(`unknown lore subcommand "${sub}"`);
}

async function cmdPlan(args: Args): Promise<void> {
  const project = requireProject(db, args);
  const a = app(db, args);
  const sub = args._[1] ?? '';

  if (sub === 'discuss') {
    const message = args._.slice(2).join(' ');
    if (!message) throw new Error('message required');
    const outline = planner.approvedOutline(db, project.id) ?? planner.latestOutline(db, project.id);
    const passages = await lore.searchCanon(db, project.id, message, { limit: 5 });
    const reply = await planner.discuss(a.llm, db, project.id, message, {
      outline,
      canonBrief: passages.map((p) => p.text).join('\n\n'),
    });
    heading('Planner');
    console.log(reply);
    return;
  }

  if (sub === 'chat') {
    const outline = planner.approvedOutline(db, project.id) ?? planner.latestOutline(db, project.id);
    console.log(C.dim('Talking to the planner. Empty line to exit.'));
    for (;;) {
      const message = await prompt('you> ');
      if (!message.trim()) break;
      const passages = await lore.searchCanon(db, project.id, message, { limit: 5 });
      const reply = await planner.discuss(a.llm, db, project.id, message, {
        outline,
        canonBrief: passages.map((p) => p.text).join('\n\n'),
      });
      console.log(`\n${C.cyan('planner>')} ${reply}\n`);
    }
    return;
  }

  if (sub === 'draft') {
    const premise = flagString(args, 'premise') || args._.slice(2).join(' ');
    if (!premise) throw new Error('a premise is required (--premise "...")');
    const divergence = flagString(args, 'divergence');
    const chapterCount = flagNumber(args, 'chapters', 6);

    heading('Planning with canon grounding');
    const { outline, warnings } = await controller.draftPlan(db, a.llm, project.id, {
      premise,
      divergence,
      chapterCount,
      preferences: { tone: flagString(args, 'tone'), pov: flagString(args, 'pov'), tense: flagString(args, 'tense') },
      userNotes: flagString(args, 'notes'),
    });
    for (const w of warnings) console.log(`${C.yellow('warning:')} ${w}`);
    printOutline(outline);
    console.log(
      `\n${C.yellow('This is a draft proposal.')} Review it, then run ${C.bold('fanfable plan approve')} to make it established.`,
    );
    return;
  }

  if (sub === 'show') {
    const outline = planner.approvedOutline(db, project.id) ?? planner.latestOutline(db, project.id);
    if (!outline) throw new Error('no outline yet — run "fanfable plan draft"');
    printOutline(outline);
    return;
  }

  if (sub === 'approve') {
    const version = args._[2] ? Number(args._[2]) : undefined;
    let outline = version
      ? db.get<{ id: number }>('SELECT id FROM outline WHERE project_id = ? AND version = ?', project.id, version)
      : undefined;
    if (!outline) {
      const latest = planner.latestOutline(db, project.id);
      if (!latest) throw new Error('no outline to approve');
      outline = { id: latest.id };
    }
    const approved = planner.approveOutline(db, project.id, outline.id);
    heading(`Approved outline v${approved.version}`);
    console.log(`status: ${C.green(approved.status)}`);
    printOutline(approved, true);
    return;
  }

  if (sub === 'revise') {
    const instruction = args._.slice(2).join(' ');
    if (!instruction) throw new Error('revision instruction required');
    const current = planner.approvedOutline(db, project.id) ?? planner.latestOutline(db, project.id);
    if (!current) throw new Error('no outline to revise');
    const chapterNumber = args.flags.chapter ? Number(args.flags.chapter) : undefined;
    heading(`Revising outline v${current.version}${chapterNumber ? ` (chapter ${chapterNumber})` : ''}`);
    const revised = await planner.reviseOutline(a.llm, current, instruction, { chapterNumber });
    // A revision is a new draft version, never an overwrite: history is kept,
    // and the approved material stays official until the new draft is approved.
    const updated = planner.saveOutline(db, project.id, {
      premise: revised.premise,
      divergence: revised.divergence,
      divergenceRef: revised.divergenceRef,
      canonRefs: revised.canonRefs,
      structure: revised.structure,
      chapters: revised.chapters,
      preferences: revised.preferences,
      status: 'draft',
    });
    printOutline(updated);
    console.log(
      `\n${C.dim(`Saved as a new draft (v${updated.version}); the approved v${current.version} is untouched. Re-approve to make the revision official.`)}`,
    );
    return;
  }

  throw new Error(`unknown plan subcommand "${sub}"`);
}

function printOutline(outline: planner.Outline, brief = false): void {
  heading(`Outline v${outline.version} [${outline.status}]`);
  console.log(`${C.bold('Premise:')} ${outline.premise}`);
  console.log(`${C.bold('Divergence:')} ${outline.divergence || '(not set)'}`);
  if (outline.divergenceRef) console.log(`${C.bold('Anchored to:')} ${outline.divergenceRef}`);
  if (outline.structure.length) {
    console.log(`\n${C.bold('Structure:')}`);
    outline.structure.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  }
  console.log(`\n${C.bold('Chapters:')}`);
  for (const c of outline.chapters) {
    console.log(`  ${C.bold(`Ch${c.number} — ${c.title}`)} ${C.dim(`(${c.targetWords} words)`)}`);
    if (!brief) {
      if (c.goal) console.log(`      goal: ${c.goal}`);
      if (c.synopsis) console.log(`      ${truncate(c.synopsis, 300)}`);
      if (c.scenes.length) {
        for (const s of c.scenes) {
          console.log(`        • ${s.title || '(untitled scene)'}${s.location ? ` @ ${s.location}` : ''}`);
          if (s.adaptations) console.log(`          ${C.dim('adaptation: ' + s.adaptations)}`);
        }
      }
      if (c.canonEventIds.length) console.log(`      ${C.dim('canon events: ' + c.canonEventIds.join(', '))}`);
      if (c.notes) console.log(`      ${C.yellow('notes: ' + c.notes)}`);
    }
  }
}

async function cmdWrite(args: Args): Promise<void> {
  const project = requireProject(db, args);
  const a = app(db, args);
  const sub = args._[1] ?? '';

  if (sub === 'next' || sub === 'chapter') {
    const chapterNumber = sub === 'chapter' ? Number(args._[2]) : undefined;
    if (sub === 'chapter' && !Number.isFinite(chapterNumber)) throw new Error('chapter number required');
    heading(chapterNumber ? `Writing chapter ${chapterNumber}` : 'Writing the next chapter');
    const result = await controller.writeChapter(db, a.llm, project.id, {
      chapterNumber,
      userInstructions: flagString(args, 'notes'),
      sceneSummary: flagString(args, 'scene') || undefined,
    });
    printWriteResult(result);
    return;
  }

  if (sub === 'show') {
    const n = Number(args._[2]);
    const chapter = controller.getChapter(db, project.id, n);
    if (!chapter) throw new Error(`chapter ${n} not found`);
    console.log(chapter.body);
    return;
  }

  if (sub === 'edit') {
    const n = Number(args._[2]);
    const file = flagString(args, 'file');
    const text = flagString(args, 'text');
    if (!Number.isFinite(n)) throw new Error('chapter number required');
    let body: string;
    if (file) {
      body = readFileSync(resolve(file), 'utf8');
    } else if (text) {
      body = text;
    } else {
      throw new Error('provide --file <path> or --text "<body>"');
    }
    const chapter = controller.setChapterBody(db, project.id, n, body, 'user edit');
    const impacted = controller.impactedByChapterEdit(db, project.id, n);
    console.log(`Saved chapter ${n} as a ${C.yellow('draft')} (${chapter.wordCount} words).`);
    if (impacted.length) {
      console.log(C.dim(`  ${impacted.length} other chapters mention this material and may need review.`));
    }
    return;
  }

  if (sub === 'regenerate') {
    const n = Number(args._[2]);
    if (!Number.isFinite(n)) throw new Error('chapter number required');
    const existing = controller.getChapter(db, project.id, n);
    if (existing) controller.setChapterBody(db, project.id, n, existing.body, 'before regeneration');
    heading(`Regenerating chapter ${n}`);
    const result = await controller.writeChapter(db, a.llm, project.id, {
      chapterNumber: n,
      userInstructions: flagString(args, 'notes'),
    });
    printWriteResult(result);
    return;
  }

  if (sub === 'approve') {
    const n = Number(args._[2]);
    if (!Number.isFinite(n)) throw new Error('chapter number required');
    heading(`Approving chapter ${n}`);
    const { chapter, issues, contextTraceId } = await controller.approveChapter(db, a.llm, project.id, n);
    console.log(`Chapter ${chapter.number} approved ${C.dim(`(${chapter.wordCount} words)`)}`);
    console.log(`Memory updated: summary, character states, knowledge, relationships, threads, timeline.`);
    printIssues(issues);
    if (contextTraceId) console.log(`${C.dim(`trace ${contextTraceId}`)}`);
    return;
  }

  if (sub === 'list') {
    const chapters = controller.listChapters(db, project.id);
    heading('Chapters');
    if (!chapters.length) {
      console.log('(none yet)');
      return;
    }
    for (const c of chapters) {
      const status = c.status === 'approved' ? C.green(c.status) : C.yellow(c.status);
      console.log(
        `  ${C.bold(`Ch${c.number}`)} ${c.title.padEnd(28)} ${status} ${C.dim(`${c.wordCount} words`)}`,
      );
    }
    return;
  }

  throw new Error(`unknown write subcommand "${sub}"`);
}

function printWriteResult(result: controller.WriteChapterResult): void {
  console.log(
    `\nDraft written: ${C.bold('chapter ' + result.chapter.number)} ${C.dim(
      `(${result.chapter.wordCount} words, status ${result.chapter.status})`,
    )}`,
  );
  if (result.trace.length) {
    console.log(`\n${C.bold('Context requested during writing:')}`);
    for (const t of result.trace) {
      console.log(`  • [${t.request.kind}] ${t.request.query}`);
      console.log(`    ${C.dim(truncate(t.answer.content.replace(/\n+/g, ' '), 160))}`);
    }
  }
  if (result.issues.length) {
    console.log(`\n${C.bold('Continuity notes:')}`);
    printIssues(result.issues);
  }
  if (result.contextTraceId) console.log(`${C.dim(`context trace ${result.contextTraceId}`)}`);
  if (result.writeTraceId) console.log(`${C.dim(`write trace ${result.writeTraceId}`)}`);
  console.log(
    `\nReview it with ${C.bold(`fanfable write show ${result.chapter.number}`)} ` +
      `then ${C.bold(`fanfable write approve ${result.chapter.number}`)}.`,
  );
}









let db: Db;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0];

  if (!command || command === 'help' || args.flags.help) {
    console.log(HELP);
    return;
  }

  const dbPath = resolve(flagString(args, 'db') || defaultDbPath());

  // Trace inspection must not use Db: Db creates directories, runs migrations,
  // normalises rows and writes schema_meta. Open a genuinely read-only
  // connection and never fall back to the writable path.
  if (command === 'trace') {
    await cmdTrace(db, args, dbPath);
    return;
  }

  db = new Db(dbPath);

  try {
    switch (command) {
      case 'project':
        await cmdProject(args);
        break;
      case 'import':
        await cmdImport(args);
        break;
      case 'sources':
        await cmdSources(args);
        break;
      case 'lore':
        await cmdLore(args);
        break;
      case 'plan':
        await cmdPlan(args);
        break;
      case 'write':
        await cmdWrite(args);
        break;
      case 'check':
        await cmdCheck(db, args);
        break;
      case 'issues':
        await cmdIssues(db, args);
        break;
      case 'state':
        await cmdState(db, args);
        break;
      case 'continuity':
        await cmdContinuity(db, args);
        break;
      case 'graph':
        await cmdGraph(db, args);
        break;
      case 'conflicts':
        await cmdConflicts(db, args);
        break;
      case 'llm':
        await cmdLlm(db, args);
        break;
      case 'serve': {
        // An explicit --project must win, including when the database has other
        // projects. Only without one do we fall back to the last used project
        // (which may live in another database) and then to the first project.
        const requestedProject = flagString(args, 'project');
        const rememberedProject = typeof globalState().lastProject === 'string'
          ? globalState().lastProject as string
          : '';
        let project = controller.getProjectByName(db, requestedProject || rememberedProject);
        if (!project && requestedProject) {
          throw new Error(`no project named "${requestedProject}"`);
        }
        if (!project) {
          const all = controller.listProjects(db);
          project = all[0];
          if (!project) {
            console.log(C.dim('no projects in this database yet — create one from the browser interface'));
          } else {
            console.log(C.dim(`using project "${project.name}"`));
          }
        }
        const port = flagNumber(args, 'port', 8123);
        const { startServer } = await import('./product/server.ts');
        const server = startServer({ db, projectId: project?.id ?? null, port });
        // Keep the process (and the database) alive until interrupted.
        await new Promise<void>((resolve) => {
          const stop = () => {
            // The server has to be closed as well: leaving it listening would
            // keep the port bound and every later request would find a closed
            // database behind it.
            server.close(() => resolve());
            server.closeIdleConnections?.();
          };
          process.on('SIGINT', () => {
            console.log('\nshutting down');
            stop();
          });
          process.on('SIGTERM', () => stop());
        });
        return;
      }
      default:
        console.log(HELP);
        throw new Error(`unknown command "${command}"`);
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  if (err instanceof LlmError) {
    console.error(`\n${C.red('Model error:')} ${err.message}`);
  } else {
    console.error(`\n${C.red('Error:')} ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exitCode = 1;
});
