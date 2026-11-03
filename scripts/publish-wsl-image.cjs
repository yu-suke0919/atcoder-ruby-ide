// Puts the app's WSL image on the release `wsl-images` as atcoder-linux-<SHA-256>.tar.gz, the URL
// vendor/wsl/runtime.json gives the app, and removes assets older than 90 days. Runs in CI with
// GH_TOKEN (contents: write). See docs/architecture.md#wslのエージェント.
const { execFileSync } = require('node:child_process');
const { copyFileSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const RELEASE = 'wsl-images';
const KEEP_DAYS = 90;
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const runtime = JSON.parse(readFileSync(path.join(root, 'vendor/wsl/runtime.json'), 'utf8'));
const name = `atcoder-linux-${runtime.sha256}.tar.gz`;
let assets;
try {
  assets = JSON.parse(gh('release', 'view', RELEASE, '--json', 'assets')).assets;
} catch {
  gh('release', 'create', RELEASE, '--prerelease', '--title', 'WSL images',
    '--notes', 'アプリが初回起動時にダウンロードする、アプリ専用のWSLのディストリビューション（CIが置く）。');
  assets = [];
}
if (assets.some(asset => asset.name === name)) console.log(`${name} is already on ${RELEASE}`);
else {
  const directory = mkdtempSync(path.join(tmpdir(), 'wsl-image-'));
  try {
    copyFileSync(path.join(root, 'vendor/wsl-image/atcoder-linux.tar.gz'), path.join(directory, name));
    gh('release', 'upload', RELEASE, path.join(directory, name));
    console.log(`Uploaded ${name} to ${RELEASE}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
const limit = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
for (const asset of assets.filter(asset => asset.name !== name && Date.parse(asset.createdAt) < limit)) {
  gh('release', 'delete-asset', RELEASE, asset.name, '--yes');
  console.log(`Removed ${asset.name}, older than ${KEEP_DAYS} days`);
}
