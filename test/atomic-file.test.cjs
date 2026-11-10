const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const atomicFile = require('../src/atomic-file.cjs');

const locked = (code, failures) => { let calls = 0; return { calls: () => calls, rename: () => { calls++; if (calls <= failures) throw Object.assign(new Error(code), { code }); } }; };

test('rename retries transient Windows lock errors until the destination is released', async () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const sync = locked(code, 3), waits = [];
    atomicFile.renameSync('a', 'b', { attempts: 10, rename: sync.rename, wait: ms => waits.push(ms) });
    assert.equal(sync.calls(), 4); assert.deepEqual(waits, [10, 20, 40]);
    const async = locked(code, 2);
    await atomicFile.rename('a', 'b', { attempts: 10, rename: async () => async.rename(), wait: async () => {} });
    assert.equal(async.calls(), 3);
  }
});

test('rename gives up after the attempt budget and never retries other errors', async () => {
  const stuck = locked('EPERM', Infinity);
  assert.throws(() => atomicFile.renameSync('a', 'b', { attempts: 4, rename: stuck.rename, wait: () => {} }), { code: 'EPERM' });
  assert.equal(stuck.calls(), 4);
  const missing = locked('ENOENT', Infinity);
  assert.throws(() => atomicFile.renameSync('a', 'b', { attempts: 10, rename: missing.rename, wait: () => {} }), { code: 'ENOENT' });
  assert.equal(missing.calls(), 1);
  const asyncMissing = locked('ENOENT', Infinity);
  await assert.rejects(atomicFile.rename('a', 'b', { attempts: 10, rename: async () => asyncMissing.rename(), wait: async () => {} }), { code: 'ENOENT' });
  assert.equal(asyncMissing.calls(), 1);
});

test('rename replaces an existing file on the real filesystem', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termlo-atomic-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'data.json'), temp = target + '.tmp';
  fs.writeFileSync(target, 'old'); fs.writeFileSync(temp, 'new');
  atomicFile.renameSync(temp, target);
  assert.equal(fs.readFileSync(target, 'utf8'), 'new'); assert.equal(fs.existsSync(temp), false);
});
