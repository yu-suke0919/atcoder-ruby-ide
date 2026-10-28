const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const profile = require('../config/atcoder-runtime.json');
const { downloadVerified } = require('./download-verified.cjs');
const execute = promisify(execFile);

async function prepareGems({ ruby = process.env.RUBY_PATH || 'ruby', directory = '', cache = path.resolve(__dirname, '../.cache/gems'), gems = profile.gems } = {}) {
  const packages = [];
  for (const gem of gems) {
    const archive = `${gem.name}-${gem.version}.gem`;
    const file = await downloadVerified({ ...gem, archive, url: `https://rubygems.org/downloads/${archive}` }, cache);
    packages.push({ ...gem, file });
  }
  const { stdout } = await execute(ruby, ['-EUTF-8:UTF-8', path.join(__dirname, 'install-gems.rb'), directory, JSON.stringify(packages)], { timeout: 120000, maxBuffer: 1024 * 1024 });
  console.log(stdout.trim());
}
if (require.main === module) prepareGems().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepareGems };
