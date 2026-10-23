import {icon} from './icons.js';
import {initSelects} from './select-control.js';
const node=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls||'';if(text!==undefined)e.textContent=text;return e;};
export function hostSpaceUI({api,state,showError,toast,onHosts,actions={}}){
 let menu,anchor,dialog;
 function closeMenu(){if(menu){menu.hidePopover();menu.remove();menu=null;}anchor?.setAttribute('aria-expanded','false');}
 function menuButton(host){
  const b=node('button','host-more icon-button');b.type='button';b.append(icon('more'));b.title='主机操作';b.setAttribute('aria-label','主机操作 · '+host.name);b.setAttribute('aria-haspopup','menu');b.setAttribute('aria-expanded','false');
  b.addEventListener('click',e=>{e.stopPropagation();if(anchor===b&&menu?.matches(':popover-open')){closeMenu();return;}closeMenu();anchor=b;menu=node('div','host-action-menu');menu.setAttribute('popover','auto');menu.setAttribute('role','menu');menu.setAttribute('aria-label',host.name+' 操作');
   for(const [mode,label,glyph]of [['connect','连接终端','terminal'],['files','文件传输','transfer'],['edit','编辑','edit'],['move','移动到空间','folder'],['copy','复制到空间','copy'],['remove','删除','trash']]){if(['move','remove'].includes(mode))menu.append(node('hr'));const action=node('button','',label);action.prepend(icon(glyph));action.type='button';action.setAttribute('role','menuitem');if(mode==='remove')action.className='danger-action';action.addEventListener('click',()=>{closeMenu();Promise.resolve().then(()=>['move','copy'].includes(mode)?open(host,mode):actions[mode]?.(host)).catch(showError);});menu.append(action);}
   document.body.append(menu);menu.showPopover();b.setAttribute('aria-expanded','true');const r=b.getBoundingClientRect();menu.style.left=Math.max(12,Math.min(r.right-220,innerWidth-232))+'px';menu.style.top=Math.max(12,Math.min(r.bottom+6,innerHeight-menu.offsetHeight-12))+'px';menu.querySelector('button').focus();
   menu.addEventListener('keydown',event=>{const buttons=[...menu.querySelectorAll('button')],i=buttons.indexOf(document.activeElement);if(['ArrowUp','ArrowDown','Home','End'].includes(event.key)){event.preventDefault();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(i+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length].focus();}if(event.key==='Escape'){event.preventDefault();closeMenu();b.focus();}});
   menu.addEventListener('toggle',()=>{b.setAttribute('aria-expanded',String(!!menu?.matches(':popover-open')));});
  });return b;
 }
 window.addEventListener('resize',closeMenu);document.addEventListener('scroll',e=>{if(menu&&!menu.contains(e.target))closeMenu();},true);
 async function open(host,mode){
  if(dialog?.open)return;const [info,hosts]=await Promise.all([api.workspaceState(),api.hostTransferPlan(host.id,mode)]);const account=info.accounts.find(a=>a.id===info.accountId),spaces=account.spaces.filter(s=>s.id!==info.spaceId),copy=mode==='copy';
  const modal=dialog=node('dialog','host-transfer-dialog');modal.id='host-transfer-dialog';const title=node('h2','',copy?'复制到空间':'移动到空间');title.id='host-transfer-title';modal.setAttribute('aria-labelledby',title.id);
  const head=node('div','dialog-heading'),close=node('button','icon-button');close.type='button';close.append(icon('close'));close.setAttribute('aria-label','关闭空间选择');close.onclick=()=>modal.close();head.append(title,close);
  const summary=node('div','transfer-host-summary'),badge=node('span','host-icon');badge.append(icon(copy?'copy':'server'));const detail=node('div');detail.append(node('strong','',host.name),node('small','',host.username+'@'+host.address));summary.append(badge,detail);modal.append(head,summary);
  if(hosts.length>1){const chain=node('div','transfer-chain');chain.append(node('strong','',`一起${copy?'复制跳板链路':'移动关联链路'} · ${hosts.length} 台`));for(const h of hosts)chain.append(node('span','',h.name));modal.append(chain);}
  const label=node('label','','目标空间'),target=node('select');target.id='host-transfer-target';for(const s of spaces)target.add(new Option(s.name,s.id));target.disabled=!spaces.length;label.append(target);modal.append(label,node('p','field-help',copy?'复制连接配置、已保存 SSH 凭据和指纹；原主机保留，副本独立。部署保护需在目标空间重新配置。':'SSH 凭据和指纹一起移动；历史任务留在原空间。部署保护需在目标空间重新配置。'));
  if(!spaces.length)modal.append(node('p','field-help','还没有其他空间，请先在左上角菜单新建项目空间。'));
  const error=node('p','form-error');error.setAttribute('role','alert');const actions=node('div','dialog-actions'),cancel=node('button','','取消'),submit=node('button','primary',copy?'复制':'移动');submit.disabled=!spaces.length;cancel.onclick=()=>modal.close();
  submit.onclick=async()=>{submit.disabled=true;try{state.hosts=await api[copy?'copyHosts':'moveHosts'](target.value,hosts.map(h=>h.id));onHosts();modal.close();toast(`已${copy?'复制':'移动'}到 ${spaces.find(s=>s.id===target.value).name}`);}catch(e){error.textContent=e.message;}finally{submit.disabled=!spaces.length;}};
  actions.append(cancel,submit);modal.append(error,actions);document.body.append(modal);const cleanup=initSelects(modal);modal.addEventListener('close',()=>{cleanup();modal.remove();},{once:true});modal.showModal();
 }
 return {menuButton,closeMenu};
}
