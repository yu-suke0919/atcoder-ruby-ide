// Prepares problems the way the app stores them and opens them through the contest UI, so each
// E2E test starts from an opened problem. Task list pages are served by the AtCoder fixture.
const { mkdir, writeFile, rm } = require('node:fs/promises');
const path = require('node:path');
const { taskListPage, taskPage } = require('./atcoder-fixture.cjs');

const sampleCode = 'a = gets.to_i\nb, c = gets.split.map(&:to_i)\ns = gets.chomp\n\nputs "#{a + b + c} #{s}"\n';
const sampleCases = [{ stdin: '1\n2 3\ntest\n', expectedOutput: '6 test\n', compare: false }];
const contestTasks = new Map();

// Serves the contest's task list with every task seeded so far.
function serveTaskList(app, contest, title = `テスト ${contest}`) {
  const tasks = [...contestTasks.get(contest).values()];
  app.atcoder.pages.set(`/contests/${contest}/tasks`, taskListPage(contest, title, tasks));
}

/**
 * Seeds a task. `task` writes task.json as if its page had been read; pass `page` instead to
 * serve the task page so the app reads it. `code` and `cases` seed the user's workspace.
 */
async function seedProblem(app, contest, id, { code = sampleCode, cases = sampleCases, task = { samples: [] }, page = null, label = id, title = 'テスト用の問題' } = {}) {
  const url = `https://atcoder.jp/contests/${contest}/tasks/${id}`;
  if (!contestTasks.has(contest)) contestTasks.set(contest, new Map());
  contestTasks.get(contest).set(id, { id, label, title });
  serveTaskList(app, contest);
  const workspace = path.join(app.dataDir, 'workspaces', contest, id);
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await mkdir(workspace, { recursive: true });
  if (task) await writeFile(path.join(workspace, 'task.json'), JSON.stringify({ url, ...task }));
  if (page) app.atcoder.pages.set(`/contests/${contest}/tasks/${id}`, taskPage(page));
  if (code !== null) await writeFile(path.join(workspace, 'solution.rb'), code);
  if (cases !== null) await writeFile(path.join(workspace, 'cases.json'), JSON.stringify({ cases }));
  return { url, contest, id, label, title: `${label} - ${title}`, workspace, solution: path.join(workspace, 'solution.rb'), cases: path.join(workspace, 'cases.json') };
}

// Registers the problem's contest with its task URL, which also opens the task.
async function openProblem(page, problem) {
  await page.locator('#contest-add').click();
  await page.locator('#contest-url').fill(problem.url);
  await page.locator('#contest-register').click();
  await page.locator('#problem-title').filter({ hasText: problem.title }).waitFor();
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
}

// Opens a task from the list of the selected contest.
async function selectTask(page, problem) {
  await page.locator(`.task-item[data-url="${problem.url}"]`).click();
}

// Removes what a test stored for the contest.
async function removeContest(app, contest) {
  await rm(path.join(app.dataDir, 'workspaces', contest), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await rm(path.join(app.dataDir, 'contests', `${contest}.json`), { force: true });
}

// Initialization is complete once the Ruby check has finished and the recheck button is usable.
const waitInitialized = page => page.waitForFunction(() => !document.getElementById('ruby-recheck').disabled);

module.exports = { sampleCode, sampleCases, seedProblem, openProblem, selectTask, removeContest, waitInitialized };
