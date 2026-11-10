// the BoxUp print preview window: reads the PDF, lists printers, prints
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bxPrint', {
  info: () => ipcRenderer.invoke('pp-info'),
  printers: () => ipcRenderer.invoke('pp-printers'),
  print: (o) => ipcRenderer.invoke('pp-print', o),
  remember: (o) => ipcRenderer.invoke('pp-remember', o),
  openPdf: () => ipcRenderer.invoke('pp-open-pdf'),
  close: () => ipcRenderer.invoke('pp-close')
});
