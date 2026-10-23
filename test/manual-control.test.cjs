const test=require('node:test'),assert=require('node:assert/strict');
const {ManualControl}=require('../src/manual-control.cjs');
const {TOOLS}=require('../src/agent.cjs');
test('manual reservations block model execution during connection setup and enforce task scope',()=>{
  const control=new ManualControl(),task={id:'task',hostIds:['a','b']};
  assert.throws(()=>control.reserve('one',task,'outside'),/范围/);control.assertFree();
  control.reserve('one',task,'a');assert.throws(()=>control.assertFree(),/手动终端/);
  assert.throws(()=>control.reserve('two',task,'a'),/已有/);control.reserve('two',task,'b');
  control.release('one');assert.throws(()=>control.assertFree(),/手动终端/);control.release('two');control.assertFree();
});
test('model tool surface contains no cross-task memory or local shell and file tools',()=>{
  const names=TOOLS.map(t=>t.function.name);assert.ok(!names.includes('remember'));assert.ok(!names.includes('search_memory'));
  assert.deepEqual(names.filter(n=>n.includes('exec')),['exec_remote']);assert.ok(names.includes('inspect_host'));
});
