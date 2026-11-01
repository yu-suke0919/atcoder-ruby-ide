// Seeds a cached problem and its workspace so each E2E test starts from an opened problem.
const { mkdir, writeFile, rm } = require('node:fs/promises');
const path = require('node:path');

const sampleCode = 'a = gets.to_i\nb, c = gets.split.map(&:to_i)\ns = gets.chomp\n\nputs "#{a + b + c} #{s}"\n';
const sampleCases = [{ stdin: '1\n2 3\ntest\n', expectedOutput: '6 test\n', compare: false }];

async function seedProblem(app, contest, task, { code = sampleCode, cases = sampleCases, title = `S - ${task}`, samples = [] } = {}) {
  const url = `https://atcoder.jp/contests/${contest}/tasks/${task}`;
  const cache = path.join(app.dataDir, 'library/problems', contest, task);
  const workspace = path.join(app.dataDir, 'workspaces', contest, task);
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, 'problem.json'), JSON.stringify({ url, title, statement: [{ type: 'text', text: '作業領域のテスト用の問題。' }], samples }));
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await mkdir(workspace, { recursive: true });
  if (code !== null) await writeFile(path.join(workspace, 'solution.rb'), code);
  if (cases !== null) await writeFile(path.join(workspace, 'cases.json'), JSON.stringify({ cases }));
  return { url, title, workspace, solution: path.join(workspace, 'solution.rb'), cases: path.join(workspace, 'cases.json') };
}

async function openProblem(page, problem, { showStatement = false } = {}) {
  await page.locator('#problem-library').click();
  await page.locator('#problem-url').fill(problem.url);
  await page.locator('#problem-open').click();
  await page.locator('#problem-title').filter({ hasText: problem.title }).waitFor();
  await page.waitForFunction(() => !document.getElementById('problem-dialog').open);
  if (!showStatement && await page.locator('#problem-panel').isVisible()) await page.locator('#problem-toggle').click();
}

// Initialization is complete once the Ruby check has finished and the recheck button is usable.
const waitInitialized = page => page.waitForFunction(() => !document.getElementById('ruby-recheck').disabled);

module.exports = { sampleCode, sampleCases, seedProblem, openProblem, waitInitialized };
