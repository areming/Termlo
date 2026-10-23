// Generated locally: no remote image request or personal data upload.
export function avatar(account,size=''){
 const el=document.createElement('span');el.className='account-avatar'+(size?' avatar-'+size:'');el.setAttribute('aria-hidden','true');
 const name=account.identity?.displayName||account.name||'T',parts=name.trim().split(/\s+/),letters=parts.length>1?parts.map(p=>Array.from(p)[0]).slice(0,2).join(''):Array.from(name).slice(0,2).join('');
 el.textContent=letters.toLocaleUpperCase();let hash=0;for(const ch of account.id||name)hash=(hash*31+ch.codePointAt(0))>>>0;el.dataset.tone=String(hash%5);return el;
}
