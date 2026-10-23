import {icon} from './icons.js';
let request;
export const confirmAction=(message,detail='',accept='确定')=>request({message,detail,buttons:['取消',accept],type:'question'}).then(result=>result.response===1);
export function initDialogs(api){
  const dialog=document.createElement('dialog');dialog.id='app-prompt-dialog';dialog.className='app-prompt';dialog.setAttribute('aria-labelledby','app-prompt-title');
  const heading=document.createElement('div');heading.className='dialog-heading';
  const title=document.createElement('h2');title.id='app-prompt-title';
  const emblem=document.createElement('span');emblem.className='prompt-emblem';
  const close=document.createElement('button');close.type='button';close.className='icon-button';close.title='关闭';close.setAttribute('aria-label','关闭提示');close.append(icon('close'));
  const text=document.createElement('div');text.id='app-prompt-detail';text.className='prompt-detail';dialog.setAttribute('aria-describedby',text.id);
  const actions=document.createElement('div');actions.className='dialog-actions';heading.append(emblem,title,close);dialog.append(heading,text,actions);document.body.append(dialog);
  const queue=[];let current=null;
  function next(){
    if(current||!queue.length)return;current=queue.shift();const options=current.options;
    title.textContent=options.message||'请确认';text.textContent=options.detail||'';text.classList.toggle('hidden',!options.detail);
    emblem.replaceChildren(icon(options.type==='error'?'shield':options.message?.includes('身份')?'key':'spark'));
    actions.replaceChildren();const buttons=options.buttons||(options.type==='error'?['知道了']:['取消','确定']);
    buttons.forEach((label,index)=>{const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.response=index;if(index===buttons.length-1&&index>0)button.className=options.type==='warning'?'danger':'primary';button.addEventListener('click',()=>finish(index));actions.append(button);});
    dialog.showModal();actions.querySelector('button').focus();
  }
  function finish(response){
    if(!current)return;const item=current;current=null;if(dialog.open)dialog.close();
    if(item.id)api.answerPrompt(item.id,response).catch(()=>{});else item.resolve({response});
    queueMicrotask(next);
  }
  close.addEventListener('click',()=>finish(0));dialog.addEventListener('cancel',event=>{event.preventDefault();finish(0);});dialog.addEventListener('close',()=>{if(current&&!dialog.open)finish(0);});
  request=options=>new Promise(resolve=>{queue.push({options,resolve});next();});
  api.onEvent(event=>{
    if(event.type==='app-prompt'){queue.push({id:event.id,options:event.options});next();}
    if(event.type==='app-prompt-closed'){
      const index=queue.findIndex(item=>item.id===event.id);if(index>=0)queue.splice(index,1);
      if(current?.id===event.id){current=null;dialog.close();queueMicrotask(next);}
    }
  });
  for(const modal of document.querySelectorAll('dialog')){
    const label=modal.querySelector('h2');if(label&&!modal.hasAttribute('aria-labelledby')){label.id=label.id||modal.id+'-title';modal.setAttribute('aria-labelledby',label.id);}
    for(const button of modal.querySelectorAll('.icon-button'))button.title=button.title||button.getAttribute('aria-label')||'关闭';
    modal.addEventListener('click',event=>{if(event.target!==modal)return;const r=modal.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)modal.close();});
  }
}
