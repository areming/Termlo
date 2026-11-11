// Hosts: grouped cards or list, quick actions, add/edit, ~/.ssh/config import.
import { api, html, raw, ico, render, $, $$, on, dialog, confirm, toast, fail, menu, contextMenu, selectable, bytes } from './ui.js';
import { view } from './telemetry.js';
import { orderHosts, moveHost } from './host-order.mjs';

const OS_LABEL = host => host.operatingSystem?.name || '';

export function createHostsPage(element, app) {
  const { store } = app;
  let group = '全部';
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
    const q = (store.get().hostQuery || '').trim().toLowerCase();   // typed in the top search box
    return orderHosts(hosts, store.get().preferences.hostOrder)
      .filter(h => group === '全部' || (h.group || '未分组') === group)
      .filter(h => !q || [h.name, h.address, h.username, h.group, h.tags].join(' ').toLowerCase().includes(q));
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

  // Every action is one click: the three ways to work with a host, then three tools.
  function actions(host) {
    return html`
      <div class="host-actions" role="group" aria-label="${host.name} 的操作">
        <button class="host-action" type="button" data-action="terminal" aria-label="打开 ${host.name} 的终端" title="终端">${ico('terminal', 'sm')}</button>
        <button class="host-action" type="button" data-action="files" aria-label="浏览 ${host.name} 的文件" title="文件">${ico('folder', 'sm')}</button>
        <button class="host-action" type="button" data-action="assistant" aria-label="把 ${host.name} 交给助手" title="助手">${ico('assistant', 'sm')}</button>
      </div>
      <div class="host-tools">
        <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="edit" aria-label="编辑 ${host.name}" title="编辑">${ico('edit', 'sm')}</button>
        <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="copy" aria-label="复制 ${host.name} 的地址" title="复制地址">${ico('copy', 'sm')}</button>
        <button class="btn btn-icon btn-sm btn-ghost btn-danger-ghost" type="button" data-action="delete" aria-label="删除 ${host.name}" title="删除主机">${ico('trash', 'sm')}</button>
      </div>`;
  }

  // Live hosts can be switched off from the card: this closes the host's terminals.
  function disconnect(host) {
    const count = (store.get().sessions || []).filter(t => t.kind === 'terminal' && t.hostId === host.id).length;
    const label = count > 1 ? `关闭 ${count} 个终端` : '关闭终端';
    return html`<button class="live-off" type="button" data-action="disconnect" aria-label="${label}（${host.name}）" title="${label}">${ico('power', 'sm')}</button>`;
  }
  const targetOf = host => `${host.username}@${host.address}${host.port !== 22 ? ':' + host.port : ''}`;
  // Jump hosts in connection order (outermost first), up to 4 levels.
  function jumps(host) {
    const { hosts } = store.get(), chain = [];
    let id = host.jumpHostId;
    while (id && chain.length < 5 && !chain.some(h => h.id === id)) {
      const next = hosts.find(h => h.id === id);
      if (!next) break;
      chain.unshift(next); id = next.jumpHostId;
    }
    return chain;
  }
  function via(host) {
    const chain = jumps(host);
    if (!chain.length) return '';
    const names = chain.map(h => h.name);
    return html`<span class="via-chip" title="${['本机', ...names, host.name].join(' → ')}">${ico('jump', 'sm')}<span class="truncate">${names.join(' › ')}</span></span>`;
  }
  // A small tile with the system's initial; lit when the host is online.
  function glyph(host) {
    const os = OS_LABEL(host);
    return html`<span class="host-glyph" aria-hidden="true">${os ? os.trim()[0].toUpperCase() : ico('host', 'sm')}</span>`;
  }

  function card(host, online) {
    const target = targetOf(host);
    const facts = specs(host);
    const telemetry = app.telemetry;
    return html`
      <article class="host-card" data-host="${host.id}" data-online="${online}" draggable="true" style="view-transition-name: host-${host.id}">
        <header class="host-card-head">
          <span class="host-pulse" aria-hidden="true"></span>
          <div class="host-card-main">
            <h3 class="host-card-title truncate"><a class="card-link" href="#terminal" data-action="terminal" title="打开终端" draggable="false">${host.name}</a></h3>
            <p class="host-card-target"><span class="mono truncate" translate="no">${target}</span>${via(host)}</p>
          </div>
          ${OS_LABEL(host) ? html`<span class="host-os truncate" title="${OS_LABEL(host)}">${OS_LABEL(host).replace(/ LTS$/, '')}</span>` : ''}
        </header>
        ${online
          ? html`<div class="host-live"><div class="host-telemetry" data-telemetry="${host.id}" data-variant="card">${view('card', telemetry.get(host.id), telemetry.history(host.id))}</div>${disconnect(host)}</div>`
          : facts.length ? html`<div class="host-idle" title="打开终端后显示实时状态"><span class="host-facts">${facts.map(f => html`<span>${f}</span>`)}</span></div>` : ''}
        <footer class="host-card-foot">
          ${actions(host)}
        </footer>
      </article>`;
  }

  function row(host, online) {
    const facts = specs(host);
    return html`
      <li class="host-line" data-host="${host.id}" data-online="${online}" draggable="true" style="view-transition-name: host-${host.id}">
        ${glyph(host)}
        <div class="host-line-main">
          <a class="host-line-name card-link truncate" href="#terminal" data-action="terminal" draggable="false" title="${OS_LABEL(host) || '打开终端'}">${host.name}</a>
          <span class="host-line-target"><span class="mono truncate" translate="no">${targetOf(host)}</span>${via(host)}</span>
        </div>
        ${online
          ? html`<div class="host-line-live"><div class="host-line-signal" data-telemetry="${host.id}" data-variant="line">${view('line', app.telemetry.get(host.id), app.telemetry.history(host.id))}</div>${disconnect(host)}</div>`
          : html`<div class="host-line-signal host-line-facts">${facts.map(f => html`<span>${f}</span>`)}</div>`}
        <div class="host-line-actions">${actions(host)}</div>
      </li>`;
  }

  // With "全部" selected and several groups, the list is sectioned by group.
  function listView(list, connected) {
    const sections = group === '全部' ? groups(list) : [[null]];
    if (sections.length < 2) return html`<ul class="host-lines">${list.map(h => row(h, connected.has(h.id)))}</ul>`;
    return sections.map(([name, count]) => html`
      <section class="host-section">
        <h3 class="host-section-title">${name}<span class="count">${count}</span></h3>
        <ul class="host-lines">${list.filter(h => (h.group || '未分组') === name).map(h => row(h, connected.has(h.id)))}</ul>
      </section>`);
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
            <p class="empty-text">终端、文件和助手都从这里开始</p>
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
    render(element, html`
      <div class="page">
        <div class="page-header">
          <h2 class="page-title">主机<span class="count">${hosts.length} 台</span>${connected.size ? html`<span class="online-count"><span class="dot"></span>${connected.size} 台在线</span>` : ''}</h2>
          <div class="segmented" role="radiogroup" aria-label="显示方式" id="host-view">
            <button type="button" role="radio" data-view="grid" aria-checked="${view === 'grid'}" aria-label="卡片" title="卡片">${ico('view-grid', 'sm')}</button>
            <button type="button" role="radio" data-view="list" aria-checked="${view === 'list'}" aria-label="列表" title="列表">${ico('view-list', 'sm')}</button>
          </div>
          <button class="btn btn-icon" type="button" data-action="import" aria-label="从 ~/.ssh/config 导入" title="从 ~/.ssh/config 导入">${ico('import', 'sm')}</button>
          <button class="btn btn-primary btn-icon btn-round" type="button" data-action="add" aria-label="添加主机" title="添加主机">${ico('plus')}</button>
        </div>
        ${groupList.length > 1 || groupList[0]?.[0] !== '未分组' ? html`
          <div class="host-groups-bar">
            <div class="tabs" role="tablist" aria-label="主机分组" id="host-groups">
              <button class="tab" type="button" role="tab" data-group="全部" aria-selected="${group === '全部'}">全部<span class="count">${hosts.length}</span></button>
              ${groupList.map(([name, count]) => html`<button class="tab" type="button" role="tab" data-group="${name}" aria-selected="${group === name}">${name}<span class="count">${count}</span></button>`)}
            </div>
            ${group !== '全部' && group !== '未分组' ? html`<button class="btn btn-sm btn-ghost" type="button" data-action="group-menu" title="重命名或解散分组“${group}”">${ico('more', 'sm')}管理分组</button>` : ''}
          </div>` : ''}
        ${!list.length ? html`<p class="text-muted empty-inline">没有匹配“${store.get().hostQuery || ''}”的主机</p>`
          : view === 'list' ? html`<div class="host-list">${listView(list, connected)}</div>`
          : html`<div class="host-grid">${list.map(h => card(h, connected.has(h.id)))}</div>`}
      </div>`);
    const tabs = $('#host-groups', element);
    if (tabs) selectable(tabs, '[role="tab"]', 'aria-selected', tab => { group = tab.dataset.group; draw(); $(`[data-group="${CSS.escape(group)}"]`, element)?.focus(); });
    selectable($('#host-view', element), '[role="radio"]', 'aria-checked', button => app.setPreferences({ hostView: button.dataset.view }));
  }

  // ---- add / edit ---------------------------------------------------------------------
  async function edit(host, draftValues) {
    const { hosts } = store.get();
    // A host can't jump through itself or through a host that already routes through it,
    // and a route has at most 4 jump hosts.
    const jumpCandidates = hosts.filter(h => h.id !== host?.id && !jumps(h).some(j => j.id === host?.id) && jumps(h).length < 4);
    const routeNames = id => { const jump = hosts.find(h => h.id === id); return jump ? [...jumps(jump), jump].map(h => h.name) : []; };
    const groupNames = [...new Set(hosts.map(h => h.group).filter(g => g && g !== '未分组'))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const currentGroup = (host?.group || draftValues?.group || '') === '未分组' ? '' : (draftValues?.group ?? host?.group ?? '');
    const jumpLabel = id => {
      const jump = hosts.find(h => h.id === id);
      return jump
        ? html`${ico('jump', 'sm')}<span class="picker-label">${jump.name}</span><span class="picker-meta mono truncate">${jump.address}</span>${ico('chevron-down', 'sm')}`
        : html`${ico('arrow-right', 'sm')}<span class="picker-label">直接连接</span><span class="picker-meta"></span>${ico('chevron-down', 'sm')}`;
    };
    // 本机 › bastion › gateway › this host — shown once there is at least one jump.
    const targetName = () => document.querySelector('#h-name')?.value.trim() || document.querySelector('#h-address')?.value.trim() || host?.name || '这台主机';
    const routeLine = id => {
      const names = routeNames(id);
      if (!names.length) return '';
      return html`<span>本机</span>${names.map(n => html`${ico('chevron-right', 'sm')}<span>${n}</span>`)}${ico('chevron-right', 'sm')}<span class="route-target">${targetName()}</span>`;
    };
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
          <label class="field-label" for="h-password">密码${host?.hasPassword ? raw('<span class="optional">已保存</span>') : ''}</label>
          <input class="input" id="h-password" name="password" type="password" autocomplete="new-password" placeholder="${host?.hasPassword ? '留空保持不变' : '留空则连接时再问'}">
          <label class="check"><input type="checkbox" name="rememberPassword" ${!host || host.hasPassword ? raw('checked') : ''}><span title="用系统加密保存在本机，不会上传">记住密码</span></label>
        </div>
        <div class="field" data-for="key" ${isKey ? '' : raw('hidden')}>
          <label class="field-label" for="h-key">私钥文件</label>
          <div class="input-with-button">
            <input class="input mono" id="h-key" name="keyPath" value="${v.keyPath && v.keyPath !== '__TERMLO_KEY_REQUIRED__' ? v.keyPath : ''}" placeholder="~/.ssh/id_ed25519…" spellcheck="false" autocomplete="off">
            <button class="btn" type="button" data-pick-key>选择…</button>
          </div>
        </div>
        <details class="disclosure" ${v.group || v.jumpHostId ? raw('open') : ''}>
          <summary>分组与跳板机</summary>
          <div class="field">
            <span class="field-label" id="h-group-label">分组</span>
            <div class="chips" role="radiogroup" aria-labelledby="h-group-label" id="h-group">
              <button class="chip" type="button" role="radio" data-group="" aria-checked="${!currentGroup}">不分组</button>
              ${groupNames.map(g => html`<button class="chip" type="button" role="radio" data-group="${g}" aria-checked="${currentGroup === g}">${g}</button>`)}
              <input class="chip chip-input" id="h-group-new" value="${currentGroup && !groupNames.includes(currentGroup) ? currentGroup : ''}" placeholder="+ 新分组" aria-label="新分组名称" maxlength="200" autocomplete="off">
            </div>
            <input type="hidden" name="group" value="${currentGroup}">
          </div>
          ${jumpCandidates.length ? html`
            <div class="field">
              <span class="field-label" id="h-jump-label">跳板机</span>
              <button class="picker" type="button" id="h-jump" aria-labelledby="h-jump-label" aria-haspopup="menu">${jumpLabel(v.jumpHostId)}</button>
              <input type="hidden" name="jumpHostId" value="${v.jumpHostId || ''}">
              <p class="route-line" id="h-route" aria-live="polite">${routeLine(v.jumpHostId)}</p>
            </div>` : ''}
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
        // Group: one click on a chip, or type a new name.
        const groupInput = $('input[name="group"]', dialogElement);
        const chips = $('#h-group', dialogElement);
        const newGroup = $('#h-group-new', dialogElement);
        selectable(chips, '[role="radio"]', 'aria-checked', chip => { groupInput.value = chip.dataset.group; newGroup.value = ''; });
        newGroup.addEventListener('input', () => {
          const name = newGroup.value.trim();
          const match = [...chips.querySelectorAll('[role="radio"]')].find(c => c.dataset.group === name);
          for (const c of chips.querySelectorAll('[role="radio"]')) c.setAttribute('aria-checked', String(c === match || (!name && !c.dataset.group)));
          groupInput.value = name;
        });
        // Jump host: a dropdown that shows name and address.
        const jumpButton = $('#h-jump', dialogElement);
        const jumpInput = $('input[name="jumpHostId"]', dialogElement);
        jumpButton?.addEventListener('click', () => menu(jumpButton, [
          { label: '直接连接', icon: 'arrow-right', checked: !jumpInput.value, run: () => pick('') },
          'separator',
          ...jumpCandidates.map(h => ({ label: h.name, meta: [...jumps(h).map(j => j.name), h.address].join(' › '), icon: 'jump', checked: jumpInput.value === h.id, run: () => pick(h.id) })),
        ], { match: true }));
        for (const field of ['#h-name', '#h-address']) $(field, dialogElement).addEventListener('input', () => { const t = $('#h-route .route-target', dialogElement); if (t) t.textContent = targetName(); });
        function pick(id) { jumpInput.value = id; render(jumpButton, jumpLabel(id)); render($('#h-route', dialogElement), routeLine(id)); }
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
      group: (data.group || '').trim(),
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
    if (action === 'disconnect') return app.closeTerminals(hostId);
    if (action === 'edit') return edit(host);
    if (action === 'copy') return copyAddress(host);
    if (action === 'delete') return remove(host);
  });

  const copyAddress = host => api.writeClipboard(`${host.username}@${host.address}`).then(() => toast('已复制地址'));
  async function moveTo(host) {
    const next = await askGroup({ title: `把 ${host.name} 移到分组`, value: host.group === '未分组' ? '' : host.group, action: '移动', help: '输入新名称会新建分组；留空则移到“未分组”。', allowEmpty: true });
    if (next !== null) await moveHosts([host.id], next, `已移到“${next || '未分组'}”`);
  }
  // ---- drag to reorder ------------------------------------------------------------------
  const DRAG_TYPE = 'application/x-termlo-host';
  let dragged = null;
  const clearMarks = () => { for (const el of $$('[data-drop]', element)) delete el.dataset.drop; };
  // Grid: left or right half of a card; list: top or bottom half of a line.
  const isAfter = (target, event) => {
    const box = target.getBoundingClientRect();
    return target.classList.contains('host-line') ? event.clientY > box.top + box.height / 2 : event.clientX > box.left + box.width / 2;
  };
  element.addEventListener('dragstart', event => {
    const item = event.target.closest?.('[data-host][draggable="true"]');
    if (!item) return;
    dragged = item.dataset.host;
    event.dataTransfer.setData(DRAG_TYPE, dragged);
    event.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => item.classList.add('is-dragging'));
  });
  element.addEventListener('dragover', event => {
    if (!dragged || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
    const target = event.target.closest('[data-host][draggable="true"]');
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (!target || target.dataset.host === dragged) return clearMarks();
    const mark = isAfter(target, event) ? 'after' : 'before';
    if (target.dataset.drop === mark) return;
    clearMarks();
    target.dataset.drop = mark;
  });
  element.addEventListener('drop', event => {
    const target = event.target.closest('[data-host][draggable="true"]');
    if (!dragged || !target || target.dataset.host === dragged) return;
    event.preventDefault();
    const { hosts, preferences } = store.get();
    const hostOrder = moveHost(hosts, preferences.hostOrder, dragged, target.dataset.host, isAfter(target, event));
    clearMarks();
    const apply = () => store.set({ preferences: { ...preferences, hostOrder } });
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (document.startViewTransition && !calm) document.startViewTransition(apply); else apply();
    api.savePreferences({ hostOrder }).catch(fail);
  });
  element.addEventListener('dragend', () => {
    dragged = null;
    clearMarks();
    for (const el of $$('.is-dragging', element)) el.classList.remove('is-dragging');
  });

  element.addEventListener('contextmenu', event => {
    const hostId = event.target.closest('[data-host]')?.dataset.host;
    const host = store.get().hosts.find(h => h.id === hostId);
    if (!host) return;
    contextMenu(event, [
      { label: '打开终端', icon: 'terminal', run: () => app.navigate('terminal', { hostId }) },
      { label: '浏览文件', icon: 'folder', run: () => app.navigate('files', { hostId }) },
      { label: '交给助手', icon: 'assistant', run: () => app.navigate('assistant', { hostIds: [hostId] }) },
      'separator',
      { label: '编辑…', icon: 'edit', run: () => edit(host) },
      { label: '移到分组…', icon: 'folder', run: () => moveTo(host) },
      { label: '复制地址', icon: 'copy', run: () => copyAddress(host) },
      'separator',
      { label: '删除主机…', icon: 'trash', danger: true, run: () => remove(host) },
    ], event.target.closest('[data-host]').querySelector('.card-link'));
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
