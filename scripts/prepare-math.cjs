const { mkdirSync, copyFileSync, readdirSync, rmSync } = require('node:fs');
const path = require('node:path');
const source = path.dirname(require.resolve('katex/package.json'));
const target = path.resolve(__dirname, '../src/vendor/katex');
rmSync(target, { recursive: true, force: true });
mkdirSync(path.join(target, 'fonts'), { recursive: true });
for (const name of ['katex.mjs', 'katex.min.css']) copyFileSync(path.join(source, 'dist', name), path.join(target, name));
copyFileSync(path.join(source, 'LICENSE'), path.join(target, 'LICENSE'));
for (const name of readdirSync(path.join(source, 'dist/fonts'))) {
  if (name.endsWith('.woff2')) copyFileSync(path.join(source, 'dist/fonts', name), path.join(target, 'fonts', name));
}
