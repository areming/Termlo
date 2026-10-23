const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {randomBytes,createCipheriv,createDecipheriv}=require('node:crypto');
const {AgentService,TOOLS,validate,modelContext,scrub}=require('../src/agent.cjs');
const {AgentStorage}=require('../src/agent-storage.cjs');const {AgentRemote}=require('../src/agent-remote.cjs');
const {Store}=require('../src/store.cjs');const net=require('../src/agent-network.cjs');
const {startFixture}=require('./fixture.cjs');const {call,response,startProvider,deploymentModel,remoteResponder}=require('./agent-fixture.cjs');
test('ordinary mutation records a task change without creating a cloud snapshot',async t=>{const dir=directory(t);let dispatches=0,prepares=0,calls=0;const agent=new AgentService({directory:dir,vault,hosts:fakeHosts(),protection:{summary:()=>({status:'none'}),ensureReady:async()=>{prepares++;throw Error('snapshot denied');}},complete:async()=>({message:++calls===1?{role:'assistant',content:null,tool_calls:[call('exec_remote',{hostId:'a',command:'change'})]}:{role:'assistant',content:null,tool_calls:[call('finish_task',{outcome:'needs_input',summary:'已记录变更',evidenceIds:[]})]},tokens:1}),remoteFactory:()=>({jobs:new Map(),start:async()=>{dispatches++;return {hostId:'a',status:'completed',exitCode:0};},close(){}})});agent.configure({baseUrl:'https://example.test/v1',model:'test'});const task=await agent.start({prompt:'deploy',hostIds:['a']});await waitFor(()=>!agent.active);assert.equal(dispatches,1);assert.equal(prepares,0);assert.equal(task.changeLedger.changes.length,1);assert.equal(task.changeLedger.changes[0].kind,'exec_remote');assert.equal(task.changeLedger.changes[0].reversibility,'unknown');});
test('task file recovery centralizes originals, rejects drift, is idempotent and cleans only task materials',async t=>{const dir=directory(t);fs.mkdirSync(path.join(dir,'tmp'));fs.writeFileSync(path.join(dir,'existing.txt'),'before');const fixture=await startFixture(dir);t.after(()=>fixture.close());const record=[],taskId=require('node:crypto').randomUUID(),remote=new AgentRemote({routes:new Map([['a',[{id:'a',address:'127.0.0.1',port:fixture.port,username:'tester',auth:'password'}]]]),credentials:{a:{password:'local-test'}},verify:async()=>true,signal:new AbortController().signal,recoveryId:taskId,onFileChange:r=>record.push(r)});t.after(()=>remote.close());const added=await remote.writeFile('a','/added.txt','new','missing');assert.ok(added.recovery.directory.endsWith(taskId));assert.equal(record[0].state,'prepared');assert.equal(record[1].state,'applied');fs.writeFileSync(path.join(dir,'added.txt'),'human change');await assert.rejects(remote.undoWrite(added),/发生变化/);fs.writeFileSync(path.join(dir,'added.txt'),'new');await remote.undoWrite(added);await remote.undoWrite(added);assert.equal(fs.existsSync(path.join(dir,'added.txt')),false);const original=await remote.readFile('a','/existing.txt');await assert.rejects(remote.writeFile('a','/existing.txt','changed',original.sha256),/原子替换/);const uncertain=record.at(-1);assert.equal(uncertain.state,'unknown');assert.ok(uncertain.backup.startsWith('/tmp/termus-recovery-'));await remote.undoWrite(uncertain);assert.equal(fs.readFileSync(path.join(dir,'existing.txt'),'utf8'),'before');await remote.cleanRecovery([added,uncertain]);assert.equal(fs.existsSync(path.join(dir,'tmp','termus-recovery-'+taskId)),false);});
test('failed controlled file task compensates its own new file and preserves a dated ledger',async t=>{const dir=directory(t);fs.mkdirSync(path.join(dir,'tmp'));const fixture=await startFixture(dir);t.after(()=>fixture.close());const h={id:'a',name:'A',address:'127.0.0.1',port:fixture.port,username:'tester',auth:'password'},hosts={list:()=>[h],get:()=>h,route:()=>[h],password:()=>''};let calls=0;const agent=new AgentService({directory:dir,vault,hosts,verify:async()=>{return true;},complete:async()=>{if(++calls===1)return {message:{role:'assistant',content:null,tool_calls:[call('write_file',{hostId:'a',path:'/managed.txt',content:'new',expectedSha256:'missing'})]},tokens:1};throw Error('model unavailable');}});agent.configure({baseUrl:'https://example.test/v1',model:'m1'});const task=await agent.start({prompt:'create managed file',hostIds:['a'],credentials:{a:{password:'local-test'}}});await waitFor(()=>!agent.active);assert.equal(task.status,'failed');assert.equal(fs.existsSync(path.join(dir,'managed.txt')),false);assert.ok(task.fileChanges?.length,task.notice);assert.equal(task.fileChanges[0].state,'restored');assert.equal(task.changeLedger.changes[0].state,'reverted');assert.match(task.notice,/已撤销 1 项/);});
test('uploaded attachment staging is removed exactly and unknown additions remain visible',async t=>{const dir=directory(t);fs.mkdirSync(path.join(dir,'tmp'));const fixture=await startFixture(dir);t.after(()=>fixture.close());const events=[],taskId=require('node:crypto').randomUUID(),remote=new AgentRemote({routes:new Map([['a',[{id:'a',address:'127.0.0.1',port:fixture.port,username:'tester',auth:'password'}]]]),credentials:{a:{password:'local-test'}},verify:async()=>true,signal:new AbortController().signal,recoveryId:taskId,onStagingChange:r=>events.push(r)});t.after(()=>remote.close());const data=Buffer.from('attachment'),sha256=require('node:crypto').createHash('sha256').update(data).digest('hex'),item={id:'asset',name:'site.txt',sha256};const result=await remote.uploadAttachment('a','/tmp',item,data);assert.equal(events[0].state,'prepared');assert.equal(events.at(-1).state,'applied');const record=events.at(-1);fs.writeFileSync(path.join(dir,result.stagingDirectory,'extra'),'other');await assert.rejects(remote.cleanStaging(record),/其他文件/);assert.equal(fs.existsSync(path.join(dir,result.stagingDirectory,'extra')),true);fs.rmSync(path.join(dir,result.stagingDirectory,'extra'));await remote.cleanStaging(record);assert.equal(fs.existsSync(path.join(dir,result.stagingDirectory)),false);});
test('two-host failure compensates known file, preserves changed target and reports residual',async t=>{const root=directory(t),da=path.join(root,'a'),db=path.join(root,'b');for(const dir of [da,db]){fs.mkdirSync(dir);fs.mkdirSync(path.join(dir,'tmp'));}const fa=await startFixture(da),fb=await startFixture(db);t.after(()=>{fa.close();fb.close();});const hostsList=[{id:'a',name:'A',address:'127.0.0.1',port:fa.port,username:'tester',auth:'password'},{id:'b',name:'B',address:'127.0.0.1',port:fb.port,username:'tester',auth:'password'}],hosts={list:()=>hostsList,get:id=>hostsList.find(h=>h.id===id),route:id=>[hostsList.find(h=>h.id===id)],password:()=>''};let round=0;const agent=new AgentService({directory:root,vault,hosts,verify:async()=>true,complete:async()=>{round++;if(round<=2)return {message:{role:'assistant',content:null,tool_calls:[call('write_file',{hostId:round===1?'a':'b',path:'/site.txt',content:'deployed',expectedSha256:'missing'})]},tokens:1};fs.writeFileSync(path.join(db,'site.txt'),'operator update');throw Error('deployment failed');}});agent.configure({baseUrl:'https://example.test/v1',model:'m1'});const task=await agent.start({prompt:'deploy two hosts',hostIds:['a','b'],credentials:{a:{password:'local-test'},b:{password:'local-test'}}});await waitFor(()=>!agent.active);assert.equal(task.status,'failed');assert.equal(fs.existsSync(path.join(da,'site.txt')),false);assert.equal(fs.readFileSync(path.join(db,'site.txt'),'utf8'),'operator update');assert.deepEqual(task.changeLedger.changes.map(c=>c.state),['reverted','residual']);assert.match(task.notice,/1 项待核实/);});
test('handoff requires current evidence for the same host and file',t=>{const agent=new AgentService({directory:directory(t),vault,hosts:fakeHosts()}),startedAt=new Date().toISOString(),task={events:[],operations:[],followups:[],handoff:{pendingHostIds:['a']}},run={task,startedAt};assert.throws(()=>agent.guard(run,'write_file',{hostId:'a',path:'/site',expectedSha256:'abc'}),/接手前/);task.events.push({name:'read_file',at:startedAt,status:'completed',args:{hostId:'b',path:'/site'},result:{sha256:'abc'}});assert.throws(()=>agent.guard(run,'write_file',{hostId:'a',path:'/site',expectedSha256:'abc'}),/接手前/);task.events.push({name:'read_file',at:startedAt,status:'completed',args:{hostId:'a',path:'/other'},result:{sha256:'abc'}});assert.throws(()=>agent.guard(run,'write_file',{hostId:'a',path:'/site',expectedSha256:'abc'}),/接手前/);task.events.push({name:'read_file',at:startedAt,status:'completed',args:{hostId:'a',path:'/site'},result:{sha256:'abc'}});agent.guard(run,'write_file',{hostId:'a',path:'/site',expectedSha256:'abc'});assert.deepEqual(task.handoff.pendingHostIds,[]);});
test('recovery request is bound to its exact recorded scope and cannot be forged by model text',async t=>{let undone=0;const agent=new AgentService({directory:directory(t),vault,hosts:fakeHosts(),remoteFactory:()=>({undoWrite:async()=>{undone++;},close(){}})}),task=agent.store.create('recover',['a'],'autonomous'),record={id:'r',hostId:'a',path:'/site',identity:require('../src/host-os.cjs').identityKey(fakeHosts().get('a')),state:'applied'};task.fileChanges=[record];task.recoveryRequest={id:'request',status:'pending',fingerprint:JSON.stringify([[record.id,record.hostId,record.identity,record.state]])};agent.store.save(task);await assert.rejects(agent.applyRecovery({id:task.id,requestId:'wrong',confirmed:true}),/变化/);await assert.rejects(agent.applyRecovery({id:task.id,requestId:'request',confirmed:false}),/变化/);assert.equal(undone,0);const other={...record,state:'unknown'};task.fileChanges=[other];await assert.rejects(agent.applyRecovery({id:task.id,requestId:'request',confirmed:true}),/范围已变化/);task.fileChanges=[record];await agent.applyRecovery({id:task.id,requestId:'request',confirmed:true});assert.equal(undone,1);assert.equal(task.recoveryRequest.status,'applied');await assert.rejects(agent.applyRecovery({id:task.id,requestId:'request',confirmed:true}),/变化/);});
test('a different model resumes the same task only after current host inspection',async t=>{let step=0,executed=0;const agent=new AgentService({directory:directory(t),vault,hosts:fakeHosts(),remoteFactory:()=>({jobs:new Map(),start:async(hostId,command)=>{if(command==='update')executed++;return {hostId,status:'completed',exitCode:0};},close(){}}),complete:async(settings,_key,messages)=>{assert.equal(settings.model,'new-model');assert.match(messages[0].content,/历史参考/);return {message:{role:'assistant',content:null,tool_calls:[step++===0?call('inspect_host',{hostId:'a'}):step===2?call('exec_remote',{hostId:'a',command:'update'}):call('finish_task',{outcome:'needs_input',summary:'请检查',evidenceIds:[]})]},tokens:1};}});agent.configure({baseUrl:'https://example.test/v1',model:'old-model'});const task=agent.store.create('continue',['a'],'autonomous');task.model='old-model';task.operations=[{id:'old',name:'write_file',hostId:'a',state:'completed',startedAt:new Date(0).toISOString()}];agent.store.save(task);agent.configure({baseUrl:'https://example.test/v1',model:'new-model'});await agent.resume({id:task.id});await waitFor(()=>!agent.active);assert.equal(executed,1);assert.equal(task.handoff.reason,'model_changed');assert.deepEqual(task.handoff.pendingHostIds,[]);});
const key=randomBytes(32),iv=randomBytes(16);
const vault={isEncryptionAvailable:()=>true,encryptString(s){const c=createCipheriv('aes-256-cbc',key,iv);return Buffer.concat([c.update(s),c.final()]);},decryptString(b){const c=createDecipheriv('aes-256-cbc',key,iv);return Buffer.concat([c.update(b),c.final()]).toString();}};
function directory(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'termus-agent-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
function fakeHosts(){const all=[{id:'a',name:'Alpha',address:'192.0.2.1'},{id:'b',name:'Beta',address:'192.0.2.2'}];return {list:()=>all,get:id=>{const h=all.find(h=>h.id===id);if(!h)throw Error('missing');return h;},route:id=>[all.find(h=>h.id===id)],password:()=> 'ssh-secret-123'};}
function fakeRemote(){return {jobs:new Map(),start:async(hostId,command)=>({hostId,command,status:'completed',stdout:'Ready',exitCode:0}),close(){}};}
async function waitFor(fn,timeout=5000){const deadline=Date.now()+timeout;while(!fn()){if(Date.now()>deadline)throw Error('condition timeout');await new Promise(r=>setTimeout(r,15));}}

test('agent settings encrypt keys, never expose them, clear on endpoint change and recover interrupted tasks',t=>{
 const dir=directory(t),store=new AgentStorage(dir,vault);
 store.configure({baseUrl:'https://example.com/v1',model:'model',apiKey:'private-api-key',maxRounds:12});
 assert.equal(store.key(),'private-api-key');assert.equal(store.publicSettings().encryptedKey,undefined);
 assert.ok(!fs.readFileSync(path.join(dir,'assistant/settings.json'),'utf8').includes('private-api-key'));
 assert.throws(()=>store.configure({baseUrl:'http://example.com/v1',model:'model'}),/HTTPS/);
 assert.equal(store.key(),'private-api-key');
 store.configure({baseUrl:'https://other.example/v1',model:'model'});assert.equal(store.key(),'');
 const task=store.create('inspect',['a'],'inspect');task.status='running';store.save(task);
 const restored=new AgentStorage(dir,vault);assert.equal(restored.get(task.id).status,'paused');assert.match(restored.get(task.id).notice,/中断/);
});
test('resource retrieval is scoped, dated and searchable; validation rejects malformed calls',t=>{
 const store=new AgentStorage(directory(t),vault);
 for(const hostId of ['a','b'])store.remember({hostId,title:'Ubuntu Kubernetes 环境',content:'CPU 4 内存 8192',source:'uname',taskId:'task',evidenceId:'e'});
 const rows=store.search('Kubernetes',['a']);assert.equal(rows.length,1);assert.equal(rows[0].hostId,'a');assert.ok(rows[0].observedAt);assert.equal(store.search('missing',['a']).length,0);
 const schema=TOOLS.find(t=>t.function.name==='exec_remote').function.parameters;
 assert.throws(()=>validate(schema,{hostId:'a',command:'ls',unexpected:1}),/未知/);assert.throws(()=>validate(schema,{hostId:'a',command:'ls',timeoutSeconds:9999}),/范围/);
 assert.ok(!scrub('ssh-secret-123 password=hello Bearer abcdef',['ssh-secret-123']).includes('hello'));
});
test('model adapter sends OpenAI compatible tools, blocks redirects and validates tool IDs',async t=>{
 const server=await startProvider(input=>response([call('list_resources')]));t.after(()=>server.close());
 const result=await net.completion({baseUrl:server.url,model:'test'},'api-test-key',[{role:'user',content:'hello'}],TOOLS);
 assert.equal(result.message.tool_calls[0].function.name,'list_resources');assert.equal(server.requests[0].path,'/v1/chat/completions');assert.equal(server.requests[0].authorization,'Bearer api-test-key');
 assert.equal(server.requests[0].input.stream,false);
 const duplicate=call('list_resources');const bad=await startProvider(()=>response([duplicate,duplicate]));t.after(()=>bad.close());
 await assert.rejects(net.completion({baseUrl:bad.url,model:'test'},'',[],TOOLS),/重复/);
 for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','::1','::ffff:127.0.0.1','fe80::1'])assert.equal(net.isPublic(address),false,address);
 assert.equal(net.isPublic('8.8.8.8'),true);
 await assert.rejects(net.fetchPage('http://127.0.0.1/private'),/公网/);
 assert.equal(net.htmlText('<script>bad()</script><h1>Hello &amp; World</h1>'),'Hello & World');
});
test('agent loops through real SSH failure, recovery, verification and dated evidence without exposing credentials',{timeout:30000},async t=>{
 const dir=directory(t),commands=[];
 const fixture=await startFixture(path.join(dir,'remote'),{exec:(cmd,stream)=>{commands.push(cmd);remoteResponder(cmd,stream);}});t.after(()=>fixture.close());
 const hosts=new Store(dir,vault);hosts.save({name:'Agent fixture',address:'127.0.0.1',port:fixture.port,username:'tester',auth:'password',password:'local-test',rememberPassword:true});
 const id=hosts.list()[0].id;const provider=await startProvider(deploymentModel([id]));t.after(()=>provider.close());
 const agent=new AgentService({directory:dir,vault,hosts,verify:async(_h,fp)=>fp===fixture.fingerprint});t.after(()=>agent.close());
 agent.configure({baseUrl:provider.url,model:'fixture-model',apiKey:'model-secret-123',maxRounds:20});
 const task=await agent.start({prompt:'检查并部署测试服务',hostIds:[id]});await agent.active.done;
 assert.equal(task.status,'completed');assert.ok(commands.includes('deploy-test'));assert.ok(commands.indexOf('repair-test')>commands.indexOf('deploy-test'));assert.ok(commands.indexOf('verify-test')>commands.indexOf('repair-test'));
 assert.ok(task.events.some(e=>e.result?.exitCode===1));assert.equal(agent.store.memory.length,0);assert.equal(task.plan.at(-1).status,'done');
 const messages=JSON.stringify(provider.requests.map(r=>r.input));assert.ok(!messages.includes('local-test'));assert.ok(!messages.includes('model-secret-123'));
 assert.ok(!JSON.stringify(task).includes('local-test'));assert.ok(!JSON.stringify(task).includes('model-secret-123'));
});
test('read-only and host scope are enforced even if the model requests forbidden commands',async t=>{
 let n=0,executed=0;const dir=directory(t);
 const agent=new AgentService({directory:dir,vault,hosts:fakeHosts(),remoteFactory:()=>({...fakeRemote(),start:async()=>{executed++;}}),complete:async()=>({tokens:1,message:response(n++===0?[call('exec_remote',{hostId:'a',command:'touch x'}),call('inspect_host',{hostId:'b'}),call('finish_task',{outcome:'completed',summary:'unsupported claim',evidenceIds:[]})]:[call('finish_task',{outcome:'needs_input',summary:'没有有效现场证据',evidenceIds:[]})]).choices[0].message})});
 agent.configure({baseUrl:'https://example.com/v1',model:'test'});const task=await agent.start({prompt:'检查',hostIds:['a'],mode:'inspect'});await agent.active.done;
 assert.equal(executed,0);assert.equal(task.status,'needs_input');assert.equal(task.events.filter(e=>e.status==='failed').length,3);
});
test('pause interrupts a pending model request; resume repairs tool protocol and never replays old commands',async t=>{
 let calls=0;const agent=new AgentService({directory:directory(t),vault,hosts:fakeHosts(),remoteFactory:fakeRemote,complete:async(_s,_k,m,_tools,signal)=>{calls++;if(calls===1)return {tokens:1,message:response([call('inspect_host',{hostId:'a'})]).choices[0].message};if(calls===2)return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));return {tokens:1,message:response([call('finish_task',{outcome:'needs_input',summary:'需要进一步核对',evidenceIds:[]})]).choices[0].message};}});
 agent.configure({baseUrl:'https://example.com/v1',model:'test'});const task=await agent.start({prompt:'检查',hostIds:['a']});await waitFor(()=>calls===2);await agent.pause(task.id);assert.equal(task.status,'paused');assert.equal(agent.active,null);
 task.messages.push({role:'assistant',content:null,tool_calls:[call('inspect_host',{hostId:'a'})]});
 await agent.resume({id:task.id,message:'核对并继续'});await agent.active.done;
 assert.equal(task.status,'needs_input');assert.ok(task.messages.some(m=>m.role==='tool'&&m.content.includes('结果未知')));assert.equal(task.events.filter(e=>e.name==='inspect_host').length,1);
 const packed=modelContext(task,'system');assert.equal(packed[0].role,'system');
});
test('SSH jobs support polling, exit status, timeouts, cancellation and checked file writes',{timeout:30000},async t=>{
 const dir=directory(t);fs.writeFileSync(path.join(dir,'sample.txt'),'old');fs.writeFileSync(path.join(dir,'empty.txt'),'');
 const fixture=await startFixture(dir,{exec:remoteResponder});t.after(()=>fixture.close());const controller=new AbortController();
 const remote=new AgentRemote({routes:new Map([['a',[{id:'a',name:'test',address:'127.0.0.1',port:fixture.port,username:'tester',auth:'password'}]]]),credentials:{a:{password:'local-test'}},verify:async()=>true,signal:controller.signal});t.after(()=>remote.close());
 await assert.rejects(remote.start('b','probe'),/范围/);
 const failed=await remote.start('a','deploy-test');assert.equal(failed.status,'failed');assert.equal(failed.exitCode,1);
 const job=await remote.start('a','long-running',1);assert.equal(job.status,'running');assert.equal((await remote.wait(job.id,2)).status,'timeout');
 const next=await remote.start('a','long-running');assert.equal(remote.cancelJob(next.id).status,'interrupted');
 const file=await remote.readFile('a','/sample.txt');assert.equal(file.content,'old');assert.equal(file.sha256.length,64);
 assert.equal((await remote.readFile('a','/empty.txt')).content,'');
 await assert.rejects(remote.writeFile('a','/sample.txt','new','missing'),/变化/);
 await remote.writeFile('a','/new.txt','new file','missing');assert.equal(fs.readFileSync(path.join(dir,'new.txt'),'utf8'),'new file');
 await assert.rejects(remote.writeFile('a','/sample.txt','new',file.sha256),/原子替换/);assert.equal(fs.readFileSync(path.join(dir,'sample.txt'),'utf8'),'old');
 assert.ok(fs.readdirSync(dir).some(f=>f.startsWith('sample.txt.termus-backup-')));
 const pending=await remote.start('a','long-running');controller.abort();assert.equal(remote.jobs.get(pending.id).status,'interrupted');
});
test('model redirect does not forward authorization and a stalled response is bounded',async t=>{
 const http=require('node:http');let requests=0;
 const server=http.createServer((req,res)=>{requests++;if(req.url==='/hang')return;res.writeHead(302,{location:'/target'});res.end();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const url='http://127.0.0.1:'+server.address().port;
 await assert.rejects(net.completion({baseUrl:url,model:'test'},'secret',[],[]),/重定向/);assert.equal(requests,1);
 await assert.rejects(net.request(url+'/hang',{timeout:40}),/超时/);
});
test('public search parses document URLs and ignores non-web links',()=>{
 const html='<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fkubernetes.io%2Fdocs%2F&amp;rut=abc">Kubernetes &amp; kubeadm</a><a class="result__snippet">Official &#x27;guide&#39;</a><a class="result__a" href="javascript:bad()">Bad</a>';
 const rows=net.searchResults(html);assert.equal(rows.length,1);assert.equal(rows[0].url,'https://kubernetes.io/docs/');assert.equal(rows[0].excerpt,"Official 'guide'");
});
test('Plan discussion never exposes mutation tools, versions proposals and requires explicit current-plan execution',async t=>{
 let mutationCalls=0,phase=0;const agent=new AgentService({directory:directory(t),vault,hosts:fakeHosts(),remoteFactory:()=>({...fakeRemote(),start:async(hostId,command)=>{mutationCalls++;return {hostId,command,status:'completed',stdout:'Ready',exitCode:0};}}),complete:async(_s,_k,m,tools)=>{
  const planning=tools.some(t=>t.function.name==='propose_plan');
  if(planning){assert.ok(!tools.some(t=>['exec_remote','write_file','finish_task'].includes(t.function.name)));const plan={title:'测试部署方案',summary:'先检查再部署并验证',steps:['检查目标','执行变更','验证结果'],checks:['服务健康'],risks:[],questions:phase++===0?['选择部署规模？']:[]};return {tokens:1,message:response([call('exec_remote',{hostId:'a',command:'touch forbidden'}),call('write_file',{hostId:'a',path:'/forbidden',content:'x',expectedSha256:'missing'}),call('finish_task',{outcome:'completed',summary:'not allowed',evidenceIds:[]}),call('propose_plan',plan)]).choices[0].message};}
  const tool=m.filter(x=>x.role==='tool').map(x=>JSON.parse(x.content)).find(r=>r.command==='verify');
  return {tokens:1,message:response(tool?[call('finish_task',{outcome:'completed',summary:'详细报告',headline:'服务已就绪',highlights:['配置已应用'],checks:[{label:'服务健康',status:'passed'}],evidenceIds:[tool.evidenceId]})]:[call('exec_remote',{hostId:'a',command:'verify'})]).choices[0].message};
 }});
 agent.configure({baseUrl:'https://example.com/v1',model:'test'});
 const task=await agent.start({prompt:'一起规划部署',hostIds:['a'],mode:'plan'});await agent.active.done;
 assert.equal(task.status,'plan_ready');assert.equal(task.proposal.revision,1);assert.equal(mutationCalls,0);assert.equal(task.events.filter(e=>e.status==='failed').length,3);
 await assert.rejects(agent.executePlan({id:task.id,revision:1}),/待明确/);
 await agent.resume({id:task.id,message:'单节点即可',hostIds:['a','b']});await agent.active.done;
 assert.equal(task.proposal.revision,2);assert.deepEqual(task.proposal.hostIds,['a','b']);assert.equal(task.mode,'plan');assert.equal(mutationCalls,0);
 await assert.rejects(agent.executePlan({id:task.id,revision:1}),/方案已变化/);
 await agent.executePlan({id:task.id,revision:2});await agent.active.done;
 assert.equal(task.mode,'autonomous');assert.equal(task.status,'completed');assert.equal(mutationCalls,1);assert.equal(task.approvedProposal.revision,2);
 assert.equal(task.events.find(e=>e.type==='result').report.headline,'服务已就绪');
 await assert.rejects(agent.executePlan({id:task.id,revision:2}),/方案已变化/);
});
test('Plan accepts conversational replies without forcing tool calls or executing',async t=>{
 let count=0;const agent=new AgentService({directory:directory(t),vault,hosts:fakeHosts(),remoteFactory:fakeRemote,complete:async()=>{count++;return {tokens:2,message:{role:'assistant',content:'你希望用单节点还是高可用部署？'}};}});
 agent.configure({baseUrl:'https://example.com/v1',model:'test'});const task=await agent.start({prompt:'一起讨论',mode:'plan'});await agent.active.done;
 assert.equal(task.status,'awaiting_reply');assert.equal(count,1);assert.equal(task.proposal,undefined);
 await assert.rejects(agent.executePlan({id:task.id,revision:1}),/方案已变化/);
});
test('Plan follow-up repairs plain-text-only replies and recovers historical proposals without executing',async t=>{
 let calls=0,mutations=0;
 const plan={title:'部署方案',summary:'核实后部署',steps:['核实','部署','验收'],checks:['健康'],risks:[],questions:[]};
 const agent=new AgentService({directory:directory(t),vault,hosts:fakeHosts(),remoteFactory:()=>({...fakeRemote(),start:async()=>{mutations++;throw Error('unexpected mutation');}}),complete:async()=>({tokens:1,message:++calls===2?{role:'assistant',content:'方案已经准备好，请点击执行。'}:response([call('propose_plan',plan)]).choices[0].message})});
 t.after(()=>agent.close());agent.configure({baseUrl:'https://example.com/v1',model:'test'});
 const task=await agent.start({prompt:'规划部署',hostIds:['a'],mode:'plan'});await agent.active.done;
 await agent.resume({id:task.id,message:'好的，按这个方案'});await agent.active.done;
 assert.equal(calls,3);assert.equal(task.proposal.revision,2);assert.equal(task.status,'plan_ready');assert.equal(task.mode,'plan');assert.equal(mutations,0);
 await assert.rejects(agent.executePlan({id:task.id,revision:1}),/方案已变化/);
 task.proposal=null;task.status='awaiting_reply';agent.store.save(task);const events=task.events.length;
 await agent.resume({id:task.id,preparePlan:true});await agent.active.done;
 assert.equal(task.proposal.revision,3);assert.ok(task.events.length>events);assert.equal(task.events.filter(e=>e.type==='proposal').length,3);assert.equal(mutations,0);
 plan.questions=['请明确目标环境'];await agent.resume({id:task.id,preparePlan:true});await agent.active.done;
 await assert.rejects(agent.executePlan({id:task.id,revision:4}),/待明确/);assert.equal(mutations,0);
});

test('explicit Plan preparation retries are bounded and never authorize execution',async t=>{
 let calls=0;const agent=new AgentService({directory:directory(t),vault,hosts:fakeHosts(),remoteFactory:fakeRemote,complete:async()=>{calls++;return {tokens:1,message:{role:'assistant',content:'已准备好，点击执行。'}};}});
 t.after(()=>agent.close());agent.configure({baseUrl:'https://example.com/v1',model:'test'});
 const task=await agent.start({prompt:'先讨论',mode:'plan'});await agent.active.done;assert.equal(calls,1);
 await agent.resume({id:task.id,preparePlan:true});await agent.active.done;
 assert.equal(calls,4);assert.equal(task.status,'awaiting_reply');assert.match(task.notice,/整理方案/);assert.equal(task.proposal,null);assert.equal(task.mode,'plan');
 await assert.rejects(agent.executePlan({id:task.id,revision:1}),/方案已变化/);
 await assert.rejects(agent.resume({id:task.id,preparePlan:'yes'}),/Plan/);
});

test('interactive questions survive restart, reject stale/invalid answers and cannot execute a Plan',async t=>{
 const dir=directory(t),question={header:'部署规模',question:'使用哪种部署规模？',options:[{label:'单节点',description:'节省资源'},{label:'多节点',description:'需要更多机器'}],recommendedOption:0};let mutations=0;
 let agent=new AgentService({directory:dir,vault,hosts:fakeHosts(),remoteFactory:fakeRemote,complete:async()=>({tokens:1,message:response([call('ask_user',{questions:[question]}),call('exec_remote',{hostId:'a',command:'must-not-run'})]).choices[0].message})});
 agent.configure({baseUrl:'https://example.com/v1',model:'test'});const started=await agent.start({prompt:'规划集群',hostIds:['a'],mode:'plan'});await agent.active.done;
 assert.equal(started.status,'awaiting_input');const requestId=started.interaction.id,qId=started.interaction.questions[0].id;assert.equal(started.events.filter(e=>e.name==='exec_remote').length,0);agent.close();
 agent=new AgentService({directory:dir,vault,hosts:fakeHosts(),remoteFactory:()=>({...fakeRemote(),start:async()=>{mutations++;}}),complete:async(_s,_k,m,tools)=>{
  assert.ok(m.some(x=>x.role==='user'&&x.content.includes('单节点')));assert.ok(tools.some(t=>t.function.name==='ask_user'));
  return {tokens:1,message:response([call('propose_plan',{title:'单节点方案',summary:'按选择规划',steps:['核查','部署'],checks:['健康'],risks:[],questions:[]})]).choices[0].message};}});t.after(()=>agent.close());
 assert.equal(agent.store.get(started.id).interaction.id,requestId);
 for(const input of [{requestId:'stale',answers:[]},{requestId,answers:[]},{requestId,answers:[{questionId:qId,optionIndex:42}]},{requestId,answers:[{questionId:qId,text:''}]}])await assert.rejects(agent.answer({id:started.id,...input}));
 await assert.rejects(agent.resume({id:started.id}),/回答/);
 await agent.answer({id:started.id,requestId,answers:[{questionId:qId,optionIndex:0,text:'保留升级余地'}]});await agent.active.done;
 const task=agent.store.get(started.id);assert.equal(task.status,'plan_ready');assert.equal(task.mode,'plan');assert.equal(mutations,0);assert.equal(task.interaction.status,'answered');assert.equal(task.events.filter(e=>e.type==='answer').length,1);
 await assert.rejects(agent.answer({id:task.id,requestId,answers:[{questionId:qId,optionIndex:0}]}),/已处理/);
});

test('autonomous and inspect modes pause for choices then resume with custom answers; active jobs prevent questions',async t=>{
 for(const mode of ['autonomous','inspect']){
  let n=0;const agent=new AgentService({directory:directory(t),vault,hosts:fakeHosts(),remoteFactory:fakeRemote,complete:async(_s,_k,m,tools)=>{
   assert.ok(tools.some(t=>t.function.name==='ask_user'));
   return {tokens:1,message:response(n++===0?[call('ask_user',{questions:[{header:'目标',question:'请填写目标站点',options:[]}]})]:[call('finish_task',{outcome:'needs_input',summary:'收到站点，尚需选择机器',evidenceIds:[]})]).choices[0].message};}});t.after(()=>agent.close());
  agent.configure({baseUrl:'https://example.com/v1',model:'test'});const task=await agent.start({prompt:'检查站点',mode});await agent.active.done;assert.equal(task.status,'awaiting_input');
  await agent.answer({id:task.id,requestId:task.interaction.id,answers:[{questionId:task.interaction.questions[0].id,text:'example.test'}]});await agent.active.done;
  assert.equal(task.mode,mode);assert.equal(task.status,'needs_input');assert.ok(task.messages.some(m=>m.role==='user'&&m.content.includes('example.test')));
 }
 const q=require('../src/agent-questions.cjs');assert.throws(()=>q.createRequest([]),/至少/);assert.throws(()=>q.createRequest([{options:[{label:'only'}]}]),/2–4/);assert.throws(()=>q.createRequest([{options:[],recommendedOption:0}]),/不存在/);
 const agent=new AgentService({directory:directory(t),vault,hosts:fakeHosts(),remoteFactory:fakeRemote});
 await assert.rejects(agent.execute({task:{},remote:{jobs:new Map([['job',{status:'running'}]])},controller:new AbortController()},'ask_user',{questions:[{header:'Q',question:'Q',options:[]}]}),/等待/);
});

test('live console preserves per-host output, bounds history and redacts credentials split across packets',async t=>{
 const {AgentConsole}=require('../src/agent-console.cjs');const task={id:'task'},events=[];
 const output=new AgentConsole({task,resources:[{id:'a',name:'Alpha'},{id:'b',name:'Beta'}],redact:text=>scrub(text,['hidden-password']),notify:event=>events.push(event),save:()=>{}});t.after(()=>output.close());
 const job={id:'job1',hostId:'a',command:'probe',status:'running',exitCode:null};output.handle({type:'start',job});output.handle({type:'data',job,channel:'stdout',text:'hidden-pass'});output.flush();
 assert.ok(!JSON.stringify(events).includes('hidden-pass'));
 output.handle({type:'data',job,channel:'stdout',text:'word\nready\n'});output.flush();assert.match(task.terminals[0].text,/ready/);assert.ok(!JSON.stringify(task).includes('hidden-password'));
 output.handle({type:'end',job:{...job,status:'completed',exitCode:0}});assert.equal(task.terminals[0].activeJobs,0);assert.equal(task.terminals[0].status,'completed');
 const other={id:'job2',hostId:'b',command:'second'};output.handle({type:'start',job:other});output.handle({type:'data',job:other,channel:'stdout',text:'x'.repeat(150000)+'\n'});output.flush();assert.ok(task.terminals[1].text.length<=120000);assert.equal(task.terminals[1].truncated,true);assert.ok(!task.terminals[0].text.includes('second'));
});

