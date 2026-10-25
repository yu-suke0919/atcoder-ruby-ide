const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { RubyRunner } = require('./ruby-runner.cjs');
const { DocumentStore } = require('./document-store.cjs');
const { compareOutput } = require('./compare-output.cjs');

let window;
let dirty = false;
let currentRun = null;
const rubyPath = app.isPackaged && process.platform === 'win32'
  ? path.join(process.resourcesPath, 'ruby', 'bin', 'ruby.exe')
  : process.env.RUBY_PATH || 'ruby';
const runner = new RubyRunner({ rubyPath });
const filters = [{ name: 'Ruby', extensions: ['rb'] }, { name: 'すべてのファイル', extensions: ['*'] }];
const documents = new DocumentStore({
  chooseOpen: async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Ruby ファイルを開く', properties: ['openFile'], filters });
    return result.canceled ? null : result.filePaths[0];
  },
  chooseSave: async (currentPath) => {
    const result = await dialog.showSaveDialog(window, { title: 'Ruby ファイルを保存', defaultPath: currentPath || 'solution.rb', filters });
    return result.canceled ? null : result.filePath;
  }
});

function updateTitle() {
  if (!window?.isDestroyed()) window.setTitle(`${dirty ? '● ' : ''}${documents.filePath ? path.basename(documents.filePath) : '無題.rb'} — AtCoder Ruby IDE`);
}

async function confirmDiscard() {
  if (!dirty) return true;
  const result = await dialog.showMessageBox(window, {
    type: 'question', title: '未保存の変更',
    message: '保存していない変更を破棄しますか？',
    buttons: ['破棄して続ける', 'キャンセル'], defaultId: 1, cancelId: 1, noLink: true
  });
  return result.response === 0;
}

function isOwnFrame(event) {
  return window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, payload) => {
    if (!isOwnFrame(event)) return { ok: false, error: 'この画面からは操作できません。' };
    try { return { ok: true, data: await callback(payload) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
}

handle('ruby:info', () => new Promise((resolve) => {
  execFile(rubyPath, ['--version'], { timeout: 3000, windowsHide: true }, (error, stdout) => {
    resolve({ available: !error, version: error ? 'Ruby が見つかりません' : stdout.trim() });
  });
}));
handle('ruby:run', async (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('実行内容を指定してください。');
  if (runner.busy) throw new Error('すでに実行中です。');
  const expected = payload.expectedOutput;
  if (expected !== null) {
    if (typeof expected !== 'string') throw new Error('期待出力は文字列で指定してください。');
    if (Buffer.byteLength(expected, 'utf8') > 1024 * 1024) throw new Error('期待出力は 1 MiB 以下にしてください。');
  }
  const pending = runner.run({ code: payload.code, stdin: payload.stdin, cwd: documents.filePath ? path.dirname(documents.filePath) : undefined });
  currentRun = pending;
  try {
    const result = await pending;
    return { ...result, comparison: expected !== null && result.status === 'completed' ? compareOutput(result.stdout, expected) : null };
  }
  finally { if (currentRun === pending) currentRun = null; }
});
handle('ruby:stop', () => runner.stop());
handle('document:open', async () => {
  if (!await confirmDiscard()) return { canceled: true };
  const result = await documents.open();
  if (!result.canceled) { dirty = false; updateTitle(); }
  return result;
});
handle('document:new', async () => {
  if (!await confirmDiscard()) return { canceled: true };
  documents.reset();
  dirty = false;
  updateTitle();
  return { canceled: false };
});
handle('document:save', async (payload) => {
  if (!payload || typeof payload.code !== 'string') throw new Error('保存するコードを指定してください。');
  const result = await documents.save(payload.code, { saveAs: payload.saveAs === true });
  // Renderer reports whether the current buffer still matches the saved snapshot.
  return result;
});
ipcMain.on('document:dirty', (event, value) => {
  if (isOwnFrame(event) && typeof value === 'boolean') { dirty = value; updateTitle(); }
});
runner.on('output', (output) => {
  if (window && !window.isDestroyed()) window.webContents.send('ruby:output', output);
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    width: 1280, height: 850, minWidth: 900, minHeight: 650,
    backgroundColor: '#11151d', title: 'AtCoder Ruby IDE',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  let closing = false;
  let closeAllowed = false;
  window.on('close', (event) => {
    if (closeAllowed) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    confirmDiscard().then(async (discard) => {
      if (discard) {
        runner.stop();
        await currentRun?.catch(() => {});
        closeAllowed = true;
        window.close();
      }
    }).finally(() => { closing = false; });
  });
  updateTitle();
  window.loadFile(path.join(__dirname, 'index.html'));
});
app.on('window-all-closed', () => app.quit());
