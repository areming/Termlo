// The assistant inside the command line. Type "# 问题" at the prompt and press Enter: the shell
// gets a comment (does nothing; the question stays in the scrollback) and the same assistant as
// the assistant page takes over this terminal until it is done — it looks around on its own
// connection, thinks, acts, and asks here when it needs a decision:
//   ● text   ● tool  ⎿ result        (committed lines, scroll like normal output)
//   ✻ 思考中… (12s · Esc 中断)         (live region: spinner, menus, the reply prompt)
// Risky operations stop at the same risk gate (↑↓ ↵ to allow or not), plans wait for "执行方案".
// While a session is open, shell output is held and keystrokes go to the session; Esc on the
// reply prompt hands the shell back. The conversation also shows on the assistant page.
import { api } from './ui.js';
import { cellWidth, row, tail, hang } from './term-text.mjs';

// ---- the shell line -------------------------------------------------------------------

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

// ---- drawing helpers --------------------------------------------------------------------

const sgr = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
const dim = text => sgr('2', text);
const GUARD = /先用 inspect|先用 read_file|现场验证|不能标记完成|还有命令在运行|逐项报告|不在本任务范围|规划阶段不能/;
const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const HIDE_CURSOR = '\x1b[?25l', SHOW_CURSOR = '\x1b[?25h';

// Light Markdown for the model's prose: **bold**, `code`, headings, fenced code.
function prose(text) {
  let code = false;
  const out = [];
  for (const raw of String(text || '').replace(/\r/g, '').trim().split('\n')) {
    if (/^\s*```/.test(raw)) { code = !code; continue; }
    if (code) { out.push(sgr('36', raw)); continue; }
    out.push(raw
      .replace(/^#{1,6}\s+(.*)$/, (_m, t) => `\x1b[1m${t}\x1b[22m`)
      .replace(/\*\*(.+?)\*\*/g, (_m, t) => `\x1b[1m${t}\x1b[22m`)
      .replace(/`([^`\n]+)`/g, (_m, t) => `\x1b[36m${t}\x1b[39m`));
  }
  return out;
}
// "● first line" then the rest indented under it.
const bullet = (mark, lines) => lines.map((line, i) => (i ? '  ' : mark + ' ') + line).join('\r\n') + '\r\n';

const shorten = (text, n = 60) => { const line = String(text || '').trim().split('\n')[0]; return line.length > n ? line.slice(0, n - 1) + '…' : line; };
const basename = path => String(path || '').split('/').filter(Boolean).pop() || path;
function toolLabel(event) {
  const a = event.args || {};
  switch (event.name) {
    case 'run': return `运行 ${shorten(a.command, 80)}`;
    case 'inspect': return { overview: '检查系统概况', docker: '查看 Docker 容器', service: `检查服务 ${a.target || ''}`, process: `查找进程 ${a.target || ''}` }[a.topic] || '只读检查';
    case 'read_file': return `读取 ${a.path || ''}`;
    case 'write_file': return `修改 ${a.path || ''}（可撤销）`;
    case 'upload': return '上传附件';
    case 'wait': return '等待后台命令';
    case 'cancel': return '停止后台命令';
    case 'web': return a.query ? `搜索 ${shorten(a.query, 50)}` : `读取网页 ${shorten(a.url, 50)}`;
    default: return '';   // ask / plan / finish show as their own blocks
  }
}

// ---- sessions ---------------------------------------------------------------------------

export function createTerminalAI({ app }) {
  const sessions = new Map();   // taskId -> session

  app.on('agent', event => { const s = sessions.get(event.taskId); if (s) s.refresh(); });
  app.on('agent-thinking', event => { const s = sessions.get(event.taskId); if (s) s.preview = event.preview || ''; });

  function begin(tab, question, { context } = {}) {
    if (tab.ai) return;
    const s = new Session(tab, sessions, app);
    tab.ai = s;
    s.open(question, context ?? screenText(tab.term));
  }

  // "问 AI" from the menu or the tab bar: put "# " on an empty shell line, or ask straight away
  // about a selection (typed into the shell as a comment, so it is in the scrollback too).
  function prompt(tab, { question, context } = {}) {
    if (tab.ai || tab.status !== 'ready') return;
    tab.term.focus();
    if (!question) {
      if (tab.line === '') { api.write(tab.id, '# '); tab.line = '# '; }
      return;
    }
    const clear = tab.line === '' ? '' : '\x05\x15';   // end of line, kill it (Ctrl+Y brings it back)
    api.write(tab.id, clear + '# ' + question);
    tab.line = '';
    setTimeout(() => { if (!tab.ai && tab.status === 'ready') begin(tab, question, { context }); }, 250);   // let the echo land first
  }

  return {
    begin, prompt,
    key: (tab, data) => tab.ai?.key(data),
    hold: (tab, bytes) => tab.ai ? (tab.ai.hold(bytes), true) : false,
    detach: tab => tab.ai?.detach(),
  };
}

class Session {
  constructor(tab, registry, app) {
    Object.assign(this, {
      tab, registry, app, busy: false, epoch: 0, term: tab.term, held: [], heldBytes: 0, live: 0, phase: 'starting', menu: null, input: null,
      printed: new Set(), done: new Set(), preview: '', frame: 0, since: Date.now(), task: null, taskId: null, credentials: null,
      timer: null, fetching: false, again: false, label: '',
      echoing: true,   // shell output passes through until the newline after the comment
    });
    this.echoed = new Promise(resolve => { this.onEcho = resolve; });
  }

  // ---- lifecycle ----
  async open(question, context) {
    api.write(this.tab.id, '\r');   // the shell runs the comment; the rest of its echo and the newline pass, the next prompt is held
    const echoed = await Promise.race([this.echoed.then(() => true), new Promise(resolve => setTimeout(resolve, 1500, false))]);
    if (this.phase === 'ended') return;
    if (!echoed) { this.echoing = false; this.write('\r\n'); }   // a silent shell: move on ourselves
    this.write(HIDE_CURSOR);
    this.spin('准备中');
    try {
      const { settings } = await api.agentState();
      if (!settings?.baseUrl || !settings?.model || !settings?.hasKey) {
        return this.close(sgr('33', '! 还没有配置模型。') + dim('在 设置 › 模型 里填好地址、模型和密钥后再试。') + '\r\n');
      }
      this.credentials = await this.app.credentials(this.tab.hostId);
      if (!this.credentials) return this.close(dim('已取消') + '\r\n');
      // Follow-up questions in the same tab continue the same conversation for a while.
      const previous = this.tab.aiTask && Date.now() - this.tab.aiTask.at < 30 * 60000 ? this.tab.aiTask.id : null;
      let id;
      if (previous) {
        try {
          const old = await api.agentTask(previous);
          for (const e of old.events) this.printed.add(e.id);
          ({ id } = await api.agentResume({ id: previous, message: question, credentials: this.credentials, context }));
        } catch { id = null; }
      }
      if (!id) ({ id } = await api.agentStart({ prompt: question, hostIds: [this.tab.hostId], credentials: this.credentials, context, origin: 'terminal' }));
      this.taskId = id;
      this.tab.aiTask = { id, at: Date.now() };
      this.registry.set(id, this);
      this.phase = 'running';
      this.refresh();
    } catch (error) {
      this.close(sgr('31', '✕ ' + (error?.message || String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) + '\r\n');
    }
  }

  // Hand the shell back: drop the live region, show the held prompt.
  close(lastWords = '') {
    this.stopSpin();
    this.clearLive();
    this.write(lastWords + SHOW_CURSOR);
    this.phase = 'ended';
    if (this.taskId) this.registry.delete(this.taskId);
    this.tab.ai = null;
    this.tab.line = '';
    let first = !this.sawNewline;
    for (const chunk of this.held) {
      let bytes = chunk;
      if (first && bytes.length) {   // a late newline from the shell: we are already on a fresh line
        if (bytes[0] === 13 && bytes[1] === 10) bytes = bytes.subarray(2); else if (bytes[0] === 10) bytes = bytes.subarray(1);
        first = false;
      }
      this.term.write(bytes);
    }
    this.held = [];
    this.term.focus();
  }

  // The tab closed or the connection dropped: stop drawing; the conversation goes on in the assistant.
  detach() {
    this.stopSpin();
    if (this.live) this.clearLive();
    this.write(SHOW_CURSOR);
    this.phase = 'ended';
    if (this.taskId) this.registry.delete(this.taskId);
    this.tab.ai = null;
    this.held = [];
  }

  hold(bytes) {
    if (this.echoing) {
      const newline = bytes.indexOf(10);
      if (newline < 0) { this.term.write(bytes); return; }
      this.term.write(bytes.subarray(0, newline + 1));
      this.echoing = false;
      this.sawNewline = true;
      this.onEcho();
      bytes = bytes.subarray(newline + 1);
      if (!bytes.length) return;
    }
    this.held.push(bytes);
    this.heldBytes += bytes.length;
    while (this.heldBytes > 1 << 20 && this.held.length > 1) this.heldBytes -= this.held.shift().length;
  }

  write(text) { this.term.write(text); }

  // ---- live region ----
  clearLive() {
    if (!this.live) return;
    this.write('\r' + (this.live > 1 ? `\x1b[${this.live - 1}A` : '') + '\x1b[J');
    this.live = 0;
  }
  // Committed text goes above the live region and stays.
  commit(text) {
    this.clearLive();
    this.write(hang(text, this.term.cols));
    this.draw();
  }
  draw() {
    if (this.phase === 'ended') return;
    const width = Math.max(20, this.term.cols);
    const rows = [];
    if (this.phase === 'running' || this.phase === 'starting') {
      const glyph = SPIN[this.frame % SPIN.length];
      const seconds = Math.floor((Date.now() - this.since) / 1000);
      rows.push(row(width, ['36', glyph + ' '], ...shimmer(this.label || '思考中', this.frame), ['2', `  ${seconds}s · Esc 中断`]));
      if (this.preview && !this.label.startsWith('运行')) rows.push(row(width, ['2', '  ⎿ ' + this.preview]));
    } else if (this.phase === 'menu') {
      const { options, index } = this.menu;
      options.forEach((option, i) => rows.push(i === index
        ? row(width, ['36;1', `❯ ${i + 1}. ${option.label}`], ['2', option.hint ? '  ' + option.hint : ''])
        : row(width, ['', `  ${i + 1}. ${option.label}`], ['2', option.hint ? '  ' + option.hint : ''])));
      rows.push(row(width, ['2', `  ↑↓ 选择 · ↵ 确认 · Esc ${this.menu.escLabel || '取消'}`]));
    } else if (this.phase === 'input') {
      rows.push(row(width, ['2', this.input.hint]));
      rows.push(sgr('36;1', '› ') + tail(this.input.text, width - 4));
    }
    this.write((this.phase === 'input' ? SHOW_CURSOR : HIDE_CURSOR) + rows.join('\r\n'));
    this.live = rows.length;
  }
  redraw() { if (this.phase !== 'ended') { this.clearLive(); this.draw(); } }

  spin(label) {
    this.phase = this.phase === 'starting' ? 'starting' : 'running';
    this.label = label || '';
    if (!this.timer) this.timer = setInterval(() => { this.frame++; this.redraw(); }, 110);
    this.redraw();
  }
  stopSpin() { clearInterval(this.timer); this.timer = null; }

  // ---- task updates ----
  async refresh() {
    if (!this.taskId || this.phase === 'ended' || this.busy) return;   // act() refreshes when the action is done
    if (this.fetching) { this.again = true; return; }
    this.fetching = true;
    const epoch = this.epoch;
    try {
      const [task, state] = await Promise.all([api.agentTask(this.taskId), api.agentState()]);
      if (this.phase !== 'ended' && !this.busy && epoch === this.epoch) this.sync(task, state.runningIds?.includes(this.taskId));
      else this.again = true;
    } catch { /* the next event retries */ }
    this.fetching = false;
    if (this.again) { this.again = false; this.refresh(); }
  }

  sync(task, running) {
    this.task = task;
    let out = '';
    for (const event of task.events) {
      if (this.printed.has(event.id)) continue;
      const text = this.render(event, task);
      if (text === null) continue;   // not final yet
      this.printed.add(event.id);
      out += text;
    }
    if (out) { this.clearLive(); this.write(hang(out, this.term.cols)); }
    if (running) {
      const tool = [...task.events].reverse().find(e => e.type === 'tool' && e.status === 'running');
      const streaming = task.events.at(-1)?.streaming;
      if (this.phase !== 'running') { this.phase = 'running'; }
      this.label = tool ? toolLabel(tool) || '执行中' : streaming ? '回答中' : '思考中';
      if (!this.timer) this.spin(this.label); else this.redraw();
      return;
    }
    this.stopSpin();
    this.preview = '';
    const pending = task.interaction?.status === 'pending' ? task.interaction : null;
    if (pending?.kind === 'approval') return this.approvalMenu(pending);
    if (pending?.questions) return this.questionFlow(pending);
    if (task.status === 'plan_ready' && task.proposal && !task.proposal.questions?.length) return this.planMenu(task.proposal);
    this.askReply(task);
  }

  // Committed text for one event; '' to skip it, null if it is not final yet.
  render(event, task) {
    switch (event.type) {
      case 'assistant':
        if (event.streaming) return null;
        return event.content.trim() ? bullet(sgr('37;1', '●'), prose(event.content)) + '\r\n' : '';
      case 'tool': {
        if (event.status === 'running') return null;
        const label = toolLabel(event);
        if (!label || event.result?.notExecuted) return '';
        const failed = ['failed', 'interrupted', 'timeout'].includes(event.status) || event.result?.error;
        if (event.status === 'failed' && GUARD.test(event.result?.error || '')) return '';   // refused before running; the next step shows
        const head = sgr(failed ? '31' : '32', '●') + ' ' + sgr('1', label) + '\r\n';
        return head + this.toolSummary(event, failed);
      }
      case 'approval-request': {
        const r = event.request;
        return sgr('33', '⚠  需要确认：' + r.reason) + '\r\n' + (r.command ? sgr('36', '  $ ' + r.command.replace(/\n/g, '\r\n    ')) : sgr('36', '  写入 ' + r.path)) + '\r\n';
      }
      case 'proposal': {
        const p = event.proposal;
        const lines = [sgr('1', '◆ 方案：' + p.title), dim('  ' + p.summary)];
        p.steps.forEach((step, i) => lines.push(`  ${i + 1}. ${step}`));
        if (p.checks?.length) lines.push(dim('  验收：' + p.checks.join('；')));
        if (p.risks?.length) lines.push(sgr('33', '  风险：' + p.risks.join('；')));
        return lines.join('\r\n') + '\r\n';
      }
      case 'result': {
        const r = event.report || {};
        const ok = r.outcome === 'completed';
        return sgr(ok ? '32' : '33', (ok ? '✔ ' : '! ') + (r.headline || event.content)) + '\r\n\r\n';
      }
      case 'notice':
        return sgr('33', '! ') + dim(event.content) + '\r\n';
      default:
        return '';   // user / answer / approval / question / recovery: shown by the prompts here
    }
  }

  toolSummary(event, failed) {
    const r = event.result || {};
    const width = Math.max(20, this.term.cols);
    const ran = (event.name === 'run' || event.name === 'wait') && !r.error && r.exitCode !== undefined;   // ran and exited non-zero: its output says why
    if (failed && !ran) return row(width, ['2', '  ⎿ '], ['31', r.error || r.warning || { interrupted: '已中断，结果未知', timeout: '超时，结果未知' }[event.status] || '失败']) + '\r\n';
    if (event.name === 'run' || event.name === 'wait') {
      const lines = String(r.output || '').replace(/\r/g, '').split('\n').filter(l => l.trim());
      const shown = lines.slice(0, 3).map((l, i) => row(width, ['2', (i ? '    ' : '  ⎿ ') + l]));
      if (lines.length > 3) shown.push(row(width, ['2', `    … 另 ${lines.length - 3} 行`]));
      if (!lines.length) shown.push(row(width, ['2', '  ⎿ ' + (r.exitCode ? `退出码 ${r.exitCode}` : '完成，无输出')]));
      else if (r.exitCode) shown.push(row(width, ['33', `    退出码 ${r.exitCode}`]));
      return shown.join('\r\n') + '\r\n';
    }
    if (event.name === 'write_file') return row(width, ['2', '  ⎿ 已写入，可在助手页撤销']) + '\r\n';
    return '';
  }

  // ---- prompts ----
  showMenu(key, options, { escLabel, onEsc } = {}) {
    if (this.menu?.key === key && this.phase === 'menu') return;
    if (this.done.has(key)) return;
    this.stopSpin();
    this.menu = { key, options, index: 0, escLabel, onEsc };
    this.phase = 'menu';
    this.redraw();
  }

  pick(option) {
    const key = this.menu.key;
    this.done.add(key);
    this.clearLive();
    this.write(dim('  → ' + option.label) + '\r\n\r\n');
    this.menu = null;
    this.phase = 'running';
    this.since = Date.now();
    this.spin('思考中');
    const result = option.run();
    if (result?.then) this.act(result);
  }

  // A user action (allow, answer, reply, pause): until it has reached the main process, a fetched
  // task may still show the old prompt.
  act(promise) {
    this.busy = true;
    Promise.resolve(promise).then(() => { this.busy = false; this.epoch++; this.refresh(); }, error => { this.busy = false; this.fail(error); });
  }

  fail(error) {
    this.stopSpin();
    this.clearLive();
    this.write(hang(sgr('31', '✕ ' + String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), this.term.cols) + '\r\n');
    if (!this.taskId) return this.close();
    this.phase = 'starting';
    this.refresh();
  }

  approvalMenu(request) {
    const answer = allow => () => api.agentApprove({ id: this.taskId, requestId: request.id, allow, credentials: this.credentials });
    this.showMenu('approval:' + request.id, [
      { label: '允许执行', hint: '只放行这一次', run: answer(true) },
      { label: '不执行', hint: '助手会换别的办法或说明情况', run: answer(false) },
    ], { escLabel: '不执行', onEsc: 1 });
  }

  planMenu(proposal) {
    this.showMenu('plan:' + proposal.revision, [
      { label: '执行方案', run: () => api.agentExecutePlan({ id: this.taskId, revision: proposal.revision, credentials: this.credentials }) },
      { label: '修改方案…', hint: '说说要改哪里', run: () => this.askReply(this.task, '说说方案要改哪里，↵ 发送 · Esc 回到命令行') },
      { label: '先不做', run: () => this.close() },
    ], { escLabel: '先不做', onEsc: 2 });
  }

  // ask(): one question at a time; free-text questions use the reply prompt.
  questionFlow(request) {
    const key = 'question:' + request.id;
    if (this.done.has(key) || (this.menu?.key?.startsWith(key) && this.phase !== 'running') || this.input?.key?.startsWith(key)) return;
    const answers = [];
    const next = () => {
      const q = request.questions[answers.length];
      if (!q) {
        this.done.add(key);
        this.phase = 'running'; this.since = Date.now(); this.spin('思考中');
        return this.act(api.agentAnswer({ id: this.taskId, requestId: request.id, answers, credentials: this.credentials }));
      }
      this.commit(sgr('36', '? ') + sgr('1', q.question) + '\r\n');
      const typed = () => this.reply(`${key}:${q.id}:text`, '输入回答，↵ 发送 · Esc 回到命令行', text => { answers.push({ questionId: q.id, text }); this.clearLive(); this.write(hang(dim('  → ' + text), this.term.cols) + '\r\n'); next(); });
      if (!q.options.length) return typed();
      const options = q.options.map((o, i) => ({ label: o.label + (i === q.recommendedOption ? '（推荐）' : ''), hint: o.description, run: () => { answers.push({ questionId: q.id, optionIndex: i }); next(); } }));
      options.push({ label: '自己输入…', run: typed });
      this.menu = null;
      this.showMenu(`${key}:${q.id}`, options, { escLabel: '回到命令行' });
      // pick() would start the spinner between questions; options here continue the flow instead
      this.menu.flow = true;
      if (q.recommendedOption !== undefined) { this.menu.index = q.recommendedOption; this.redraw(); }
    };
    next();
  }

  askReply(task, hint) {
    const status = task?.status;
    const ended = status === 'completed' || status === 'failed';
    this.reply('reply:' + (task?.events.at(-1)?.id || ''), hint || (ended ? '↵ 接着问 · Esc 回到命令行' : '回复助手，↵ 发送 · Esc 回到命令行'), text => {
      this.clearLive();
      this.write(hang(sgr('36;1', '› ') + text, this.term.cols) + '\r\n\r\n');
      this.phase = 'running'; this.since = Date.now(); this.spin('思考中');
      this.act(api.agentResume({ id: this.taskId, message: text, credentials: this.credentials }));
    });
  }

  reply(key, hint, onSubmit) {
    if (this.input?.key === key && this.phase === 'input') return;
    this.stopSpin();
    this.input = { key, text: '', hint: '  ' + hint, onSubmit };
    this.menu = null;
    this.phase = 'input';
    this.redraw();
  }

  // ---- keys ----
  key(data) {
    if (this.phase === 'running' || this.phase === 'starting') {
      if ((data === '\x1b' || data === '\x03') && this.taskId && this.phase === 'running') {
        this.label = '正在中断';
        this.redraw();
        this.act(api.agentPause(this.taskId));
      }
      return;
    }
    if (this.phase === 'menu') {
      const menu = this.menu, count = menu.options.length;
      if (data === '\x1b[A' || data === '\x1bOA' || data === 'k') { menu.index = (menu.index + count - 1) % count; this.redraw(); }
      else if (data === '\x1b[B' || data === '\x1bOB' || data === 'j') { menu.index = (menu.index + 1) % count; this.redraw(); }
      else if (/^[1-9]$/.test(data) && Number(data) <= count) { menu.index = Number(data) - 1; this.choose(); }
      else if (data === '\r') this.choose();
      else if (data === '\x1b' || data === '\x03') {
        if (menu.onEsc !== undefined) { menu.index = menu.onEsc; this.choose(); } else this.close();
      }
      return;
    }
    if (this.phase === 'input') {
      const input = this.input;
      if (data === '\r') {
        const text = input.text.trim();
        if (!text) { if (input.key.startsWith('reply:')) this.close(); return; }
        this.input = null;
        input.onSubmit(text);
      } else if (data === '\x1b') this.close();
      else if (data === '\x03') { if (input.text) { input.text = ''; this.redraw(); } else this.close(); }
      else if (data === '\x7f' || data === '\b') { input.text = [...input.text].slice(0, -1).join(''); this.redraw(); }
      else if (data === '\x15') { input.text = ''; this.redraw(); }
      else if (!data.startsWith('\x1b')) {
        const text = data.replace(/\r\n?|\n/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
        if (text) { input.text = (input.text + text).slice(0, 4000); this.redraw(); }
      }
    }
  }

  choose() {
    const option = this.menu.options[this.menu.index];
    if (this.menu.flow) {
      this.clearLive();
      this.write(dim('  → ' + option.label.replace(/（推荐）$/, '')) + '\r\n');
      this.menu = null;
      option.run();
      return;
    }
    this.pick(option);
  }
}

// A light sweeping across the label: dim text, a bright band moving left to right.
function shimmer(label, frame) {
  const chars = [...label, '…'];
  const span = chars.length + 6;
  const center = (frame % span) - 3;
  return chars.map((ch, i) => [Math.abs(i - center) <= 1 ? '1' : '2', ch]);
}
