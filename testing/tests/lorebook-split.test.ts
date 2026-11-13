/**
 * The lorebook split must not leave a name declared twice.
 *
 * `lorebook.ts` is a facade: it re-exports what the modules under `lorebook/`
 * now own. If a declaration also stays behind in `lorebook.ts`, TypeScript
 * raises no error and the suite raises none either, because every test imports
 * through `lorebook.ts`. The local copy simply shadows the re-export, and the
 * two drift apart silently.
 *
 * That happened during the 2026-11-13 refactor: a block was copied into
 * `lorebook/kinds.ts` without being removed from the monolith, and typecheck
 * plus 1,555 tests both passed with two live copies.
 *
 * This test makes that failure loud. It compares top-level declaration names —
 * functions, classes, interfaces, types, consts and lets — between the facade
 * and each module it re-exports from.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(import.meta.dirname, '../../fanfable/src');
const FACADE = join(SRC, 'lorebook.ts');
const MODULES = join(SRC, 'lorebook');

/** Top-level declaration names in a source file, with their line numbers. */
function declarations(source: string): Map<string, number> {
  const out = new Map<string, number>();
  const rx = /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let)\s+([A-Za-z_$][\w$]*)/;
  source.split('\n').forEach((line, index) => {
    const match = rx.exec(line);
    if (match?.[1] && !out.has(match[1])) out.set(match[1], index + 1);
  });
  return out;
}

test('no declaration is duplicated between lorebook.ts and a lorebook/ module', () => {
  const facade = declarations(readFileSync(FACADE, 'utf8'));
  const problems: string[] = [];

  const files = readdirSync(MODULES, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(MODULES, entry.name));

  for (const file of files) {
    const module = declarations(readFileSync(file, 'utf8'));
    const name = relative(SRC, file).replaceAll('\\', '/');
    for (const [symbol, line] of module) {
      const at = facade.get(symbol);
      if (at !== undefined) {
        problems.push(`${symbol}: ${name}:${line} and lorebook.ts:${at}`);
      }
    }
  }

  assert.deepEqual(
    problems,
    [],
    'a name is declared in both the facade and a module; the local declaration ' +
      'wins silently and the re-export is dead. Remove one of them.',
  );
});

/**
 * Every module under lorebook/ must be reachable from the facade, or from
 * another module that is. An orphan module is dead code that looks live.
 */
test('every lorebook/ module is imported by the facade or by another module', () => {
  const files = readdirSync(MODULES, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name);

  const sources = new Map<string, string>();
  sources.set('lorebook.ts', readFileSync(FACADE, 'utf8'));
  for (const name of files) {
    sources.set(`lorebook/${name}`, readFileSync(join(MODULES, name), 'utf8'));
  }

  const orphans: string[] = [];
  for (const name of files) {
    // Match any quoted specifier ending in this filename, so both './shared.ts'
    // and './lorebook/shared.ts' count. A tighter pattern misses the facade's
    // own imports and would flag every module as an orphan.
    const rx = new RegExp(`['"][^'"]*/?${name.replace('.', '\\.')}['"]`);
    const importedBy = [...sources.entries()].some(
      ([from, text]) => !from.endsWith(`/${name}`) && rx.test(text),
    );
    if (!importedBy) orphans.push(`lorebook/${name}`);
  }

  assert.deepEqual(orphans, [], 'modules under lorebook/ that nothing imports');
});
