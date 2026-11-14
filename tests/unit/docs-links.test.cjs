// Links between the documents, and the `docs/<file>.md#<heading>` that code comments cite, must
// lead somewhere: a heading renamed without its links is caught here. Headings become anchors
// the way GitHub makes them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const documents = files.filter(file => file.endsWith('.md'));

function anchors(file) {
  const seen = new Map();
  const text = readFileSync(path.join(root, file), 'utf8').replace(/^```[\s\S]*?^```/gm, '');
  return new Set([...text.matchAll(/^#{1,6} +(.+?) *#*$/gm)].map(([, heading]) => {
    const slug = heading.replace(/`/g, '').toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '').replace(/ /g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    return count ? `${slug}-${count}` : slug;
  }));
}

// `target` is relative to `base`: the folder of the document, or the root for code comments.
function broken(from, target, base = path.posix.dirname(from)) {
  const [file, anchor] = target.split('#');
  const resolved = file ? path.posix.normalize(path.posix.join(base, file)) : from;
  if (!existsSync(path.join(root, resolved))) return `${from} → ${target}: no such file`;
  if (anchor && resolved.endsWith('.md') && !anchors(resolved).has(decodeURIComponent(anchor))) return `${from} → ${target}: no such heading`;
  return null;
}

test('links between the documents lead to a file and a heading', () => {
  const problems = documents.flatMap(file => [...readFileSync(path.join(root, file), 'utf8').matchAll(/\]\(([^)\s]+)\)/g)]
    .map(([, target]) => target)
    .filter(target => !/^[a-z]+:/.test(target))
    .map(target => broken(file, target)))
    .filter(Boolean);
  assert.deepEqual(problems, []);
});

test('the documents code comments cite have the headings they name', () => {
  const sources = files.filter(file => /\.(rs|js|mjs|cjs|sh|rb|nsh|yml)$/.test(file) && !file.startsWith('tests/fixtures/'));
  const problems = sources.flatMap(file => [...readFileSync(path.join(root, file), 'utf8').matchAll(/docs\/[\w-]+\.md(?:#[^\s)、。,;'"`]+)?/g)]
    .map(([target]) => broken(file, target.replace(/[.:]+$/, ''), '')))
    .filter(Boolean);
  assert.deepEqual(problems, []);
});
