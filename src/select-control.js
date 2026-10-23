import {icon} from './icons.js';
// Keep native form values and change events, with an accessible themed popup.
export function initSelects(root=document){
  const cleanups=[...root.querySelectorAll('select:not(.select-source)')].map(enhance);
  cleanups.push(...[...root.querySelectorAll('input[list]')].map(editable));return ()=>cleanups.forEach(cleanup=>cleanup());
}
function editable(input){
 const list=document.getElementById(input.getAttribute('list'));if(!list)return ()=>{};
 input.removeAttribute('list');const wrap=document.createElement('span');wrap.className='editable-select';input.before(wrap);wrap.append(input);
 const trigger=document.createElement('button');trigger.type='button';trigger.className='editable-select-trigger';trigger.setAttribute('aria-label','选择'+(input.closest('label')?.childNodes[0]?.textContent||'已有项'));trigger.append(icon('chevron'));wrap.append(trigger);
 const popup=document.createElement('div');popup.className='select-menu';popup.id=(input.id||input.name)+'-suggestions';popup.setAttribute('popover','auto');popup.setAttribute('role','listbox');wrap.append(popup);
 input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls',popup.id);input.setAttribute('aria-expanded','false');
 let active=-1,items=[];const opened=()=>popup.matches(':popover-open');
 const close=()=>{if(opened())popup.hidePopover();input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');};
 const mark=()=>{[...popup.children].forEach((r,i)=>{r.classList.toggle('focused',i===active);r.setAttribute('aria-selected',String(i===active));});if(active>=0){input.setAttribute('aria-activedescendant',popup.children[active].id);popup.children[active].scrollIntoView({block:'nearest'});}};
 const choose=i=>{if(!items[i])return;input.value=items[i];close();input.focus();input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));};
 function open(all=false){items=[...new Set([...list.options].map(o=>o.value))].filter(v=>all||v.toLocaleLowerCase().includes(input.value.toLocaleLowerCase()));popup.replaceChildren();active=-1;
  for(const [i,value]of items.entries()){const row=document.createElement('div');row.className='select-option';row.id=popup.id+'-'+i;row.setAttribute('role','option');row.textContent=value;row.addEventListener('pointerdown',e=>e.preventDefault());row.addEventListener('click',()=>choose(i));popup.append(row);}
  if(!items.length){const empty=document.createElement('div');empty.className='select-option';empty.textContent='可直接输入新分组';popup.append(empty);}
  popup.showPopover();input.setAttribute('aria-expanded','true');const r=wrap.getBoundingClientRect(),height=Math.min(250,innerHeight-r.bottom-14);popup.style.width=Math.min(Math.max(r.width,200),innerWidth-24)+'px';popup.style.left=Math.max(12,Math.min(r.left,innerWidth-parseFloat(popup.style.width)-12))+'px';popup.style.top=height<100?'auto':r.bottom+5+'px';popup.style.bottom=height<100?innerHeight-r.top+5+'px':'auto';popup.style.maxHeight='250px';
 }
 trigger.addEventListener('click',()=>{if(opened())close();else{input.focus();open(true);}});
 input.addEventListener('input',()=>{if(document.activeElement===input)open();});
 input.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();if(!opened())open(true);if(items.length){active=(active+(e.key==='ArrowDown'?1:items.length-1)+items.length)%items.length;mark();}}else if(e.key==='Enter'&&opened()){e.preventDefault();e.stopPropagation();if(active>=0)choose(active);else close();}else if(e.key==='Escape'&&opened()){e.preventDefault();e.stopPropagation();close();}else if(e.key==='Tab')close();});
 popup.addEventListener('toggle',()=>input.setAttribute('aria-expanded',String(opened())));input.closest('dialog')?.addEventListener('close',close);window.addEventListener('resize',close);
 return ()=>{close();window.removeEventListener('resize',close);};
}
function enhance(select){
  const wrap=document.createElement('span');wrap.className='select-control';select.before(wrap);wrap.append(select);select.classList.add('select-source');select.tabIndex=-1;select.setAttribute('aria-hidden','true');
  const trigger=document.createElement('button');trigger.type='button';trigger.className='select-trigger';trigger.id=(select.id||select.name)+'-trigger';
  trigger.setAttribute('role','combobox');trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');
  const label=document.createElement('span');label.className='select-value';trigger.append(label,icon('chevron'));wrap.append(trigger);
  const popup=document.createElement('div');popup.className='select-menu';popup.setAttribute('popover','auto');popup.setAttribute('role','listbox');popup.id=trigger.id+'-menu';wrap.append(popup);trigger.setAttribute('aria-controls',popup.id);
  let active=-1,query='',queryAt=0;
  const isOpen=()=>popup.matches(':popover-open');
  const available=()=>[...select.options].map((o,i)=>({o,i})).filter(({o})=>!o.disabled&&!o.hidden);
  function close(){if(isOpen())popup.hidePopover();trigger.setAttribute('aria-expanded','false');trigger.removeAttribute('aria-activedescendant');}
  function position(){
    const r=trigger.getBoundingClientRect(),width=Math.min(Math.max(r.width,220),innerWidth-24);
    popup.style.width=width+'px';popup.style.left=Math.max(12,Math.min(r.left,innerWidth-width-12))+'px';
    const below=innerHeight-r.bottom-12,above=r.top-12,up=below<180&&above>below;
    popup.style.maxHeight=Math.max(48,Math.min(300,up?above:below))+'px';popup.style.top='auto';popup.style.bottom='auto';
    if(up)popup.style.bottom=(innerHeight-r.top+6)+'px';else popup.style.top=(r.bottom+6)+'px';
  }
  function highlight(){
    for(const node of popup.children)node.classList.toggle('focused',Number(node.dataset.index)===active);
    const item=popup.querySelector(`[data-index="${active}"]`);if(item){trigger.setAttribute('aria-activedescendant',item.id);if(isOpen()){const r=item.getBoundingClientRect(),p=popup.getBoundingClientRect();if(r.top<p.top)popup.scrollTop-=p.top-r.top+5;else if(r.bottom>p.bottom)popup.scrollTop+=r.bottom-p.bottom+5;}}
  }
  function choose(index){
    const option=select.options[index];if(select.disabled||!option||option.disabled)return;
    const changed=select.selectedIndex!==index;select.selectedIndex=index;close();trigger.focus();
    if(changed){select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));}sync();
  }
  function sync(){
    label.textContent=select.selectedOptions[0]?.textContent||'请选择';trigger.title=label.textContent;trigger.disabled=select.disabled;
    const name=select.getAttribute('aria-label')||select.closest('label')?.childNodes[0]?.textContent?.trim()||'选择';trigger.setAttribute('aria-label',name);popup.setAttribute('aria-label',name);
    if(trigger.disabled)close();
    if(isOpen())render();
  }
  function render(){
    popup.replaceChildren();for(const {o,i} of available()){
      const row=document.createElement('div');row.className='select-option';row.id=popup.id+'-'+i;row.dataset.index=i;row.setAttribute('role','option');row.setAttribute('aria-selected',String(i===select.selectedIndex));
      const text=document.createElement('span');text.textContent=o.textContent;row.title=o.textContent;row.append(text,icon(i===select.selectedIndex?'check':'chevron'));
      row.addEventListener('pointerdown',event=>event.preventDefault());row.addEventListener('click',()=>choose(i));popup.append(row);
    }
    highlight();position();
  }
  function open(){if(select.disabled)return;active=select.selectedIndex;render();popup.showPopover();trigger.setAttribute('aria-expanded','true');position();highlight();}
  trigger.addEventListener('click',()=>isOpen()?close():open());
  trigger.addEventListener('keydown',event=>{
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      event.preventDefault();if(!isOpen()){open();return;}
      const entries=available(),index=entries.findIndex(x=>x.i===active);if(!entries.length)return;
      active=entries[event.key==='Home'?0:event.key==='End'?entries.length-1:Math.max(0,Math.min(entries.length-1,index+(event.key==='ArrowDown'?1:-1)))].i;highlight();
    }else if(event.key==='Enter'||event.key===' '){event.preventDefault();if(isOpen())choose(active);else open();}
    else if(event.key==='Escape'&&isOpen()){event.preventDefault();event.stopPropagation();close();}
    else if(event.key==='Tab')close();
    else if(event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
      query=Date.now()-queryAt>700?event.key:query+event.key;queryAt=Date.now();const found=available().find(({o})=>o.textContent.toLocaleLowerCase().startsWith(query.toLocaleLowerCase()));
      if(found){event.preventDefault();if(!isOpen())open();active=found.i;highlight();}
    }
  });
  popup.addEventListener('toggle',()=>{trigger.setAttribute('aria-expanded',String(isOpen()));if(!isOpen())trigger.removeAttribute('aria-activedescendant');});
  // Programmatic updates (host editor, task mode, selected server) must also sync.
  for(const property of ['value','selectedIndex']){
    const descriptor=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,property);
    Object.defineProperty(select,property,{configurable:true,get(){return descriptor.get.call(this);},set(value){descriptor.set.call(this,value);sync();}});
  }
  const observer=new MutationObserver(sync);observer.observe(select,{subtree:true,childList:true,characterData:true,attributes:true});
  select.addEventListener('change',sync);select.form?.addEventListener('reset',()=>setTimeout(sync,0));select.closest('dialog')?.addEventListener('close',close);
  const scroll=event=>{if(isOpen()&&!popup.contains(event.target))position();};window.addEventListener('resize',close);document.addEventListener('scroll',scroll,true);
  sync();
  return ()=>{close();observer.disconnect();window.removeEventListener('resize',close);document.removeEventListener('scroll',scroll,true);};
}
