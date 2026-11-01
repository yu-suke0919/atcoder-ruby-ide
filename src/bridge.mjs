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
  registerContest: url => invoke('contest_register', { url }),
  setContestHidden: (url, hidden) => invoke('contest_set_hidden', { url, hidden }),
  openTask: url => invoke('task_open', { url }),
  saveTaskCases: (url, cases) => {
    cases.forEach(item => validateTolerance(item.tolerance ?? null));
    return invoke('task_save_cases', { url, cases });
  },
  browserLayout: (x, y, width, height) => invoke('browser_layout', { x, y, width, height }),
  browserVisible: visible => invoke('browser_visible', { visible }),
  browserHome: url => invoke('browser_home', { url }),
  browserTask: url => invoke('browser_task', { url }),
  browserCloseTasks: () => invoke('browser_close_tasks'),
  browserOpen: url => invoke('browser_open', { url }),
  browserHistory: forward => invoke('browser_history', { forward }),
  browserReload: () => invoke('browser_reload'),
  onBrowserUrl: handler => window.__TAURI__.event.listen('browser-url', event => handler(event.payload)),
  onTaskPage: handler => window.__TAURI__.event.listen('task-page', event => handler(event.payload)),
  rubyInfo: () => invoke('ruby_info'),
  run(code, stdin, expectedOutput = null, tolerance = null, problemTimeLimitMs = null, notify = () => {}) {
    return new Promise((resolve, reject) => {
      if (expectedOutput !== null && typeof expectedOutput !== 'string') { reject(new Error('期待出力は文字列で指定してください。')); return; }
      validateTolerance(tolerance);
      if (problemTimeLimitMs !== null && (!Number.isInteger(problemTimeLimitMs) || problemTimeLimitMs <= 0 || problemTimeLimitMs > 4294967295)) throw new Error('問題の時間制限は1〜4,294,967,295ミリ秒の整数にしてください。');
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
      invoke('run_ruby', { code, stdin, expectedOutput, tolerance, problemTimeLimitMs, onEvent: channel }).catch(reject);
    });
  },
  stop: () => invoke('stop_ruby'),
  saveCode: code => invoke('document_save', { code }),
  resetSession: () => invoke('session_reset'),
  setTitle: title => appWindow.setTitle(title),
  onCloseRequested: handler => appWindow.onCloseRequested(handler),
  destroy: () => appWindow.destroy()
};
