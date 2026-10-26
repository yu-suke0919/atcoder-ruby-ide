import { ide } from './bridge.js';

const $ = (id) => document.getElementById(id);
const editor = $('code-editor');
const input = $('stdin');
const expectedOutput = $('expected-output');
const compareOutput = $('compare-output');
const sample = 'a = gets.to_i\nb, c = gets.split.map(&:to_i)\ns = gets.chomp\n\nputs "#{a + b + c} #{s}"\n';
editor.value = sample;
function newCase(stdin = '', expectedOutput = '', compare = true) {
  return { stdin, expectedOutput, compare, revision: 0, comparison: compare ? 'pending' : 'none', stdout: '', stderr: '', status: null, durationMs: null };
}
let cases = [newCase('1\n2 3\ntest\n', '6 test\n', false)];
let selectedCase = 0;
let canceled = false;
const currentCase = () => cases[selectedCase];
const comparisonLabels = { none: '比較なし', pending: '未比較', running: '比較中…', matched: '一致', mismatched: '不一致', unavailable: '判定なし' };
const statusLabel = (status, exitCode) => ({ completed: '正常終了', failed: `エラー終了${exitCode == null ? '' : ` (${exitCode})`}`, stopped: '停止しました', timeout: '時間制限で停止（5 秒）', 'output-limit': '出力上限で停止（1 MiB）', running: '実行中…', canceled: '未実行（中止）', error: '実行できませんでした' })[status] || '実行する準備ができています';
let savedCode = sample;
let filePath = null;
let running = false;
let fileBusy = false;
let rubyAvailable = false;
let currentRun = null;
let closing = false;
let scrollFrame = null;

async function confirmDiscard() {
  return editor.value === savedCode || await ide.confirmDiscard();
}

function showComparison(state) {
  $('comparison-status').textContent = comparisonLabels[state];
  $('comparison-status').dataset.state = state;
}

function updateCaseList() {
  $('case-select').replaceChildren(...cases.map((item, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `ケース ${index + 1} · ${item.status === 'running' ? '実行中' : item.status && item.status !== 'completed' ? statusLabel(item.status, item.exitCode) : comparisonLabels[item.comparison]}`;
    return option;
  }));
  $('case-select').value = String(selectedCase);
  $('case-count').textContent = `${cases.length} ケース`;
  const done = cases.filter(item => item.status && !['running', 'canceled'].includes(item.status)).length;
  const count = state => cases.filter(item => item.comparison === state).length;
  const errors = cases.filter(item => ['failed', 'timeout', 'output-limit', 'error'].includes(item.status)).length;
  $('cases-summary').textContent = `完了 ${done} / ${cases.length} · 一致 ${count('matched')} · 不一致 ${count('mismatched')} · エラー ${errors}`;
}

function showResult() {
  const item = currentCase();
  for (const stream of ['stdout', 'stderr']) $(stream).textContent = item[stream];
  $('run-status').textContent = statusLabel(item.status, item.exitCode);
  $('run-duration').textContent = item.durationMs === null ? '— ms' : `${item.durationMs} ms`;
  showComparison(item.comparison);
  updateCaseList();
}

function showCase() {
  const item = currentCase();
  input.value = item.stdin;
  expectedOutput.value = item.expectedOutput;
  compareOutput.checked = item.compare;
  expectedOutput.disabled = !item.compare;
  showResult();
  updateButtons();
}

function resetComparison(all = false) {
  for (const item of all ? cases : [currentCase()]) {
    item.revision++;
    item.comparison = item.compare ? 'pending' : 'none';
  }
  expectedOutput.disabled = !currentCase().compare;
  showComparison(currentCase().comparison);
  updateCaseList();
}

function message(text, error = false) {
  $('message').textContent = text;
  $('message').dataset.error = String(error);
}

function updateEditor() {
  const dirty = editor.value !== savedCode;
  const name = filePath ? filePath.split(/[\\/]/).at(-1) : '無題.rb';
  ide.setTitle(`${dirty ? '● ' : ''}${name} — AtCoder Ruby IDE`).catch(() => {});
  $('save-state').textContent = dirty ? '● 未保存の変更' : filePath ? '保存済み' : '未保存のファイル';
  $('file-path').textContent = filePath || '無題.rb';
  $('file-path').title = filePath || '未保存のファイル';
  $('line-numbers').textContent = Array.from({ length: editor.value.split('\n').length }, (_, i) => i + 1).join('\n');
  updateCursor();
}

function updateCursor() {
  const beforeCursor = editor.value.slice(0, editor.selectionStart).split('\n');
  $('cursor-position').textContent = `Ln ${beforeCursor.length}, Col ${beforeCursor.at(-1).length + 1}`;
}

function updateButtons() {
  for (const id of ['run', 'run-all']) $(id).disabled = running || !rubyAvailable || fileBusy || closing;
  $('case-add').disabled = running || fileBusy || closing;
  $('case-remove').disabled = running || fileBusy || closing || cases.length === 1;
  $('case-select').disabled = fileBusy || closing;
  $('stop').disabled = !running;
  $('clear-output').disabled = running;
  for (const id of ['new', 'open', 'save-as']) $(id).disabled = running || fileBusy || closing;
  $('save').disabled = fileBusy || closing || (running && !filePath);
  editor.readOnly = fileBusy || closing;
}

async function fileAction(action) {
  if (fileBusy || closing) return;
  fileBusy = true;
  updateButtons();
  try { await action(); }
  catch (error) { message(`ファイル操作に失敗しました：${error.message}`, true); }
  finally { fileBusy = false; updateButtons(); }
}

function openFile() {
  if (running) return;
  return fileAction(async () => {
    if (!await confirmDiscard()) return;
    const result = await ide.openFile();
    if (result.canceled) return;
    editor.value = result.code;
    savedCode = editor.value;
    filePath = result.filePath;
    resetComparison(true);
    updateEditor();
    message('ファイルを開きました。');
  });
}

function saveFile(saveAs = false) {
  if (running && (saveAs || !filePath)) return;
  return fileAction(async () => {
    const code = editor.value;
    const result = await ide.saveFile(code, saveAs);
    if (result.canceled) return;
    if (filePath !== result.filePath) resetComparison(true);
    savedCode = code;
    filePath = result.filePath;
    updateEditor();
    message('ファイルを保存しました。');
  });
}

async function run(all = false) {
  if (running || fileBusy || closing || !rubyAvailable) return;
  const code = editor.value;
  const queue = (all ? cases : [currentCase()]).map(item => ({ item, stdin: item.stdin, expectedOutput: item.expectedOutput, compare: item.compare, revision: item.revision }));
  for (const { item } of queue) {
    Object.assign(item, { stdout: '', stderr: '', status: null, durationMs: null, comparison: item.compare ? 'pending' : 'none' });
  }
  canceled = false;
  running = true;
  updateButtons();
  const pending = (async () => {
    for (const snapshot of queue) {
      const { item } = snapshot;
      if (canceled) { item.status = 'canceled'; item.comparison = item.compare ? 'pending' : 'none'; continue; }
      Object.assign(item, { stdout: '', stderr: '', status: 'running', durationMs: null });
      if (item.revision === snapshot.revision) item.comparison = snapshot.compare ? 'running' : 'none';
      showResult();
      message('Ruby を実行しています。');
      try {
        const result = await ide.run(code, snapshot.stdin, snapshot.compare ? snapshot.expectedOutput : null, ({ stream, text }) => {
          item[stream] += text;
          if (item === currentCase()) appendOutput(stream, text);
        });
        Object.assign(item, { stdout: result.stdout, stderr: result.stderr, status: result.status, exitCode: result.exitCode, durationMs: result.durationMs });
        if (item.revision === snapshot.revision && snapshot.compare) item.comparison = result.comparison === null ? 'unavailable' : result.comparison ? 'matched' : 'mismatched';
        message(result.status === 'completed' ? '実行が完了しました。' : statusLabel(result.status, result.exitCode), ['failed', 'timeout', 'output-limit'].includes(result.status));
      } catch (error) {
        item.status = 'error';
        if (item.revision === snapshot.revision && snapshot.compare) item.comparison = 'unavailable';
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
$('case-select').addEventListener('change', () => { selectedCase = Number($('case-select').value); showCase(); });
$('case-add').addEventListener('click', () => {
  cases.push(newCase()); selectedCase = cases.length - 1; showCase();
});
$('case-remove').addEventListener('click', () => {
  if (cases.length === 1) return;
  cases.splice(selectedCase, 1); selectedCase = Math.min(selectedCase, cases.length - 1); showCase();
});
$('open').addEventListener('click', openFile);
$('save').addEventListener('click', () => saveFile());
$('save-as').addEventListener('click', () => saveFile(true));
$('new').addEventListener('click', () => fileAction(async () => {
  if (running) return;
  if (!await confirmDiscard()) return;
  await ide.newFile();
  editor.value = '';
  savedCode = '';
  filePath = null;
  resetComparison(true);
  updateEditor();
  message('新しいファイルを作成しました。');
}));
$('clear-output').addEventListener('click', () => {
  Object.assign(currentCase(), { stdout: '', stderr: '', status: null, durationMs: null });
  resetComparison(); showResult();
});
function editCase() {
  Object.assign(currentCase(), { stdin: input.value, expectedOutput: expectedOutput.value, compare: compareOutput.checked });
  resetComparison();
}
input.addEventListener('input', editCase);
expectedOutput.addEventListener('input', editCase);
compareOutput.addEventListener('change', editCase);
editor.addEventListener('input', () => { resetComparison(true); updateEditor(); });
editor.addEventListener('click', updateCursor);
editor.addEventListener('keyup', updateCursor);
editor.addEventListener('scroll', () => { $('line-numbers').scrollTop = editor.scrollTop; });
editor.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && !editor.readOnly) {
    event.preventDefault();
    editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
    resetComparison(true);
    updateEditor();
  }
});
document.addEventListener('keydown', (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  const key = event.key.toLowerCase();
  if (['s', 'o', 'enter'].includes(key)) event.preventDefault();
  if (key === 's') saveFile(event.shiftKey);
  if (key === 'o') openFile();
  if (key === 'enter') run();
});

showCase();
updateEditor();
updateButtons();
ide.onCloseRequested(async event => {
  event.preventDefault();
  if (closing) return;
  closing = true;
  updateButtons();
  try {
    if (!await confirmDiscard()) return;
    await stop();
    await currentRun?.catch(() => {});
    await ide.destroy();
  } finally { closing = false; updateButtons(); }
}).catch(error => message(String(error), true));

ide.rubyInfo().then((info) => {
  rubyAvailable = info.available;
  $('ruby-version').textContent = info.version;
  $('ruby-version').title = info.version;
  if (!info.available) message('Ruby を起動できません。インストール状態を確認してください。', true);
  updateButtons();
}).catch((error) => { $('ruby-version').textContent = 'Ruby を起動できません'; message(String(error), true); });
