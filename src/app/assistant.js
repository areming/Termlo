// Assistant (2.2): one conversation per session, sessions listed on the left by host.
// Commands sit in the conversation as expandable rows. Only decisions are cards — plan,
// question, approval (risk gate), recovery, result. Everything else is one line.
import { api, html, raw, ico, render, $, on, dialog, confirm, toast, fail, menu, contextMenu, duration, when, escape } from './ui.js';

const STATUS = {
  running: ['执行中', 'running'], awaiting_input: ['等你回答', 'warning'], awaiting_approval: ['等你确认', 'warning'], plan_ready: ['方案待确认', 'accent'],
  awaiting_reply: ['等你回复', 'accent'], needs_input: ['需要补充', 'warning'], completed: ['已完成', 'success'],
  failed: ['失败', 'danger'], paused: ['已暂停', ''], idle: ['未开始', ''],
};

// Minimal, safe markdown for model output: fenced code, tables, lists, headings,
// paragraphs, inline code and bold. Everything is escaped first; no raw HTML passes.
const inline = text => escape(text)
  .replace(/`([^`\n]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function markdownBlock(block) {
  const lines = block.split('\n');
  const out = [];
  let paragraph = [];
  const flush = () => { if (paragraph.length) out.push('<p>' + paragraph.map(inline).join('<br>') + '</p>'); paragraph = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }
    if (line.trim().startsWith('|') && TABLE_RULE.test(lines[i + 1] || '')) {
      flush();
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(cells(lines[i]));
      i--;
      out.push(`<div class="md-table"><table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const list = line.match(/^\s*([-*]|\d+[.)])\s+(.*)$/);
    if (list) {
      flush();
      const ordered = /\d/.test(list[1]);
      const items = [];
      for (; i < lines.length; i++) {
        const m = lines[i].match(/^\s*([-*]|\d+[.)])\s+(.*)$/);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        items.push(`<li>${inline(m[2])}</li>`);
      }
      i--;
      out.push(`<${ordered ? 'ol' : 'ul'} class="md-list">${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) { flush(); out.push(`<p class="md-heading">${inline(heading[1])}</p>`); continue; }
    paragraph.push(line.trim());
  }
  flush();
  return out.join('');
}

function prose(text) {
  const blocks = String(text || '').split(/```[\w-]*\n?/);
  return raw(blocks.map((block, i) => i % 2
    ? `<pre class="code" translate="no"><code>${escape(block.replace(/\n$/, ''))}</code></pre>`
    : markdownBlock(block)).join(''));
}

const basename = path => String(path || '').split('/').filter(Boolean).pop() || path;
const shorten = (text, n = 60) => { const line = String(text || '').trim().split('\n')[0]; return line.length > n ? line.slice(0, n - 1) + '…' : line; };

// Human label for an execution-console row.
function toolLabel(event) {
  const a = event.args || {};
  switch (event.name) {
    case 'run': return `运行 ${shorten(a.command, 48)}`;
    case 'inspect': return { overview: '检查系统概况', docker: '查看 Docker 容器', service: `检查服务 ${a.target || ''}`, process: `查找进程 ${a.target || ''}` }[a.topic] || '只读检查';
    case 'read_file': return `读取 ${basename(a.path)}`;
    case 'write_file': return `修改 ${basename(a.path)}（可撤销）`;
    case 'upload': return '上传附件';
    case 'wait': return `等待后台命令 ${a.id || ''}`;
    case 'cancel': return `停止后台命令 ${a.id || ''}`;
    case 'web': return a.query ? `搜索 ${shorten(a.query, 40)}` : `读取网页 ${shorten(a.url, 40)}`;
    default: return null;   // ask / plan / finish show up as cards instead
  }
}

const CONSOLE_STATE = { completed: 'success', failed: 'failed', timeout: 'failed', interrupted: 'failed', running: 'running', awaiting_approval: 'waiting' };

export function createAssistantPage(element, app) {
  const { store } = app;
  let state = { settings: {}, tasks: [], activeId: null };
  let task = null;            // full detail of the open task
  let currentId = null;
  let composing = null;       // { hostIds, attachments }: a new conversation being written
  let refreshTimer = null;
  let thinking = null;        // { taskId, events, text }: live preview of the model's reasoning, cleared by the next event
  let draft = '';

  render(element, html`<div class="assistant-page" id="assistant-root"></div>`);
  const root = $('#assistant-root', element);

  // ---- data ---------------------------------------------------------------------------
  async function refresh() {
    try {
      state = await api.agentState();
      if (currentId && state.tasks.some(t => t.id === currentId)) task = await api.agentTask(currentId);
      else if (currentId) { currentId = null; task = null; }
      // A wrong password typed for this session must be asked again next time.
      if (task?.status === 'failed' && /认证|登录|authentication/i.test(task.notice || '')) app.forgetCredentials(task.hostIds);
      draw();
    } catch (error) { fail(error); }
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 120);
  }

  function openTask(id) {
    currentId = id;
    composing = null;
    refresh();
  }

  // ---- layout -----------------------------------------------------------------------------
  function draw() {
    if (element.hidden && root.childElementCount) return;
    const keepFocus = document.activeElement?.id === 'assistant-input';
    const caret = keepFocus ? document.activeElement.selectionStart : null;
    let main;
    if (!state.settings.baseUrl || !state.settings.model || state.settings.keyBroken) main = setupView();
    // A task is being opened but its detail has not arrived yet: don't fall back to the
    // new-conversation view, which would recreate `composing` and keep the page there.
    else if (currentId && !task && !composing) main = html`<div class="files-state"><span class="spinner"></span></div>`;
    else if (composing || !task) main = composeView();
    else main = taskView();
    const ready = state.settings.baseUrl && state.settings.model && !state.settings.keyBroken;
    render(root, html`${ready ? sidebar() : ''}<section class="assistant-main" aria-label="对话">${main}</section>`);
    root.dataset.sidebar = String(!!ready);
    const stream = $('.stream', root);
    if (stream) stream.scrollTop = stream.scrollHeight;
    const input = $('#assistant-input', root);
    if (input) {
      input.value = draft;
      if (keepFocus) { input.focus(); input.setSelectionRange(caret, caret); }
    }
  }

  function header() {
    const [label, tone] = STATUS[task?.status] || ['', ''];
    return html`
      <div class="assistant-header">
        <h2 class="assistant-title truncate" title="${task?.prompt || ''}">${task ? task.title : '新对话'}</h2>
        ${task ? html`<span class="badge ${tone ? 'badge-' + tone : ''}">${label}</span>` : ''}
        <span class="toolbar-spacer"></span>
        ${task ? html`<button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="task-more" aria-label="对话操作" title="更多">${ico('more', 'sm')}</button>` : ''}
      </div>`;
  }

  // Sessions, grouped by the host they work on (most recent first).
  function sidebar() {
    const groups = new Map();
    for (const t of state.tasks) {
      const key = t.hostIds.length === 1 ? t.hostIds[0] : t.hostIds.length ? '*' : '-';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const groupName = key => key === '*' ? '多台主机' : key === '-' ? '未选主机' : app.hostLabel(key);
    return html`
      <aside class="sessions" aria-label="对话列表">
        <div class="sessions-head">
          <span class="sessions-title">对话</span>
          <button class="btn btn-icon btn-sm" type="button" data-action="new" aria-label="新对话" title="新对话">${ico('plus', 'sm')}</button>
        </div>
        <div class="sessions-list">
          ${state.tasks.length ? [...groups].map(([key, list]) => html`
            <div class="sessions-group">
              <p class="sessions-group-title truncate">${key.length > 1 && key !== '*' ? ico('host', 'sm') : ''}<span class="truncate">${groupName(key)}</span></p>
              ${list.map(t => html`
                <button class="session" type="button" data-task="${t.id}" ${t.id === currentId && !composing ? raw('aria-current="true"') : ''} title="${t.title}">
                  <span class="session-dot" data-tone="${STATUS[t.status]?.[1] || ''}" aria-hidden="true"></span>
                  <span class="session-title truncate">${t.title}</span>
                  <span class="session-time">${when(t.updatedAt)}</span>
                  <span class="visually-hidden">${STATUS[t.status]?.[0] || ''}</span>
                </button>`)}
            </div>`)
            : html`<p class="sessions-empty">还没有对话</p>`}
        </div>
      </aside>`;
  }

  function setupView() {
    return html`
      <div class="page">
        <div class="card empty empty-page">
          <span class="empty-icon">${ico('assistant', 'lg')}</span>
          <h2 class="empty-title">先连接一个模型</h2>
          <p class="empty-text">${state.settings.keyBroken ? '保存的密钥在这台电脑上解不开，请重新填写' : '任何支持工具调用的 OpenAI 兼容模型都可以'}</p>
          <button class="btn btn-primary" type="button" data-action="settings">${ico('settings')}设置模型</button>
        </div>
      </div>`;
  }

  // Everyday jobs, one click to fill the box.
  const SUGGESTIONS = [
    ['activity', '检查服务器整体状况', '检查这台服务器的整体状况：CPU、内存、磁盘、负载和异常进程，给出结论'],
    ['status-warning', '服务起不来', '有个 systemd 服务起不来，帮我找出原因并修好：'],
    ['trash', '清理磁盘空间', '磁盘快满了，找出占用最大的目录，清理 7 天前的日志和缓存，删除前先告诉我'],
    ['link', '端口被占用', '80 端口被占用了，找出是哪个进程，确认后再处理'],
  ];

  function composeView() {
    composing ||= { hostIds: [], attachments: [] };
    const hosts = store.get().hosts.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return html`
      ${header()}
      <div class="compose">
        <div class="compose-main">
          <h2 class="compose-title"><span class="compose-mark" aria-hidden="true">${ico('assistant')}</span>要在服务器上做什么？</h2>
          <p class="compose-hint">问问题、排查、动手都行；复杂的改动会先给你方案</p>
          <form class="composer composer-large" data-form="start">
            <label class="visually-hidden" for="assistant-input">任务目标</label>
            <textarea id="assistant-input" name="prompt" rows="4" placeholder="例如：nginx 为什么 502？／用 Docker 部署 nginx，把 80 端口指向 /srv/site…" required></textarea>
            <div class="composer-bar">
              <button class="btn btn-sm btn-ghost" type="button" data-action="pick-hosts" aria-haspopup="menu">${ico('host', 'sm')}${composing.hostIds.length ? composing.hostIds.map(app.hostLabel).join('、') : '选择主机'}</button>
              ${composing.attachments.map(a => html`<span class="badge badge-outline">${ico('attach', 'sm')}${a.name}<button class="btn btn-icon btn-sm btn-ghost chip-remove" type="button" data-drop="${a.id}" aria-label="移除附件 ${a.name}" title="移除">${ico('close', 'sm')}</button></span>`)}
              <span class="toolbar-spacer"></span>
              <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="attach" aria-label="添加附件" title="添加附件">${ico('attach', 'sm')}</button>
              <button class="btn btn-primary btn-sm" type="submit" ${!hosts.length ? raw('disabled') : ''}>${ico('send', 'sm')}发送</button>
            </div>
          </form>
          ${!hosts.length ? html`<p class="text-muted">还没有主机，<a href="#hosts" data-action="add-host">先添加一台</a></p>`
            : html`<div class="suggestions" aria-label="常用任务">${SUGGESTIONS.map(([icon, label, text]) => html`
                <button class="suggestion" type="button" data-suggest="${text}" title="${text}">${ico(icon, 'sm')}<span>${label}</span></button>`)}</div>`}
        </div>
      </div>`;
  }

  function taskView() {
    const running = task.status === 'running';
    const runningTool = running ? [...task.events].reverse().find(e => e.type === 'tool' && e.status === 'running') : null;
    const placeholder = running ? '补充要求，例如 不要重启数据库…（立即生效）'
      : task.status === 'awaiting_input' ? '也可以直接写回答…'
      : task.status === 'awaiting_approval' ? '也可以直接说怎么做…'
      : task.status === 'plan_ready' ? '想改方案就直接说…'
      : '继续对话…';
    return html`
      ${header()}
      <div class="assistant">
        <div class="conversation">
          <div class="stream" aria-live="polite">
            ${streamItems(running)}
            ${running && !runningTool && !task.events.at(-1)?.streaming ? thinkingStep() : ''}
            ${task.recovery ? recoveryCard() : ''}
            ${task.notice && !running && task.status !== 'completed' && !task.events.some(e => (e.type === 'notice' && e.content === task.notice) || (e.type === 'result' && e.report?.headline === task.notice)) ? html`<p class="msg-step" data-tone="warning">${ico('status-warning')}${task.notice}</p>` : ''}
          </div>
          <form class="composer" data-form="${running ? 'followup' : 'resume'}">
            <label class="visually-hidden" for="assistant-input">给助手的消息</label>
            <textarea id="assistant-input" name="message" rows="2" placeholder="${placeholder}"></textarea>
            <div class="composer-bar">
              ${task.hostIds.map(id => html`<span class="badge badge-outline">${ico('host', 'sm')}${app.hostLabel(id)}</span>`)}
              <span class="toolbar-spacer"></span>
              ${running
                ? html`<button class="btn btn-sm" type="button" data-action="pause">${ico('stop', 'sm')}暂停</button>
                       <button class="btn btn-primary btn-sm" type="submit">${ico('send', 'sm')}补充</button>`
                : html`<button class="btn btn-primary btn-sm" type="submit">${ico('send', 'sm')}${task.status === 'paused' ? '继续' : '发送'}</button>`}
            </div>
          </form>
        </div>
      </div>`;
  }

  // Messages and cards in order; consecutive commands form one block. A finished block of more
  // than three steps folds into one line ("6 步 · 全部成功"), the live one stays open.
  function streamItems(running) {
    const out = [];
    let group = [];
    const flush = live => {
      if (!group.length) return;
      const rows = html`<ul class="cmd-list">${group.map(stepRow)}</ul>`;
      if (live || group.length <= 3) out.push(html`<div class="cmd-block">${rows}</div>`);
      else {
        const failed = group.filter(e => (CONSOLE_STATE[e.status] || '') === 'failed').length;
        out.push(html`<details class="cmd-block cmd-fold"><summary>${ico('terminal', 'sm')}<span>${group.length} 步</span><span class="text-muted">${failed ? `${failed} 步失败` : '全部成功'}</span>${ico('chevron-right', 'sm')}</summary>${rows}</details>`);
      }
      group = [];
    };
    for (const event of task.events) {
      if (event.type === 'tool') { if (toolLabel(event)) group.push(event); continue; }
      flush(false);
      out.push(streamItem(event));
    }
    flush(running);
    return out;
  }

  function streamItem(event) {
    switch (event.type) {
      case 'user': return html`<div class="msg msg-user">${prose(event.content)}${event.attachments?.length ? html`<p class="text-xs">${ico('attach', 'sm')}${event.attachments.map(a => a.name).join('、')}</p>` : ''}</div>`;
      case 'answer': return html`<div class="msg msg-user">${prose(event.content.replace(/^用户回答：\n/, ''))}</div>`;
      case 'assistant':
        if (event.superseded || (!event.content && !event.streaming)) return '';
        return html`<div class="msg msg-assistant" data-event="${event.id}">${prose(event.content)}${event.streaming ? html`<span class="caret" aria-hidden="true"></span>` : ''}</div>`;
      case 'notice': return html`<p class="msg-step" data-tone="warning">${ico('status-info')}${event.content}</p>`;
      case 'approval': return event.revision ? '' : html`<p class="msg-step" data-tone="success">${ico('play')}${event.content}</p>`;   // plan approvals show on the plan itself
      case 'approval-request': return approvalCard(event);
      case 'question': return questionCard(event);
      case 'proposal': return planCard(event);
      case 'result': return resultCard(event);
      default: return '';
    }
  }

  function stepRow(event) {
    let state = CONSOLE_STATE[event.status] || (event.result?.error ? 'failed' : 'success');
    if (state === 'waiting' && task.status !== 'awaiting_approval') state = 'skipped';
    const r = event.result || {};
    const elapsed = event.finishedAt ? duration(new Date(event.finishedAt) - new Date(event.at)) : '';
    const command = event.name === 'run' ? event.args?.command
      : event.name === 'read_file' || event.name === 'write_file' ? event.args?.path
      : event.name === 'web' ? (event.args?.query || event.args?.url) : event.name === 'inspect' ? `inspect ${event.args?.topic || ''} ${event.args?.target || ''}` : '';
    const output = state === 'waiting' || state === 'skipped' ? '' : r.error ? r.error : r.output ?? (r.content ? r.content.slice(0, 4000) : r.sha256 ? `sha256 ${r.sha256}` : JSON.stringify(r, null, 2).slice(0, 2000));
    return html`
      <li>
        <details class="console-row" data-state="${state}">
          <summary>
            <span class="row-state">${state === 'running' ? html`<span class="glyph-spinner" aria-hidden="true"></span>` : ico({ success: 'check', waiting: 'status-warning', skipped: 'stop' }[state] || 'close', 'sm')}</span>
            <span class="console-label">${toolLabel(event)}</span>
            <span class="console-meta">${state === 'running' ? '运行中' : state === 'waiting' ? '等你确认' : state === 'skipped' ? '未执行' : r.exitCode !== undefined && r.exitCode !== 0 ? `退出码 ${r.exitCode}` : elapsed}</span>
            ${ico('chevron-right', 'sm')}
          </summary>
          <div class="console-detail">
            ${command ? html`<div class="console-command"><span>$</span><code translate="no">${command}</code><button class="btn btn-icon btn-sm btn-ghost" type="button" data-copy="${command}" aria-label="复制命令" title="复制命令">${ico('copy', 'sm')}</button></div>` : ''}
            ${output ? html`<pre class="output" translate="no">${output}</pre>` : ''}
          </div>
        </details>
      </li>`;
  }

  function questionCard(event) {
    const request = event.request;
    const live = task.interaction?.id === request.id && task.interaction.status === 'pending' && task.status !== 'running';
    if (!live) return html`<p class="msg-step">${ico('question')}${event.content}：${request.questions.map(q => q.question).join('；')}</p>`;
    return html`
      <form class="decision" data-kind="question" data-form="answer" data-request="${request.id}">
        <header class="decision-header">${ico('question', 'sm')}<span class="decision-kind">提问</span><h3 class="decision-title">${request.questions.length === 1 ? request.questions[0].question : '需要你确认几件事'}</h3></header>
        <div class="decision-body">
          ${request.questions.map((q, qi) => html`
            <fieldset class="question" data-question="${q.id}">
              ${request.questions.length > 1 ? html`<legend class="field-label">${q.question}</legend>` : html`<legend class="visually-hidden">${q.question}</legend>`}
              ${q.options.length ? html`
                <div class="choices">
                  ${q.options.map((o, oi) => html`<label class="choice"><input type="radio" name="q-${q.id}" value="${oi}" ${q.recommendedOption === oi ? raw('checked') : ''} required><span class="choice-text"><span>${o.label}${q.recommendedOption === oi ? html` <span class="badge badge-accent">推荐</span>` : ''}</span><span class="choice-detail">${o.description}</span></span></label>`)}
                </div>
                <input class="input" name="t-${q.id}" placeholder="补充说明（可选）…" aria-label="补充说明" autocomplete="off">`
              : html`<textarea class="textarea" name="t-${q.id}" rows="2" required aria-label="${q.question}" placeholder="写下你的回答…"></textarea>`}
            </fieldset>`)}
        </div>
        <footer class="decision-footer"><button class="btn btn-primary" type="submit">提交回答</button></footer>
      </form>`;
  }

  function planCard(event) {
    const p = event.proposal;
    const latest = task.proposal?.revision === p.revision && task.status === 'plan_ready';
    const executed = task.events.some(e => e.type === 'approval' && e.revision === p.revision);
    if (executed) return html`
      <details class="cmd-block cmd-fold plan-fold">
        <summary>${ico('plan', 'sm')}<span>方案：${p.title}</span><span class="badge badge-success">已执行</span>${ico('chevron-right', 'sm')}</summary>
        <div class="plan-fold-body"><ol class="steps">${p.steps.map(s => html`<li><div>${s}</div></li>`)}</ol>
          ${p.checks.length ? html`<ul class="checks">${p.checks.map(c => html`<li>${ico('check')}<span>${c}</span></li>`)}</ul>` : ''}</div>
      </details>`;
    if (!latest) return html`<p class="msg-step">${ico('plan')}方案 v${p.revision}：${p.title}（已被新版本替代）</p>`;
    return html`
      <article class="decision" data-kind="plan">
        <header class="decision-header">${ico('plan', 'sm')}<span class="decision-kind">方案</span><h3 class="decision-title">${p.title}</h3><span class="badge">v${p.revision}</span></header>
        <div class="decision-body">
          <p>${p.summary}</p>
          <ol class="steps">${p.steps.map(s => html`<li><div>${s}</div></li>`)}</ol>
          ${p.checks.length ? html`<h4 class="section-title">验收标准</h4><ul class="checks">${p.checks.map(c => html`<li>${ico('check')}<span>${c}</span></li>`)}</ul>` : ''}
          ${p.risks.length ? html`<h4 class="section-title">影响和风险</h4><ul class="checks" data-tone="warning">${p.risks.map(r => html`<li>${ico('status-warning')}<span>${r}</span></li>`)}</ul>` : ''}
          ${p.questions.length ? html`<p class="field-error">${ico('question', 'sm')}还有 ${p.questions.length} 个问题待明确，回答后助手会更新方案。</p>` : ''}
        </div>
        <footer class="decision-footer">
          <span class="hint" title="改过的文件都可以撤销">确认后助手会自己做完，危险操作仍会先问你</span>
          <button class="btn btn-ghost" type="button" data-action="revise">修改方案</button>
          <button class="btn btn-primary" type="button" data-action="execute" data-revision="${p.revision}" ${p.questions.length ? raw('disabled') : ''}>${ico('play', 'sm')}执行方案</button>
        </footer>
      </article>`;
  }

  // Risk gate: the exact command (or file) waits for 允许 / 拒绝.
  function approvalCard(event) {
    const r = event.request;
    const live = task.interaction?.id === r.id && task.interaction.status === 'pending' && task.status === 'awaiting_approval';
    if (!live) return '';
    return html`
      <article class="decision" data-kind="approval">
        <header class="decision-header">${ico('status-warning', 'sm')}<span class="decision-kind">需要你确认</span><h3 class="decision-title">${r.reason}</h3></header>
        <div class="decision-body">
          <p class="approval-target">${ico('host', 'sm')}${app.hostLabel(r.hostId)}<span class="text-muted">${r.command ? '将执行' : '将改写'}</span></p>
          <pre class="code" translate="no"><code>${r.command || r.path}</code></pre>
        </div>
        <footer class="decision-footer">
          <span class="hint">只允许这一次</span>
          <button class="btn btn-ghost" type="button" data-action="deny">不执行</button>
          <button class="btn btn-danger" type="button" data-action="allow" data-request="${r.id}">${ico('play', 'sm')}允许执行</button>
        </footer>
      </article>`;
  }

  function resultCard(event) {
    const r = event.report;
    const done = r.outcome === 'completed';
    return html`
      <article class="decision" data-kind="result" data-outcome="${done ? 'done' : 'incomplete'}">
        <header class="decision-header">${ico(done ? 'status-success' : 'status-warning', 'sm')}<span class="decision-kind">结果</span><h3 class="decision-title">${r.headline}</h3><span class="badge ${done ? 'badge-success' : 'badge-warning'}">${done ? '已完成' : '需要补充'}</span></header>
        <div class="decision-body">
          ${r.checks.length ? html`<ul class="checks">${r.checks.map(c => html`<li ${c.status !== 'passed' ? raw(`data-state="fail"`) : ''}>${ico(c.status === 'passed' ? 'check' : c.status === 'failed' ? 'close' : 'question')}<span>${c.label}</span></li>`)}</ul>` : ''}
          ${r.artifacts?.map(a => html`<div class="deliverable">${ico('link', 'sm')}<span class="deliverable-label">${a.label}</span><span class="mono truncate" translate="no">${a.value}</span><button class="btn btn-icon btn-sm btn-ghost" type="button" data-copy="${a.value}" aria-label="复制 ${a.label}" title="复制">${ico('copy', 'sm')}</button></div>`)}
          <details class="disclosure"><summary>完整报告</summary>${prose(r.summary)}</details>
        </div>
      </article>`;
  }

  function recoveryCard() {
    return html`
      <article class="decision" data-kind="recovery">
        <header class="decision-header">${ico('status-warning', 'sm')}<span class="decision-kind">恢复</span><h3 class="decision-title">${task.status === 'failed' ? '任务出错，已停止' : '任务已停止'}</h3></header>
        <div class="decision-body"><p class="text-muted">本次任务改过 ${task.recovery.count} 个文件或暂存目录。可以撤销这些改动，回到执行前的状态；通过命令做的其他改动（安装软件、启动服务等）不在撤销范围内。</p></div>
        <footer class="decision-footer">
          <button class="btn btn-ghost" type="button" data-action="keep">保持现状</button>
          <button class="btn" type="button" data-action="undo">${ico('undo', 'sm')}撤销改动</button>
          <button class="btn btn-primary" type="button" data-action="continue">继续排查</button>
        </footer>
      </article>`;
  }

  // ---- credentials ----------------------------------------------------------------------
  async function secrets(hostIds) {
    const result = {};
    for (const hostId of hostIds) {
      const entry = await app.credentials(hostId);
      if (!entry) return null;
      Object.assign(result, entry);
    }
    return result;
  }

  // ---- actions ------------------------------------------------------------------------------
  async function start(form) {
    const prompt = form.prompt.value.trim();
    if (!prompt) return;
    if (!composing.hostIds.length) { toast('请先选择主机', { tone: 'warning' }); return $('[data-action="pick-hosts"]', root)?.focus(); }
    const credentials = await secrets(composing.hostIds);
    if (!credentials) return;
    try {
      const { id } = await api.agentStart({ prompt, hostIds: composing.hostIds, attachmentIds: composing.attachments.map(a => a.id), credentials });
      draft = '';
      openTask(id);
    } catch (error) { fail(error); }
  }

  async function send(form) {
    const text = form.message.value.trim();
    try {
      if (form.dataset.form === 'followup') {
        if (!text) return;
        await api.agentFollowup({ id: task.id, message: text });
      } else {
        const credentials = await secrets(task.hostIds);
        if (!credentials) return;
        await api.agentResume({ id: task.id, message: text, credentials });
      }
      draft = '';
      scheduleRefresh();
    } catch (error) { fail(error); }
  }

  async function answer(form) {
    const request = task.interaction;
    const answers = request.questions.map(q => {
      const choice = form.querySelector(`input[name="q-${q.id}"]:checked`);
      const text = form.querySelector(`[name="t-${q.id}"]`)?.value.trim() || '';
      return { questionId: q.id, ...(choice ? { optionIndex: Number(choice.value) } : {}), ...(text ? { text } : {}) };
    });
    const credentials = await secrets(task.hostIds);
    if (!credentials) return;
    try { await api.agentAnswer({ id: task.id, requestId: request.id, answers, credentials }); scheduleRefresh(); }
    catch (error) { fail(error); }
  }

  async function pickHosts(button) {
    const hosts = store.get().hosts.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const { value, form } = await dialog({
      title: '选择主机',
      body: html`<p class="text-muted">助手只能操作这里选中的主机。</p><ul class="list import-list">${hosts.map(h => html`
        <li class="row"><label class="check import-check"><input type="checkbox" name="host" value="${h.id}" ${composing.hostIds.includes(h.id) ? raw('checked') : ''}><span class="row-main"><span class="row-title">${h.name}</span><span class="row-meta mono">${h.username}@${h.address}</span></span></label></li>`)}</ul>`,
      actions: [{ label: '取消', value: 'cancel', tone: 'ghost' }, { label: '确定', value: 'ok', tone: 'primary' }],
    });
    if (value !== 'ok') return;
    composing.hostIds = [...form.querySelectorAll('input[name="host"]:checked')].map(i => i.value);
    draw();
  }

  async function removeTask(id) {
    const summary = state.tasks.find(t => t.id === id);
    if (!summary) return false;
    let clean = false;
    if (summary.recoverable) {
      const { value } = await dialog({
        title: `删除「${summary.title}」？`,
        body: html`
          <p>这个对话在服务器上还留有 ${summary.recoverable} 项撤销备份或附件暂存文件。</p>
          <p class="text-muted">清理会删掉这些备份和暂存文件；任务做过的改动保持不变，但之后不能再撤销。只删除记录则服务器上的文件原样保留。</p>`,
        actions: [
          { label: '取消', value: 'cancel', tone: 'ghost' },
          { label: '只删除记录', value: 'local' },
          { label: '清理服务器并删除', value: 'clean', tone: 'primary' },
        ],
      });
      if (value !== 'clean' && value !== 'local') return false;
      clean = value === 'clean';
    } else if (!(await confirm({ title: `删除「${summary.title}」？`, text: '只删除本机上的对话记录，不影响服务器。', action: '删除对话' }))) return false;
    const credentials = clean ? await secrets(summary.hostIds) : {};
    if (!credentials) return false;
    try {
      const result = await api.agentRemove({ id, clean, credentials });
      toast(clean ? `已清理 ${result.cleaned} 项并删除对话` : '已删除对话', { tone: 'success' });
      if (id === currentId) { currentId = null; task = null; }
      await refresh();
      return true;
    } catch (error) { fail(error); refresh(); return false; }
  }

  function newConversation(hostIds = task?.hostIds || []) {
    composing = { hostIds: [...hostIds], attachments: [] };
    draft = '';
    draw();
    $('#assistant-input', root)?.focus();
  }

  // ---- events ------------------------------------------------------------------------------
  root.addEventListener('input', event => { if (event.target.id === 'assistant-input') draft = event.target.value; });
  root.addEventListener('keydown', event => {
    // Enter sends, Shift+Enter starts a new line; never while an input method is composing.
    if (event.target.id === 'assistant-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      event.target.form.requestSubmit();
    }
  });
  root.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target;
    if (form.dataset.form === 'start') start(form);
    else if (form.dataset.form === 'answer') answer(form);
    else send(form);
  });
  on(root, 'click', '[data-task]', (_e, button) => openTask(button.dataset.task));
  root.addEventListener('contextmenu', event => {
    const button = event.target.closest('[data-task]');
    if (!button) return;
    const id = button.dataset.task;
    const summary = state.tasks.find(t => t.id === id);
    contextMenu(event, [
      { label: '打开', icon: 'assistant', run: () => openTask(id) },
      { label: '在新对话里继续这台主机', icon: 'plus', run: () => newConversation(summary?.hostIds || []) },
      'separator',
      { label: '删除对话…', icon: 'trash', danger: true, run: () => removeTask(id) },
    ]);
  });
  // Drop files on the new-task composer to attach them.
  root.addEventListener('dragover', event => {
    if (!composing || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    $('.composer', root)?.setAttribute('data-drop', 'true');
  });
  root.addEventListener('dragleave', event => { if (!root.contains(event.relatedTarget)) $('.composer', root)?.removeAttribute('data-drop'); });
  root.addEventListener('drop', async event => {
    if (!composing) return;
    event.preventDefault();
    $('.composer', root)?.removeAttribute('data-drop');
    const paths = [...(event.dataTransfer?.files || [])].map(file => api.pathForFile(file)).filter(Boolean);
    if (!paths.length) return;
    try { composing.attachments.push(...await api.agentAddAttachments(paths)); draw(); } catch (error) { fail(error); }
  });
  on(root, 'click', '[data-drop]', (_e, button) => { api.agentDropAttachment(button.dataset.drop).catch(() => {}); composing.attachments = composing.attachments.filter(a => a.id !== button.dataset.drop); draw(); });
  on(root, 'click', '[data-suggest]', (_e, button) => {
    const input = $('#assistant-input', root);
    if (!input) return;
    input.value = button.dataset.suggest;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  on(root, 'click', '[data-copy]', (_e, button) => api.writeClipboard(button.dataset.copy).then(() => toast('已复制')).catch(fail));
  on(root, 'click', '[data-action]', async (event, button) => {
    const action = button.dataset.action;
    if (action === 'settings') return app.navigate('settings', { section: 'model' });
    if (action === 'add-host') { event.preventDefault(); return app.navigate('hosts', { add: true }); }
    if (action === 'new') return newConversation();
    if (action === 'pick-hosts') return pickHosts(button);
    if (action === 'attach') {
      try { const files = await api.agentPickAttachments(); composing.attachments.push(...files); draw(); } catch (error) { fail(error); }
      return;
    }
    if (!task) return;
    try {
      if (action === 'pause') { await api.agentPause(task.id); return scheduleRefresh(); }
      if (action === 'allow' || action === 'deny') {
        const request = task.interaction;
        if (request?.kind !== 'approval') return;
        const credentials = await secrets(task.hostIds);
        if (!credentials) return;
        await api.agentApprove({ id: task.id, requestId: request.id, allow: action === 'allow', credentials });
        return scheduleRefresh();
      }
      if (action === 'execute') {
        const credentials = await secrets(task.hostIds);
        if (!credentials) return;
        await api.agentExecutePlan({ id: task.id, revision: Number(button.dataset.revision), credentials });
        return scheduleRefresh();
      }
      if (action === 'revise') { const input = $('#assistant-input', root); input.focus(); return; }
      if (action === 'keep') { await api.agentRecover({ id: task.id, action: 'keep' }); return scheduleRefresh(); }
      if (action === 'continue') {
        const credentials = await secrets(task.hostIds);
        if (!credentials) return;
        await api.agentResume({ id: task.id, message: '继续排查问题，先核实现场。', credentials });
        return scheduleRefresh();
      }
      if (action === 'undo') {
        if (!(await confirm({ title: '撤销本任务的文件改动？', text: '被修改过的文件会恢复成任务开始前的内容；如果文件在任务之后又被改过，会跳过它并告诉你。', action: '撤销改动', tone: 'primary' }))) return;
        const credentials = await secrets(task.hostIds);
        if (!credentials) return;
        const result = await api.agentRecover({ id: task.id, action: 'undo', credentials });
        toast(result.failed ? `已撤销 ${result.restored} 项，${result.failed} 项未能撤销` : `已撤销 ${result.restored} 项`, { tone: result.failed ? 'warning' : 'success' });
        return scheduleRefresh();
      }
      if (action === 'task-more') {
        return menu(button, [
          { label: '在新对话里继续这台主机', icon: 'plus', run: () => newConversation() },
          { label: '复制第一句话', icon: 'copy', run: () => api.writeClipboard(task.prompt).then(() => toast('已复制')) },
          'separator',
          { label: '删除对话…', icon: 'trash', danger: true, run: () => removeTask(task.id) },
        ]);
      }
    } catch (error) { fail(error); scheduleRefresh(); }
  });

  app.on('agent', event => { if (!event.taskId || event.taskId === currentId) scheduleRefresh(); else if (!element.hidden) scheduleRefresh(); });
  // "思考中… 12 秒" with the latest line of the model's reasoning, updated in place.
  function thinkingStep() {
    const since = Date.parse(task.events.at(-1)?.at || '') || Date.now();
    const preview = thinking?.taskId === task.id && thinking.events === task.events.length ? thinking.text : '';
    return html`<div class="msg-step thinking-step" data-thinking data-since="${since}">
      <span class="glyph-spinner" aria-hidden="true"></span><span><span class="shimmer">思考中…</span><span class="text-muted" data-elapsed>${elapsed(since)}</span></span>
      <span class="thinking-preview text-muted truncate" data-thinking-preview>${preview}</span>
    </div>`;
  }
  const elapsed = since => { const s = Math.floor((Date.now() - since) / 1000); return s >= 3 ? ` ${s} 秒` : ''; };
  setInterval(() => {
    const step = $('[data-thinking]', root);
    if (step) $('[data-elapsed]', step).textContent = elapsed(Number(step.dataset.since));
  }, 1000);
  app.on('agent-thinking', event => {
    if (event.taskId !== currentId || !task) return;
    thinking = { taskId: task.id, events: task.events.length, text: event.preview };
    const target = $('[data-thinking-preview]', root);
    if (target) target.textContent = event.preview;
  });

  app.on('agent-delta', event => {
    if (event.taskId !== currentId) return;
    const target = $(`[data-event="${event.eventId}"]`, root);
    if (!target) return scheduleRefresh();
    // Append streamed text to the last paragraph without re-rendering the page.
    const caret = $('.caret', target);
    const paragraph = target.querySelector('p:last-of-type') || target.appendChild(document.createElement('p'));
    paragraph.append(document.createTextNode(event.text));
    if (caret) paragraph.append(caret);
    const stream = $('.stream', root);
    if (stream && stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120) stream.scrollTop = stream.scrollHeight;
  });

  refresh();
  return {
    async show(params) {
      // Settings (the model) and the conversation list may have changed while away.
      try { state = await api.agentState(); } catch (error) { fail(error); }
      if (params?.taskId) { openTask(params.taskId); return; }
      // From a host: continue that host's latest conversation (a new one if it has none).
      if (params?.hostIds?.length && !params.prompt && !params.compose) {
        const ids = params.hostIds;
        const latest = state.tasks.find(t => t.hostIds.length === ids.length && ids.every(id => t.hostIds.includes(id)));
        if (latest) { openTask(latest.id); return; }
      }
      if (params?.hostIds || params?.prompt || params?.compose) {
        composing = { hostIds: params.hostIds || [], attachments: [] };
        draft = params.prompt || '';
        draw();
        $('#assistant-input', root)?.focus();
        return;
      }
      if (!currentId && state.activeId) currentId = state.activeId;
      refresh();
    },
  };
}
