// Terminal: tabs of SSH shells (xterm.js), search, copy/paste, "ask the assistant".
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { api, html, ico, render, $, $$, on, toast, fail, menu, contextMenu, message, uid } from './ui.js';
import { SemanticHighlights } from './terminal-highlights.js';
import { view } from './telemetry.js';
import { createAsk, trackLine, questionOf } from './terminal-ask.js';

// Terminal fonts offered in settings. JetBrains Mono ships with the app.
export const TERMINAL_FONTS = {
  jetbrains: { label: 'JetBrains Mono（内置）', short: 'JetBrains', family: '"JetBrains Mono", "Cascadia Code", Consolas, monospace' },
  cascadia: { label: 'Cascadia Code', short: 'Cascadia', family: '"Cascadia Code", "Cascadia Mono", Consolas, monospace' },
  system: { label: '系统等宽字体', short: '系统', family: 'Consolas, "SF Mono", Menlo, monospace' },
};
const fontFamily = key => (TERMINAL_FONTS[key] || TERMINAL_FONTS.jetbrains).family;
const fontsReady = document.fonts.load('14px "JetBrains Mono"').catch(() => {});

const AUTH_FAILURE = /authentication|认证|密码|passphrase|All configured authentication methods failed/i;

function terminalTheme() {
  const style = getComputedStyle(document.documentElement);
  const get = name => style.getPropertyValue(name).trim();
  const ansi = name => get('--ansi-' + name);
  return {
    background: get('--terminal-bg'),
    foreground: get('--terminal-text'),
    cursor: get('--accent'),
    cursorAccent: get('--terminal-bg'),
    selectionBackground: get('--terminal-selection'),
    black: ansi('black'), red: ansi('red'), green: ansi('green'), yellow: ansi('yellow'),
    blue: ansi('blue'), magenta: ansi('magenta'), cyan: ansi('cyan'), white: ansi('white'),
    brightBlack: ansi('bright-black'), brightRed: ansi('bright-red'), brightGreen: ansi('bright-green'), brightYellow: ansi('bright-yellow'),
    brightBlue: ansi('bright-blue'), brightMagenta: ansi('bright-magenta'), brightCyan: ansi('bright-cyan'), brightWhite: ansi('bright-white'),
  };
}

export function createTerminalPage(element, app) {
  const { store } = app;
  const tabs = [];   // { id, hostId, term, fit, search, pane, status }
  let active = null;

  render(element, html`
    <div class="terminal-page">
      <div class="terminal-tabs" role="tablist" aria-label="终端" id="term-tabs"></div>
      <div class="terminal-search" id="term-search" hidden>
        <div class="input-group">${ico('search', 'sm')}<input class="input" id="term-search-input" type="text" placeholder="在终端中查找…" aria-label="在终端中查找" autocomplete="off"></div>
        <button class="btn btn-icon btn-sm btn-ghost" type="button" data-search="prev" aria-label="上一个" title="上一个 (Shift+Enter)">${ico('chevron-up', 'sm')}</button>
        <button class="btn btn-icon btn-sm btn-ghost" type="button" data-search="next" aria-label="下一个" title="下一个 (Enter)">${ico('chevron-down', 'sm')}</button>
        <button class="btn btn-icon btn-sm btn-ghost" type="button" data-search="close" aria-label="关闭查找" title="关闭查找 (Esc)">${ico('close', 'sm')}</button>
      </div>
      <div class="terminal-panes" id="term-panes"></div>
      <div class="terminal-status" id="term-status" hidden></div>
      <div class="terminal-empty" id="term-empty"></div>
    </div>`);
  const tabStrip = $('#term-tabs', element);
  const panes = $('#term-panes', element);
  const empty = $('#term-empty', element);
  const searchBar = $('#term-search', element);
  const searchInput = $('#term-search-input', element);
  const statusBar = $('#term-status', element);
  const asker = createAsk({ host: element.querySelector('.terminal-page'), before: statusBar, app, onResize: () => fitTab(active) });

  // Live state of the active tab's host under the terminal.
  function drawStatus() {
    statusBar.hidden = !active;
    if (!active) return;
    const host = store.get().hosts.find(h => h.id === active.hostId);
    const state = { ready: 'connected', connecting: 'connecting', closed: 'disconnected', failed: 'failed' }[active.status] || 'connecting';
    const label = { connected: '已连接', connecting: '连接中…', disconnected: '已断开', failed: '连接失败' }[state];
    render(statusBar, html`
      <span class="status" data-state="${state}"><span class="dot"></span>${label}</span>
      ${host?.operatingSystem?.name ? html`<span class="terminal-status-os truncate">${host.operatingSystem.name}</span>` : ''}
      <div class="terminal-telemetry" data-telemetry="${active.hostId}" data-variant="bar">${active.status === 'ready' ? view('bar', app.telemetry.get(active.hostId), app.telemetry.history(active.hostId)) : ''}</div>`);
  }
  app.telemetry.subscribe(hostId => { if (active?.hostId === hostId && active.status === 'ready') app.telemetry.patch(statusBar, hostId); });

  function publish() {
    const others = (store.get().sessions || []).filter(s => s.kind !== 'terminal');
    store.set({ sessions: [...others, ...tabs.map(t => ({ id: t.id, hostId: t.hostId, kind: 'terminal', status: t.status }))] });
  }

  function drawTabs() {
    render(tabStrip, html`
      ${tabs.map(t => html`
        <div class="terminal-tab" role="tab" tabindex="${t === active ? 0 : -1}" aria-selected="${t === active}" data-tab="${t.id}" title="${app.hostLabel(t.hostId)}">
          <span class="status" data-state="${{ ready: 'connected', connecting: 'connecting', closed: 'disconnected', failed: 'failed' }[t.status] || 'connecting'}"><span class="dot"></span></span>
          <span class="truncate">${app.hostLabel(t.hostId)}</span>
          <button class="tab-close" type="button" data-close="${t.id}" aria-label="关闭 ${app.hostLabel(t.hostId)}" title="关闭">${ico('close', 'sm')}</button>
        </div>`)}
      <button class="btn btn-icon btn-sm btn-ghost terminal-new" type="button" data-new aria-label="新建终端" title="新建终端">${ico('plus', 'sm')}</button>
      ${tabs.length ? html`<button class="btn btn-sm btn-ghost terminal-ask" type="button" data-ask-open title="也可以直接在命令行输入 # 加问题，回车">${ico('assistant', 'sm')}问 AI</button>` : ''}`);
    empty.hidden = tabs.length > 0;
    panes.hidden = tabs.length === 0;
    drawStatus();
    if (!tabs.length) drawEmpty();
  }

  function drawEmpty() {
    const hosts = store.get().hosts;
    render(empty, html`
      <div class="card empty empty-page">
        <span class="empty-icon">${ico('terminal', 'lg')}</span>
        <h2 class="empty-title">打开一个终端</h2>
        ${hosts.length ? html`

          <ul class="list pick-list">${hosts.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).map(h => html`
            <li class="row"><button class="row-button" type="button" data-open="${h.id}">${ico('host', 'sm')}<span class="row-main"><span class="row-title">${h.name}</span><span class="row-meta mono">${h.username}@${h.address}</span></span>${ico('arrow-right', 'sm')}</button></li>`)}</ul>`
        : html`<button class="btn btn-primary" type="button" data-add>${ico('plus')}添加主机</button>`}
      </div>`);
  }

  function select(tab) {
    if (asker.openFor && asker.openFor !== tab) asker.close();
    active = tab;
    for (const t of tabs) t.pane.hidden = t !== tab;
    drawTabs();
    if (tab) requestAnimationFrame(() => { fitTab(tab); tab.term.focus(); });
  }

  function fitTab(tab) {
    if (!tab || tab.pane.hidden || !tab.pane.clientWidth) return;
    try {
      tab.fit.fit();
      if (tab.status === 'ready') api.resize(tab.id, tab.term.cols, tab.term.rows).catch(() => {});
    } catch { /* not visible yet */ }
  }

  async function connect(tab, { force = false, reason = '' } = {}) {
    const credentials = await app.credentials(tab.hostId, { force, reason });
    if (!credentials) { tab.status = 'closed'; tab.term.writeln('\r\n\x1b[2m已取消连接。按 Enter 重新连接。\x1b[0m'); drawTabs(); publish(); return; }
    tab.status = 'connecting';
    drawTabs(); publish();
    tab.id = uid('t');
    tab.pane.dataset.pane = tab.id;
    try {
      await api.connect(tab.id, tab.hostId, credentials, { cols: tab.term.cols, rows: tab.term.rows });
      tab.status = 'ready';
      tab.line = '';
      drawTabs(); publish();
      fitTab(tab);
      hintOnce(tab);
    } catch (error) {
      const text = message(error);
      tab.status = 'failed';
      drawTabs(); publish();
      if (AUTH_FAILURE.test(text)) return connect(tab, { force: true, reason: '登录失败，请检查后重试。' });
      tab.term.writeln(`\r\n\x1b[31m连接失败：${text}\x1b[0m`);
      tab.term.writeln('\x1b[2m按 Enter 重新连接。\x1b[0m');
    }
  }

  function open(hostId) {
    const pane = document.createElement('div');
    pane.className = 'terminal-pane';
    panes.append(pane);
    const preferences = store.get().preferences;
    const term = new Terminal({
      fontFamily: fontFamily(preferences.terminalFont),
      fontSize: preferences.terminalFontSize || 14,
      lineHeight: 1.25,
      fontWeightBold: 700,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      scrollback: 10000,
      allowProposedApi: true,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(pane);
    const highlights = new SemanticHighlights(term, preferences.terminalHighlights !== false);
    const tab = { id: uid('t'), hostId, term, fit, search, pane, highlights, status: 'connecting', line: '' };
    // The bundled font may still be loading: re-measure once it is ready.
    fontsReady.then(() => { term.options.fontFamily = fontFamily(store.get().preferences.terminalFont); fitTab(tab); });
    tabs.push(tab);

    term.onData(data => {
      if (tab.status === 'ready') {
        // "# 问题" + Enter: the shell gets it as a comment (does nothing, and the question stays
        // in the scrollback); the question goes to the model.
        const question = data === '\r' ? questionOf(tab) : null;
        if (question) { api.write(tab.id, '\r'); tab.line = ''; asker.ask(tab, question); return; }
        trackLine(tab, data);
        api.write(tab.id, data);
      }
      else if ((tab.status === 'closed' || tab.status === 'failed') && data === '\r') connect(tab);
    });
    term.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.shiftKey && key === 'c') { copySelection(tab); return false; }
      if (event.ctrlKey && event.shiftKey && key === 'v') { paste(tab); return false; }
      if (event.ctrlKey && !event.shiftKey && key === 'f') { openSearch(); return false; }
      return true;
    });
    pane.addEventListener('contextmenu', event => {
      const selection = term.getSelection();
      contextMenu(event, [
        { label: '复制', icon: 'copy', hint: 'Ctrl Shift C', run: () => copySelection(tab) },
        { label: '粘贴', icon: 'clipboard', hint: 'Ctrl Shift V', run: () => paste(tab) },
        ...(selection.trim() ? [
          { label: '问 AI', icon: 'assistant', run: () => asker.ask(tab, '解释这段输出；有问题的话给出处理命令', selection.trim().slice(-4000)) },
          { label: '交给助手处理', icon: 'play', run: () => askAssistant(tab, selection) },
        ] : [{ label: '问 AI', icon: 'assistant', hint: '# 问题 ↵', run: () => asker.open(tab) }]),
        'separator',
        { label: '查找', icon: 'search', hint: 'Ctrl F', run: openSearch },
        { label: '清屏', icon: 'refresh', run: () => term.clear() },
      ], term.textarea);
    });

    select(tab);
    connect(tab);
    return tab;
  }

  // First terminal ever: one tip about "# 问题".
  function hintOnce(tab) {
    try {
      if (localStorage.getItem('termlo.askHint')) return;
      localStorage.setItem('termlo.askHint', '1');
    } catch { return; }
    toast('小技巧：命令行里输入 # 加一句话回车，AI 会给出命令', { timeout: 9000 });
  }

  async function copySelection(tab) {
    const text = tab.term.getSelection();
    if (!text) return;
    try { await api.writeClipboard(text); } catch (error) { fail(error); }
  }

  async function paste(tab) {
    if (tab.status !== 'ready') return;
    try { const text = await api.readClipboard(); if (text) tab.term.paste(text); } catch (error) { fail(error); }
  }

  function askAssistant(tab, selection) {
    const excerpt = selection.trim().slice(-4000);
    app.navigate('assistant', {
      hostIds: [tab.hostId],
      prompt: `这是 ${app.hostLabel(tab.hostId)} 终端里的输出，帮我看看是什么问题，需要的话处理一下：\n\n${excerpt}`,
    });
  }

  function close(tab) {
    if (asker.openFor === tab) asker.close();
    api.disconnect(tab.id).catch(() => {});
    tab.highlights.dispose();
    tab.term.dispose();
    tab.pane.remove();
    const index = tabs.indexOf(tab);
    tabs.splice(index, 1);
    publish();
    select(tabs[Math.min(index, tabs.length - 1)] || null);
  }

  // ---- search ----------------------------------------------------------------------
  function openSearch() {
    if (!active) return;
    searchBar.hidden = false;
    const selection = active.term.getSelection();
    if (selection && !selection.includes('\n')) searchInput.value = selection;
    searchInput.select();
    searchInput.focus();
  }
  function find(direction) {
    if (!active || !searchInput.value) return;
    const options = { caseSensitive: false, decorations: { matchOverviewRuler: '#888', activeMatchColorOverviewRuler: '#888' } };
    if (direction === 'prev') active.search.findPrevious(searchInput.value, options);
    else active.search.findNext(searchInput.value, options);
  }
  function closeSearch() {
    searchBar.hidden = true;
    active?.search.clearDecorations();
    active?.term.focus();
  }
  searchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); find(event.shiftKey ? 'prev' : 'next'); }
    if (event.key === 'Escape') { event.preventDefault(); closeSearch(); }
  });
  searchInput.addEventListener('input', () => find('next'));
  on(searchBar, 'click', '[data-search]', (_e, button) => {
    const action = button.dataset.search;
    if (action === 'close') closeSearch(); else find(action);
  });

  // ---- events --------------------------------------------------------------------------
  on(tabStrip, 'click', '[data-close]', (event, button) => { event.stopPropagation(); const tab = tabs.find(t => t.id === button.dataset.close); if (tab) close(tab); });
  on(tabStrip, 'click', '[data-ask-open]', () => { if (active) asker.open(active); });
  on(tabStrip, 'click', '[data-tab]', (_e, element) => select(tabs.find(t => t.id === element.dataset.tab)));
  on(tabStrip, 'click', '[data-new]', async (_e, button) => {
    const hosts = store.get().hosts.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    if (!hosts.length) return app.navigate('hosts', { add: true });
    menu(button, hosts.slice(0, 20).map(h => ({ label: h.name, icon: 'host', run: () => open(h.id) })));
  });
  tabStrip.addEventListener('keydown', event => {
    const index = tabs.indexOf(active);
    if (event.key === 'ArrowRight' && tabs.length) { select(tabs[(index + 1) % tabs.length]); $(`[data-tab="${active.id}"]`, tabStrip)?.focus(); }
    if (event.key === 'ArrowLeft' && tabs.length) { select(tabs[(index - 1 + tabs.length) % tabs.length]); $(`[data-tab="${active.id}"]`, tabStrip)?.focus(); }
  });
  on(empty, 'click', '[data-open]', (_e, button) => open(button.dataset.open));
  on(empty, 'click', '[data-add]', () => app.navigate('hosts', { add: true }));

  const byId = id => tabs.find(t => t.id === id);
  const decode = data => Uint8Array.from(atob(data), c => c.charCodeAt(0));
  app.on('data', event => byId(event.id)?.term.write(decode(event.data)));
  app.on('stage', event => byId(event.id)?.term.writeln(`\x1b[2m${event.message}\x1b[0m`));
  app.on('fault', event => byId(event.id)?.term.writeln(`\r\n\x1b[31m${event.message}\x1b[0m`));
  app.on('status', event => {
    const tab = byId(event.id);
    if (!tab || event.status !== 'closed' || tab.status !== 'ready') return;
    tab.status = 'closed';
    tab.term.writeln('\r\n\x1b[2m连接已断开。按 Enter 重新连接。\x1b[0m');
    drawTabs(); publish();
  });

  new ResizeObserver(() => fitTab(active)).observe(panes);
  new MutationObserver(() => { const theme = terminalTheme(); for (const t of tabs) { t.term.options.theme = theme; t.highlights.refreshColors(); } })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  store.subscribe(state => {
    const { terminalFontSize: size, terminalFont, terminalHighlights } = state.preferences;
    const family = fontFamily(terminalFont);
    for (const t of tabs) {
      if ((size && t.term.options.fontSize !== size) || t.term.options.fontFamily !== family) {
        if (size) t.term.options.fontSize = size;
        t.term.options.fontFamily = family;
        fitTab(t);
      }
      if (t.highlights.enabled !== (terminalHighlights !== false)) t.highlights.setEnabled(terminalHighlights !== false);
    }
    if (!tabs.length && !element.hidden) drawEmpty();
  });

  drawTabs();
  return {
    // Close every terminal of a host (the "disconnect" on a live host card).
    closeHost(hostId) {
      for (const tab of tabs.filter(t => t.hostId === hostId)) close(tab);
    },
    show(params) {
      if (params?.hostId) open(params.hostId);
      else if (active) requestAnimationFrame(() => { fitTab(active); active.term.focus(); });
    },
  };
}
