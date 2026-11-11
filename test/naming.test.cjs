// The Termus -> Termlo rename: the data folder moves once, and undo records written by
// 2.0.1 and earlier (with termus- paths on the server) still validate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDataDir } = require('../src/data-dir.cjs');
const { AgentRemote } = require('../src/agent-remote.cjs');

function appData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termlo-appdata-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the Termus data folder moves to Termlo in one rename, with everything inside it', t => {
  const root = appData(t);
  fs.mkdirSync(path.join(root, 'Termus', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Termus', 'hosts.json'), '{"version":1}');
  fs.writeFileSync(path.join(root, 'Termus', 'Local State'), 'key');
  const result = resolveDataDir(root);
  assert.deepEqual(result, { directory: path.join(root, 'Termlo'), moved: true });
  assert.ok(!fs.existsSync(path.join(root, 'Termus')));
  assert.equal(fs.readFileSync(path.join(root, 'Termlo', 'Local State'), 'utf8'), 'key');
  assert.ok(fs.existsSync(path.join(root, 'Termlo', 'agent')));
  // Second launch: nothing to move.
  assert.deepEqual(resolveDataDir(root), { directory: path.join(root, 'Termlo'), moved: false });
});

test('an existing Termlo folder wins, a fresh install gets Termlo, and a failed move keeps the old folder', t => {
  const root = appData(t);
  assert.equal(resolveDataDir(root).directory, path.join(root, 'Termlo'));

  fs.mkdirSync(path.join(root, 'Termus'));
  const locked = resolveDataDir(root, { rename: () => { throw new Error('EBUSY'); } });
  assert.equal(locked.directory, path.join(root, 'Termus'));
  assert.equal(locked.moved, false);
  assert.ok(fs.existsSync(path.join(root, 'Termus')));

  fs.mkdirSync(path.join(root, 'Termlo'));
  assert.equal(resolveDataDir(root).directory, path.join(root, 'Termlo'));
  assert.ok(fs.existsSync(path.join(root, 'Termus')), 'both exist: the old folder is left alone');
});

test('undo and clean accept this task\'s recovery folder under both names, and nothing else', async () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const other = '99999999-2222-4333-8444-555555555555';
  const remote = new AgentRemote({ routes: new Map([['h1', []]]), credentials: {}, verify: async () => true, signal: new AbortController().signal, recoveryId: id });
  assert.equal(remote.ownRecoveryDirectory('/tmp/termlo-recovery-' + id), true);
  assert.equal(remote.ownRecoveryDirectory('/tmp/termus-recovery-' + id), true);
  for (const bad of ['/tmp/termlo-recovery-' + other, '/tmp/termus-recovery-' + other, '/tmp/termlo-recovery-' + id + '/..', '/tmp/other-recovery-' + id, undefined]) {
    assert.equal(remote.ownRecoveryDirectory(bad), false, String(bad));
  }
  const record = dir => ({ hostId: 'h1', path: '/etc/a.conf', recovery: { directory: dir, backup: dir + '/x.original' } });
  await assert.rejects(remote.undoWrite(record('/tmp/termlo-recovery-' + other)), /撤销记录无效/);
  await assert.rejects(remote.cleanRecovery([record('/tmp/termus-recovery-' + other)]), /清理记录无效/);
  // Staging folders: both prefixes, still a strict uuid shape.
  const staging = folder => ({ hostId: 'h1', folder, path: folder + '/payload', sha256: 'x' });
  await assert.rejects(remote.cleanStaging(staging('/tmp/termlo-nope')), /附件暂存记录无效/);
  await assert.rejects(remote.cleanStaging(staging('/tmp/other-' + id)), /附件暂存记录无效/);
  remote.close();
});
