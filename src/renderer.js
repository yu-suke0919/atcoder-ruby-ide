import { ide } from './bridge.mjs';
import { createEditor } from './editor.mjs';
import { createLspClient } from './lsp-completion.mjs';
import { SampleCases, MAX_CASES } from './sample-cases.mjs';

const $ = (id) => document.getElementById(id);
const input = $('stdin');
const expectedOutput = $('expected-output');
const compareOutput = $('compare-output');
const tolerantCompare = $('tolerant-compare');
const toleranceInput = $('tolerance');
const differenceDialog = $('difference-dialog');
const contestDialog = $('contest-dialog');
const railMenu = $('rail-menu');
// The opened task: the saved task data plus its label and title from the task list.
let activeProblem = null;
let contests = [];
let selectedContest = null;
// The task whose page is being read; it opens when its task-page event arrives.
let pendingTask = null;
const saveFailedDialog = $('save-failed-dialog');
const cases = new SampleCases([{ stdin: '', expectedOutput: '', compare: false }]);
// Edits are written to the opened problem's workspace after a short pause; Ctrl+S writes immediately.
const SAVE_DELAY_MS = 800;
let saveTimer = null;
let saving = null;
let saveError = null;
let resolveSaveFailed = null;
let canceled = false;
const comparisonLabels = { none: '比較なし', pending: '未比較', running: '比較中…', matched: '一致', mismatched: '不一致', unavailable: '判定なし' };
const statusLabel = (status, exitCode, executionLimitMs) => ({ completed: '正常終了', failed: `エラー終了${exitCode == null ? '' : ` (${exitCode})`}`, stopped: '停止しました', timeout: `時間制限で停止（${executionLimitMs / 1000} 秒）`, 'output-limit': '出力上限で停止（1 MiB）', 'memory-limit': 'ローカルのメモリ上限で停止（1 GiB）', running: '実行中…', canceled: '未実行（中止）', error: '実行できませんでした' })[status] || '実行する準備ができています';
let savedCode = '';
let filePath = null;
let running = false;
let fileBusy = true;
let rubyAvailable = false;
let rubyChecking = false;
let currentRun = null;
let closing = false;
let scrollFrame = null;
let completionStatus = 'idle';
const completionClient = createLspClient(ide, ({ status, error }) => {
  completionStatus = status;
  $('completion-state').textContent = ({ starting: '補完を準備中…', ready: '補完の準備完了', failed: '補完の接続に失敗しました（基本候補を使用）' })[status];
  $('completion-state').dataset.state = status;
  $('completion-state').title = error;
  $('completion-retry').hidden = status !== 'failed';
  $('completion-retry').disabled = fileBusy || closing || status === 'starting';
});
const editor = createEditor($('editor-host'), '', () => { resetComparison(true); updateEditor(); scheduleSave(); }, updateCursor, completionClient);
$('completion-retry').addEventListener('click', async () => {
  if (fileBusy || closing || completionStatus === 'starting') return;
  try { await completionClient.retry(); if (!fileBusy && !closing) editor.complete(); }
  catch { /* The completion status reports the failure; basic editing remains available. */ }
});
$('editor-search').addEventListener('click', () => editor.search());
$('editor-complete').addEventListener('click', () => editor.complete());
$('error-location').addEventListener('click', () => { if (!fileBusy && !closing) editor.jumpToError(); });

const needsSave = () => activeProblem !== null && (editor.value !== savedCode || cases.dirty);

function showSaveState() {
  const state = !activeProblem ? 'none' : saving ? 'saving' : saveError ? 'failed' : needsSave() ? 'pending' : 'saved';
  $('save-state').dataset.state = state;
  $('save-state').textContent = { none: '問題を開いてください', saved: '保存済み', pending: '● 未保存の変更', saving: '保存中…', failed: '保存に失敗しました' }[state];
  $('save-state').title = saveError || '';
  $('save-retry').hidden = state !== 'failed';
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = needsSave() ? setTimeout(() => { saveTimer = null; saveNow(); }, SAVE_DELAY_MS) : null;
  showSaveState();
}

// Returns whether everything edited so far is on disk.
async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  while (saving) await saving;
  if (!needsSave()) { showSaveState(); return saveError === null; }
  const problem = activeProblem;
  const code = editor.value;
  const data = cases.data();
  const codeChanged = code !== savedCode;
  const casesChanged = cases.dirty;
  saving = (async () => {
    try {
      if (codeChanged) { await ide.saveCode(code); if (problem.url === activeProblem?.url) savedCode = code; }
      if (casesChanged) { await ide.saveTaskCases(problem.url, data); if (problem.url === activeProblem?.url) cases.markSaved(data); }
      saveError = null;
    } catch (error) {
      saveError = error.message;
    }
  })();
  showSaveState();
  await saving;
  saving = null;
  updateEditor();
  if (saveError === null && needsSave()) scheduleSave();
  else showSaveState();
  return saveError === null;
}

function confirmSaveFailed() {
  $('save-failed-message').textContent = `${saveError}\n保存できなかった変更を破棄して続けますか？`;
  openDialog(saveFailedDialog);
  return new Promise(resolve => { resolveSaveFailed = resolve; });
}
function finishSaveFailed(discard) {
  const resolve = resolveSaveFailed;
  resolveSaveFailed = null;
  saveFailedDialog.close();
  resolve?.(discard);
}
$('save-failed-cancel').addEventListener('click', () => finishSaveFailed(false));
$('save-failed-discard').addEventListener('click', () => finishSaveFailed(true));
saveFailedDialog.addEventListener('close', () => finishSaveFailed(false));
$('save-retry').addEventListener('click', () => saveNow());

// Saves pending edits before the problem changes; only a failed save asks the user.
async function leaveProblem() {
  return await saveNow() || await confirmSaveFailed();
}

function showComparison(state) {
  $('comparison-status').textContent = comparisonLabels[state];
  $('comparison-status').dataset.state = state;
  const available = state === 'mismatched' && cases.current.difference !== null;
  $('comparison-status').disabled = !available;
  $('comparison-status').setAttribute('aria-label', available ? '不一致の詳細を表示' : comparisonLabels[state]);
  $('comparison-status').title = available ? 'クリックして最初の不一致を確認' : '';
  if (!available) {
    differenceDialog.close();
    for (const id of ['difference-position', 'difference-actual', 'difference-expected']) $(id).replaceChildren();
  }
}

function showDifferenceLine(target, value, column) {
  const mark = document.createElement('mark');
  if (value === null || value === '') {
    mark.textContent = value === null ? '（行なし）' : '（空行）';
    target.replaceChildren(mark);
    return;
  }
  const characters = Array.from(value);
  const index = column - 1;
  const start = Math.max(0, index - 40);
  const end = Math.min(characters.length, index + 41);
  const visible = text => text.replaceAll(' ', '␠').replaceAll('　', '□').replaceAll('\t', '⇥');
  const whitespace = { ' ': '␠（半角空白）', '　': '□（全角空白）', '\t': '⇥（タブ）' };
  mark.textContent = index < characters.length ? whitespace[characters[index]] || characters[index] : '（行末）';
  if (index < characters.length) mark.title = `U+${characters[index].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  target.replaceChildren(
    document.createTextNode((start > 0 ? '…' : '') + visible(characters.slice(start, index).join(''))),
    mark,
    document.createTextNode(visible(characters.slice(index + 1, end).join('')) + (end < characters.length ? '…' : '')),
  );
}

function openDifference() {
  const detail = cases.current.difference;
  if (cases.current.comparison !== 'mismatched' || !detail) return;
  $('difference-position').textContent = detail.column === detail.expectedColumn
    ? `最初の不一致：${detail.line} 行 ${detail.column} 列`
    : `最初の不一致：${detail.line} 行 実際 ${detail.column} 列 / 期待 ${detail.expectedColumn} 列`;
  showDifferenceLine($('difference-expected'), detail.expectedLine, detail.expectedColumn);
  showDifferenceLine($('difference-actual'), detail.actualLine, detail.column);
  openDialog(differenceDialog);
}
$('comparison-status').addEventListener('click', openDifference);
$('difference-close').addEventListener('click', () => differenceDialog.close());

function updateCaseList() {
  $('case-select').replaceChildren(...cases.items.map((item, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `ケース ${index + 1} · ${item.status === 'running' ? '実行中' : item.status && item.status !== 'completed' ? statusLabel(item.status, item.exitCode, item.executionLimitMs) : comparisonLabels[item.comparison]}`;
    if (item.exceededTimeLimitMs !== null) option.textContent += ' · 制限超過の可能性';
    return option;
  }));
  $('case-select').value = String(cases.selected);
  $('case-count').textContent = `${cases.items.length} ケース`;
  const done = cases.items.filter(item => item.status && !['running', 'canceled'].includes(item.status)).length;
  const count = state => cases.items.filter(item => item.comparison === state).length;
  const errors = cases.items.filter(item => ['failed', 'timeout', 'output-limit', 'memory-limit', 'error'].includes(item.status)).length;
  const warnings = cases.items.filter(item => item.exceededTimeLimitMs !== null).length;
  $('cases-summary').textContent = `完了 ${done} / ${cases.items.length} · 一致 ${count('matched')} · 不一致 ${count('mismatched')} · エラー ${errors}${warnings ? ` · 制限超過の可能性 ${warnings}` : ''}`;
}

function showResult() {
  const item = cases.current;
  for (const stream of ['stdout', 'stderr']) $(stream).textContent = item[stream];
  $('run-status').textContent = statusLabel(item.status, item.exitCode, item.executionLimitMs);
  $('run-duration').textContent = item.durationMs === null ? '— ms' : `${item.durationMs} ms`;
  showExecutionLimit();
  showTimeLimitWarning();
  showComparison(item.comparison);
  showErrorLocation();
  updateCaseList();
}

function showExecutionLimit() {
  const limit = cases.current.executionLimitMs;
  $('execution-limit').textContent = limit != null ? `実行時上限 ${limit / 1000} 秒`
    : activeProblem?.timeLimitMs != null ? '実行上限 5〜30 秒' : '既定上限 5 秒';
}

function showTimeLimitWarning() {
  const limit = cases.current.exceededTimeLimitMs;
  $('time-limit-warning').hidden = limit === null;
  $('time-limit-warning').textContent = limit === null ? '' : `制限超過の可能性（問題の制限 ${limit / 1000} 秒）`;
}

function showErrorLocation() {
  const line = cases.current.errorLine;
  $('error-location').hidden = line === null;
  $('error-location').textContent = line === null ? '' : `コードの${line}行目へ`;
  editor.errorLine = line;
}

function showCase() {
  differenceDialog.close();
  const item = cases.current;
  input.value = item.stdin;
  expectedOutput.value = item.expectedOutput;
  compareOutput.checked = item.compare;
  showTolerance();
  expectedOutput.disabled = !item.compare;
  showResult();
  updateButtons();
}

function showTolerance() {
  tolerantCompare.checked = cases.current.tolerance !== null;
  toleranceInput.value = cases.current.tolerance ?? 1e-6;
  toleranceInput.setCustomValidity(typeof cases.current.tolerance === 'number' && cases.current.tolerance > 0 && Number.isFinite(cases.current.tolerance)
    || cases.current.tolerance === null ? '' : '許容誤差は0より大きい有限の数にしてください。');
}

function resetComparison(all = false) {
  cases.invalidate(all);
  expectedOutput.disabled = !cases.current.compare;
  showComparison(cases.current.comparison);
  showErrorLocation();
  showTimeLimitWarning();
  updateCaseList();
}

function message(text, error = false) {
  $('message').textContent = text;
  $('message').dataset.error = String(error);
}

function taskMessage(text, error = false) {
  $('task-message').textContent = text;
  $('task-message').dataset.error = String(error);
}

function updateEditor() {
  const name = filePath ? filePath.split(/[\\/]/).at(-1) : '';
  ide.setTitle(activeProblem ? `${activeProblem.title} · ${name} — AtCoder Ruby IDE` : 'AtCoder Ruby IDE').catch(() => {});
  showSaveState();
  $('file-path').textContent = filePath || '問題を開いてください';
  $('file-path').title = filePath || '問題を開いてください';
  updateCursor();
}

function updateCursor() {
  const { line, column } = editor.cursor;
  $('cursor-position').textContent = `Ln ${line}, Col ${column}`;
}

function updateButtons() {
  const locked = fileBusy || closing || !activeProblem;
  for (const button of document.querySelectorAll('.task-item')) button.disabled = fileBusy || closing || running;
  $('contest-add').disabled = fileBusy || closing;
  $('ruby-recheck').disabled = rubyChecking || running || fileBusy || closing;
  for (const id of ['run', 'run-all']) $(id).disabled = running || !rubyAvailable || locked;
  $('case-add').disabled = running || locked || cases.items.length >= MAX_CASES;
  $('case-remove').disabled = running || locked || cases.items.length === 1;
  $('case-select').disabled = locked;
  $('stop').disabled = !running;
  $('clear-output').disabled = running || locked;
  editor.readOnly = locked;
  $('editor-search').disabled = locked;
  $('editor-complete').disabled = locked;
  $('completion-retry').disabled = locked || completionStatus === 'starting';
  $('error-location').disabled = locked;
  input.readOnly = expectedOutput.readOnly = locked;
  compareOutput.disabled = locked;
  tolerantCompare.disabled = locked || !cases.current.compare;
  toleranceInput.disabled = locked || !cases.current.compare || cases.current.tolerance === null;
}

async function fileAction(action, report = message) {
  if (fileBusy || closing) return;
  fileBusy = true;
  updateButtons();
  try { await action(); }
  catch (error) { report(`操作に失敗しました：${error.message}`, true); }
  finally { fileBusy = false; updateButtons(); }
}

async function run(all = false) {
  if (running || fileBusy || closing || !rubyAvailable || !activeProblem) return;
  const code = editor.value;
  cases.clear(all);
  const queue = cases.snapshot(all, activeProblem?.timeLimitMs ?? null);
  canceled = false;
  running = true;
  updateButtons();
  const pending = (async () => {
    for (const snapshot of queue) {
      const { item } = snapshot;
      if (canceled) { cases.cancel(snapshot); continue; }
      cases.begin(snapshot);
      showResult();
      message('Ruby を実行しています。');
      try {
        const result = await ide.run(code, snapshot.stdin, snapshot.compare ? snapshot.expectedOutput : null, snapshot.compare ? snapshot.tolerance : null, snapshot.timeLimitMs, event => {
          if (event.type === 'started') {
            cases.started(snapshot, event.executionLimitMs);
            if (item === cases.current) showExecutionLimit();
          } else {
            item[event.stream] += event.text;
            if (item === cases.current) appendOutput(event.stream, event.text);
          }
        });
        cases.finish(snapshot, result);
        message(result.status === 'completed' ? '実行が完了しました。' : statusLabel(result.status, result.exitCode, result.executionLimitMs), ['failed', 'timeout', 'output-limit', 'memory-limit'].includes(result.status));
      } catch (error) {
        cases.fail(snapshot, error.message);
        message(error.message, true);
      }
      showResult();
    }
  })();
  currentRun = pending;
  try { await pending; }
  finally { currentRun = null; running = false; showResult(); updateButtons(); }
}

function appendOutput(stream, text) {
  const output = $(stream);
  output.append(document.createTextNode(text));
  if (scrollFrame === null) scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;
    for (const id of ['stdout', 'stderr']) $(id).scrollTop = $(id).scrollHeight;
  });
}
async function stop() {
  canceled = true;
  try { await ide.stop(); }
  catch (error) { message(error.message, true); }
}
$('run').addEventListener('click', () => run());
$('run-all').addEventListener('click', () => run(true));
$('stop').addEventListener('click', stop);
$('case-select').addEventListener('change', () => { cases.selected = Number($('case-select').value); showCase(); });
$('case-add').addEventListener('click', () => {
  cases.add();
  showCase();
  scheduleSave();
});
$('case-remove').addEventListener('click', () => {
  cases.remove();
  showCase();
  scheduleSave();
});
$('clear-output').addEventListener('click', () => {
  cases.clear();
  showResult();
});
function editCase(field, value) {
  cases.current[field] = value;
  resetComparison();
  scheduleSave();
}
input.addEventListener('input', () => editCase('stdin', input.value));
expectedOutput.addEventListener('input', () => editCase('expectedOutput', expectedOutput.value));
compareOutput.addEventListener('change', () => { editCase('compare', compareOutput.checked); updateButtons(); });
tolerantCompare.addEventListener('change', () => {
  editCase('tolerance', tolerantCompare.checked ? 1e-6 : null);
  showTolerance();
  updateButtons();
});
toleranceInput.addEventListener('input', () => {
  const value = toleranceInput.valueAsNumber;
  // Keep incomplete input as a string so JSON cannot silently turn NaN into null/strict mode.
  editCase('tolerance', Number.isFinite(value) ? value : toleranceInput.value);
  toleranceInput.setCustomValidity(Number.isFinite(value) && value > 0 ? '' : '許容誤差は0より大きい有限の数にしてください。');
});
document.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if (!event.ctrlKey && !event.metaKey) return;
  const key = event.key.toLowerCase();
  if (['s', 'o', 'enter'].includes(key)) event.preventDefault();
  if (document.querySelector('dialog[open]')) return;
  if (key === 's' && activeProblem && !closing) saveNow();
  if (key === 'enter') run();
});

function showProblem() {
  showExecutionLimit();
  $('problem-title').textContent = activeProblem ? activeProblem.title : '問題を選んでください';
  $('problem-title').title = activeProblem?.title || '';
  $('problem-limits').textContent = activeProblem
    ? `実行時間制限 ${activeProblem.timeLimitMs == null ? '不明' : `${activeProblem.timeLimitMs / 1000} 秒`} / メモリ制限 ${activeProblem.memoryLimitMiB == null ? '不明' : `${activeProblem.memoryLimitMiB} MiB`}` : '';
  renderTasks();
}
function applyWorkspace(result, task) {
  clearTimeout(saveTimer);
  saveTimer = null;
  saveError = null;
  activeProblem = { ...result.task, title: `${task.label} - ${task.title}` };
  editor.value = result.document.code;
  savedCode = editor.value;
  filePath = result.document.filePath;
  cases.replace(result.cases, { saved: true });
  showProblem(); showCase(); updateEditor();
}

// Native pages sit above the HTML, so they are hidden while an in-app dialog is open.
function syncBrowser() {
  ide.browserVisible(!document.querySelector('dialog[open]')).catch(() => {});
}
function openDialog(dialog) {
  dialog.showModal();
  syncBrowser();
}
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('close', syncBrowser);
function layoutBrowser() {
  const rect = $('browser-host').getBoundingClientRect();
  ide.browserLayout(rect.x, rect.y, rect.width, rect.height).catch(() => {});
}
new ResizeObserver(layoutBrowser).observe($('browser-host'));
window.addEventListener('resize', layoutBrowser);

const contestFor = url => contests.find(contest => contest.url === url) || null;
function renderRail() {
  $('contest-icons').replaceChildren(...contests.filter(contest => !contest.hidden).map(contest => {
    const button = document.createElement('button');
    button.className = 'rail-icon';
    button.textContent = contest.url.split('/').at(-1).slice(0, 6);
    button.title = contest.title;
    button.setAttribute('aria-label', contest.title);
    button.setAttribute('aria-pressed', String(contest.url === selectedContest));
    button.addEventListener('click', () => selectContest(contest.url));
    button.addEventListener('contextmenu', event => {
      event.preventDefault();
      event.stopPropagation();
      showMenu(event, [{ label: `「${contest.title}」を非表示にする`, action: () => setHidden(contest.url, true) }]);
    });
    return button;
  }));
}
function renderTasks() {
  const contest = contestFor(selectedContest);
  $('contest-title').textContent = contest ? contest.title : 'コンテストを選んでください';
  $('task-list').replaceChildren(...(contest?.tasks || []).map(task => {
    const button = document.createElement('button');
    button.className = 'task-item';
    button.dataset.url = task.url;
    const label = document.createElement('span'); label.className = 'task-label'; label.textContent = task.label;
    const title = document.createElement('span'); title.textContent = task.title;
    button.append(label, title);
    button.setAttribute('aria-current', String(task.url === activeProblem?.url));
    button.addEventListener('click', () => openTask(task));
    return button;
  }));
  updateButtons();
}
function showMenu(event, items) {
  railMenu.replaceChildren(...(items.length ? items.map(item => {
    const button = document.createElement('button');
    button.setAttribute('role', 'menuitem');
    button.textContent = item.label;
    button.addEventListener('click', () => { hideMenu(); item.action(); });
    return button;
  }) : [Object.assign(document.createElement('p'), { textContent: '非表示のコンテスト・問題集はありません' })]));
  railMenu.style.left = `${event.clientX}px`;
  railMenu.style.top = `${event.clientY}px`;
  railMenu.hidden = false;
}
function hideMenu() { railMenu.hidden = true; }
document.addEventListener('click', event => { if (!railMenu.contains(event.target)) hideMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') hideMenu(); });
$('contest-rail').addEventListener('contextmenu', event => {
  event.preventDefault();
  showMenu(event, contests.filter(contest => contest.hidden).map(contest => ({ label: `「${contest.title}」を表示する`, action: () => setHidden(contest.url, false) })));
});

function rememberContest(contest) {
  const index = contests.findIndex(item => item.url === contest.url);
  if (index < 0) contests.push(contest); else contests[index] = contest;
  contests.sort((a, b) => a.url.localeCompare(b.url));
}
async function setHidden(url, hidden) {
  try {
    rememberContest(await ide.setContestHidden(url, hidden));
    if (hidden && selectedContest === url) await selectContest(null);
    renderRail();
  } catch (error) { taskMessage(error.message, true); }
}
async function selectContest(url) {
  hideMenu();
  if (url !== selectedContest) {
    selectedContest = url;
    pendingTask = null;
    taskMessage('');
    await ide.browserCloseTasks().catch(() => {});
  }
  await ide.browserHome(url).catch(error => taskMessage(error.message, true));
  renderRail();
  renderTasks();
}

// Shows the task page; its workspace opens once the page has been read.
async function openTask(task) {
  if (running || fileBusy || closing) return;
  if (activeProblem?.url === task.url) {
    // The open problem keeps its edits; only its page is shown again.
    pendingTask = null;
    await ide.browserTask(task.url).catch(error => taskMessage(error.message, true));
    return;
  }
  if (!await leaveProblem()) return;
  pendingTask = task;
  try {
    await ide.browserTask(task.url);
    await openPendingTask();
  } catch (error) { taskMessage(error.message, true); }
}
// Opens run one after another, so a page read while the previous open is checking is not lost.
let opening = Promise.resolve();
function openPendingTask() {
  opening = opening.then(openPendingTaskNow);
  return opening;
}
async function openPendingTaskNow() {
  const task = pendingTask;
  if (!task) return;
  await fileAction(async () => {
    const result = await ide.openTask(task.url);
    if (pendingTask !== task) return;
    if (!result) {
      taskMessage(`${task.label} の問題ページを読み込んでいます。表示されない場合は、右側のブラウザでログインし、開催中のコンテストは参加登録してください。`);
      return;
    }
    pendingTask = null;
    applyWorkspace(result, task);
    taskMessage('');
    message(`${task.label} を開きました。`);
    editor.focus();
  }, taskMessage);
}
ide.onTaskPage(page => {
  if (page.url !== pendingTask?.url) return;
  if (page.error) taskMessage(`${pendingTask.label}：${page.error}`, true);
  else openPendingTask();
}).catch(error => message(String(error), true));

$('contest-add').addEventListener('click', () => {
  $('contest-message').textContent = '';
  openDialog(contestDialog);
  $('contest-url').focus();
});
$('contest-cancel').addEventListener('click', () => contestDialog.close());
$('contest-register').addEventListener('click', async () => {
  if ($('contest-register').disabled) return;
  $('contest-register').disabled = true;
  $('contest-message').dataset.error = 'false';
  $('contest-message').textContent = '問題一覧を取得しています…';
  try {
    const registered = await ide.registerContest($('contest-url').value);
    rememberContest(registered.contest);
    contestDialog.close();
    await selectContest(registered.contest.url);
    const task = registered.task && registered.contest.tasks.find(item => item.url === registered.task);
    if (task) await openTask(task);
  } catch (error) {
    $('contest-message').dataset.error = 'true';
    $('contest-message').textContent = error.message;
  } finally {
    $('contest-register').disabled = false;
  }
});
$('contest-url').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) $('contest-register').click(); });

window.addEventListener('beforeunload', event => {
  if (closing || (!fileBusy && !running && !saving && saveError === null && !needsSave())) return;
  event.preventDefault();
  event.returnValue = '';
});

showCase();
updateEditor();
updateButtons();
ide.onCloseRequested(async event => {
  event.preventDefault();
  if (closing) return;
  closing = true;
  let destroyed = false;
  updateButtons();
  try {
    if (!await leaveProblem()) return;
    await stop();
    await currentRun?.catch(() => {});
    await ide.destroy();
    destroyed = true;
  } finally {
    if (!destroyed) { closing = false; updateButtons(); }
  }
}).catch(error => message(String(error), true));

async function checkRuby() {
  if (rubyChecking || running || fileBusy || closing) return;
  rubyChecking = true;
  rubyAvailable = false;
  $('ruby-version').textContent = 'Ruby を確認中…';
  updateButtons();
  try {
    const info = await ide.rubyInfo();
    rubyAvailable = true;
    $('ruby-version').textContent = info.version;
    $('ruby-version').title = info.version;
    message('Ruby を確認しました。');
  } catch (error) {
    $('ruby-version').textContent = 'Ruby を起動できません';
    $('ruby-version').title = error.message;
    message(error.message, true);
  } finally {
    rubyChecking = false;
    updateButtons();
  }
}
$('ruby-recheck').addEventListener('click', checkRuby);
async function initialize() {
  try {
    await ide.resetSession();
    fileBusy = false;
    updateButtons();
    layoutBrowser();
    contests = await ide.listContests();
    renderRail();
    renderTasks();
    await checkRuby();
  } catch (error) {
    $('ruby-version').textContent = '初期化できません';
    message(`初期化に失敗しました：${error.message}`, true);
  }
}
initialize();
