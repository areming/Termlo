const {test}=require('node:test');
const assert=require('node:assert/strict');
const ledger=require('../src/task-changes.cjs');
const task=()=>({events:[],changeLedger:undefined});
const host={id:'a',address:'example.test',port:22,username:'ops'};
test('task ledger records real dispatch and treats saved rows as reference only',()=>{
  const t=task(),unit=ledger.begin(t,{title:'更新站点版本',hostIds:['a'],checks:['HTTP 200']});
  const c=ledger.dispatch(t,{name:'write_file',args:{hostId:'a',path:'/srv/site/current',unitId:unit.id},eventId:'e1',host});
  assert.equal(c.state,'dispatched');assert.equal(c.reversibility,'controlled');
  ledger.settleChange(t,'e1',{status:'completed',sha256:'abc'});
  assert.equal(c.state,'applied');assert.equal(unit.status,'running');
  const page=ledger.page(t,{unitId:unit.id});assert.equal(page.referenceOnly,true);assert.equal(page.total,1);
  ledger.onRun(t,'next-run');assert.equal(t.changeLedger.runId,'next-run');
  assert.match(ledger.summary(t),/next-run/);
});
test('ledger never turns interrupted work into a completed change',()=>{
  const t=task();ledger.dispatch(t,{name:'exec_remote',args:{hostId:'a',command:'install'},eventId:'e1',host});
  ledger.onRun(t,'r2');assert.equal(t.changeLedger.changes[0].state,'unknown');
  ledger.settleChange(t,'e1',{status:'timeout'});assert.equal(t.changeLedger.changes[0].state,'unknown');
  assert.throws(()=>ledger.dispatch(t,{name:'write_file',args:{hostId:'a',unitId:'missing',path:'/x'},eventId:'e2',host}),/单元不存在/);
});
test('file verification requires fresh evidence for the exact host, path and hash',()=>{
  const t=task(),u=ledger.begin(t,{title:'更新配置',hostIds:['a']}),c=ledger.dispatch(t,{name:'write_file',args:{hostId:'a',path:'/etc/site',unitId:u.id},eventId:'write',host});
  ledger.settleChange(t,'write',{sha256:'abc'});const start=new Date().toISOString();
  t.events.push({id:'wrong',name:'read_file',at:new Date().toISOString(),status:'completed',args:{hostId:'a',path:'/other'},result:{sha256:'abc'}});
  assert.throws(()=>ledger.verify(t,{changeId:c.id,evidenceIds:['wrong']},start),/同主机同路径/);
  t.events.push({id:'right',name:'read_file',at:new Date().toISOString(),status:'completed',args:{hostId:'a',path:'/etc/site'},result:{sha256:'abc'}});
  assert.equal(ledger.verify(t,{changeId:c.id,evidenceIds:['right']},start).state,'verified');assert.equal(u.status,'verified');
});
