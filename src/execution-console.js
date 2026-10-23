import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { terminalTheme } from './appearance.js';
import { icon } from './icons.js';
import {metricStrip} from './host-metrics.js';
const labels={idle:'等待命令',running:'运行中',completed:'已完成',failed:'失败',timeout:'超时',interrupted:'已中断'};
export function executionConsole({api,toast,showError,credentials,refresh,hosts,trackingBadge,clipboardUI}) {
  const $=id=>document.querySelector(id), grid=$('#agent-terminal-grid'), tabs=$('#agent-terminal-tabs');
  const panes=new Map();let taskId=null, mode='2', selected=[],opening=false,resyncing=false;
  try{mode=localStorage.getItem('termus.agent.console.layout')||'2';}catch{}
  if(!['1','2','4'].includes(mode))mode='2';
  const element=(tag,cls,text)=>{const el=document.createElement(tag);el.className=cls;if(text!==undefined)el.textContent=text;return el;};
  function fit(){for(const pane of panes.values())if(!pane.el.classList.contains('hidden')){try{if(pane.manual){const {cols,rows}=pane.manual.term;pane.manual.fit.fit();if(pane.manual.status==='ready'&&(cols!==pane.manual.term.cols||rows!==pane.manual.term.rows))api.resize(pane.manual.id,pane.manual.term.cols,pane.manual.term.rows).catch(()=>{});}else if(pane.body.clientWidth>0)pane.fit.fit();}catch{}}}
  const run=action=>Promise.resolve().then(action).catch(showError);
  async function closeManual(pane){
    const session=pane.manual;if(!session)return;
    await api.disconnect(session.id);clipboardUI.removeExternal(session.id);session.term.dispose();session.pane.remove();pane.manual=null;
    pane.body.classList.remove('hidden');pane.toggle.setAttribute('aria-pressed','false');pane.toggle.title='手动终端 · 先暂停助手';pane.toggle.setAttribute('aria-label',pane.toggle.title);pane.toggle.replaceChildren(icon('terminal'));pane.paste.classList.add('hidden');
    pane.status.textContent=labels[pane.row.status]||pane.row.status;pane.status.className='execution-status '+pane.row.status;requestAnimationFrame(fit);
  }
  async function toggleManual(pane){
    if(opening)return;
    if(pane.manual){await closeManual(pane);return;}
    opening=true;pane.toggle.disabled=true;const owner=taskId;
    try{
      const auth=await credentials([pane.row.hostId]);if(auth===null||taskId!==owner)return;
      const body=element('div','execution-screen manual-screen');pane.el.append(body);pane.body.classList.add('hidden');
      const term=new Terminal({theme:terminalTheme(),fontFamily:'Consolas, "Microsoft YaHei UI", monospace',fontSize:12,lineHeight:1.25,scrollback:4000,cursorBlink:true});const addon=new FitAddon();term.loadAddon(addon);term.open(body);addon.fit();
      const session={id:crypto.randomUUID(),term,fit:addon,pane:body,host:hosts().find(h=>h.id===pane.row.hostId)||pane.row,status:'connecting'};pane.manual=session;
      pane.toggle.setAttribute('aria-pressed','true');pane.toggle.title='关闭手动终端 · 返回助手输出';pane.toggle.setAttribute('aria-label',pane.toggle.title);pane.toggle.replaceChildren(icon('close'));pane.paste.classList.remove('hidden');pane.status.textContent='连接中';
      clipboardUI.attachExternal(session);term.onData(data=>{if(session.status==='ready')api.write(session.id,data);});
      try {await api.agentManualOpen(session.id,owner,pane.row.hostId,auth,{cols:term.cols,rows:term.rows});if(taskId!==owner||panes.get(pane.row.hostId)!==pane){await api.disconnect(session.id);return;}session.status='ready';pane.status.textContent='手动';term.focus();}
      catch(error){await closeManual(pane);throw error;}
      finally{await refresh();}
    }finally{opening=false;pane.toggle.disabled=false;}
  }
  const resize=new ResizeObserver(fit);resize.observe(grid);
  function make(row){
    const el=element('article','agent-terminal-pane');el.dataset.hostId=row.hostId;
    const header=element('header','execution-host');const title=element('strong','',row.name),status=element('span','execution-status',labels[row.status]||row.status);
    const copy=element('button','icon-button');copy.title='复制选区或当前终端内容';copy.setAttribute('aria-label','复制 '+row.name+' 终端');copy.append(icon('copy'));
    const toggle=element('button','icon-button manual-toggle');toggle.title='手动终端 · 先暂停助手';toggle.setAttribute('aria-label',toggle.title);toggle.setAttribute('aria-pressed','false');toggle.append(icon('terminal'));
    const paste=element('button','icon-button manual-paste hidden');paste.title='粘贴 · Ctrl+V';paste.setAttribute('aria-label','粘贴到手动终端');paste.append(icon('clipboard'));
    const tracking=trackingBadge?.(row.hostId);
    const body=element('div','execution-screen');header.append(icon('server'),title,...(tracking?[tracking]:[]),status,toggle,paste,copy);el.append(header,metricStrip(row.hostId),body);grid.append(el);
    const term=new Terminal({theme:terminalTheme(),fontFamily:'Consolas, "Microsoft YaHei UI", monospace',fontSize:12,lineHeight:1.25,scrollback:4000,disableStdin:true,convertEol:true,cursorBlink:false});
    const addon=new FitAddon();term.loadAddon(addon);term.open(body);
    const copyText=async()=>{const source=pane.manual?.term||term;const text=source.getSelection()||Array.from({length:source.buffer.active.length},(_,i)=>source.buffer.active.getLine(i)?.translateToString(true)||'').join('\n').trimEnd();if(text){await api.writeClipboard(text);toast('已复制终端内容');}};
    copy.addEventListener('click',()=>copyText().catch(showError));
    term.attachCustomKeyEventHandler(e=>{if(e.type==='keydown'&&e.ctrlKey&&e.key.toLowerCase()==='c'&&term.hasSelection()){e.preventDefault();copyText().catch(showError);return false;}return true;});
    const pane={el,body,term,fit:addon,title,tracking,status,toggle,paste,manual:null,row:{...row,seq:-1},written:''};
    toggle.addEventListener('click',()=>run(()=>toggleManual(pane)));paste.addEventListener('click',()=>run(()=>clipboardUI.paste(pane.manual)));
    panes.set(row.hostId,pane);return pane;
  }
  function draw(){
    const capacity=Number(mode);selected=selected.filter(id=>panes.has(id));
    for(const id of panes.keys())if(selected.length<capacity&&!selected.includes(id))selected.push(id);
    selected=selected.slice(0,capacity);grid.dataset.layout=mode;grid.dataset.count=String(selected.length);tabs.replaceChildren();
    for(const [id,pane] of panes){
      pane.el.classList.toggle('hidden',!selected.includes(id));const btn=element('button','execution-tab'+(selected.includes(id)?' active':''));btn.append(element('span','',pane.row.name));if(trackingBadge){const next=trackingBadge(id);btn.append(next);if(pane.tracking&&(pane.tracking.className!==next.className||pane.tracking.title!==next.title)){const headerBadge=trackingBadge(id);pane.tracking.replaceWith(headerBadge);pane.tracking=headerBadge;}}btn.setAttribute('aria-pressed',String(selected.includes(id)));btn.title=pane.row.address;
      btn.addEventListener('click',()=>{if(selected.includes(id)){if(capacity>1)selected=selected.filter(x=>x!==id);}else {if(selected.length>=capacity)selected.pop();selected.push(id);}draw();});tabs.append(btn);
    }
    $('#agent-console-empty').classList.toggle('hidden',panes.size>0);
    $('#agent-console-count').textContent=panes.size?`${panes.size} 台主机`:'';
    for(const btn of document.querySelectorAll('[data-console-layout]'))btn.setAttribute('aria-pressed',String(btn.dataset.consoleLayout===mode));
    requestAnimationFrame(fit);
  }
  function update(row){
    const pane=panes.get(row.hostId)||make(row);if(row.seq<pane.row.seq)return;
    if(row.delta!==undefined){
      if(row.seq===pane.row.seq)return;
      if(row.baseSeq!==pane.row.seq){if(!resyncing){resyncing=true;Promise.resolve(refresh()).catch(showError).finally(()=>resyncing=false);}return;}
      row={...row,text:pane.written+row.delta};
    }
    if(row.seq===pane.row.seq&&row.text===pane.written&&row.status===pane.row.status)return;
    const previous=pane.written;pane.row=row;pane.title.textContent=row.name;if(!pane.manual){pane.status.textContent=labels[row.status]||row.status;pane.status.className='execution-status '+row.status;}
    if(row.text!==previous){const atBottom=pane.term.buffer.active.viewportY>=pane.term.buffer.active.baseY;
      if(row.text.startsWith(previous)){pane.term.write(row.text.slice(previous.length),()=>{if(atBottom)pane.term.scrollToBottom();});}
      else {pane.term.reset();pane.term.write((row.truncated?'[仅保留最近输出]\r\n':'')+row.text);}
      pane.written=row.text;
    }
    draw();
  }
  function setTask(task){
    if(taskId!==(task?.id||null)){for(const pane of panes.values()){if(pane.manual){api.disconnect(pane.manual.id).catch(showError);clipboardUI.removeExternal(pane.manual.id);pane.manual.term.dispose();}pane.term.dispose();}panes.clear();grid.replaceChildren();selected=[];taskId=task?.id||null;}
    for(const hostId of task?.hostIds||[])if(!panes.has(hostId)){const host=hosts().find(h=>h.id===hostId);make({hostId,name:host?.name||hostId,address:host?.address||'',text:'',seq:-1,status:'idle'});}
    for(const [id,pane] of panes)if(!task?.hostIds.includes(id)&&!pane.manual){pane.term.dispose();pane.el.remove();panes.delete(id);}
    for(const row of task?.terminals||[])update(row);draw();
  }
  for(const btn of document.querySelectorAll('[data-console-layout]'))btn.addEventListener('click',()=>{mode=btn.dataset.consoleLayout;try{localStorage.setItem('termus.agent.console.layout',mode);}catch{}draw();});
  $('#agent-console-expand').addEventListener('click',()=>{const expanded=$('#assistant-view').classList.toggle('console-focus');$('#agent-console-expand').setAttribute('aria-pressed',String(expanded));$('#agent-console-expand').title=expanded?'返回对话与终端':'展开执行台';requestAnimationFrame(fit);});
  window.addEventListener('termus-theme',()=>{for(const pane of panes.values()){pane.term.options.theme=terminalTheme();if(pane.manual)pane.manual.term.options.theme=terminalTheme();}});
  window.addEventListener('termus-metrics',()=>requestAnimationFrame(fit));
  api.onEvent(event=>{
    if(event.type==='agent-terminal'&&event.taskId===taskId)update(event.terminal);
    for(const pane of panes.values())if(pane.manual?.id===event.id){const session=pane.manual;
      if(event.type==='data')session.term.write(Uint8Array.from(atob(event.data),c=>c.charCodeAt(0)));
      if(event.type==='status'){session.status=event.status;pane.status.textContent=event.status==='ready'?'手动':event.status==='closed'?'已断开':'连接中';clipboardUI.update();}
      if(event.type==='fault')showError(event.message);
    }
  });
  draw();return {setTask,fit};
}
