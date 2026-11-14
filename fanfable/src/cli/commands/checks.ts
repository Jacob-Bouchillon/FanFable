/**
 * Reporting commands: continuity issues, conflicts and warnings.
 *
 * Moved out of cli.ts on 2026-11-13, logic unchanged. `db` is a parameter
 * rather than a module-level singleton so the command is a plain function.
 */
import { Db } from '../../core/db.ts';
import { truncate } from '../../core/text.ts';
import * as controller from '../../plan/controller.ts';
import * as planner from '../../plan/planner.ts';
import * as continuity from '../../product/continuity.ts';
import { continuitySettings, filterBySeverity } from '../../product/continuity-settings.ts';
import { C, app, heading, requireProject, flagString, type Args } from '../shared.ts';

export function printIssues(issues: continuity.ContinuityIssue[]): void {
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
export async function cmdCheck(db: Db, args: Args): Promise<void> {
  const project = requireProject(db, args);
  const a = app(db, args);
  const n = Number(args._[1]);
  if (!Number.isFinite(n)) throw new Error('chapter number required');
  const chapter = controller.getChapter(db, project.id, n);
  if (!chapter) throw new Error(`chapter ${n} not found`);
  heading(`Continuity check — chapter ${n}`);
  const outline = planner.approvedOutline(db, project.id);
  let contextTraceId: string | undefined;
  const bundle = await controller.assembleContext(db, a.llm, project.id, {
    chapter: outline?.chapters.find((c) => c.number === n),
    chapterNumber: n,
    onTraceId: (id) => {
      contextTraceId = id;
    },
  });
  const report = { droppedModelIssues: 0 };
  const issues = await controller.runContinuityCheck(db, a.llm, project.id, chapter, outline, bundle, report);
  printIssues(issues);
  console.log(C.dim(`dropped model issues: ${report.droppedModelIssues}`));
  if (contextTraceId) console.log(`${C.dim(`trace ${contextTraceId}`)}`);
}
export async function cmdIssues(db: Db, args: Args): Promise<void> {
  const project = requireProject(db, args);
  const sub = args._[1];
  if (sub === 'resolve') {
    const id = Number(args._[2]);
    if (!Number.isFinite(id)) throw new Error('issue id required');
    const resolution = args.flags.fix ? 'fixed' : args.flags.accept ? 'accepted' : 'open';
    continuity.setIssueResolution(db, project.id, id, resolution);
    console.log(`issue ${id} marked ${resolution}`);
    return;
  }
  const all = args.flags.all === true;
  const settings = continuitySettings(project);
  let issues = continuity.listIssues(db, project.id, { openOnly: !all, minSeverity: all ? 'note' : settings.minSeverity });
  issues = filterBySeverity(issues, all ? { ...settings, minSeverity: 'note' } : settings);
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
export async function cmdContinuity(db: Db, args: Args): Promise<void> {
  const project = requireProject(db, args);
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
