const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/app/host-order.mjs');
const hosts = [{ id: 'a', name: 'web' }, { id: 'b', name: 'db' }, { id: 'c', name: 'cache' }, { id: 'd', name: 'api' }];
const names = list => list.map(h => h.name);

test('without a saved order hosts sort by name; saved ids come first, new hosts after by name', async () => {
  const { orderHosts } = await load();
  assert.deepEqual(names(orderHosts(hosts)), ['api', 'cache', 'db', 'web']);
  assert.deepEqual(names(orderHosts(hosts, ['a', 'b'])), ['web', 'db', 'api', 'cache']);
  assert.deepEqual(names(orderHosts(hosts, ['gone', 'c'])), ['cache', 'api', 'db', 'web']);
});

test('moving a host before or after another keeps every host exactly once', async () => {
  const { moveHost } = await load();
  assert.deepEqual(moveHost(hosts, [], 'a', 'd'), ['a', 'd', 'c', 'b']);
  assert.deepEqual(moveHost(hosts, [], 'd', 'a', true), ['c', 'b', 'a', 'd']);
  assert.deepEqual(moveHost(hosts, ['a', 'b', 'c', 'd'], 'b', 'b'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(moveHost(hosts, ['a', 'b', 'c', 'd'], 'a', 'missing'), ['a', 'b', 'c', 'd']);
});
