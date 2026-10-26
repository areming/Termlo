import {icon} from './icons.js';
import {confirmAction} from './app-dialogs.js';
import {initSelects} from './select-control.js';
import {avatar} from './avatar.js';
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const errorText=e=>String(e?.message||e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');
export function managementUI({api,state,showError,onInfo,select}){
 let dialog,info,accountId,section='spaces',pending=false,spaceOnly=false,cleanupSelects=()=>{};
 const act=fn=>()=>Promise.resolve().then(fn).catch(showError);
 const button=(label,fn,cls='')=>{const b=node('button',cls,label);b.type='button';b.addEventListener('click',act(fn));return b;};
 const glyph=(name,title,fn)=>{const b=button('',fn,'icon-button');b.append(icon(name));b.title=title;b.setAttribute('aria-label',title);return b;};
 async function refresh(){info=await api.managementState();if(!info.accounts.some(a=>a.id===accountId))accountId=info.accountId;onInfo(info);render();}
 function heading(title){const row=node('div','management-heading');row.append(node('h3','',title));return row;}
 async function leaveAndSwitch(id,space){dialog.close();await select(id,space);}
 function form(title,fields,submit){
  const pane=node('form','management-form');pane.append(node('h3','',title));const values={};
  for(const f of fields){const label=node('label','',f.label),input=node('input');input.name=f.name;input.type=f.type||'text';input.value=f.value||'';input.required=f.required!==false;input.maxLength=f.max||200;if(f.min)input.minLength=f.min;input.autocomplete=f.autocomplete||'off';if(f.placeholder)input.placeholder=f.placeholder;label.append(input);pane.append(label);values[f.name]=input;}
  const error=node('p','form-error');error.setAttribute('role','alert');const actions=node('div','dialog-actions'),save=node('button','primary',title);save.type='submit';actions.append(button('取消',()=>{if(section==='login')section='profile';render();}),save);pane.append(error,actions);
  pane.addEventListener('submit',async e=>{e.preventDefault();if(pending||!pane.reportValidity())return;pending=true;save.disabled=true;try{await submit(Object.fromEntries(Object.entries(values).map(([k,v])=>[k,v.value])));await refresh();}catch(e){error.textContent=errorText(e);}finally{for(const v of Object.values(values))if(v.type==='password')v.value='';pending=false;save.disabled=false;}});
  cleanupSelects();dialog.querySelector('.management-content').replaceChildren(pane);values[fields[0].name]?.focus();return pane;
 }
 function create(kind){form(kind==='account'?'新建本地用户':'新建项目空间',[{name:'name',label:'名称',max:60}],async v=>{const result=await api.workspaceCreate(kind,v.name,accountId);if(kind==='account'){accountId=result.accountId;section='spaces';}});}
 function rename(kind,id,value){form('保存名称',[{name:'name',label:kind==='account'?'账户名称':'空间名称',value,max:60}],v=>api.workspaceRename(kind,accountId,kind==='space'?id:undefined,v.name));}
 async function remove(kind,id){if(!await confirmAction('移除'+(kind==='account'?'账户':'空间')+'？','仅能移除空项目；本机已有文件不会被递归删除。','移除'))return;await api.workspaceRemove(kind,accountId,kind==='space'?id:undefined);await refresh();}
 function login(mode='login',base='',mail='',targetId=''){
  section='login';render();const tabs=node('div','management-tabs');tabs.append(button('登录',()=>login('login',base,mail,targetId),mode==='login'?'selected':''),button('注册',()=>login('register',base,mail),mode==='register'?'selected':''));
  const pane=form(mode==='register'?'注册用户':targetId?'重新连接此用户':'登录用户',[{name:'baseUrl',label:'账户服务地址',value:base,placeholder:'http://服务器:端口',max:300},{name:'email',label:'邮箱',type:'email',value:mail,autocomplete:'username'},...(mode==='register'?[{name:'name',label:'显示名称',max:60}]:[]),{name:'password',label:'密码（12–128 字符）',type:'password',min:12,max:128,autocomplete:mode==='login'?'current-password':'new-password'}],async values=>{const result=targetId&&mode==='login'?await api.accountReconnect(targetId,values):await api.accountAuthenticate({...values,mode});accountId=result.accountId;section='profile';});
  pane.prepend(tabs);const transport=node('p','field-help');const update=()=>{transport.textContent=/^http:\/\//i.test(pane.elements.baseUrl.value.trim())?'HTTP · 连接未加密':'支持 HTTP / HTTPS · 只向所填地址发送账户信息';};pane.elements.baseUrl.addEventListener('input',update);update();pane.append(transport,node('p','field-help',targetId?'修改地址后重新登录；仅当用户 ID 与邮箱均一致时更新此用户，原空间与主机保留。':'填写服务根地址即可；完整注册/登录接口或 Swagger 地址也会自动识别。'));
 }
 function render(){
  if(!dialog?.open||!info)return;cleanupSelects();const nav=dialog.querySelector('.management-accounts'),content=dialog.querySelector('.management-content');nav.replaceChildren();content.replaceChildren();
  for(const a of info.accounts){const b=button('',()=>{accountId=a.id;section='spaces';render();},'management-account'+(a.id===accountId?' selected':''));b.append(avatar(a,'small'),node('span','',a.name));b.title=a.identity?.email||'本地账户';nav.append(b);}
  nav.append(button('+ 本地用户',()=>create('account')),button('登录 / 注册',()=>login()));nav.classList.toggle('hidden',spaceOnly);
  if(section==='add'){
   content.append(heading('添加用户'),node('p','field-help','可连接账户服务，也可只在此设备创建独立用户。'));
   const choices=node('div','management-add-choices');
   const remote=button('',()=>login(),'management-add-choice');remote.append(icon('key'),node('strong','','登录或注册'),node('small','','连接已有账户服务'));
   const local=button('',()=>create('account'),'management-add-choice');local.append(icon('plus'),node('strong','','本地用户'),node('small','','独立保存，离线可用'));
   choices.append(remote,local);content.append(choices);return;
  }
  const account=info.accounts.find(a=>a.id===accountId),top=heading(spaceOnly?'项目空间':account.name);if(!spaceOnly){top.prepend(avatar(account,'large'));top.append(glyph('edit','重命名账户',()=>rename('account',account.id,account.name)),glyph('trash','移除空账户',()=>remove('account')),button(account.id===info.accountId?'当前账户':'进入账户',()=>leaveAndSwitch(account.id),account.id===info.accountId?'selected':''));}content.append(top);
  if(section==='login')return;
  const profile=node('div','management-profile management-dashboard-profile');
  if(account.identity){
   const sync=account.login.sync||{},syncLabels={synced:'配置已同步',pending:'等待同步',unsupported:'服务版本较旧',conflict:'多设备修改冲突',error:'同步遇到问题','not-loaded':'尚未同步'};
   const status=node('div','management-profile-status');status.append(node('span','management-status-dot'+(sync.status==='synced'?' is-signed-in':'')),node('strong','',account.login.signedIn?'远程账户 · '+(syncLabels[sync.status]||'同步状态待检查'):'远程账户 · 此设备未登录'),node('small','',sync.message||'空间、主机信息以及模型地址、模型名和调用预算使用账户密码加密同步；SSH 密码、私钥和模型 API 密钥只保存在本机。'));profile.append(status);
   const details=node('div','management-profile-details');for(const [label,value]of [['邮箱',account.identity.email],['账户服务',account.identity.baseUrl],['同步状态',syncLabels[sync.status]||'尚未同步']]){const row=node('div');row.append(node('small','',label),node('span','',value||'—'));details.append(row);}profile.append(details);
   const actions=node('div','management-profile-actions');
   if(account.login.signedIn){actions.append(button('验证连接',async()=>{await api.accountVerify(account.id);await refresh();}),button('立即同步',async()=>{await api.accountSyncNow(account.id);await refresh();}));}
   actions.append(button(account.login.signedIn?'更换服务地址 / 重新登录':'重新登录 / 更新服务地址',()=>login('login',account.identity.baseUrl,account.identity.email,account.id)));
   if(account.login.hasSession)actions.append(button('从此设备退出',async()=>{await api.accountLogout(account.id);await refresh();}));
   profile.append(actions);
   if(sync.status==='conflict'&&account.login.signedIn){
    const conflict=node('div','management-sync-conflict');conflict.append(node('strong','','检测到此设备与云端都有更新'),node('p','','选择保留哪一份配置。选择本机版本会覆盖云端；选择云端版本会替换本机空间和主机信息。'));
    const choices=node('div','management-profile-actions');
    choices.append(button('载入云端配置',async()=>{if(!await confirmAction('载入云端配置？','此设备尚未同步的空间和主机设置会被云端版本替换。','载入'))return;await api.accountSyncResolve(account.id,'cloud');await refresh();}),button('用本机覆盖云端',async()=>{if(!await confirmAction('用本机配置覆盖云端？','其他设备将会在下次同步时载入此设备的配置。','覆盖云端'))return;await api.accountSyncResolve(account.id,'local');await refresh();},'primary'));
    conflict.append(choices);profile.append(conflict);
   }
   if(account.login.signedIn){const actions=node('div','management-profile-actions');actions.append(button('编辑资料',()=>form('保存资料',[{name:'name',label:'显示名称',value:account.identity.displayName||account.name,max:60},{name:'locale',label:'语言（可选）',value:account.identity.profile?.locale,required:false,max:80},{name:'timeZone',label:'时区（可选）',value:account.identity.profile?.timeZone,required:false,max:80}],v=>api.accountUpdate(account.id,v))),button('修改密码',()=>form('修改密码',[{name:'oldPassword',label:'当前密码',type:'password',min:12,max:128},{name:'password',label:'新密码（修改后所有设备需重新登录）',type:'password',min:12,max:128}],v=>api.accountPassword(account.id,v))));profile.append(actions);}
  }else profile.append(node('p','field-help','本地用户数据仅保存在此设备。登录远程账户后，空间和主机配置可在设备间同步。'),button('登录 / 注册远程账户',()=>login()));
  profile.classList.toggle('hidden',spaceOnly);content.append(profile);
  const spacesHeading=node('div','management-subheading');spacesHeading.append(node('h4','','项目空间'),node('small','',account.spaces.length+' 个'));content.append(spacesHeading);
  for(const s of account.spaces){const row=node('div','management-row');row.append(icon('folder'),node('strong','',s.name));if(account.id===info.accountId&&s.id===info.spaceId)row.append(node('small','','当前'));else row.append(button('进入',()=>leaveAndSwitch(account.id,s.id)));row.append(glyph('edit','重命名 '+s.name,()=>rename('space',s.id,s.name)),glyph('trash','移除 '+s.name,()=>remove('space',s.id)));content.append(row);}
  content.append(button('+ 新建项目空间',()=>create('space')));
  if(!spaceOnly&&account.id===info.accountId){
   const details=node('details','management-inline-move'),summary=node('summary','','移动主机到其他空间');details.append(summary,node('p','field-help','任务历史留在原空间；涉及的跳板链路需一起移动。'));
   const destinations=account.spaces.filter(s=>s.id!==info.spaceId),list=node('div','management-hosts'),chosen=new Set();
   for(const h of state.hosts){const label=node('label','host-choice'),c=node('input');c.type='checkbox';c.value=h.id;c.addEventListener('change',()=>c.checked?chosen.add(h.id):chosen.delete(h.id));label.append(c,node('span','',h.name+' · '+h.address));list.append(label);}details.append(list);
   const target=node('select');target.id='management-move-target';target.setAttribute('aria-label','目标空间');for(const s of destinations)target.add(new Option(s.name,s.id));details.append(target);
   const move=button('移动所选主机',async()=>{if(!chosen.size)throw new Error('请先选择主机');if(!await confirmAction('移动 '+chosen.size+' 台主机？','凭据与指纹一并移动；原任务历史留在原空间。','移动'))return;state.hosts=await api.moveHosts(target.value,[...chosen]);window.dispatchEvent(new Event('termus-hosts-changed'));await refresh();},'primary');move.disabled=!destinations.length||!state.hosts.length;details.append(move);content.append(details);cleanupSelects=initSelects(details);
  }
 }
 async function open(initial='spaces',options={}){
  if(dialog?.open)return;spaceOnly=!!options.spaceOnly;info=await api.managementState();accountId=info.accountId;section=initial;
  dialog=node('dialog','management-dialog'+(spaceOnly?' space-management':''));dialog.id='management-dialog';const head=node('div','dialog-heading');head.append(node('h2','',spaceOnly?'空间管理':'用户看板'),glyph('close','关闭管理',()=>dialog.close()));
  const layout=node('div','management-layout');layout.append(node('aside','management-accounts'),node('section','management-content'));dialog.append(head,layout);document.body.append(dialog);dialog.addEventListener('close',()=>{cleanupSelects();dialog.remove();},{once:true});dialog.showModal();render();if(initial==='login')login();
 }
 window.addEventListener('termus-account-sync',()=>{if(dialog?.open)refresh().catch(showError);});
 return {open};
}
