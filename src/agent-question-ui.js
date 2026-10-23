import {icon} from './icons.js';
const el=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';if(text!==undefined)n.textContent=text;return n;};
export function questionCard({request,active,busy,drafts,onAnswer}){
 const card=el('section','agent-question'+(active?' active':''));card.dataset.requestId=request.id;
 if(!active){card.append(el('strong','','已讨论'),el('p','',request.questions.map(q=>q.question).join(' · ')));return card;}
 let draft=drafts.get(request.id);if(!draft){draft={index:0,answers:{}};drafts.set(request.id,draft);}
 const render=()=>{
  card.replaceChildren();const q=request.questions[draft.index],a=draft.answers[q.id]||={questionId:q.id,text:''};
  const top=el('div','question-heading');top.append(icon('spark'),el('strong','',q.header),el('span','',`${draft.index+1} / ${request.questions.length}`));card.append(top,el('h3','',q.question));
  const options=el('div','question-options');options.setAttribute('role','radiogroup');options.setAttribute('aria-label',q.question);
  q.options.forEach((option,index)=>{const label=el('label','question-option');const radio=el('input');radio.type='radio';radio.name='answer-'+q.id;radio.checked=a.optionIndex===index;radio.disabled=busy;
   const content=el('span');const title=el('strong','',option.label);if(q.recommendedOption===index)title.append(el('small','question-recommended','推荐'));content.append(title,el('small','',option.description));label.append(radio,content);options.append(label);
   radio.addEventListener('change',()=>{a.optionIndex=index;delete a.custom;render();});
  });
  if(q.options.length){const label=el('label','question-option custom-choice'),radio=el('input');radio.type='radio';radio.name='answer-'+q.id;radio.checked=a.custom===true;radio.disabled=busy;radio.addEventListener('change',()=>{delete a.optionIndex;a.custom=true;render();});label.append(radio,el('span','','自己填写'));options.append(label);}
  card.append(options);
  const customLabel=el('label','question-custom',q.options.length?'自己的答案 / 补充说明':'你的回答');
  const custom=el('textarea');custom.rows=2;custom.maxLength=4000;custom.placeholder=q.options.length?'也可以不选，直接写你的想法…':'填写必要信息，请勿输入密码或私钥';custom.value=a.text;custom.disabled=busy;custom.setAttribute('aria-label',customLabel.textContent);custom.addEventListener('input',()=>{a.text=custom.value;});customLabel.append(custom);card.append(customLabel);
  const foot=el('div','question-actions'),error=el('span','question-error');error.setAttribute('role','alert');
  const back=el('button','','上一题');back.type='button';back.dataset.first=String(!draft.index);back.disabled=busy||!draft.index;back.addEventListener('click',()=>{if(draft.index){draft.index--;render();}});
  const next=el('button','primary',draft.index===request.questions.length-1?'提交并继续':'下一题');next.type='button';next.disabled=busy;
  next.addEventListener('click',async()=>{
   const valid=item=>item&&(Number.isInteger(item.optionIndex)||item.text.trim());
   if(!valid(a)){error.textContent='请选择或填写回答';return;}
   if(draft.index<request.questions.length-1){draft.index++;render();return;}
   const missing=request.questions.findIndex(q=>!valid(draft.answers[q.id]));if(missing>=0){draft.index=missing;render();return;}
   next.disabled=true;try{await onAnswer(request.id,request.questions.map(q=>{const {custom,...answer}=draft.answers[q.id];return answer;}));}catch(e){error.textContent=e.message;}finally{next.disabled=false;}
  });foot.append(error,back,next);card.append(foot);
 };render();return card;
}
