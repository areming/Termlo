#!/usr/bin/env node
// Termlo agent benchmark: runs real tasks with a real model against a real SSH host.
//
//   node scripts/bench.cjs [S1 S2 S3] [--label name]
//
// Config (never committed): ~/.config/termlo/bench.env
//   TERMLO_BENCH_BASE_URL, TERMLO_BENCH_API_KEY, TERMLO_BENCH_MODEL, TERMLO_BENCH_FALLBACK_MODEL,
//   TERMLO_BENCH_HOST, TERMLO_BENCH_USER, TERMLO_BENCH_PASSWORD
// The target host is modified (Docker containers, files under /srv/termlo-bench). Use a disposable machine.
// Success is judged by a checker command on the host, never by the model's own report.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('ssh2');
const { AgentService } = require('../src/agent/service.cjs');
const model = require('../src/agent/model.cjs');

const root = path.join(__dirname, '..');
const env = loadEnv(path.join(os.homedir(), '.config', 'termlo', 'bench.env'));
const HOST_ID = 'bench-vm';
const TASK_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_ROUNDS = 30;
const GUARD_PATTERNS = /结果未知的操作|写入前先用 read_file|主机不在本任务范围|不能使用这个工具|还没有成功的现场验证|逐项报告已确认方案|还有命令在运行/;

const SCENARIOS = {
  S1: {
    title: '只读巡检',
    prompt: '巡检这台服务器：系统版本、CPU/内存/磁盘使用、正在运行的 Docker 容器和监听端口，给出简短报告。只检查，不要做任何修改。',
    setup: 'docker ps -a --format "{{.Names}} {{.Status}}" | sort > /tmp/termlo-bench-s1-before',
    check: 'docker ps -a --format "{{.Names}} {{.Status}}" | sort | diff -q /tmp/termlo-bench-s1-before - >/dev/null && echo BENCH_PASS',
    cleanup: 'rm -f /tmp/termlo-bench-s1-before',
  },
  S2: {
    title: '用 Docker 部署 nginx 站点',
    prompt: '用 Docker 在这台服务器上部署一个 nginx 站点：容器名 termlo-bench-web，监听宿主机 18080 端口，首页内容为 "Termlo bench OK"。服务器不能访问外网，请使用本机已有的 nginx 镜像。部署后验证。',
    setup: 'docker rm -f termlo-bench-web >/dev/null 2>&1; rm -rf /srv/termlo-bench; true',
    check: 'curl -s --max-time 5 http://127.0.0.1:18080/ | grep -q "Termlo bench OK" && docker inspect -f "{{.State.Running}}" termlo-bench-web | grep -q true && echo BENCH_PASS',
    cleanup: 'docker rm -f termlo-bench-web >/dev/null 2>&1; rm -rf /srv/termlo-bench; true',
  },
  S3: {
    title: '修复配置损坏的 nginx 容器',
    prompt: '服务器上的 nginx 容器 termlo-bench-broken 本应在宿主机 18081 端口提供网站，但现在无法访问。请排查并修复，保留原有网站内容。',
    setup: [
      'docker rm -f termlo-bench-broken >/dev/null 2>&1; rm -rf /srv/termlo-bench/s3; mkdir -p /srv/termlo-bench/s3/html',
      'echo "Termlo repaired" > /srv/termlo-bench/s3/html/index.html',
      'printf "server {\\n  listen 80\\n  location / { root /usr/share/nginx/html; }\\n}\\n" > /srv/termlo-bench/s3/default.conf',
      'docker run -d --name termlo-bench-broken --restart unless-stopped -p 18081:80 -v /srv/termlo-bench/s3/default.conf:/etc/nginx/conf.d/default.conf:ro -v /srv/termlo-bench/s3/html:/usr/share/nginx/html:ro nginx:latest >/dev/null',
    ].join(' && '),
    check: 'curl -s --max-time 5 http://127.0.0.1:18081/ | grep -q "Termlo repaired" && echo BENCH_PASS',
    cleanup: 'docker rm -f termlo-bench-broken >/dev/null 2>&1; rm -rf /srv/termlo-bench; true',
  },
  // Plan mode end to end: a plan is proposed, approved as-is, then executed.
  S4: {
    title: '先规划再执行：修改应用配置',
    mode: 'plan',
    prompt: '把 /srv/termlo-bench/s4/app.env 里的 PORT 改成 9090，其他行保持不变。先给方案。',
    setup: 'rm -rf /srv/termlo-bench/s4 && mkdir -p /srv/termlo-bench/s4 && printf "NAME=demo\\nPORT=8080\\nDEBUG=false\\n" > /srv/termlo-bench/s4/app.env',
    check: 'grep -qx "PORT=9090" /srv/termlo-bench/s4/app.env && grep -qx "NAME=demo" /srv/termlo-bench/s4/app.env && grep -qx "DEBUG=false" /srv/termlo-bench/s4/app.env && echo BENCH_PASS',
    cleanup: 'rm -rf /srv/termlo-bench; true',
  },
  // Undo: the task is stopped right after its first file change, then the user undoes it.
  S5: {
    title: '中途停止后撤销文件改动',
    interrupt: 'undo',
    prompt: '用修改文件的方式，把 /srv/termlo-bench/s5/site.conf 里的 server_name 改成 new.example.com。',
    setup: 'rm -rf /tmp/term*-recovery-* /srv/termlo-bench/s5 && mkdir -p /srv/termlo-bench/s5 && printf "server {\\n  server_name old.example.com;\\n}\\n" > /srv/termlo-bench/s5/site.conf && sha256sum /srv/termlo-bench/s5/site.conf > /tmp/termlo-bench-s5.sha',
    check: 'sha256sum -c --quiet /tmp/termlo-bench-s5.sha && ! ls -d /tmp/term*-recovery-* >/dev/null 2>&1 && echo BENCH_PASS',
    cleanup: 'rm -rf /srv/termlo-bench /tmp/termlo-bench-s5.sha; true',
  },
  // Clean and delete: the change stays, the undo backup on the server is removed.
  S6: {
    title: '中途停止后清理并删除任务',
    interrupt: 'clean',
    prompt: '用修改文件的方式，把 /srv/termlo-bench/s6/site.conf 里的 server_name 改成 new.example.com。',
    setup: 'rm -rf /tmp/term*-recovery-* /srv/termlo-bench/s6 && mkdir -p /srv/termlo-bench/s6 && printf "server {\\n  server_name old.example.com;\\n}\\n" > /srv/termlo-bench/s6/site.conf',
    check: 'grep -q "server_name new.example.com;" /srv/termlo-bench/s6/site.conf && ! ls -d /tmp/term*-recovery-* >/dev/null 2>&1 && echo BENCH_PASS',
    cleanup: 'rm -rf /srv/termlo-bench; true',
  },
};

function loadEnv(file) {
  if (!fs.existsSync(file)) throw new Error(`缺少基准配置文件：${file}`);
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  for (const key of ['TERMLO_BENCH_BASE_URL', 'TERMLO_BENCH_API_KEY', 'TERMLO_BENCH_MODEL', 'TERMLO_BENCH_HOST', 'TERMLO_BENCH_USER', 'TERMLO_BENCH_PASSWORD']) {
    if (!values[key]) throw new Error(`基准配置缺少 ${key}`);
  }
  return values;
}

// Run a shell command on the target host outside the agent (setup / check / cleanup).
function hostExec(command) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let output = '';
    client.on('ready', () => client.exec(command, (error, stream) => {
      if (error) { client.end(); return reject(error); }
      stream.on('data', data => { output += data; }).stderr.on('data', data => { output += data; });
      stream.on('close', code => { client.end(); resolve({ code, output }); });
    }));
    client.on('error', reject);
    client.connect({ host: env.TERMLO_BENCH_HOST, username: env.TERMLO_BENCH_USER, password: env.TERMLO_BENCH_PASSWORD, readyTimeout: 15000, hostVerifier: () => true });
  });
}

// Model calls: primary (free) model first; after it is rate-limited, switch to the paid fallback for the rest of the run.
function createModel(calls) {
  let current = env.TERMLO_BENCH_MODEL;
  return async options => {
    for (;;) {
      const started = Date.now();
      let firstText = null;
      try {
        const result = await model.complete({ ...options, model: current, onText: text => { firstText ??= Date.now() - started; options.onText(text); } });
        calls.push({ model: current, ms: Date.now() - started, firstTextMs: firstText, tokens: result.tokens, ...result.usage });
        return result;
      } catch (error) {
        calls.push({ model: current, ms: Date.now() - started, tokens: 0, error: error.message });
        if (/HTTP 429/.test(error.message) && env.TERMLO_BENCH_FALLBACK_MODEL && current !== env.TERMLO_BENCH_FALLBACK_MODEL) {
          console.log(`  ↪ ${current} 受限，切换到 ${env.TERMLO_BENCH_FALLBACK_MODEL}`);
          current = env.TERMLO_BENCH_FALLBACK_MODEL;
          continue;
        }
        throw error;
      }
    }
  };
}

async function runScenario(id) {
  const scenario = SCENARIOS[id];
  const host = { id: HOST_ID, name: 'bench-vm', address: env.TERMLO_BENCH_HOST, port: 22, username: env.TERMLO_BENCH_USER, auth: 'password', group: 'bench', tags: '', color: 'mint', keyPath: '', jumpHostId: '' };
  const hosts = { get: () => host, list: () => [{ ...host, hasPassword: true }], route: () => [host], password: () => env.TERMLO_BENCH_PASSWORD };
  const vault = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termlo-bench-'));
  const calls = [];
  // Interrupt scenarios stop the run as soon as the first file change is on the server.
  let interrupted = false;
  const notify = event => {
    if (!scenario.interrupt || interrupted || event.type !== 'agent' || !agent.active) return;
    const current = agent.active.task;
    if (current.fileChanges?.some(r => r.state === 'applied' && r.recovery)) {
      interrupted = true;
      setImmediate(() => agent.pause(current.id));
    }
  };
  const agent = new AgentService({ directory, vault, hosts, verify: async () => true, complete: createModel(calls), notify });
  agent.configure({ baseUrl: env.TERMLO_BENCH_BASE_URL, model: env.TERMLO_BENCH_MODEL, apiKey: env.TERMLO_BENCH_API_KEY, maxRounds: MAX_ROUNDS });

  console.log(`\n▶ ${id} ${scenario.title}`);
  const setup = await hostExec(scenario.setup);
  if (setup.code !== 0) throw new Error(`${id} 准备失败：${setup.output}`);

  const started = Date.now();
  let task;
  let followUp = '';
  try {
    task = await agent.start({ prompt: scenario.prompt, hostIds: [HOST_ID], mode: scenario.mode || 'execute' });
    const timer = setTimeout(() => agent.active && agent.pause(agent.active.task.id), TASK_TIMEOUT_MS);
    await agent.active?.done;
    // Plan mode: answer questions like a user who accepts the suggestions, then approve the plan as proposed.
    for (let i = 0; scenario.mode === 'plan' && i < 4; i++) {
      task = agent.task(task.id);
      if (task.interaction?.status === 'pending') {
        agent.answer({ id: task.id, requestId: task.interaction.id, answers: task.interaction.questions.map(q => q.options.length
          ? { questionId: q.id, optionIndex: q.recommendedOption ?? 0 }
          : { questionId: q.id, text: '按你的建议处理。' }) });
      } else if (task.status === 'plan_ready' && task.proposal) {
        followUp = `方案 v${task.proposal.revision}：${task.proposal.steps.length} 步`;
        agent.executePlan({ id: task.id, revision: task.proposal.revision });
      } else break;
      await agent.active?.done;
    }
    clearTimeout(timer);
    task = agent.task(task.id);
    if (scenario.interrupt) {
      if (!interrupted) followUp = '没有改过文件就结束了，未能测试中断';
      else if (scenario.interrupt === 'undo') {
        const result = await agent.recover({ id: task.id, action: 'undo' });
        followUp = `撤销 ${result.restored} 项，失败 ${result.failed} 项`;
        task = agent.task(task.id);
      } else {
        const recoverable = agent.state().tasks.find(t => t.id === task.id)?.recoverable || 0;
        const result = await agent.remove(task.id, { clean: true });
        followUp = `待清理 ${recoverable} 项，已清理 ${result.cleaned} 项，任务${agent.store.tasks.some(t => t.id === task.id) ? '仍在' : '已删除'}`;
      }
    }
  } catch (error) {
    followUp = [followUp, '出错：' + error.message].filter(Boolean).join('；');
    task ||= { status: 'error', notice: error.message, events: [], rounds: 0, tokens: 0 };
  }
  const duration = Date.now() - started;
  const check = await hostExec(scenario.check);
  await hostExec(scenario.cleanup);
  agent.close();
  fs.rmSync(directory, { recursive: true, force: true });

  const tools = task.events.filter(event => event.type === 'tool');
  const result = {
    id,
    title: scenario.title,
    passed: check.output.includes('BENCH_PASS') && (!scenario.interrupt || interrupted),
    followUp,
    status: task.status,
    notice: task.notice || '',
    rounds: task.rounds,
    tokens: task.tokens,
    durationSec: Math.round(duration / 1000),
    firstResponseSec: calls[0] ? +(calls[0].ms / 1000).toFixed(1) : null,
    avgCallSec: calls.length ? +(calls.reduce((sum, call) => sum + call.ms, 0) / calls.length / 1000).toFixed(1) : null,
    toolCalls: tools.length,
    toolErrors: tools.filter(event => event.result?.error).length,
    guardBlocks: tools.filter(event => GUARD_PATTERNS.test(event.result?.error || '')).length,
    promptTokens: calls.reduce((sum, call) => sum + (call.prompt || 0), 0),
    cachedTokens: calls.reduce((sum, call) => sum + (call.cached || 0), 0),
    models: [...new Set(calls.map(call => call.model))],
    calls,
    // Compact execution trace for diagnosing failures (assistant text, tool calls and their outcomes).
    trace: task.events.filter(event => ['assistant', 'tool', 'notice', 'result', 'question'].includes(event.type)).map(event => ({
      type: event.type,
      name: event.name,
      args: event.args ? JSON.stringify(event.args).slice(0, 400) : undefined,
      status: event.status,
      error: event.result?.error,
      exitCode: event.result?.exitCode,
      output: event.result?.output ? String(event.result.output).slice(-300) : undefined,
      content: typeof event.content === 'string' ? event.content.slice(0, 400) : undefined,
      report: event.report ? { headline: event.report.headline, outcome: event.report.outcome, checks: event.report.checks?.map(c => ({ label: c.label, status: c.status, evidenceIds: c.evidenceIds?.length })) } : undefined,
    })),
  };
  console.log(`  ${result.passed ? '✅ 通过' : '❌ 未通过'} · 状态 ${result.status} · ${result.rounds} 轮 · ${result.tokens} tokens · ${result.durationSec}s${result.notice ? ' · ' + result.notice.slice(0, 120) : ''}${result.followUp ? '\n    ↳ ' + result.followUp : ''}`);
  return result;
}

function summarize(label, results) {
  const lines = [
    `# Termlo 基准 · ${label}`,
    '',
    `时间：${new Date().toISOString()} · 主模型：${env.TERMLO_BENCH_MODEL} · 备用：${env.TERMLO_BENCH_FALLBACK_MODEL || '无'}`,
    '',
    '| 场景 | 结果 | 状态 | 轮数 | tokens | 缓存命中 | 耗时 s | 首响 s | 平均每轮 s | 工具调用 | 工具出错 | 守卫拦截 | 模型 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.map(r => `| ${r.id} ${r.title} | ${r.passed ? '✅' : '❌'} | ${r.status} | ${r.rounds} | ${r.tokens} | ${r.promptTokens ? Math.round(r.cachedTokens / r.promptTokens * 100) + '%' : '-'} | ${r.durationSec} | ${r.firstResponseSec ?? '-'} | ${r.avgCallSec ?? '-'} | ${r.toolCalls} | ${r.toolErrors} | ${r.guardBlocks} | ${r.models.join(', ')} |`),
    '',
    `合计：通过 ${results.filter(r => r.passed).length}/${results.length} · ${results.reduce((s, r) => s + r.rounds, 0)} 轮 · ${results.reduce((s, r) => s + r.tokens, 0)} tokens · ${results.reduce((s, r) => s + r.durationSec, 0)} s`,
  ];
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const labelIndex = args.indexOf('--label');
  const label = labelIndex >= 0 ? args.splice(labelIndex, 2)[1] : 'run';
  const ids = args.length ? args : Object.keys(SCENARIOS);
  for (const id of ids) if (!SCENARIOS[id]) throw new Error(`未知场景 ${id}`);

  const results = [];
  for (const id of ids) results.push(await runScenario(id));

  const output = path.join(root, 'test-output', 'bench');
  fs.mkdirSync(output, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const summary = summarize(label, results);
  fs.writeFileSync(path.join(output, `${stamp}-${label}.json`), JSON.stringify({ label, model: env.TERMLO_BENCH_MODEL, fallback: env.TERMLO_BENCH_FALLBACK_MODEL, results }, null, 2));
  fs.writeFileSync(path.join(output, `${stamp}-${label}.md`), summary + '\n');
  console.log('\n' + summary);
}

main().catch(error => { console.error(error); process.exit(1); });
