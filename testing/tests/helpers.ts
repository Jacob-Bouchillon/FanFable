import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Db } from '../../fanfable/src/core/db.ts';
import { MockProvider } from '../../fanfable/src/core/llm.ts';
import * as lore from '../../fanfable/src/answer/lore.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';

export const FIXTURE = resolve(import.meta.dirname, 'fixtures/sample-book.txt');

/**
 * Temporary directories created by the suite, removed when the process exits.
 *
 * `mkdtempSync` never cleans up after itself. Before this registry existed a
 * full run leaked roughly 150 directories, and repeated runs filled /tmp to the
 * point where SQLite started failing with `disk I/O error`. The suite reported
 * that as a cascade of unrelated-looking failures.
 */
const tempDirs: string[] = [];
let cleanupRegistered = false;

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once('exit', () => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a leftover directory is not worth failing a run over */
      }
    }
  });
}

export function tempDb(): { db: Db; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fanfable-test-'));
  tempDirs.push(dir);
  registerCleanup();
  const path = join(dir, 'test.db');
  return { db: new Db(path), path };
}

export function seedProject(db: Db, name = 'test') {
  const project = controller.createProject(db, name);
  lore.importSource(db, project.id, FIXTURE);
  return project;
}

export function mockProvider(handler?: (req: { system?: string; messages: { content: string }[] }) => string): MockProvider {
  const p = new MockProvider();
  if (handler) p.handler = handler;
  return p;
}
