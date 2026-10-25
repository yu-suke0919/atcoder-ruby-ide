const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, payload) {
  const result = await ipcRenderer.invoke(channel, payload);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

contextBridge.exposeInMainWorld('ide', {
  rubyInfo: () => invoke('ruby:info'),
  run: (code, stdin) => invoke('ruby:run', { code, stdin }),
  stop: () => invoke('ruby:stop'),
  openFile: () => invoke('document:open'),
  newFile: () => invoke('document:new'),
  saveFile: (code, saveAs) => invoke('document:save', { code, saveAs }),
  setDirty: (dirty) => ipcRenderer.send('document:dirty', dirty),
  onOutput: (callback) => {
    const listener = (_event, output) => callback(output);
    ipcRenderer.on('ruby:output', listener);
    return () => ipcRenderer.removeListener('ruby:output', listener);
  }
});
