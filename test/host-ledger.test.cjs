const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {HostLedger,parseProbe}=require('../src/host-ledger.cjs');
const {AgentService}=require('../src/agent.cjs');
const {Workspaces}=require('../src/workspaces.cjs');
const {Store}=require('../src/store.cjs');

const sample=(boot='boot-1')=>({bootId:boot,kernel:'Linux 6.1',os:'Debian',memoryTotalKiB:4096,rootTotalKiB:10000,rootUsedKiB:1000,rootAvailableKiB:9000,fingerprint:boot});
const host={id:'host-a',name:'Alpha',address:'192.0.2.5',port:22,username:'root'};
const temp=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'termus-host-ledger-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};

test('lightweight probe parses bounded non-secret host facts',()=>{
  const data=parseProbe('BOOT=boot-1\nKERNEL=Linux 6.1\nOS="Debian"\nMEM=4096\nROOT=10000 1000 9000\nEND\n');
  assert.equal(data.bootId,'boot-1');assert.equal(data.rootAvailableKiB,9000);assert.equal(data.fingerprint.length,64);
  const packageChanged=parseProbe('BOOT=boot-1\nKERNEL=Linux 6.1\nOS="Debian"\nMEM=4096\nROOT=10000 1000 9000\nPKG=123:456\nUNITS=42:10\n');
  const packageChangedAgain=parseProbe('BOOT=boot-1\nKERNEL=Linux 6.1\nOS="Debian"\nMEM=4096\nROOT=10000 1000 9000\nPKG=124:456\nUNITS=42:10\n');
  assert.notEqual(packageChanged.fingerprint,packageChangedAgain.fingerprint);
  assert.throws(()=>parseProbe('password=secret\nROOT=100 1 99'),/不支持/);
});

test('per-host versions survive restart; unchanged checks do not add versions',async t=>{
  const dir=temp(t),remote={};let boot='boot-1';
  let ledger=new HostLedger(dir,{probe:async()=>sample(boot)});
  assert.equal(ledger.status(host).status,'untracked');
  await ledger.check(host,remote);assert.equal(ledger.status(host).status,'tracked');assert.equal(ledger.status(host).revision,1);
  await ledger.check(host,remote);assert.equal(ledger.status(host).revision,1);
  const task={id:'task-1',changeLedger:{changes:[{id:'change-1',operationId:'op-1',hostId:host.id,kind:'write_file',resource:'/site',state:'applied',reversibility:'controlled'}]}};
  ledger.syncTask(task,[host]);assert.equal(ledger.status(host).revision,2);
  assert.equal(ledger.page(host,{limit:1}).entries[0].kind,'change');
  ledger.syncTask(task,[host]);assert.equal(ledger.status(host).revision,2);
  boot='boot-2';await ledger.check(host,remote);assert.equal(ledger.status(host).status,'changed');assert.equal(ledger.status(host).revision,3);
  ledger=new HostLedger(dir,{probe:async()=>{throw Error('private-token');}});
  assert.equal(ledger.status(host).revision,3);
  await ledger.check(host,remote);assert.equal(ledger.status(host).status,'unavailable');
  assert.equal(ledger.status({...host,address:'192.0.2.6'}).status,'identity_changed');
  const content=fs.readFileSync(ledger.file(host.id),'utf8');assert.ok(content.includes('task-1'));assert.ok(!content.includes('private-token'));assert.ok(!content.includes('password'));
});

test('each agent model invocation probes selected hosts and another model sees the same ledger',async t=>{
  const dir=temp(t),hosts={list:()=>[host],get:()=>host,route:()=>[host],password:()=>''},vault={isEncryptionAvailable:()=>true};
  let probes=0,completions=0;
  const options={directory:dir,hosts,vault,remoteFactory:()=>({jobs:new Map(),close(){}}),probeHost:async()=>{probes++;return sample();},complete:async(_settings,_key,messages)=>{completions++;assert.match(messages[0].content,/主机跟踪摘要/);assert.match(messages[0].content,/"status":"tracked"/);return {tokens:1,message:{role:'assistant',content:'方案先讨论'}};}};
  let agent=new AgentService(options);agent.configure({baseUrl:'https://example.test/v1',model:'model-a'});
  await agent.start({prompt:'规划部署',hostIds:[host.id],mode:'plan'});await waitFor(()=>!agent.active);
  assert.equal(probes,1);assert.equal(completions,1);assert.equal(agent.state().hostTracking[0].status,'tracked');agent.close();
  agent=new AgentService(options);agent.configure({baseUrl:'https://example.test/v1',model:'model-b'});
  await agent.start({prompt:'重新规划',hostIds:[host.id],mode:'plan'});await waitFor(()=>!agent.active);
  assert.equal(probes,2);assert.equal(completions,2);assert.equal(agent.state().hostTracking[0].revision,1);agent.close();
});

test('moving a host to another space carries its ledger; copying starts a separate history',async t=>{
  const dir=temp(t),vault={isEncryptionAvailable:()=>true,encryptString:x=>Buffer.from(x),decryptString:x=>x.toString()},spaces=new Workspaces(dir),store=new Store(dir,vault);
  store.save({name:'Alpha',address:'192.0.2.5',port:22,username:'root'});
  const original=store.list()[0],sourceLedger=new HostLedger(dir,{probe:async()=>sample()});await sourceLedger.check(original,{});
  const other=spaces.create('space','Second');spaces.copyHosts(store,other.spaceId,[original.id]);
  const copied=new Store(spaces.find('local',other.spaceId).directory,vault).list()[0];
  assert.equal(new HostLedger(spaces.find('local',other.spaceId).directory).status(copied).status,'untracked');
  const third=spaces.create('space','Third');spaces.moveHosts(store,third.spaceId,[original.id]);
  const moved=new Store(spaces.find('local',third.spaceId).directory,vault).list()[0];
  assert.equal(new HostLedger(spaces.find('local',third.spaceId).directory).status(moved).status,'tracked');
});

test('manual host check needs no model call, reports progress and stops duplicate checks',async t=>{
  const dir=temp(t),vault={isEncryptionAvailable:()=>true},hosts={list:()=>[host],get:()=>host,route:()=>[host],password:()=>''};
  let release,modelCalls=0,closed=0;
  const agent=new AgentService({directory:dir,vault,hosts,remoteFactory:()=>({close(){closed++;}}),probeHost:()=>new Promise(resolve=>{release=resolve;}),complete:async()=>{modelCalls++;}});
  const checking=agent.checkHosts({hostIds:[host.id]});await waitFor(()=>!!release);
  assert.equal(agent.state().hostCheckActive,true);assert.equal(agent.state().hostTracking[0].status,'checking');
  await assert.rejects(agent.checkHosts({hostIds:[host.id]}),/核对中/);
  release(sample());const result=await checking;
  assert.equal(result[0].status,'tracked');assert.equal(agent.state().hostCheckActive,false);assert.equal(modelCalls,0);assert.equal(closed,1);
  agent.close();
});

async function waitFor(fn){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('timeout');await new Promise(resolve=>setTimeout(resolve,10));}}
