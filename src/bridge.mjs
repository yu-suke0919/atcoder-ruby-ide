const { invoke: nativeInvoke, Channel } = window.__TAURI__.core;
const invoke = (...args) => nativeInvoke(...args).catch(error => { throw new Error(String(error)); });
const appWindow = window.__TAURI__.window.getCurrentWindow();

function validateTolerance(value) {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) throw new Error('許容誤差は0より大きい有限の数にしてください。');
}

export const ide = {
  lspStart: () => invoke('lsp_start'),
  lspComplete: (code, line, character) => invoke('lsp_complete', { code, line, character }),
  lspStop: () => invoke('lsp_stop'),
  listContests: () => invoke('contest_list'),
  submissionStates: contest => invoke('submission_states', { contest }),
  registerContest: url => invoke('contest_register', { url }),
  setContestHidden: (url, hidden) => invoke('contest_set_hidden', { url, hidden }),
  hideEndedContests: () => invoke('contest_hide_ended'),
  openTask: (url, label) => invoke('task_open', { url, label }),
  openFile: (workspace, name) => invoke('file_open', { workspace, name }),
  createFile: (workspace, label) => invoke('file_create', { workspace, label }),
  copyFile: (workspace, name, label) => invoke('file_copy', { workspace, name, label }),
  renameFile: (workspace, from, to) => invoke('file_rename', { workspace, from, to }),
  deleteFile: (workspace, name) => invoke('file_delete', { workspace, name }),
  openHome: () => invoke('home_open'),
  // Saves a workspace's samples: `home` or a task URL, with the problem's tolerance.
  saveSamples: (workspace, samples) => {
    validateTolerance(samples.tolerance ?? null);
    return invoke('samples_save', { workspace, samples });
  },
  browserLayout: (x, y, width, height) => invoke('browser_layout', { x, y, width, height }),
  browserVisible: visible => invoke('browser_visible', { visible }),
  browserHome: url => invoke('browser_home', { url }),
  browserTask: url => invoke('browser_task', { url }),
  browserCloseTasks: () => invoke('browser_close_tasks'),
  browserOpen: url => invoke('browser_open', { url }),
  browserHistory: forward => invoke('browser_history', { forward }),
  browserReload: () => invoke('browser_reload'),
  rurimaShow: query => invoke('rurima_show', { query }),
  rurimaLayout: (open, x, y, width, height) => invoke('rurima_layout', { open, x, y, width, height }),
  rurimaHistory: forward => invoke('rurima_history', { forward }),
  rurimaReload: () => invoke('rurima_reload'),
  // A picture of the shown AtCoder page as JPEG bytes; empty or null where it cannot be taken.
  browserSnapshot: () => invoke('browser_snapshot'),
  onRurimaUrl: handler => window.__TAURI__.event.listen('rurima-url', event => handler(event.payload)),
  onRurimaSearch: handler => window.__TAURI__.event.listen('rurima-search', event => handler(event.payload)),
  onBrowserUrl: handler => window.__TAURI__.event.listen('browser-url', event => handler(event.payload)),
  onTaskPage: handler => window.__TAURI__.event.listen('task-page', event => handler(event.payload)),
  onContestJoined: handler => window.__TAURI__.event.listen('contest-joined', event => handler(event.payload)),
  onSubmissions: handler => window.__TAURI__.event.listen('submissions', event => handler(event.payload)),
  onRuntimeDownload: handler => window.__TAURI__.event.listen('runtime-download', event => handler(event.payload)),
  rubyInfo: () => invoke('ruby_info'),
  run(code, stdin, expectedOutput = null, tolerance = null, problemTimeLimitMs = null, problemMemoryLimitMib = null, notify = () => {}) {
    return new Promise((resolve, reject) => {
      if (expectedOutput !== null && typeof expectedOutput !== 'string') { reject(new Error('期待出力は文字列で指定してください。')); return; }
      validateTolerance(tolerance);
      if (problemTimeLimitMs !== null && (!Number.isInteger(problemTimeLimitMs) || problemTimeLimitMs <= 0 || problemTimeLimitMs > 4294967295)) throw new Error('問題の時間制限は1〜4,294,967,295ミリ秒の整数にしてください。');
      if (problemMemoryLimitMib !== null && (!Number.isInteger(problemMemoryLimitMib) || problemMemoryLimitMib <= 0 || problemMemoryLimitMib > 4294967295)) throw new Error('問題のメモリ制限は1〜4,294,967,295 MiBの整数にしてください。');
      const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
      const channel = new Channel();
      channel.onmessage = event => {
        if (event.type === 'started') notify({ type: 'started', executionLimitMs: event.executionLimitMs });
        else if (event.type === 'output') {
          const text = decoders[event.stream].decode(new Uint8Array(event.bytes), { stream: true });
          if (text) notify({ type: 'output', stream: event.stream, text });
        } else if (event.type === 'completed') resolve(event.result);
        else if (event.type === 'failed') reject(new Error(event.message));
      };
      invoke('run_ruby', { code, stdin, expectedOutput, tolerance, problemTimeLimitMs, problemMemoryLimitMib, onEvent: channel }).catch(reject);
    });
  },
  stop: () => invoke('stop_ruby'),
  saveCode: (code, revision) => invoke('document_save', { code, revision }),
  resetSession: () => invoke('session_reset'),
  setTitle: title => appWindow.setTitle(title),
  // Flashes the taskbar button until the window comes to the front.
  requestAttention: () => appWindow.requestUserAttention(window.__TAURI__.window.UserAttentionType.Critical),
  onCloseRequested: handler => appWindow.onCloseRequested(handler),
  destroy: () => appWindow.destroy()
};
