const STORAGE_KEY = 'termlo.onboarding.v1';
const $ = selector => document.querySelector(selector);

export function initOnboarding({ api, state, workspaceUI, assistantUI, showView, editHost, showError }) {
  const root = $('#onboarding');
  const steps = [...root.querySelectorAll('[data-onboarding-step]')];
  let step = 0;
  let accountMode = 'local';
  let model = null;
  let account = null;

  function completed() {
    try { return localStorage.getItem(STORAGE_KEY) === 'done'; }
    catch { return false; }
  }
  function rememberCompleted() {
    try { localStorage.setItem(STORAGE_KEY, 'done'); }
    catch { /* An unwritable preference must not trap the user in onboarding. */ }
  }
  function hasModel() { return !!(model?.baseUrl && model?.model); }
  function updateAccountChoice() {
    for (const [id, selected] of [['onboarding-local', accountMode === 'local'], ['onboarding-online', accountMode === 'online']]) {
      const button = $('#' + id);
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
  }
  function updateStatus() {
    const hostCount = state.hosts.length;
    $('#onboarding-host-title').textContent = hostCount ? `已保存 ${hostCount} 台主机` : '还没有主机';
    $('#onboarding-host-detail').textContent = hostCount ? '可在现有主机页面继续编辑、连接和配置跳板机。' : '保存第一台机器后，就能打开终端和独立 SFTP。';
    $('#onboarding-model-title').textContent = hasModel() ? `已配置 ${model.model}` : '尚未配置模型';
    $('#onboarding-model-detail').textContent = hasModel() ? '可在模型设置中测试连接和工具调用。' : '在原有设置页填写接口、模型和密钥，并测试工具调用。';
    $('#onboarding-account-summary').textContent = accountMode === 'online' ? '已有服务已登录' : '本地使用';
    $('#onboarding-host-summary').textContent = hostCount ? `已保存 ${hostCount} 台` : '稍后添加';
    $('#onboarding-model-summary').textContent = hasModel() ? '已配置，待按需测试' : '稍后配置';
    updateAccountChoice();
    updateTips();
  }
  async function refreshStatus() {
    const [agentInfo, managementInfo] = await Promise.all([api.agentState(), api.managementState()]);
    model = agentInfo.settings;
    account = managementInfo.accounts.find(item => item.id === managementInfo.accountId);
    accountMode = account?.identity && account.login?.signedIn ? 'online' : 'local';
    updateStatus();
    return { agentInfo, managementInfo };
  }
  function showStep(number) {
    step = Math.max(0, Math.min(4, number));
    steps.forEach((item, index) => item.classList.toggle('active', index === step));
    root.querySelectorAll('.onboarding-progress span').forEach((item, index) => item.classList.toggle('active', index <= step));
    root.scrollTop = 0;
    updateStatus();
  }
  function hide() {
    rememberCompleted();
    root.classList.add('hidden');
    $('#onboarding-reopen').focus();
    updateTips();
  }
  function display() {
    showStep(0);
    root.classList.remove('hidden');
    root.tabIndex = -1;
    root.focus({ preventScroll: true });
  }
  async function open() { await refreshStatus(); display(); }
  function watchDialog(dialogId) {
    const dialog = $('#' + dialogId);
    if (!dialog) return;
    dialog.addEventListener('close', () => refreshStatus().catch(showError), { once: true });
  }
  function updateTips() {
    $('#agent-onboarding-hint').classList.toggle('hidden', hasModel());
    $('#sftp-onboarding-hint').classList.toggle('hidden', state.hosts.length > 0);
  }
  async function start(info) {
    const { agentInfo, managementInfo } = await refreshStatus();
    if (completed()) return;
    const accounts = managementInfo.accounts || [];
    const existing = info.hosts.length > 0 || agentInfo.tasks.length > 0 || hasModel() || accounts.length > 1 || accounts.some(item => item.identity || item.spaces?.length > 1);
    if (existing) { rememberCompleted(); return; }
    display();
  }

  root.querySelectorAll('[data-onboarding-next]').forEach(button => button.addEventListener('click', () => showStep(step + 1)));
  root.querySelectorAll('[data-onboarding-back]').forEach(button => button.addEventListener('click', () => showStep(step - 1)));
  root.querySelectorAll('[data-onboarding-skip]').forEach(button => button.addEventListener('click', () => showStep(step + 1)));
  $('#onboarding-exit').addEventListener('click', hide);
  $('#onboarding-finish').addEventListener('click', hide);
  $('#onboarding-reopen').addEventListener('click', () => open().catch(showError));
  $('#onboarding-local').addEventListener('click', () => {
    if (account?.identity && account.login?.signedIn) {
      workspaceUI.openManagement('profile').then(() => watchDialog('management-dialog')).catch(showError);
      return;
    }
    accountMode = 'local'; updateStatus();
  });
  $('#onboarding-online').addEventListener('click', async () => {
    try {
      await workspaceUI.openManagement('login');
      watchDialog('management-dialog');
    } catch (error) { showError(error); }
  });
  $('#onboarding-add-host').addEventListener('click', async () => {
    try { await editHost(); watchDialog('host-dialog'); }
    catch (error) { showError(error); }
  });
  $('#onboarding-configure-model').addEventListener('click', async () => {
    try { await assistantUI.openSettings(); }
    catch (error) { showError(error); }
  });
  $('#onboarding-service-open').addEventListener('click', () => { hide(); showView('assistant'); $('#agent-deploy-open').focus(); });
  $('#agent-onboarding-configure').addEventListener('click', () => assistantUI.openSettings().catch(showError));
  $('#sftp-onboarding-host').addEventListener('click', () => editHost().catch(showError));
  $('#agent-settings-dialog').addEventListener('close', () => refreshStatus().catch(showError));
  return { start, updateTips, refreshStatus };
}
