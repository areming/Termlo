// Files: browse a server over SFTP; drop files to upload; folder transfers with a queue.
import { api, html, raw, ico, render, $, on, dialog, confirm, toast, fail, menu, message, bytes, when, uid } from './ui.js';

const AUTH_FAILURE = /authentication|认证|密码|passphrase|All configured authentication methods failed/i;

export function createFilesPage(element, app) {
  const { store } = app;
  let current = null;            // { id, hostId, path, files, status }
  const transfers = new Map();   // transferId -> { name, direction, state, bytesDone, bytesTotal, ... }

  function publish() {
    const others = (store.get().sessions || []).filter(s => s.kind !== 'sftp');
    store.set({ sessions: current ? [...others, { id: current.id, hostId: current.hostId, kind: 'sftp', status: current.status }] : others });
  }

  function draw() {
    if (!current) return drawPicker();
    const { path = '', files = [], status, error } = current;
    const segments = path.split('/').filter(Boolean);
    render(element, html`
      <div class="files-page">
        <div class="toolbar files-toolbar">
          <button class="btn btn-sm" type="button" data-action="switch" title="切换主机">${ico('host', 'sm')}<span class="truncate">${app.hostLabel(current.hostId)}</span>${ico('chevron-down', 'sm')}</button>
          <ol class="breadcrumb files-path" aria-label="当前目录">
            <li><a href="#" data-go="/">/</a></li>
            ${segments.map((segment, i) => i === segments.length - 1
              ? html`<li aria-current="page">${segment}</li>`
              : html`<li><a href="#" data-go="${'/' + segments.slice(0, i + 1).join('/')}">${segment}</a></li>`)}
          </ol>
          <span class="toolbar-spacer"></span>
          <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="goto" aria-label="前往路径" title="前往路径">${ico('arrow-right', 'sm')}</button>
          <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="mkdir" aria-label="新建文件夹" title="新建文件夹">${ico('plus', 'sm')}</button>
          <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="refresh" aria-label="刷新" title="刷新">${ico('refresh', 'sm')}</button>
          <button class="btn btn-sm" type="button" data-action="upload-folder">上传文件夹</button>
          <button class="btn btn-sm btn-primary" type="button" data-action="upload">${ico('upload', 'sm')}上传</button>
        </div>
        <div class="files-body" id="files-drop">
          ${status === 'connecting' ? html`<div class="files-state"><span class="spinner"></span>正在连接 ${app.hostLabel(current.hostId)}…</div>`
            : status === 'failed' ? html`<div class="files-state"><p class="field-error">${ico('status-error', 'sm')}${error}</p><button class="btn" type="button" data-action="reconnect">重新连接</button></div>`
            : status === 'closed' ? html`<div class="files-state"><p class="text-muted">连接已断开。</p><button class="btn" type="button" data-action="reconnect">重新连接</button></div>`
            : html`
              <ul class="list files-list" aria-label="${path} 中的文件">
                ${path !== '/' ? html`<li class="row" data-path="${parent(path)}" data-dir="1"><button class="row-button" type="button" data-open>${ico('folder', 'sm')}<span class="row-main"><span class="row-title">..</span></span></button></li>` : ''}
                ${files.map(f => html`
                  <li class="row" data-path="${f.path}" data-dir="${f.directory ? 1 : 0}" data-name="${f.name}">
                    <button class="row-button" type="button" data-open title="${f.directory ? '打开' : '下载'} ${f.name}">
                      <span class="${f.directory ? '' : 'text-muted'}">${ico(f.directory ? 'folder' : f.symlink ? 'link' : 'file', 'sm')}</span>
                      <span class="row-main"><span class="row-title" translate="no">${f.name}</span></span>
                      <span class="row-aside num">${f.directory ? '' : bytes(f.size)}</span>
                      <span class="row-aside">${when(f.modified)}</span>
                    </button>
                    <div class="quick-actions">
                      <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="download" aria-label="下载 ${f.name}" title="下载">${ico('download', 'sm')}</button>
                      <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="more" aria-label="更多操作" title="更多操作">${ico('more', 'sm')}</button>
                    </div>
                  </li>`)}
                ${!files.length ? html`<li class="row"><span class="text-muted files-empty">空文件夹。把文件拖到这里即可上传。</span></li>` : ''}
              </ul>`}
          <div class="drop-hint" hidden>${ico('upload', 'lg')}<span>松开即上传到 <span class="mono">${path}</span></span></div>
        </div>
        ${transfers.size ? html`
          <section class="transfer-queue" aria-label="传输">
            ${[...transfers.entries()].map(([id, t]) => transferRow(id, t))}
          </section>` : ''}
      </div>`);
  }

  function transferRow(id, t) {
    const percent = t.bytesTotal ? Math.min(100, Math.round(t.bytesDone / t.bytesTotal * 100)) : 0;
    const label = t.direction === 'upload' ? '上传' : '下载';
    const state = {
      started: '准备中…', running: `${percent}% · ${bytes(t.bytesDone)} / ${bytes(t.bytesTotal)}${t.filesTotal > 1 ? ` · ${t.filesDone}/${t.filesTotal} 个文件` : ''}`,
      conflict: '等待你决定', done: `完成 · ${t.files} 个文件${t.skipped ? `，跳过 ${t.skipped} 个` : ''}`, failed: `失败：${t.message}`, cancelled: '已取消',
    }[t.state];
    return html`
      <div class="transfer-row" data-state="${t.state}">
        ${ico(t.direction === 'upload' ? 'upload' : 'download', 'sm')}
        <div class="transfer-main">
          <span class="truncate">${label} ${t.name || ''}</span>
          <span class="text-xs text-muted">${state}</span>
          ${t.state === 'running' ? html`<progress max="100" value="${percent}" aria-label="${label}进度"></progress>` : ''}
        </div>
        ${['started', 'running', 'conflict'].includes(t.state)
          ? html`<button class="btn btn-sm btn-ghost" type="button" data-cancel="${id}">取消</button>`
          : html`<button class="btn btn-icon btn-sm btn-ghost" type="button" data-dismiss="${id}" aria-label="移除" title="移除">${ico('close', 'sm')}</button>`}
      </div>`;
  }

  function drawPicker() {
    const hosts = store.get().hosts.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    render(element, html`
      <div class="page">
        <div class="card empty empty-page">
          <span class="empty-icon">${ico('folder', 'lg')}</span>
          <h2 class="empty-title">浏览服务器文件</h2>
          ${hosts.length ? html`
            <p class="empty-text">选择一台主机。可以把本机文件直接拖进来上传。</p>
            <ul class="list pick-list">${hosts.map(h => html`
              <li class="row"><button class="row-button" type="button" data-host="${h.id}">${ico('host', 'sm')}<span class="row-main"><span class="row-title">${h.name}</span><span class="row-meta mono">${h.username}@${h.address}</span></span>${ico('arrow-right', 'sm')}</button></li>`)}</ul>`
          : html`<p class="empty-text">还没有主机，先添加一台。</p><button class="btn btn-primary" type="button" data-add>${ico('plus')}添加主机</button>`}
        </div>
      </div>`);
  }

  const parent = path => path === '/' ? '/' : path.replace(/\/[^/]+\/?$/, '') || '/';
  const join = (dir, name) => (dir.endsWith('/') ? dir : dir + '/') + name;

  // ---- connection -----------------------------------------------------------------------
  async function open(hostId, options = {}) {
    if (current?.hostId === hostId && current.status === 'ready' && !options.force) return list(current.path);
    if (current) api.disconnect(current.id).catch(() => {});
    current = { id: uid('f'), hostId, path: '', files: [], status: 'connecting' };
    draw(); publish();
    const credentials = await app.credentials(hostId, options);
    if (!credentials) { current = null; publish(); return draw(); }
    try {
      await api.connectFiles(current.id, hostId, credentials);
      current.status = 'ready';
      publish();
      await list('.');
    } catch (error) {
      const text = message(error);
      if (AUTH_FAILURE.test(text)) return open(hostId, { force: true, reason: '登录失败，请检查后重试。' });
      current.status = 'failed';
      current.error = text;
      publish(); draw();
    }
  }

  async function list(path) {
    if (!current || current.status !== 'ready') return;
    try {
      const result = await api.listRemote(current.id, path);
      current.path = result.path;
      current.files = result.files;
      draw();
    } catch (error) { fail(error); }
  }

  // ---- actions -----------------------------------------------------------------------------
  async function upload(paths) {
    if (!current) return;
    try { await api.upload(current.id, current.path, paths); }
    catch (error) { fail(error); }
    list(current.path);
  }

  async function download(file) {
    try {
      const result = await api.download(current.id, [file.path]);
      if (result?.directory) toast(`已下载到 ${result.directory}`, { tone: 'success', action: '打开文件夹', onAction: () => api.showInFolder(result.directory) });
    } catch (error) { fail(error); }
  }

  async function rename(file) {
    const { value, data } = await dialog({
      title: `重命名 ${file.name}`,
      body: html`<div class="field"><label class="field-label" for="rename-input">新名称</label><input class="input mono" id="rename-input" name="name" value="${file.name}" required pattern="[^\\/]+" autocomplete="off" autofocus></div>`,
      actions: [{ label: '取消', value: 'cancel', tone: 'ghost' }, { label: '重命名', value: 'ok', tone: 'primary' }],
      onOpen: el => { const input = $('#rename-input', el); const dot = file.name.lastIndexOf('.'); input.setSelectionRange(0, dot > 0 && !file.directory ? dot : file.name.length); },
    });
    if (value !== 'ok' || data.name === file.name) return;
    try { await api.renameRemote(current.id, file.path, join(parent(file.path), data.name)); toast('已重命名'); }
    catch (error) { fail(error); }
    list(current.path);
  }

  async function remove(file) {
    if (!file.directory && !(await confirm({ title: `删除 ${file.name}？`, text: `${file.path}\n删除后无法恢复。`, action: '删除文件' }))) return;
    try {
      const result = await api.removeRemote(current.id, file.path, file.directory);
      if (!result?.cancelled) toast(`已删除 ${file.name}`);
    } catch (error) { fail(error); }
    list(current.path);
  }

  async function mkdir() {
    const { value, data } = await dialog({
      title: '新建文件夹',
      body: html`<div class="field"><label class="field-label" for="mkdir-input">名称</label><input class="input mono" id="mkdir-input" name="name" required pattern="[^\\/]+" autocomplete="off" autofocus></div>`,
      actions: [{ label: '取消', value: 'cancel', tone: 'ghost' }, { label: '新建', value: 'ok', tone: 'primary' }],
    });
    if (value !== 'ok') return;
    try { await api.mkdirRemote(current.id, join(current.path, data.name)); }
    catch (error) { fail(error); }
    list(current.path);
  }

  async function goto() {
    const { value, data } = await dialog({
      title: '前往路径',
      body: html`<div class="field"><label class="field-label" for="goto-input">绝对路径</label><input class="input mono" id="goto-input" name="path" value="${current.path}" required pattern="/.*" autocomplete="off" autofocus></div>`,
      actions: [{ label: '取消', value: 'cancel', tone: 'ghost' }, { label: '前往', value: 'ok', tone: 'primary' }],
    });
    if (value === 'ok') list(data.path.trim());
  }

  async function resolveConflict(event) {
    const kind = event.conflictType === 'directory' ? '文件夹' : '文件';
    const { value, data } = await dialog({
      title: `${event.name} 已存在`,
      body: html`
        <p>目标位置已经有同名${kind}。</p>
        ${event.existing && event.incoming ? html`<p class="text-muted text-xs">现有：${bytes(event.existing.size)} · ${when(event.existing.modified)}<br>新的：${bytes(event.incoming.size)} · ${when(event.incoming.modified)}</p>` : ''}
        <label class="check"><input type="checkbox" name="all">后续冲突都这样处理</label>`,
      actions: [
        { label: '取消传输', value: 'cancel', tone: 'ghost' },
        { label: '跳过', value: 'skip' },
        { label: '保留两者', value: 'rename' },
        { label: event.conflictType === 'directory' ? '合并' : '覆盖', value: 'overwrite', tone: 'primary' },
      ],
    });
    api.answerConflict(event.conflictId, value === 'cancel' ? 'cancel' : { policy: value, applyToAll: !!data.all });
  }

  // ---- events -------------------------------------------------------------------------------
  const fileOf = target => {
    const row = target.closest('[data-path]');
    if (!row) return null;
    return { path: row.dataset.path, name: row.dataset.name || '..', directory: row.dataset.dir === '1' };
  };
  on(element, 'click', '[data-host]', (_e, button) => open(button.dataset.host));
  on(element, 'click', '[data-add]', () => app.navigate('hosts', { add: true }));
  on(element, 'click', '[data-go]', (event, link) => { event.preventDefault(); list(link.dataset.go); });
  on(element, 'click', '[data-open]', (_e, button) => { const file = fileOf(button); if (file.directory) list(file.path); else download(file); });
  on(element, 'click', '[data-cancel]', (_e, button) => api.cancelTransfer(button.dataset.cancel));
  on(element, 'click', '[data-dismiss]', (_e, button) => { transfers.delete(button.dataset.dismiss); draw(); });
  on(element, 'click', '[data-action]', (_e, button) => {
    const action = button.dataset.action;
    const file = fileOf(button);
    if (action === 'refresh') return list(current.path);
    if (action === 'upload') return upload();
    if (action === 'upload-folder') return api.uploadFolder(current.id, current.path).catch(fail).then(() => list(current.path));
    if (action === 'mkdir') return mkdir();
    if (action === 'goto') return goto();
    if (action === 'reconnect') return open(current.hostId, { force: false });
    if (action === 'download') return download(file);
    if (action === 'switch') {
      const hosts = store.get().hosts.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      return menu(button, hosts.slice(0, 20).map(h => ({ label: h.name, icon: 'host', run: () => open(h.id) })));
    }
    if (action === 'more') {
      return menu(button, [
        { label: '下载', icon: 'download', run: () => download(file) },
        { label: '重命名', icon: 'edit', run: () => rename(file) },
        { label: '复制路径', icon: 'copy', run: () => api.writeClipboard(file.path).then(() => toast('已复制路径')) },
        'separator',
        { label: file.directory ? '删除文件夹…' : '删除…', icon: 'trash', danger: true, run: () => remove(file) },
      ]);
    }
  });

  // Drag & drop from the operating system.
  let depth = 0;
  element.addEventListener('dragenter', event => {
    if (!current || current.status !== 'ready' || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    depth++;
    const hint = $('.drop-hint', element);
    if (hint) hint.hidden = false;
  });
  element.addEventListener('dragover', event => { if (current?.status === 'ready') event.preventDefault(); });
  element.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; const hint = $('.drop-hint', element); if (hint) hint.hidden = true; } });
  element.addEventListener('drop', event => {
    event.preventDefault();
    depth = 0;
    const hint = $('.drop-hint', element);
    if (hint) hint.hidden = true;
    const paths = [...(event.dataTransfer?.files || [])].map(file => api.pathForFile(file)).filter(Boolean);
    if (paths.length) upload(paths);
  });

  app.on('transfer', event => {
    if (event.id !== current?.id) return;
    const entry = { ...(transfers.get(event.transferId) || {}), ...event };
    transfers.set(event.transferId, entry);
    if (event.state === 'conflict') resolveConflict(event);
    if (event.state === 'done') setTimeout(() => { if (transfers.get(event.transferId)?.state === 'done') { transfers.delete(event.transferId); if (!element.hidden) draw(); } }, 6000);
    if (!element.hidden) draw();
  });
  app.on('status', event => {
    if (event.id !== current?.id || event.status !== 'closed') return;
    current.status = 'closed';
    publish();
    if (!element.hidden) draw();
  });

  return {
    show(params) {
      if (params?.hostId) open(params.hostId);
      else draw();
    },
  };
}
