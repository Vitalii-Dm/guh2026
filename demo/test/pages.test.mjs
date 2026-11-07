// No test loads the pages themselves, so at least check every page script parses.
// A duplicate declaration left by a merge otherwise only shows in a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = (path) => fileURLToPath(new URL(path, import.meta.url));

for (const [folder, file] of [...readdirSync(dir('..')).map((f) => ['..', f]), ...readdirSync(dir('../../demo3d')).map((f) => ['../../demo3d', f])]) {
  if (!/\.m?js$/.test(file)) continue;
  test(`${file} parses`, () => {
    const { status, stderr } = spawnSync(process.execPath, ['--check', `${dir(folder)}/${file}`], { encoding: 'utf8' });
    assert.equal(status, 0, stderr);
  });
}

test('demo.js reaches the browser history through window', () => {
  // This file has its own `history`, so a bare history.replaceState crashes the page.
  assert.doesNotMatch(readFileSync(dir('../demo.js'), 'utf8'), /(?<![.\w])history\.(replaceState|pushState)/);
});
