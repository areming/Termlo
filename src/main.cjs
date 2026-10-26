const { app, BrowserWindow, ipcMain, dialog, safeStorage, clipboard, Menu, session: electronSession } = require('electron');
const { validateText } = require('./clipboard.cjs');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { Store } = require('./store.cjs');
const { SSHSession } = require('./ssh.cjs');
const { AgentService } = require('./agent.cjs');
const { Workspaces } = require('./workspaces.cjs');
const { AccountClient } = require('./account-client.cjs');
const { DeploymentProtection } = require('./deployment-protection.cjs');
const { randomUUID } = require('node:crypto');
const { ManualControl } = require('./manual-control.cjs');
app.setName('Termlo');
const manual = new ManualControl();
const { HostMonitor } = require('./host-monitor.cjs');
const { PromptBroker } = require('./prompt-broker.cjs');
const prompts = new PromptBroker(send);
let scopeToken = randomUUID(), switching = false, workspaces, accounts;
const initialScopeToken = scopeToken;
let monitor = new HostMonitor({notify: message => send({ ...message, scopeToken: initialScopeToken })});
const pendingActions = new Set();
const osProbes=new Map();
const syncTimers=new Map();
const syncMutations=new Set(['saveHost','deleteHost','moveHosts','copyHosts','workspaceCreate','workspaceRename','workspaceRemove','agentConfigure']);
function syncAccountFor(name,args){if(['workspaceRename','workspaceRemove'].includes(name))return args[1];if(name==='workspaceCreate')return args[0]==='space'?(args[2]||workspaces?.current().account.id):null;return workspaces?.current().account.id;}
function queueAccountSync(accountId){
  if(!accounts||!accountId)return;let account;try{account=workspaces.find(accountId).account;}catch{return;}if(!account.identity)return;
  accounts.markSyncDirty(accountId);const previous=syncTimers.get(accountId);if(previous)clearTimeout(previous);
  const timer=setTimeout(async()=>{syncTimers.delete(accountId);try{const status=await accounts.syncNow(accountId);send({type:'account-sync',accountId,sync:status});}catch(error){accounts.saveSyncState(accountId,{...(accounts.syncEntries[accountId]||{}),status:'error',message:error.message},null);send({type:'account-sync',accountId,sync:accounts.syncStatus(accountId)});}},800);syncTimers.set(accountId,timer);
}
async function finishAccountLogin(accountId,password){
  const current=workspaces.current().account.id===accountId;
  if(current&&(agent.active||connections.size)){accounts.saveSyncState(accountId,{...(accounts.syncEntries[accountId]||{}),status:'pending',message:'当前有任务或连接；同步会在你关闭它们并重新登录后加载。'},null);return accounts.syncStatus(accountId);}
  const result=await accounts.syncOnLogin(accountId,password);
  if(current&&result.status==='synced'){
    refreshCurrentContextFromSync(accountId);
  }
  return result;
}
function refreshCurrentContextFromSync(accountId){
  if(workspaces.current().account.id!==accountId||agent.active||connections.size)return false;
  const target=workspaces.current(),hostFile=path.join(target.directory,'hosts.json');
  if(store.file!==hostFile){agent.close();monitor.close();const context=createContext(target,scopeToken);store=context.store;agent=context.agent;monitor=new HostMonitor({notify:message=>send({...message,scopeToken})});setTimeout(()=>{if(window&&!window.isDestroyed())window.webContents.reload();},80);return true;}
  store.data=new Store(target.directory,safeStorage).data;const settingsFile=path.join(target.settingsDirectory,'settings.json');agent.store.settings=fs.existsSync(settingsFile)?JSON.parse(fs.readFileSync(settingsFile,'utf8')):{baseUrl:'',model:'',maxRounds:80};agent.hostLedger.syncTasks(agent.store.tasks,store.list());send({type:'hosts',hosts:store.list()});send({type:'agent'});return true;
}
SSHSession.observe = (hostId, ssh) => {
  monitor.attach(hostId, ssh);
  const source=store,protection=agent?.protection,token=scopeToken,{identityKey,probeInventory}=require('./host-os.cjs');let key;
  try{key=identityKey(source.get(hostId));}catch{return;}
  protection?.reconnect(hostId);
  ssh.discoveryReady=require('./cloud-detect.cjs').detectCloud(ssh).then(cloud=>{if(cloud&&token===scopeToken&&source===store&&source.cacheCloud(hostId,cloud,key)){send({type:'host-cloud',hostId,cloudIdentity:cloud,scopeToken:token});queueAccountSync(workspaces.current().account.id);}}).catch(()=>{});
  const probeKey=source.file+hostId+key;if(Date.now()-(osProbes.get(probeKey)||0)<30000)return;osProbes.set(probeKey,Date.now());
  probeInventory(ssh).then(info=>{if(info&&token===scopeToken&&source===store&&source.cacheInventory(hostId,info,key)){const host=source.get(hostId);send({type:'host-os',hostId,operatingSystem:host.operatingSystem,specifications:host.specifications,scopeToken:token});queueAccountSync(workspaces.current().account.id);}}).catch(()=>{});
};
const root = path.join(__dirname, '..');
const dataPath = process.env.TERMUS_DATA_DIR || (app.isPackaged ? path.join(app.getPath('appData'), 'Termus') : path.join(root, 'data'));
app.setPath('userData', dataPath);
let window, store, agent, localRoot = os.homedir();
const connections = new Map();
const indexUrl = pathToFileURL(path.join(root, 'dist/index.html')).href;
function trusted(event) { return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === indexUrl; }
function send(message) { if (window && !window.isDestroyed()) window.webContents.send('termus:event', { scopeToken, ...message }); }
function handler(name, action) {
  ipcMain.handle('termus:' + name, async (event, token, ...args) => {
    if (!trusted(event)) throw new Error('拒绝未授权请求');
    if (token !== scopeToken) throw new Error('工作空间已切换，请刷新后重试');
    if (workspaces?.moveBlocked) throw new Error('主机移动写入未完成，请重启应用以恢复数据');
    if (switching && name !== 'answerPrompt') throw new Error('正在切换工作空间');
    if(agent?.protection.busy&&['saveHost','deleteHost','moveHosts','copyHosts','workspaceRemove','agentStart','agentDeployUserApi','agentResume','agentExecutePlan','agentManualOpen','connect','connectFiles'].includes(name))throw new Error('部署保护操作进行中，请等待完成');
    const marker = {}; if (name !== 'answerPrompt') pendingActions.add(marker);
    let result,success=false;try { result=await action(...args);success=true;return result; } finally { pendingActions.delete(marker);if(success&&syncMutations.has(name))queueAccountSync(syncAccountFor(name,args)); }
  });
}
function getSession(id) { const connection = connections.get(id); if (!connection) throw new Error('连接已关闭'); return connection; }
function resolveLocal(directory) {
  const resolved = fs.realpathSync(directory);
  const relative = path.relative(localRoot, resolved);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('请通过“选择文件夹”访问其他目录');
  return resolved;
}
async function listLocal(directory = localRoot) {
  const resolved = resolveLocal(directory);
  const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
  const files = (await Promise.all(entries.map(async entry => {
    if (entry.isSymbolicLink()) return null;
    try {
      const absolute = path.join(resolved, entry.name), stat = await fs.promises.stat(absolute);
      return { name: entry.name, path: absolute, directory: stat.isDirectory(), size: stat.size, modified: stat.mtimeMs };
    } catch { return null; }
  }))).filter(Boolean).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  return { path: resolved, root: localRoot, parent: resolved === localRoot ? null : path.dirname(resolved), files };
}
function installHandlers() {
  handler('protectionState',()=>agent.protection.public());
  handler('protectionDismiss',id=>agent.protection.dismiss(id));
  handler('protectionDisable',id=>{if(agent.active)throw new Error('请先暂停助手');return agent.protection.disable(id);});
  handler('protectionConfigure',(id,input)=>{if(agent.active)throw new Error('请先暂停助手再配置保护');return agent.protection.configure(id,input);});
  handler('protectionRefresh',id=>agent.protection.refresh(id));
  handler('protectionRestore',async(id,input)=>{if(agent.active||connections.size||manual.sessions.size)throw new Error('恢复前请暂停助手，并关闭当前空间的终端和文件连接');try{return await agent.protection.restore(id,input);}finally{const task=agent.store.tasks.find(t=>t.id===agent.protection.group(id).taskId);if(task&&['restored_pending_check','unknown'].includes(agent.protection.group(id).status)){task.status='paused';task.notice=agent.protection.group(id).notice;agent.event(task,'notice',task.notice);}}});
  handler('protectionRemove',(id,confirmed)=>{if(agent.active)throw new Error('请先暂停助手');return agent.protection.remove(id,confirmed);});
  handler('agentRecoverFiles',input=>{if(connections.size||manual.sessions.size)throw new Error('撤销前请关闭当前空间的终端和文件连接');return agent.protection.locked(()=>agent.recoverFiles(input));});
  handler('agentApplyRecovery',input=>{if(connections.size||manual.sessions.size)throw new Error('撤销前请关闭当前空间的终端和文件连接');return agent.protection.locked(()=>agent.applyRecovery(input));});
  handler('agentDismissRecovery',input=>agent.dismissRecovery(input));
  ipcMain.handle('termus:scope', event => { if (!trusted(event)) throw new Error('拒绝未授权请求'); return scopeToken; });
  handler('workspaceState', () => workspaces.public());
  handler('managementState',()=>({...workspaces.public(),accounts:workspaces.public().accounts.map(a=>({...a,login:accounts.status(a.id)}))}));
  handler('workspaceRename',(kind,accountId,spaceId,name)=>{workspaces.rename(kind,accountId,spaceId,name);return workspaces.public();});
  handler('workspaceRemove',async(kind,accountId,spaceId)=>{if(accounts.status(accountId).signedIn&&kind==='account')throw new Error('请先退出登录');workspaces.remove(kind,accountId,spaceId);if(kind==='account')accounts.forget(accountId);return workspaces.public();});
  handler('accountAuthenticate',async input=>{const result=await accounts.authenticate(input);await finishAccountLogin(result.accountId,input.password);return result;});
  handler('accountVerify',id=>accounts.verify(id));
  handler('accountLogout',id=>accounts.logout(id));
  handler('accountReconnect',async(id,input)=>{const result=await accounts.reconnect(id,input);await finishAccountLogin(result.accountId,input.password);return result;});
  handler('accountUpdate',(id,input)=>accounts.update(id,input));
  handler('accountPassword',(id,input)=>accounts.password(id,input));
  handler('accountSyncNow',async id=>{const previous=accounts.syncEntries[id]?.revision||0,result=await accounts.syncNow(id);if(result.status==='synced'&&result.revision!==previous)refreshCurrentContextFromSync(id);return result;});
  handler('accountSyncResolve',async(id,choice)=>{const result=await accounts.resolveSyncConflict(id,choice);refreshCurrentContextFromSync(id);return result;});
  handler('moveHosts',(destinationId,ids)=>{
    agent.protection.assertTransfer(ids);
    if(pendingActions.size>1||agent.active||connections.size)throw new Error('移动前请暂停助手，并关闭当前空间的终端和文件连接');
    const hosts=workspaces.moveHosts(store,destinationId,ids);send({type:'hosts',hosts});return hosts;
  });
  handler('workspaceCreate', (kind, name, accountId) => { workspaces.create(kind, name, accountId); return workspaces.public(); });
  handler('hostTransferPlan',(id,mode)=>workspaces.transferPlan(store,id,mode));
  handler('spaceHosts',id=>workspaces.spaceHosts(store,id));
  handler('copyHosts',(destinationId,ids)=>workspaces.copyHosts(store,destinationId,ids));
  handler('workspaceSwitch', async (accountId, spaceId) => {
    if(agent.protection.busy)throw new Error('保护操作进行中，请等待完成再切换空间');
    const target = workspaces.find(accountId, spaceId);
    if (target.key === workspaces.current().key) return false;
    if (pendingActions.size > 1 || prompts.pending.size) throw new Error('请等待当前连接、传输或对话框结束后再切换');
    switching = true;
    try {
      if (agent.active || connections.size) {
        const { response } = await prompts.ask({ type: 'question', message: `切换到“${target.account.name} / ${target.space.name}”？`, detail: `将暂停当前助手任务并关闭 ${connections.size} 个终端或文件连接。任务记录会保存；远端派生进程可能继续，恢复时需要核实。`, buttons: ['取消', '暂停并切换'], cancelId: 0, defaultId: 0 });
        if (response !== 1) return false;
      }
      if (agent.active) await agent.pause(agent.active.task.id);
      agent.attachments.clearDrafts();
      for (const [id, ssh] of connections) { ssh.close(); manual.release(id); }
      connections.clear();
      const nextToken = randomUUID(), next = createContext(target, nextToken);
      workspaces.select(accountId, spaceId);
      agent.close(); monitor.close(); prompts.cancelAll();
      store = next.store; agent = next.agent; scopeToken = nextToken;
      monitor = new HostMonitor({ notify: message => send({ ...message, scopeToken: nextToken }) });
      localRoot = fs.realpathSync(os.homedir());
      setTimeout(() => { if (window && !window.isDestroyed()) window.webContents.reload(); }, 50);
      return true;
    } finally { switching = false; }
  });
  handler('hostMetrics', () => monitor.snapshot());
  handler('answerPrompt', (id, response) => prompts.answer(id, response));
  handler('agentState', () => agent.state());
  handler('agentCheckHosts', async input => { manual.assertFree();return agent.checkHosts(input); });
  handler('agentTask', id => { const { messages, ...task } = agent.store.get(id); return task; });
  handler('agentConfigure', input => agent.configure(input));
  handler('agentTest', () => agent.test());
  let pickingAttachments=false;
  handler('agentPickProject',async()=>{
    if(pickingAttachments)throw new Error('正在选择附件');pickingAttachments=true;
    try{const result=await dialog.showOpenDialog(window,{title:'添加项目 ZIP · 目录与部署说明会提供给模型',properties:['openFile'],filters:[{name:'Project ZIP',extensions:['zip']}]});return result.canceled?[]:await agent.attachments.importFiles(result.filePaths,{project:true});}finally{pickingAttachments=false;}
  });
  handler('agentPickAttachments', async () => {
    if(pickingAttachments)throw new Error('正在选择附件');
    pickingAttachments=true;
    try{
      const result=await dialog.showOpenDialog(window,{title:'添加任务附件 · 单个最多 25 MB',properties:['openFile','multiSelections']});
      return result.canceled?[]:await agent.attachments.importFiles(result.filePaths);
    }finally{pickingAttachments=false;}
  });
  handler('agentDropAttachment', id => agent.attachments.drop(id));
  handler('agentDeployUserApi', async ({hostId,credentials={}}={}) => {
    manual.assertFree();agent.hosts.get(hostId);
    const archive=path.join(root,'dist','termlo-user-api.zip');
    if(!fs.existsSync(archive))throw new Error('内置账户服务包缺失，请重新安装 Termlo');
    const task=await agent.deployUserApi({hostId,credentials,archive:fs.readFileSync(archive)});return {id:task.id};
  });
  handler('agentStart', async input => { manual.assertFree(); const task = await agent.start(input); return { id: task.id }; });
  handler('agentResume', async input => { manual.assertFree(); const task = await agent.resume(input); return { id: task.id }; });
  handler('agentAnswer', async input => { manual.assertFree(); const task = await agent.answer(input); return { id: task.id }; });
  handler('agentFollowup', input => agent.followup(input));
  handler('agentExecutePlan', async input => { manual.assertFree(); const task = await agent.executePlan(input); return {id:task.id}; });
  handler('agentManualOpen', async (id, taskId, hostId, credentials, size) => {
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id) || connections.has(id)) throw new Error('连接标识无效');
    const task = agent.store.get(taskId);
    manual.reserve(id, task, hostId);
    try {
      if (agent.active) await agent.pause(agent.active.task.id);
      if (!manual.sessions.has(id)) throw new Error('手动连接已取消');
      agent.event(task, 'notice', '已打开手动终端。关闭后再继续助手，恢复时将重新检查现场。');
      await connectTerminal(id, hostId, credentials, size);
      return true;
    } catch (error) { manual.release(id); throw error; }
  });
  handler('agentPause', async id => { await agent.pause(id); return agent.state(); });
  handler('agentDelete', id => { if (agent.active?.task.id === id) throw new Error('请先暂停任务');const task=agent.store.get(id);if(task.fileChanges?.some(r=>r.state!=='cleaned')||task.stagingChanges?.some(r=>r.state!=='cleaned'))throw new Error('请先清理此任务的恢复材料，再删除任务');agent.store.remove(id); agent.attachments.removeTask(id); return agent.state(); });
  handler('agentExport', async id => {
    const { messages, ...task } = agent.store.get(id);
    const result = await dialog.showSaveDialog(window, { title: '导出任务记录', defaultPath: 'Termlo-task-' + id.slice(0,8) + '.json', filters: [{name:'JSON 任务报告',extensions:['json']}] });
    if (!result.canceled) await fs.promises.writeFile(result.filePath, JSON.stringify(task,null,2));
    return !result.canceled;
  });
  handler('readClipboard', async () => validateText(await clipboard.readText()));
  handler('writeClipboard', async text => { await clipboard.writeText(validateText(text)); });
  handler('editMenu', readOnly => {
    Menu.buildFromTemplate([
      { role: 'undo', label: '撤销', enabled: !readOnly }, { role: 'redo', label: '重做', enabled: !readOnly },
      { type: 'separator' }, { role: 'cut', label: '剪切', enabled: !readOnly },
      { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴', enabled: !readOnly },
      { type: 'separator' }, { role: 'selectAll', label: '全选' },
    ]).popup({ window });
  });
  handler('init', () => ({ hosts: store.list(), localRoot, version: app.getVersion(), encrypted: safeStorage.isEncryptionAvailable(), workspace: workspaces.public() }));
  handler('saveHost', input => {
    if(input.id&&input.spaceId&&input.spaceId!==workspaces.current().space.id)agent.protection.assertTransfer([input.id]);
    if(input.id&&input.spaceId&&input.spaceId!==workspaces.current().space.id&&(pendingActions.size>1||agent.active||connections.size))throw new Error('移动前请暂停助手，并关闭当前空间的终端和文件连接');
    const hosts=workspaces.saveHost(store,input,input.spaceId);send({type:'hosts',hosts});return hosts;
  });
  handler('connectionPlan', id => store.route(id));
  handler('deleteHost', async id => {
    const host = store.get(id);
    const { response } = await prompts.ask({ type: 'question', message: `删除主机“${host.name}”？`, detail: '已有连接会保留。', buttons: ['取消', '删除'], defaultId: 0, cancelId: 0 });
    if (response === 1) store.remove(id);
    return store.list();
  });
  handler('pickKey', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择 SSH 私钥', properties: ['openFile'] });
    return result.canceled ? null : result.filePaths[0];
  });
  async function connectTerminal(id, hostId, credentials = {}, size = {}, kind = 'terminal') {
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id) || connections.has(id)) throw new Error('连接标识无效');
    if (connections.size >= 20) throw new Error('最多同时打开 20 个连接');
    const route = store.route(hostId);
    const ssh = new SSHSession(), connectionToken = scopeToken;
    ssh.kind = kind;
    connections.set(id, ssh);
    ssh.on('data', data => send({ id, type: 'data', data, scopeToken: connectionToken }));
    ssh.on('fault', message => send({ id, type: 'fault', message, scopeToken: connectionToken }));
    ssh.on('stage', message => send({ id, type: 'stage', message, scopeToken: connectionToken }));
    ssh.on('status', status => { send({ id, type: 'status', status, scopeToken: connectionToken }); if (status === 'closed') { connections.delete(id); manual.release(id); } });
    try {
      const auth = Object.fromEntries(route.map(host => {
        const input = credentials[host.id] || {};
        return [host.id, host.auth === 'key' ? { passphrase: String(input.passphrase || '') } : { password: input.password ?? store.password(host.id) }];
      }));
      await ssh.connectRoute(route, auth, async (host, fingerprint) => {
        const previous = store.known(host);
        if (previous === fingerprint) return true;
        if (previous) {
          await prompts.ask({ type: 'error', message: '服务器指纹发生变化，连接已拒绝', detail: `${host.name} · ${host.address}:${host.port}\n\n原指纹：${previous}\n当前指纹：${fingerprint}\n\n确认服务器更换密钥后，可在“已知主机”中删除旧记录，再重新连接。` });
          return false;
        }
        const { response } = await prompts.ask({ type: 'question', message: '首次连接：确认服务器身份', detail: `${host.name} · ${host.address}:${host.port}\n\n${fingerprint}\n\n请与服务器管理员提供的指纹核对。`, buttons: ['取消', '信任并连接'], defaultId: 0, cancelId: 0 });
        if (response !== 1 || ssh.closed) return false;
        const current = store.known(host);
        if (current && current !== fingerprint) return false;
        store.trust(host, fingerprint);
        return true;
      });
      if (ssh.closed) throw new Error('连接已取消');
      if(kind==='sftp'){
        const channel=await ssh.sftp();
        channel.on('error',error=>ssh.emit('fault',error.message));
        channel.on('close',()=>ssh.close());
        if(ssh.closed)throw new Error('文件连接已取消');
        ssh.emit('status','ready');return true;
      }
      const cols = Number.isInteger(size.cols) ? Math.max(2, Math.min(size.cols, 500)) : 100;
      const rows = Number.isInteger(size.rows) ? Math.max(2, Math.min(size.rows, 500)) : 30;
      await ssh.shell(cols, rows);
      return true;
    } catch (error) { ssh.close(); connections.delete(id); throw error; }
  }
  handler('connect', (id,hostId,credentials,size)=>connectTerminal(id,hostId,credentials,size));
  handler('connectFiles', (id,hostId,credentials)=>connectTerminal(id,hostId,credentials,{},'sftp'));
  handler('disconnect', id => { connections.get(id)?.close(); connections.delete(id); manual.release(id); });
  handler('resize', (id, cols, rows) => getSession(id).resize(cols, rows));
  ipcMain.on('termus:write', (event, token, id, data) => {
    if (!trusted(event) || token !== scopeToken || switching) return;
    try { getSession(id).write(data); } catch (error) { send({ id, type: 'fault', message: error.message }); }
  });
  handler('listRemote', (id, directory) => getSession(id).list(directory));
  handler('mkdirRemote', (id, directory) => getSession(id).mkdir(directory));
  handler('listLocal', directory => listLocal(directory));
  handler('pickLocal', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择本地文件夹', properties: ['openDirectory'] });
    if (result.canceled) return null;
    localRoot = fs.realpathSync(result.filePaths[0]);
    return listLocal();
  });
  handler('transfer', async (id, direction, remote, selectedLocal) => {
    const ssh = getSession(id);
    let local;
    if (direction === 'upload') {
      if (selectedLocal) { local = resolveLocal(selectedLocal); }
      else {
        const result = await dialog.showOpenDialog(window, { title: '上传文件', properties: ['openFile'] });
        if (result.canceled) return { canceled: true };
        local = result.filePaths[0];
      }
      remote = path.posix.join(remote, path.basename(local));
    } else if (direction === 'download') {
      const filename = path.posix.basename(remote).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      const result = await dialog.showSaveDialog(window, { title: '保存下载文件', defaultPath: path.join(localRoot, filename), properties: ['showOverwriteConfirmation'] });
      if (result.canceled) return { canceled: true };
      local = result.filePath;
    } else throw new Error('传输方向无效');
    await ssh.transfer(direction, local, remote, progress => send({ id, type: 'transfer', direction, name: path.basename(local), ...progress }));
    return { canceled: false, name: path.basename(local) };
  });
  handler('knownHosts', () => Object.entries(store.data.knownHosts).map(([key, fingerprint]) => { const [address, port] = JSON.parse(key); return { key, address, port, fingerprint }; }));
  handler('forgetHostKey', async key => {
    const { response } = await prompts.ask({ type: 'warning', message: '移除服务器指纹记录？', detail: '下次连接需要重新确认服务器身份。', buttons: ['取消', '移除'], defaultId: 0, cancelId: 0 });
    if (response === 1) store.forget(key);
  });
}
function createContext(target, token) {
  const nextStore = new Store(target.directory, safeStorage);
  const protection=new DeploymentProtection({directory:target.directory,hosts:nextStore,vault:safeStorage,notify:message=>send({...message,scopeToken:token})});
  const nextAgent = new AgentService({ protection, directory: target.directory, settingsDirectory: target.settingsDirectory, vault: safeStorage, hosts: nextStore, notify: message => send({ ...message, scopeToken: token }), verify: async (host, fingerprint) => {
    if (token !== scopeToken) throw new Error('空间已切换');
    const previous = nextStore.known(host);
    if (previous === fingerprint) return true;
    if (previous) throw new Error('服务器指纹发生变化，助手连接已拒绝，请在已知主机中核对');
    const result = await prompts.ask({ type:'question', message:'助手首次连接：确认服务器身份', detail:`${host.name} · ${host.address}:${host.port}\n\n${fingerprint}`, buttons:['取消','信任并连接'], defaultId:0, cancelId:0 });
    if (result.response !== 1) return false;
    if (token !== scopeToken) return false;
    const current = nextStore.known(host); if (current && current !== fingerprint) return false;
    nextStore.trust(host,fingerprint); return true;
  } });
  return { store: nextStore, agent: nextAgent };
}
app.whenReady().then(async () => {
  workspaces = new Workspaces(dataPath);
  accounts = new AccountClient(dataPath,safeStorage,workspaces);
  ({ store, agent } = createContext(workspaces.current(), scopeToken));
  localRoot = fs.realpathSync(localRoot);
  if(process.platform==='darwin')Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'Termlo',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},
    {label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    {label:'窗口',submenu:[{role:'minimize'},{role:'close'}]},
  ]));else Menu.setApplicationMenu(null);
  electronSession.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  electronSession.defaultSession.setPermissionCheckHandler(() => false);
  installHandlers();
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 1000, minHeight: 680, backgroundColor: '#181a1f', icon: path.join(root, 'assets/termlo.png'), title: 'Termlo', show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('did-start-loading', () => {
    prompts.cancelAll();
    agent.attachments.clearDrafts();
    for(const [id,ssh] of connections)if(ssh.kind==='sftp'){ssh.close();connections.delete(id);}
    for (const id of [...manual.sessions.keys()]) { connections.get(id)?.close(); connections.delete(id); manual.release(id); }
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  let quitApproved=false,quitPrompting=false;
  window.on('close', event => {
    if(agent.protection.busy){event.preventDefault();send({type:'protection-close-blocked'});return;}
    if(quitApproved)return;
    if (!connections.size && !agent.active) return;
    event.preventDefault();if(quitPrompting)return;quitPrompting=true;
    prompts.ask({ type: 'warning', message:'退出 Termlo？', detail:`将关闭 ${connections.size} 个终端或文件连接${agent.active?'并暂停助手任务':''}。远端派生进程可能继续。`,buttons:['取消','退出'] }).then(({response})=>{quitPrompting=false;if(response===1&&window){quitApproved=true;window.close();}});
  });
  window.on('closed', () => { monitor.close();prompts.cancelAll();agent.close(); for (const ssh of connections.values()) ssh.close(); connections.clear(); window = null; });
  await window.loadURL(indexUrl);
  window.show();
  const activeAccountId=workspaces.current().account.id;
  if(accounts.status(activeAccountId).signedIn){const previous=accounts.syncEntries[activeAccountId]?.revision||0;void accounts.syncNow(activeAccountId).then(status=>{if(status.status==='synced'&&status.revision!==previous)refreshCurrentContextFromSync(activeAccountId);send({type:'account-sync',accountId:activeAccountId,sync:status});}).catch(error=>{accounts.saveSyncState(activeAccountId,{...(accounts.syncEntries[activeAccountId]||{}),status:'error',message:error.message},null);send({type:'account-sync',accountId:activeAccountId,sync:accounts.syncStatus(activeAccountId)});});}
}).catch(error => { dialog.showErrorBox('Termlo 启动失败', error.message); app.exit(1); });
app.on('window-all-closed', () => app.quit());
