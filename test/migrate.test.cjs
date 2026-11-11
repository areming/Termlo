const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrate, MARKER } = require('../src/migrate.cjs');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const ORPHAN = '44444444-4444-4444-8444-444444444444';

function write(root, file, data) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), JSON.stringify(data));
}
const host = (id, name, address, extra = {}) => ({ id, name, address, port: 22, username: 'root', auth: 'password', group: '未分组', jumpHostId: '', ...extra });

function layout(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termlo-migrate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'hosts.json', { version: 1, hosts: [host('d1', 'local', '10.0.0.1', { encryptedPassword: 'x' })], knownHosts: { '["10.0.0.1",22]': 'SHA256:a' } });
  write(root, 'workspaces.json', { version: 1, accounts: [
    { id: 'local', spaces: [{ id: 'default', name: 'Default' }, { id: A, name: '客户 A' }] },
    { id: B, name: 'AreMing', spaces: [{ id: C, name: '默认项目' }] },
  ] });
  write(root, `spaces/${A}/hosts.json`, { hosts: [
    host('a2', 'web', '10.0.1.2', { jumpHostId: 'a1' }),
    host('a1', 'bastion', '10.0.1.1', { jumpHostId: 'a0' }),
    host('a0', 'edge', '10.0.1.0'),
    host('dup', 'local again', '10.0.0.1'),
  ], knownHosts: { '["10.0.1.1",22]': 'SHA256:b', '["10.0.0.1",22]': 'SHA256:changed' } });
  write(root, `accounts/${B}/spaces/${C}/hosts.json`, { hosts: [host('k1', 'kewan', '47.0.0.1', { encryptedPassword: 'y', group: '生产' })], knownHosts: {} });
  write(root, `spaces/${ORPHAN}/hosts.json`, { hosts: [], knownHosts: { '["10.9.9.9",22]': 'SHA256:c' } });
  write(root, 'assistant/settings.json', { baseUrl: 'https://api.example/v1', model: 'm', maxRounds: 30, encryptedKey: 'k' });
  return root;
}

test('every 1.x space, including account spaces and orphaned folders, ends up in one host list', t => {
  const root = layout(t);
  const before = fs.readFileSync(path.join(root, `spaces/${A}/hosts.json`), 'utf8');
  const report = migrate(root);
  assert.equal(report.hosts, 4);
  assert.equal(report.duplicates, 1);
  const data = JSON.parse(fs.readFileSync(path.join(root, 'hosts.json'), 'utf8'));
  const byName = Object.fromEntries(data.hosts.map(h => [h.name, h]));
  assert.deepEqual(Object.keys(byName).sort(), ['bastion', 'edge', 'kewan', 'local', 'web']);
  assert.equal(byName.kewan.group, 'AreMing · 默认项目 · 生产');
  assert.equal(byName.kewan.encryptedPassword, 'y');
  assert.equal(byName.web.group, '客户 A');
  // Jump chains are remapped to the new ids at every depth.
  assert.equal(byName.web.jumpHostId, byName.bastion.id);
  assert.equal(byName.bastion.jumpHostId, byName.edge.id);
  assert.equal(new Set(data.hosts.map(h => h.id)).size, data.hosts.length);
  // Fingerprints merge; the existing entry wins.
  assert.equal(data.knownHosts['["10.0.0.1",22]'], 'SHA256:a');
  assert.equal(data.knownHosts['["10.0.1.1",22]'], 'SHA256:b');
  assert.equal(data.knownHosts['["10.9.9.9",22]'], 'SHA256:c');
  // Model settings move; old files are left untouched.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'agent/settings.json'), 'utf8')), { baseUrl: 'https://api.example/v1', model: 'm', maxRounds: 60, encryptedKey: 'k' });
  assert.equal(fs.readFileSync(path.join(root, `spaces/${A}/hosts.json`), 'utf8'), before);
  assert.ok(fs.existsSync(path.join(root, 'assistant/settings.json')));
});

test('migration runs once', t => {
  const root = layout(t);
  migrate(root);
  const after = fs.readFileSync(path.join(root, 'hosts.json'), 'utf8');
  assert.equal(migrate(root), null);
  assert.equal(fs.readFileSync(path.join(root, 'hosts.json'), 'utf8'), after);
  assert.ok(fs.existsSync(path.join(root, MARKER)));
});

test('a fresh install writes only the marker', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termlo-migrate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(migrate(root), null);
  assert.deepEqual(fs.readdirSync(root), [MARKER]);
});
