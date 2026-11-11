// Natural language in the command line: type "# 问题" at the prompt and press Enter.
// The line is a shell comment, so nothing runs if this is triggered by mistake. The question
// goes to the model with the last lines of the screen (redacted in the main process) and comes
// back as commands in a bar over the bottom of the terminal:
//   ↵ run in this shell · Tab put it on the command line · Esc close.
// Risky commands (same rules as the assistant's risk gate) need ↵ twice. Jobs that need many
// steps can be handed to the assistant, which works on its own connection in the background.
import { api, html, ico, render, $, on, toast, fail, message } from './ui.js';

// What the user has typed on the current shell line, as far as we can tell. null = unknown
// (history recall, completion, cursor movement): then "#" is never intercepted.
export function trackLine(tab, data) {
  if (data === '\r' || data === '\x03' || data === '\x15') { tab.line = ''; return; }
  if (data === '\x7f' || data === '\b') { if (tab.line !== null) tab.line = tab.line.slice(0, -1); return; }
  if (data.includes('\r')) { const rest = data.slice(data.lastIndexOf('\r') + 1); tab.line = /[\x00-\x1f]/.test(rest) ? null : rest; return; }
  if (/[\x00-\x1f\x7f]/.test(data)) { tab.line = null; return; }
  if (tab.line !== null) tab.line += data;
}

// "# 问题" on a shell prompt (not inside vim/less/top, which use the alternate screen).
export function questionOf(tab) {
  if (tab.line == null || tab.term.buffer.active.type !== 'normal') return null;
  const match = tab.line.match(/^\s*#(?!!)\s*(\S.+)$/);
  return match && match[1].trim().length >= 2 ? match[1].trim() : null;
}

export function screenText(term, lines = 40) {
  const buffer = term.buffer.active;
  const end = buffer.baseY + buffer.cursorY;
  const out = [];
  for (let i = Math.max(0, end - lines); i <= end; i++) out.push(buffer.getLine(i)?.translateToString(true) ?? '');
  return out.join('\n').replace(/\s+$/, '');
}

export function createAsk({ host: container, before = null, app, onResize = () => {} }) {
  const bar = document.createElement('div');
  bar.className = 'ask-bar';
  bar.hidden = true;
  bar.setAttribute('role', 'dialog');
  bar.setAttribute('aria-label', '问 AI');
  // Part of the layout (between the terminal and the status bar): the terminal shrinks, so the
  // prompt and the latest output stay visible.
  container.insertBefore(bar, before);
  new ResizeObserver(() => onResize()).observe(bar);
  let state = null;   // { tab, question, screen, phase: 'asking'|'answer'|'error', answer, selected, armed, error, seq }
  let seq = 0;

  function draw() {
    if (!state) { bar.hidden = true; return; }
    bar.hidden = false;
    const { phase, answer } = state;
    render(bar, html`
      <form class="ask-head" data-ask-form>
        <span class="ask-mark" aria-hidden="true">${ico('assistant', 'sm')}</span>
        <input class="ask-input" name="q" value="${state.question}" placeholder="用一句话描述要做什么…" aria-label="问题" autocomplete="off" spellcheck="false">
        ${phase === 'asking' ? html`<span class="spinner" aria-label="思考中"></span>` : ''}
        <button class="btn btn-icon btn-sm btn-ghost" type="button" data-ask="close" aria-label="关闭" title="关闭 (Esc)">${ico('close', 'sm')}</button>
      </form>
      ${phase === 'error' ? html`<p class="ask-note" data-tone="danger">${ico('status-warning', 'sm')}${state.error}${state.setup ? html` <button class="btn btn-sm btn-ghost" type="button" data-ask="settings">去设置</button>` : ''}</p>` : ''}
      ${phase === 'answer' ? html`
        ${answer.note ? html`<p class="ask-note">${answer.note}</p>` : ''}
        ${answer.commands.length ? html`
          <ul class="ask-commands" role="listbox" aria-label="命令" tabindex="0" data-ask-list>
            ${answer.commands.map((c, i) => html`
              <li class="ask-command" role="option" aria-selected="${i === state.selected}" data-index="${i}">
                <code translate="no">${c.command}</code>
                ${c.explain ? html`<span class="ask-explain">${c.explain}</span>` : ''}
                ${c.risk ? html`<span class="ask-risk">${ico('status-warning', 'sm')}${c.risk}${i === state.selected && state.armed ? '，再按 ↵ 运行' : ''}</span>` : ''}
              </li>`)}
          </ul>` : ''}
        <div class="ask-foot">
          ${answer.commands.length ? html`
            <button class="btn btn-sm ${answer.commands[state.selected]?.risk ? 'btn-danger' : 'btn-primary'}" type="button" data-ask="run">${ico('play', 'sm')}运行<kbd>↵</kbd></button>
            <button class="btn btn-sm" type="button" data-ask="insert">放到命令行<kbd>Tab</kbd></button>
            <button class="btn btn-icon btn-sm btn-ghost" type="button" data-ask="copy" aria-label="复制命令" title="复制命令">${ico('copy', 'sm')}</button>` : ''}
          <span class="toolbar-spacer"></span>
          <button class="btn btn-sm ${answer.handoff ? 'btn-primary' : 'btn-ghost'}" type="button" data-ask="handoff" title="助手用自己的连接在后台一步步完成，危险操作会先问你">${ico('assistant', 'sm')}交给助手完成</button>
        </div>` : ''}`);
  }

  async function ask(tab, question, screen = screenText(tab.term)) {
    const mine = ++seq;
    state = { tab, question, screen, phase: 'asking', selected: 0, armed: false };
    draw();
    try {
      const answer = await api.agentSuggest({ hostId: tab.hostId, question, screen });
      if (mine !== seq || !state) return;
      state = { ...state, phase: 'answer', answer };
      draw();
      ($('[data-ask-list]', bar) || $('[data-ask="handoff"]', bar))?.focus();
    } catch (error) {
      if (mine !== seq || !state) return;
      const text = message(error);
      state = { ...state, phase: 'error', error: text, setup: /配置模型/.test(text) };
      draw();
      $('.ask-input', bar)?.focus();
    }
  }

  function close() {
    const tab = state?.tab;
    seq++;
    state = null;
    draw();
    tab?.term.focus();
  }

  function selected() { return state?.answer?.commands[state.selected]; }

  function run() {
    const command = selected();
    if (!command || state.tab.status !== 'ready') return;
    if (command.risk && !state.armed) { state.armed = true; draw(); $('[data-ask-list]', bar)?.focus(); return; }
    api.write(state.tab.id, command.command.replace(/\r?\n/g, '\r') + '\r');
    state.tab.line = '';
    close();
  }

  function insert() {
    const command = selected();
    if (!command || state.tab.status !== 'ready') return;
    const text = command.command.replace(/\r?\n/g, ' ');
    api.write(state.tab.id, text);
    state.tab.line = text;
    close();
  }

  async function handoff() {
    const { tab, question, screen } = state;
    const credentials = await app.credentials(tab.hostId);
    if (!credentials) return;
    try {
      const prompt = `${question}\n\n（来自 ${app.hostLabel(tab.hostId)} 的终端，屏幕最近内容：）\n\`\`\`\n${screen.slice(-3000)}\n\`\`\``;
      const { id } = await api.agentStart({ prompt, hostIds: [tab.hostId], credentials });
      close();
      toast('已交给助手，在后台处理', { action: '查看', onAction: () => app.navigate('assistant', { taskId: id }), timeout: 6000 });
    } catch (error) { fail(error); }
  }

  bar.addEventListener('submit', event => {
    event.preventDefault();
    const question = event.target.q.value.trim();
    if (question && state) ask(state.tab, question, state.screen);
  });
  bar.addEventListener('keydown', event => {
    if (!state) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (!event.target.closest('[data-ask-list]')) return;
    const count = state.answer?.commands.length || 0;
    if (event.key === 'Enter') { event.preventDefault(); run(); }
    else if (event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); insert(); }
    else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && count) {
      event.preventDefault();
      state.selected = (state.selected + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
      state.armed = false;
      draw(); $('[data-ask-list]', bar)?.focus();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      $('.ask-input', bar)?.focus();   // typing refines the question
    }
  });
  on(bar, 'click', '[data-index]', (_e, item) => { state.selected = Number(item.dataset.index); state.armed = false; draw(); $('[data-ask-list]', bar)?.focus(); });
  on(bar, 'click', '[data-ask]', (_e, button) => {
    const action = button.dataset.ask;
    if (action === 'close') close();
    else if (action === 'run') run();
    else if (action === 'insert') insert();
    else if (action === 'copy') api.writeClipboard(selected()?.command || '').then(() => toast('已复制')).catch(fail);
    else if (action === 'handoff') handoff();
    else if (action === 'settings') { close(); app.navigate('settings', { section: 'model' }); }
  });

  return {
    ask,
    open(tab, { question = '', screen } = {}) {
      state = { tab, question, screen: screen ?? screenText(tab.term), phase: 'idle', selected: 0, armed: false };
      draw();
      const input = $('.ask-input', bar);
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    },
    close,
    get openFor() { return state?.tab || null; },
  };
}
