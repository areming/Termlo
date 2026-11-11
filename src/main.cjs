// Termlo 2.0 main process: hosts, terminals, files, assistant, settings.
const { app, BrowserWindow, ipcMain, dialog, safeStorage, clipboard, Menu, shell, Tray, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { Store } = require('./store.cjs');
const { SSHSession } = require('./ssh.cjs');
const { AgentService } = require('./agent/service.cjs');
const { PromptBroker } = require('./prompt-broker.cjs');
const { validateText } = require('./clipboard.cjs');
const { readSshConfig } = require('./ssh-config.cjs');
const { migrate } = require('./migrate.cjs');
const { identityKey, probeInventory } = require('./host-os.cjs');
const { resolveDataDir } = require('./data-dir.cjs');
const atomicFile = require('./atomic-file.cjs');
const { HostMonitor } = require('./host-monitor.cjs');

app.setName('Termlo');
const root = path.join(__dirname, '..');
// userData is the data directory itself, so Electron's key for saved passwords lives with the data.
// Must run before app ready; a packaged build moves the pre-2.0.2 "Termus" folder to "Termlo".
const dataPath = process.env.TERMLO_DATA_DIR || (app.isPackaged ? resolveDataDir(app.getPath('appData')).directory : path.join(root, 'data'));
app.setPath('userData', dataPath);

const indexUrl = pathToFileURL(path.join(root, 'dist/index.html')).href;
const connections = new Map();   // id -> SSHSession (terminal or sftp)
const transfers = new Map();     // id -> { controller }
const conflicts = new Map();     // id -> resolve
let window, store, agent, prompts, migration, preferences;

function send(message) {
  if (window && !window.isDestroyed()) window.webContents.send('termlo:event', message);
}

function trusted(event) {
  return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url.split('#')[0] === indexUrl;
}

function handle(name, action) {
  ipcMain.handle('termlo:' + name, async (event, ...args) => {
    if (!trusted(event)) throw new Error('拒绝未授权请求');
    return action(...args);
  });
}

function session(id) {
  const ssh = connections.get(id);
  if (!ssh) throw new Error('连接已关闭');
  return ssh;
}

// ---- preferences (theme, terminal) ------------------------------------------
// Window-button strip (Windows / Linux): the top bar's --bg and --muted tokens, one per theme.
const TITLE_BAR = { dark: { color: '#0f131a', symbolColor: '#929eb0' }, light: { color: '#eef2f6', symbolColor: '#566779' } };
const titleBarOverlay = theme => ({ ...TITLE_BAR[theme === 'light' ? 'light' : 'dark'], height: 47 });
const PREFERENCE_DEFAULTS ={ theme: 'dark', terminalFontSize: 14, terminalFont: 'jetbrains', terminalHighlights: true, hostView: 'grid' };
function loadPreferences() {
  try { return { ...PREFERENCE_DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(dataPath, 'preferences.json'), 'utf8')) }; }
  catch { return { ...PREFERENCE_DEFAULTS }; }
}
function savePreferences(input) {
  const next = { ...preferences };
  if (['dark', 'light'].includes(input.theme)) next.theme = input.theme;
  if (Number.isInteger(input.terminalFontSize) && input.terminalFontSize >= 11 && input.terminalFontSize <= 22) next.terminalFontSize = input.terminalFontSize;
  if (['grid', 'list'].includes(input.hostView)) next.hostView = input.hostView;
  if (['jetbrains', 'cascadia', 'system'].includes(input.terminalFont)) next.terminalFont = input.terminalFont;
  if (typeof input.terminalHighlights === 'boolean') next.terminalHighlights = input.terminalHighlights;
  if (typeof input.closeToTray === 'boolean') next.closeToTray = input.closeToTray;
  if (typeof input.trayHintShown === 'boolean') next.trayHintShown = input.trayHintShown;
  // Card order the user dragged into place: host ids only; unknown ids are harmless and skipped.
  if (Array.isArray(input.hostOrder) && input.hostOrder.length <= 2000 && input.hostOrder.every(id => typeof id === 'string' && /^[\w-]{1,100}$/.test(id))) next.hostOrder = [...new Set(input.hostOrder)];
  const file = path.join(dataPath, 'preferences.json');
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
  atomicFile.renameSync(temporary, file);
  preferences = next;
  return preferences;
}

// ---- host key verification --------------------------------------------------
function verifier({ quiet = false } = {}) {
  return async (host, fingerprint) => {
    const previous = store.known(host);
    if (previous === fingerprint) return true;
    if (previous) {
      if (!quiet) await prompts.ask({ type: 'error', message: '服务器指纹变了，已拒绝连接', detail: `${host.name} · ${host.address}:${host.port}\n\n原指纹：${previous}\n现指纹：${fingerprint}\n\n如果确认服务器换过密钥，请到"设置 → 已知主机"删除旧记录后重新连接。`, buttons: ['知道了'] });
      return false;
    }
    const { response } = await prompts.ask({ type: 'question', message: '第一次连接，请确认服务器身份', detail: `${host.name} · ${host.address}:${host.port}\n\n${fingerprint}\n\n请和服务器管理员提供的指纹核对。`, buttons: ['取消', '信任并连接'] });
    if (response !== 1) return false;
    const current = store.known(host);
    if (current && current !== fingerprint) return false;
    store.trust(host, fingerprint);
    return true;
  };
}

function credentialsFor(route, supplied = {}) {
  return Object.fromEntries(route.map(host => {
    const input = supplied[host.id] || {};
    return [host.id, host.auth === 'key' ? { passphrase: String(input.passphrase || '') } : { password: input.password ?? store.password(host.id) }];
  }));
}

// Learn the OS of a host once connected (shown on host cards, given to the assistant).
const probed = new Map();
// Live metrics ride on the terminals the user opened: a terminal open means "online". File
// sessions linger in the background and the assistant's have no kind, so neither is sampled.
const monitor = new HostMonitor({ notify: message => send(message) });
SSHSession.observe = (hostId, ssh) => {
  if (ssh.kind === 'terminal') monitor.attach(hostId, ssh);
  let key;
  try { key = identityKey(store.get(hostId)); } catch { return; }
  if (Date.now() - (probed.get(hostId + key) || 0) < 60000) return;
  probed.set(hostId + key, Date.now());
  probeInventory(ssh).then(info => {
    if (info && store.cacheInventory(hostId, info, key)) send({ type: 'hosts', hosts: store.list() });
  }).catch(() => {});
};

async function openConnection(id, hostId, credentials, kind, size = {}) {
  if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id) || connections.has(id)) throw new Error('连接标识无效');
  if (connections.size >= 24) throw new Error('最多同时打开 24 个连接');
  const route = store.route(hostId);
  const ssh = new SSHSession();
  ssh.kind = kind;
  connections.set(id, ssh);
  ssh.on('data', data => send({ type: 'data', id, data }));
  ssh.on('fault', message => send({ type: 'fault', id, message }));
  ssh.on('stage', message => send({ type: 'stage', id, message }));
  ssh.on('status', status => {
    send({ type: 'status', id, status });
    if (status === 'closed') connections.delete(id);
  });
  try {
    await ssh.connectRoute(route, credentialsFor(route, credentials), verifier());
    if (ssh.closed) throw new Error('连接已取消');
    if (kind === 'sftp') {
      const channel = await ssh.sftp();
      channel.on('close', () => ssh.close());
      ssh.emit('status', 'ready');
    } else {
      const cols = Number.isInteger(size.cols) ? Math.max(2, Math.min(size.cols, 500)) : 100;
      const rows = Number.isInteger(size.rows) ? Math.max(2, Math.min(size.rows, 500)) : 30;
      await ssh.shell(cols, rows);
    }
    return true;
  } catch (error) {
    ssh.close();
    connections.delete(id);
    throw error;
  }
}

// ---- transfers ----------------------------------------------------------------
async function runTransfer(id, direction, name, run) {
  const transferId = randomUUID();
  const controller = new AbortController();
  transfers.set(transferId, { controller });
  const notify = data => send({ type: 'transfer', id, transferId, direction, name, ...data });
  notify({ state: 'started' });
  try {
    const result = await run({
      signal: controller.signal,
      onProgress: progress => notify({ state: 'running', ...progress }),
      conflict: 'ask',
      resolveConflict: info => new Promise(resolve => {
        const conflictId = randomUUID();
        conflicts.set(conflictId, resolve);
        notify({ state: 'conflict', conflictId, name: info.name, conflictType: info.type, incoming: info.incoming, existing: info.existing });
      }),
    });
    notify({ state: 'done', files: result.files, bytes: result.bytes, skipped: result.skipped?.length || 0 });
    return result;
  } catch (error) {
    notify({ state: error.name === 'AbortError' ? 'cancelled' : 'failed', message: error.message });
    if (error.name !== 'AbortError') throw error;
    return { cancelled: true };
  } finally {
    transfers.delete(transferId);
  }
}

// ---- IPC ----------------------------------------------------------------------
function installHandlers() {
  handle('init', () => ({
    hosts: store.list(),
    preferences,
    migration,
    platform: process.platform,
    version: app.getVersion(),
    metrics: monitor.snapshot(),
  }));
  handle('savePreferences', input => {
    const saved = savePreferences(input || {});
    if (process.platform !== 'darwin') window?.setTitleBarOverlay?.(titleBarOverlay(saved.theme));
    return saved;
  });
  handle('answerPrompt', (id, response) => prompts.answer(id, response));

  // hosts
  handle('saveHost', input => store.save(input));
  handle('setHostGroup', (ids, group) => store.setGroup(ids, group));
  handle('deleteHost', id => {
    if ([...connections.values()].some(ssh => ssh.hostId === id)) throw new Error('请先关闭这台主机的终端和文件连接');
    store.remove(id);
    return store.list();
  });
  handle('pickKey', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择 SSH 私钥', defaultPath: path.join(os.homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('previewSshConfig', () => {
    const { hosts, warnings } = readSshConfig({ homeDir: os.homedir() });
    const existing = store.list();
    return {
      hosts: hosts.map(host => ({
        ...host,
        duplicate: existing.some(h => h.address === host.address && Number(h.port) === Number(host.port) && h.username === host.username),
      })),
      warnings: warnings.slice(0, 20),
    };
  });
  handle('importSshConfig', ids => {
    if (!Array.isArray(ids)) throw new Error('导入列表无效');
    const { hosts } = readSshConfig({ homeDir: os.homedir() });
    const wanted = new Set(ids);
    // Jump hosts are listed before the hosts using them; keep that order and remap ids.
    const mapping = new Map();
    const needed = new Set();
    const mark = id => { if (!id || needed.has(id)) return; needed.add(id); mark(hosts.find(h => h.id === id)?.jumpHostId); };
    for (const id of wanted) mark(id);
    let imported = 0;
    for (const host of hosts) {
      if (!needed.has(host.id)) continue;
      const { id, ...input } = host;
      const duplicate = store.list().find(h => h.address === input.address && Number(h.port) === Number(input.port) && h.username === input.username && (h.jumpHostId || '') === (mapping.get(input.jumpHostId) || ''));
      if (duplicate) { mapping.set(id, duplicate.id); continue; }
      const before = new Set(store.list().map(h => h.id));
      const after = store.save({ ...input, jumpHostId: mapping.get(input.jumpHostId) || '', needsKeyFile: input.auth === 'key' && !input.keyPath });
      mapping.set(id, after.find(h => !before.has(h.id)).id);
      imported++;
    }
    return { hosts: store.list(), imported };
  });

  // terminals and files
  handle('connect', (id, hostId, credentials, size) => openConnection(id, hostId, credentials, 'terminal', size).then(() => { connections.get(id).hostId = hostId; return true; }));
  handle('connectFiles', (id, hostId, credentials) => openConnection(id, hostId, credentials, 'sftp').then(() => { connections.get(id).hostId = hostId; return true; }));
  handle('disconnect', id => { connections.get(id)?.close(); connections.delete(id); });
  handle('resize', (id, cols, rows) => session(id).resize(cols, rows));
  ipcMain.on('termlo:write', (event, id, data) => {
    if (!trusted(event)) return;
    try { session(id).write(data); } catch (error) { send({ type: 'fault', id, message: error.message }); }
  });
  handle('listRemote', (id, directory) => session(id).list(directory));
  handle('mkdirRemote', (id, directory) => session(id).mkdirp(directory));
  handle('renameRemote', (id, from, to) => session(id).rename(from, to));
  handle('removeRemote', async (id, target, isDirectory) => {
    const ssh = session(id);
    if (!isDirectory) return ssh.removeFile(target);
    const { response } = await prompts.ask({ type: 'warning', message: `删除文件夹 ${path.posix.basename(target)} 及其全部内容？`, detail: `${target}\n\n删除后无法恢复。`, buttons: ['取消', '删除文件夹'] });
    if (response !== 1) return { cancelled: true };
    return ssh.removeDirectory(target, { force: true });
  });
  handle('upload', async (id, remoteDirectory, localPaths) => {
    const ssh = session(id);
    let paths = Array.isArray(localPaths) ? localPaths.filter(p => typeof p === 'string' && path.isAbsolute(p)) : [];
    if (!paths.length) {
      const result = await dialog.showOpenDialog(window, { title: '上传到服务器', properties: ['openFile', 'multiSelections'] });
      if (result.canceled) return { cancelled: true };
      paths = result.filePaths;
    }
    const results = [];
    for (const local of paths) results.push(await runTransfer(id, 'upload', path.basename(local), options => ssh.upload(local, remoteDirectory, options)));
    return results;
  });
  handle('uploadFolder', async (id, remoteDirectory) => {
    const result = await dialog.showOpenDialog(window, { title: '上传文件夹', properties: ['openDirectory'] });
    if (result.canceled) return { cancelled: true };
    return runTransfer(id, 'upload', path.basename(result.filePaths[0]), options => session(id).upload(result.filePaths[0], remoteDirectory, options));
  });
  handle('download', async (id, remotePaths) => {
    const ssh = session(id);
    const result = await dialog.showOpenDialog(window, { title: '下载到…', defaultPath: path.join(os.homedir(), 'Downloads'), properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return { cancelled: true };
    const target = result.filePaths[0];
    for (const remote of remotePaths) await runTransfer(id, 'download', path.posix.basename(remote), options => ssh.download(remote, target, options));
    return { directory: target };
  });
  handle('cancelTransfer', transferId => transfers.get(transferId)?.controller.abort());
  handle('answerConflict', (conflictId, answer) => {
    const resolve = conflicts.get(conflictId);
    if (!resolve) return false;
    conflicts.delete(conflictId);
    resolve(answer);
    return true;
  });
  handle('showInFolder', target => { if (typeof target === 'string' && path.isAbsolute(target)) shell.openPath(target); });

  // known hosts
  handle('knownHosts', () => Object.entries(store.data.knownHosts).map(([key, fingerprint]) => {
    const [address, port] = JSON.parse(key);
    return { key, address, port, fingerprint };
  }));
  handle('forgetHostKey', key => store.forget(key));

  // clipboard
  handle('readClipboard', async () => validateText(clipboard.readText()));
  handle('writeClipboard', async text => clipboard.writeText(validateText(text)));
  handle('editMenu', readOnly => {
    Menu.buildFromTemplate([
      { role: 'cut', label: '剪切', enabled: !readOnly },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴', enabled: !readOnly },
      { type: 'separator' },
      { role: 'selectAll', label: '全选' },
    ]).popup({ window });
  });

  // assistant
  handle('agentState', () => agent.state());
  handle('agentTask', id => agent.task(id));
  handle('agentConfigure', input => agent.configure(input));
  handle('agentTest', () => agent.test());
  handle('agentStart', input => ({ id: agent.start(input).id }));
  handle('agentFollowup', input => agent.followup(input));
  handle('agentResume', input => ({ id: agent.resume(input).id }));
  handle('agentAnswer', input => ({ id: agent.answer(input).id }));
  handle('agentExecutePlan', input => ({ id: agent.executePlan(input).id }));
  handle('agentApprove', input => ({ id: agent.approve(input).id }));
  handle('agentPause', async id => { await agent.pause(id); return agent.state(); });
  handle('agentRemove', async input => {
    const { id, clean = false, credentials = {} } = typeof input === 'string' ? { id: input } : input || {};
    const result = await agent.remove(id, { clean: !!clean, credentials });
    return { ...result, state: agent.state() };
  });
  handle('agentRecover', input => agent.recover(input));
  handle('agentAddAttachments', paths => {
    const files = Array.isArray(paths) ? paths.filter(p => typeof p === 'string' && path.isAbsolute(p)) : [];
    if (!files.length) throw new Error('没有可添加的文件');
    return agent.attachments.importFiles(files);
  });
  handle('agentPickAttachments', async () => {
    const result = await dialog.showOpenDialog(window, { title: '添加附件（单个最多 25 MB）', properties: ['openFile', 'multiSelections'] });
    return result.canceled ? [] : agent.attachments.importFiles(result.filePaths);
  });
  handle('agentDropAttachment', id => agent.attachments.drop(id));
}

function createWindow() {
  window = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1000, minHeight: 680,
    show: false, autoHideMenuBar: true, title: 'Termlo',
    backgroundColor: TITLE_BAR[preferences.theme === 'light' ? 'light' : 'dark'].color,
    // The app draws its own top bar; the system keeps only the window buttons, in our colors.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 17 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(preferences.theme) }),
    icon: path.join(root, 'assets', process.platform === 'win32' ? 'termlo.ico' : 'termlo.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  // Closing the window keeps Termlo (and its terminals) running in the tray, like most desktop
  // tools; the tray menu quits. The first time, say where it went.
  window.on('close', event => {
    if (quitting || !tray || preferences.closeToTray === false) return;
    event.preventDefault();
    window.hide();
    if (!preferences.trayHintShown) {
      tray.displayBalloon?.({ title: 'Termlo 还在运行', content: '终端连接保持不断。点托盘图标打开，右键可以退出。', iconType: 'info' });
      savePreferences({ trayHintShown: true });
    }
  });
  window.loadURL(indexUrl);
}

// ---- tray (Windows / Linux) -------------------------------------------------------------
let tray = null, quitting = false;
function showWindow() {
  if (!window || window.isDestroyed()) return createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
function trayMenu() {
  const hosts = store.list().slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).slice(0, 15);
  const terminals = [...connections.values()].filter(ssh => ssh.kind === 'terminal' && !ssh.closed).length;
  return Menu.buildFromTemplate([
    { label: '打开 Termlo', click: showWindow },
    { label: '打开终端', enabled: hosts.length > 0, submenu: hosts.map(h => ({ label: h.name, click: () => { showWindow(); send({ type: 'navigate', page: 'terminal', params: { hostId: h.id } }); } })) },
    { type: 'separator' },
    { label: terminals ? `退出（关闭 ${terminals} 个终端）` : '退出 Termlo', click: () => { quitting = true; app.quit(); } },
  ]);
}
function createTray() {
  if (process.platform === 'darwin' || tray) return;
  const icon = nativeImage.createFromPath(path.join(root, 'assets', process.platform === 'win32' ? 'termlo.ico' : 'termlo.png'));
  tray = new Tray(process.platform === 'win32' || icon.isEmpty() ? icon : icon.resize({ width: 22, height: 22 }));   // .ico carries its own sizes
  tray.setToolTip('Termlo');
  tray.on('click', showWindow);
  // Built on demand so the host list and terminal count are current.
  if (process.platform === 'win32') tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
  else tray.setContextMenu(trayMenu());
}

app.whenReady().then(() => {
  fs.mkdirSync(dataPath, { recursive: true });
  migration = migrate(dataPath);
  preferences = loadPreferences();
  store = new Store(dataPath, safeStorage);
  prompts = new PromptBroker(send);
  agent = new AgentService({
    directory: dataPath,
    vault: safeStorage,
    hosts: { get: id => store.get(id), list: () => store.list(), route: id => store.route(id), password: id => store.password(id) },
    verify: verifier({ quiet: true }),
    notify: send,
  });
  Menu.setApplicationMenu(null);
  installHandlers();
  createWindow();
  createTray();
});

// One Termlo per data directory: launching it again brings the running window back.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (app.isReady()) showWindow(); });

app.on('before-quit', () => {
  quitting = true;
  tray?.destroy();
  monitor.close();
  agent?.close();
  for (const ssh of connections.values()) ssh.close();
});
app.on('window-all-closed', () => app.quit());
