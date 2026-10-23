const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomBytes,createHash}=require('node:crypto');
const {AgentStorage}=require('../src/agent-storage.cjs');
const {AgentAttachments,MAX_FILE}=require('../src/agent-attachments.cjs');
const {AgentService}=require('../src/agent.cjs');
const {AgentRemote}=require('../src/agent-remote.cjs');
const {startFixture}=require('./fixture.cjs');
const {call,response}=require('./agent-fixture.cjs');
const vault={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'termus-attachment-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('attachment snapshots are encrypted, immutable, task scoped and survive restart',async t=>{
  const dir=directory(t),source=path.join(dir,'site.key'),secret='-----BEGIN PRIVATE KEY-----\nTEST-SECRET-DO-NOT-SEND\n-----END PRIVATE KEY-----';fs.writeFileSync(source,secret);
  const storage=new AgentStorage(dir,vault),files=new AgentAttachments(storage);const [item]=await files.importFiles([source]);
  assert.equal(item.access,'transfer-only');assert.equal(item.key,undefined);assert.equal(item.path,undefined);
  assert.ok(!fs.readFileSync(path.join(files.directory,item.id)).includes(Buffer.from(secret)));
  const task=storage.create('配置域名',['a'],'plan');files.bind([item.id],task);fs.writeFileSync(source,'changed');
  assert.equal(files.read(item.id,task).toString(),secret);assert.throws(()=>files.read(item.id,{id:'other',attachments:[item]}),/范围/);
  assert.throws(()=>files.bind([item.id],storage.create('other',[],'plan')),/其他消息/);
  assert.throws(()=>files.drop(item.id),/随任务删除/);
  const restored=new AgentAttachments(new AgentStorage(dir,vault));assert.equal(restored.read(item.id,task).toString(),secret);
  assert.ok(!fs.readFileSync(path.join(storage.directory,'tasks.json'),'utf8').includes(secret));
  storage.remove(task.id);files.removeTask(task.id);assert.equal(fs.existsSync(path.join(files.directory,item.id)),false);
});
test('attachment limits, batch rollback, draft cleanup and authentication failure',async t=>{
  const dir=directory(t),storage=new AgentStorage(dir,vault),files=new AgentAttachments(storage),source=path.join(dir,'a');fs.writeFileSync(source,'hello');
  const large=path.join(dir,'large');fs.closeSync(fs.openSync(large,'w'));fs.truncateSync(large,MAX_FILE+1);
  await assert.rejects(files.importFiles([source,large]),/25 MB/);assert.equal(files.items.length,0);assert.deepEqual(fs.readdirSync(files.directory),[]);
  await assert.rejects(files.importFiles(Array(11).fill(source)),/10/);
  const [draft]=await files.importFiles([source]);assert.throws(()=>files.validate([draft.id,draft.id]),/列表/);
  const restored=new AgentAttachments(new AgentStorage(dir,vault));assert.equal(restored.items.length,0);assert.ok(!fs.existsSync(path.join(files.directory,draft.id)));
  const [item]=await restored.importFiles([source]);const task=storage.create('test',[],'plan');restored.bind([item.id],task);
  fs.writeFileSync(path.join(files.directory,item.id),'corrupted');assert.throws(()=>restored.read(item.id,task));
});
test('Plan and inspect reject attachment upload, metadata reaches model but bytes do not',async t=>{
  for(const mode of ['plan','inspect']){
    const dir=directory(t),source=path.join(dir,'certificate.key');const secret='unique-private-file-content';fs.writeFileSync(source,secret);
    let rounds=0,uploads=0;const requests=[];
    const hosts={get:id=>({id}),list:()=>[{id:'a'}],route:id=>[{id}],password:()=>''};
    const agent=new AgentService({directory:dir,vault,hosts,remoteFactory:()=>({jobs:new Map(),close(){},uploadAttachment(){uploads++;}}),complete:async(_s,_k,messages,tools)=>{
      requests.push({messages,tools});return {tokens:1,message:response(rounds++===0?[call('upload_attachment',{attachmentId:item.id,hostId:'a',directory:'/tmp'})]:mode==='plan'?[]:[call('finish_task',{outcome:'needs_input',summary:'等待',evidenceIds:[]})],mode==='plan'?'先讨论用途':null).choices[0].message};
    }});
    const [item]=await agent.attachments.importFiles([source]);agent.configure({baseUrl:'https://example.com/v1',model:'fixture'});
    const task=await agent.start({prompt:'配置域名',hostIds:['a'],mode,attachmentIds:[item.id]});await agent.active.done;
    assert.equal(uploads,0);assert.equal(task.events.find(e=>e.name==='upload_attachment').status,'failed');
    assert.ok(JSON.stringify(requests).includes(item.id));assert.ok(!JSON.stringify(requests).includes(secret));assert.ok(!JSON.stringify(task).includes(secret));
    assert.ok(requests.every(r=>!r.tools.some(t=>t.function.name==='upload_attachment')));
  }
});
test('SFTP attachment upload preserves binary bytes, verifies hash and creates separate staging paths',{timeout:30000},async t=>{
  const dir=directory(t),fixture=await startFixture(dir);t.after(()=>fixture.close());
  const controller=new AbortController(),remote=new AgentRemote({routes:new Map([['a',[{id:'a',address:'127.0.0.1',port:fixture.port,username:'tester',auth:'password'}]]]),credentials:{a:{password:'local-test'}},verify:async()=>true,signal:controller.signal});t.after(()=>remote.close());
  const data=randomBytes(70001),item={id:'attachment',name:'../证书.tar.gz',sha256:createHash('sha256').update(data).digest('hex')},progress=[];
  const result=await remote.uploadAttachment('a','/',item,data,n=>progress.push(n));
  assert.deepEqual(fs.readFileSync(path.join(dir,result.path)),data);assert.equal(result.verified,true);assert.equal(result.deploymentVerified,false);assert.equal(progress.at(-1),100);
  const next=await remote.uploadAttachment('a','/',item,data);assert.notEqual(next.path,result.path);
  await assert.rejects(remote.uploadAttachment('outside','/',item,data),/范围/);
  await assert.rejects(remote.uploadAttachment('a','relative',item,data),/绝对/);
  const count=fs.readdirSync(dir).length;await assert.rejects(remote.uploadAttachment('a','/',{...item,sha256:'incorrect'},data),/校验失败/);assert.equal(fs.readdirSync(dir).length,count);
});
