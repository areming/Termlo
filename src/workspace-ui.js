import { icon } from './icons.js';
import { confirmAction } from './app-dialogs.js';
import { managementUI } from './management-ui.js';
import { avatar } from './avatar.js';
export function initWorkspaces({ api, state, showError }) {
  const trigger = document.querySelector('#workspace-switch');
  const menu = document.createElement('div'); menu.id = 'workspace-menu'; menu.className = 'workspace-menu hidden'; document.body.append(menu);
  let info, accountsPage = false, busy = false, menuAnchor=trigger;
  const management=managementUI({api,state,showError,select,onInfo:value=>{info=value;render();}});
  const profileButton=document.createElement('button');profileButton.id='account-profile-button';profileButton.className='account-profile-button';profileButton.type='button';profileButton.setAttribute('aria-label','切换用户');profileButton.addEventListener('click',async()=>{try{if(menuAnchor===profileButton&&!menu.classList.contains('hidden'))return close();info=await api.workspaceState();accountsPage=true;menuAnchor=profileButton;render();open();}catch(e){showError(e);}});
  const addUser=document.createElement('button');addUser.id='account-add-button';addUser.className='account-add-button';addUser.type='button';addUser.title='添加用户';addUser.setAttribute('aria-label','添加用户');addUser.append(icon('plus'));addUser.addEventListener('click',()=>{close();management.open('add').catch(showError);});
  const dock=document.createElement('div');dock.className='account-dock';dock.append(profileButton,addUser);document.querySelector('.sidebar-bottom').before(dock);
  const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const button = (text, action, cls = '') => { const b = node('button', cls, text); b.type = 'button'; b.addEventListener('click', () => Promise.resolve().then(action).catch(showError)); return b; };
  const close = () => { menu.classList.add('hidden'); trigger.setAttribute('aria-expanded', 'false');profileButton.setAttribute('aria-expanded','false'); };
  function position() { const r = menuAnchor.getBoundingClientRect(); menu.style.left = Math.max(8,Math.min(r.left, window.innerWidth - 332)) + 'px'; menu.style.top = (menuAnchor===profileButton?Math.max(10,r.top-menu.offsetHeight-6):Math.min(r.bottom+6,innerHeight-menu.offsetHeight-10)) + 'px'; }
  async function select(accountId, spaceId) {
    if (busy) return;
    if (document.querySelector('dialog[open]')) throw new Error('请先关闭当前对话框');
    if (document.querySelector('#agent-prompt').value.trim() || document.querySelector('#agent-attachments')?.children.length) {
      if (!await confirmAction('切换项目空间？', '尚未发送的内容和附件草稿会清空。已发送的任务记录会保留。', '切换')) return;
    }
    busy = true; close(); trigger.disabled = true;
    try { sessionStorage.setItem('termus.switchView', state.view); if (await api.workspaceSwitch(accountId, spaceId)) document.body.classList.add('workspace-switching'); }
    finally { busy = false; trigger.disabled = false; }
  }
  function create(kind) {
    close(); const dialog = node('dialog'); dialog.id = 'workspace-create-dialog';
    const form = node('form'), head = node('div', 'dialog-heading'), title = kind === 'account' ? '新建本地账户' : '新建项目空间';
    const cancel = () => dialog.close(); const x = button('', cancel, 'icon-button'); x.append(icon('close')); x.setAttribute('aria-label', '关闭'); head.append(node('h2', '', title), x);
    const a = info.accounts.find(a => a.id === info.accountId), label = node('label', '', '名称'), input = node('input'); input.required = true; input.maxLength = 60; input.name = 'name'; label.append(input);
    const detail = node('p', 'field-help', kind === 'account' ? '独立保存在此设备；这不是云端登录，订阅和同步尚未接入。' : '所属账户：' + a.name);
    const error = node('p', 'form-error'); error.setAttribute('role', 'alert'); const actions = node('div', 'dialog-actions'), submit = node('button', 'primary', '创建'); submit.type = 'submit'; actions.append(button('取消', cancel), submit);
    form.append(head, detail, label, error, actions); dialog.append(form); document.body.append(dialog);
    dialog.addEventListener('close', () => { dialog.remove(); trigger.focus(); }, { once: true });
    form.addEventListener('submit', async e => { e.preventDefault(); if (!form.reportValidity()) return; submit.disabled = true; try { info = await api.workspaceCreate(kind, input.value); dialog.close(); render(); open(); } catch (e) { error.textContent = e.message; } finally { submit.disabled = false; } });
    dialog.showModal(); input.focus();
  }
  function render() {
    if (!info) return; const a = info.accounts.find(a => a.id === info.accountId), s = a.spaces.find(s => s.id === info.spaceId);
    profileButton.replaceChildren(avatar(a));const identity=node('span','account-profile-label');identity.append(node('strong','',a.identity?.displayName||a.name),node('small','','切换用户'));profileButton.append(identity,icon('chevron'));profileButton.title='切换用户 · '+(a.identity?.email||a.name);
    document.querySelector('#workspace-name').textContent = s.name; document.querySelector('#topbar-workspace-name').textContent = s.name; document.querySelector('#workspace-account').textContent = '项目空间'; trigger.title = '切换项目空间';
    menu.replaceChildren();
    if (accountsPage) {
      menu.append(node('small', 'workspace-menu-caption', '切换用户'));
      for (const account of info.accounts) { const b = button('', () => select(account.id)); b.append(avatar(account,'small'), node('span', '', account.identity?.displayName||account.name), node('small', '', account.spaces.length + ' 个空间')); b.classList.toggle('selected', account.id === a.id); menu.append(b); }
      const manage=button('',()=>{close();return management.open('profile');});manage.append(icon('settings'),node('span','','用户看板'));menu.append(node('hr'),manage);
    } else {
      menu.append(node('small', 'workspace-menu-caption', '项目空间'));
      for (const space of a.spaces) { const b = button('', () => select(a.id, space.id)); b.append(icon('folder'), node('span', '', space.name), node('small', '', space.id === s.id ? '✓' : '')); b.classList.toggle('selected', space.id === s.id); menu.append(b); }
      menu.append(node('hr'), button('+ 新建项目空间', () => create('space')), node('small', 'workspace-menu-caption', '主机、会话与 Agent 记录按空间归属'));
      menu.append(node('hr'),button('空间管理',()=>{close();return management.open('spaces',{spaceOnly:true});}));
    }
  }
  function open() { menu.classList.remove('hidden'); menuAnchor.setAttribute('aria-expanded', 'true'); position(); }
  trigger.addEventListener('click', async () => { if (busy) return; if (menuAnchor===trigger&&!menu.classList.contains('hidden')) return close(); try { info = await api.workspaceState(); accountsPage = false;menuAnchor=trigger; render(); open(); } catch (e) { showError(e); } });
  document.addEventListener('click', e => { const path=e.composedPath(); if (!path.includes(trigger) && !path.includes(profileButton) && !path.includes(menu)) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.classList.contains('hidden')) { close(); trigger.focus(); } });
  window.addEventListener('resize', close);
  return { setInfo(value) { info = value; render(); },openManagement:management.open };
}
