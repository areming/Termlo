const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {AgentService}=require('../src/agent.cjs');const {AgentStorage}=require('../src/agent-storage.cjs');const {AgentConsole}=require('../src/agent-console.cjs');const {call,response}=require('./agent-fixture.cjs');
const vault={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
function setup(t,complete,remoteFactory){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'termus-workflow-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const h={id:'a',name:'A',address:'192.0.2.1'};const agent=new AgentService({directory,vault,hosts:{get:()=>h,list:()=>[h],route:()=>[h],password:()=>''},complete,remoteFactory:remoteFactory||(()=>({jobs:new Map(),start:async(hostId,command)=>({hostId,command,status:'completed',exitCode:0}),close(){}}))});agent.configure({baseUrl:'https://example.com/v1',model:'fixture',maxRounds:12});t.after(()=>agent.close());return agent;}
const answer=calls=>({tokens:1,message:response(calls).choices[0].message});
test('followups invalidate a stale in-flight response, preserve order, and require explicit adoption',async t=>{
 let release,seen,round=0,executions=0;const agent=setup(t,async(_s,_k,m)=>{round++;if(round===1)return new Promise(r=>release=r);if(round===2){seen=m;const entries=agent.store.tasks[0].followups;return answer([call('exec_remote',{hostId:'a',command:'must-not-run-before-adoption'}),call('apply_followup',{ids:entries.map(x=>x.id),status:'applied',note:'跳过第三台，不重启机器。'})]);}return answer([call('finish_task',{outcome:'needs_input',summary:'检查结束',evidenceIds:[]})]);},()=>({jobs:new Map(),start:async()=>{executions++;return {status:'completed',exitCode:0};},close(){}}));
 const task=await agent.start({prompt:'部署',hostIds:['a']});const done=agent.active.done;
 const first=agent.followup({id:task.id,message:'跳过第三台'}),second=agent.followup({id:task.id,message:'不要重启'});
 assert.notEqual(first.id,second.id);while(!release)await new Promise(resolve=>setTimeout(resolve,1));release(answer([call('exec_remote',{hostId:'a',command:'stale-reboot'})]));await done;
 assert.equal(executions,0);assert.deepEqual(task.followups.map(x=>x.status),['applied','applied']);assert.ok(JSON.stringify(seen).indexOf('跳过第三台')<JSON.stringify(seen).indexOf('不要重启'));assert.ok(!task.messages.some(m=>m.tool_calls?.some(c=>c.function.arguments.includes('stale-reboot'))));
 task.messages=[];assert.match(agent.system({task,resources:[],settings:agent.store.settings,rounds:0}),/不要重启/,'adopted constraints survive transcript trimming');
});
test('new input during a tool prevents the rest of its batch from dispatching without orphaning tool results',async t=>{
 let release,started,round=0,commands=[];const ready=new Promise(r=>started=r);
 const agent=setup(t,async()=>{if(round++===0)return answer([call('exec_remote',{hostId:'a',command:'first'}),call('exec_remote',{hostId:'a',command:'second'})]);return answer([call('apply_followup',{ids:agent.store.tasks[0].followups.map(x=>x.id),status:'needs_input',note:'请说明新的目标。'})]);},()=>({jobs:new Map(),start:async(hostId,command)=>{commands.push(command);started();return new Promise(r=>release=()=>r({hostId,command,status:'completed',exitCode:0}));},close(){}}));
 const task=await agent.start({prompt:'批量操作',hostIds:['a']});const done=agent.active.done;await ready;agent.followup({id:task.id,message:'先别继续'});release();await done;
 assert.deepEqual(commands,['first']);assert.ok(task.messages.some(m=>m.role==='tool'&&m.content.includes('notExecuted')));assert.equal(task.status,'needs_input');
 const batch=task.messages.find(m=>m.tool_calls?.length===2);for(const c of batch.tool_calls)assert.ok(task.messages.some(m=>m.tool_call_id===c.id));
});
test('restart preserves uncertain operations and pending inputs; mutations require fresh same-host recovery evidence',async t=>{
 let phase=0,commands=[];const agent=setup(t,async(_s,_k,m)=>{const tsk=agent.store.tasks[0];if(phase++===0)return answer([call('exec_remote',{hostId:'a',command:'do-not-replay'}),call('review_operation',{operationId:'old-op',resolution:'completed',evidenceIds:['fake'],note:'猜测'}),call('inspect_host',{hostId:'a'})]);if(phase===2){const e=tsk.events.find(e=>e.name==='inspect_host');return answer([call('review_operation',{operationId:'old-op',resolution:'not_applied',evidenceIds:[e.id],note:'已检查现场，旧操作尚未生效。'}),call('exec_remote',{hostId:'a',command:'verified-next-step'})]);}return answer([call('finish_task',{outcome:'needs_input',summary:'测试完成',evidenceIds:[]})]);},()=>({jobs:new Map(),start:async(hostId,command)=>{commands.push(command);return {hostId,command,status:'completed',exitCode:0};},close(){}}));
 const task=agent.store.create('恢复任务',['a'],'autonomous');task.operations=[{id:'old-op',hostId:'a',name:'exec_remote',state:'running'}];task.followups=[{id:'pending',content:'旧补充',status:'delivered'}];task.status='running';agent.store.save(task);
 const restored=new AgentStorage(path.dirname(agent.store.directory),vault);assert.equal(restored.get(task.id).operations[0].state,'unknown');assert.equal(restored.get(task.id).followups[0].status,'queued');
 task.followups=[];await agent.resume({id:task.id});await agent.active.done;
 assert.ok(!commands.includes('do-not-replay'));assert.equal(commands.at(-1),'verified-next-step');assert.equal(task.operations[0].state,'not_applied');assert.ok(task.events.find(e=>e.name==='review_operation').result.error.includes('本轮'));
});
test('unverified acceptance criteria cannot be presented as completed, and forged passed evidence becomes unknown',async t=>{
 const agent=setup(t,async()=>answer([call('finish_task',{outcome:'completed',headline:'全部成功',summary:'声称完成',evidenceIds:[],checks:[{label:'健康检查',status:'passed',evidenceIds:['fake']} ]})]));
 const task=await agent.start({prompt:'验证报告',hostIds:[]});await agent.active.done;assert.equal(task.status,'needs_input');const report=task.events.find(e=>e.type==='result').report;assert.equal(report.checks[0].status,'unknown');assert.notEqual(report.headline,'全部成功');
});
test('console delta payloads reduce repeated output while retaining sequence-based recovery snapshots',()=>{
 const task={id:'perf'},events=[];const c=new AgentConsole({task,resources:[],redact:x=>x,notify:e=>events.push(e),save(){}});c.append('a','x'.repeat(10000));c.flush();let baseline=0;for(let i=0;i<100;i++){c.append('a','line-'+i+'\n');baseline+=JSON.stringify({...task.terminals[0]}).length;c.flush();}c.close();
 const actual=events.slice(1).reduce((sum,e)=>sum+JSON.stringify(e.terminal).length,0);assert.ok(actual<baseline/10);let text=events[0].terminal.text,seq=events[0].terminal.seq;for(const {terminal:r} of events.slice(1)){assert.equal(r.baseSeq,seq);text+=r.delta;seq=r.seq;}assert.equal(text,task.terminals[0].text);
 console.log('Console payload benchmark:',JSON.stringify({updates:100,fullSnapshotBytes:baseline,deltaBytes:actual,reduction:Math.round(100*(1-actual/baseline))+'%'}));
});

test('fresh evidence expires after a later mutation on the same host, but not another host',()=>{
 const {freshEvidence}=require('../src/agent-ledger.cjs');
 const e={id:'proof',name:'inspect_host',status:'completed',args:{hostId:'a'},at:'2026-10-21T01:00:00Z',finishedAt:'2026-10-21T01:00:01Z',result:{status:'completed',exitCode:0}};
 const task={events:[e],operations:[{id:'change',name:'write_file',hostId:'b',state:'completed',finishedAt:'2026-10-21T01:00:02Z'}]};
 assert.equal(freshEvidence(task,['proof'],null,'a').length,1);
 task.operations[0].hostId='a';assert.equal(freshEvidence(task,['proof'],null,'a').length,0);
 e.at=e.finishedAt='2026-10-21T01:00:03Z';assert.equal(freshEvidence(task,['proof'],null,'a').length,1);
 assert.equal(freshEvidence(task,['proof'],null,'b').length,0);
});

test('finish cannot bypass evidence freshness by omitting checks after resuming a task',async t=>{
 let round=0;const agent=setup(t,async()=>answer([call('finish_task',round++===0?{outcome:'completed',summary:'旧检查还有效',evidenceIds:['old-proof']}:{outcome:'needs_input',summary:'需要重新检查',evidenceIds:[]})]));
 const task=agent.store.create('恢复核验',['a'],'autonomous');task.events.push({id:'old-proof',name:'inspect_host',type:'tool',status:'completed',at:'2020-01-01T00:00:00Z',args:{hostId:'a'},result:{hostId:'a',status:'completed',exitCode:0}});
 await agent.resume({id:task.id});await agent.active.done;assert.equal(task.status,'needs_input');assert.match(task.events.find(e=>e.name==='finish_task').result.error,/本轮/);
});
