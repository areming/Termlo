import { initAppearance, terminalTheme } from './appearance.js';
import { initSelects } from './select-control.js';
import { initDialogs, confirmAction } from './app-dialogs.js';
import { initMetrics, metricStrip, setMetricHost } from './host-metrics.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { icon, mountIcons } from './icons.js';
import { initAssistant } from './assistant-ui.js';
import { initWorkspaces } from './workspace-ui.js';
import { hostSpaceUI } from './host-space-ui.js';
import { hostOSIcon } from './host-os-ui.js';
import { specificationStrip, updateSpecification } from './host-specs-ui.js';
import { initProtection } from './protection-ui.js';
import { terminalClipboard } from './terminal-clipboard.js';
import { TERMINAL_THEME, SemanticHighlights, highlightPreferences } from './terminal-highlights.js';
import { initOnboarding } from './onboarding-ui.js';

const api = window.termus;
const isMac = /^Mac/i.test(navigator.platform);
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { hosts: [], sessions: new Map(), fileSessions: new Map(), active: null, view: 'hosts', group: '', local: null, remote: null, sftpHost:'', sftpId: '', remoteRequest: 0 };
let toastTimer, credentialResolve, credentialAnswer = null, connecting = false;
mountIcons();
document.querySelector('#topbar-shortcut').textContent=isMac?'⌘ K':'Ctrl K';
document.querySelector('#host-search-shortcut').textContent=isMac?'⌘ K':'Ctrl K';
initDialogs(api);initMetrics(api);
initAppearance(state);
if(isMac){document.querySelector('#terminal-copy').title='复制选区 · ⌘ C';document.querySelector('#terminal-paste').title='粘贴 · ⌘ V';}
initSelects();
const terminalMetrics=metricStrip('');terminalMetrics.id='terminal-metrics';$('#terminal-panes').before(terminalMetrics);
const sftpMetrics=metricStrip('');sftpMetrics.id='sftp-metrics';$('#sftp-view .page-heading').after(sftpMetrics);
window.addEventListener('termus-metrics',()=>requestAnimationFrame(()=>{const active=state.sessions.get(state.active);if(state.view!=='terminal'||!active?.term.element)return;const {cols,rows}=active.term;active.fit.fit();if(active.status==='ready'&&(cols!==active.term.cols||rows!==active.term.rows))api.resize(active.id,active.term.cols,active.term.rows).catch(()=>{});}));
const clipboardUI = terminalClipboard({ api, state, toast, showError });
const highlightsUI = highlightPreferences({ state, showError });
const assistantUI = initAssistant({ api, state, showError, toast, askCredential, clipboardUI });
const workspaceUI = initWorkspaces({ api, state, showError });
const onboardingUI = initOnboarding({ api, state, workspaceUI, assistantUI, showView, editHost, showError });
initProtection({api,state,showError});
const hostSpaces=hostSpaceUI({api,state,showError,toast,onHosts:()=>window.dispatchEvent(new Event('termus-hosts-changed')),actions:{connect:connectHost,files:openFiles,edit:editHost,remove:async host=>{state.hosts=await api.deleteHost(host.id);window.dispatchEvent(new Event('termus-hosts-changed'));}}});
let editorHosts=[],editorRequest=0,editorLoading=false;
window.addEventListener('termus-hosts-changed',()=>{renderHosts();refreshSftpSelect();assistantUI.refresh().catch(showError);});
function element(tag, className, value) { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; }
function button(label, action, className = '') { const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', event => { event.stopPropagation(); Promise.resolve().then(action).catch(showError); }); return node; }
function iconButton(name, label, action, className = '', showLabel = false) {
  const node = button('', action, className); node.append(icon(name));
  node.title = label; node.setAttribute('aria-label', label);
  if (showLabel) node.append(element('span', '', label));
  return node;
}
function toast(message, error = false) { clearTimeout(toastTimer); const box = $('#toast'); box.textContent = message; box.className = 'toast' + (error ? ' error' : ''); toastTimer = setTimeout(() => box.classList.add('hidden'), error ? 8000 : 3500); }
function message(error) { return String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
function showError(error) { toast(message(error), true); }
function bind(selector, event, action) { $(selector).addEventListener(event, e => { try { Promise.resolve(action(e)).catch(showError); } catch (error) { showError(error); } }); }
function formatSize(size) { if (size < 1024) return `${size} B`; const units = ['KB', 'MB', 'GB', 'TB']; let n = size / 1024, i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return `${n.toFixed(1)} ${units[i]}`; }
function showView(name) {
  state.view = name;
  $$('.view').forEach(view => view.classList.toggle('hidden', view.id !== name + '-view'));
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === name));
  $('#breadcrumb-title').textContent = ({ hosts: '主机', terminal: '终端', sftp: 'SFTP 文件传输', known: '已知主机', assistant: '智能助手' })[name];
  $('#topbar-assistant').classList.toggle('is-active',name==='assistant');
  if (name === 'terminal') fitActive();
  if (name === 'assistant') assistantUI.refresh().catch(showError);
  if (name === 'sftp') { refreshSftpSelect(); if (!state.local) loadLocal().catch(showError); if (state.fileSessions.get(state.sftpId)?.status==='ready' && !state.remote) loadRemote('.').catch(showError); }
  if (name === 'known') loadKnown().catch(showError);
  clipboardUI.update();
  highlightsUI.updateVisibility();
  onboardingUI.updateTips();
}
function renderHosts() {
  onboardingUI.updateTips();
  hostSpaces.closeMenu();
  const groups = [...new Set(state.hosts.map(h => h.group))].sort();
  if (state.group && !groups.includes(state.group)) state.group = '';
  $('#host-count').textContent = state.hosts.length;
  $('#heading-count').textContent = state.hosts.length;
  $('#group-count').textContent = groups.length;
  const groupNav = $('#groups'); groupNav.replaceChildren();
  const all = button('', () => { state.group = ''; showView('hosts'); renderHosts(); }, !state.group ? 'selected' : '');
  all.append(icon('grid'), element('span', '', '全部主机'), element('span', 'group-total', state.hosts.length)); groupNav.append(all);
  const filter = $('#group-filter'); filter.replaceChildren(new Option('全部分组', ''));
  const options = $('#group-options'); options.replaceChildren();
  for (const group of groups) {
    const count = state.hosts.filter(h => h.group === group).length;
    const choose = () => { state.group = group; showView('hosts'); renderHosts(); };
    const nav = button('', choose, state.group === group ? 'selected' : ''); nav.append(icon('folder'), element('span', '', group), element('span', 'group-total', count)); groupNav.append(nav);
    filter.add(new Option(group, group)); options.append(new Option(group, group));
  }
  filter.value = state.group;
  const query = $('#search').value.trim().toLowerCase();
  const hosts = state.hosts.filter(h => (!state.group || h.group === state.group) && [h.name, h.address, h.tags, h.username, h.group].join(' ').toLowerCase().includes(query));
  $('#host-heading').textContent = state.group || '所有主机'; $('#heading-count').textContent = hosts.length;
  $('#host-list-label').textContent = (state.group || '主机') + (query ? ` · 找到 ${hosts.length} 台` : '');
  const grid = $('#host-grid'); grid.replaceChildren();
  $('#empty-hosts').classList.toggle('hidden', state.hosts.length > 0);
  if (state.hosts.length && !hosts.length) grid.append(element('p', '', '没有匹配的主机，请调整搜索条件。'));
  for (const host of hosts) {
    const card = element('article', 'host-card'); card.tabIndex = 0;card.dataset.hostId=host.id;
    card.addEventListener('dblclick', event => { if (!event.target.closest('button')) connectHost(host); });
    card.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target === card) connectHost(host); });
    const top = element('div', 'host-card-top');top.append(hostOSIcon(host), element('span', 'host-protocol', 'SSH'),hostSpaces.menuButton(host));
    const tags = element('div', 'tags'); for (const tag of (host.tags || host.group).split(/[,，]/).map(t => t.trim()).filter(Boolean).slice(0, 4)) tags.append(element('span', 'tag', tag));if(host.needsKeyFile)tags.append(element('span','tag','本机需选私钥'));
    const details = element('div', 'host-details'); details.append(element('h3', '', host.name), element('div', 'host-address', `${host.username}@${host.address}:${host.port}`));
    const route = element('div', 'host-route'); route.append(icon(host.jumpHostId ? 'route' : 'shield'), element('span', '', host.jumpHostId ? '经由 ' + (state.hosts.find(h => h.id === host.jumpHostId)?.name || '未知跳板机') : '直接连接')); route.title = route.textContent;
    card.append(top, details, specificationStrip(host), tags, route, metricStrip(host.id)); grid.append(card);
  }
}
function authFields() { const key = $('#host-form').elements.auth.value === 'key'; $('#key-fields').classList.toggle('hidden', !key); $('#password-fields').classList.toggle('hidden', key); }
async function editHost(host) {
  const info=await api.workspaceState(),account=info.accounts.find(a=>a.id===info.accountId);state.workspace=info;
  const form = $('#host-form'); form.reset();form.dataset.needsKeyFile=String(!!host?.needsKeyFile);form.elements.id.value=host?.id||'';
  const spaces=$('#host-space');spaces.replaceChildren();for(const s of account.spaces)spaces.add(new Option(s.name,s.id));spaces.value=info.spaceId;
  editorHosts=state.hosts;editorRequest++;editorLoading=false;
  fillGroupOptions(editorHosts);
  const select = $('#jump-host'); select.replaceChildren(new Option('直接连接（不使用跳板机）', ''));
  for (const candidate of state.hosts) if (candidate.id !== host?.id) select.add(new Option(`${candidate.name} · ${candidate.address}`, candidate.id));
  for (const key of ['id', 'name', 'address', 'port', 'username', 'group', 'tags', 'auth', 'keyPath', 'jumpHostId']) if (host) form.elements[key].value = key==='keyPath'&&host.needsKeyFile?'':host[key] || '';
  $('#key-sync-note').classList.toggle('hidden',!host?.needsKeyFile);
  $('#host-dialog-title').textContent = host ? '编辑主机' : '新建主机';
  $('#clear-password-label').classList.toggle('hidden', !host?.hasPassword);
  form.elements.password.placeholder = host?.hasPassword ? '已保存密码，留空保持不变' : '留空则在连接时输入';
  $('#host-error').textContent = '';$('#host-space-note').textContent='';form.querySelector('[type=submit]').textContent='保存主机';form.querySelector('[type=submit]').disabled=false; authFields(); previewRoute();updateHostPreview(); $('#host-dialog').showModal(); form.elements.name.focus();
}
function fillGroupOptions(hosts){$('#group-options').replaceChildren(...[...new Set(hosts.map(h=>h.group).filter(Boolean))].sort().map(group=>new Option(group,group)));}
function updateHostPreview(){const f=$('#host-form');$('#host-preview-name').textContent=f.elements.name.value.trim()||'新主机';$('#host-preview-address').textContent=f.elements.address.value.trim()?`${f.elements.username.value||'user'}@${f.elements.address.value}:${f.elements.port.value||22}`:'准备你的下一条连接';const host=state.hosts.find(h=>h.id===f.elements.id.value),badge=hostOSIcon(host);$('#host-preview-icon').className=badge.className;$('#host-preview-icon').dataset.os=badge.dataset.os;$('#host-preview-icon').replaceChildren(...badge.childNodes);$('#host-preview-icon').title=badge.title;}
async function changeHostSpace(){
  const request=++editorRequest,form=$('#host-form'),target=form.elements.spaceId.value,previous=$('#jump-host').value;editorLoading=true;form.querySelector('[type=submit]').disabled=true;
  try{const hosts=await api.spaceHosts(target);if(request!==editorRequest||!$('#host-dialog').open)return;editorHosts=hosts;fillGroupOptions(hosts);const jump=$('#jump-host');jump.replaceChildren(new Option('直接连接（不使用跳板机）',''));for(const h of hosts)if(h.id!==form.elements.id.value)jump.add(new Option(`${h.name} · ${h.address}`,h.id));
   const missing=!!previous&&!hosts.some(h=>h.id===previous);if(missing){const placeholder=new Option('请选择目标空间的路由','__choose__');placeholder.disabled=true;jump.add(placeholder);jump.value='__choose__';}else jump.value=previous;form.querySelector('[type=submit]').textContent=target!==state.workspace.spaceId&&form.elements.id.value?'保存并移动':'保存主机';$('#host-space-note').textContent=(target!==state.workspace.spaceId?(form.elements.id.value?'保存后移入此空间。':'主机将直接创建在此空间。'):'')+(missing?' 原跳板机不在此空间，请选择新的路由；整条链路可从卡片菜单移动。':'');$('#host-error').textContent='';previewRoute();
  }catch(e){if(request===editorRequest)$('#host-error').textContent=message(e);}finally{if(request===editorRequest){editorLoading=false;form.querySelector('[type=submit]').disabled=false;}}
}
function previewRoute() {
  const form = $('#host-form'), route = [], seen = new Set([form.elements.id.value]);
  let id = $('#jump-host').value;
  const container = $('#route-preview'); container.replaceChildren();
  while (id) {
    if (seen.has(id) || route.length >= 4) { container.append(element('span', 'form-error', '此链路存在循环或超过 4 级，请重新选择。')); return; }
    seen.add(id); const host = editorHosts.find(h => h.id === id); if (!host) break;
    route.unshift(host.name); id = host.jumpHostId;
  }
  for (const name of ['本机', ...route, form.elements.name.value || '目标主机']) { if (container.children.length) container.append(icon('chevron')); container.append(element('span', 'route-node', name)); }
}
function askCredential(host, role) {
  $('#credential-title').textContent = host.auth === 'key' ? '私钥认证' : '密码认证';
  $('#credential-description').textContent = `${role} · ${host.name}\n${host.username}@${host.address}:${host.port}`;
  $('#credential-label').firstChild.textContent = host.auth === 'key' ? '私钥口令（无口令可留空）' : '密码';
  $('#credential-value').value = ''; credentialAnswer = null;
  $('#credential-dialog').showModal(); $('#credential-value').focus();
  return new Promise(resolve => { credentialResolve = resolve; });
}
async function connectHost(host) {
  if (connecting || $('#credential-dialog').open) return;
  connecting = true;
  let credentials = {};
  let route;
  try {
    route = await api.connectionPlan(host.id);
    for (const peer of route) {
      if (peer.auth === 'key' || !peer.hasPassword) {
        const value = await askCredential(peer, peer.id === host.id ? '目标主机' : '跳板机');
        if (value === null) return;
        credentials[peer.id] = peer.auth === 'key' ? { passphrase: value } : { password: value };
      }
    }
  } catch (error) { showError(error); return;
  } finally { connecting = false; }
  const id = crypto.randomUUID();
  const term = new Terminal({ cursorBlink: true, fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 14, lineHeight: 1.25, scrollback: 5000, allowProposedApi: true, theme: terminalTheme() });
  const fit = new FitAddon(); term.loadAddon(fit);
  const pane = element('div', 'terminal-pane'); pane.dataset.id = id; $('#terminal-panes').append(pane);
  const session = { id, host: { ...host }, route, term, fit, pane, status: 'connecting' };
  state.sessions.set(id, session); state.active = id; showView('terminal'); renderTabs();
  term.open(pane); fit.fit(); term.focus();
  session.highlights = new SemanticHighlights(term, highlightsUI.current());
  term.writeln('\x1b[38;2;167;236;208mTermlo\x1b[0m  ·  正在建立 SSH 连接…\r\n');
  term.onData(data => { if (session.status === 'ready') api.write(id, data); });
  clipboardUI.attach(session);
  try { await api.connect(id, host.id, credentials, { cols: term.cols, rows: term.rows }); }
  catch (error) { session.status = 'closed'; term.writeln('\r\n\x1b[31m连接失败：' + message(error).replace(/[\x00-\x1f\x7f]/g, ' ') + '\x1b[0m'); renderTabs(); }
  finally { credentials = {}; }
}
function renderTabs() {
  const tabs = $('#tabs'); tabs.replaceChildren();
  for (const session of state.sessions.values()) {
    const tab = button('', () => { state.active = session.id; renderTabs(); fitActive(); }, 'tab' + (state.active === session.id ? ' active' : ''));
    tab.append(element('span', 'tab-dot ' + session.status), element('span', 'tab-name', session.host.name));
    const close = element('span', 'tab-close'); close.append(icon('close')); close.setAttribute('aria-label', '关闭 ' + session.host.name); close.addEventListener('click', event => { event.stopPropagation(); closeTab(session.id).catch(showError); }); tab.append(close); tabs.append(tab);
    session.pane.classList.toggle('hidden', session.id !== state.active);
  }
  $('#session-count').textContent = [...state.sessions.values()].filter(s => s.status === 'ready').length;
  $('#terminal-empty').classList.toggle('hidden', state.sessions.size > 0);
  $('#terminal-bar').classList.toggle('hidden', !state.sessions.size);
  const active = state.sessions.get(state.active);
  setMetricHost(terminalMetrics,active?.host.id);terminalMetrics.classList.toggle('hidden',!active);
  if (active) { $('#terminal-status').textContent = `${active.host.username}@${active.host.address} · ${({ ready: '已连接', connecting: active.stage || '连接中', closed: '已断开' })[active.status]}${active.route.length > 1 ? ' · ' + (active.route.length - 1) + ' 级跳板' : ''}`; $('#terminal-status').title = active.route.map(h => h.name).join(' → '); }
  $('#disconnect').disabled = !active || active.status === 'closed'; $('#reconnect').disabled = !active || active.status !== 'closed'; $('#open-sftp').disabled = active?.status !== 'ready';
  refreshSftpSelect();
  clipboardUI.update();
  highlightsUI.updateVisibility();
}
async function closeTab(id) {
  const session = state.sessions.get(id); if (!session) return;
  if (session.status !== 'closed') { if (!await confirmAction('关闭终端？','将关闭此终端会话，独立文件连接继续保留。','关闭终端')) return; await api.disconnect(id); }
  session.highlights?.dispose(); session.term.dispose(); session.pane.remove(); state.sessions.delete(id);
  if (state.active === id) state.active = [...state.sessions.keys()].at(-1) || null;
  renderTabs(); fitActive();
}
function fitActive() { requestAnimationFrame(() => { const active = state.sessions.get(state.active); if (!active || state.view !== 'terminal' || !active.term.element) return; active.fit.fit(); if (active.status === 'ready') api.resize(active.id, active.term.cols, active.term.rows).catch(() => {}); if (!document.querySelector('dialog[open]')) active.term.focus(); }); }
function refreshSftpSelect() {
  const select=$('#sftp-session'),hosts=new Map(state.hosts.map(h=>[h.id,h]));
  // A saved host may be edited while connected; show the actual connected endpoint.
  for(const s of state.fileSessions.values())if(s.status!=='closed')hosts.set(s.host.id,s.host);
  select.replaceChildren(new Option('选择服务器',''));
  for(const host of hosts.values()){
    const s=[...state.fileSessions.values()].find(s=>s.host.id===host.id&&s.status!=='closed');
    select.add(new Option(`${host.name} · ${host.address}${s?.status==='ready'?' · 已连接':s?' · 连接中':''}`,host.id));
  }
  select.value=state.sftpHost;
  const session=state.fileSessions.get(state.sftpId),ready=session?.status==='ready',pending=session?.status==='connecting';
  setMetricHost(sftpMetrics,session?.host.id);sftpMetrics.classList.toggle('hidden',!session);
  $('#sftp-connect').disabled=connecting||!state.hosts.some(h=>h.id===state.sftpHost)||ready||pending;
  $('#sftp-disconnect').disabled=!session||session.status==='closed';
  $('#sftp-disconnect').title=pending?'取消连接':'断开文件连接';
  $('#sftp-state').textContent=ready?'已连接':pending?(session.stage||'连接中…'):session?'已断开':'未连接';
  $('#sftp-state').dataset.status=session?.status||'idle';
  $('#sftp-empty').classList.toggle('hidden',ready);
  $('#sftp-empty').textContent=pending?'正在建立独立文件连接…':session?.error||'选择服务器后连接，无需打开终端。';
  for(const id of ['upload','remote-mkdir','remote-up','remote-refresh','remote-path'])$('#'+id).disabled=!ready;
  $('#remote-path-form button[type="submit"]').disabled=!ready;
  const transfer=session?.transferState;
  $('#transfer-title').textContent=transfer?.title||'就绪';$('#transfer-detail').textContent=transfer?.detail||'双击目录浏览，点击文件右侧的按钮传输。';$('#transfer-progress').value=transfer?.percent||0;
}
function selectFileHost(hostId){
  state.sftpHost=hostId;const session=[...state.fileSessions.values()].find(s=>s.host.id===hostId);
  state.sftpId=session?.id||'';state.remote=session?.status==='ready'?session.remote:null;state.remoteRequest++;
  $('#remote-path').value=state.remote?.path||'.';
  if(state.remote)renderFiles('remote',state.remote.files);else $('#remote-files').replaceChildren(element('div','file-placeholder','等待连接'));
  refreshSftpSelect();
  if(session?.status==='ready'&&!state.remote)loadRemote('.').catch(showError);
}
async function connectFiles(){
  if(connecting||$('#credential-dialog').open)return;
  const host=state.hosts.find(h=>h.id===state.sftpHost);if(!host)return;
  if([...state.fileSessions.values()].some(s=>s.host.id===host.id&&s.status!=='closed'))return;
  connecting=true;refreshSftpSelect();let credentials={};
  try{
    for(const peer of await api.connectionPlan(host.id))if(peer.auth==='key'||!peer.hasPassword){
      const value=await askCredential(peer,peer.id===host.id?'文件连接':'跳板机');if(value===null)return;
      credentials[peer.id]=peer.auth==='key'?{passphrase:value}:{password:value};
    }
    for(const [id,s] of state.fileSessions)if(s.host.id===host.id)state.fileSessions.delete(id);
    const session={id:crypto.randomUUID(),host:{...host},status:'connecting',remote:null};state.fileSessions.set(session.id,session);
    if(state.sftpHost===host.id)selectFileHost(host.id);
    try{await api.connectFiles(session.id,host.id,credentials);if(session.status==='connecting')session.status='ready';refreshSftpSelect();if(state.sftpId===session.id&&session.status==='ready')await loadRemote('.').catch(showError);}
    catch(error){session.error=message(error);session.status='closed';await api.disconnect(session.id).catch(()=>{});throw error;}
  }finally{connecting=false;credentials={};refreshSftpSelect();}
}
async function openFiles(host){selectFileHost(host.id);showView('sftp');await connectFiles();}
async function loadLocal(directory) { state.local = await api.listLocal(directory); $('#local-path').textContent = state.local.path; $('#local-path').title = state.local.path; $('#local-up').disabled = !state.local.parent; renderFiles('local', state.local.files); }
async function loadRemote(directory = '.') {
  const id = state.sftpId; if (state.fileSessions.get(id)?.status!=='ready') throw new Error('请先建立文件连接');
  const request = ++state.remoteRequest;
  const listing = await api.listRemote(id, directory);
  if (id !== state.sftpId || request !== state.remoteRequest) return;
  state.remote = listing;state.fileSessions.get(id).remote=listing; $('#remote-path').value = listing.path; renderFiles('remote', listing.files);
}
function renderFiles(side, files) {
  const container = $('#' + side + '-files'); container.replaceChildren();
  if (!files.length) { container.append(element('div', 'file-placeholder', '这个文件夹是空的')); return; }
  for (const file of files) {
    const row = element('div', 'file-row' + (file.directory || file.symlink ? ' directory' : '')); row.title = file.name;
    row.append(icon(file.directory ? 'folder' : file.symlink ? 'route' : 'file'), element('span', 'file-name', file.name), element('span', 'file-size', file.directory ? '—' : formatSize(file.size)));
    if (file.directory || file.symlink) { row.addEventListener('dblclick', () => (side === 'local' ? loadLocal(file.path) : loadRemote(file.path)).catch(showError)); row.append(iconButton('chevron', '打开文件夹', () => side === 'local' ? loadLocal(file.path) : loadRemote(file.path))); }
    else { row.append(iconButton(side === 'local' ? 'up' : 'down', side === 'local' ? '上传' : '下载', () => transfer(side === 'local' ? 'upload' : 'download', file))); }
    container.append(row);
  }
}
async function transfer(direction, file) {
  const id = state.sftpId; if (!id || !state.remote) throw new Error('请先打开远程目录');
  const s = state.fileSessions.get(id); if (s.busy) throw new Error('当前连接的文件仍在传输');
  s.busy = true;s.transferState={title:'准备传输…',percent:0};refreshSftpSelect();
  try {
    const result = await api.transfer(id, direction, direction === 'upload' ? state.remote.path : file.path, direction === 'upload' ? file?.path : undefined);
    if (result.canceled) { s.transferState={title:'已取消',percent:0}; return; }
    toast('传输完成：' + result.name);
    if (state.local) await loadLocal(state.local.path);
    if (state.sftpId === id && state.remote) await loadRemote(state.remote.path);else s.remote=null;
  } catch (error) { s.transferState={title:'传输失败',detail:message(error),percent:0};throw error; }
  finally { s.busy = false;refreshSftpSelect(); }
}
async function loadKnown() { const list = $('#known-list'); list.replaceChildren(); const hosts = await api.knownHosts(); if (!hosts.length) list.append(element('div', 'notice', '首次连接时确认服务器指纹后，记录会显示在这里。')); for (const host of hosts) { const item = element('div', 'known-item'); const text = element('div'); text.append(element('strong', '', host.address + ':' + host.port), element('code', '', host.fingerprint)); item.append(text, button('移除记录', async () => { await api.forgetHostKey(host.key); await loadKnown(); })); list.append(item); } }
api.onEvent(event => {
  if(event.type==='hosts'){state.hosts=event.hosts;renderHosts();refreshSftpSelect();return;}
  if(event.type==='account-sync'){window.dispatchEvent(new CustomEvent('termus-account-sync',{detail:event}));return;}
  const fileSession=state.fileSessions.get(event.id);
  if(fileSession){
    if(event.type==='stage')fileSession.stage=event.message;
    if(event.type==='fault'){fileSession.error=event.message;showError(event.message);}
    if(event.type==='status'){
      fileSession.status=event.status;
      if(event.status==='closed'){fileSession.remote=null;if(state.sftpId===event.id){state.remote=null;state.remoteRequest++;$('#remote-path').value='.';$('#remote-files').replaceChildren(element('div','file-placeholder','文件连接已断开'));}}
    }
    if(event.type==='transfer')fileSession.transferState={title:`${event.done?'已完成':event.direction==='upload'?'上传中':'下载中'} · ${event.name}`,detail:`${fileSession.host.name} · ${formatSize(event.transferred)} / ${formatSize(event.total)}`,percent:event.done?100:event.total?event.transferred/event.total*100:0};
    refreshSftpSelect();return;
  }
  const session = state.sessions.get(event.id); if (!session) return;
  if (event.type === 'data') session.term.write(Uint8Array.from(atob(event.data), char => char.charCodeAt(0)));
  if (event.type === 'stage') { session.stage = event.message; renderTabs(); }
  if (event.type === 'status') { session.status = event.status; if (event.status === 'closed') session.term.writeln('\r\n\x1b[90m连接已关闭。\x1b[0m'); renderTabs(); if (event.status === 'ready') fitActive(); }
  if (event.type === 'fault') { session.term.writeln('\r\n\x1b[31m' + event.message.replace(/[\x00-\x1f\x7f]/g, ' ') + '\x1b[0m'); }
  if (event.type === 'transfer') { $('#transfer-title').textContent = `${event.done ? '已完成' : event.direction === 'upload' ? '上传中' : '下载中'} · ${event.name}`; $('#transfer-detail').textContent = `${session.host.name} · ${formatSize(event.transferred)} / ${formatSize(event.total)}`; $('#transfer-progress').value = event.done ? 100 : event.total ? event.transferred / event.total * 100 : 0; }
});
$$('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
bind('#topbar-search','click',()=>{showView('hosts');$('#search').focus();});
bind('#topbar-assistant','click',()=>showView('assistant'));
$$('[data-go-hosts]').forEach(button => button.addEventListener('click', () => showView('hosts')));
$$('[data-close]').forEach(button => button.addEventListener('click', () => $('#' + button.dataset.close).close()));
$('#credential-dialog').addEventListener('close', () => { $('#credential-value').value = ''; const resolve = credentialResolve, value = credentialAnswer; credentialResolve = null; credentialAnswer = null; resolve?.(value); });
$('#host-dialog').addEventListener('close', () => { $('#host-form').elements.password.value = ''; });
bind('#credential-form', 'submit', event => { event.preventDefault(); credentialAnswer = $('#credential-value').value; $('#credential-dialog').close(); });
bind('#jump-host', 'change', previewRoute); bind('#host-form input[name="name"]', 'input', previewRoute);
bind('#host-space','change',changeHostSpace);bind('#host-form','input',updateHostPreview);
function setLayout(list) { $('#host-grid').classList.toggle('list-mode', list); for (const [id, active] of [['view-list', list], ['view-cards', !list]]) { $('#' + id).classList.toggle('active', active); $('#' + id).setAttribute('aria-pressed', String(active)); } }
bind('#view-list', 'click', () => setLayout(true)); bind('#view-cards', 'click', () => setLayout(false));
bind('#new-host', 'click', () => editHost()); bind('#empty-add', 'click', () => editHost());
bind('#search', 'input', renderHosts); bind('#group-filter', 'change', () => { state.group = $('#group-filter').value; renderHosts(); });
bind('#host-form select[name="auth"]', 'change', authFields);
bind('#pick-key', 'click', async () => { const file = await api.pickKey(); if (file) {$('#host-form').elements.keyPath.value = file;$('#host-form').dataset.needsKeyFile='false';$('#key-sync-note').classList.add('hidden');} });
bind('#host-form', 'submit', async event => {
  event.preventDefault();if(editorLoading)return;if($('#jump-host').value==='__choose__'){$('#host-error').textContent='请选择目标空间中的跳板机，或明确选择直接连接';return;} const form = event.target, submit = form.querySelector('[type="submit"]'); submit.disabled = true;
  try { const input = Object.fromEntries(new FormData(form)); input.needsKeyFile=form.dataset.needsKeyFile==='true'&&!input.keyPath;input.rememberPassword = form.elements.rememberPassword.checked; input.clearPassword = form.elements.clearPassword.checked; state.hosts = await api.saveHost(input); form.elements.password.value = ''; $('#host-dialog').close(); renderHosts(); toast(input.spaceId!==state.workspace.spaceId?'已保存到 '+form.elements.spaceId.selectedOptions[0].textContent:'主机已保存'); }
  catch (error) { $('#host-error').textContent = message(error); }
  finally { submit.disabled = false; }
});
bind('#disconnect', 'click', async () => { const id=state.active;if (await confirmAction('断开终端？','独立文件连接继续保留。','断开')) await api.disconnect(id); });
bind('#reconnect', 'click', () => { const host = state.sessions.get(state.active)?.host; if (host) return connectHost(state.hosts.find(h => h.id === host.id) || host); });
bind('#open-sftp', 'click', () => { const host=state.sessions.get(state.active)?.host;if(host)return openFiles(host); });
bind('#sftp-session', 'change', () => selectFileHost($('#sftp-session').value));
bind('#sftp-connect','click',connectFiles);
bind('#sftp-disconnect','click',async()=>{const id=state.sftpId,s=state.fileSessions.get(id);if(!s)return;if(s.status==='connecting'||await confirmAction('断开文件连接？',s.busy?'当前传输会中止，终端连接不受影响。':'终端连接不受影响。','断开'))await api.disconnect(id);});
bind('#choose-local', 'click', async () => { const listing = await api.pickLocal(); if (listing) { state.local = listing; await loadLocal(listing.path); } });
bind('#local-up', 'click', () => state.local?.parent && loadLocal(state.local.parent)); bind('#local-refresh', 'click', () => loadLocal(state.local?.path));
bind('#remote-up', 'click', () => { if (!state.remote) return; const parent = state.remote.path.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/'; return loadRemote(parent); });
bind('#remote-refresh', 'click', () => loadRemote(state.remote?.path || '.'));
bind('#remote-path-form', 'submit', event => { event.preventDefault(); return loadRemote($('#remote-path').value); });
bind('#upload', 'click', () => transfer('upload'));
bind('#remote-mkdir', 'click', () => { if (!state.remote) throw new Error('请先打开远程目录'); $('#folder-name').value = ''; $('#folder-error').textContent = ''; $('#folder-dialog').showModal(); $('#folder-name').focus(); });
bind('#folder-form', 'submit', async event => { event.preventDefault(); const name = $('#folder-name').value.trim(); if (!name || /[/\\\x00-\x1f]/.test(name) || ['.', '..'].includes(name)) { $('#folder-error').textContent = '请输入有效文件夹名称'; return; } try { await api.mkdirRemote(state.sftpId, state.remote.path.replace(/\/$/, '') + '/' + name); $('#folder-dialog').close(); await loadRemote(state.remote.path); } catch (error) { $('#folder-error').textContent = message(error); } });
window.addEventListener('resize', fitActive);
api.onEvent(event=>{const host=state.hosts.find(h=>h.id===event.hostId);if(!host)return;if(event.type==='host-cloud'){host.cloudIdentity=event.cloudIdentity;return;}if(event.type!=='host-os')return;host.operatingSystem=event.operatingSystem;host.specifications=event.specifications;for(const card of document.querySelectorAll('.host-card'))if(card.dataset.hostId===host.id){const badge=card.querySelector('.os-icon');if(badge)badge.replaceWith(hostOSIcon(host));const spec=card.querySelector('.host-specifications');if(spec)updateSpecification(spec,host);}});
window.addEventListener('keydown', event => { const primary=isMac?event.metaKey:event.ctrlKey;if(primary && event.key.toLowerCase() === 'k') { event.preventDefault(); if ($$('dialog[open]').length) return; showView('hosts'); $('#search').focus(); } if(primary && event.key.toLowerCase() === 'n') { event.preventDefault(); if (!$$('dialog[open]').length) editHost(); } });
api.init().then(async info => { state.hosts = info.hosts; state.workspace = info.workspace; workspaceUI.setInfo(info.workspace); $('#version').textContent = info.version; $('#host-form').elements.rememberPassword.disabled = !info.encrypted; renderHosts(); const view = sessionStorage.getItem('termus.switchView'); sessionStorage.removeItem('termus.switchView'); if (['hosts','assistant','terminal','sftp','known'].includes(view)) showView(view); await onboardingUI.start(info); }).catch(showError);
