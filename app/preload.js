// lets the label tool open saved files, list downloads and open the BoxUp print preview
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('boxupApp', {
  openFile: (p) => ipcRenderer.send('open-file', p),
  showInFolder: (p) => ipcRenderer.send('show-in-folder', p),
  dl: {
    list: () => ipcRenderer.invoke('dl-list'),
    on: (cb) => ipcRenderer.on('dl-event', (e, d) => cb(d)),
    open: (p) => ipcRenderer.invoke('dl-open', p),
    print: (p) => ipcRenderer.invoke('dl-print', p),
    folder: (p) => ipcRenderer.invoke('dl-folder', p),
    openFolder: () => ipcRenderer.invoke('dl-open-folder'),
    clear: () => ipcRenderer.invoke('dl-clear'),
    pickDir: () => ipcRenderer.invoke('dl-pick-dir')
  }
});
