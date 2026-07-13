const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  jira: (opts) => ipcRenderer.invoke('jira:request', opts),
  jiraUpload: (opts) => ipcRenderer.invoke('jira:upload', opts),
  jiraDownload: (url) => ipcRenderer.invoke('jira:download', url),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
});
