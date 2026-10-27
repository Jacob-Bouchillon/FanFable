#!/usr/bin/env node
/**
 * fanfable — local AI fanfiction generator.
 *
 * Command line interface. Everything the prototype can do is reachable here:
 * create/reopen a project, import sources, search lore, plan collaboratively,
 * write and approve chapters, inspect warnings and memory.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Db } from './db.ts';
import {
  DEFAULT_LLM_SETTINGS,
  LlmError,
  configPath,
  loadGlobalConfig,
  saveGlobalConfig,
} from './llm.ts';
import { clientFrom } from './llm.ts';
import type { LlmSettings } from './llm.ts';
import * as lore from './lore.ts';
import * as lorebook from './lorebook.ts';
import * as embeddings from './embeddings.ts';
import * as graph from './graph.ts';
import * as loreDiag from './lore-diagnostics.ts';
import { listConflicts, resolveConflict } from './state-conflicts.ts';
import * as memory from './memory.ts';
import * as planner from './planner.ts';
import * as continuity from './continuity.ts';
import { continuitySettings } from './continuity-settings.ts';
import * as controller from './controller.ts';
import * as retrieval from './retrieval.ts';
import type { PassageTrail } from './graph.ts';
import { truncate } from './text.ts';
import { buildTrailsHtml, trailText } from './trail-html.ts';

/* ------------------------------------------------------------------- args */

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args.flags[name] = next;
        i++;
      } else {
        args.flags[name] = true;
      }
    } else if (token.startsWith('-') && token.length > 1) {
      const name = token.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        args.flags[name] = next;
        i++;
      } else {
        args.flags[name] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

const C = {
  bold: (s: string) => `\u001b[1m${s}\u001b[0m`,
  dim: (s: string) => `\u001b[2m${s}\u001b[0m`,
  red: (s: string) => `\u001b[31m${s}\u001b[0m`,
  yellow: (s: string) => `\u001b[33m${s}\u001b[0m`,
  green: (s: string) => `\u001b[32m${s}\u001b[0m`,
  cyan: (s: string) => `\u001b[36m${s}\u001b[0m`,
};

function heading(text: string): void {
  console.log(`\n${C.bold(text)}\n${C.dim('-'.repeat(Math.min(text.length, 70)))}`);
}

/* ------------------------------------------------------------------ paths */

function defaultDbPath(): string {
  if (process.env.FANFABLE_DB) return process.env.FANFABLE_DB;
  const base =
    process.env.FANFABLE_DATA_DIR || join(homedir(), '.local', 'share', 'fanfable');
  return join(base, 'fanfable.db');
}

function globalState(): Record<string, unknown> {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function setGlobalState(patch: Record<string, unknown>): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  const current = globalState();
  writeFileSync(p, JSON.stringify({ ...current, ...patch }, null, 2));
}

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

${C.bold('SOURCE MATERIAL')}
  import <file...>                 Import source files into canon
  sources                          List imported sources
  lore search <query>              Search canon, show passages with references
  lore ask <question>              Answer a lore question with citations
  lore extract [--model m] [--max-windows n] [--priority-first n] [--random-floor f] [--seed n] [--full]
                           Extract the book's lore: people, places, rules, facts.
                           No budget flags mines everything; --max-windows caps it (top priority
                           first, seeded sample of the rest); --full ignores the budget.
  lore embed [--model m]           Embed passages, entities and triples for dense retrieval
  lore trails --query "..." [--out f]  Draw how each top passage connects to the query
                           [--web] show the association layer too (default off)
  lore hints [--limit n]           List ties whose endpoints are not in the bank
  lore link-facts [--dry-run] [--limit n]  Attach fact subjects to entities
  lore capacity [--dry-run] [--limit n]  Park unproven entities, funnel proven nouns
  lore rulings export [--out path]  Export keepers, note rulings and alias identities by name
  lore rulings replay --in path [--write] [--dry-run] [--limit n]
                           Reapply an exported ruling file to this project
  lore ties --from A --to B [--at n]  What two people are to each other now, and before
  lore merge                       Merge entries that are the same under two names
  lore judge-aliases [--max n]     Rule on quarantined nickname pairs (one model call)
  lore diagnose                    Report what the index is probably missing
  lore enrich <name> [--handoff f] Re-read the passages about one character
  lore notes [--resolve] [--max n] Parked tie failures; resolve them with one closed-vocabulary pass
  lore evaluate [--max n]        Judge each banked tie with understanding; failures park as notes
  lore status [--watch [secs]]     How much of the book is read, banked, and waiting
  lore correct relation <id>       Correct a relation by hand
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

${C.bold('MODEL')}
  llm status                       Check that the model server is reachable
  llm config --provider ollama --model llama3.1:8b --base-url http://127.0.0.1:11434

${C.bold('UI')}
  serve [--port 8123]               Open the browser interface (everything, in one place)
`;

/* -------------------------------------------------------------- utilities */

function requireProject(args: Args): controller.Project {
  const name = (args.flags.project as string) ?? (globalState().lastProject as string);
  if (!name) {
    throw new Error(
      'No project selected. Use --project <name>, or run "fanfable project use <name>".',
    );
  }
  const project = controller.getProjectByName(db, name);
  if (!project) throw new Error(`no project named "${name}"`);
  return project;
}

function app(args: Args): controller.App {
  const project = requireProject(args);
  // A --model flag wins everywhere, same as the extract command's override.
  // Without it the project (then global, then built-in) default applies.
  const m = flagString(args, 'model');
  const settings = m ? { ...(project.settings as object), model: m } : project.settings;
  return new controller.App(db, project.id, clientFrom(settings));
}

function flagString(args: Args, name: string, fallback = ''): string {
  const v = args.flags[name];
  return typeof v === 'string' ? v : fallback;
}

function flagNumber(args: Args, name: string, fallback: number): number {
  const v = args.flags[name];
  const n = typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** An optional numeric flag: absent (or unparsable) means "no budget". */
function budgetFlag(args: Args, name: string): number | undefined {
  const n = flagNumber(args, name, NaN);
  return Number.isFinite(n) ? n : undefined;
}

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
      const p = requireProject(args);
      const patch: Record<string, unknown> = {};
      for (const key of ['provider', 'baseUrl', 'model'] as const) {
        const v = flagString(args, key);
        if (v) patch[key === 'baseUrl' ? 'baseUrl' : key] = v;
      }
      const temp = flagNumber(args, 'temperature', NaN);
      if (Number.isFinite(temp)) patch.temperature = temp;
      if (Object.keys(patch).length) {
        const updated = controller.updateProjectSettings(db, p.id, patch);
        console.log(`Updated settings for ${C.bold(p.name)}`);
        console.log(JSON.stringify({ ...DEFAULT_LLM_SETTINGS, ...loadGlobalConfig(), ...updated.settings }, null, 2));
        return;
      }
      console.log(JSON.stringify({ ...DEFAULT_LLM_SETTINGS, ...loadGlobalConfig(), ...p.settings }, null, 2));
      return;
    }
    default:
      throw new Error(`unknown project subcommand "${sub}"`);
  }
}

async function cmdImport(args: Args): Promise<void> {
  const project = requireProject(args);
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
  const project = requireProject(args);
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
  const project = requireProject(args);
  const sub = args._[1] ?? '';
  const a = app(args);

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
    });
    heading('Lore answer');
    console.log(res.answer);
    if (res.passages.length) {
      console.log(`\n${C.dim('sources:')}`);
      res.passages.forEach((p, i) => console.log(`  [S${i + 1}] ${p.sourceTitle} :: ${p.locator}`));
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
      maxWindows: budgetFlag(args, 'max-windows'),
      priorityFirst: budgetFlag(args, 'priority-first'),
      randomFloor: budgetFlag(args, 'random-floor'),
      seed: budgetFlag(args, 'seed'),
      full: args.flags.full === true,
      onProgress: (m) => process.stdout.write(`  ${C.dim(m)}\n`),
    });
    console.log(
      `${C.green('extracted')} ${stats.entities} entities, ${stats.relations} relationships, ` +
        `${stats.facts} facts, ${stats.timeline} timeline entries`,
    );
    if (stats.selection) {
      console.log(
        C.dim(
          `  budget: mined ${stats.selection.selected} of ${stats.selection.total} windows, ` +
            `${stats.selection.skipped} left unmined (re-run with --full for the rest)`,
        ),
      );
    }
    const v = stats.verification;
    if (v.claimed) {
      console.log(
        C.dim(
          `  quotes: ${v.verified} verified, ${v.repointed} repointed, ${v.dropped} dropped` +
            (v.unresolved ? `, ${v.unresolved} relations named an unknown entity` : '') +
            (v.hinted ? `, ${v.hinted} hints kept` : ''),
        ),
      );
    }
    if (stats.emptyWindows.length) {
      console.log(C.dim(`  ${stats.emptyWindows.length} window(s) produced nothing:`));
      for (const w of stats.emptyWindows) console.log(C.dim(`    #${w.index} ${w.locator}: ${w.reason}`));
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
    console.log(C.dim('  review them with "fanfable lore show"'));
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
    // The same retrieval the app uses; trails ride along on it. A lookup
    // route answers from words alone, so its passages are merged with any
    // graph passages before the shared bank ranker picks the four to draw.
    const pkg = await retrieval.retrieve(db, a.llm, project.id, { query, web });
    const graphTrails = pkg.graph.trails ?? [];
    const byChunk = new Map(graphTrails.map((t) => [t.chunkId, t]));
    const candidates: lore.Passage[] = [];
    const seen = new Set<number>();
    const add = (passage: lore.Passage): void => {
      if (seen.has(passage.chunkId)) return;
      seen.add(passage.chunkId);
      candidates.push(passage);
    };
    // The package is budgeted for a prompt; trails are a diagnostic and want
    // the keyword hits the budget trimmed away, plus every graph passage.
    for (const passage of lore.searchCanon(db, project.id, query, { limit: 4 })) add(passage);
    for (const passage of pkg.passages) add(passage);
    for (const passage of pkg.graph.passages) {
      add({ ...passage, sourceId: 0, sourceTitle: '', path: '', heading: '', score: 0 });
    }
    const trails: PassageTrail[] = lorebook
      .rankWithBank(db, project.id, query, candidates)
      .slice(0, 4)
      .map((passage) => {
        const known = byChunk.get(passage.chunkId);
        if (known) return known;
        return { chunkId: passage.chunkId, locator: passage.locator, score: 0, steps: [] };
      });
    for (const trail of trails) {
      console.log(`\n${C.cyan(trail.locator)} ${C.dim(`(score ${trail.score.toFixed(3)})`)}`);
      console.log(`  ${trailText(trail) || C.dim('(no passages matched)')}`);
    }
    writeFileSync(out, buildTrailsHtml(query, trails));
    console.log(`\n${C.green('wrote')} ${out}`);
    return;
  }

  if (sub === 'ties') {
    const fromName = flagString(args, 'from');
    const toName = flagString(args, 'to');
    if (!fromName || !toName) throw new Error('names required: lore ties --from "Harry Potter" --to "Ron"');
    const from = lorebook.findEntity(db, project.id, fromName);
    if (!from) throw new Error(`no one called "${fromName}" (the --from side)`);
    const to = lorebook.findEntity(db, project.id, toName);
    if (!to) throw new Error(`no one called "${toName}" (the --to side)`);
    const atRaw = flagNumber(args, 'at', NaN);
    const atSeq = Number.isFinite(atRaw) ? atRaw : undefined;
    const directed = lorebook.directedPairStatus(db, project.id, from.id, to.id, atSeq);
    const corroborated = lorebook.relationCorroboration(db, project.id);
    heading(
      `Ties: ${from.name} ↔ ${to.name}` + (atSeq !== undefined ? C.dim(` (at passage ${atSeq})`) : ''),
    );
    if (!directed.forward.current && !directed.forward.history.length && !directed.reverse.current && !directed.reverse.history.length) {
      console.log(C.dim('(no ties banked between them)'));
      return;
    }
    const show = (r: lorebook.StatusRow): void => {
      const badge = r.conflictStatus !== 'none' ? C.dim(` [${r.conflictStatus}]`) : '';
      const support = (corroborated.get(r.id) ?? 1) > 1 ? C.dim(` [×${corroborated.get(r.id)} windows]`) : '';
      const where = r.locator ? C.dim(` [${r.locator}]`) : r.seq !== null ? C.dim(` (passage ${r.seq})`) : C.dim(' (unplaced)');
      console.log(`\n${C.bold(`${r.fromName} → ${r.toName}: ${r.kind}`)}${badge}${support}${where}`);
      if (r.description) console.log(`  ${r.description}`);
      if (r.evidence) console.log(`  ${C.dim(`"${r.evidence}"`)}`);
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

  if (sub === 'notes') {
    if (args.flags.resolve === true) {
      heading('Resolving parked tie notes');
      const result = await lorebook.resolveTieNotes(db, a.llm, project.id, {
        maxNotes: flagNumber(args, 'max', 25),
        onProgress: (m) => process.stdout.write(`  ${C.dim(m)}\n`),
      });
      console.log(
        `${C.green('resolved')} ${result.resolved} ties, ${result.confirmed} confirmed drops, ` +
          `${result.unproven} left pending (${result.pending} still waiting)`,
      );
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
    console.log(C.dim('run "fanfable lore notes --resolve" for one closed-vocabulary pass over the pending ones'));
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
          (v.redundant ? `, ${v.redundant} redundant` : ''));
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
      lorebook.updateEntity(db, project.id, id, {
        name: flagString(args, 'name') || undefined,
        summary: flagString(args, 'summary') || undefined,
        role: flagString(args, 'role') || undefined,
        status: flagString(args, 'status') || undefined,
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
      const events = await lore.extractCanonEvents(db, a.llm, project.id, {
        sourceId: flagNumber(args, 'source', undefined as unknown as number) || undefined,
      });
      console.log(`indexed ${events.length} canon events`);
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

  throw new Error(`unknown lore subcommand "${sub}"`);
}

async function cmdPlan(args: Args): Promise<void> {
  const project = requireProject(args);
  const a = app(args);
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
  const project = requireProject(args);
  const a = app(args);
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
    const impacted = controller.impactedMaterial(db, project.id, `chapter ${n}`);
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
    const { chapter, issues } = await controller.approveChapter(db, a.llm, project.id, n);
    console.log(`Chapter ${chapter.number} approved ${C.dim(`(${chapter.wordCount} words)`)}`);
    console.log(`Memory updated: summary, character states, knowledge, relationships, threads, timeline.`);
    printIssues(issues);
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
  console.log(
    `\nReview it with ${C.bold(`fanfable write show ${result.chapter.number}`)} ` +
      `then ${C.bold(`fanfable write approve ${result.chapter.number}`)}.`,
  );
}

function printIssues(issues: continuity.ContinuityIssue[]): void {
  if (!issues.length) {
    console.log(`${C.green('No continuity issues found.')}`);
    return;
  }
  for (const i of issues) {
    const color = i.severity === 'error' ? C.red : i.severity === 'warning' ? C.yellow : C.dim;
    console.log(`  ${color(`[${i.severity}]`)} ${C.bold(i.category)}: ${i.message}`);
    if (i.evidence) console.log(`      ${C.dim('evidence: ' + truncate(i.evidence, 220))}`);
    if (i.suggestion) console.log(`      ${C.dim('suggestion: ' + truncate(i.suggestion, 220))}`);
  }
}

async function cmdCheck(args: Args): Promise<void> {
  const project = requireProject(args);
  const a = app(args);
  const n = Number(args._[1]);
  if (!Number.isFinite(n)) throw new Error('chapter number required');
  const chapter = controller.getChapter(db, project.id, n);
  if (!chapter) throw new Error(`chapter ${n} not found`);
  heading(`Continuity check — chapter ${n}`);
  const outline = planner.approvedOutline(db, project.id);
  const bundle = await controller.assembleContext(db, a.llm, project.id, {
    chapter: outline?.chapters.find((c) => c.number === n),
    chapterNumber: n,
  });
  const issues = await controller.runContinuityCheck(db, a.llm, project.id, chapter, outline, bundle);
  printIssues(issues);
}

async function cmdIssues(args: Args): Promise<void> {
  const project = requireProject(args);
  const sub = args._[1];
  if (sub === 'resolve') {
    const id = Number(args._[2]);
    if (!Number.isFinite(id)) throw new Error('issue id required');
    const resolution = args.flags.fix ? 'fixed' : args.flags.accept ? 'accepted' : 'open';
    continuity.setIssueResolution(db, project.id, id, resolution);
    console.log(`issue ${id} marked ${resolution}`);
    return;
  }
  const issues = continuity.listIssues(db, project.id, { openOnly: args.flags.all !== true });
  heading('Continuity issues');
  if (!issues.length) {
    console.log('(none)');
    return;
  }
  for (const i of issues) {
    const color = i.severity === 'error' ? C.red : i.severity === 'warning' ? C.yellow : C.dim;
    console.log(
      `  ${C.bold(`#${i.id}`)} ${color(`[${i.severity}]`)} ${C.bold(i.category)} ${
        i.chapterNumber ? C.dim(`(ch${i.chapterNumber})`) : ''
      } ${C.dim(`[${i.resolution}]`)}`,
    );
    console.log(`      ${i.message}`);
    if (i.evidence) console.log(`      ${C.dim('evidence: ' + truncate(i.evidence, 200))}`);
  }
}

async function cmdContinuity(args: Args): Promise<void> {
  const project = requireProject(args);
  const current = continuitySettings(project);

  const hasFlags =
    args.flags.on !== undefined ||
    args.flags.off !== undefined ||
    args.flags.model !== undefined ||
    args.flags.severity !== undefined ||
    args.flags.drafts !== undefined;

  if (!hasFlags) {
    heading('Continuity checking');
    console.log(`enabled:        ${current.enabled ? C.green('yes') : C.yellow('no')}`);
    console.log(`model checks:   ${current.modelChecks ? 'yes' : 'no'}`);
    console.log(`check drafts:   ${current.onDraft ? 'yes' : 'no'}`);
    console.log(`report:         ${current.minSeverity} and above`);
    console.log(`\n${C.dim('change it with: fanfable continuity --off | --on | --model on|off | --drafts on|off | --severity error|warning|note')}`);
    return;
  }

  const next = { ...current };
  if (args.flags.on) next.enabled = true;
  if (args.flags.off) next.enabled = false;
  if (args.flags.model !== undefined) next.modelChecks = args.flags.model !== 'off' && args.flags.model !== 'false';
  if (args.flags.drafts !== undefined) next.onDraft = args.flags.drafts !== 'off' && args.flags.drafts !== 'false';
  if (args.flags.severity) {
    const sev = String(args.flags.severity);
    if (sev === 'error' || sev === 'warning' || sev === 'note') next.minSeverity = sev;
  }
  controller.updateProjectSettings(db, project.id, { continuity: next });
  heading('Continuity checking updated');
  console.log(`enabled:        ${next.enabled ? 'yes' : 'no'}`);
  console.log(`model checks:   ${next.modelChecks ? 'yes' : 'no'}`);
  console.log(`check drafts:   ${next.onDraft ? 'yes' : 'no'}`);
  console.log(`report:         ${next.minSeverity} and above`);
}

async function cmdGraph(args: Args): Promise<void> {
  const project = requireProject(args);
  const sub = args._[1] ?? 'stats';

  if (sub === 'stats') {
    const g = graph.loadGraph(db, project.id);
    const kinds = new Map<string, number>();
    for (const node of g.nodes.values()) kinds.set(node.kind, (kinds.get(node.kind) ?? 0) + 1);
    heading('Knowledge graph');
    console.log(`${g.nodes.size} nodes, ${g.edges.length} connections`);
    for (const [kind, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${kind.padEnd(16)} ${n}`);
    }
    const typeCounts = new Map<string, number>();
    for (const e of g.edges) typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
    if (typeCounts.size) {
      console.log(`\n${C.dim('connection types')}`);
      for (const [type, n] of [...typeCounts].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
        console.log(`  ${type.padEnd(20)} ${n}`);
      }
    }
    return;
  }

  const name = flagString(args, 'name') || (sub === 'stats' ? '' : sub);
  if (!name) throw new Error('a name is required: fanfable graph <name>');
  const hops = flagNumber(args, 'hops', 1);
  const g = graph.loadGraph(db, project.id);
  const roots = graph.resolveRoots(g, [name]);
  if (!roots.length) {
    console.log(C.yellow(`nothing in the graph is called "${name}"`));
    return;
  }
  const result = graph.traverse(g, {
    roots: roots.map((r) => r.node.id),
    hops,
    maxNodes: flagNumber(args, 'limit', 40),
  });
  heading(`Connections for "${name}"`);
  console.log(C.dim(`${result.nodes.size} nodes, ${result.edges.length} connections, ${hops} hop(s)`));
  const nameOf = (id: string) => g.nodes.get(id)?.name ?? id;
  for (const edge of result.edges) {
    const from = result.depth.get(edge.from) ?? 0;
    const to = result.depth.get(edge.to) ?? 0;
    const unsure = edge.confidence < 0.6 ? C.yellow(' [uncertain]') : '';
    console.log(
      `  ${'  '.repeat(Math.max(0, Math.min(from, to)))}${nameOf(edge.from)} ${C.cyan(`--${edge.type}-->`)} ${nameOf(edge.to)}${unsure}` +
        (edge.description ? C.dim(`  ${truncate(edge.description, 90)}`) : ''),
    );
  }
}

async function cmdConflicts(args: Args): Promise<void> {
  const project = requireProject(args);
  const sub = args._[1] ?? 'list';

  if (sub === 'resolve') {
    const id = Number(args._[2]);
    if (!Number.isFinite(id)) throw new Error('a conflict id is required');
    const status = (flagString(args, 'status') || 'accepted') as 'open' | 'accepted' | 'resolved';
    resolveConflict(db, project.id, id, status);
    console.log(`Conflict ${id} marked ${status}.`);
    return;
  }

  heading('Conflicts with established story state');
  const conflicts = listConflicts(db, project.id, { openOnly: args.flags.all !== true });
  if (!conflicts.length) {
    console.log(C.green('No conflicts: every approved chapter agrees with the story so far.'));
    return;
  }
  for (const c of conflicts) {
    console.log(
      `\n${C.yellow(`[${c.kind}]`)} ${C.bold(c.subject)} — ${c.message}` +
        `\n   ${C.dim('established: ' + c.existingRef + ' · this chapter: ' + c.incomingRef)}` +
        (c.evidence ? `\n   ${C.dim(c.evidence)}` : '') +
        `\n   ${C.dim('resolve with: fanfable conflicts resolve ' + c.id + ' --status accepted|resolved')}`,
    );
  }
}

async function cmdState(args: Args): Promise<void> {
  const project = requireProject(args);
  const sub = args._[1] ?? '';

  if (sub === 'characters') {
    const chars = memory.listCharacters(db, project.id);
    heading('Characters');
    if (!chars.length) {
      console.log('(none recorded yet — approve a chapter to extract state)');
      return;
    }
    const states = memory.currentStates(db, project.id);
    const knowledge = memory.listKnowledge(db, project.id);
    for (const c of chars) {
      console.log(`\n${C.bold(c.name)}${c.aliases.length ? C.dim(` (${c.aliases.join(', ')})`) : ''}`);
      if (c.profile) console.log(`  profile: ${truncate(c.profile, 300)}`);
      if (c.traits.length) console.log(`  traits: ${c.traits.join(', ')}`);
      const s = states.find((x) => x.characterId === c.id);
      if (s) {
        console.log(
          `  state: ${s.location || '?'} | ${s.condition || '?'} | ${s.emotional || '?'} | ${s.situation || '?'} ${C.dim(
            `(${s.source})`,
          )}`,
        );
      }
      const k = knowledge.filter((x) => x.characterId === c.id);
      if (k.length) {
        console.log('  knows:');
        for (const entry of k) console.log(`    - [${entry.certainty}] ${entry.fact}`);
      }
    }
    return;
  }

  if (sub === 'timeline') {
    const events = memory.listAuEvents(db, project.id);
    heading('AU timeline');
    if (!events.length) {
      console.log('(no events recorded yet)');
      return;
    }
    for (const e of events) {
      const link = e.adaptsCanonEventId ? C.cyan(` [adapts canon #${e.adaptsCanonEventId}]`) : '';
      const kind = e.kind !== 'event' ? C.yellow(` [${e.kind}]`) : '';
      console.log(
        `\n${C.bold(e.title)}${link}${kind} ${C.dim(`[${e.storyTime || `order ${e.storyOrder}`}]` +
          `${e.chapterNumber ? ` ch${e.chapterNumber}` : ''}`)}`,
      );
      if (e.summary) console.log(`  ${truncate(e.summary, 300)}`);
      if (e.participants.length) console.log(`  ${C.dim('who: ' + e.participants.join(', '))}`);
      if (e.location) console.log(`  ${C.dim('where: ' + e.location)}`);
      if (e.divergenceNote) console.log(`  ${C.yellow('changed from canon: ' + e.divergenceNote)}`);
    }
    return;
  }

  if (sub === 'threads') {
    const threads = memory.listThreads(db, project.id);
    heading('Plot threads');
    if (!threads.length) {
      console.log('(none)');
      return;
    }
    for (const t of threads) {
      console.log(`  ${C.bold(t.title)} [${t.status}]`);
      if (t.description) console.log(`    ${truncate(t.description, 220)}`);
      if (t.events.length) console.log(`    ${C.dim('events: ' + t.events.join(' | '))}`);
    }
    return;
  }

  if (sub === 'facts') {
    const facts = memory.listFacts(db, project.id);
    heading('Established facts and decisions');
    if (!facts.length) {
      console.log('(none)');
      return;
    }
    for (const f of facts) {
      console.log(`  ${C.bold(`[${f.kind}]`)} ${f.subject ? `${f.subject}: ` : ''}${f.content} ${C.dim(`(${f.certainty})`)}`);
    }
    return;
  }

  if (sub === 'requests') {
    const rows = db.all<{
      id: number;
      kind: string;
      query: string;
      result_count: number;
      status: string;
      created_at: string;
    }>(
      'SELECT id, kind, query, result_count, status, created_at FROM context_request WHERE project_id = ? ORDER BY id DESC LIMIT 100',
      project.id,
    );
    heading('Context requests');
    if (!rows.length) {
      console.log('(none)');
      return;
    }
    for (const r of rows) {
      console.log(
        `  ${C.bold(`#${r.id}`)} ${C.cyan(r.kind.padEnd(9))} ${r.status.padEnd(9)} ${r.result_count} results  ${r.query}`,
      );
    }
    return;
  }

  if (sub === 'set-character') {
    const name = args._[2];
    if (!name) throw new Error('character name required');
    const char = memory.resolveCharacter(db, project.id, name);
    if (!char) throw new Error('character not found');
    const location = flagString(args, 'location');
    const condition = flagString(args, 'condition');
    const emotional = flagString(args, 'emotional');
    const situation = flagString(args, 'situation');
    memory.addCharacterState(db, project.id, char.id, {
      location,
      condition,
      emotional,
      situation,
      source: 'user',
    });
    console.log(`Updated state for ${C.bold(char.name)}`);
    const impacted = controller.impactedMaterial(db, project.id, char.name);
    if (impacted.length) {
      console.log(C.dim(`  chapters mentioning ${char.name}: ${impacted.map((i) => i.chapter.number).join(', ')}`));
    }
    return;
  }

  if (sub === 'add-fact') {
    const content = flagString(args, 'content');
    if (!content) throw new Error('--content required');
    memory.addFact(db, project.id, {
      kind: flagString(args, 'kind', 'fact'),
      subject: flagString(args, 'subject'),
      content,
      certainty: 'established',
    });
    console.log('Fact recorded.');
    return;
  }

  if (sub === 'set-event') {
    const id = Number(args._[2]);
    if (!Number.isFinite(id)) throw new Error('event id required');
    const order = args.flags.order !== undefined ? flagNumber(args, 'order', NaN) : null;
    const kind = flagString(args, 'kind');
    const note = flagString(args, 'note');
    const existing = db.get<{ id: number; title: string; story_order: number; kind: string; divergence_note: string }>(
      'SELECT id, title, story_order, kind, divergence_note FROM au_event WHERE id = ? AND project_id = ?',
      id,
      project.id,
    );
    if (!existing) throw new Error(`event ${id} not found`);
    db.run(
      'UPDATE au_event SET story_order = ?, kind = ?, divergence_note = ? WHERE id = ? AND project_id = ?',
      order !== null && Number.isFinite(order) ? order : existing.story_order,
      kind || existing.kind,
      note || existing.divergence_note,
      id,
      project.id,
    );
    console.log(`Updated AU event ${id} "${existing.title}".`);
    const impacts = controller.impactedMaterial(db, project.id, existing.title);
    if (impacts.length) {
      console.log(
        C.dim(`  chapters mentioning "${existing.title}": ${impacts.map((i) => i.chapter.number).join(', ')}`),
      );
    }
    return;
  }

  // overview
  heading(`Story state — ${project.name}`);
  const outline = planner.approvedOutline(db, project.id);
  console.log(`outline: ${outline ? C.green(`v${outline.version} approved`) : C.yellow('none approved')}`);
  if (outline) console.log(`premise: ${truncate(outline.premise, 300)}`);
  const chapters = controller.listChapters(db, project.id);
  console.log(`chapters: ${chapters.length} (${chapters.filter((c) => c.status === 'approved').length} approved)`);
  console.log(`characters: ${memory.listCharacters(db, project.id).length}`);
  console.log(`timeline events: ${memory.listAuEvents(db, project.id).length}`);
  console.log(`open threads: ${memory.listThreads(db, project.id).filter((t) => t.status === 'open').length}`);
  const issues = continuity.listIssues(db, project.id, { openOnly: true });
  console.log(
    `continuity issues: ${issues.length} ${C.dim(
      `(${issues.filter((i) => i.severity === 'error').length} errors)`,
    )}`,
  );
}

async function cmdLlm(args: Args): Promise<void> {
  const sub = args._[1] ?? '';
  if (sub === 'config') {
    const patch: Partial<LlmSettings> = {};
    const provider = flagString(args, 'provider');
    const model = flagString(args, 'model');
    const baseUrl = flagString(args, 'base-url');
    const temperature = flagNumber(args, 'temperature', NaN);
    if (provider) patch.provider = provider as LlmSettings['provider'];
    if (model) patch.model = model;
    if (baseUrl) patch.baseUrl = baseUrl;
    if (Number.isFinite(temperature)) patch.temperature = temperature;
    saveGlobalConfig(patch);
    console.log(JSON.stringify({ ...DEFAULT_LLM_SETTINGS, ...loadGlobalConfig() }, null, 2));
    return;
  }

  if (sub === 'status' || sub === '') {
    const settings = { ...DEFAULT_LLM_SETTINGS, ...loadGlobalConfig() };
    heading('Model status');
    console.log(`provider: ${settings.provider}`);
    console.log(`base url: ${settings.baseUrl}`);
    console.log(`model: ${settings.model}`);
    const client = controller.createClient(settings);
    const ok = await client.available();
    console.log(ok ? C.green('server reachable') : C.red('server not reachable'));
    if (!ok) {
      console.log(
        C.dim(
          'Start a local server, e.g. "ollama serve" (Ollama) or "llama-server -m model.gguf" (llama.cpp).',
        ),
      );
    }
    return;
  }

  throw new Error(`unknown llm subcommand "${sub}"`);
}

/* ------------------------------------------------------------------- main */

let db: Db;

async function prompt(label: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(label);
  rl.close();
  return answer;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0];

  if (!command || command === 'help' || args.flags.help) {
    console.log(HELP);
    return;
  }

  const dbPath = resolve(flagString(args, 'db') || defaultDbPath());
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
        await cmdCheck(args);
        break;
      case 'issues':
        await cmdIssues(args);
        break;
      case 'state':
        await cmdState(args);
        break;
      case 'continuity':
        await cmdContinuity(args);
        break;
      case 'graph':
        await cmdGraph(args);
        break;
      case 'conflicts':
        await cmdConflicts(args);
        break;
      case 'llm':
        await cmdLlm(args);
        break;
      case 'serve': {
        // The configured project may live in a different database; fall back to
        // the most recently used one, and say so clearly if there is none.
        let project = controller.getProjectByName(db, (globalState().lastProject as string) ?? '');
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
        const { startServer } = await import('./server.ts');
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
