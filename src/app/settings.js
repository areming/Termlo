// Settings: model, appearance, known hosts, about.
import { api, html, raw, ico, render, $, on, confirm, toast, fail, message, selectable } from './ui.js';
import { TERMINAL_FONTS } from './terminal.js';
import { openHelp } from './guide.js';

const PRESETS = [
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { label: '本机 Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
];

export function createSettingsPage(element, app) {
  const { store } = app;
  let settings = {};
  let known = [];
  let testing = false;

  async function load() {
    try {
      [settings, known] = await Promise.all([api.agentState().then(s => s.settings), api.knownHosts()]);
    } catch (error) { fail(error); }
    draw();
  }

  function draw() {
    const { preferences, version, update } = store.get();
    const result = update?.result;
    const updateLine = update?.checking ? '正在检查…'
      : update?.error ? update.error
      : result?.newer ? `有新版本 ${result.latest}`
      : result ? '已是最新版本'
      : '';
    render(element, html`
      <div class="page settings-page">
        <section class="settings-section" id="settings-model" aria-labelledby="s-model">
          <header><h2 class="title-lg" id="s-model">模型</h2><p class="text-muted">OpenAI 兼容接口，模型需支持工具调用</p></header>
          <form class="card settings-card" data-form="model" autocomplete="off">
            <div class="field">
              <label class="field-label" for="m-base">接口地址</label>
              <input class="input mono" id="m-base" name="baseUrl" value="${settings.baseUrl || ''}" placeholder="https://…/v1" required spellcheck="false">
              <div class="preset-row">${PRESETS.map(p => html`<button class="btn btn-sm btn-ghost" type="button" data-preset="${p.baseUrl}">${p.label}</button>`)}</div>
            </div>
            <div class="field-row">
              <div class="field">
                <label class="field-label" for="m-model">模型名称</label>
                <input class="input mono" id="m-model" name="model" value="${settings.model || ''}" placeholder="例如 deepseek-chat…" required spellcheck="false">
              </div>
              <div class="field field-port">
                <label class="field-label" for="m-rounds">每次最多调用</label>
                <input class="input mono num" id="m-rounds" name="maxRounds" inputmode="numeric" value="${settings.maxRounds || 60}" required pattern="[0-9]{1,3}">
              </div>
            </div>
            <div class="field">
              <label class="field-label" for="m-fallback" title="主模型限流或额度用完时，本次任务自动改用它（同一接口和密钥）">备用模型<span class="optional">可选</span></label>
              <input class="input mono" id="m-fallback" name="fallbackModel" value="${settings.fallbackModel || ''}" placeholder="主模型限流或额度用完时改用它…" spellcheck="false">
            </div>
            <div class="field">
              <label class="field-label" for="m-key" title="用系统加密保存在本机；更换接口地址后需要重新填写">API 密钥<span class="optional">${settings.keyBroken ? '' : settings.hasKey ? '已保存，留空则不变' : '本机接口可以不填'}</span></label>
              <input class="input mono" id="m-key" name="apiKey" type="password" placeholder="${settings.hasKey ? '••••••••' : 'sk-…'}" autocomplete="off">
              ${settings.keyBroken ? html`<p class="field-error">${ico('status-warning', 'sm')}已保存的密钥无法在这台电脑上解密，请重新填写。</p>` : ''}
            </div>
            <div class="btn-group settings-actions">
              <button class="btn" type="button" data-action="test" ${testing || !settings.model ? raw('disabled') : ''} ${testing ? raw('aria-busy="true"') : ''}>${testing ? '测试中…' : '测试连接'}</button>
              <button class="btn btn-primary" type="submit">保存</button>
            </div>
          </form>
          <p class="text-xs text-muted">使用助手时，命令输出会发给这里配置的模型服务。详见下方安全说明。</p>
        </section>

        <section class="settings-section" aria-labelledby="s-look">
          <header><h2 class="title-lg" id="s-look">外观</h2></header>
          <div class="card settings-card">
            <div class="setting">
              <span class="setting-text"><span>主题</span></span>
              <div class="segmented segmented-sm" role="radiogroup" aria-label="主题" id="s-theme">
                <button type="button" role="radio" data-theme-choice="dark" aria-checked="${preferences.theme !== 'light'}">暗色</button>
                <button type="button" role="radio" data-theme-choice="light" aria-checked="${preferences.theme === 'light'}">亮色</button>
              </div>
            </div>
            <div class="setting">
              <span class="setting-text"><span>终端字号</span><span class="text-xs text-muted">${preferences.terminalFontSize} px</span></span>
              <div class="btn-group">
                <button class="btn btn-icon btn-sm" type="button" data-font="-1" aria-label="减小终端字号" title="减小">−</button>
                <button class="btn btn-icon btn-sm" type="button" data-font="1" aria-label="增大终端字号" title="增大">${ico('plus', 'sm')}</button>
              </div>
            </div>
            <div class="setting">
              <span class="setting-text" id="s-font-label"><span>终端字体</span></span>
              <div class="segmented segmented-sm" role="radiogroup" aria-labelledby="s-font-label" id="s-font">
                ${Object.entries(TERMINAL_FONTS).map(([key, font]) => html`<button type="button" role="radio" data-font-choice="${key}" aria-checked="${(preferences.terminalFont || 'jetbrains') === key}" title="${font.label}" style="font-family: ${font.family}">${font.short}</button>`)}
              </div>
            </div>
            <div class="setting">
              <label class="setting-text" for="s-highlights"><span>终端高亮</span><span class="text-xs text-muted">给命令、地址、路径、错误和警告上色</span></label>
              <input class="switch" type="checkbox" role="switch" id="s-highlights" ${preferences.terminalHighlights !== false ? raw('checked') : ''}>
            </div>
            ${document.documentElement.dataset.platform !== 'darwin' ? html`
              <div class="setting">
                <label class="setting-text" for="s-tray"><span>关闭窗口时留在托盘</span><span class="text-xs text-muted">终端连接保持不断，右键托盘图标退出</span></label>
                <input class="switch" type="checkbox" role="switch" id="s-tray" ${preferences.closeToTray !== false ? raw('checked') : ''}>
              </div>` : ''}
          </div>
        </section>

        <section class="settings-section" aria-labelledby="s-known">
          <header><h2 class="title-lg" id="s-known">已知主机</h2><p class="text-muted">服务器重装或换了密钥，删掉旧记录再连接即可</p></header>
          ${known.length ? html`
            <ul class="list">${known.map(k => html`
              <li class="row">
                ${ico('shield', 'sm')}
                <div class="row-main"><span class="row-title mono">${k.address}:${k.port}</span><span class="row-meta mono truncate" translate="no">${k.fingerprint}</span></div>
                <div class="quick-actions"><button class="btn btn-icon btn-sm btn-ghost" type="button" data-forget="${k.key}" aria-label="删除 ${k.address} 的指纹" title="删除指纹">${ico('trash', 'sm')}</button></div>
              </li>`)}</ul>`
          : html`<p class="text-muted">还没有记录。</p>`}
        </section>

        <section class="settings-section" aria-labelledby="s-safety">
          <header><h2 class="title-lg" id="s-safety">安全说明</h2></header>
          <div class="card settings-card">
            <div class="setting">
              <span class="setting-text"><span>助手能做什么</span><span class="text-xs text-muted">拥有你所选 SSH 账户的权限，只能操作这次任务选中的主机。</span></span>
            </div>
            <div class="setting">
              <span class="setting-text"><span>什么会发给模型</span><span class="text-xs text-muted">对话内容、命令输出，以及你在终端里交给助手的屏幕内容。密码、私钥和常见令牌发送前会被隐藏；少于 8 个字符的密码无法可靠隐藏。</span></span>
            </div>
            <div class="setting">
              <span class="setting-text"><span>什么能撤销</span><span class="text-xs text-muted">只有助手用“修改文件”做的改动会自动备份、可以撤销。安装软件、启动服务等命令需要你另行检查。</span></span>
            </div>
            <div class="setting">
              <span class="setting-text"><span>密钥保存在哪</span><span class="text-xs text-muted">SSH 密码、私钥口令和模型密钥用系统加密保存在这台电脑上，不上传。</span></span>
            </div>
          </div>
        </section>

        <section class="settings-section" aria-labelledby="s-about">
          <header><h2 class="title-lg" id="s-about">关于</h2></header>
          <div class="card settings-card settings-about">
            <div class="setting">
              <span class="setting-text"><span>Termlo ${version}</span>${updateLine ? html`<span class="text-xs ${result?.newer ? 'text-accent' : 'text-muted'}" aria-live="polite">${updateLine}</span>` : ''}</span>
              <div class="btn-group">
                ${result?.newer ? html`<button class="btn btn-sm btn-primary" type="button" data-action="open-release">${ico('download', 'sm')}下载 ${result.latest}</button>` : ''}
                <button class="btn btn-sm" type="button" data-action="check-update" ${update?.checking ? raw('disabled aria-busy="true"') : ''}>${ico('refresh', 'sm')}检查更新</button>
              </div>
            </div>
            <div class="setting">
              <label class="setting-text" for="s-update"><span>自动检查更新</span><span class="text-xs text-muted">每天看两次 GitHub 上有没有新版本，有就提醒你；不会自动安装</span></label>
              <input class="switch" type="checkbox" role="switch" id="s-update" ${preferences.updateCheck !== false ? raw('checked') : ''}>
            </div>
            <p class="text-muted text-xs">本地优先：主机、密码和任务记录只保存在这台电脑上。<button class="link-button" type="button" data-action="help">使用说明</button></p>
          </div>
        </section>
      </div>`);
    selectable($('#s-theme', element), '[role="radio"]', 'aria-checked', button => app.setPreferences({ theme: button.dataset.themeChoice }));
    selectable($('#s-font', element), '[role="radio"]', 'aria-checked', button => app.setPreferences({ terminalFont: button.dataset.fontChoice }));
  }

  element.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    const data = Object.fromEntries(new FormData(form));
    try {
      settings = await api.agentConfigure({ baseUrl: data.baseUrl.trim(), model: data.model.trim(), fallbackModel: data.fallbackModel.trim(), maxRounds: Number(data.maxRounds), ...(data.apiKey ? { apiKey: data.apiKey } : {}) });
      toast('已保存模型设置', { tone: 'success' });
      draw();
    } catch (error) { fail(error); }
  });
  on(element, 'click', '[data-preset]', (_e, button) => { $('#m-base', element).value = button.dataset.preset; $('#m-model', element).focus(); });
  on(element, 'click', '[data-action="test"]', async () => {
    testing = true; draw();
    try {
      const result = await api.agentTest();
      toast(result.toolCalling ? '连接正常，模型支持工具调用' : '能连上，但模型没有调用工具，助手可能无法工作', { tone: result.toolCalling ? 'success' : 'warning', timeout: 6000 });
    } catch (error) { toast('连接失败：' + message(error), { tone: 'danger' }); }
    testing = false; draw();
  });
  on(element, 'click', '[data-font]', (_e, button) => {
    const size = (store.get().preferences.terminalFontSize || 14) + Number(button.dataset.font);
    if (size >= 11 && size <= 22) app.setPreferences({ terminalFontSize: size }).then(draw);
  });
  element.addEventListener('change', event => {
    if (event.target.id === 's-tray') app.setPreferences({ closeToTray: event.target.checked });
    if (event.target.id === 's-highlights') app.setPreferences({ terminalHighlights: event.target.checked });
    if (event.target.id === 's-update') app.setPreferences({ updateCheck: event.target.checked });
  });
  on(element, 'click', '[data-action="check-update"]', async () => {
    const pending = api.checkUpdate();
    store.set({ update: { ...store.get().update, checking: true } }); draw();
    try { await pending; } catch (error) { fail(error); }
    draw();
  });
  on(element, 'click', '[data-action="help"]', () => openHelp());
  on(element, 'click', '[data-action="open-release"]', () => api.openRelease(store.get().update?.result?.url).catch(fail));
  app.on('update', () => { if (element.isConnected && !element.closest('[hidden]')) draw(); });
  on(element, 'click', '[data-forget]', async (_e, button) => {
    if (!(await confirm({ title: '删除这条指纹记录？', text: '下次连接这台服务器时需要重新确认它的身份。', action: '删除记录' }))) return;
    try { await api.forgetHostKey(button.dataset.forget); known = await api.knownHosts(); draw(); } catch (error) { fail(error); }
  });

  return {
    show(params) {
      load().then(() => { if (params?.section === 'model') $('#m-base', element)?.focus(); });
    },
  };
}
