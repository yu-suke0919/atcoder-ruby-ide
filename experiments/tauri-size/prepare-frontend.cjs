const { mkdir, readFile, writeFile, copyFile } = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const destination = path.join(__dirname, 'frontend-dist');
  const source = path.resolve(__dirname, '../../src');
  await mkdir(destination, { recursive: true });
  const html = (await readFile(path.join(source, 'index.html'), 'utf8'))
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
    .replace('src="renderer.js"', 'src="prototype.js"');
  await writeFile(path.join(destination, 'index.html'), html);
  await copyFile(path.join(source, 'styles.css'), path.join(destination, 'styles.css'));
  await copyFile(path.join(__dirname, 'prototype.js'), path.join(destination, 'prototype.js'));
})().catch(error => { console.error(error); process.exitCode = 1; });
