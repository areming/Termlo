const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { Store, connectionRoute } = require('../src/store.cjs');
const { SSHSession } = require('../src/ssh.cjs');
const { startFixture } = require('./fixture.cjs');
const base = { name: 'host', address: '127.0.0.1', port: 22, username: 'tester', auth: 'password' };
function temp(t) { const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'termus-jump-')); t.after(() => fs.rmSync(folder, { recursive: true, force: true })); return folder; }
async function setup(t) {
  const root = temp(t),started=[];t.after(async()=>{for(const fixture of started.reverse())await fixture.close();});
  const destination = await startFixture(path.join(root, 'destination'));started.push(destination);
  const inner = await startFixture(path.join(root, 'inner'), { forward: { 'target.internal': destination.port } });started.push(inner);
  const outer = await startFixture(path.join(root, 'outer'), { forward: { 'inner.internal': inner.port } });started.push(outer);
  const route = [{ ...base, id: 'outer', name: 'Outer', port: outer.port }, { ...base, id: 'inner', name: 'Inner', address: 'inner.internal' }, { ...base, id: 'target', name: 'Target', address: 'target.internal' }];
  const auth = Object.fromEntries(route.map(h => [h.id, { password: 'local-test' }]));
  return { root, route, auth, outer, inner, destination };
}
test('routes preserve legacy direct hosts, reject cycles/depth and prevent deleting a referenced gateway', t => {
  const store = new Store(temp(t), {});
  store.save({ ...base, name: 'Gateway' }); const gateway = store.list()[0];
  store.save({ ...base, name: 'Target', jumpHostId: gateway.id }); const target = store.list()[1];
  assert.deepEqual(store.route(target.id).map(h => h.name), ['Gateway', 'Target']);
  assert.throws(() => store.remove(gateway.id), /正在使用/);
  assert.throws(() => store.save({ ...gateway, jumpHostId: target.id }), /循环/);
  assert.throws(() => store.save({ ...base, jumpHostId: 'missing' }), /不存在/);
  assert.equal(store.route(gateway.id).length, 1);
  const hosts = Array.from({ length: 6 }, (_, i) => ({ id: String(i), jumpHostId: i ? String(i - 1) : '' }));
  assert.throws(() => connectionRoute(hosts, '5'), /4 级/);
  assert.equal(connectionRoute(hosts, '4').length, 5);
});
test('two jump hosts: remote DNS, every fingerprint, terminal and SFTP binary roundtrip', { timeout: 30000 }, async t => {
  const f = await setup(t), ssh = new SSHSession(); t.after(() => ssh.close());
  const verified = [];
  await ssh.connectRoute(f.route, f.auth, (host, fingerprint) => { verified.push([host.id, fingerprint]); return true; });
  assert.deepEqual(verified, [['outer', f.outer.fingerprint], ['inner', f.inner.fingerprint], ['target', f.destination.fingerprint]]);
  assert.deepEqual(f.outer.forwarded, ['inner.internal']); assert.deepEqual(f.inner.forwarded, ['target.internal']);
  await ssh.shell();
  const output = new Promise(resolve => { let text = ''; const listener = data => { text += Buffer.from(data, 'base64').toString(); if (text.includes('received: through-jumps')) { ssh.off('data', listener); resolve(text); } }; ssh.on('data', listener); });
  ssh.write('through-jumps\r'); assert.match(await output, /received: through-jumps/);
  const source = path.join(f.root, 'payload.bin'), target = path.join(f.root, 'download.bin'); const bytes = require('node:crypto').randomBytes(180000); fs.writeFileSync(source, bytes);
  await ssh.transfer('upload', source, '/payload.bin'); await ssh.transfer('download', target, '/payload.bin'); assert.deepEqual(fs.readFileSync(target), bytes);
  assert.equal((await ssh.list('/')).files[0].name, 'payload.bin');
  ssh.close(); await new Promise(r => setTimeout(r, 80));
  assert.equal(f.outer.active(), 0); assert.equal(f.inner.active(), 0); assert.equal(f.destination.active(), 0);
});
test('rejecting an inner fingerprint closes the entire chain without reaching target', { timeout: 20000 }, async t => {
  const f = await setup(t), ssh = new SSHSession(); t.after(() => ssh.close());
  await assert.rejects(ssh.connectRoute(f.route, f.auth, host => host.id !== 'inner'), /verification failed/);
  assert.equal(ssh.closed, true); assert.deepEqual(f.inner.forwarded, []);
  await new Promise(r => setTimeout(r, 80)); assert.equal(f.outer.active(), 0);
});
test('jump authentication failure and denied forwarding are reported and cleaned up', { timeout: 20000 }, async t => {
  const f = await setup(t);
  const bad = new SSHSession(); t.after(() => bad.close());
  await assert.rejects(bad.connectRoute(f.route, { ...f.auth, inner: { password: 'wrong' } }, () => true), /Inner.*authentication/);
  const denied = new SSHSession(); t.after(() => denied.close());
  await assert.rejects(denied.connectRoute([f.route[0], { ...f.route[2], address: 'not-allowed.internal' }], f.auth, () => true));
  assert.equal(denied.closed, true);
});
test('lost gateway closes target and encrypted keys work through a jump', { timeout: 20000 }, async t => {
  const f = await setup(t), ssh = new SSHSession(); t.after(() => ssh.close());
  const keyPath = path.join(f.root, 'encrypted-key'); fs.writeFileSync(keyPath, f.destination.clientKey.private);
  f.route[2] = { ...f.route[2], auth: 'key', keyPath }; f.auth.target = { passphrase: 'key-test' };
  await ssh.connectRoute(f.route, f.auth, () => true); await ssh.shell();
  const closed = once(ssh, 'status'); ssh.hops[0].close(); assert.deepEqual(await closed, ['closed']);
  await assert.rejects(ssh.list('/'), /断开/);
});
