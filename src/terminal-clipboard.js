import { preparePaste, MAX_CLIPBOARD_TEXT } from './clipboard.cjs';

export function terminalClipboard({ api, state, toast, showError }) {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#paste-dialog'), preview = $('#paste-preview'), menu = $('#terminal-menu');
  let pending = null, reading = false, menuSession = null;
  const external=new Map();let externalActive=null;
  const active = () => state.view==='assistant'?external.get(externalActive):state.sessions.get(state.active);
  const live = session => session && (state.sessions.get(session.id) === session || external.get(session.id) === session) && session.status === 'ready';
  const visible = session => active()===session && (external.has(session?.id)?state.view==='assistant'&&session.pane.offsetParent!==null:state.view==='terminal');
  const focus = session => { if (visible(session) && !document.querySelector('dialog[open]')) session?.term.focus(); };
  const run = action => Promise.resolve().then(action).catch(showError);
  function update() {
    $('#terminal-copy').disabled = !active()?.term.hasSelection();
    $('#terminal-paste').disabled = !live(active());
    if (pending) $('#paste-confirm').disabled = !live(pending.session) || !preview.value.length;
    if (menuSession && !visible(menuSession)) hideMenu();
  }
  async function copy(session) {
    const text = session?.term.getSelection();
    if (!text) { toast('先拖动鼠标选择要复制的终端文字'); return; }
    await api.writeClipboard(text);
    toast('已复制到系统剪贴板'); focus(session);
  }
  function send(session, text) {
    if (!live(session)) throw new Error('目标连接已断开，未粘贴任何内容');
    // xterm adds bracketed-paste markers only when requested by the remote shell.
    session.term.paste(text); session.term.clearSelection(); focus(session);
  }
  function refreshPreview() {
    if (!pending) return;
    const result = preparePaste(preview.value, $('#paste-trim').checked);
    $('#paste-count').textContent = `${result.text.length.toLocaleString()} 字符 · ${result.text.split('\n').length} 行`;
    $('#paste-cleaned').textContent = pending.removed + result.removed ? '已过滤不可见控制字符，请核对剩余文本。' : '';
    update();
  }
  async function paste(session, suppliedText) {
    if (reading || pending || document.querySelector('dialog[open]')) return;
    if (!live(session)) { toast('请先连接终端', true); return; }
    reading = true;
    try {
      const result = preparePaste(suppliedText === undefined ? await api.readClipboard() : suppliedText);
      if (!live(session)) throw new Error('目标连接已断开，未粘贴任何内容');
      // Clipboard access can yield while the user switches views or opens a form.
      if (!visible(session) || document.querySelector('dialog[open]')) return;
      if (!result.text) { toast('剪贴板中没有可粘贴的文本'); return; }
      if (!result.review) { send(session, result.text); return; }
      pending = { session, removed: result.removed };
      $('#paste-target').textContent = `${session.host.name} · ${session.host.username}@${session.host.address}:${session.host.port}`;
      preview.value = result.text; $('#paste-trim').checked = true;
      $('#paste-error').textContent = ''; refreshPreview();
      dialog.showModal(); $('#paste-cancel').focus();
    } finally { reading = false; }
  }
  $('#paste-confirm').addEventListener('click', () => {
    if (!pending) return;
    try {
      const result = preparePaste(preview.value, $('#paste-trim').checked);
      if (!result.text) throw new Error('没有可粘贴的文本');
      send(pending.session, result.text); dialog.close();
    } catch (error) { $('#paste-error').textContent = error.message; }
  });
  preview.maxLength = MAX_CLIPBOARD_TEXT;
  preview.addEventListener('input', () => run(refreshPreview));
  $('#paste-trim').addEventListener('change', () => run(refreshPreview));
  dialog.addEventListener('close', () => {
    const session = pending?.session; pending = null; preview.value = '';
    $('#paste-target').textContent = ''; focus(session);
  });
  function hideMenu(restore = false) {
    const session = menuSession; menuSession = null; menu.classList.add('hidden');
    if (restore) focus(session);
  }
  function openMenu(session, x, y) {
    menuSession = session;
    $('#menu-copy').disabled = !session.term.hasSelection();
    $('#menu-paste').disabled = !live(session);
    menu.classList.remove('hidden');
    menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  for (const [id, action] of [
    ['menu-copy', copy], ['menu-paste', paste],
    ['menu-select', session => { session.term.selectAll(); focus(session); }],
  ]) $( '#' + id).addEventListener('click', () => { const session = menuSession; hideMenu(); if (session) run(() => action(session)); });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); hideMenu(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...menu.querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus();
  });
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) hideMenu(); }, true);
  window.addEventListener('blur', () => hideMenu());
  window.addEventListener('resize', () => hideMenu());
  // Normal text/password fields retain native editing, including an OS context menu.
  document.addEventListener('contextmenu', event => {
    const field = event.target.closest('input, textarea');
    if (!field || field.closest('.terminal-pane,.execution-screen')) return;
    event.preventDefault(); run(() => api.editMenu(!!field.readOnly));
  });
  $('#terminal-copy').addEventListener('click', () => run(() => copy(active())));
  $('#terminal-paste').addEventListener('click', () => run(() => paste(active())));
  function attach(session) {
    const { term, pane } = session;
    term.onSelectionChange(update);
    // A local context-menu gesture must not also become a remote mouse click.
    pane.addEventListener('mousedown', event => {
      if (event.button === 2) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    // Capture before xterm's own paste listener so every entry point shares review.
    pane.addEventListener('paste', event => {
      event.preventDefault(); event.stopImmediatePropagation();
      run(() => paste(session, event.clipboardData?.getData('text/plain') ?? ''));
    }, true);
    pane.addEventListener('contextmenu', event => {
      event.preventDefault(); event.stopImmediatePropagation(); openMenu(session, event.clientX, event.clientY);
    }, true);
    term.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown' || event.altKey) return true;
      const mac=/^Mac/i.test(navigator.platform),ctrl=event.ctrlKey,primary=mac?event.metaKey:ctrl;
      const isCopy = event.code === 'KeyC' && (primary && (mac || event.shiftKey || term.hasSelection()) || ctrl && event.shiftKey) || ctrl && event.code === 'Insert';
      const isPaste = (primary || ctrl && event.shiftKey) && event.code === 'KeyV' || !ctrl && !event.metaKey && event.shiftKey && event.code === 'Insert';
      const isMenu = event.code === 'ContextMenu' || event.shiftKey && event.code === 'F10';
      if (!isCopy && !isPaste && !isMenu) return true;
      event.preventDefault(); event.stopPropagation();
      if (event.repeat) return false;
      if (isMenu) { const rect = pane.getBoundingClientRect(); openMenu(session, rect.left + 24, rect.top + 24); }
      else run(() => isCopy ? copy(session) : paste(session));
      return false;
    });
  }
  function attachExternal(session) {
    external.set(session.id,session);externalActive=session.id;
    session.pane.addEventListener('pointerdown',()=>{externalActive=session.id;update();});
    session.term.onFocus?.(()=>{externalActive=session.id;update();});
    session.pane.addEventListener('focusin',()=>{externalActive=session.id;update();});
    attach(session);update();
  }
  return { attach, update, attachExternal, removeExternal:id=>{external.delete(id);update();}, paste:session=>{externalActive=session.id;return paste(session);} };
}
