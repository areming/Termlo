const {randomUUID}=require('node:crypto');
const {identityKey}=require('./host-os.cjs');
const MUTATIONS=new Set(['exec_remote','write_file','upload_attachment']);
function initialize(task){
  task.changeLedger||={version:1,units:[],changes:[],runId:null};
  const ledger=task.changeLedger;
  ledger.units||=[];ledger.changes||=[];
  return ledger;
}
function begin(task,{title,hostIds=[],checks=[],strategy='controlled'}){
  const ledger=initialize(task);
  if(ledger.units.length>=60)throw new Error('本任务变更单元已达上限');
  if(typeof title!=='string'||!title.trim()||title.length>180)throw new Error('请填写简短的变更目标');
  const unit={id:randomUUID(),title:title.trim(),hostIds,checks,status:'planned',strategy,createdAt:new Date().toISOString()};
  ledger.units.push(unit);return unit;
}
function dispatch(task,{name,args,eventId,host}){
  if(!MUTATIONS.has(name))return null;
  const ledger=initialize(task);
  if(ledger.changes.length>=500)throw new Error('本任务变更账本已达上限');
  let unit=ledger.units.find(x=>x.id===args.unitId);
  if(args.unitId&&!unit)throw new Error('变更单元不存在');
  if(!unit)unit=begin(task,{title:'未分类远程变更',hostIds:[args.hostId],strategy:'unknown'});
  if(unit.hostIds.length&&!unit.hostIds.includes(args.hostId))throw new Error('主机不属于此变更单元');
  const change={id:randomUUID(),unitId:unit.id,operationId:eventId,hostId:args.hostId,identity:identityKey(host),kind:name,resource:name==='write_file'?args.path:name==='upload_attachment'?args.attachmentId:'远程 Shell',state:'dispatched',reversibility:name==='write_file'?'controlled':'unknown',observedAt:new Date().toISOString()};
  ledger.changes.push(change);unit.status='running';return change;
}
function settleChange(task,eventId,result){
  const ledger=initialize(task),change=ledger.changes.find(x=>x.operationId===eventId);if(!change)return;
  change.state=result?.error||['interrupted','timeout'].includes(result?.status)?'unknown':result?.status==='running'?'running':result?.status==='failed'?'unknown':'applied';
  change.observedAt=new Date().toISOString();
  if(result?.path&&change.kind==='upload_attachment')change.resource=result.path;
  if(result?.sha256)change.expectedSha256=result.sha256;
  if(result?.stagingDirectory)change.stagingDirectory=result.stagingDirectory;
  const unit=ledger.units.find(x=>x.id===change.unitId);
  if(unit&&unit.status!=='verified')unit.status=ledger.changes.some(c=>c.unitId===unit.id&&c.state==='unknown')?'unknown':'running';
}
function markCompensation(task,record,state){const ledger=initialize(task);const change=[...ledger.changes].reverse().find(c=>c.hostId===record.hostId&&c.kind===(record.attachmentId?'upload_attachment':'write_file')&&(c.resource===record.path||c.resource===record.attachmentId)&&c.state!=='reverted');if(change){change.state=state;change.observedAt=new Date().toISOString();const unit=ledger.units.find(u=>u.id===change.unitId);if(unit){const rows=ledger.changes.filter(c=>c.unitId===unit.id);unit.status=rows.some(c=>['unknown','residual'].includes(c.state))?'unknown':rows.every(c=>c.state==='reverted')?'reverted':'running';}}}
function verify(task,{changeId,evidenceIds},runStart){
  const ledger=initialize(task),change=ledger.changes.find(c=>c.id===changeId);if(!change)throw new Error('变更记录不存在');
  if(change.kind!=='write_file'||change.state!=='applied'||!change.expectedSha256)throw new Error('此类变更不能由文件哈希自动验收；请记录现场检查和实际局限');
  const proof=(evidenceIds||[]).map(id=>task.events.find(e=>e.id===id)).find(e=>e&&e.name==='read_file'&&e.status==='completed'&&e.args?.hostId===change.hostId&&e.args.path===change.resource&&e.result?.sha256===change.expectedSha256&&!e.result?.truncated&&e.at>=runStart&&e.at>=change.observedAt);
  if(!proof)throw new Error('需要本轮、同主机同路径且哈希匹配的现场读取证据');
  if(ledger.changes.some(c=>c.hostId===change.hostId&&c.id!==change.id&&c.observedAt>proof.at&&['exec_remote','write_file','upload_attachment'].includes(c.kind)))throw new Error('该主机在核验后发生新变更，请重新检查');
  change.state='verified';change.verifiedAt=new Date().toISOString();change.evidenceIds=[proof.id];const unit=ledger.units.find(u=>u.id===change.unitId);if(unit&&ledger.changes.filter(c=>c.unitId===unit.id).every(c=>c.state==='verified'))unit.status='verified';return {changeId:change.id,state:change.state,evidenceId:proof.id};
}
function onRun(task,runId){const ledger=initialize(task);ledger.runId=runId;ledger.startedAt=new Date().toISOString();for(const c of ledger.changes)if(['dispatched','running'].includes(c.state))c.state='unknown';}
function summary(task,max=5500){
  const ledger=initialize(task),counts={};for(const c of ledger.changes)counts[c.state]=(counts[c.state]||0)+1;
  const outstanding=ledger.changes.filter(c=>['unknown','residual','undoing'].includes(c.state));
  const recent=ledger.units.slice(-12).map(u=>({id:u.id,title:u.title,hosts:u.hostIds,status:u.status,strategy:u.strategy}));
  const bounded=outstanding.slice(0,20).map(c=>({id:c.id,hostId:c.hostId,kind:c.kind,resource:c.resource,state:c.state}));
  let text=JSON.stringify({version:ledger.version,runId:ledger.runId,counts,units:recent,outstanding:bounded,omittedUnits:Math.max(0,ledger.units.length-recent.length),omittedOutstanding:Math.max(0,outstanding.length-bounded.length)});
  if(text.length>max)text=JSON.stringify({version:ledger.version,counts,outstanding:bounded.slice(0,6),more:outstanding.length-6,detailTool:'read_changes'});
  return text;
}
function page(task,{unitId,hostId,status,offset=0,limit=20}={}){
  const ledger=initialize(task);if(!Number.isInteger(offset)||offset<0||offset>10000||!Number.isInteger(limit)||limit<1||limit>50)throw new Error('分页范围无效');
  const all=ledger.changes.filter(c=>(!unitId||c.unitId===unitId)&&(!hostId||c.hostId===hostId)&&(!status||c.state===status));
  return {referenceOnly:true,note:'历史记录仅供定位；执行前核实当前服务器状态。',total:all.length,nextOffset:offset+limit<all.length?offset+limit:null,changes:all.slice(offset,offset+limit),units:ledger.units.filter(u=>!unitId||u.id===unitId).slice(-20)};
}
module.exports={initialize,begin,dispatch,settleChange,markCompensation,verify,onRun,summary,page};
