import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Db } from '../../fanfable/src/core/db.ts';
import { MockProvider } from '../../fanfable/src/core/llm.ts';
import * as lore from '../../fanfable/src/answer/lore.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';

export const FIXTURE = resolve(import.meta.dirname, 'fixtures/sample-book.txt');

export function tempDb(): { db: Db; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fanfable-test-'));
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
