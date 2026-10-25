const $ = (id) => document.getElementById(id);
const editor = $('code-editor');
const input = $('stdin');
const sample = 'a = gets.to_i\nb, c = gets.split.map(&:to_i)\ns = gets.chomp\n\nputs "#{a + b + c} #{s}"\n';
editor.value = sample;
input.value = '1\n2 3\ntest\n';
let savedCode = sample;
let filePath = null;
let running = false;
let fileBusy = false;
let rubyAvailable = false;

function message(text, error = false) {
  $('message').textContent = text;
  $('message').dataset.error = String(error);
}

function updateEditor() {
  const dirty = editor.value !== savedCode;
  window.ide.setDirty(dirty);
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
  $('run').disabled = running || !rubyAvailable || fileBusy;
  $('stop').disabled = !running;
  $('clear-output').disabled = running;
  for (const id of ['new', 'open', 'save', 'save-as']) $(id).disabled = fileBusy;
  editor.readOnly = fileBusy;
}

async function fileAction(action) {
  if (fileBusy) return;
  fileBusy = true;
  updateButtons();
  try { await action(); }
  catch (error) { message(`ファイル操作に失敗しました：${error.message}`, true); }
  finally { fileBusy = false; updateButtons(); }
}

function openFile() {
  return fileAction(async () => {
    const result = await window.ide.openFile();
    if (result.canceled) return;
    editor.value = result.code;
    savedCode = editor.value;
    filePath = result.filePath;
    updateEditor();
    message('ファイルを開きました。');
  });
}

function saveFile(saveAs = false) {
  return fileAction(async () => {
    const code = editor.value;
    const result = await window.ide.saveFile(code, saveAs);
    if (result.canceled) return;
    savedCode = code;
    filePath = result.filePath;
    updateEditor();
    message('ファイルを保存しました。');
  });
}

async function run() {
  if (running || fileBusy || !rubyAvailable) return;
  running = true;
  updateButtons();
  $('stdout').textContent = '';
  $('stderr').textContent = '';
  $('run-status').textContent = '実行中…';
  $('run-duration').textContent = '— ms';
  message('Ruby を実行しています。');
  try {
    const result = await window.ide.run(editor.value, input.value);
    const statuses = {
      completed: '正常終了', failed: `エラー終了${result.exitCode === null ? '' : ` (${result.exitCode})`}`,
      stopped: '停止しました', timeout: '時間制限で停止（5 秒）', 'output-limit': '出力上限で停止（1 MiB）'
    };
    $('run-status').textContent = statuses[result.status];
    $('run-duration').textContent = `${result.durationMs} ms`;
    message(result.status === 'completed' ? '実行が完了しました。' : statuses[result.status], ['failed', 'timeout', 'output-limit'].includes(result.status));
  } catch (error) {
    $('run-status').textContent = '実行できませんでした';
    message(error.message, true);
  } finally { running = false; updateButtons(); }
}

window.ide.onOutput(({ stream, text }) => {
  const output = stream === 'stderr' ? $('stderr') : $('stdout');
  output.append(document.createTextNode(text));
  output.scrollTop = output.scrollHeight;
});
$('run').addEventListener('click', run);
$('stop').addEventListener('click', async () => {
  try { await window.ide.stop(); }
  catch (error) { message(error.message, true); }
});
$('open').addEventListener('click', openFile);
$('save').addEventListener('click', () => saveFile());
$('save-as').addEventListener('click', () => saveFile(true));
$('new').addEventListener('click', () => fileAction(async () => {
  const result = await window.ide.newFile();
  if (result.canceled) return;
  editor.value = '';
  savedCode = '';
  filePath = null;
  updateEditor();
  message('新しいファイルを作成しました。');
}));
$('clear-output').addEventListener('click', () => {
  $('stdout').textContent = '';
  $('stderr').textContent = '';
  $('run-status').textContent = '実行する準備ができています';
  $('run-duration').textContent = '— ms';
});
editor.addEventListener('input', updateEditor);
editor.addEventListener('click', updateCursor);
editor.addEventListener('keyup', updateCursor);
editor.addEventListener('scroll', () => { $('line-numbers').scrollTop = editor.scrollTop; });
editor.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && !editor.readOnly) {
    event.preventDefault();
    editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
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

updateEditor();
updateButtons();
window.ide.rubyInfo().then((info) => {
  rubyAvailable = info.available;
  $('ruby-version').textContent = info.version;
  $('ruby-version').title = info.version;
  if (!info.available) message('Ruby を起動できません。インストール状態を確認してください。', true);
  updateButtons();
}).catch((error) => message(error.message, true));
