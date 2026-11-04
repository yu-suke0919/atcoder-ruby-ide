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
