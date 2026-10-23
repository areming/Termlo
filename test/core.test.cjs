const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { once } = require('node:events');
const { SSHSession } = require('../src/ssh.cjs');
const { Store, normalizeHost } = require('../src/store.cjs');
const { startFixture } = require('./fixture.cjs');
const base = { name: 'Test', address: '127.0.0.1', port: 22, username: 'tester', auth: 'password', group: 'Test' };
const key = randomBytes(32), iv = randomBytes(16);
const vault = { isEncryptionAvailable: () => true, encryptString(text) { const c = createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([c.update(text), c.final()]); }, decryptString(bytes) { const c = createDecipheriv('aes-256-cbc', key, iv); return Buffer.concat([c.update(bytes), c.final()]).toString(); } };
function temp(t) { const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'termus-test-')); t.after(() => fs.rmSync(folder, { recursive: true, force: true })); return folder; }
test('host persistence, encrypted password, endpoint change and fingerprint storage', t => {
  const folder = temp(t); const store = new Store(folder, vault);
  store.save({ ...base, password: 'secret-value', rememberPassword: true });
  let host = store.list()[0]; assert.equal(host.hasPassword, true); assert.equal(host.password, undefined); assert.equal(host.encryptedPassword, undefined);
  assert.equal(fs.readFileSync(store.file, 'utf8').includes('secret-value'), false);
  assert.equal(new Store(folder, vault).password(host.id), 'secret-value');
  store.trust(host, 'SHA256:abc'); assert.equal(new Store(folder, vault).known(host), 'SHA256:abc');
  store.save({ ...host, address: 'localhost' }); assert.equal(store.list()[0].hasPassword, false);
  store.remove(host.id); assert.equal(store.list().length, 0);
});
test('invalid host settings and unavailable encryption fail without modifying disk', t => {
  assert.throws(() => normalizeHost({ ...base, port: 99999 }), /端口/);
  assert.throws(() => normalizeHost({ ...base, address: 'ssh://example.com' }), /地址/);
  const store = new Store(temp(t), { isEncryptionAvailable: () => false });
  assert.throws(() => store.save({ ...base, password: 'secret', rememberPassword: true }), /加密/);
  assert.equal(store.list().length, 0);
});
test('SSH password, interactive terminal, resize, SFTP binary roundtrip and no overwrite', { timeout: 30000 }, async t => {
  const folder = temp(t), remote = path.join(folder, 'remote');
  const fixture = await startFixture(remote); t.after(() => fixture.close());
  const ssh = new SSHSession(); t.after(() => ssh.close());
  let receivedFingerprint;
  await ssh.connect({ ...base, port: fixture.port }, { password: 'local-test' }, fingerprint => { receivedFingerprint = fingerprint; return fingerprint === fixture.fingerprint; });
  assert.equal(receivedFingerprint, fixture.fingerprint);
  const data = []; ssh.on('data', chunk => data.push(Buffer.from(chunk, 'base64').toString()));
  await ssh.shell(); ssh.resize(120, 40);
  const gotData = once(ssh, 'data'); ssh.write('hello\r'); await gotData;
  await new Promise(resolve => setTimeout(resolve, 150)); assert.match(data.join(''), /received: hello/);
  await ssh.mkdir('/uploads'); assert.equal((await ssh.list('/')).files[0].name, 'uploads');
  const bytes = randomBytes(256 * 1024 + 37), source = path.join(folder, 'source.bin'), target = path.join(folder, 'download.bin'); fs.writeFileSync(source, bytes);
  let progress;
  await ssh.transfer('upload', source, '/uploads/文件.bin', value => { progress = value; });
  assert.equal(progress.done, true); assert.equal(progress.transferred, bytes.length);
  await assert.rejects(ssh.transfer('upload', source, '/uploads/文件.bin'), /已存在/);
  await ssh.transfer('download', target, '/uploads/文件.bin'); assert.deepEqual(fs.readFileSync(target), bytes);
  assert.deepEqual(fs.readdirSync(path.join(remote, 'uploads')), ['文件.bin']);
  const closed = once(ssh, 'status'); ssh.close(); await closed;
  await assert.rejects(ssh.list('/'), /断开/);
});
test('SSH rejects unknown/changed fingerprints and wrong passwords', { timeout: 20000 }, async t => {
  const fixture = await startFixture(temp(t)); t.after(() => fixture.close());
  for (const [credentials, verify, pattern] of [[{ password: 'local-test' }, () => false, /verification failed/], [{ password: 'wrong' }, () => true, /authentication methods failed/]]) {
    const ssh = new SSHSession(); try { await assert.rejects(ssh.connect({ ...base, port: fixture.port }, credentials, verify), pattern); } finally { ssh.close(); }
  }
});
test('encrypted private key authentication and independent concurrent sessions', { timeout: 20000 }, async t => {
  const folder = temp(t), fixture = await startFixture(path.join(folder, 'remote')); t.after(() => fixture.close());
  const keyPath = path.join(folder, 'id_ed25519'); fs.writeFileSync(keyPath, fixture.clientKey.private);
  const first = new SSHSession(), second = new SSHSession(); t.after(() => { first.close(); second.close(); });
  await Promise.all([first.connect({ ...base, port: fixture.port, auth: 'key', keyPath }, { passphrase: 'key-test' }, () => true), second.connect({ ...base, port: fixture.port }, { password: 'local-test' }, () => true)]);
  await Promise.all([first.shell(), second.shell()]);
  first.close(); assert.equal(second.connected, true); assert.equal((await second.list('/')).path, '/');
});
