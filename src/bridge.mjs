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
  listCollections: () => invoke('collection_list'),
  registerCollection: url => invoke('collection_register', { url }),
  fetchCollectionTask: (url, task) => invoke('collection_fetch_task', { url, task }),
  repairCollectionTask: (url, task) => invoke('collection_repair_task', { url, task }),
  openCollectionTask: (url, task) => invoke('collection_open_task', { url, task }),
  openProblem: url => invoke('problem_open', { url }),
  refreshProblem: url => invoke('problem_refresh', { url }),
  saveProblemCases: (url, cases) => {
    cases.forEach(item => validateTolerance(item.tolerance ?? null));
    return invoke('problem_save_cases', { url, cases });
  },
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
