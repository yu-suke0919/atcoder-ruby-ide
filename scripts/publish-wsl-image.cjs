// Puts the app's WSL image on the release `wsl-images` as atcoder-linux-<version>.tar.gz, the URL
// vendor/wsl/runtime.json gives the app, and removes assets older than 90 days. When that version is
// already there, its image is used: runtime.json takes that asset's SHA-256 and size. Runs in CI with
// GH_TOKEN (contents: write) and GH_REPO. See docs/architecture.md#wslのエージェント.
const { execFileSync } = require('node:child_process');
const { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const RELEASE = 'wsl-images';
const KEEP_DAYS = 90;

/** What to do with `runtime` given the release's `assets` (as the GitHub API lists them). */
function releasePlan(runtime, assets, now = Date.now()) {
  const name = `atcoder-linux-${runtime.version}.tar.gz`;
  const existing = assets.find(asset => asset.name === name);
  if (existing && !/^sha256:[0-9a-f]{64}$/.test(existing.digest ?? '')) {
    throw new Error(`${name} on ${RELEASE} has no SHA-256 digest to check it against`);
  }
  const limit = now - KEEP_DAYS * 24 * 60 * 60 * 1000;
  return {
    name,
    upload: !existing,
    runtime: existing ? { ...runtime, sha256: existing.digest.slice('sha256:'.length), bytes: existing.size } : runtime,
    remove: assets.filter(asset => asset.name !== name && Date.parse(asset.created_at) < limit).map(asset => asset.name),
  };
}

function publish() {
  const root = path.resolve(__dirname, '..');
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const manifest = path.join(root, 'vendor/wsl/runtime.json');
  const runtime = JSON.parse(readFileSync(manifest, 'utf8'));
  let assets;
  try {
    assets = JSON.parse(gh('api', `repos/{owner}/{repo}/releases/tags/${RELEASE}`)).assets;
  } catch {
    gh('release', 'create', RELEASE, '--prerelease', '--title', 'WSL images',
      '--notes', 'アプリが初回起動時にダウンロードする、アプリ専用のWSLのディストリビューション（CIが置く）。');
    assets = [];
  }
  const plan = releasePlan(runtime, assets);
  if (plan.upload) {
    const directory = mkdtempSync(path.join(tmpdir(), 'wsl-image-'));
    try {
      copyFileSync(path.join(root, 'vendor/wsl-image/atcoder-linux.tar.gz'), path.join(directory, plan.name));
      gh('release', 'upload', RELEASE, path.join(directory, plan.name));
      console.log(`Uploaded ${plan.name} to ${RELEASE}`);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  } else {
    writeFileSync(manifest, `${JSON.stringify(plan.runtime, null, 2)}\n`);
    console.log(`${plan.name} is already on ${RELEASE}; runtime.json now points to it`);
  }
  for (const name of plan.remove) {
    gh('release', 'delete-asset', RELEASE, name, '--yes');
    console.log(`Removed ${name}, older than ${KEEP_DAYS} days`);
  }
  console.log(JSON.stringify(plan.runtime, null, 2));
}

if (require.main === module) publish();
module.exports = { releasePlan };
