const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { prepareLsp } = require('../../scripts/prepare-lsp.cjs');
const execute = promisify(execFile);
const ruby = process.env.RUBY_PATH || 'ruby';
const root = path.resolve(__dirname, '../..');

test('LSP: pinned bundle boots offline despite external Ruby and Bundler settings', async () => {
  const resources = path.join(root, 'vendor/ruby-lsp');
  const probe = `load ARGV[0]`;
  const { stdout } = await execute(ruby, ['--disable=rubyopt', '-EUTF-8:UTF-8', '-e', probe, path.join(resources, 'server.rb'), '--probe'], {
    env: { ...process.env, RUBYOPT: '-rmissing_external_file', RUBYLIB: '/missing', GEM_HOME: '/missing', GEM_PATH: '/missing', BUNDLE_GEMFILE: '/missing', BUNDLE_PATH: '/missing', BUNDLE_WITHOUT: 'default', BUNDLE_FROZEN: 'false', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1' }
  });
  const versions = JSON.parse(stdout);
  const profile = require('../../config/ruby-lsp.json');
  for (const gem of [...profile.gems, ...profile.bundledGems]) assert.equal(versions[gem.name], gem.version);
  assert.equal(await readFile(path.join(resources, 'gems/gems/ruby-lsp-0.26.11/LICENSE.txt'), 'utf8').then(s => s.includes('MIT')), true);
});

test('LSP: a corrupt package preserves the prepared bundle', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'IDE LSP 日本語 '));
  try {
    const { mkdir } = require('node:fs/promises');
    const destination = path.join(directory, 'vendor/ruby-lsp');
    const cache = path.join(directory, 'cache');
    await mkdir(destination, { recursive: true });
    await mkdir(cache);
    await writeFile(path.join(destination, 'keep'), 'original');
    await writeFile(path.join(cache, 'ruby-lsp-0.26.11.gem'), 'bad archive');
    await assert.rejects(prepareLsp({ root: directory, ruby, cache }), /SHA-256/);
    assert.equal(await readFile(path.join(destination, 'keep'), 'utf8'), 'original');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
