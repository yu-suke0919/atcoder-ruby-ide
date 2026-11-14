// Every class the stylesheet styles is one the page or its scripts use, so rules for removed
// parts of the screen do not stay behind. CodeMirror's own classes (cm-) come from the editor.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '../../src');
const read = name => readFileSync(path.join(src, name), 'utf8');

test('the stylesheet styles only classes the screen uses', () => {
  const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const used = ['index.html', ...readdirSync(src).filter(name => /\.m?js$/.test(name))].map(read).join('\n');
  const classes = new Set([...css.matchAll(/\.(-?[a-z_][\w-]*)/gi)].map(([, name]) => name).filter(name => !name.startsWith('cm-')));
  const unused = [...classes].filter(name => !new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(used));
  assert.deepEqual(unused, []);
});
