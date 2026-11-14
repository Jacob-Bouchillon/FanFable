/**
 * The knowledge graph and the state-conflict listings.
 *
 * Moved out of cli.ts on 2026-11-13, logic unchanged. `db` is a parameter
 * rather than a module-level singleton so the command is a plain function.
 */
import { Db } from '../../core/db.ts';
import * as graph from '../../support/graph.ts';
import { listConflicts, resolveConflict } from '../../product/state-conflicts.ts';
import { truncate } from '../../core/text.ts';
import { C, heading, requireProject, flagString, flagNumber, type Args } from '../shared.ts';

export async function cmdGraph(db: Db, args: Args): Promise<void> {
  const project = requireProject(db, args);
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
export async function cmdConflicts(db: Db, args: Args): Promise<void> {
  const project = requireProject(db, args);
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
