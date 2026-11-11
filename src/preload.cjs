const { contextBridge, ipcRenderer, webUtils } = require('electron');

const methods = [
  'init', 'savePreferences', 'answerPrompt', 'checkUpdate', 'openRelease',
  'saveHost', 'setHostGroup', 'deleteHost', 'pickKey', 'previewSshConfig', 'importSshConfig',
  'connect', 'connectFiles', 'disconnect', 'resize',
  'listRemote', 'mkdirRemote', 'renameRemote', 'removeRemote',
  'upload', 'uploadFolder', 'download', 'cancelTransfer', 'answerConflict', 'showInFolder',
  'knownHosts', 'forgetHostKey',
  'readClipboard', 'writeClipboard', 'editMenu',
  'agentState', 'agentTask', 'agentConfigure', 'agentTest', 'agentStart', 'agentFollowup',
  'agentResume', 'agentAnswer', 'agentExecutePlan', 'agentApprove', 'agentPause', 'agentRemove', 'agentRecover',
  'agentPickAttachments', 'agentAddAttachments', 'agentDropAttachment',
];

const api = Object.fromEntries(methods.map(name => [name, (...args) => ipcRenderer.invoke('termlo:' + name, ...args)]));
api.write = (id, data) => ipcRenderer.send('termlo:write', id, data);
api.pathForFile = file => webUtils.getPathForFile(file);
api.onEvent = callback => {
  const handler = (_event, message) => callback(message);
  ipcRenderer.on('termlo:event', handler);
  return () => ipcRenderer.removeListener('termlo:event', handler);
};

contextBridge.exposeInMainWorld('termlo', api);
