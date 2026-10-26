const { contextBridge, ipcRenderer } = require('electron');
const methods = ['init', 'saveHost', 'deleteHost', 'pickKey', 'connectionPlan', 'connect', 'disconnect', 'resize', 'listRemote', 'mkdirRemote', 'pickLocal', 'listLocal', 'transfer', 'knownHosts', 'forgetHostKey', 'readClipboard', 'writeClipboard', 'editMenu', 'agentState', 'agentCheckHosts', 'agentTask', 'agentConfigure', 'agentTest', 'agentStart', 'agentDeployUserApi', 'agentResume', 'agentExecutePlan', 'agentPause', 'agentDelete', 'agentExport'];
const scope = ipcRenderer.invoke('termus:scope');
methods.push('spaceHosts','hostTransferPlan','copyHosts');
methods.push('agentAnswer');
methods.push('protectionState','protectionDismiss','protectionConfigure','protectionRefresh','protectionRestore','protectionRemove');
methods.push('agentRecoverFiles');
methods.push('agentApplyRecovery');
methods.push('agentDismissRecovery');
methods.push('protectionDisable');
const invoke = async (name, ...args) => ipcRenderer.invoke('termus:' + name, await scope, ...args);
const api = Object.fromEntries([...methods, 'managementState','workspaceRename','workspaceRemove','moveHosts','accountAuthenticate','accountVerify','accountLogout','accountReconnect','accountUpdate','accountPassword','accountSyncNow','accountSyncResolve','agentPickProject','agentFollowup', 'workspaceState', 'workspaceCreate', 'workspaceSwitch', 'agentManualOpen', 'hostMetrics', 'connectFiles', 'agentPickAttachments', 'agentDropAttachment', 'answerPrompt'].map(name => [name, (...args) => invoke(name, ...args)]));
api.write = async (id, data) => ipcRenderer.send('termus:write', await scope, id, data);
api.onEvent = callback => {
  const handler = async (_event, message) => { if (message.scopeToken === await scope) callback(message); };
  ipcRenderer.on('termus:event', handler);
  return () => ipcRenderer.removeListener('termus:event', handler);
};
contextBridge.exposeInMainWorld('termus', api);
