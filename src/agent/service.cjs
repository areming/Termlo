// Termlo 2.0 agent kernel.
//
// Safety invariants (enforced here in code, never left to the model):
//   1. Only the hosts selected for the task can be reached (routes contain nothing else).
//   2. Plan mode has no tool that can change a server.
//   3. write_file needs a read of the same path in this run with a matching sha256.
//   4. A host with an operation of unknown outcome (timeout, interruption, crash, resumed task)
//      accepts no further change until a read-only observation (inspect / read_file) succeeds.
//   5. User input that arrives mid-run invalidates any in-flight model response; nothing it
//      planned is executed.
//   6. "completed" needs a successful on-server result after the last change.
//   7. Redaction applies to what leaves the trust boundary, never to what is executed.
const { randomUUID } = require('node:crypto');
const { TaskStore, now } = require('./store.cjs');
const { TOOLS, MUTATING, toolsFor, validate, define } = require('./tools.cjs');
const prompt = require('./prompt.cjs');
const model = require('./model.cjs');
const { createRedactor } = require('./redact.cjs');
const { AgentRemote, quote } = require('../agent-remote.cjs');
const { AgentConsole } = require('../agent-console.cjs');
const { AgentAttachments } = require('../agent-attachments.cjs');
const questions = require('../agent-questions.cjs');
const network = require('../agent-network.cjs');
const { identityKey } = require('../host-os.cjs');

const SYNC_WAIT_SECONDS = 60;
const OUTPUT_LIMIT = 8000;
const CONTEXT_HIGH = 140000;   // characters of history before trimming
const CONTEXT_LOW = 70000;     // characters kept after trimming
const MAX_EVENTS = 3000;
const RUNNING_STATES = new Set(['running']);

const INSPECT = {
  overview: "printf '=== SYSTEM ===\\n'; uname -srm; grep PRETTY_NAME /etc/os-release 2>/dev/null; uptime; printf '\\n=== RESOURCES ===\\n'; nproc 2>/dev/null; free -m 2>/dev/null; df -hP -x tmpfs -x devtmpfs -x overlay 2>/dev/null; printf '\\n=== NETWORK ===\\n'; ip -brief address 2>/dev/null; ss -lntup 2>/dev/null | head -40; printf '\\n=== SERVICES ===\\n'; systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | head -60; systemctl --failed --no-pager --no-legend 2>/dev/null",
  docker: "docker ps -a --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}' 2>&1 | head -80; printf '\\n=== IMAGES ===\\n'; docker images --format 'table {{.Repository}}:{{.Tag}}\\t{{.Size}}' 2>&1 | head -60",
  service: target => `systemctl status --no-pager --lines=0 -- ${quote(target)} 2>&1 | head -20; printf '\\n=== LOG ===\\n'; journalctl -u ${quote(target)} -n 60 --no-pager 2>&1 | tail -60`,
  process: target => `ps -eo pid,ppid,user,stat,etime,pcpu,pmem,args | grep -F -- ${quote(target)} | grep -v 'grep -F' | head -40`,
};

function clip(text, limit) {
  if (!text || text.length <= limit) return text || '';
  const head = Math.floor(limit * 0.25);
  return text.slice(0, head) + `\n…（省略 ${text.length - limit} 字符）…\n` + text.slice(-(limit - head));
}

class AgentService {
  constructor({ directory, vault, hosts, verify, notify = () => {}, complete = model.complete, remoteFactory = options => new AgentRemote(options), web = network, syncWaitSeconds = SYNC_WAIT_SECONDS }) {
    this.syncWaitSeconds = syncWaitSeconds;
    this.store = new TaskStore(directory, vault);
    this.attachments = new AgentAttachments(this.store);
    this.hosts = hosts;
    this.verify = verify;
    this.notify = notify;
    this.complete = complete;
    this.remoteFactory = remoteFactory;
    this.web = web;
    this.active = null;
    this.busy = false;
    this.sequence = 0;   // monotonic ordering for observations vs. changes (timestamps can tie)
    // A task that was running when the app stopped has operations of unknown outcome.
    for (const task of this.store.tasks) {
      if (task.status !== 'running') continue;
      this.markUnknown(task);
      task.status = 'paused';
      task.notice = '应用曾意外关闭。继续前会先核实服务器现场，未完成的操作不会自动重放。';
      this.store.save(task, true);
    }
  }

  // ---- public API -------------------------------------------------------------
  state() {
    return {
      settings: this.store.publicSettings(),
      activeId: this.active?.task.id || null,
      tasks: this.store.tasks.map(({ messages, events, terminals, operations, fileChanges, stagingChanges, ...summary }) => ({
        ...summary,
        recoverable: this.recoverable(summary.id).length,
      })),
    };
  }

  task(id) {
    const { messages, ...task } = this.store.get(id);
    return task;
  }

  configure(input) {
    if (this.active) throw new Error('请先暂停当前任务再更改模型');
    return this.store.configure(input);
  }

  async test() {
    const settings = this.store.settings;
    if (!settings.baseUrl || !settings.model) throw new Error('请先保存模型设置');
    const tool = define('connection_check', '测试工具调用', {});
    const result = await this.complete({
      baseUrl: settings.baseUrl, model: settings.model, apiKey: this.store.key(),
      messages: [{ role: 'user', content: 'Call connection_check once with no arguments.' }],
      tools: [tool], signal: AbortSignal.timeout(60000),
    });
    return { ok: true, toolCalling: !!result.message.tool_calls?.some(call => call.function.name === 'connection_check') };
  }

  start({ prompt: goal, hostIds = [], mode = 'execute', credentials = {}, attachmentIds = [] }) {
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 12000) throw new Error('请填写任务目标（最多 12000 字）');
    if (!['execute', 'plan'].includes(mode)) throw new Error('任务模式无效');
    if (!Array.isArray(hostIds) || hostIds.length > 20 || hostIds.some(id => typeof id !== 'string')) throw new Error('最多选择 20 台主机');
    this.ensureIdle();
    for (const id of hostIds) this.hosts.get(id);
    this.attachments.validate(attachmentIds);
    const task = this.store.create({ prompt: goal.trim(), hostIds: [...new Set(hostIds)], mode });
    const attachments = this.attachments.bind(attachmentIds, task);
    this.event(task, 'user', task.prompt, { attachments });
    this.launch(task, credentials);
    return task;
  }

  followup({ id, message }) {
    const run = this.active;
    if (run?.task.id !== id || run.task.status !== 'running') throw new Error('任务没有在运行，请用"继续"发送');
    if (typeof message !== 'string' || !message.trim() || message.length > 12000) throw new Error('补充内容应为 1–12000 字');
    const task = run.task;
    if (task.followups.filter(f => f.status === 'queued').length >= 20) throw new Error('待处理的补充过多，请稍候');
    const entry = { id: randomUUID(), content: run.redact.text(message.trim()), status: 'queued', at: now() };
    task.followups.push(entry);
    task.inputRevision = (task.inputRevision || 0) + 1;
    this.event(task, 'user', entry.content, { followupId: entry.id });
    return { id: entry.id };
  }

  resume({ id, message = '', credentials = {}, attachmentIds = [], hostIds, answer }) {
    this.ensureIdle();
    const task = this.store.get(id);
    if (typeof message !== 'string' || message.length > 12000) throw new Error('补充内容过长');
    const pending = task.interaction?.status === 'pending' ? task.interaction : null;
    let text = message.trim();
    if (answer) {
      if (!pending || answer.requestId !== pending.id) throw new Error('问题已变化，请刷新后回答');
      const answers = questions.normalizeAnswers(pending, answer.answers);
      pending.status = 'answered';
      pending.answers = answers;
      text = '用户回答：\n' + answers.map(a => `${a.question}\n→ ${[a.choice, a.text].filter(Boolean).join('；')}`).join('\n');
      this.event(task, 'answer', text, { requestId: pending.id, answers });
    } else {
      if (pending) { pending.status = 'answered'; pending.answers = [{ text }]; }
      if (!text) text = '继续完成原目标。';
    }
    if (hostIds !== undefined) {
      if (task.mode !== 'plan') throw new Error('只能在规划阶段调整主机');
      if (!Array.isArray(hostIds) || hostIds.length > 20) throw new Error('最多选择 20 台主机');
      for (const hostId of hostIds) this.hosts.get(hostId);
      task.hostIds = [...new Set(hostIds)];
    }
    this.attachments.validate(attachmentIds, task);
    const attachments = this.attachments.bind(attachmentIds, task);
    if (task.mode === 'plan') task.proposal = null;
    task.recovery = null;
    task.messages.push({ role: 'user', content: text });
    if (!answer) this.event(task, 'user', text, { attachments });
    this.launch(task, credentials);
    return task;
  }

  answer({ id, requestId, answers, credentials = {} }) {
    return this.resume({ id, credentials, answer: { requestId, answers } });
  }

  executePlan({ id, revision, credentials = {} }) {
    this.ensureIdle();
    const task = this.store.get(id);
    const proposal = task.proposal;
    if (task.mode !== 'plan' || task.status !== 'plan_ready' || !proposal || proposal.revision !== revision) throw new Error('方案已变化，请查看最新方案');
    if (proposal.questions.length) throw new Error('方案还有待明确的问题');
    task.approvedPlan = structuredClone(proposal);
    task.mode = 'execute';
    task.interaction = null;
    task.messages.push({ role: 'user', content: `用户确认执行方案 v${revision}：${JSON.stringify({ title: proposal.title, steps: proposal.steps, checks: proposal.checks })}。按方案执行，并核实环境是否有变化。` });
    this.event(task, 'approval', `开始执行方案 v${revision}`, { revision });
    this.launch(task, credentials);
    return task;
  }

  async pause(id) {
    const run = this.active;
    if (run?.task.id !== id) return this.store.get(id);
    run.controller.abort();
    await run.done;
    return run.task;
  }

  remove(id) {
    if (this.active?.task.id === id) throw new Error('请先暂停任务');
    this.attachments.removeTask(id);
    this.store.remove(id);
  }

  close() {
    this.active?.controller.abort();
    this.active?.remote.close();
    this.store.flush();
  }

  // Undo file writes and clean attachment staging of a stopped task.
  async recover({ id, action, credentials = {} }) {
    this.ensureIdle();
    const task = this.store.get(id);
    const records = this.recoverable(id);
    if (action === 'keep') {
      task.recovery = null;
      task.notice = '已保留当前服务器状态。再次操作前会先核实现场。';
      this.event(task, 'notice', task.notice);
      return { kept: true };
    }
    if (action !== 'undo') throw new Error('未知的恢复操作');
    if (!records.length) throw new Error('没有可撤销的改动');
    const routes = new Map();
    const auth = {};
    for (const record of records) {
      if (!task.hostIds.includes(record.hostId) || identityKey(this.hosts.get(record.hostId)) !== record.identity) throw new Error('主机连接信息已变化，不能使用旧的撤销记录');
      this.addRoute(record.hostId, routes, auth, credentials);
    }
    const remote = this.remoteFactory({ routes, credentials: auth, verify: this.verify, signal: new AbortController().signal, recoveryId: task.id });
    this.busy = true;
    let restored = 0;
    const failures = [];
    try {
      for (const record of [...records].reverse()) {
        try {
          if (record.kind === 'staging') { await remote.cleanStaging(record); record.state = 'cleaned'; }
          else { await remote.undoWrite(record); record.state = 'restored'; }
          restored++;
        } catch (error) {
          failures.push(`${record.path}：${error.message}`);
        }
        this.store.save(task, true);
      }
    } finally {
      remote.close();
      this.busy = false;
    }
    task.recovery = null;
    task.notice = failures.length
      ? `已撤销 ${restored} 项，${failures.length} 项未能撤销：${failures.join('；')}`
      : `已撤销 ${restored} 项文件改动和暂存文件。通过命令做的其他改动（安装软件、启动服务等）需要另行检查。`;
    this.event(task, 'notice', task.notice);
    return { restored, failed: failures.length };
  }

  // ---- run lifecycle ----------------------------------------------------------
  ensureIdle() {
    if (this.active) throw new Error('已有任务在运行，请先暂停或等待完成');
    if (this.busy) throw new Error('正在撤销改动，请稍候');
    if (!this.store.settings.baseUrl || !this.store.settings.model) throw new Error('请先配置模型');
  }

  addRoute(hostId, routes, auth, credentials) {
    const route = structuredClone(this.hosts.route(hostId));
    routes.set(hostId, route);
    for (const host of route) {
      const supplied = credentials[host.id] || {};
      auth[host.id] = host.auth === 'key'
        ? { passphrase: String(supplied.passphrase || '') }
        : { password: String(supplied.password ?? this.hosts.password(host.id) ?? '') };
    }
  }

  launch(task, credentials) {
    const settings = { ...this.store.settings };
    const key = this.store.key();
    const routes = new Map();
    const auth = {};
    for (const hostId of task.hostIds) this.addRoute(hostId, routes, auth, credentials);
    const secrets = [key, ...Object.values(auth).flatMap(item => Object.values(item))];
    const redact = createRedactor(secrets);
    const controller = new AbortController();
    const resources = this.hosts.list().filter(h => task.hostIds.includes(h.id)).map(h => ({
      id: h.id, name: h.name, address: h.address, os: h.operatingSystem?.name || '',
    }));

    // Anything still marked in flight from a previous run has an unknown outcome now.
    this.markUnknown(task);
    // Earlier unknown operations are covered by mustObserve; their sequence numbers belong to another run.
    for (const op of task.operations) if (op.state === 'unknown') op.unknownSeq = 0;
    const changedBefore = new Set(task.operations.map(op => op.hostId));

    const run = {
      task, settings, key, redact, controller, resources,
      rounds: 0,
      jobs: new Map(),          // alias -> job id
      aliases: new Map(),       // job id -> alias
      observed: new Map(),      // hostId -> sequence of last successful read-only observation
      mustObserve: changedBefore,
      reads: new Map(),         // hostId\0path -> sha256 read in this run
      lastMutationAt: 0,
      lastSuccessAt: 0,
      failure: { signature: '', count: 0 },
    };
    run.console = new AgentConsole({ task, resources, redact: redact.text, notify: this.notify, save: () => this.store.save(task) });
    run.remote = this.remoteFactory({
      recoveryId: task.id, routes, credentials: auth, verify: this.verify, signal: controller.signal,
      onOutput: event => {
        run.console.handle(event);
        if (event.type === 'end') this.settleJob(task, event.job);
      },
      onFileChange: record => this.recordChange(task, { ...record, kind: 'file' }),
      onStagingChange: record => this.recordChange(task, { ...record, kind: 'staging' }),
    });

    if (redact.weak && !task.weakSecretNoticed) {
      task.weakSecretNoticed = true;
      this.event(task, 'notice', '有主机密码少于 8 个字符，服务器输出中出现的该密码无法可靠隐藏。建议改用更长的密码或密钥登录。');
    }

    this.active = run;
    task.status = 'running';
    task.notice = '';
    task.model = settings.model;
    task.recovery = null;
    this.store.save(task, true);
    this.notify({ type: 'agent', taskId: task.id });

    run.done = this.loop(run)
      .catch(error => {
        if (task.status !== 'running') return;
        if (controller.signal.aborted) {
          task.status = 'paused';
          task.notice = '任务已暂停。继续时会先核实服务器现场。';
        } else {
          task.status = 'failed';
          task.notice = redact.text(error.message);
        }
        this.event(task, 'notice', task.notice);
      })
      .finally(() => {
        run.remote.close();
        run.console.close();
        this.markUnknown(task);
        if (['failed', 'paused'].includes(task.status) && this.recoverable(task.id).length) {
          task.recovery = { count: this.recoverable(task.id).length, at: now() };
          this.event(task, 'recovery', '可以撤销本任务的文件改动', { count: task.recovery.count });
        }
        if (this.active === run) this.active = null;
        this.store.save(task, true);
        this.notify({ type: 'agent', taskId: task.id });
      });
  }

  async loop(run) {
    const { task, controller } = run;
    const tools = toolsFor(task.mode);
    let nudges = 0;
    while (task.status === 'running') {
      controller.signal.throwIfAborted();
      this.deliverFollowups(task);
      const revision = task.inputRevision || 0;
      if (run.rounds >= run.settings.maxRounds) {
        task.status = 'paused';
        task.notice = `已用完本次的 ${run.settings.maxRounds} 次模型调用。进度已保存，可以继续。`;
        this.event(task, 'notice', task.notice);
        break;
      }
      run.rounds++;
      task.rounds++;

      const response = await this.callModel(run, tools);
      task.tokens += response.tokens;
      run.usage = response.usage;
      if (revision !== (task.inputRevision || 0)) {   // invariant 5: planned before the user's latest input
        if (response.event) response.event.superseded = true;
        continue;
      }

      const message = run.redact.deep(response.message);
      task.messages.push(message);
      const calls = response.message.tool_calls || [];
      if (!calls.length) {
        if (task.mode === 'plan') { task.status = 'awaiting_reply'; break; }
        if (++nudges > 2) {
          task.status = 'needs_input';
          task.notice = '模型多次没有调用工具，任务未完成。请补充说明后继续，或换用支持工具调用的模型。';
          this.event(task, 'notice', task.notice);
          break;
        }
        task.messages.push({ role: 'user', content: '继续完成任务。已经完成或确实无法继续时，调用 finish。' });
        continue;
      }
      nudges = 0;

      for (const call of calls) {
        if (task.status !== 'running') {
          task.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ notExecuted: true, error: '任务已暂停等待用户，本工具未执行' }) });
          continue;
        }
        if (revision !== (task.inputRevision || 0)) {
          task.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ notExecuted: true, error: '用户刚补充了要求，本工具未执行；请按新要求重新决定' }) });
          continue;
        }
        controller.signal.throwIfAborted();
        await this.runTool(run, call, tools);
      }

      this.trimContext(task);
      if (task.events.length > MAX_EVENTS) {
        task.status = 'paused';
        task.notice = '任务记录过长，请新建任务继续。';
        this.event(task, 'notice', task.notice);
      }
    }
  }

  async callModel(run, tools) {
    const { task, settings, controller } = run;
    const messages = this.context(run);
    for (let attempt = 1; ; attempt++) {
      let event = null;
      try {
        const result = await this.complete({
          baseUrl: settings.baseUrl, model: settings.model, apiKey: run.key, messages, tools,
          signal: controller.signal,
          onText: text => {
            if (!event) event = this.event(task, 'assistant', '', { streaming: true });
            const safe = run.redact.text(text);
            event.content += safe;
            this.notify({ type: 'agent-delta', taskId: task.id, eventId: event.id, text: safe });
          },
        });
        const content = result.message.content;
        if (content) {
          event ||= this.event(task, 'assistant', '');
          event.content = run.redact.text(content);
        }
        if (event) { event.streaming = false; this.store.save(task); }
        return { ...result, event };
      } catch (error) {
        if (event) task.events = task.events.filter(e => e !== event);
        if (controller.signal.aborted || attempt >= 3 || !error.retryable) throw error;
        this.event(task, 'notice', `模型连接异常，正在重试（${attempt}/2）…`);
        await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
      }
    }
  }

  context(run) {
    const { task } = run;
    const start = task.contextStart || 1;
    const history = task.messages.slice(start);
    const unverified = this.unverified(run);
    let tail = prompt.tail({
      task, hosts: run.resources, roundsLeft: run.settings.maxRounds - run.rounds,
      unverified: unverified.map(id => run.resources.find(h => h.id === id)?.name || id),
      approvedPlan: task.approvedPlan,
    });
    if (start > 1) tail += '\n较早的对话已省略；需要的事实请重新检查服务器。';
    return [
      { role: 'system', content: prompt.system(task.mode) },
      task.messages[0],
      ...history,
      { role: 'user', content: tail },
    ];
  }

  // Trim in large steps so the cached prefix stays stable between trims.
  trimContext(task) {
    const start = task.contextStart || 1;
    const sizes = task.messages.map(m => JSON.stringify(m).length);
    let total = sizes.slice(start).reduce((sum, size) => sum + size, 0);
    if (total <= CONTEXT_HIGH) return;
    let cut = start;
    while (cut < task.messages.length - 1 && (total > CONTEXT_LOW || task.messages[cut].role === 'tool')) {
      total -= sizes[cut];
      cut++;
    }
    task.contextStart = cut;
  }

  deliverFollowups(task) {
    const queued = task.followups.filter(f => f.status === 'queued');
    if (!queued.length) return;
    task.messages.push({ role: 'user', content: '用户补充要求（立即生效，后续操作要遵守）：\n' + queued.map(f => '- ' + f.content).join('\n') });
    for (const entry of queued) { entry.status = 'delivered'; entry.deliveredAt = now(); }
  }

  // ---- tools ------------------------------------------------------------------
  async runTool(run, call, tools) {
    const { task, redact, controller } = run;
    const name = call.function.name;
    const event = this.event(task, 'tool', '', { name, args: {}, status: 'running' });
    let result;
    try {
      if (!tools.some(tool => tool.function.name === name)) throw new Error(task.mode === 'plan' ? '规划阶段不能使用这个工具' : `没有名为 ${name} 的工具`);
      let args;
      try { args = JSON.parse(call.function.arguments); } catch { throw new Error('工具参数不是有效的 JSON'); }
      validate(TOOLS[name].function.parameters, args);
      event.args = redact.deep(args);   // for display; the raw args are what runs (invariant 7)
      if ('hostId' in args && !task.hostIds.includes(args.hostId)) throw new Error('主机不在本任务范围内');   // invariant 1
      this.guard(run, name, args);
      result = await this.dispatch(run, name, args);
      event.status = result.status === 'running' ? 'running'
        : result.status && result.status !== 'completed' ? result.status
        : result.error ? 'failed' : 'completed';
    } catch (error) {
      result = { error: controller.signal.aborted ? '已中断，远端结果未知' : error.message };
      event.status = controller.signal.aborted ? 'interrupted' : 'failed';
    }
    result = redact.deep(result);
    event.result = result;
    event.finishedAt = now();
    task.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    this.countFailure(run, name, event.args, result);
    this.store.save(task);
    this.notify({ type: 'agent', taskId: task.id });
  }

  guard(run, name, args) {
    const { task } = run;
    if (MUTATING.has(name) && this.unverified(run).includes(args.hostId)) {
      throw new Error('这台主机有结果未知的操作（或任务刚恢复），先用 inspect 或 read_file 核实现场，再做变更');   // invariant 4
    }
    if (name === 'write_file' && args.sha256 !== 'missing' && run.reads.get(args.hostId + '\0' + args.path) !== args.sha256) {
      throw new Error('写入前先用 read_file 读取这个文件，并传入它返回的 sha256');   // invariant 3
    }
    if (name === 'finish' || name === 'ask' || name === 'plan') {
      if ([...run.remote.jobs.values()].some(job => RUNNING_STATES.has(job.status))) throw new Error('还有命令在运行，先 wait 等它结束或 cancel');
    }
    if (name === 'finish' && args.outcome === 'completed' && task.hostIds.length) {
      if (this.unverified(run).length) throw new Error('有结果未知的操作还没核实，不能标记完成');
      if (!run.lastSuccessAt || run.lastSuccessAt < run.lastMutationAt) throw new Error('最后一次变更之后还没有成功的现场验证（例如 curl、服务状态），不能标记完成');   // invariant 6
      const reported = new Set(args.checks.map(c => c.label));
      const missing = (task.approvedPlan?.checks || []).filter(label => !reported.has(label));
      if (missing.length) throw new Error('请逐项报告已确认方案的验收标准（label 用原文）：' + missing.join('；'));
    }
  }

  async dispatch(run, name, args) {
    const { task, remote, controller } = run;
    switch (name) {
      case 'run': {
        const op = this.beginOperation(run, 'run', args.hostId);
        let started;
        try {
          started = await remote.start(args.hostId, args.command, args.timeoutSeconds ?? 600);
        } catch (error) {
          // Connection or validation failure: the command never reached the server.
          this.settleOperation(task, op, controller.signal.aborted ? 'unknown' : 'done');
          throw error;
        }
        op.jobId = started.id;
        op.state = 'running';
        const job = await this.waitJob(run, started.id, this.syncWaitSeconds);
        if (job.status !== 'running') this.settleJob(task, job);   // the end event may have fired before jobId was set
        return this.jobResult(run, job);
      }
      case 'wait': {
        const jobId = run.jobs.get(args.id);
        if (!jobId) throw new Error('没有这个 id；id 只在本次运行内有效');
        const job = await this.waitJob(run, jobId, args.seconds ?? 30);
        if (job.status !== 'running') this.settleJob(task, job);
        return this.jobResult(run, job);
      }
      case 'cancel': {
        const jobId = run.jobs.get(args.id);
        if (!jobId) throw new Error('没有这个 id');
        return this.jobResult(run, remote.cancelJob(jobId));
      }
      case 'inspect': {
        let command = INSPECT[args.topic];
        if (typeof command === 'function') {
          if (!args.target) throw new Error('这个检查需要 target');
          if (args.topic === 'service' && !/^[a-zA-Z0-9_.@-]+$/.test(args.target)) throw new Error('服务名无效');
          command = command(args.target);
        }
        const job = await this.waitJob(run, (await remote.start(args.hostId, command, 90)).id, 90);
        if (job.status === 'completed') this.observe(run, args.hostId);
        return this.jobResult(run, job);
      }
      case 'read_file': {
        const file = await remote.readFile(args.hostId, args.path);
        run.reads.set(args.hostId + '\0' + args.path, file.sha256);
        this.observe(run, args.hostId);
        return { path: file.path, size: file.size, modifiedAt: file.modifiedAt, sha256: file.sha256, truncated: file.truncated, content: file.content };
      }
      case 'write_file': {
        if (task.fileChanges.filter(r => r.state === 'applied').length >= 128) throw new Error('本任务的可撤销文件改动已达 128 项');
        const op = this.beginOperation(run, 'write_file', args.hostId);
        try {
          const record = await remote.writeFile(args.hostId, args.path, args.content, args.sha256);
          this.settleOperation(task, op, 'done');
          run.reads.set(args.hostId + '\0' + args.path, record.sha256);
          return { path: args.path, sha256: record.sha256, bytes: record.bytes, backedUp: !!record.backup };
        } catch (error) {
          this.settleOperation(task, op, /超时|中断|abort/i.test(error.message) || controller.signal.aborted ? 'unknown' : 'done');
          throw error;
        }
      }
      case 'upload': {
        const item = task.attachments.find(a => a.id === args.attachmentId);
        if (!item) throw new Error('附件不属于本任务');
        const op = this.beginOperation(run, 'upload', args.hostId);
        const data = this.attachments.read(args.attachmentId, task);
        try {
          const result = await remote.uploadAttachment(args.hostId, args.directory, item, data);
          this.settleOperation(task, op, 'done');
          return { path: result.path, directory: result.stagingDirectory, bytes: result.bytes, sha256: result.sha256, verified: result.verified };
        } catch (error) {
          this.settleOperation(task, op, controller.signal.aborted ? 'unknown' : 'done');
          throw error;
        } finally {
          data.fill(0);
        }
      }
      case 'web': {
        if (!!args.query === !!args.url) throw new Error('query 和 url 二选一');
        return args.query ? this.web.searchWeb(args.query, controller.signal) : this.web.fetchPage(args.url, controller.signal, args.offset);
      }
      case 'ask': {
        const request = questions.createRequest(args.questions);
        task.interaction = request;
        task.status = 'awaiting_input';
        this.event(task, 'question', '需要你确认', { request: structuredClone(request) });
        return { waitingForUser: true };
      }
      case 'plan': {
        if (!args.steps.length) throw new Error('方案至少要有一个步骤');
        task.planRevision = (task.planRevision || 0) + 1;
        task.proposal = { ...args, revision: task.planRevision, hostIds: [...task.hostIds], at: now() };
        task.status = 'plan_ready';
        this.event(task, 'proposal', args.summary, { proposal: structuredClone(task.proposal) });
        if (args.questions.length) {
          task.interaction = questions.createRequest(args.questions.map((question, i) => ({ header: `待明确 ${i + 1}`, question, options: [] })));
          this.event(task, 'question', '完善方案', { request: structuredClone(task.interaction) });
        }
        return { revision: task.planRevision, waitingForUser: true };
      }
      case 'finish':
        return this.finish(run, args);
      default:
        throw new Error('未知工具');
    }
  }

  async finish(run, args) {
    const { task, remote } = run;
    const checks = args.checks.map(c => ({ label: c.label, status: c.status, ...(c.hostId ? { hostId: c.hostId } : {}) }));
    const outcome = args.outcome === 'completed' && checks.some(c => c.status !== 'passed') ? 'needs_input' : args.outcome;
    if (outcome === 'completed') {
      // The task succeeded: undo material is no longer needed on the server.
      const files = task.fileChanges.filter(r => r.state === 'applied' && r.recovery);
      try { if (files.length) { await remote.cleanRecovery(files); for (const r of files) r.state = 'cleaned'; } }
      catch { this.event(task, 'notice', '任务已完成，但服务器上的备份文件没有全部清理。'); }
      for (const record of task.stagingChanges.filter(r => r.state === 'applied')) {
        try { await remote.cleanStaging(record); record.state = 'cleaned'; }
        catch { this.event(task, 'notice', `附件暂存目录 ${record.folder} 没有清理成功，请手动检查。`); }
      }
    }
    const artifacts = (args.artifacts || []).filter(a => !a.hostId || task.hostIds.includes(a.hostId));
    task.report = {
      outcome,
      headline: outcome !== args.outcome ? `有验收项未通过：${args.headline}`.slice(0, 160) : args.headline,
      summary: args.summary, checks, artifacts, at: now(),
    };
    task.status = outcome;
    task.notice = outcome === 'needs_input' ? task.report.headline : '';
    this.event(task, 'result', args.summary, { report: structuredClone(task.report) });
    return { outcome };
  }

  // ---- bookkeeping (done by the program, not the model) ----------------------
  tick() {
    return ++this.sequence;
  }

  alias(run, jobId) {
    if (!run.aliases.has(jobId)) {
      const alias = 'j' + (run.aliases.size + 1);
      run.aliases.set(jobId, alias);
      run.jobs.set(alias, jobId);
    }
    return run.aliases.get(jobId);
  }

  async waitJob(run, jobId, seconds) {
    const deadline = Date.now() + seconds * 1000;
    let job = await run.remote.wait(jobId, 0);
    while (job.status === 'running' && Date.now() < deadline) {
      job = await run.remote.wait(jobId, Math.min(20, Math.ceil((deadline - Date.now()) / 1000)));
    }
    if (job.status === 'completed') run.lastSuccessAt = this.tick();
    return job;
  }

  jobResult(run, job) {
    const result = { hostId: job.hostId, status: job.status };
    if (job.status === 'running') result.id = this.alias(run, job.id);
    if (job.exitCode !== null && job.exitCode !== undefined) result.exitCode = job.exitCode;
    const stdout = job.stdout || '';
    const stderr = job.stderr || '';
    result.output = clip(stdout, stderr ? OUTPUT_LIMIT * 0.7 : OUTPUT_LIMIT) + (stderr ? '\n[stderr]\n' + clip(stderr, OUTPUT_LIMIT * 0.3) : '');
    if (job.truncated) result.note = '输出很长，只保留了最后部分';
    if (job.error) result.error = job.error;
    if (job.status === 'running') result.hint = `仍在运行，用 wait 并传入 id "${result.id}"`;
    if (['timeout', 'interrupted'].includes(job.status)) result.warning = '结果未知。继续变更前先用 inspect 或 read_file 核实现场';
    return result;
  }

  beginOperation(run, tool, hostId) {
    const op = { id: randomUUID(), tool, hostId, state: 'dispatched', at: now() };
    run.task.operations.push(op);
    run.lastMutationAt = this.tick();
    this.store.save(run.task, true);   // must be on disk before the command leaves
    return op;
  }

  settleOperation(task, op, state) {
    if (!op || op.state === state) return;
    op.state = state;
    if (state === 'unknown') op.unknownSeq = this.tick();
    this.store.save(task);
  }

  settleJob(task, job) {
    const op = task.operations.find(o => o.jobId === job.id);
    if (!op) return;
    this.settleOperation(task, op, ['completed', 'failed'].includes(job.status) && job.exitCode !== null ? 'done' : 'unknown');
  }

  markUnknown(task) {
    for (const op of task.operations || []) {
      if (op.state === 'dispatched' || op.state === 'running') { op.state = 'unknown'; op.unknownSeq = this.tick(); }
    }
  }

  observe(run, hostId) {
    run.observed.set(hostId, this.tick());
    run.mustObserve.delete(hostId);
    run.lastSuccessAt = this.tick();
  }

  unverified(run) {
    const hosts = new Set(run.mustObserve);
    for (const op of run.task.operations) {
      if (op.state === 'unknown' && (op.unknownSeq || 0) > (run.observed.get(op.hostId) || 0)) hosts.add(op.hostId);
    }
    return [...hosts];
  }

  recordChange(task, record) {
    const list = record.kind === 'staging' ? task.stagingChanges : task.fileChanges;
    const entry = { ...record, identity: identityKey(this.hosts.get(record.hostId)), at: now() };
    const index = list.findIndex(r => r.id === record.id);
    if (index < 0) list.push(entry); else list[index] = { ...list[index], ...entry };
    this.store.save(task, true);
  }

  recoverable(id) {
    const task = this.store.get(id);
    return [
      ...(task.fileChanges || []).filter(r => r.state === 'applied' && r.recovery),
      ...(task.stagingChanges || []).filter(r => r.state === 'applied'),
    ];
  }

  countFailure(run, name, args, result) {
    if (!MUTATING.has(name)) return;
    if (!result.error && !(result.exitCode > 0)) { run.failure = { signature: '', count: 0 }; return; }
    const signature = JSON.stringify([name, args, result.error || result.exitCode]);
    run.failure = signature === run.failure.signature ? { signature, count: run.failure.count + 1 } : { signature, count: 1 };
    if (run.failure.count >= 3) {
      run.task.status = 'paused';
      run.task.notice = '同一个操作连续失败 3 次，已停止重复执行。请检查后继续。';
      this.event(run.task, 'notice', run.task.notice);
    }
  }

  event(task, type, content, extra = {}) {
    const event = { id: randomUUID(), type, content, at: now(), ...extra };
    task.events.push(event);
    this.store.save(task);
    this.notify({ type: 'agent', taskId: task.id });
    return event;
  }
}

module.exports = { AgentService };
