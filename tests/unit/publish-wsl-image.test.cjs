const { test } = require('node:test');
const assert = require('node:assert/strict');
const { releasePlan } = require('../../scripts/publish-wsl-image.cjs');

const URL = 'https://github.com/yu-suke0919/atcoder-ruby-ide/releases/download/wsl-images';
const version = 'a'.repeat(64);
const built = { rubyVersion: '3.4.5', version, sha256: 'b'.repeat(64), bytes: 49_000_000, url: `${URL}/atcoder-linux-${version}.tar.gz` };
const day = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-11-07T00:00:00Z');
const asset = (name, daysAgo, extra = {}) => ({ name, created_at: new Date(now - daysAgo * day).toISOString(), ...extra });

test('a new version is uploaded under its version and old assets are pruned', () => {
  const plan = releasePlan(built, [asset('atcoder-linux-old.tar.gz', 91), asset('atcoder-linux-recent.tar.gz', 10)], now);
  assert.equal(plan.name, `atcoder-linux-${version}.tar.gz`);
  assert.equal(plan.upload, true);
  assert.deepEqual(plan.runtime, built);
  assert.deepEqual(plan.remove, ['atcoder-linux-old.tar.gz']);
});

test('the same version reuses the asset on the release, even when it is old', () => {
  const existing = asset(`atcoder-linux-${version}.tar.gz`, 120, { digest: `sha256:${'c'.repeat(64)}`, size: 48_000_000 });
  const plan = releasePlan(built, [existing], now);
  assert.equal(plan.upload, false);
  assert.deepEqual(plan.runtime, { ...built, sha256: 'c'.repeat(64), bytes: 48_000_000 });
  assert.deepEqual(plan.remove, []);
});

test('an asset of the same version without a digest cannot be reused', () => {
  assert.throws(() => releasePlan(built, [asset(`atcoder-linux-${version}.tar.gz`, 1)], now), /digest/);
});
