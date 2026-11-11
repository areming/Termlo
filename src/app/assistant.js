// Assistant: conversation + execution console. Only four things are cards — plan, question,
// recovery, result — because only those need a decision. Everything else is one line.
import { api, html, raw, ico, render, $, $$, on, dialog, confirm, toast, fail, menu, message, duration, when, escape, selectable } from './ui.js';

const STATUS = {
  running: ['执行中', 'running'], awaiting_input: ['等你回答', 'warning'], plan_ready: ['方案待确认', 'accent'],
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

const CONSOLE_STATE = { completed: 'success', failed: 'failed', timeout: 'failed', interrupted: 'failed', running: 'running' };

export function createAssistantPage(element, app) {
  const { store } = app;
  let state = { settings: {}, tasks: [], activeId: null };
  let task = null;            // full detail of the open task
  let currentId = null;
  let composing = null;       // { hostIds, prompt, mode, attachments }
  let refreshTimer = null;
  let draft = '';

  render(element, html`<div class="assistant-page" id="assistant-root"></div>`);
  const root = $('#assistant-root', element);

  // ---- data ---------------------------------------------------------------------------
  async function refresh() {
    try {
      state = await api.agentState();
      if (currentId && state.tasks.some(t => t.id === currentId)) task = await api.agentTask(currentId);
      else if (currentId) { currentId = null; task = null; }
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
    if (!state.settings.baseUrl || !state.settings.model || state.settings.keyBroken) render(root, setupView());
    else if (composing || !task) render(root, composeView());
    else render(root, taskView());
    const stream = $('.stream', root);
    if (stream) stream.scrollTop = stream.scrollHeight;
    const input = $('#assistant-input', root);
    if (input) {
      input.value = draft;
      if (keepFocus) { input.focus(); input.setSelectionRange(caret, caret); }
    }
    const modes = $('#assistant-mode', root);
    if (modes) selectable(modes, '[role="radio"]', 'aria-checked', button => { composing.mode = button.dataset.mode; });
  }

  function header() {
    const [label, tone] = STATUS[task?.status] || ['', ''];
    return html`
      <div class="assistant-header">
        <button class="btn btn-ghost assistant-switch" type="button" data-action="tasks" aria-haspopup="menu">
          <span class="truncate">${task ? task.title : '新任务'}</span>${ico('chevron-down', 'sm')}
        </button>
        ${task ? html`<span class="badge ${tone ? 'badge-' + tone : ''}">${label}</span>` : ''}
        <span class="toolbar-spacer"></span>
        ${task ? html`<button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="task-more" aria-label="任务操作" title="任务操作">${ico('more', 'sm')}</button>` : ''}
        ${task && !composing ? html`<button class="btn btn-sm" type="button" data-action="new">${ico('plus', 'sm')}新任务</button>` : ''}
      </div>`;
  }

  function setupView() {
    return html`
      <div class="page">
        <div class="card empty empty-page">
          <span class="empty-icon">${ico('assistant', 'lg')}</span>
          <h2 class="empty-title">先连接一个模型</h2>
          <p class="empty-text">${state.settings.keyBroken ? '已保存的 API 密钥无法在这台电脑上解密，需要重新填写。' : '助手需要一个支持工具调用的模型（OpenAI 兼容接口）。密钥用系统加密保存在本机。'}</p>
          <button class="btn btn-primary" type="button" data-action="settings">${ico('settings')}设置模型</button>
        </div>
      </div>`;
  }

  function composeView() {
    composing ||= { hostIds: [], mode: 'plan', attachments: [] };
    const hosts = store.get().hosts.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const recent = state.tasks.slice(0, 6);
    return html`
      ${header()}
      <div class="compose">
        <div class="compose-main">
          <h2 class="title-lg">要在服务器上做什么？</h2>
          <p class="text-muted">用一句话说清目标。助手会先检查现场，再动手；改过的文件可以撤销。</p>
          <form class="composer composer-large" data-form="start">
            <label class="visually-hidden" for="assistant-input">任务目标</label>
            <textarea id="assistant-input" name="prompt" rows="4" placeholder="例如：用 Docker 部署 nginx，把 80 端口指向 /srv/site…" required></textarea>
            <div class="composer-bar">
              <div class="segmented segmented-sm" role="radiogroup" aria-label="助手模式" id="assistant-mode">
                <button type="button" role="radio" data-mode="plan" aria-checked="${composing.mode === 'plan'}" title="先给方案，你确认后再执行">先规划</button>
                <button type="button" role="radio" data-mode="execute" aria-checked="${composing.mode === 'execute'}" title="直接执行，过程中随时可以补充要求或暂停">直接执行</button>
              </div>
              <button class="btn btn-sm btn-ghost" type="button" data-action="pick-hosts" aria-haspopup="menu">${ico('host', 'sm')}${composing.hostIds.length ? composing.hostIds.map(app.hostLabel).join('、') : '选择主机'}</button>
              ${composing.attachments.map(a => html`<span class="badge badge-outline">${ico('attach', 'sm')}${a.name}<button class="btn btn-icon btn-sm btn-ghost chip-remove" type="button" data-drop="${a.id}" aria-label="移除附件 ${a.name}" title="移除">${ico('close', 'sm')}</button></span>`)}
              <span class="toolbar-spacer"></span>
              <button class="btn btn-icon btn-sm btn-ghost" type="button" data-action="attach" aria-label="添加附件" title="添加附件">${ico('attach', 'sm')}</button>
              <button class="btn btn-primary btn-sm" type="submit" ${!hosts.length ? raw('disabled') : ''}>${ico('send', 'sm')}开始</button>
            </div>
          </form>
          ${!hosts.length ? html`<p class="text-muted">还没有主机。<a href="#hosts" data-action="add-host">先添加一台</a>。</p>` : ''}
        </div>
        ${recent.length ? html`
          <div class="compose-recent">
            <h3 class="section-title">最近的任务</h3>
            <ul class="list">${recent.map(t => html`
              <li class="row"><button class="row-button" type="button" data-task="${t.id}">
                <span class="row-main"><span class="row-title truncate">${t.title}</span><span class="row-meta">${when(t.updatedAt)}</span></span>
                <span class="badge ${STATUS[t.status]?.[1] ? 'badge-' + STATUS[t.status][1] : ''}">${STATUS[t.status]?.[0] || t.status}</span>
              </button></li>`)}</ul>
          </div>` : ''}
      </div>`;
  }

  function taskView() {
    const running = task.status === 'running';
    const tools = task.events.filter(e => e.type === 'tool' && toolLabel(e));
    const runningTool = running ? [...task.events].reverse().find(e => e.type === 'tool' && e.status === 'running') : null;
    const placeholder = running ? '补充要求，例如 不要重启数据库…（立即生效）'
      : task.status === 'awaiting_input' ? '也可以直接写回答…'
      : task.status === 'plan_ready' ? '想改方案就直接说…'
      : '继续对话，或说明下一步…';
    return html`
      ${header()}
      <div class="assistant">
        <div class="conversation">
          <div class="stream" aria-live="polite">
            ${task.events.map(event => streamItem(event))}
            ${runningTool && toolLabel(runningTool) ? html`<p class="msg-step"><span class="spinner"></span>正在${toolLabel(runningTool)}…</p>` : ''}
            ${running && !runningTool && !task.events.at(-1)?.streaming ? html`<p class="msg-step"><span class="spinner"></span>思考中…</p>` : ''}
            ${task.recovery ? recoveryCard() : ''}
            ${task.notice && !running && task.status !== 'completed' && !task.events.some(e => (e.type === 'notice' && e.content === task.notice) || (e.type === 'result' && e.report?.headline === task.notice)) ? html`<p class="msg-step" data-tone="warning">${ico('status-warning')}${task.notice}</p>` : ''}
          </div>
          <form class="composer" data-form="${running ? 'followup' : 'resume'}">
            <label class="visually-hidden" for="assistant-input">给助手的消息</label>
            <textarea id="assistant-input" name="message" rows="2" placeholder="${placeholder}"></textarea>
            <div class="composer-bar">
              ${task.hostIds.map(id => html`<span class="badge badge-outline">${ico('host', 'sm')}${app.hostLabel(id)}</span>`)}
              <span class="text-xs text-muted">${task.mode === 'plan' ? '规划中' : '执行'} · ${task.rounds} 轮</span>
              <span class="toolbar-spacer"></span>
              ${running
                ? html`<button class="btn btn-sm" type="button" data-action="pause">${ico('stop', 'sm')}暂停</button>
                       <button class="btn btn-primary btn-sm" type="submit">${ico('send', 'sm')}补充</button>`
                : html`<button class="btn btn-primary btn-sm" type="submit">${ico('send', 'sm')}${task.status === 'paused' ? '继续' : '发送'}</button>`}
            </div>
          </form>
        </div>
        <aside class="console" aria-label="执行台">
          <div class="console-header">
            <span class="console-title">执行台</span>
            ${running ? html`<span class="status" data-state="running"><span class="dot"></span>执行中</span>` : html`<span class="text-xs text-muted">${tools.length} 步</span>`}
          </div>
          ${tools.length ? html`<ul class="console-list">${tools.map(consoleRow)}</ul>`
            : html`<p class="console-empty text-muted">助手执行的每一步都会出现在这里，点开可以看到原始命令和输出。</p>`}
        </aside>
      </div>`;
  }

  function streamItem(event) {
    switch (event.type) {
      case 'user': return html`<div class="msg msg-user">${prose(event.content)}${event.attachments?.length ? html`<p class="text-xs">${ico('attach', 'sm')}${event.attachments.map(a => a.name).join('、')}</p>` : ''}</div>`;
      case 'answer': return html`<div class="msg msg-user">${prose(event.content.replace(/^用户回答：\n/, ''))}</div>`;
      case 'assistant':
        if (event.superseded || (!event.content && !event.streaming)) return '';
        return html`<div class="msg msg-assistant" data-event="${event.id}">${prose(event.content)}${event.streaming ? html`<span class="caret" aria-hidden="true"></span>` : ''}</div>`;
      case 'notice': return html`<p class="msg-step" data-tone="warning">${ico('status-info')}${event.content}</p>`;
      case 'approval': return html`<p class="msg-step" data-tone="success">${ico('play')}${event.content}</p>`;
      case 'question': return questionCard(event);
      case 'proposal': return planCard(event);
      case 'result': return resultCard(event);
      default: return '';
    }
  }

  function consoleRow(event) {
    const state = CONSOLE_STATE[event.status] || (event.result?.error ? 'failed' : 'success');
    const r = event.result || {};
    const elapsed = event.finishedAt ? duration(new Date(event.finishedAt) - new Date(event.at)) : '';
    const command = event.name === 'run' ? event.args?.command
      : event.name === 'read_file' || event.name === 'write_file' ? event.args?.path
      : event.name === 'web' ? (event.args?.query || event.args?.url) : event.name === 'inspect' ? `inspect ${event.args?.topic || ''} ${event.args?.target || ''}` : '';
    const output = r.error ? r.error : r.output ?? (r.content ? r.content.slice(0, 4000) : r.sha256 ? `sha256 ${r.sha256}` : JSON.stringify(r, null, 2).slice(0, 2000));
    return html`
      <li>
        <details class="console-row" data-state="${state}">
          <summary>
            <span class="row-state">${state === 'running' ? html`<span class="spinner"></span>` : ico(state === 'success' ? 'check' : 'close', 'sm')}</span>
            <span class="console-label">${toolLabel(event)}</span>
            <span class="console-meta">${state === 'running' ? '运行中' : r.exitCode !== undefined && r.exitCode !== 0 ? `退出码 ${r.exitCode}` : elapsed}</span>
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
          <span class="hint">执行时改过的文件都可以撤销</span>
          <button class="btn btn-ghost" type="button" data-action="revise">修改方案</button>
          <button class="btn btn-primary" type="button" data-action="execute" data-revision="${p.revision}" ${p.questions.length ? raw('disabled') : ''}>${ico('play', 'sm')}执行方案</button>
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
        <footer class="decision-footer"><span class="hint">${task.rounds} 轮 · ${task.events.filter(e => e.type === 'tool' && toolLabel(e)).length} 步</span></footer>
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

  // ---- actions ------------------------------------------------------------------------------
  async function start(form) {
    const prompt = form.prompt.value.trim();
    if (!prompt) return;
    if (!composing.hostIds.length) { toast('请先选择主机', { tone: 'warning' }); return $('[data-action="pick-hosts"]', root)?.focus(); }
    try {
      const { id } = await api.agentStart({ prompt, hostIds: composing.hostIds, mode: composing.mode, attachmentIds: composing.attachments.map(a => a.id) });
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
        await api.agentResume({ id: task.id, message: text });
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
    try { await api.agentAnswer({ id: task.id, requestId: request.id, answers }); scheduleRefresh(); }
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

  function taskMenu(button) {
    menu(button, [
      ...state.tasks.slice(0, 15).map(t => ({ label: `${t.title} · ${STATUS[t.status]?.[0] || ''}`, icon: t.id === currentId ? 'check' : 'assistant', run: () => openTask(t.id) })),
      ...(state.tasks.length ? ['separator'] : []),
      { label: '新任务', icon: 'plus', run: () => { composing = { hostIds: task?.hostIds || [], mode: 'plan', attachments: [] }; draft = ''; draw(); } },
    ]);
  }

  // ---- events ------------------------------------------------------------------------------
  root.addEventListener('input', event => { if (event.target.id === 'assistant-input') draft = event.target.value; });
  root.addEventListener('keydown', event => {
    if (event.target.id === 'assistant-input' && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
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
  on(root, 'click', '[data-drop]', (_e, button) => { api.agentDropAttachment(button.dataset.drop).catch(() => {}); composing.attachments = composing.attachments.filter(a => a.id !== button.dataset.drop); draw(); });
  on(root, 'click', '[data-copy]', (_e, button) => api.writeClipboard(button.dataset.copy).then(() => toast('已复制')).catch(fail));
  on(root, 'click', '[data-action]', async (event, button) => {
    const action = button.dataset.action;
    if (action === 'settings') return app.navigate('settings', { section: 'model' });
    if (action === 'add-host') { event.preventDefault(); return app.navigate('hosts', { add: true }); }
    if (action === 'new') { composing = { hostIds: task?.hostIds || [], mode: 'plan', attachments: [] }; draft = ''; return draw(); }
    if (action === 'tasks') return taskMenu(button);
    if (action === 'pick-hosts') return pickHosts(button);
    if (action === 'attach') {
      try { const files = await api.agentPickAttachments(); composing.attachments.push(...files); draw(); } catch (error) { fail(error); }
      return;
    }
    if (!task) return;
    try {
      if (action === 'pause') { await api.agentPause(task.id); return scheduleRefresh(); }
      if (action === 'execute') { await api.agentExecutePlan({ id: task.id, revision: Number(button.dataset.revision) }); return scheduleRefresh(); }
      if (action === 'revise') { const input = $('#assistant-input', root); input.focus(); return; }
      if (action === 'keep') { await api.agentRecover({ id: task.id, action: 'keep' }); return scheduleRefresh(); }
      if (action === 'continue') { await api.agentResume({ id: task.id, message: '继续排查问题，先核实现场。' }); return scheduleRefresh(); }
      if (action === 'undo') {
        if (!(await confirm({ title: '撤销本任务的文件改动？', text: '被修改过的文件会恢复成任务开始前的内容；如果文件在任务之后又被改过，会跳过它并告诉你。', action: '撤销改动', tone: 'primary' }))) return;
        const result = await api.agentRecover({ id: task.id, action: 'undo' });
        toast(result.failed ? `已撤销 ${result.restored} 项，${result.failed} 项未能撤销` : `已撤销 ${result.restored} 项`, { tone: result.failed ? 'warning' : 'success' });
        return scheduleRefresh();
      }
      if (action === 'task-more') {
        return menu(button, [
          { label: '复制任务目标', icon: 'copy', run: () => api.writeClipboard(task.prompt).then(() => toast('已复制')) },
          'separator',
          { label: '删除任务…', icon: 'trash', danger: true, run: async () => {
            if (!(await confirm({ title: '删除这个任务？', text: '只删除本机上的任务记录，不影响服务器。', action: '删除任务' }))) return;
            try { await api.agentRemove(task.id); currentId = null; task = null; refresh(); } catch (error) { fail(error); }
          } },
        ]);
      }
    } catch (error) { fail(error); scheduleRefresh(); }
  });

  app.on('agent', event => { if (!event.taskId || event.taskId === currentId) scheduleRefresh(); else if (!element.hidden) scheduleRefresh(); });
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
    show(params) {
      if (params?.hostIds || params?.prompt || params?.compose) {
        composing = { hostIds: params.hostIds || [], mode: 'plan', attachments: [] };
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
