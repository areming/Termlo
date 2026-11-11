const { contextBridge, ipcRenderer, webUtils } = require('electron');

const methods = [
  'init', 'savePreferences', 'answerPrompt',
  'saveHost', 'deleteHost', 'pickKey', 'previewSshConfig', 'importSshConfig',
  'connect', 'connectFiles', 'disconnect', 'resize',
  'listRemote', 'mkdirRemote', 'renameRemote', 'removeRemote',
  'upload', 'uploadFolder', 'download', 'cancelTransfer', 'answerConflict', 'showInFolder',
  'knownHosts', 'forgetHostKey',
  'readClipboard', 'writeClipboard', 'editMenu',
  'agentState', 'agentTask', 'agentConfigure', 'agentTest', 'agentStart', 'agentFollowup',
  'agentResume', 'agentAnswer', 'agentExecutePlan', 'agentPause', 'agentRemove', 'agentRecover',
  'agentPickAttachments', 'agentDropAttachment',
];

const api = Object.fromEntries(methods.map(name => [name, (...args) => ipcRenderer.invoke('termus:' + name, ...args)]));
api.write = (id, data) => ipcRenderer.send('termus:write', id, data);
api.pathForFile = file => webUtils.getPathForFile(file);
api.onEvent = callback => {
  const handler = (_event, message) => callback(message);
  ipcRenderer.on('termus:event', handler);
  return () => ipcRenderer.removeListener('termus:event', handler);
};

contextBridge.exposeInMainWorld('termlo', api);
