// Hosts: grouped cards or list, quick actions, add/edit, ~/.ssh/config import.
import { api, html, raw, ico, render, $, $$, on, dialog, confirm, toast, fail, menu, selectable, bytes } from './ui.js';
import { view } from './telemetry.js';

const OS_LABEL = host => host.operatingSystem?.name || '';

export function createHostsPage(element, app) {
  const { store } = app;
  let group = '全部';
  let query = '';
  let shownOnline = new Set();   // hosts drawn as online in the last render

  function connectedIds() {
    return new Set(store.get().hosts.map(h => h.id).filter(id => app.telemetry.online(id)));
  }

  function groups(hosts) {
    const counts = new Map();
    for (const host of hosts) counts.set(host.group || '未分组', (counts.get(host.group || '未分组') || 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
  }

  function visible(hosts) {
    const q = query.trim().toLowerCase();
    return hosts
      .filter(h => group === '全部' || (h.group || '未分组') === group)
      .filter(h => !q || [h.name, h.address, h.username, h.group, h.tags].join(' ').toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  // Hardware facts learned on a previous connection, shown while a host is offline.
  function specs(host) {
    const s = host.specifications || {};
    const parts = [
      s.cpuCount ? `${s.cpuCount} 核` : '',
      s.memoryTotal ? `${bytes(s.memoryTotal)} 内存` : '',
      s.rootTotal ? `${bytes(s.rootTotal)} 磁盘` : '',
    ].filter(Boolean);
    return parts;
  }

  function card(host, online) {
    const target = `${host.username}@${host.address}${host.port !== 22 ? ':' + host.port : ''}`;
    const jump = host.jumpHostId ? app.hostLabel(host.jumpHostId) : '';
    const facts = specs(host);
    const telemetry = app.telemetry;
    return html`
      <article class="host-card" data-host="${host.id}" data-online="${online}">
        <header class="host-card-head">
          <span class="host-pulse" aria-hidden="true"></span>
          <div class="host-card-main">
            <h3 class="host-card-title truncate"><a class="card-link" href="#terminal" data-action="terminal" title="打开终端">${host.name}</a></h3>
            <p class="host-card-target mono truncate" translate="no">${target}</p>
          </div>
          ${OS_LABEL(host) ? html`<span class="host-os truncate" title="${OS_LABEL(host)}">${OS_LABEL(host).replace(/ LTS$/, '')}</span>` : ''}
        </header>
        ${online
          ? html`<div class="host-telemetry" data-telemetry="${host.id}" data-variant="card">${view('card', telemetry.get(host.id), telemetry.history(host.id))}</div>`
          : html`<div class="host-idle">
              ${facts.length ? html`<span class="host-facts">${facts.map(f => html`<span>${f}</span>`)}</span>` : ''}
              <div class="host-idle-action">
                <button class="btn btn-sm" type="button" data-action="terminal">${ico('terminal', 'sm')}连接</button>
                <span class="text-xs text-muted">连接后显示实时状态</span>
              </div>
            </div>`}
        <footer class="host-card-foot">
          <div class="host-badges">
            ${online ? html`<span class="status" data-state="connected"><span class="dot"></span>在线</span>` : ''}
            ${jump ? html`<span class="badge badge-outline" title="经由跳板机连接">经 ${jump}</span>` : ''}
            ${host.auth === 'key' ? html`<span class="badge badge-outline">${ico('key', 'sm')}密钥</span>` : ''}
          </div>
          <div class="quick-actions">
            <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="terminal" aria-label="打开终端" title="打开终端">${ico('terminal', 'sm')}</button>
            <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="files" aria-label="浏览文件" title="浏览文件">${ico('folder', 'sm')}</button>
            <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="assistant" aria-label="交给助手" title="交给助手">${ico('assistant', 'sm')}</button>
            <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="more" aria-label="更多操作" title="更多操作">${ico('more', 'sm')}</button>
          </div>
        </footer>
      </article>`;
  }

  function row(host, connected) {
    return html`
      <li class="row host-row" data-host="${host.id}">
        <span class="status-dot-slot">${connected ? html`<span class="status" data-state="connected" title="已连接"><span class="dot"></span></span>` : ico('host', 'sm')}</span>
        <div class="row-main">
          <a class="row-title card-link" href="#terminal" data-action="terminal">${host.name}</a>
          <span class="row-meta mono" translate="no">${host.username}@${host.address}${host.port !== 22 ? ':' + host.port : ''}</span>
        </div>
        <span class="row-aside">${OS_LABEL(host)}</span>
        <span class="row-aside">${host.group || '未分组'}</span>
        <div class="quick-actions">
          <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="files" aria-label="浏览文件" title="浏览文件">${ico('folder', 'sm')}</button>
          <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="assistant" aria-label="交给助手" title="交给助手">${ico('assistant', 'sm')}</button>
          <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="more" aria-label="更多操作" title="更多操作">${ico('more', 'sm')}</button>
        </div>
      </li>`;
  }

  function draw() {
    const { hosts, preferences } = store.get();
    const view = preferences.hostView || 'grid';
    if (!hosts.length) {
      render(element, html`
        <div class="page">
          <div class="card empty empty-page">
            <span class="empty-icon">${ico('host', 'lg')}</span>
            <h2 class="empty-title">添加第一台服务器</h2>
            <p class="empty-text">添加后就能打开终端、管理文件，或者把运维任务交给助手。</p>
            <div class="btn-group">
              <button class="btn btn-primary" type="button" data-action="add">${ico('plus')}添加主机</button>
              <button class="btn" type="button" data-action="import">导入 ~/.ssh/config</button>
            </div>
          </div>
        </div>`);
      return;
    }
    const connected = connectedIds();
    shownOnline = connected;
    const groupList = groups(hosts);
    if (group !== '全部' && !groupList.some(([name]) => name === group)) group = '全部';
    const list = visible(hosts);
    const focused = document.activeElement?.id === 'host-filter';
    render(element, html`
      <div class="page">
        <div class="page-header">
          <h2 class="page-title">主机<span class="count">${hosts.length} 台</span>${connected.size ? html`<span class="online-count"><span class="dot"></span>${connected.size} 台在线</span>` : ''}</h2>
          <div class="input-group host-filter">${ico('search', 'sm')}<input class="input" id="host-filter" type="search" value="${query}" placeholder="筛选主机…" aria-label="筛选主机" autocomplete="off"></div>
          <div class="segmented" role="radiogroup" aria-label="显示方式" id="host-view">
            <button type="button" role="radio" data-view="grid" aria-checked="${view === 'grid'}" aria-label="卡片" title="卡片">${ico('view-grid', 'sm')}</button>
            <button type="button" role="radio" data-view="list" aria-checked="${view === 'list'}" aria-label="列表" title="列表">${ico('view-list', 'sm')}</button>
          </div>
          <button class="btn" type="button" data-action="import">导入</button>
          <button class="btn btn-primary" type="button" data-action="add">${ico('plus')}添加主机</button>
        </div>
        ${groupList.length > 1 || groupList[0]?.[0] !== '未分组' ? html`
          <div class="host-groups-bar">
            <div class="tabs" role="tablist" aria-label="主机分组" id="host-groups">
              <button class="tab" type="button" role="tab" data-group="全部" aria-selected="${group === '全部'}">全部<span class="count">${hosts.length}</span></button>
              ${groupList.map(([name, count]) => html`<button class="tab" type="button" role="tab" data-group="${name}" aria-selected="${group === name}">${name}<span class="count">${count}</span></button>`)}
            </div>
            ${group !== '全部' && group !== '未分组' ? html`<button class="btn btn-sm btn-ghost" type="button" data-action="group-menu" title="重命名或解散分组“${group}”">${ico('more', 'sm')}管理分组</button>` : ''}
          </div>` : ''}
        ${!list.length ? html`<p class="text-muted empty-inline">没有匹配的主机。</p>`
          : view === 'list' ? html`<ul class="list host-list">${list.map(h => row(h, connected.has(h.id)))}</ul>`
          : html`<div class="host-grid">${list.map(h => card(h, connected.has(h.id)))}</div>`}
      </div>`);
    const tabs = $('#host-groups', element);
    if (tabs) selectable(tabs, '[role="tab"]', 'aria-selected', tab => { group = tab.dataset.group; draw(); $(`[data-group="${CSS.escape(group)}"]`, element)?.focus(); });
    selectable($('#host-view', element), '[role="radio"]', 'aria-checked', button => app.setPreferences({ hostView: button.dataset.view }));
    if (focused) { const input = $('#host-filter', element); input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }

  // ---- add / edit ---------------------------------------------------------------------
  async function edit(host, draftValues) {
    const { hosts } = store.get();
    const jumpCandidates = hosts.filter(h => h.id !== host?.id);
    const groupNames = [...new Set(hosts.map(h => h.group).filter(Boolean))];
    const v = { ...(host || {}), ...(draftValues || {}) };
    const isKey = v.auth === 'key';
    const { value, data, form } = await dialog({
      title: host ? `编辑 ${host.name}` : '添加主机',
      wide: true,
      body: html`
        <div class="field-row">
          <div class="field">
            <label class="field-label" for="h-address">地址</label>
            <input class="input mono" id="h-address" name="address" value="${v.address || ''}" placeholder="IP 或域名…" required spellcheck="false" autocomplete="off" autofocus>
          </div>
          <div class="field field-port">
            <label class="field-label" for="h-port">端口</label>
            <input class="input mono num" id="h-port" name="port" inputmode="numeric" value="${v.port || 22}" required pattern="[0-9]{1,5}">
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label class="field-label" for="h-user">用户名</label>
            <input class="input mono" id="h-user" name="username" value="${v.username || 'root'}" required spellcheck="false" autocomplete="off">
          </div>
          <div class="field">
            <label class="field-label" for="h-name">名称<span class="optional">可选</span></label>
            <input class="input" id="h-name" name="name" value="${v.name || ''}" placeholder="默认使用地址…" autocomplete="off">
          </div>
        </div>
        <div class="field">
          <span class="field-label" id="h-auth-label">登录方式</span>
          <div class="segmented" role="radiogroup" aria-labelledby="h-auth-label" id="h-auth">
            <button type="button" role="radio" data-auth="password" aria-checked="${!isKey}">密码</button>
            <button type="button" role="radio" data-auth="key" aria-checked="${isKey}">私钥</button>
          </div>
          <input type="hidden" name="auth" value="${isKey ? 'key' : 'password'}">
        </div>
        <div class="field" data-for="password" ${isKey ? raw('hidden') : ''}>
          <label class="field-label" for="h-password">密码<span class="optional">${host?.hasPassword ? '已保存，留空则不变' : '可选，留空则每次连接时询问'}</span></label>
          <input class="input" id="h-password" name="password" type="password" autocomplete="new-password">
          <label class="check"><input type="checkbox" name="rememberPassword" ${!host || host.hasPassword ? raw('checked') : ''}>记住密码（用系统加密保存在本机）</label>
        </div>
        <div class="field" data-for="key" ${isKey ? '' : raw('hidden')}>
          <label class="field-label" for="h-key">私钥文件</label>
          <div class="input-with-button">
            <input class="input mono" id="h-key" name="keyPath" value="${v.keyPath && v.keyPath !== '__TERMLO_KEY_REQUIRED__' ? v.keyPath : ''}" placeholder="~/.ssh/id_ed25519…" spellcheck="false" autocomplete="off">
            <button class="btn" type="button" data-pick-key>选择…</button>
          </div>
        </div>
        <details class="disclosure" ${v.group || v.jumpHostId ? raw('open') : ''}>
          <summary>更多选项</summary>
          <div class="field-row">
            <div class="field">
              <label class="field-label" for="h-group">分组<span class="optional">可选</span></label>
              <input class="input" id="h-group" name="group" list="h-groups" value="${v.group && v.group !== '未分组' ? v.group : ''}" placeholder="例如 生产环境…" autocomplete="off">
              <datalist id="h-groups">${groupNames.map(g => html`<option value="${g}">`)}</datalist>
            </div>
            <div class="field">
              <label class="field-label" for="h-jump">跳板机<span class="optional">可选</span></label>
              <span class="select-wrap"><select class="select" id="h-jump" name="jumpHostId">
                <option value="">直接连接</option>
                ${jumpCandidates.map(h => html`<option value="${h.id}" ${v.jumpHostId === h.id ? raw('selected') : ''}>${h.name}</option>`)}
              </select></span>
            </div>
          </div>
        </details>`,
      actions: [{ label: '取消', value: 'cancel', tone: 'ghost' }, { label: host ? '保存' : '添加主机', value: 'ok', tone: 'primary' }],
      onOpen(dialogElement) {
        const authInput = $('input[name="auth"]', dialogElement);
        selectable($('#h-auth', dialogElement), '[role="radio"]', 'aria-checked', button => {
          authInput.value = button.dataset.auth;
          $('[data-for="password"]', dialogElement).hidden = button.dataset.auth !== 'password';
          $('[data-for="key"]', dialogElement).hidden = button.dataset.auth !== 'key';
          $('#h-key', dialogElement).required = button.dataset.auth === 'key';
        });
        $('#h-key', dialogElement).required = isKey;
        $('[data-pick-key]', dialogElement).addEventListener('click', async () => {
          const file = await api.pickKey();
          if (file) $('#h-key', dialogElement).value = file;
        });
      },
    });
    if (value !== 'ok') return;
    const input = {
      ...(host ? { id: host.id } : {}),
      name: data.name.trim() || data.address.trim(),
      address: data.address.trim(),
      port: Number(data.port),
      username: data.username.trim(),
      auth: data.auth,
      keyPath: data.auth === 'key' ? data.keyPath.trim() : '',
      group: data.group?.trim() || '',
      jumpHostId: data.jumpHostId || '',
      tags: host?.tags || '',
      ...(data.password ? { password: data.password, rememberPassword: !!data.rememberPassword } : {}),
      ...(host?.hasPassword && !data.rememberPassword ? { clearPassword: true } : {}),
    };
    try {
      const hosts = await api.saveHost(input);
      store.set({ hosts });
      toast(host ? `已保存 ${input.name}` : `已添加 ${input.name}`, { tone: 'success' });
    } catch (error) {
      fail(error);
      if (form) edit(host, input);
    }
  }

  // ---- groups ------------------------------------------------------------------------
  // Ask for a group name; existing names are offered. Returns the trimmed name, '' for 未分组, or null.
  async function askGroup({ title, value = '', action, help, allowEmpty = false }) {
    const names = groups(store.get().hosts).map(([name]) => name).filter(name => name !== '未分组');
    const { value: choice, form } = await dialog({
      title,
      body: html`
        <div class="field">
          <label class="field-label" for="g-name">分组名称</label>
          <input class="input" id="g-name" name="group" list="g-names" value="${value}" maxlength="200" placeholder="例如 生产环境…" autocomplete="off" ${allowEmpty ? '' : raw('required')}>
          <datalist id="g-names">${names.map(name => html`<option value="${name}">`)}</datalist>
          ${help ? html`<p class="field-help">${help}</p>` : ''}
        </div>`,
      actions: [{ label: '取消', value: 'cancel', tone: 'ghost' }, { label: action, value: 'ok', tone: 'primary' }],
      onOpen: element => $('#g-name', element).select(),
    });
    return choice === 'ok' ? form.group.value.trim() : null;
  }

  async function moveHosts(ids, name, message) {
    try {
      store.set({ hosts: await api.setHostGroup(ids, name) });
      toast(message, { tone: 'success' });
    } catch (error) { fail(error); }
  }

  function groupMenu(anchor) {
    const name = group;
    const ids = store.get().hosts.filter(h => (h.group || '未分组') === name).map(h => h.id);
    menu(anchor, [
      { label: '重命名分组…', icon: 'edit', run: async () => {
        const next = await askGroup({ title: `重命名分组“${name}”`, value: name, action: '重命名', help: '填已有的分组名会把两个分组合并。' });
        if (!next || next === name) return;
        group = next;
        await moveHosts(ids, next, `已重命名为“${next}”`);
      } },
      { label: '解散分组', icon: 'trash', danger: true, run: async () => {
        const ok = await confirm({ title: `解散分组“${name}”？`, text: `其中 ${ids.length} 台主机会移到“未分组”，主机本身不会删除。`, action: '解散分组' });
        if (!ok) return;
        group = '全部';
        await moveHosts(ids, '', `已解散分组“${name}”`);
      } },
    ]);
  }

  async function remove(host) {
    const ok = await confirm({ title: `删除主机 ${host.name}？`, text: '主机配置和保存的密码会从本机删除，服务器上的内容不受影响。', action: '删除主机' });
    if (!ok) return;
    try {
      const hosts = await api.deleteHost(host.id);
      store.set({ hosts });
      toast(`已删除 ${host.name}`);
    } catch (error) { fail(error); }
  }

  async function importConfig() {
    let preview;
    try { preview = await api.previewSshConfig(); } catch (error) { return fail(error); }
    const candidates = preview.hosts.filter(h => !h.id.includes(' (经'));
    if (!candidates.length) {
      return dialog({ title: '导入 ~/.ssh/config', body: html`<p>没有在 ~/.ssh/config 里找到可以导入的主机。</p>`, actions: [{ label: '知道了', value: 'ok', tone: 'primary' }] });
    }
    const { value, form } = await dialog({
      title: '从 ~/.ssh/config 导入',
      wide: true,
      body: html`
        <p class="text-muted">密码不会导入，第一次连接时再输入。跳板机会一起导入。</p>
        <ul class="list import-list">
          ${candidates.map(h => html`
            <li class="row">
              <label class="check import-check">
                <input type="checkbox" name="host" value="${h.id}" ${h.duplicate ? raw('disabled') : raw('checked')}>
                <span class="row-main"><span class="row-title">${h.name}</span><span class="row-meta mono" translate="no">${h.username}@${h.address}${h.port !== 22 ? ':' + h.port : ''}</span></span>
              </label>
              ${h.duplicate ? html`<span class="badge">已存在</span>` : ''}
            </li>`)}
        </ul>
        ${preview.warnings.length ? html`<details class="disclosure"><summary>${preview.warnings.length} 条提示</summary><ul class="warning-list">${preview.warnings.map(w => html`<li>${w.message}</li>`)}</ul></details>` : ''}`,
      actions: [{ label: '取消', value: 'cancel', tone: 'ghost' }, { label: '导入所选主机', value: 'ok', tone: 'primary' }],
    });
    if (value !== 'ok') return;
    const ids = [...form.querySelectorAll('input[name="host"]:checked')].map(input => input.value);
    if (!ids.length) return;
    try {
      const result = await api.importSshConfig(ids);
      store.set({ hosts: result.hosts });
      toast(result.imported ? `已导入 ${result.imported} 台主机` : '这些主机都已存在', { tone: 'success' });
    } catch (error) { fail(error); }
  }

  // ---- events -------------------------------------------------------------------------
  on(element, 'click', '[data-action]', (event, target) => {
    const action = target.dataset.action;
    const hostId = target.closest('[data-host]')?.dataset.host;
    const host = store.get().hosts.find(h => h.id === hostId);
    event.preventDefault();
    if (action === 'add') return edit(null);
    if (action === 'import') return importConfig();
    if (action === 'group-menu') return groupMenu(target);
    if (!host) return;
    if (action === 'terminal') return app.navigate('terminal', { hostId });
    if (action === 'files') return app.navigate('files', { hostId });
    if (action === 'assistant') return app.navigate('assistant', { hostIds: [hostId] });
    if (action === 'more') {
      return menu(target, [
        { label: '打开终端', icon: 'terminal', run: () => app.navigate('terminal', { hostId }) },
        { label: '编辑主机', icon: 'edit', run: () => edit(host) },
        { label: '移到分组…', icon: 'folder', run: async () => {
          const next = await askGroup({ title: `把 ${host.name} 移到分组`, value: host.group === '未分组' ? '' : host.group, action: '移动', help: '输入新名称会新建分组；留空则移到“未分组”。', allowEmpty: true });
          if (next === null) return;
          await moveHosts([host.id], next, `已移到“${next || '未分组'}”`);
        } },
        { label: '复制地址', icon: 'copy', run: () => api.writeClipboard(`${host.username}@${host.address}`).then(() => toast('已复制')) },
        'separator',
        { label: '删除主机…', icon: 'trash', danger: true, run: () => remove(host) },
      ]);
    }
  });
  element.addEventListener('input', event => {
    if (event.target.id === 'host-filter') { query = event.target.value; draw(); }
  });
  store.subscribe(() => { if (!element.hidden) draw(); });
  // A host going online or offline changes the card's shape; a new sample only patches numbers.
  app.telemetry.subscribe(hostId => {
    if (element.hidden) return;
    if (app.telemetry.online(hostId) !== shownOnline.has(hostId)) return draw();
    app.telemetry.patch(element, hostId);
  });

  return {
    show(params) {
      draw();
      if (params?.add) edit(null);
    },
  };
}
