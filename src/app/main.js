// Termlo 2.0 renderer entry: app shell, navigation, theme, prompts, command palette.
import { hydrateIcons, icon } from '../ui/icons.js';
import { api, html, raw, ico, render, $, $$, on, dialog, toast, fail, createStore, escape } from './ui.js';
import { createHostsPage } from './hosts.js';
import { createTerminalPage } from './terminal.js';
import { createFilesPage } from './files.js';
import { createAssistantPage } from './assistant.js';
import { createSettingsPage } from './settings.js';
import { createTelemetry } from './telemetry.js';
import { openHelp } from './guide.js';

const PAGES = [
  { id: 'hosts', label: '主机', icon: 'host' },
  { id: 'terminal', label: '终端', icon: 'terminal' },
  { id: 'files', label: '文件', icon: 'folder' },
  { id: 'assistant', label: '助手', icon: 'assistant' },
];

const store = createStore({ hosts: [], preferences: {}, page: 'hosts' });
const listeners = new Map();   // event type -> Set(handler)
const app = {
  store,
  api,
  navigate,
  hostLabel,
  credentials,
  forgetCredentials: hostIds => { for (const id of hostIds) for (const host of route(id)) sessionSecrets.delete(host.id); },
  on(type, handler) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler); },
  setPreferences,
};
app.telemetry = createTelemetry(app);

// ---- shell ----------------------------------------------------------------------
function renderShell() {
  render($('#app'), html`
    <nav class="rail" aria-label="主导航">
      <div class="rail-brand"><a href="#hosts" data-page="hosts" title="Termlo · 回到主机"><img src="./termlo.svg" alt="Termlo" width="28" height="28"></a></div>
      <div class="rail-nav">
        ${PAGES.map(p => html`<a class="rail-item" href="#${p.id}" data-page="${p.id}">${ico(p.icon)}${p.label}</a>`)}
      </div>
      <div class="rail-bottom">
        <a class="rail-item" href="#settings" data-page="settings">${ico('settings')}设置</a>
      </div>
    </nav>
    <header class="topbar">
      <span class="topbar-brand" translate="no">Termlo</span>
      <h1 class="visually-hidden" id="page-title">主机</h1>
      <span class="toolbar-spacer"></span>
      <div class="global-search" id="global-search-box">
        ${ico('search', 'sm')}
        <input id="global-search" type="text" role="combobox" aria-controls="search-results" aria-expanded="false" aria-autocomplete="list" aria-keyshortcuts="Control+K" aria-label="搜索主机或操作" placeholder="搜索主机或操作…" autocomplete="off" spellcheck="false">
        <kbd class="kbd">Ctrl K</kbd>
      </div>
      <button class="btn btn-ghost btn-icon" type="button" id="help-button" aria-label="使用说明" title="使用说明">${ico('question')}</button>
      <button class="btn btn-ghost btn-icon" type="button" id="theme-toggle"></button>
    </header>
    <main class="content" id="main" tabindex="-1">
      ${[...PAGES, { id: 'settings' }].map(p => html`<section class="view" id="view-${p.id}" data-view="${p.id}" hidden></section>`)}
    </main>`);
}

const pages = {};

function navigate(page, params) {
  if (!pages[page]) page = 'hosts';
  const previous = store.get().page;
  if (previous !== page) pages[previous]?.hide?.();
  for (const view of $$('.view')) view.hidden = view.dataset.view !== page;
  for (const item of $$('.rail-item')) {
    if (item.dataset.page === page) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  $('#page-title').textContent = page === 'settings' ? '设置' : PAGES.find(p => p.id === page).label;
  search.reset(page, previous !== page);
  store.set({ page });
  if (location.hash !== '#' + page) history.replaceState(null, '', '#' + page);
  pages[page].show?.(params);
}

// ---- theme & preferences --------------------------------------------------------
function applyTheme() {
  const light = store.get().preferences.theme === 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  const toggle = $('#theme-toggle');
  const label = light ? '切换到暗色主题' : '切换到亮色主题';
  toggle.innerHTML = icon(light ? 'moon' : 'sun');
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
}

async function setPreferences(patch) {
  try {
    const preferences = await api.savePreferences(patch);
    store.set({ preferences });
    applyTheme();
  } catch (error) { fail(error); }
}

// ---- hosts & credentials -----------------------------------------------------------
function hostLabel(id) {
  const host = store.get().hosts.find(h => h.id === id);
  return host ? host.name : '已删除的主机';
}

function route(hostId) {
  const hosts = store.get().hosts, chain = [];
  let current = hosts.find(h => h.id === hostId);
  while (current && chain.length < 8) {
    chain.unshift(current);
    current = current.jumpHostId ? hosts.find(h => h.id === current.jumpHostId) : null;
  }
  return chain;
}

// Ask for whatever a connection route needs that is not saved: passwords or key passphrases.
// force: ask again even if a password is saved (after an authentication failure).
// Secrets typed but not saved are kept in memory for this app session, shared by the
// terminal, files and assistant, so one host is not asked for three times.
const sessionSecrets = new Map();   // host id -> { password } | { passphrase }
async function credentials(hostId, { force = false, reason = '' } = {}) {
  const result = {};
  for (const host of route(hostId)) {
    if (!force && sessionSecrets.has(host.id)) { result[host.id] = sessionSecrets.get(host.id); continue; }
    const needsPassword = host.auth === 'password' && (force || !host.hasPassword);
    const needsPassphrase = host.auth === 'key' && force;
    if (!needsPassword && !needsPassphrase) continue;
    const label = needsPassword ? '密码' : '私钥口令';
    const { value, data } = await dialog({
      title: `连接 ${host.name}`,
      body: html`
        ${reason ? html`<p class="field-error">${ico('status-error', 'sm')}${reason}</p>` : ''}
        <p class="text-muted mono">${host.username}@${host.address}${host.port !== 22 ? ':' + host.port : ''}</p>
        <div class="field">
          <label class="field-label" for="cred-secret">${label}</label>
          <input class="input" id="cred-secret" name="secret" type="password" autocomplete="off" ${needsPassword ? raw('required') : ''} autofocus>
        </div>
        ${needsPassword ? html`<label class="check"><input type="checkbox" name="remember"><span title="用系统加密保存在本机，不会上传">记住密码</span></label>` : ''}`,
      actions: [{ label: '取消', value: 'cancel', tone: 'ghost' }, { label: '连接', value: 'ok', tone: 'primary' }],
    });
    if (value !== 'ok') return null;
    if (needsPassword) {
      result[host.id] = { password: data.secret };
      if (!data.remember) sessionSecrets.set(host.id, result[host.id]);
      if (data.remember) {
        try {
          const { hasPassword, ...saved } = host;
          const hosts = await api.saveHost({ ...saved, password: data.secret, rememberPassword: true });
          store.set({ hosts });
        } catch (error) { fail(error); }
      }
    } else {
      result[host.id] = { passphrase: data.secret };
      sessionSecrets.set(host.id, result[host.id]);
    }
  }
  return result;
}

// ---- prompts from the main process (host keys, destructive confirmations) ----------
const openPrompts = new Map();
async function showPrompt({ id, options }) {
  const buttons = options.buttons || ['取消', '确定'];
  const tone = options.type === 'warning' || options.type === 'error' ? 'danger' : 'primary';
  const { value } = await dialog({
    title: options.message,
    // One paragraph per line; fingerprints get their own monospace block so they can be compared.
    body: html`<div class="prompt-detail">${String(options.detail || '').split(/\n+/).filter(Boolean).map(line => /^(SHA256|MD5):/.test(line.trim())
      ? html`<code class="fingerprint">${line.trim()}</code>`
      : html`<p>${line}</p>`)}</div>`,
    actions: buttons.map((label, index) => ({
      label, value: String(index),
      tone: index === buttons.length - 1 && buttons.length > 1 ? tone : 'ghost',
    })),
    onOpen: element => openPrompts.set(id, element),
  });
  if (!openPrompts.delete(id)) return;   // already answered or timed out in the main process
  const index = Number(value);
  api.answerPrompt(id, Number.isInteger(index) ? index : 0).catch(() => {});
}

// ---- search (Ctrl K) ----------------------------------------------------------------
// One box for everything. On the hosts page it filters the cards as you type (Enter opens a
// terminal on the first match); elsewhere it lists matching hosts and actions below the box.
const search = (() => {
  let panel = null, matches = [], active = 0;
  const input = () => $('#global-search');
  const actions = () => [
    ...store.get().hosts.flatMap(h => [
      { label: h.name, verb: '终端', hint: h.address, icon: 'terminal', run: () => navigate('terminal', { hostId: h.id }) },
      { label: h.name, verb: '文件', hint: h.address, icon: 'folder', run: () => navigate('files', { hostId: h.id }) },
      { label: h.name, verb: '助手', hint: h.address, icon: 'assistant', run: () => navigate('assistant', { hostIds: [h.id] }) },
    ]),
    { label: '添加主机', icon: 'plus', run: () => navigate('hosts', { add: true }) },
    { label: '新建助手任务', icon: 'assistant', run: () => navigate('assistant', { compose: true }) },
    { label: '模型设置', icon: 'settings', run: () => navigate('settings', { section: 'model' }) },
    { label: '使用说明', icon: 'question', run: () => openHelp() },
    { label: '切换主题', icon: store.get().preferences.theme === 'light' ? 'moon' : 'sun', run: () => setPreferences({ theme: store.get().preferences.theme === 'light' ? 'dark' : 'light' }) },
  ];
  const filtering = () => store.get().page === 'hosts';
  function close() {
    panel?.remove();
    panel = null;
    input()?.setAttribute('aria-expanded', 'false');
    input()?.removeAttribute('aria-activedescendant');
  }
  function draw() {
    const box = input();
    const q = box.value.trim().toLowerCase();
    if (filtering()) { close(); if ((store.get().hostQuery || '') !== box.value) store.set({ hostQuery: box.value }); return; }
    matches = actions().filter(a => !q || [a.label, a.verb, a.hint].join(' ').toLowerCase().includes(q)).slice(0, 10);
    active = Math.min(active, Math.max(0, matches.length - 1));
    if (!panel) {
      panel = document.createElement('ul');
      panel.className = 'search-results';
      panel.id = 'search-results';
      panel.setAttribute('role', 'listbox');
      panel.setAttribute('aria-label', '搜索结果');
      panel.popover = 'manual';
      document.body.append(panel);
      panel.showPopover?.();
      panel.addEventListener('pointerdown', event => event.preventDefault());   // keep focus in the box
      on(panel, 'click', '[data-index]', (_e, row) => pick(Number(row.dataset.index)));
      box.setAttribute('aria-expanded', 'true');
    }
    const rect = $('#global-search-box').getBoundingClientRect();
    Object.assign(panel.style, { left: rect.left + 'px', top: rect.bottom + 6 + 'px', width: rect.width + 'px' });
    render(panel, matches.length
      ? html`${matches.map((a, i) => html`<li class="search-result" role="option" id="search-option-${i}" data-index="${i}" aria-selected="${i === active}">${ico(a.icon, 'sm')}<span class="search-result-label truncate">${a.label}</span>${a.verb ? html`<span class="search-result-verb">${a.verb}</span>` : ''}<span class="search-result-hint mono truncate">${a.hint || ''}</span></li>`)}`
      : html`<li class="search-empty">没有匹配的结果</li>`);
    if (matches.length) box.setAttribute('aria-activedescendant', 'search-option-' + active);
  }
  function pick(index) {
    const chosen = matches[index];
    input().value = '';
    close();
    input().blur();
    chosen?.run();
  }
  function bind() {
    const box = input();
    box.addEventListener('focus', draw);
    box.addEventListener('input', () => { active = 0; draw(); });
    box.addEventListener('blur', () => setTimeout(close, 0));
    box.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); if (box.value) { box.value = ''; draw(); } else { close(); box.blur(); } return; }
      if (filtering()) {
        if (event.key === 'Enter') {
          const first = document.querySelector('#view-hosts [data-host]');
          if (first) { box.blur(); navigate('terminal', { hostId: first.dataset.host }); }
        }
        return;
      }
      if (event.key === 'ArrowDown') { event.preventDefault(); active = Math.min(active + 1, matches.length - 1); draw(); }
      if (event.key === 'ArrowUp') { event.preventDefault(); active = Math.max(active - 1, 0); draw(); }
      if (event.key === 'Enter') { event.preventDefault(); if (matches[active]) pick(active); }
    });
    addEventListener('resize', () => { if (panel) draw(); });
  }
  // Leaving a page clears the box; the hosts page names what the box does there.
  function reset(page, leaving) {
    const box = input();
    if (!box) return;
    if (leaving) {
      box.value = '';
      close();
      if (store.get().hostQuery) store.set({ hostQuery: '' });
    }
    box.placeholder = page === 'hosts' ? '搜索主机…' : '搜索主机或操作…';
  }
  return { bind, reset, focus: () => { input().focus(); input().select(); } };
})();

// ---- update check ---------------------------------------------------------------------
// A newer release: a dot on 设置, and one toast per version (the details stay in Settings → 关于).
function updateArrived(update) {
  store.set({ update });
  const result = update?.result;
  const rail = $('.rail-item[data-page="settings"]');
  if (rail) rail.dataset.update = String(!!result?.newer);
  if (!result?.newer || store.get().preferences.updateSeen === result.latest) return;
  setPreferences({ updateSeen: result.latest });
  toast(`Termlo ${result.latest} 可以更新了`, { action: '查看', onAction: () => api.openRelease(result.url).catch(fail), timeout: 15000 });
}

// ---- boot -----------------------------------------------------------------------------
async function boot() {
  renderShell();
  const initial = await api.init();
  store.set({ hosts: initial.hosts, preferences: initial.preferences, version: initial.version, update: initial.update });
  document.documentElement.dataset.platform = initial.platform;   // window buttons sit in our top bar
  for (const metrics of initial.metrics || []) app.telemetry.accept(metrics);
  applyTheme();

  pages.hosts = createHostsPage($('#view-hosts'), app);
  pages.terminal = createTerminalPage($('#view-terminal'), app);
  app.closeTerminals = hostId => pages.terminal.closeHost(hostId);
  pages.files = createFilesPage($('#view-files'), app);
  pages.assistant = createAssistantPage($('#view-assistant'), app);
  pages.settings = createSettingsPage($('#view-settings'), app);
  hydrateIcons(document.body);

  api.onEvent(event => {
    if (event.type === 'hosts') store.set({ hosts: event.hosts });
    if (event.type === 'navigate') navigate(event.page, event.params);   // from the tray menu
    if (event.type === 'update') updateArrived(event.update);
    if (event.type === 'app-prompt') showPrompt(event);
    if (event.type === 'app-prompt-closed') { const element = openPrompts.get(event.id); openPrompts.delete(event.id); element?.close(); }
    for (const handler of listeners.get(event.type) || []) handler(event);
  });

  $('#help-button').addEventListener('click', () => openHelp());
  $('#theme-toggle').addEventListener('click', () => setPreferences({ theme: store.get().preferences.theme === 'light' ? 'dark' : 'light' }));
  search.bind();
  on($('.rail'), 'click', '[data-page]', (event, item) => { event.preventDefault(); navigate(item.dataset.page); });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); search.focus(); }
  });

  const migrated = initial.migration;
  if (migrated) {
    toast(`已从旧版本导入${migrated.hosts ? ` ${migrated.hosts} 台其他项目的主机` : ''}${migrated.settings ? '和模型设置' : ''}。`, { tone: 'success', timeout: 8000 });
  }

  if (initial.update?.result) updateArrived(initial.update);
  navigate(location.hash.slice(1) || 'hosts');
  document.documentElement.dataset.ready = 'true';
}

boot().catch(error => {
  document.body.textContent = '启动失败：' + (error?.message || error);
});

export { escape };
