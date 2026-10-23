import { icon } from './icons.js';
import { TERMINAL_THEME } from './terminal-highlights.js';
export const LIGHT_TERMINAL_THEME = {
  background:'#f8fafb',foreground:'#263541',cursor:'#127e68',cursorAccent:'#ffffff',selectionBackground:'#c2dce8',selectionForeground:'#142c3e',
  black:'#263541',red:'#b52f41',green:'#26733e',yellow:'#875c0d',blue:'#265eaa',magenta:'#824ba7',cyan:'#137a80',white:'#536371',
  brightBlack:'#647584',brightRed:'#c1263c',brightGreen:'#177d36',brightYellow:'#9b6000',brightBlue:'#2264b4',brightMagenta:'#9748ad',brightCyan:'#007a82',brightWhite:'#263541',
};
export const terminalTheme=()=>document.documentElement.dataset.theme==='light'?LIGHT_TERMINAL_THEME:TERMINAL_THEME;
export function initAppearance(state) {
  const root=document.documentElement,themeButton=document.querySelector('#theme-toggle'),sideButton=document.querySelector('#sidebar-toggle');
  const read=(key,fallback)=>{try{return localStorage.getItem(key)||fallback;}catch{return fallback;}};
  const save=(key,value)=>{try{localStorage.setItem(key,value);}catch{}};
  function theme(value){
    root.dataset.theme=value;save('termus.theme',value);
    themeButton.replaceChildren(icon(value==='dark'?'sun':'moon'));themeButton.title=value==='dark'?'切换到日间模式':'切换到夜间模式';themeButton.setAttribute('aria-label',themeButton.title);
    for(const session of state.sessions.values()){session.term.options.theme=terminalTheme();session.highlights?.configure(session.highlights.settings);}
    window.dispatchEvent(new Event('termus-theme'));
  }
  function sidebar(collapsed){root.classList.toggle('sidebar-collapsed',collapsed);save('termus.sidebar.collapsed',String(collapsed));sideButton.title=collapsed?'展开侧栏':'收起侧栏';sideButton.setAttribute('aria-label',sideButton.title);sideButton.setAttribute('aria-expanded',String(!collapsed));window.dispatchEvent(new Event('resize'));}
  for(const button of document.querySelectorAll('.nav-item')){
    const label=[...button.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('').trim();button.title=label;button.setAttribute('aria-label',label);
    for(const text of [...button.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE)){const span=document.createElement('span');span.className='nav-label';span.textContent=text.textContent;text.replaceWith(span);}
  }
  for(const id of ['terminal-copy','terminal-paste','open-sftp','reconnect','disconnect','choose-local','remote-mkdir','upload']){
    const button=document.getElementById(id);if(!button)continue;const label=button.textContent.trim();button.title=button.title||label;button.setAttribute('aria-label',label);
    for(const text of [...button.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE))text.remove();
  }
  document.querySelector('#security-open').addEventListener('click',()=>document.querySelector('#security-dialog').showModal());
  theme(read('termus.theme','dark')==='light'?'light':'dark');sidebar(read('termus.sidebar.collapsed','false')==='true');
  themeButton.addEventListener('click',()=>theme(root.dataset.theme==='dark'?'light':'dark'));
  sideButton.addEventListener('click',()=>sidebar(!root.classList.contains('sidebar-collapsed')));
}
