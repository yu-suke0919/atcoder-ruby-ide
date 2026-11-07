const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const workflow = YAML.parse(readFileSync(path.join(__dirname, '../../.github/workflows/ci.yml'), 'utf8'));

test('CI skips pushes and pull requests that only change documents', () => {
  for (const event of ['push', 'pull_request']) {
    assert.deepEqual(workflow.on[event]['paths-ignore'], ['docs/**', '*.md'], event);
  }
});

test('CI cancels older runs of the same workflow and ref', () => {
  assert.deepEqual(workflow.concurrency, {
    group: '${{ github.workflow }}-${{ github.ref }}',
    'cancel-in-progress': true,
  });
});

test('CI builds the WSL distribution, tests on Linux and builds the Windows app, with no Windows Ruby', () => {
  assert.deepEqual(Object.keys(workflow.jobs), ['wsl-runtime', 'linux', 'windows']);
  assert.equal(workflow.on.workflow_dispatch, null);
});

test('CI caches the built Ruby, gems and Ruby LSP under the files that decide them', () => {
  const script = readFileSync(path.join(__dirname, '../../scripts/build-wsl-runtime.sh'), 'utf8');
  const inputs = script.match(/^inputs=\(([^)]*)\)$/m)[1].trim().split(/\s+/);
  for (const file of inputs) readFileSync(path.join(__dirname, '../..', file));
  const cache = workflow.jobs['wsl-runtime'].steps.find(step => step.uses?.startsWith('actions/cache@'));
  assert.equal(cache.with.path, '.cache/wsl');
  assert.equal(cache.with.key, `wsl-runtime-\${{ hashFiles(${inputs.map(file => `'${file}'`).join(', ')}) }}`);
});
