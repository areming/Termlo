import { icon } from './icons.js';
import { confirmAction } from './app-dialogs.js';
import { executionConsole } from './execution-console.js';
import { questionCard } from './agent-question-ui.js';
import { specificationText } from './host-specs-ui.js';
import { hostOSIcon } from './host-os-ui.js';
const names = { inspect_project:'分析项目', list_resources:'查看授权资源', inspect_host:'检查服务器环境', exec_remote:'执行远程命令', read_job:'等待操作结果', cancel_job:'停止远程操作', read_file:'读取文件', write_file:'写入文件', search_web:'搜索资料', fetch_url:'阅读网页', checkpoint:'更新任务计划', finish_task:'整理任务结果' };
const statuses = { running:'进行中', paused:'已暂停', completed:'已完成', needs_input:'需要补充', failed:'连接或服务异常',plan_ready:'方案待确认',awaiting_reply:'等待讨论' };
const modes={plan:'Plan · 先规划',autonomous:'自主执行',inspect:'只读巡检'};
names.propose_plan='整理方案';
names.protection_status='查看部署保护';names.prepare_protection='准备任务恢复点';names.request_protection='配置部署保护';
names.ask_user='询问你的选择';statuses.awaiting_input='等待你的选择';
names.upload_attachment='上传附件';
names.apply_followup='处理补充要求';names.check_runtime='核实服务或进程';names.review_operation='核对中断操作';
names.begin_change='登记变更目标';names.read_changes='查看变更账本';names.request_recovery='提出恢复方案';
names.read_host_ledger='查看主机版本';
names.verify_change='核验受控变更';names.compensate_controlled='清理受控改动';
const node = (tag,cls,text) => { const el=document.createElement(tag); if(cls) el.className=cls; if(text!==undefined) el.textContent=text; return el; };
const stamp = date => new Date(date).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
function richText(text) {
  const fragment=document.createDocumentFragment();
  const blocks=String(text||'').split(/```[^\n]*\n([\s\S]*?)```/g);
  blocks.forEach((block,index)=>{
    if(index%2) { fragment.append(node('pre','agent-code',block.trimEnd())); return; }
    for(const line of block.split('\n')) {
      const p=node('div',/^#{1,3} /.test(line)?'message-heading':'message-line');
      line.replace(/^#{1,3} /,'').split(/\*\*([^*]+)\*\*/g).forEach((part,i)=>p.append(node(i%2?'strong':'span','',part)));
      fragment.append(p);
    }
  });
  return fragment;
}
export function initAssistant({api,state,showError,toast,askCredential,clipboardUI}) {
  const $=selector=>document.querySelector(selector);
  const attachmentMenu=node('div','attachment-menu select-menu');attachmentMenu.id='agent-attachment-menu';attachmentMenu.setAttribute('popover','auto');attachmentMenu.setAttribute('role','menu');$('.agent-compose-area').append(attachmentMenu);
  const fileButton=node('button','','添加文件');fileButton.id='agent-attach-file';fileButton.type='button';fileButton.prepend(icon('paperclip'));fileButton.setAttribute('role','menuitem');fileButton.title='原样上传，内容不提供给模型';
  const projectButton=node('button','','分析项目 ZIP');projectButton.id='agent-attach-project';projectButton.type='button';projectButton.prepend(icon('folder'));projectButton.setAttribute('role','menuitem');projectButton.title='模型可读取目录、依赖与部署说明';attachmentMenu.append(fileButton,projectButton);
  let info=null, selected=null, task=null, selectedHosts=new Set(), busy=false, loading=0, refreshTimer;
  const openDetails=new Set();
  const drafts=new Map();
  const answerDrafts=new Map();
  const progress=node('div','agent-progress hidden');progress.id='agent-progress';$('#agent-feed').before(progress);
  const fileRecovery=node('div','task-protection hidden');fileRecovery.id='task-file-recovery';$('#agent-feed').before(fileRecovery);
  const planBar=node('div','agent-plan-bar hidden');planBar.id='agent-plan-bar';
  const planLabel=node('div','plan-bar-label'),planTitle=node('strong'),planHint=node('small');planLabel.append(planTitle,planHint);
  const planView=node('button','icon-button');planView.type='button';planView.title='查看最新方案';planView.setAttribute('aria-label','查看最新方案');planView.append(icon('search'));
  const planPrimary=node('button','primary');planPrimary.type='button';planPrimary.id='agent-plan-primary';
  planBar.append(planLabel,planView,planPrimary);$('.agent-compose-area').before(planBar);
  const draftFiles=()=>drafts.get(selected||'new')||[];
  const pruneHosts=()=>{const known=new Set(state.hosts.map(h=>h.id));selectedHosts=new Set([...selectedHosts].filter(id=>known.has(id)));};
  const sizeLabel=bytes=>bytes<1024*1024?`${Math.ceil(bytes/1024)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;
  function attachmentCard(file,remove){
    const access=file.access==='project-read'?'项目分析':'仅传输';const card=node('div','attachment-card');card.title=`${file.name}\n${sizeLabel(file.size)} · ${access==='项目分析'?'目录与部署说明会提供给模型':'仅传输，内容不自动发送给模型'}`;
    card.append(icon(file.access==='project-read'?'folder':'file'));const label=node('div','attachment-label');label.append(node('strong','',file.name),node('small','',`${sizeLabel(file.size)} · ${access}`));card.append(label);
    if(remove){const button=node('button','icon-button');button.title='移除附件';button.setAttribute('aria-label','移除 '+file.name);button.append(icon('close'));button.disabled=busy;button.addEventListener('click',()=>run(remove));card.append(button);}else card.append(icon('lock'));
    return card;
  }
  function renderAttachments(){
    const list=$('#agent-attachments');list.replaceChildren();list.classList.toggle('hidden',!draftFiles().length);
    for(const file of draftFiles())list.append(attachmentCard(file,async()=>{if(busy)return;await api.agentDropAttachment(file.id);drafts.set(selected||'new',draftFiles().filter(a=>a.id!==file.id));renderAttachments();context();}));
    $('#agent-attach').disabled=busy||!!info?.activeId;
    projectButton.disabled=busy||!!info?.activeId;
    fileButton.disabled=busy||!!info?.activeId;
  }
  const run=action=>Promise.resolve().then(action).catch(showError);
  const on=(id,action)=>$(id).addEventListener('click',()=>run(action));
  const trackingStrip=node('div','agent-tracking-strip');trackingStrip.id='agent-tracking-strip';
  const trackingMark=node('span','agent-tracking-mark');trackingMark.append(icon('book'));
  const trackingCopy=node('div','agent-tracking-copy'),trackingTitle=node('strong'),trackingHint=node('small');trackingCopy.append(trackingTitle,trackingHint);
  const trackingNow=node('button','agent-tracking-now');trackingNow.type='button';trackingNow.append(icon('refresh'),node('span','','立即核对'));
  trackingStrip.append(trackingMark,trackingCopy,trackingNow);$('.agent-composer').before(trackingStrip);
  const consoleUI=executionConsole({api,toast,showError,credentials,refresh,hosts:()=>state.hosts,trackingBadge,clipboardUI});
  const scopeChanged=()=>task?.mode==='plan'&&(task.hostIds.length!==selectedHosts.size||task.hostIds.some(id=>!selectedHosts.has(id)));
  const planDirty=()=>!!$('#agent-prompt').value.trim()||!!draftFiles().length||scopeChanged();
  const pendingQuestion=()=>task?.interaction?.status==='pending';
  const trackingLabels={tracked:'已核对',checking:'核对中',changed:'状态有变化',identity_changed:'连接信息已变',unavailable:'无法核对',stale:'待重新核对',untracked:'尚未核对'};
  function trackingBadge(hostId){
    const record=info?.hostTracking?.find(row=>row.hostId===hostId);
    const status=record?.status||'untracked';
    const label=trackingLabels[status];
    const badge=node('span','host-tracking '+status);badge.title=label+(record?.checkedAt?'\n核对时间：'+new Date(record.checkedAt).toLocaleString('zh-CN'):'')+(record?.revision?'\n记录版本：'+record.revision:'')+'\n仅是轻量状态记录，不是整机快照或自动回滚';
    badge.setAttribute('role','img');badge.setAttribute('aria-label',label);badge.append(icon(status==='tracked'?'book':status==='checking'?'refresh':status==='changed'||status==='identity_changed'?'highlight':'book'));return badge;
  }
  const scopedHostIds=()=>task?.mode==='plan'?[...selectedHosts]:task?.hostIds||[...selectedHosts];
  function renderTracking(){
    const ids=scopedHostIds(),records=ids.map(id=>info?.hostTracking?.find(row=>row.hostId===id)),count=status=>records.filter(row=>(row?.status||'untracked')===status).length;
    const checking=count('checking'),changed=count('changed')+count('identity_changed'),unavailable=count('unavailable'),tracked=count('tracked'),stale=count('stale'),unknown=count('untracked');
    trackingStrip.dataset.status=checking?'checking':changed?'changed':unavailable?'unavailable':tracked===ids.length&&ids.length?'tracked':'idle';
    trackingTitle.textContent=!ids.length?'主机状态 · 未选择':checking?`正在核对 ${checking}/${ids.length} 台`:changed?`${changed} 台状态有变化`:unavailable?`${unavailable} 台无法核对`:tracked===ids.length?`${tracked} 台主机已核对`:stale?`${stale} 台待重新核对`:`${unknown} 台尚未核对`;
    trackingHint.textContent=!ids.length?'先选择主机，再立即核对':checking?'只读检查中；结束后保存记录':changed||unavailable?'历史记录仅供参考，请核实机器现场':info?.activeId?'每次模型调用前自动核对':'运行助手前会自动核对，也可现在手动核对';
    trackingNow.disabled=busy||!!info?.activeId||!!info?.hostCheckActive||!ids.length;
    trackingNow.title=info?.activeId?'任务运行时会在每次模型调用前自动核对':'不调用模型，只读核对选中主机；每台限时，结束后停止';
  }
  trackingNow.addEventListener('click',()=>run(async()=>{
    const ids=scopedHostIds();if(!ids.length||busy||info?.activeId)return;
    busy=true;renderFeed();
    try{const auth=await credentials(ids);if(auth===null)return;const results=await api.agentCheckHosts({hostIds:ids,credentials:auth});await refresh();const failed=results.filter(row=>row.status==='unavailable').length;toast(failed?`核对结束：${failed} 台无法读取，详情见主机状态`:`已核对 ${results.length} 台主机`);}
    finally{busy=false;renderFeed();}
  }));
  const canExecutePlan=()=>task?.status==='plan_ready'&&!!task.proposal&&!task.proposal.questions.length&&!planDirty()&&!pendingQuestion();
  function renderPlanBar(){
    planBar.classList.toggle('hidden',task?.mode!=='plan'&&!pendingQuestion());if(task?.mode!=='plan'&&!pendingQuestion())return;
    const proposal=task.proposal,running=busy||task.status==='running';
    if(pendingQuestion()){planTitle.textContent='需要你确认';planHint.textContent=`${task.interaction.questions.length} 个问题 · 提交后继续`;planPrimary.textContent='回答问题';planPrimary.disabled=busy||!!info?.activeId;planView.disabled=true;return;}
    planTitle.textContent=proposal?`v${proposal.revision} · ${proposal.title}`:'方案待整理';planTitle.title=planTitle.textContent;
    planHint.textContent=running?'正在规划，尚未执行变更':planDirty()?'补充内容将纳入新方案':proposal?.questions.length?`${proposal.questions.length} 个问题待补充`:canExecutePlan()?'方案已就绪，确认后开始执行':'根据当前对话生成可确认的方案';
    planPrimary.textContent=running?'规划中…':canExecutePlan()?'按方案执行':proposal?'更新方案':'整理方案';
    planPrimary.disabled=running||!!info?.activeId;planView.disabled=!proposal;
  }
  planView.addEventListener('click',()=>{const card=[...document.querySelectorAll('.agent-proposal')].find(el=>Number(el.dataset.revision)===task?.proposal?.revision);card?.scrollIntoView({block:'start'});});
  planPrimary.addEventListener('click',()=>run(()=>pendingQuestion()?document.querySelector('.agent-question.active')?.scrollIntoView({block:'center'}):canExecutePlan()?executePlan(task.proposal.revision):send({preparePlan:true})));
  function context() {
    const ids=scopedHostIds();
    $('#agent-hosts-label').textContent=ids.length?`${ids.length} 台主机`:'选择主机';
    $('#agent-context-hosts').replaceChildren();
    for(const id of ids) {
      const host=state.hosts.find(h=>h.id===id); const item=node('div','context-host');
      item.append(icon('server')); const content=node('div'); content.append(node('strong','',host?.name||'主机已删除'),node('small','',host?`${host.username}@${host.address}`:id)); item.append(content,trackingBadge(id)); $('#agent-context-hosts').append(item);
    }
    if(!ids.length) $('#agent-context-hosts').append(node('p','inspector-empty','选择机器作为任务上下文，也可以先讨论方案。'));
    $('#agent-plan').replaceChildren();
    for(const step of task?.plan || []) { const row=node('div','plan-step '+step.status); row.append(node('span','plan-dot',step.status==='done'?'✓':step.status==='blocked'?'!':''),node('span','',step.title)); $('#agent-plan').append(row); }
    if(!task?.plan?.length) $('#agent-plan').append(node('p','inspector-empty','开始后，助手会根据实际情况安排和调整计划。'));
    $('#agent-metrics').textContent=task?`${task.rounds} 次模型调用 · ${(task.tokens||0).toLocaleString()} tokens\n${modes[task.mode]} · ${stamp(task.updatedAt)} 更新`:'';
    renderTracking();
    $('#agent-hosts-open').disabled=busy||!!task&&(task.mode!=='plan'||task.status==='running'); $('#agent-mode').disabled=!!task||busy; if(task) $('#agent-mode').value=task.mode;
    for(const button of document.querySelectorAll('.execute-plan'))button.disabled=busy||!!info?.activeId||!canExecutePlan();
    for(const control of document.querySelectorAll('.agent-question.active input,.agent-question.active textarea,.agent-question.active button'))control.disabled=busy||!!info?.activeId||control.dataset.first==='true';
    renderPlanBar();
  }
  function renderTasks() {
    const list=$('#agent-tasks'); list.replaceChildren();
    if(!info?.tasks.length) list.append(node('p','task-list-empty','任务记录会保存在这里。'));
    for(const item of info?.tasks || []) {
      const row=node('button','task-item'+(item.id===selected?' selected':'')); const top=node('div','task-item-top');
      top.append(node('span','task-state-dot '+item.status),node('strong','',item.title));
      row.append(top,node('small','',`${statuses[item.status]||item.status} · ${stamp(item.updatedAt)}`)); row.addEventListener('click',()=>run(async()=>{if(busy)return;selected=item.id; await refresh();})); list.append(row);
    }
  }
  function welcome() {
    const el=node('div','agent-welcome'); const emblem=node('div','agent-emblem');emblem.append(icon('spark'));
    el.append(emblem,node('h1','','先聊清楚，再动手'),node('p','','一起定方案，交给助手执行。'));
    const suggestions=node('div','agent-suggestions');
    for(const [title,detail,prompt,ico] of [
      ['了解环境','盘点系统、资源与运行服务','检查选中机器的系统、资源和运行服务，形成带来源的环境报告，按需现场核实。','server'],
      ['规划并部署','让助手自主检查、准备与验证','在选中机器部署 Kubernetes 集群。先检查环境，根据实际情况规划和完成部署，最后验证节点、网络与测试工作负载。','route'],
      ['查找问题','根据现场证据逐步定位','检查选中机器是否存在服务异常、资源瓶颈或网络问题，根据证据定位原因并给出结论。','search'],
    ]) { const card=node('button','suggestion');card.append(icon(ico));const content=node('div');content.append(node('strong','',title),node('small','',detail));card.append(content,icon('arrow'));card.addEventListener('click',()=>{$('#agent-prompt').value=prompt;$('#agent-prompt').focus();});suggestions.append(card); }
    const deploy=node('button','suggestion');deploy.type='button';deploy.append(icon('server'));const deployText=node('div');deployText.append(node('strong','','部署账户服务'),node('small','','固定脚本检查环境并完成安装，不消耗模型调用'));deploy.append(deployText,icon('arrow'));deploy.addEventListener('click',openDeployDialog);suggestions.append(deploy);
    el.append(suggestions); if(!info?.settings.baseUrl) { const setup=node('button','agent-setup-link','先连接一个支持工具调用的模型'); setup.addEventListener('click',settingsDialog); el.append(setup); } return el;
  }
  function fold(parent,title,content,id) {
    const details=node('details','message-details');details.open=openDetails.has(id);details.addEventListener('toggle',()=>{if(details.open)openDetails.add(id);else openDetails.delete(id);});details.append(node('summary','',title));const body=node('div','message-content');body.append(richText(content));details.append(body);parent.append(details);
  }
  function resultCard(event) {
    const lines=event.content.split('\n').map(s=>s.replace(/^[#*\s-]+/,'')).filter(Boolean);
    const report=event.report||{headline:lines[0]?.slice(0,120),highlights:lines.slice(1,4).map(s=>s.slice(0,220)),checks:[]};
    const item=node('article','agent-message result');item.append(node('div','result-eyebrow',report.outcome==='needs_input'?'需要你补充':'任务结果'),node('h3','result-headline',report.headline));
    const badges=node('div','result-badges');badges.append(node('span','',`${task.hostIds.length} 台主机`),node('span','',`${event.evidenceIds?.length||0} 项引用证据`));item.append(badges);
    if(report.highlights?.length){const list=node('ul','result-highlights');for(const text of report.highlights.slice(0,3))list.append(node('li','',text));item.append(list);}
    if(report.checks?.length){const list=node('div','result-checks');for(const check of report.checks){const row=node('div','result-check '+check.status);row.append(node('span','',({passed:'✓',failed:'!',unknown:'○'})[check.status]),node('span','',check.label),node('small','',({passed:'通过',failed:'未通过',unknown:'未验证'})[check.status]));row.title=[state.hosts.find(h=>h.id===check.hostId)?.name,check.method,check.expected?'预期：'+check.expected:'',check.observedAt?'采集：'+new Date(check.observedAt).toLocaleString():'',...(check.evidenceIds||[])].filter(Boolean).join('\n');list.append(row);}item.append(list);}
    if(report.artifacts?.length){const list=node('div','result-artifacts');for(const artifact of report.artifacts){const row=node('button','result-artifact');row.type='button';row.title='复制 '+artifact.label;row.append(icon('copy'),node('strong','',artifact.label),node('code','',artifact.value));row.addEventListener('click',()=>run(async()=>{await api.writeClipboard(artifact.value);toast('已复制');}));list.append(row);}item.append(list);}
    fold(item,'展开完整报告与证据',event.content+'\n\n证据：'+(event.evidenceIds||[]).join('、'),event.id+'-report');return item;
  }
  function proposalCard(event) {
    const plan=event.proposal, current=task.mode==='plan'&&task.proposal?.revision===plan.revision;
    const item=node('article','agent-proposal');item.dataset.revision=plan.revision;
    const top=node('div','proposal-top');top.append(node('span','',`PLAN / v${plan.revision}`),node('span','',current?(plan.questions.length?'待完善方案':'最终方案'):task.approvedProposal?.revision===plan.revision?'已确认方案':'历史方案'));item.append(top,node('h3','',plan.title),node('p','',plan.summary));
    const steps=node('ol','proposal-steps');for(const step of plan.steps)steps.append(node('li','',step));item.append(steps);
    if(plan.checks.length){const checks=node('div','proposal-checks');checks.append(node('strong','','验收'));for(const text of plan.checks)checks.append(node('span','',text));item.append(checks);}
    if(plan.questions.length){const questions=node('div','proposal-questions');questions.append(node('strong','','先明确这些问题'));for(const text of plan.questions)questions.append(node('p','',text));item.append(questions);}
    if(plan.risks.length)fold(item,'影响与约束（'+plan.risks.length+'）',plan.risks.join('\n'),event.id+'-risks');
    if(current){const actions=node('div','proposal-actions');const discuss=node('button','','继续讨论');discuss.addEventListener('click',()=>{$('#agent-prompt').focus();});const execute=node('button','primary execute-plan','按此方案执行');execute.addEventListener('click',()=>run(()=>executePlan(plan.revision)));actions.append(discuss,execute);item.append(actions,node('small','proposal-help',plan.questions.length?'补充答案后，助手会更新方案。':'执行后，助手会自主推进并验证结果。'));}
    return item;
  }
  function recoveryCard(event){
    const request=event.request,active=task.recoveryRequest?.id===request.id&&task.recoveryRequest.status==='pending';
    const item=node('article','agent-proposal');
    item.append(node('div','proposal-top','恢复方案'),node('h3','','撤销本任务的受控改动'),node('p','',request.reason),node('p','',`${request.count} 项文件或附件暂存 · ${request.impact}`),node('small','proposal-help','Shell、软件安装和云资源不在这次撤销范围。历史账本供参考，执行前会核对目标内容。'));
    if(active){const actions=node('div','proposal-actions');
      const undo=node('button','primary','恢复并检查');undo.disabled=busy||!!info?.activeId;undo.addEventListener('click',()=>run(async()=>{if(!await confirmAction('恢复受控改动？','请先关闭终端和文件连接，确认后台操作已经停止。目标文件发生变化时将停止覆盖，并保留待处理项。','恢复并检查'))return;const rows=[...(task.fileChanges||[]),...(task.stagingChanges||[])].filter(r=>r.state!=='cleaned');const auth=await credentials([...new Set(rows.map(r=>r.hostId))]);if(auth===null)return;await api.agentApplyRecovery({id:task.id,requestId:request.id,credentials:auth,confirmed:true});await refresh();}));
      const inspect=node('button','','继续排查');inspect.disabled=busy||!!info?.activeId;inspect.addEventListener('click',()=>run(async()=>{const auth=await credentials([...task.hostIds]);if(auth===null)return;await api.agentResume({id:task.id,message:'继续排查失败原因，先核实当前现场，不要凭历史账本推断成功。',credentials:auth,attachmentIds:[]});await refresh();}));
      const keep=node('button','','保持现状');keep.disabled=busy||!!info?.activeId;keep.addEventListener('click',()=>run(async()=>{await api.agentDismissRecovery({id:task.id,requestId:request.id});await refresh();}));actions.append(undo,inspect,keep);item.append(actions);}
    else item.append(node('small','proposal-help','此方案已处理或失效'));return item;
  }
  function renderFeed() {
    fileRecovery.replaceChildren();
    const fileRecords=(task?.fileChanges||[]).filter(r=>r.state!=='cleaned'),stagingRecords=(task?.stagingChanges||[]).filter(r=>r.state!=='cleaned');
    const changeRows=task?.changeLedger?.changes||[],openRows=changeRows.filter(r=>['unknown','residual'].includes(r.state));
    fileRecovery.classList.toggle('hidden',!task||!changeRows.length&&!fileRecords.length&&!stagingRecords.length);
    if(task&&(changeRows.length||fileRecords.length||stagingRecords.length)){
      const label=node('div');label.append(node('strong','',`本次变更 · ${changeRows.length} 项 · ${openRows.length} 项待核实`),node('small','','历史账本仅供参考，继续操作前核验现场。Shell 和软件安装不保证可撤销。'));fileRecovery.append(icon('file'),label);
      if(task.handoff?.pendingHostIds?.length)fileRecovery.append(node('small','',`接手检查：${task.handoff.pendingHostIds.length} 台主机待核验`));
      const details=node('details','message-details');details.append(node('summary','','查看变更账本'));const list=node('div','message-content');for(const c of changeRows.slice(-30)){const host=state.hosts.find(h=>h.id===c.hostId);list.append(node('div','',`${host?.name||c.hostId} · ${c.kind} · ${c.resource||''} · ${c.state}`));}if(changeRows.length>30)list.append(node('small','',`更早 ${changeRows.length-30} 项保留在任务记录中`));details.append(list);fileRecovery.append(details);
      if((fileRecords.length||stagingRecords.length)&&task.recoveryRequest?.status!=='pending')for(const [action,text]of [['undo','撤销…'],['clean','清理材料']]){
        const b=node('button','',text);b.type='button';b.disabled=busy||!!info?.activeId;
        b.addEventListener('click',()=>run(async()=>{
          if(!await confirmAction(action==='undo'?'撤销本任务的文件修改？':'清理文件恢复材料？',action==='undo'?'请先关闭终端和文件连接，并核实远端后台操作已经停止。修改过的文件会恢复；被其他操作再次改动的文件会拒绝覆盖。':'仅删除本任务集中保存的原文件材料，清理后不能再撤销。',action==='undo'?'撤销':'清理'))return;
          const auth=await credentials([...new Set([...fileRecords,...stagingRecords].map(r=>r.hostId))]);if(auth===null)return;
          await api.agentRecoverFiles({id:task.id,action,confirmed:true,credentials:auth});await refresh();
        }));fileRecovery.append(b);
      }
    }
    const feed=$('#agent-feed'), nearBottom=feed.scrollHeight-feed.scrollTop-feed.clientHeight<80, scroll=feed.scrollTop;
    const feedKey=JSON.stringify([task?.id,task?.feedRevision,task?.status,busy,info?.activeId,info?.settings.baseUrl,info?.settings.model]);
    if(feed.dataset.revision!==feedKey){
    feed.dataset.revision=feedKey;
    feed.replaceChildren();
    if(!task) feed.append(welcome());
    else for(const event of task.events) {
      if(event.type==='result') {feed.append(resultCard(event));}
      else if(event.type==='question'){feed.append(questionCard({request:event.request,active:pendingQuestion()&&task.interaction.id===event.request.id,busy:busy||!!info?.activeId,drafts:answerDrafts,onAnswer:answerQuestion}));}
      else if(event.type==='proposal') {feed.append(proposalCard(event));}
      else if(event.type==='recovery') {feed.append(recoveryCard(event));}
      else if(event.type==='tool') {
        const details=node('details','agent-tool '+event.status); details.open=openDetails.has(event.id);details.addEventListener('toggle',()=>{if(details.open)openDetails.add(event.id);else openDetails.delete(event.id);});
        const summary=node('summary');summary.append(node('span','tool-state',event.status==='running'?'◌':event.status==='completed'?'✓':'!'),node('span','tool-name',names[event.name]||event.name),node('small','',stamp(event.at)),icon('chevron'));details.append(summary);
        const host=state.hosts.find(h=>h.id===event.args?.hostId);if(host)details.append(node('div','tool-host',host.name+' · '+host.address));
        if(host) summary.querySelector('.tool-name').textContent += ' · '+host.name;
        if(event.name==='upload_attachment'){
          const file=task.attachments?.find(a=>a.id===event.args?.attachmentId);
          if(file)summary.querySelector('.tool-name').textContent+=' · '+file.name;
          if(event.status==='running')summary.querySelector('.tool-name').textContent+=` · ${event.progress||0}%`;
          if(event.result?.verified)summary.querySelector('.tool-name').textContent+=' · 已校验';
        }
        if(event.args?.command)details.append(node('pre','agent-code',event.args.command));
        else if(event.args && Object.keys(event.args).length)details.append(node('pre','agent-code tool-args',JSON.stringify(event.args,null,2)));
        if(event.result) { const output=event.result.stdout!==undefined ? [event.result.status+' · exit '+(event.result.exitCode??'—'),event.result.stdout,event.result.stderr,event.result.error].filter(Boolean).join('\n') : JSON.stringify(event.result,null,2);details.append(node('pre','tool-output',output)); }
        details.append(node('small','evidence-id','证据 '+event.id));feed.append(details);
      } else {
        const item=node('article','agent-message '+event.type);const meta=node('div','message-meta');meta.append(node('strong','',({user:'你',answer:'你的选择',assistant:'Termlo',notice:'任务状态',approval:'开始执行'})[event.type]||'Termlo'),node('time','',stamp(event.at)));item.append(meta);const content=node('div','message-content');
        const long=event.type==='assistant'&&(event.content.length>360||event.content.split('\n').length>8);
        content.append(richText(long?event.content.slice(0,240)+'…':event.content));item.append(content);if(long)fold(item,'展开说明',event.content,event.id+'-text');
        if(event.attachments?.length){const files=node('div','message-attachments');for(const file of event.attachments)files.append(attachmentCard(file));item.append(files);}
        if(event.followupId){const input=task.followups?.find(x=>x.id===event.followupId);if(input){const receipt=node('div','followup-receipt '+input.status,({queued:'已收到 · 等待处理',delivered:'已送达 · 等待采用',applied:'已采用',needs_input:'需要澄清'})[input.status]);if(input.note)receipt.append(node('span','',input.note));item.append(receipt);}}
        feed.append(item);
      }
    }
    // Keep the conversation readable; terminal output remains visible in the execution pane.
    const items=[...feed.children];let batch=[];
    const groupTools=()=>{
      if(batch.length>1){const key='group-'+batch[0].querySelector('.evidence-id').textContent;const group=node('details','tool-group');group.open=openDetails.has(key)||batch.some(el=>el.classList.contains('running'));
        group.addEventListener('toggle',()=>{if(group.open)openDetails.add(key);else openDetails.delete(key);});
        const failures=batch.filter(el=>el.matches('.failed,.timeout,.interrupted')).length;
        group.append(node('summary','',`执行记录 · ${batch.length} 项${failures?' · '+failures+' 次异常':''}`));batch[0].before(group);for(const el of batch)group.append(el);
      }batch=[];
    };
    for(const item of items){if(item.classList.contains('agent-tool'))batch.push(item);else groupTools();}groupTools();
    const finalRevision=task?.approvedProposal?.revision||(task?.status==='plan_ready'&&!task.proposal?.questions.length?task.proposal?.revision:null);
    const finalCard=[...feed.children].find(el=>el.classList.contains('agent-proposal')&&Number(el.dataset.revision)===finalRevision);
    if(finalCard){const previous=[];for(const child of [...feed.children]){if(child===finalCard)break;previous.push(child);}if(previous.length){const key=task.id+'-discussion-'+finalRevision,discussion=node('details','plan-discussion');discussion.open=openDetails.has(key);discussion.addEventListener('toggle',()=>{if(discussion.open)openDetails.add(key);else openDetails.delete(key);});discussion.append(node('summary','',`方案讨论 · ${previous.length} 条记录`));feed.insertBefore(discussion,previous[0]);for(const child of previous)discussion.append(child);}}
    if(task?.status==='running') { const thinking=node('div','agent-thinking');thinking.append(node('span','thinking-dot'),node('span','','助手正在推进任务…'));feed.append(thinking); }
    if(nearBottom) feed.scrollTop=feed.scrollHeight; else feed.scrollTop=scroll;
    if(pendingQuestion()&&nearBottom)feed.querySelector('.agent-question.active')?.scrollIntoView({block:'start'});
    }
    progress.replaceChildren();progress.classList.toggle('hidden',!task||!['running','paused','failed','needs_input'].includes(task.status));
    if(task){const unknown=(task.operations||[]).filter(o=>['unknown','blocked'].includes(o.state));const live=[...task.events].reverse().find(e=>e.type==='tool'&&e.status==='running');const latest=[...task.events].reverse().find(e=>e.type==='tool'&&e.status==='completed');
      const title=unknown.length?`${unknown.length} 项操作待核实`:live?(names[live.name]||live.name):task.status==='running'?'正在评估下一步':'进度已保存';
      progress.append(node('strong','',title));if(live?.args?.hostId)progress.append(node('span','',state.hosts.find(h=>h.id===live.args.hostId)?.name||''));
      if(unknown.length){const details=node('details');details.append(node('summary','','查看待核实操作'));for(const op of unknown)details.append(node('div','',`${state.hosts.find(h=>h.id===op.hostId)?.name||'主机'} · ${names[op.name]||op.name} · ${op.command||op.path||'结果未知'}`));progress.append(details);}else if(latest)progress.append(node('small','',`最近：${names[latest.name]||latest.name} · 已返回结果`));
    }
    const next=task?.plan?.find(s=>s.status==='pending');if(next&&!progress.classList.contains('hidden'))progress.append(node('small','','接下来：'+next.title));
    $('#agent-title').textContent=task?.title || '你的服务器工作伙伴';
    $('#agent-status').textContent=task?(task.mode==='plan'&&task.status==='running'?'规划中':statuses[task.status]):'准备就绪';$('#agent-status').className='agent-status '+(task?.status||'');
    $('#agent-export').classList.toggle('hidden',!task);
    $('#agent-delete').classList.toggle('hidden',!task || task.status==='running');
    const running=task?.status==='running';
    $('#agent-stop').classList.toggle('hidden',!running);$('#agent-send').classList.remove('hidden');
    const planning=(task?.mode||$('#agent-mode').value)==='plan';
    $('#agent-send-label').textContent=running?'发送补充':planning?(task?'发送讨论':'开始规划'):(task?'继续任务':'开始任务');$('#agent-send').disabled=busy;
    $('#agent-send').title=$('#agent-send-label').textContent;$('#agent-send').setAttribute('aria-label',$('#agent-send-label').textContent);
    $('#agent-prompt').disabled=busy;$('#agent-prompt').placeholder=running?'随时补充要求；已发出的操作不会自动撤销…':planning?'描述需求、补充约束或修改方案；此阶段不执行变更…':task?'补充目标或信息，继续当前任务…':'描述目标，例如：检查这几台服务器，为部署集群评估环境…';
    $('#agent-notice').classList.toggle('hidden',!task?.notice);$('#agent-notice').textContent=task?.notice||'';
    renderAttachments();context();
  }
  async function refresh() {
    const request=++loading;const next=await api.agentState();const detail=selected?await api.agentTask(selected):null;
    if(request!==loading)return;if(detail&&detail.id!==task?.id)selectedHosts=new Set(detail.hostIds);pruneHosts();info=next;task=detail;
    $('#agent-nav-status').classList.toggle('hidden',!info.activeId);
    $('#agent-model-label').textContent=info.settings.model || '先配置模型接口';
    renderTasks();renderFeed();consoleUI.setTask(task);window.dispatchEvent(new CustomEvent('termus-agent-selection',{detail:{taskId:task?.id||null,hostIds:task?.hostIds||[]}}));
  }
  function settingsDialog() {
    const form=$('#agent-settings-form');form.reset();for(const key of ['baseUrl','model','maxRounds'])form.elements[key].value=info?.settings[key] || (key==='maxRounds'?80:'');
    $('#agent-key').placeholder=info?.settings.needsApiKey?'此设备尚无 API 密钥，请重新填写':info?.settings.hasKey?'已加密保存，留空保持不变':'只在此设备使用系统加密保存';$('#agent-settings-result').textContent='';$('#agent-settings-dialog').showModal();
  }
  async function saveSettings() {
    const form=$('#agent-settings-form');if(!form.reportValidity())throw new Error('请填写完整模型设置');
    const input=Object.fromEntries(new FormData(form));input.clearKey=form.elements.clearKey.checked;
    const result=await api.agentConfigure(input);form.elements.apiKey.value='';form.elements.clearKey.checked=false;$('#agent-key').placeholder=result.needsApiKey?'此设备尚无 API 密钥，请重新填写':result.hasKey?'已加密保存，留空保持不变':'只在此设备使用系统加密保存';await refresh();return result;
  }
  $('#agent-settings-form').addEventListener('submit',event=>{event.preventDefault();run(async()=>{try{await saveSettings();$('#agent-settings-dialog').close();toast('模型设置已保存');}catch(error){$('#agent-settings-result').textContent=error.message;}});});
  $('#agent-settings-dialog').addEventListener('close',()=>{$('#agent-key').value='';});
  on('#agent-settings-open',settingsDialog);
  on('#agent-test',async()=>{const btn=$('#agent-test');btn.disabled=true;$('#agent-settings-result').textContent='正在保存并测试连接与工具调用…';try{await saveSettings();const result=await api.agentTest();$('#agent-settings-result').textContent=result.toolCalling?'连接成功，工具调用正常。':'接口可以连接，但模型没有调用工具。请选用支持工具调用的模型。';}catch(error){$('#agent-settings-result').textContent=error.message;}finally{btn.disabled=false;}});
  on('#agent-new',async()=>{if(busy)return;selected=null;task=null;selectedHosts.clear();$('#agent-prompt').value='';openDetails.clear();await refresh();$('#agent-feed').scrollTop=0;});
  function openDeployDialog(){
    if(busy||info?.activeId){toast('先等待或暂停当前任务，再部署账户服务',true);return;}
    if(!state.hosts.length){toast('请先添加一台服务器');return;}
    const list=$('#agent-deploy-hosts');list.replaceChildren();$('#agent-deploy-error').textContent='';
    const preferred=selectedHosts.size===1?[...selectedHosts][0]:state.hosts.length===1?state.hosts[0].id:null;
    for(const host of state.hosts){
      const label=node('label','host-choice'),radio=node('input');radio.type='radio';radio.name='agent-deploy-host';radio.value=host.id;radio.checked=host.id===preferred;
      const details=node('span');details.append(node('strong','',host.name),node('small','',host.username+'@'+host.address));const specs=specificationText(host);if(specs)details.append(node('small','',specs));
      label.append(radio,hostOSIcon(host),details);list.append(label);
    }
    $('#agent-deploy-dialog').showModal();
  }
  on('#agent-deploy-open',openDeployDialog);
  on('#agent-deploy-confirm',async()=>{
    if(busy)return;const hostId=$('#agent-deploy-hosts input:checked')?.value;
    if(!hostId){$('#agent-deploy-error').textContent='请选择一台服务器';return;}
    busy=true;$('#agent-deploy-confirm').disabled=true;$('#agent-deploy-error').textContent='正在连接并检查服务器环境…';
    try{
      const auth=await credentials([hostId]);if(auth===null){$('#agent-deploy-error').textContent='已取消连接验证';return;}
      const result=await api.agentDeployUserApi({hostId,credentials:auth});
      $('#agent-deploy-dialog').close();selected=result.id;task=null;selectedHosts=new Set([hostId]);$('#agent-prompt').value='';await refresh();$('#agent-feed').scrollTop=$('#agent-feed').scrollHeight;
    }catch(error){$('#agent-deploy-error').textContent=error.message;}
    finally{busy=false;$('#agent-deploy-confirm').disabled=false;renderFeed();}
  });
  on('#agent-attach',()=>{if(busy||info?.activeId)return;if(attachmentMenu.matches(':popover-open'))return attachmentMenu.hidePopover();attachmentMenu.showPopover();const r=$('#agent-attach').getBoundingClientRect();attachmentMenu.style.left=Math.max(10,Math.min(r.left,innerWidth-230))+'px';attachmentMenu.style.top=Math.max(10,r.top-100)+'px';attachmentMenu.querySelector('button').focus();});
  on('#agent-attach-file',async()=>{attachmentMenu.hidePopover();if(busy||info?.activeId)return;const key=selected||'new';busy=true;renderFeed();try{const files=await api.agentPickAttachments();drafts.set(key,[...(drafts.get(key)||[]),...files]);}finally{busy=false;renderFeed();}});
  on('#agent-attach-project',async()=>{attachmentMenu.hidePopover();if(busy||info?.activeId)return;if(!await confirmAction('分析项目 ZIP？','模型可以读取目录、依赖清单和部署说明。证书、私钥等请用普通文件。','选择项目'))return;const key=selected||'new';busy=true;renderFeed();try{const files=await api.agentPickProject();drafts.set(key,[...(drafts.get(key)||[]),...files]);}finally{busy=false;renderFeed();}});
  on('#agent-hosts-open',()=>{
    const list=$('#agent-host-picker');list.replaceChildren();if(!state.hosts.length)list.append(node('p','','请先在主机页面添加服务器。'));
    for(const host of state.hosts){const label=node('label','host-choice');const check=node('input');check.type='checkbox';check.value=host.id;check.checked=selectedHosts.has(host.id);check.addEventListener('change',()=>{if(check.checked)selectedHosts.add(host.id);else selectedHosts.delete(host.id);context();});const text=node('span');text.append(node('strong','',host.name),node('small','',host.username+'@'+host.address+' · '+host.group));const specs=specificationText(host);if(specs)text.append(node('small','',specs));const tracked=info?.hostTracking?.find(row=>row.hostId===host.id);text.append(node('small','host-tracking-caption',trackingLabels[tracked?.status||'untracked']+(tracked?.checkedAt?' · '+stamp(tracked.checkedAt):'')));label.append(check,hostOSIcon(host),text,trackingBadge(host.id));list.append(label);}
    $('#agent-hosts-dialog').showModal();
  });
  async function credentials(ids) {
    const auth={},seen=new Set();
    for(const id of ids)for(const peer of await api.connectionPlan(id))if(!seen.has(peer.id)){
      seen.add(peer.id);
      if(peer.auth==='key'||!peer.hasPassword){const value=await askCredential(peer,'助手任务');if(value===null)return null;auth[peer.id]=peer.auth==='key'?{passphrase:value}:{password:value};}
    }
    return auth;
  }
  async function send({preparePlan=false}={}) {
    if(busy)return;if(!info?.settings.baseUrl){settingsDialog();return;}
    const prompt=$('#agent-prompt').value.trim();if(!task&&!prompt){$('#agent-prompt').focus();return;}
    if(info.activeId){
      if(info.activeId!==task?.id){toast('请打开正在运行的任务发送补充，或先暂停它',true);return;}
      if(!prompt)return;busy=true;renderFeed();
      try{await api.agentFollowup({id:task.id,message:prompt});$('#agent-prompt').value='';await refresh();}finally{busy=false;renderFeed();}return;
    }
    const currentTask=task, mode=$('#agent-mode').value;
    busy=true;renderFeed();
    try{
      const ids=currentTask?.mode==='plan'?[...selectedHosts]:currentTask?.hostIds||[...selectedHosts];const auth=await credentials(ids);if(auth===null)return;
      const attachmentIds=draftFiles().map(a=>a.id),draftKey=selected||'new';
      const result=currentTask?await api.agentResume({id:currentTask.id,message:prompt,credentials:auth,attachmentIds,...(currentTask.mode==='plan'?{hostIds:ids,preparePlan}:{})}):await api.agentStart({prompt,hostIds:ids,mode,credentials:auth,attachmentIds});
      drafts.delete(draftKey);selected=result.id;$('#agent-prompt').value='';await refresh();$('#agent-feed').scrollTop=$('#agent-feed').scrollHeight;
    }finally{busy=false;renderFeed();}
  }
  async function executePlan(revision) {
    if(busy||!task||scopeChanged())return;
    if($('#agent-prompt').value.trim()||draftFiles().length){toast('先发送补充内容和附件，更新方案后再执行');return;}
    const id=task.id,ids=[...task.hostIds];busy=true;renderFeed();
    try{const auth=await credentials(ids);if(auth===null)return;await api.agentExecutePlan({id,revision,credentials:auth});await refresh();}
    finally{busy=false;renderFeed();}
  }
  async function answerQuestion(requestId,answers){
    if(busy||info?.activeId)return;
    if(planDirty()){toast('请先发送输入框中的补充内容、附件或主机调整，再回答最新问题');return;}
    const id=task.id,ids=[...task.hostIds];busy=true;renderFeed();
    try{const auth=await credentials(ids);if(auth===null)return;await api.agentAnswer({id,requestId,answers,credentials:auth});answerDrafts.delete(requestId);await refresh();$('#agent-feed').scrollTop=$('#agent-feed').scrollHeight;}
    finally{busy=false;renderFeed();}
  }
  $('#agent-mode').addEventListener('change',renderFeed);
  on('#agent-send',send);
  $('#agent-prompt').addEventListener('input',context);
  $('#agent-prompt').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();run(send);}});
  on('#agent-stop',async()=>{if(!task)return;$('#agent-stop').disabled=true;try{await api.agentPause(task.id);await refresh();}finally{$('#agent-stop').disabled=false;}});
  on('#agent-export',async()=>{if(task&&await api.agentExport(task.id))toast('任务记录已导出');});
  on('#agent-delete',async()=>{if(busy)return;const id=task?.id;if(id&&await confirmAction('删除任务记录？','将删除对话、执行记录和本机附件副本；服务器上的文件不受影响。','删除')){await api.agentDelete(id);for(const file of drafts.get(id)||[])await api.agentDropAttachment(file.id);drafts.delete(id);selected=null;task=null;await refresh();}});
  api.onEvent(event=>{if(event.type!=='agent')return;clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>run(refresh),120);});
  run(refresh);
  return {refresh,openSettings:async()=>{await refresh();settingsDialog();}};
}

