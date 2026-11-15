// The cloud session script prepares gems and Ruby LSP for the pinned Ruby; with another Ruby that
// fails part-way, so it says which Ruby it found and what to fix instead of only "failed".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, writeFile, chmod, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const pinned = require('../../config/ruby-wsl.json').rubyVersion;

test('the cloud session script names a Ruby that is not the pinned one and prepares nothing', async t => {
  const bin = await mkdtemp(path.join(tmpdir(), 'IDE-ruby-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(path.join(bin, 'ruby'), '#!/bin/sh\nprintf 3.0.0\n');
  await chmod(path.join(bin, 'ruby'), 0o755);
  // npm would prepare everything; here it must not run.
  await writeFile(path.join(bin, 'npm'), '#!/bin/sh\necho npm was run >&2\nexit 1\n');
  await chmod(path.join(bin, 'npm'), 0o755);
  const { stdout, stderr } = await execute('bash', [path.join(root, 'scripts/cloud-session.sh')], {
    env: { ...process.env, CLAUDE_CODE_REMOTE: 'true', CLAUDE_PROJECT_DIR: root, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.match(stdout, new RegExp(`Ruby 3\\.0\\.0.*${pinned.replaceAll('.', '\\.')}`));
  assert.match(stdout, /docs\/cloud-development\.md/);
  assert.doesNotMatch(stderr, /npm was run/);
});
