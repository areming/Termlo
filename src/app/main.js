// Termlo 2.0 renderer entry: app shell, navigation, theme, prompts, command palette.
import { hydrateIcons, icon } from '../ui/icons.js';
import { api, html, raw, ico, render, $, $$, on, dialog, toast, fail, createStore, escape } from './ui.js';
import { createHostsPage } from './hosts.js';
import { createTerminalPage } from './terminal.js';
import { createFilesPage } from './files.js';
import { createAssistantPage } from './assistant.js';
import { createSettingsPage } from './settings.js';

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

// ---- shell ----------------------------------------------------------------------
function renderShell() {
  render($('#app'), html`
    <nav class="rail" aria-label="主导航">
      <div class="rail-brand"><img src="./termlo.svg" alt="Termlo" width="28" height="28"></div>
      <div class="rail-nav">
        ${PAGES.map(p => html`<a class="rail-item" href="#${p.id}" data-page="${p.id}">${ico(p.icon)}${p.label}</a>`)}
      </div>
      <div class="rail-bottom">
        <a class="rail-item" href="#settings" data-page="settings">${ico('settings')}设置</a>
      </div>
    </nav>
    <header class="topbar">
      <h1 class="topbar-title" id="page-title">主机</h1>
      <span class="toolbar-spacer"></span>
      <button class="search-trigger" type="button" id="search-trigger" aria-keyshortcuts="Control+K">
        ${ico('search', 'sm')}<span>搜索主机或操作…</span><kbd class="kbd">Ctrl K</kbd>
      </button>
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
        ${needsPassword ? html`<label class="check"><input type="checkbox" name="remember">记住密码（用系统加密保存在本机）</label>` : ''}`,
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
    body: html`<p class="prompt-detail">${options.detail || ''}</p>`,
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

// ---- command palette (Ctrl K) -------------------------------------------------------
async function palette() {
  const hosts = store.get().hosts;
  const actions = [
    ...hosts.flatMap(h => [
      { label: `打开终端 · ${h.name}`, hint: h.address, icon: 'terminal', run: () => navigate('terminal', { hostId: h.id }) },
      { label: `浏览文件 · ${h.name}`, hint: h.address, icon: 'folder', run: () => navigate('files', { hostId: h.id }) },
      { label: `交给助手 · ${h.name}`, hint: h.address, icon: 'assistant', run: () => navigate('assistant', { hostIds: [h.id] }) },
    ]),
    { label: '添加主机', icon: 'plus', run: () => navigate('hosts', { add: true }) },
    { label: '新建助手任务', icon: 'assistant', run: () => navigate('assistant', { compose: true }) },
    { label: '模型设置', icon: 'settings', run: () => navigate('settings', { section: 'model' }) },
    { label: '切换主题', icon: 'sun', run: () => setPreferences({ theme: store.get().preferences.theme === 'light' ? 'dark' : 'light' }) },
  ];
  let chosen = null;
  await dialog({
    title: '搜索',
    body: html`
      <div class="input-group">${ico('search')}<input class="input" id="palette-input" type="text" role="combobox" aria-controls="palette-list" aria-expanded="true" aria-label="搜索主机或操作" placeholder="输入主机名、地址或操作…" autocomplete="off"></div>
      <ul class="list palette-list" id="palette-list" role="listbox" aria-label="结果"></ul>`,
    actions: [],
    onOpen(element) {
      const input = $('#palette-input', element), list = $('#palette-list', element);
      let matches = [], active = 0;
      const draw = () => {
        const q = input.value.trim().toLowerCase();
        matches = actions.filter(a => !q || (a.label + ' ' + (a.hint || '')).toLowerCase().includes(q)).slice(0, 12);
        active = Math.min(active, Math.max(0, matches.length - 1));
        render(list, matches.length
          ? html`${matches.map((a, i) => html`<li class="row" role="option" data-index="${i}" aria-selected="${i === active}">${ico(a.icon, 'sm')}<div class="row-main"><span class="row-title">${a.label}</span></div>${a.hint ? html`<span class="row-aside mono">${a.hint}</span>` : ''}</li>`)}`
          : html`<li class="row"><span class="text-muted">没有匹配的结果</span></li>`);
      };
      const pick = index => { chosen = matches[index]; element.close(); };
      input.addEventListener('input', () => { active = 0; draw(); });
      input.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown') { active = Math.min(active + 1, matches.length - 1); draw(); event.preventDefault(); }
        if (event.key === 'ArrowUp') { active = Math.max(active - 1, 0); draw(); event.preventDefault(); }
        if (event.key === 'Enter') { event.preventDefault(); if (matches[active]) pick(active); }
      });
      on(list, 'click', '[data-index]', (_e, row) => pick(Number(row.dataset.index)));
      draw();
      input.focus();
    },
  });
  chosen?.run();
}

// ---- boot -----------------------------------------------------------------------------
async function boot() {
  renderShell();
  const initial = await api.init();
  store.set({ hosts: initial.hosts, preferences: initial.preferences, version: initial.version });
  applyTheme();

  pages.hosts = createHostsPage($('#view-hosts'), app);
  pages.terminal = createTerminalPage($('#view-terminal'), app);
  pages.files = createFilesPage($('#view-files'), app);
  pages.assistant = createAssistantPage($('#view-assistant'), app);
  pages.settings = createSettingsPage($('#view-settings'), app);
  hydrateIcons(document.body);

  api.onEvent(event => {
    if (event.type === 'hosts') store.set({ hosts: event.hosts });
    if (event.type === 'app-prompt') showPrompt(event);
    if (event.type === 'app-prompt-closed') { const element = openPrompts.get(event.id); openPrompts.delete(event.id); element?.close(); }
    for (const handler of listeners.get(event.type) || []) handler(event);
  });

  $('#theme-toggle').addEventListener('click', () => setPreferences({ theme: store.get().preferences.theme === 'light' ? 'dark' : 'light' }));
  $('#search-trigger').addEventListener('click', palette);
  on($('.rail'), 'click', '[data-page]', (event, item) => { event.preventDefault(); navigate(item.dataset.page); });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); palette(); }
  });

  const migrated = initial.migration;
  if (migrated) {
    toast(`已从旧版本导入${migrated.hosts ? ` ${migrated.hosts} 台其他项目的主机` : ''}${migrated.settings ? '和模型设置' : ''}。`, { tone: 'success', timeout: 8000 });
  }

  navigate(location.hash.slice(1) || 'hosts');
  document.documentElement.dataset.ready = 'true';
}

boot().catch(error => {
  document.body.textContent = '启动失败：' + (error?.message || error);
});

export { escape };
