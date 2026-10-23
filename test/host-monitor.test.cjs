const test=require('node:test'),assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const {parseSample,deriveSample,HostMonitor}=require('../src/host-monitor.cjs');const {metricsFixture}=require('./metrics-fixture.cjs');const {PromptBroker}=require('../src/prompt-broker.cjs');
test('Linux monitor derives interval CPU/network and distinguishes missing counters from zero',()=>{
  const first=parseSample(metricsFixture(0)),second=parseSample(metricsFixture(1));const initial=deriveSample(first,null);assert.equal(initial.cpu,null);assert.equal(initial.network,null);
  const result=deriveSample(second,first);assert.equal(result.cpu,40);assert.equal(result.memory.percent,37.5);assert.equal(result.disk.percent,30);assert.equal(result.network.rx,65536);assert.equal(result.network.tx,20480);
  assert.equal(deriveSample(first,second).cpu,null);assert.equal(deriveSample(first,second).network,null);
  second.interfaces.eth1={rx:0,tx:0};assert.equal(deriveSample(second,first).network,null);
  assert.equal(parseSample(metricsFixture().replace('MemAvailable: 5242880 kB','')).memory,null);
  assert.throws(()=>parseSample('UNSUPPORTED\n'),/不支持/);
});
test('monitor shares a sampler per host, preserves last data as disconnected and restarts after reconnect',async t=>{
  let count=0;const values=[];const monitor=new HostMonitor({interval:15,read:async()=>metricsFixture(count++),notify:e=>values.push(e.metrics)});t.after(()=>monitor.close());
  const session=()=>Object.assign(new EventEmitter(),{connected:true,closed:false});const one=session(),two=session();monitor.attach('a',one);monitor.attach('a',two);
  await new Promise(r=>setTimeout(r,5));assert.equal(count,1);assert.equal(monitor.snapshot().length,1);
  one.emit('status','closed');assert.notEqual(monitor.snapshot()[0].status,'disconnected');two.emit('status','closed');assert.equal(monitor.snapshot()[0].status,'disconnected');const stopped=count;
  await new Promise(r=>setTimeout(r,30));assert.equal(count,stopped);const three=session();monitor.attach('a',three);await new Promise(r=>setTimeout(r,5));assert.equal(count,stopped+1);assert.equal(monitor.snapshot()[0].status,'live');assert.equal(monitor.snapshot()[0].cpu,null);
});
test('application prompts require a matching pending ID, validate choices and cancel on reload',async()=>{
  const events=[],broker=new PromptBroker(e=>events.push(e));const pending=broker.ask({message:'Trust?',buttons:['Cancel','Trust']});const id=events[0].id;
  assert.equal(broker.answer('wrong',1),false);assert.throws(()=>broker.answer(id,2),/无效/);broker.answer(id,1);assert.deepEqual(await pending,{response:1});assert.equal(broker.answer(id,1),false);
  const cancelled=broker.ask({message:'Trust?'});broker.cancelAll();assert.deepEqual(await cancelled,{response:0});
});
