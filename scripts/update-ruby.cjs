const { readFile, writeFile, rename, rm } = require('node:fs/promises');
const path = require('node:path');
const { parse } = require('yaml');
const { prepareRuby } = require('./prepare-ruby.cjs');

const RUBY_RELEASES = 'https://raw.githubusercontent.com/ruby/www.ruby-lang.org/master/_data/releases.yml';
const WINDOWS_DOWNLOADS = 'https://raw.githubusercontent.com/oneclick/rubyinstaller.org-website/master/_data/downloads.yaml';
const compare = (a, b) => {
  const left = a.split(/[.-]/).map(Number), right = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return difference;
  }
  return 0;
};

function selectRuby(releasesText, downloadsText) {
  const releases = parse(releasesText), downloads = parse(downloadsText);
  if (!Array.isArray(releases) || !Array.isArray(downloads)) throw Error('公式リリース一覧の形式が不正です。');
  const versions = releases.map(entry => entry?.version).filter(version => typeof version === 'string' && /^3\.4\.\d+$/.test(version)).sort(compare);
  const rubyVersion = versions.at(-1);
  if (!rubyVersion) throw Error('安定版Ruby 3.4.xが公式一覧にありません。');
  const candidates = [];
  for (const entry of downloads) {
    if (entry?.filetype !== 'rubyinstaller7z' || typeof entry.href !== 'string') continue;
    const match = entry.href.match(/^https:\/\/github\.com\/oneclick\/rubyinstaller2\/releases\/download\/RubyInstaller-(3\.4\.\d+-\d+)\/rubyinstaller-\1-x64\.7z$/);
    if (match && match[1].split('-')[0] === rubyVersion) candidates.push({ entry, version: match[1] });
  }
  candidates.sort((a, b) => compare(a.version, b.version));
  const latest = candidates.at(-1);
  if (!latest) throw Error(`Ruby ${rubyVersion}に対応するWindows x64版がありません。`);
  const { entry, version } = latest;
  if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)) throw Error('公式SHA-256が不正です。');
  if (candidates.some(candidate => candidate.version === version && candidate.entry.sha256 !== entry.sha256)) throw Error('公式SHA-256が重複して矛盾しています。');
  return {
    rubyVersion, version, platform: 'win32', arch: 'x64', archive: `rubyinstaller-${version}-x64.7z`,
    url: entry.href, sha256: entry.sha256.toLowerCase(), releaseSource: RUBY_RELEASES, checksumSource: WINDOWS_DOWNLOADS,
  };
}

async function fetchMetadata(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error(`公式リリース一覧を取得できません: HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw Error('公式リリース一覧が4 MiBを超えています。');
  return text;
}

async function updateRuby({ root = path.resolve(__dirname, '..'), fetchMetadata: fetchText = fetchMetadata, prepare = prepareRuby } = {}) {
  const metadata = await Promise.all([fetchText(RUBY_RELEASES), fetchText(WINDOWS_DOWNLOADS)]);
  const source = selectRuby(...metadata);
  const file = path.join(root, 'config/ruby-windows.json');
  const previous = JSON.parse(await readFile(file, 'utf8'));
  if (compare(source.version, previous.version) < 0) throw Error('固定済みより古いRubyへの更新は行いません。');
  await prepare({ root, source });
  const temporary = `${file}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(source, null, 2)}\n`);
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  console.log(`Pinned Ruby ${source.rubyVersion} / RubyInstaller ${source.version}`);
  return source;
}

if (require.main === module) updateRuby().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { RUBY_RELEASES, WINDOWS_DOWNLOADS, selectRuby, updateRuby };
