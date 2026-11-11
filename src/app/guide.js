// Getting started and 使用说明.
// - First run (no hosts): the hosts page is a welcome with three steps.
// - Hosts added but steps left: a slim "上手 n/3" strip on the hosts page until all three are done
//   or the user closes it. Each step ticks itself off from real state, nothing to click through.
// - 使用说明: one dialog, opened from the top bar, Settings → 关于 or the search box.
import { api, html, raw, ico, dialog } from './ui.js';

const LOCAL_MODEL = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//i;

// Facts the steps depend on that are not in the shared store: read when the hosts page shows.
export async function guideFacts() {
  try {
    const { settings, tasks } = await api.agentState();
    return {
      model: !!settings.model && (settings.hasKey || LOCAL_MODEL.test(settings.baseUrl || '')),
      askedInTerminal: tasks.some(t => t.origin === 'terminal'),
    };
  } catch { return { model: false, askedInTerminal: false }; }
}

export function guideSteps({ hosts, preferences }, facts) {
  return [
    { id: 'host', icon: 'host', done: hosts.length > 0, title: '添加服务器', text: '密码、私钥、跳板机都行，也可以从 ~/.ssh/config 导入' },
    { id: 'model', icon: 'assistant', done: !!facts?.model, title: '连接模型', text: '助手用它思考；任何兼容 OpenAI 的接口都可以，本机 Ollama 也行' },
    { id: 'ask', icon: 'terminal', done: !!(facts?.askedInTerminal || preferences.askedInTerminal), title: '在终端里问一句', text: raw('命令行输入 <code># 这台机器为什么这么慢</code> 回车，助手就在终端里查看、回答') },
  ];
}

function stepAction(step, hosts) {
  if (step.id === 'host') return html`<div class="btn-group"><button class="btn btn-primary" type="button" data-action="add">${ico('plus', 'sm')}添加主机</button><button class="btn" type="button" data-action="import" title="从 ~/.ssh/config 导入">导入</button></div>`;
  if (step.id === 'model') return html`<button class="btn" type="button" data-guide="model">设置模型</button>`;
  return hosts.length ? html`<button class="btn" type="button" data-guide="terminal">打开终端</button>` : '';
}

const mark = (step, i) => html`<span class="guide-mark" data-done="${step.done}" aria-hidden="true">${step.done ? ico('check', 'sm') : i + 1}</span>`;

// The empty hosts page.
export function welcome(steps, hosts) {
  return html`
    <div class="page">
      <div class="welcome">
        <img class="welcome-logo" src="./termlo.svg" alt="" width="64" height="64">
        <h2 class="welcome-title">欢迎使用 Termlo</h2>
        <p class="welcome-text">SSH 终端、文件，加一个守规矩的服务器助手</p>
        <ol class="guide-steps card">
          ${steps.map((step, i) => html`
            <li class="guide-step" data-done="${step.done}">
              ${mark(step, i)}
              <span class="guide-step-text"><span class="guide-step-title">${step.title}</span><span class="text-xs text-muted">${step.text}</span></span>
              ${step.done ? '' : stepAction(step, hosts)}
            </li>`)}
        </ol>
        <button class="btn btn-ghost btn-sm" type="button" data-guide="help">${ico('question', 'sm')}使用说明</button>
      </div>
    </div>`;
}

// The slim strip above the host grid while steps are left.
export function strip(steps, hosts) {
  const left = steps.filter(s => !s.done);
  return html`
    <section class="guide-strip card" aria-label="上手">
      <span class="guide-progress" title="上手进度">${steps.length - left.length}/${steps.length}</span>
      <ul class="guide-strip-steps">
        ${left.map((step, i) => html`
          <li class="guide-strip-step">
            ${ico(step.icon, 'sm')}
            <span class="guide-step-text"><span class="guide-step-title">${step.title}</span><span class="text-xs text-muted">${step.text}</span></span>
            ${stepAction(step, hosts)}
          </li>`)}
      </ul>
      <button class="btn btn-icon btn-sm btn-ghost" type="button" data-guide="dismiss" aria-label="不再显示上手提示" title="不再显示">${ico('close', 'sm')}</button>
    </section>`;
}

// ---- 使用说明 -----------------------------------------------------------------------------
const kbd = keys => html`${keys.split(' ').map(k => html`<kbd class="kbd">${k}</kbd>`)}`;
const SECTIONS = [
  { icon: 'host', title: '主机', items: [
    '卡片上直接开终端、文件或助手；右键看全部操作',
    '拖动卡片排序；在线的主机显示实时 CPU、内存、磁盘和网速',
    '首次连接会让你核对服务器指纹，之后指纹变了会拒绝连接',
  ] },
  { icon: 'terminal', title: '终端', items: [
    html`${kbd('Ctrl F')} 查找，${kbd('Ctrl Shift C')} / ${kbd('Ctrl Shift V')} 复制粘贴`,
    '断线后按 Enter 重连；底部状态栏是这台主机的实时负载',
    '字号、字体和高亮在设置里调',
  ] },
  { icon: 'assistant', title: '终端里的助手', items: [
    html`命令行输入 <code># 一句话</code> 回车，助手在这个终端里查看、动手、回答`,
    html`要你决定时：${kbd('↑ ↓')} 选择，${kbd('Enter')} 确认，也可以按数字`,
    html`回答后直接接着问；${kbd('Esc')} 回到命令行，执行中按 ${kbd('Esc')} 中断`,
    '选中一段输出，右键"问 AI"，把它交给助手看',
  ] },
  { icon: 'folder', title: '文件', items: [
    '把本机文件拖进来就上传，拖到文件夹上就传进那个文件夹',
    '新建、重命名、删除、下载都在右键菜单里',
    '同名文件会问你：覆盖、跳过，还是两个都留',
  ] },
  { icon: 'plan', title: '助手页', items: [
    '查看类的问题直接回答；改动大的先给方案，点"执行方案"后自己做完并逐项验证',
    html`${kbd('Enter')} 发送，${kbd('Shift Enter')} 换行；最多 4 个对话同时进行`,
    '助手改过的文件会自动备份，可以一键撤销',
  ] },
  { icon: 'shield', title: '安全', items: [
    '删数据、停服务、重启、改防火墙或账户等操作，会先给出确切命令，你允许才执行',
    '命令输出会发给你配置的模型；密码、私钥和常见令牌发送前会被隐藏',
    '密码和密钥用系统加密保存在本机，不上传',
  ] },
];

export function openHelp() {
  return dialog({
    title: '使用说明',
    wide: true,
    body: html`
      <div class="help-grid">
        ${SECTIONS.map(s => html`
          <section class="help-section">
            <h3 class="help-title">${ico(s.icon, 'sm')}${s.title}</h3>
            <ul class="help-list">${s.items.map(item => html`<li>${item}</li>`)}</ul>
          </section>`)}
      </div>
      <p class="text-xs text-muted help-foot">${kbd('Ctrl K')} 随时搜索主机和操作。</p>`,
    actions: [{ label: '知道了', value: 'ok', tone: 'primary' }],
  });
}
