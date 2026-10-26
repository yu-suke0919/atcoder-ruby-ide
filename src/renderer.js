import { ide } from './bridge.js';
import { SampleCases, MAX_CASES } from './sample-cases.mjs';

const $ = (id) => document.getElementById(id);
const editor = $('code-editor');
const input = $('stdin');
const expectedOutput = $('expected-output');
const compareOutput = $('compare-output');
const differenceDialog = $('difference-dialog');
const sample = 'a = gets.to_i\nb, c = gets.split.map(&:to_i)\ns = gets.chomp\n\nputs "#{a + b + c} #{s}"\n';
editor.value = sample;
const cases = new SampleCases([{ stdin: '1\n2 3\ntest\n', expectedOutput: '6 test\n', compare: false }]);
let canceled = false;
const comparisonLabels = { none: '比較なし', pending: '未比較', running: '比較中…', matched: '一致', mismatched: '不一致', unavailable: '判定なし' };
const statusLabel = (status, exitCode) => ({ completed: '正常終了', failed: `エラー終了${exitCode == null ? '' : ` (${exitCode})`}`, stopped: '停止しました', timeout: '時間制限で停止（5 秒）', 'output-limit': '出力上限で停止（1 MiB）', running: '実行中…', canceled: '未実行（中止）', error: '実行できませんでした' })[status] || '実行する準備ができています';
let savedCode = sample;
let filePath = null;
let running = false;
let fileBusy = true;
let rubyAvailable = false;
let rubyChecking = false;
let currentRun = null;
let closing = false;
let scrollFrame = null;

async function confirmDiscard(includeCases = false) {
  return (editor.value === savedCode && (!includeCases || !cases.dirty)) || await ide.confirmDiscard();
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
  $('difference-position').textContent = `最初の不一致：${detail.line} 行 ${detail.column} 列`;
  showDifferenceLine($('difference-expected'), detail.expectedLine, detail.column);
  showDifferenceLine($('difference-actual'), detail.actualLine, detail.column);
  differenceDialog.showModal();
}
$('comparison-status').addEventListener('click', openDifference);
$('difference-close').addEventListener('click', () => differenceDialog.close());

function updateCaseList() {
  $('case-select').replaceChildren(...cases.items.map((item, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `ケース ${index + 1} · ${item.status === 'running' ? '実行中' : item.status && item.status !== 'completed' ? statusLabel(item.status, item.exitCode) : comparisonLabels[item.comparison]}`;
    return option;
  }));
  $('case-select').value = String(cases.selected);
  $('case-count').textContent = `${cases.items.length} ケース${cases.dirty ? ' · 未保存' : ''}`;
  const done = cases.items.filter(item => item.status && !['running', 'canceled'].includes(item.status)).length;
  const count = state => cases.items.filter(item => item.comparison === state).length;
  const errors = cases.items.filter(item => ['failed', 'timeout', 'output-limit', 'error'].includes(item.status)).length;
  $('cases-summary').textContent = `完了 ${done} / ${cases.items.length} · 一致 ${count('matched')} · 不一致 ${count('mismatched')} · エラー ${errors}`;
}

function showResult() {
  const item = cases.current;
  for (const stream of ['stdout', 'stderr']) $(stream).textContent = item[stream];
  $('run-status').textContent = statusLabel(item.status, item.exitCode);
  $('run-duration').textContent = item.durationMs === null ? '— ms' : `${item.durationMs} ms`;
  showComparison(item.comparison);
  updateCaseList();
}

function showCase() {
  differenceDialog.close();
  const item = cases.current;
  input.value = item.stdin;
  expectedOutput.value = item.expectedOutput;
  compareOutput.checked = item.compare;
  expectedOutput.disabled = !item.compare;
  showResult();
  updateButtons();
}

function resetComparison(all = false) {
  cases.invalidate(all);
  expectedOutput.disabled = !cases.current.compare;
  showComparison(cases.current.comparison);
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
  $('ruby-recheck').disabled = rubyChecking || running || fileBusy || closing;
  for (const id of ['run', 'run-all']) $(id).disabled = running || !rubyAvailable || fileBusy || closing;
  $('case-add').disabled = running || fileBusy || closing || cases.items.length >= MAX_CASES;
  $('case-remove').disabled = running || fileBusy || closing || cases.items.length === 1;
  $('case-select').disabled = fileBusy || closing;
  $('stop').disabled = !running;
  $('clear-output').disabled = running || fileBusy || closing;
  for (const id of ['new', 'open', 'save-as']) $(id).disabled = running || fileBusy || closing;
  $('save').disabled = fileBusy || closing || (running && !filePath);
  editor.readOnly = fileBusy || closing;
  input.readOnly = expectedOutput.readOnly = fileBusy || closing;
  compareOutput.disabled = fileBusy || closing;
  for (const id of ['cases-open', 'cases-save']) $(id).disabled = running || fileBusy || closing;
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
  cases.clear(all);
  const queue = cases.snapshot(all);
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
        const result = await ide.run(code, snapshot.stdin, snapshot.compare ? snapshot.expectedOutput : null, ({ stream, text }) => {
          item[stream] += text;
          if (item === cases.current) appendOutput(stream, text);
        });
        cases.finish(snapshot, result);
        message(result.status === 'completed' ? '実行が完了しました。' : statusLabel(result.status, result.exitCode), ['failed', 'timeout', 'output-limit'].includes(result.status));
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
});
$('case-remove').addEventListener('click', () => {
  cases.remove();
  showCase();
});
$('cases-open').addEventListener('click', () => fileAction(async () => {
  if (running || (cases.dirty && !await ide.confirmDiscard())) return;
  const result = await ide.openCases();
  if (result.canceled) return;
  cases.replace(result.cases, { saved: true });
  showCase();
  message('サンプルを読み込みました。');
}));
$('cases-save').addEventListener('click', () => fileAction(async () => {
  if (running) return;
  const data = cases.data();
  const result = await ide.saveCases(data);
  if (result.canceled) return;
  cases.markSaved(data);
  updateCaseList();
  message('サンプルを保存しました。');
}));
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
  cases.clear();
  showResult();
});
function editCase(field, value) {
  cases.current[field] = value;
  resetComparison();
}
input.addEventListener('input', () => editCase('stdin', input.value));
expectedOutput.addEventListener('input', () => editCase('expectedOutput', expectedOutput.value));
compareOutput.addEventListener('change', () => editCase('compare', compareOutput.checked));
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
  if (differenceDialog.open) return;
  if (key === 's') saveFile(event.shiftKey);
  if (key === 'o') openFile();
  if (key === 'enter') run();
});

window.addEventListener('beforeunload', event => {
  if (closing || (!fileBusy && !running && editor.value === savedCode && !cases.dirty)) return;
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
    if (!await confirmDiscard(true)) return;
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
    rubyAvailable = info.available;
    $('ruby-version').textContent = info.version;
    $('ruby-version').title = info.version;
    message(info.available ? 'Ruby を確認しました。' : 'Ruby を起動できません。インストール状態を確認して再確認してください。', !info.available);
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
    await ide.newFile();
    fileBusy = false;
    updateButtons();
    await checkRuby();
  } catch (error) {
    $('ruby-version').textContent = '初期化できません';
    message(`初期化に失敗しました：${error.message}`, true);
  }
}
initialize();
