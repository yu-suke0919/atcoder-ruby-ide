import { ide } from './bridge.mjs';
import { createEditor } from './editor.mjs';
import { createLspClient } from './lsp-completion.mjs';
import { renderStatement } from './presentation.mjs';
import { SampleCases, MAX_CASES } from './sample-cases.mjs';

const $ = (id) => document.getElementById(id);
const input = $('stdin');
const expectedOutput = $('expected-output');
const compareOutput = $('compare-output');
const tolerantCompare = $('tolerant-compare');
const toleranceInput = $('tolerance');
const differenceDialog = $('difference-dialog');
const problemDialog = $('problem-dialog');
const collectionDialog = $('collection-dialog');
const imageDialog = $('image-dialog');
$('image-close').addEventListener('click', () => imageDialog.close());
const collectionRepairDialog = $('collection-repair-dialog');
let repairTarget = null;
let activeProblem = null;
let activeCollectionUrl = null;
let collectionViews = [];
let selectedCollection = null;
let collectionDownloading = false;
let cancelCollection = false;
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
      if (casesChanged) { await ide.saveProblemCases(problem.url, data); if (problem.url === activeProblem?.url) cases.markSaved(data); }
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
  saveFailedDialog.showModal();
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
  differenceDialog.showModal();
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
  $('problem-message').textContent = text;
  $('problem-message').dataset.error = String(error);
}

function collectionMessage(text, error = false) {
  $('collection-message').textContent = text;
  $('collection-message').dataset.error = String(error);
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
  $('problem-toggle').disabled = !activeProblem || fileBusy || closing;
  for (const id of ['collection-repair-cancel', 'collection-repair-confirm']) $(id).disabled = fileBusy || closing || running;
  $('collections').disabled = fileBusy || closing;
  for (const id of ['collection-register', 'collection-url', 'collection-select']) $(id).disabled = fileBusy || closing || running || collectionDownloading;
  $('collection-close').disabled = fileBusy;
  $('collection-resume').disabled = collectionDownloading || fileBusy || closing || running || !selectedCollection || selectedCollection.downloaded.length === selectedCollection.collection.tasks.length;
  $('collection-pause').disabled = !collectionDownloading || cancelCollection;
  for (const button of $('collection-tasks').querySelectorAll('button')) button.disabled = collectionDownloading || fileBusy || closing || running || button.dataset.available !== 'true';
  $('problem-library').disabled = fileBusy || closing;
  for (const id of ['problem-open', 'problem-url']) $(id).disabled = running || fileBusy || closing;
  $('problem-refresh').disabled = running || fileBusy || closing || activeCollectionUrl !== null;
  $('problem-refresh').title = activeCollectionUrl ? '問題集は初回取得した内容を固定保存しています。' : '';
  $('problem-close').disabled = fileBusy;
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
  if (differenceDialog.open || problemDialog.open || collectionDialog.open || collectionRepairDialog.open || imageDialog.open || saveFailedDialog.open) return;
  if (key === 's' && activeProblem && !closing) saveNow();
  if (key === 'enter') run();
});

function showProblem() {
  showExecutionLimit();
  $('problem-title').textContent = activeProblem ? activeProblem.title : '問題を選んでください';
  $('problem-title').title = activeProblem?.title || '';
  $('problem-limits').textContent = activeProblem
    ? `実行時間制限: ${activeProblem.timeLimitMs == null ? '不明' : `${activeProblem.timeLimitMs / 1000} 秒`} / メモリ制限: ${activeProblem.memoryLimitMiB == null ? '不明' : `${activeProblem.memoryLimitMiB} MiB`}` : '';
  const statement = $('problem-statement');
  const scroll = statement.scrollTop;
  renderStatement(statement, activeProblem?.statement || []);
  statement.scrollTop = scroll;
  $('problem-library').title = activeProblem ? activeProblem.title : 'AtCoder の問題を開く';
  document.querySelector('.brand-caption').textContent = activeProblem ? activeProblem.title : '小さく書いて、すぐ試す。';
}
function setProblemVisible(visible) {
  $('problem-panel').hidden = !visible;
  document.querySelector('.workspace').classList.toggle('with-problem', visible);
  $('problem-toggle').textContent = visible ? '問題文を隠す' : '問題文を表示する';
  $('problem-toggle').setAttribute('aria-expanded', String(visible));
}
$('problem-toggle').addEventListener('click', () => {
  if (activeProblem && !fileBusy && !closing) setProblemVisible($('problem-panel').hidden);
});
function applyWorkspace(result, collectionUrl = null) {
  const changedProblem = activeProblem?.url !== result.problem.url;
  clearTimeout(saveTimer);
  saveTimer = null;
  saveError = null;
  activeProblem = result.problem;
  activeCollectionUrl = collectionUrl;
  editor.value = result.document.code;
  savedCode = editor.value;
  filePath = result.document.filePath;
  cases.replace(result.cases, { saved: true });
  showProblem(); showCase(); updateEditor();
  setProblemVisible(true);
  if (changedProblem) $('problem-statement').scrollTop = 0;
}
$('problem-library').addEventListener('click', () => problemDialog.showModal());
$('problem-close').addEventListener('click', () => problemDialog.close());
problemDialog.addEventListener('cancel', event => { if (fileBusy) event.preventDefault(); });
$('problem-open').addEventListener('click', () => {
  if (running) return;
  fileAction(async () => {
    if (!await leaveProblem()) return;
    message('問題を読み込んでいます。');
    const result = await ide.openProblem($('problem-url').value);
    applyWorkspace(result);
    problemDialog.close();
    editor.focus();
    message('問題と保存済みの解答・ケースを開きました。');
  });
});
$('problem-refresh').addEventListener('click', () => {
  if (running || activeCollectionUrl) return;
  fileAction(async () => {
    message('問題を再取得しています。');
    const problem = await ide.refreshProblem($('problem-url').value);
    if (activeProblem?.url === problem.url) {
      activeProblem = problem;
      showProblem();
      updateEditor();
      message('問題文と元のサンプルを更新しました。解答・ケースは保持しています。');
    } else {
      message('問題を再取得しました。「開く」で解答・ケースを開けます。');
    }
  });
});

function renderCollection() {
  const options = collectionViews.map(view => {
    const option = document.createElement('option');
    option.value = view.collection.url;
    option.textContent = view.collection.title;
    return option;
  });
  if (!options.length) { const option = document.createElement('option'); option.value = ''; option.textContent = '問題集を登録してください'; options.push(option); }
  $('collection-select').replaceChildren(...options);
  $('collection-select').value = selectedCollection?.collection.url || '';
  $('collection-title').textContent = selectedCollection?.collection.title || '';
  const tasks = selectedCollection?.collection.tasks || [];
  const downloaded = new Set(selectedCollection?.downloaded || []);
  const failed = tasks.filter(task => !downloaded.has(task.url) && task.error).length;
  $('collection-progress').textContent = `取得済み ${downloaded.size} / ${tasks.length} · 未取得 ${tasks.length - downloaded.size - failed} · 失敗 ${failed}`;
  $('collection-tasks').replaceChildren(...tasks.map(task => {
    const row = document.createElement('div'); row.className = 'collection-task';
    const name = document.createElement('span'); name.textContent = `${task.label} · ${task.title}`;
    const state = document.createElement('span'); state.className = 'task-state';
    state.textContent = downloaded.has(task.url) ? '取得済み' : task.error ? `失敗: ${task.error}` : '未取得';
    state.dataset.error = String(!downloaded.has(task.url) && !!task.error);
    const button = document.createElement('button'); button.textContent = '開く'; button.dataset.available = String(downloaded.has(task.url));
    button.dataset.action = 'open';
    button.setAttribute('aria-label', `${task.label} ${task.title} を開く`);
    const collectionUrl = selectedCollection.collection.url;
    const collectionTitle = selectedCollection.collection.title;
    button.addEventListener('click', () => fileAction(async () => {
      if (running || !await leaveProblem()) return;
      const result = await ide.openCollectionTask(collectionUrl, task.url);
      applyWorkspace(result, collectionUrl);
      collectionDialog.close();
      editor.focus();
      message('固定保存した問題と解答・ケースを開きました。');
    }, collectionMessage));
    const repair = document.createElement('button'); repair.textContent = '取り直す'; repair.dataset.available = String(downloaded.has(task.url)); repair.dataset.action = 'repair';
    repair.setAttribute('aria-label', `${task.label} ${task.title} を取り直す`);
    repair.addEventListener('click', () => {
      if (collectionDownloading || fileBusy || running || closing) return;
      repairTarget = { collectionUrl, taskUrl: task.url, label: task.label };
      $('collection-repair-target').textContent = `${collectionTitle}\n${task.label} · ${task.title}`;
      $('collection-repair-url').textContent = task.url;
      collectionRepairDialog.showModal();
    });
    const actions = document.createElement('div'); actions.className = 'task-actions'; actions.append(button, repair);
    row.append(name, state, actions); return row;
  }));
  updateButtons();
}
function rememberCollection(view) {
  const index = collectionViews.findIndex(item => item.collection.url === view.collection.url);
  if (index < 0) collectionViews.push(view); else collectionViews[index] = view;
  selectedCollection = view;
  renderCollection();
}
async function collectionAction(action) {
  if (collectionDownloading || fileBusy || closing) return;
  collectionDownloading = true; cancelCollection = false;
  $('collection-pause').textContent = '中断'; updateButtons();
  try { await action(); }
  catch (error) { collectionMessage(error.message, true); }
  finally { collectionDownloading = false; updateButtons(); }
}
async function fetchMissingCollectionTasks() {
  const url = selectedCollection.collection.url;
  const downloaded = new Set(selectedCollection.downloaded);
  const queue = selectedCollection.collection.tasks.filter(task => !downloaded.has(task.url));
  for (let index = 0; index < queue.length; index++) {
    if (cancelCollection) break;
    collectionMessage(`${queue[index].label} を取得しています…`);
    rememberCollection(await ide.fetchCollectionTask(url, queue[index].url));
    if (index + 1 < queue.length && !cancelCollection) await new Promise(resolve => setTimeout(resolve, 500));
  }
  collectionMessage(cancelCollection ? '取得を中断しました。未取得分から再開できます。' : '取得処理が終了しました。失敗した問題は「未取得分を取得」で再試行できます。');
}
$('collections').addEventListener('click', () => {
  collectionDialog.showModal();
  if (collectionDownloading) { renderCollection(); return; }
  collectionMessage('');
  fileAction(async () => {
    const previous = selectedCollection?.collection.url;
    collectionViews = await ide.listCollections();
    selectedCollection = collectionViews.find(view => view.collection.url === previous) || collectionViews[0] || null;
    renderCollection();
  }, collectionMessage);
});
$('collection-select').addEventListener('change', () => {
  selectedCollection = collectionViews.find(view => view.collection.url === $('collection-select').value) || null;
  renderCollection();
});
$('collection-register').addEventListener('click', () => collectionAction(async () => {
  if (running) return;
  collectionMessage('問題集の一覧を読み込んでいます…');
  const result = await ide.registerCollection($('collection-url').value);
  rememberCollection(result.view);
  if (result.created) await fetchMissingCollectionTasks();
  else collectionMessage('保存済みの問題集を開きました。');
}));
$('collection-resume').addEventListener('click', () => collectionAction(async () => {
  if (!running && selectedCollection) await fetchMissingCollectionTasks();
}));
$('collection-pause').addEventListener('click', () => {
  cancelCollection = true;
  $('collection-pause').textContent = '中断中…';
  updateButtons();
});
$('collection-close').addEventListener('click', () => collectionDialog.close());
collectionDialog.addEventListener('cancel', event => { if (fileBusy) event.preventDefault(); });
$('collection-repair-cancel').addEventListener('click', () => collectionRepairDialog.close());
collectionRepairDialog.addEventListener('close', () => { repairTarget = null; });
$('collection-repair-confirm').addEventListener('click', () => {
  const target = repairTarget;
  if (!target || running) return;
  fileAction(async () => {
    collectionRepairDialog.close();
    collectionMessage(`${target.label} を取り直しています…`);
    const result = await ide.repairCollectionTask(target.collectionUrl, target.taskUrl);
    rememberCollection(result.view);
    if (activeCollectionUrl === target.collectionUrl && activeProblem?.url === target.taskUrl) {
      activeProblem = result.problem;
      showProblem(); updateEditor();
    }
    collectionMessage('問題文と元のサンプルを取り直しました。解答・編集済みケースは保持しています。');
  }, collectionMessage);
});

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
    await checkRuby();
  } catch (error) {
    $('ruby-version').textContent = '初期化できません';
    message(`初期化に失敗しました：${error.message}`, true);
  }
}
initialize();
