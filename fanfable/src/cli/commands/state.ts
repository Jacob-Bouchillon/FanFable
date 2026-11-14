/**
 * Story state: what the story currently holds, and what the writer will see.
 *
 * Moved out of cli.ts on 2026-11-13, logic unchanged. `db` is a parameter
 * rather than a module-level singleton so the command is a plain function.
 */
import { Db } from '../../core/db.ts';
import * as controller from '../../plan/controller.ts';
import * as memory from '../../product/memory.ts';
import * as planner from '../../plan/planner.ts';
import { truncate } from '../../core/text.ts';
import * as continuity from '../../product/continuity.ts';
import { C, heading, requireProject, flagString, flagNumber, ageLabel, type Args } from '../shared.ts';

export async function cmdState(db: Db, args: Args): Promise<void> {
  const project = requireProject(db, args);
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

/** Printed settings never carry the whole key: prefix…suffix only. */
