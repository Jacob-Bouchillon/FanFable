import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execFileSync } from 'node:child_process';
import { importFile, readTextFile } from '../../fanfable/src/importer.ts';
import { chunkText } from '../../fanfable/src/text.ts';
import { makePdf } from './pdf-fixture.ts';
import * as lore from '../../fanfable/src/lore.ts';


const exec = promisify(execFile);

function tempFile(name: string, data: Buffer | string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fanfable-src-'));
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
}

async function hasCommand(cmd: string): Promise<boolean> {
  try {
    await exec(cmd, ['-v'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

test('a plain text file is read directly', async () => {
  const path = tempFile('book.txt', 'CHAPTER ONE\n\nThe rain had not stopped.\n');
  const imported = await importFile(path);
  assert.equal(imported.format, 'txt');
  assert.match(imported.text, /The rain had not stopped/);
});

test('a PDF is read with its pages', async (t) => {
  if (!(await hasCommand('pdftotext'))) {
    t.skip('pdftotext is not installed');
    return;
  }
  const pdf = makePdf([
    'The rain had not stopped for three days.',
    'The bridge at Ardenne still stood.',
    'Serena took the third lantern.',
  ]);
  const path = tempFile('book.pdf', pdf);
  const imported = await importFile(path);
  assert.equal(imported.format, 'pdf');
  assert.ok(imported.pageCount >= 3, `expected 3 pages, got ${imported.pageCount}`);
  assert.match(imported.text, /Ardenne/);
  // pages are separated so a citation can point at one
  assert.ok(imported.text.includes('\f'), 'pages are marked');
});

test('a PDF import produces passages with page references', async (t) => {
  if (!(await hasCommand('pdftotext'))) {
    t.skip('pdftotext is not installed');
    return;
  }
  const pdf = makePdf([
    'The rain had not stopped for three days, and the bridge at Ardenne still stood.',
    'Serena watched it from the ridge, wrapped in a coat that had belonged to her brother.',
  ]);
  const path = tempFile('book.pdf', pdf);
  const { Db } = await import( '../../fanfable/src/db.ts');
  const controller = await import( '../../fanfable/src/controller.ts');
  const db2 = new Db(':memory:');
  const p = controller.createProject(db2, 'pdf');
  const res = await lore.importSourceAsync(db2, p.id, path);
  void res;

  assert.ok(res.chunks > 0, 'the PDF produced passages');
  const chunks = db2.all<{ locator: string; page_start: number }>(
    'SELECT locator, page_start FROM canon_chunk WHERE project_id = ?',
    p.id,
  );
  assert.ok(chunks.length > 0);
  assert.ok(
    chunks.some((c) => /p\.\s*\d/.test(c.locator)),
    `a passage should cite a page, got ${chunks.map((c) => c.locator).join(' | ')}`,
  );
  db2.close();
});

test('chunking keeps page ranges', () => {
  const text = ['Page one text here.', 'Page two text here.', 'Page three text here.'].join('\f\n\n');
  const chunks = chunkText(text, { maxWords: 20 });
  assert.ok(chunks.length >= 1);
  assert.ok(chunks[0].pageStart >= 1, 'chunks know their page');
  for (const c of chunks) assert.ok(c.pageEnd >= c.pageStart);
});

test('a DOCX is read', async () => {
  // A minimal docx is a zip; build one with the system zip tool if present.
  if (!(await hasCommand('zip'))) return;
  const docx = buildMinimalDocx();
  const path = tempFile('book.docx', docx);
  const imported = await importFile(path);
  assert.equal(imported.format, 'docx');
  assert.match(imported.text, /The rain had not stopped/);
});

function buildMinimalDocx(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'fanfable-docx-'));
  mkdirSync(join(dir, 'word'), { recursive: true });
  mkdirSync(join(dir, 'docProps'), { recursive: true });
  writeFileSync(
    join(dir, 'word/document.xml'),
    '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
      '<w:p><w:r><w:t>The rain had not stopped for three days.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>The bridge at Ardenne still stood.</w:t></w:r></w:p>' +
      '</w:body></w:document>',
  );
  writeFileSync(
    join(dir, 'docProps/core.xml'),
    '<?xml version="1.0"?><cp:coreProperties xmlns:dc="x">' +
      '<dc:title>The Bridge</dc:title><dc:creator>Ilsa</dc:creator></cp:coreProperties>',
  );
  writeFileSync(join(dir, '[Content_Types].xml'), '<?xml version="1.0"?><Types/>');
  const outDir = mkdtempSync(join(tmpdir(), 'fanfable-docx-out-'));
  const out = join(outDir, 'built.docx');
  execFileSync('zip', ['-r', '-q', out, '.'], { cwd: dir });
  return readFileSync(out);
}
