const { buildSync } = require('esbuild');
const { mkdirSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'src/vendor/editor');
mkdirSync(target, { recursive: true });
const { metafile } = buildSync({
  absWorkingDir: root, entryPoints: ['scripts/codemirror.mjs'],
  outfile: path.join(target, 'codemirror.mjs'), bundle: true, format: 'esm',
  target: 'es2022', minify: true, legalComments: 'eof', metafile: true,
});
const packages = new Set(Object.keys(metafile.inputs).filter(name => name.startsWith('node_modules/')).map(name => name.split('/').slice(0, name.split('/')[1].startsWith('@') ? 3 : 2).join('/')));
writeFileSync(path.join(target, 'LICENSES.txt'), [...packages].sort().map(name => {
  const directory = path.join(root, name);
  const license = ['LICENSE', 'LICENSE.txt', 'LICENSE.md'].find(file => existsSync(path.join(directory, file)));
  if (!license) throw new Error(`Missing license: ${name}`);
  return `${name}\n${readFileSync(path.join(directory, license), 'utf8')}`;
}).join('\n\n'));
