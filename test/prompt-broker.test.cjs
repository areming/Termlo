const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PromptBroker } = require('../src/prompt-broker.cjs');

test('every prompt is followed by a closed notice, whether answered or cancelled', async () => {
  const events = [];
  const broker = new PromptBroker(event => events.push(event));
  const answered = broker.ask({ message: '删除？', buttons: ['取消', '删除'] });
  const opened = events[0];
  assert.equal(opened.type, 'app-prompt');
  assert.throws(() => broker.answer(opened.id, 5), /无效/);
  broker.answer(opened.id, 1);
  assert.deepEqual(await answered, { response: 1 });
  assert.deepEqual(events.at(-1), { type: 'app-prompt-closed', id: opened.id });
  assert.equal(broker.answer(opened.id, 0), false);

  const cancelled = broker.ask({ message: '继续？' });
  broker.cancelAll();
  assert.deepEqual(await cancelled, { response: 0 });
  assert.equal(events.filter(e => e.type === 'app-prompt-closed').length, 2);
});
