const { invoke: nativeInvoke, Channel } = window.__TAURI__.core;
const invoke = (...args) => nativeInvoke(...args).catch(error => { throw new Error(String(error)); });
const appWindow = window.__TAURI__.window.getCurrentWindow();

export const ide = {
  openProblem: url => invoke('problem_open', { url }),
  refreshProblem: url => invoke('problem_refresh', { url }),
  saveProblemCases: (url, cases) => invoke('problem_save_cases', { url, cases }),
  rubyInfo: () => invoke('ruby_info'),
  run(code, stdin, expectedOutput = null, output = () => {}) {
    return new Promise((resolve, reject) => {
      if (expectedOutput !== null && typeof expectedOutput !== 'string') { reject(new Error('期待出力は文字列で指定してください。')); return; }
      const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
      const channel = new Channel();
      channel.onmessage = event => {
        if (event.type === 'output') {
          const text = decoders[event.stream].decode(new Uint8Array(event.bytes), { stream: true });
          if (text) output({ stream: event.stream, text });
        } else if (event.type === 'completed') resolve(event.result);
        else if (event.type === 'failed') reject(new Error(event.message));
      };
      invoke('run_ruby', { code, stdin, expectedOutput, onEvent: channel }).catch(error => reject(new Error(String(error))));
    });
  },
  stop: () => invoke('stop_ruby'),
  openFile: () => invoke('document_open'),
  saveFile: (code, saveAs) => invoke('document_save', { code, saveAs }),
  newFile: () => invoke('document_new'),
  openCases: () => invoke('samples_open'),
  saveCases: cases => invoke('samples_save', { cases }),
  confirmDiscard: () => invoke('confirm_discard'),
  setTitle: title => appWindow.setTitle(title),
  onCloseRequested: handler => appWindow.onCloseRequested(handler),
  destroy: () => appWindow.destroy()
};
