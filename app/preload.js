// lets the "Saved" pop-up open the file or its folder
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('boxupApp', {
  openFile: (p) => ipcRenderer.send('open-file', p),
  showInFolder: (p) => ipcRenderer.send('show-in-folder', p)
});
