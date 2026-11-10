#!/usr/bin/env node
// SFTP integration check against a real, disposable SSH host.
//
//   node scripts/sftp-integration.cjs
//
// Credentials come from ~/.config/termlo/bench.env (never committed):
//   TERMLO_BENCH_HOST, TERMLO_BENCH_USER, TERMLO_BENCH_PASSWORD [, TERMLO_BENCH_PORT]
// Skips (exit 0) when the file is missing. Works only under /tmp/termlo-sftp-test
// on the remote host and removes it afterwards.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SSHSession } = require('../src/ssh.cjs');

const ENV_FILE = path.join(os.homedir(), '.config', 'termlo', 'bench.env');
const REMOTE_ROOT = '/tmp/termlo-sftp-test';

function loadEnv(file) {
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function call(object, method, ...args) {
  return new Promise((resolve, reject) => object[method](...args, (error, value) => (error ? reject(error) : resolve(value))));
}

async function step(name, action) {
  const started = Date.now();
  await action();
  console.log(`  ok  ${name} (${Date.now() - started} ms)`);
}

async function main() {
  if (!fs.existsSync(ENV_FILE)) {
    console.log(`skip: ${ENV_FILE} not found`);
    return;
  }
  const env = loadEnv(ENV_FILE);
  if (!env.TERMLO_BENCH_HOST || !env.TERMLO_BENCH_USER || !env.TERMLO_BENCH_PASSWORD) {
    console.log('skip: TERMLO_BENCH_HOST/USER/PASSWORD not set');
    return;
  }

  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'termlo-sftp-it-'));
  const ssh = new SSHSession();
  ssh.on('fault', message => console.error('fault:', message));
  try {
    const host = {
      id: 'it',
      name: 'integration',
      address: env.TERMLO_BENCH_HOST,
      port: Number(env.TERMLO_BENCH_PORT || 22),
      username: env.TERMLO_BENCH_USER,
      auth: 'password',
    };
    // Disposable test VM: accept its key, but show it.
    await ssh.connectRoute([host], { it: { password: env.TERMLO_BENCH_PASSWORD } }, (_host, fingerprint) => {
      console.log(`connected, host key ${fingerprint}`);
      return true;
    });
    const sftp = await ssh.sftp();
    const remote = (...parts) => path.posix.join(REMOTE_ROOT, ...parts);

    // Fresh workspace.
    if (await ssh.list('/tmp').then(r => r.files.some(f => f.name === 'termlo-sftp-test'))) {
      await ssh.removeDirectory(REMOTE_ROOT);
    }

    // Local fixture tree: many small files, one larger binary, nested dirs.
    const tree = path.join(local, 'tree');
    for (let i = 0; i < 40; i++) write(path.join(tree, 'small', `file-${String(i).padStart(2, '0')}.txt`), `file ${i}\n`.repeat(i + 1));
    write(path.join(tree, 'nested', 'deep', 'deeper', 'note.md'), '# deep\n');
    const big = Buffer.alloc(12 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE(i, i);
    write(path.join(tree, 'big.bin'), big);
    fs.mkdirSync(path.join(tree, 'empty'));

    await step('mkdirp creates nested directories and is idempotent', async () => {
      assert.equal(await ssh.mkdirp(remote('upload', 'here')), remote('upload', 'here'));
      await ssh.mkdirp(remote('upload'));
    });

    await step('recursive upload with progress', async () => {
      const events = [];
      const result = await ssh.upload(tree, remote('upload'), { conflict: 'skip', onProgress: event => events.push(event) });
      assert.equal(result.target, remote('upload', 'tree'));
      assert.equal(result.files, 42);
      const last = events.at(-1);
      assert.equal(last.done, true);
      assert.equal(last.bytesDone, last.bytesTotal);
      assert.equal(last.filesDone, 42);
      console.log(`      ${result.files} files, ${(result.bytes / 1048576).toFixed(1)} MiB, ${events.length} progress events`);
    });

    await step('uploading again with rename creates "tree (1)"; ask + apply-to-all asks once', async () => {
      const renamed = await ssh.upload(tree, remote('upload'), { conflict: 'rename' });
      assert.equal(renamed.target, remote('upload', 'tree (1)'));
      let asked = 0;
      const merged = await ssh.upload(tree, remote('upload'), {
        conflict: 'ask',
        resolveConflict: async () => {
          asked++;
          return { policy: 'overwrite', applyToAll: true };
        },
      });
      assert.equal(asked, 1);
      assert.equal(merged.files, 42);
    });

    await step('single file overwrite and rename-on-conflict (name (1).ext)', async () => {
      write(path.join(local, 'single', 'note.md'), '# replaced\n');
      await ssh.upload(path.join(local, 'single', 'note.md'), remote('upload', 'tree', 'nested', 'deep', 'deeper'), { conflict: 'overwrite' });
      const second = await ssh.upload(path.join(local, 'single', 'note.md'), remote('upload', 'tree', 'nested', 'deep', 'deeper'), { conflict: 'rename' });
      assert.equal(second.target, remote('upload', 'tree', 'nested', 'deep', 'deeper', 'note (1).md'));
      const listing = await ssh.list(remote('upload', 'tree', 'nested', 'deep', 'deeper'));
      assert.deepEqual(listing.files.map(f => f.name).sort(), ['note (1).md', 'note.md']);
    });

    await step('remote symlinks are skipped on download and removed as links', async () => {
      await call(sftp, 'symlink', '/etc', remote('upload', 'tree', 'etc-link'));
      const downloads = path.join(local, 'downloads');
      fs.mkdirSync(downloads);
      const result = await ssh.download(remote('upload', 'tree'), downloads, { conflict: 'overwrite' });
      assert.deepEqual(result.skipped, [{ path: remote('upload', 'tree', 'etc-link'), reason: 'symlink' }]);
      assert.equal(result.files, 43);
      assert.equal(sha256(path.join(downloads, 'tree', 'big.bin')), sha256(path.join(tree, 'big.bin')));
      assert.equal(fs.readFileSync(path.join(downloads, 'tree', 'small', 'file-07.txt'), 'utf8'), 'file 7\n'.repeat(8));
      assert.equal(fs.readFileSync(path.join(downloads, 'tree', 'nested', 'deep', 'deeper', 'note.md'), 'utf8'), '# replaced\n');
      assert.ok(fs.existsSync(path.join(downloads, 'tree', 'empty')));
      assert.ok(!fs.existsSync(path.join(downloads, 'tree', 'etc-link')));
    });

    await step('abort mid-upload leaves no partial file', async () => {
      const controller = new AbortController();
      await assert.rejects(
        ssh.upload(path.join(tree, 'big.bin'), remote('upload'), {
          name: 'aborted.bin',
          conflict: 'overwrite',
          signal: controller.signal,
          onProgress: event => {
            if (event.bytesDone > 1024 * 1024) controller.abort();
          },
        }),
        { name: 'AbortError' },
      );
      const names = (await ssh.list(remote('upload'))).files.map(f => f.name);
      assert.ok(!names.includes('aborted.bin'), 'final name never appears');
      assert.ok(!names.some(name => name.endsWith('.part')), `no partial files: ${names.join(', ')}`);
    });

    await step('rename / move refuses to clobber, then moves', async () => {
      await assert.rejects(ssh.rename(remote('upload', 'tree (1)'), remote('upload', 'tree')), /目标已存在/);
      await ssh.rename(remote('upload', 'tree (1)'), remote('moved'));
      assert.ok((await ssh.list(REMOTE_ROOT)).files.some(f => f.name === 'moved'));
    });

    await step('remove file and guarded recursive delete', async () => {
      await assert.rejects(ssh.removeFile(remote('moved', 'small')), /是目录/);
      await ssh.removeFile(remote('moved', 'big.bin'));
      await assert.rejects(ssh.removeDirectory('/tmp'), /顶层目录/);
      await assert.rejects(ssh.removeDirectory('/', { force: true }), /根目录/);
      await assert.rejects(ssh.removeDirectory(''), /无效|为空/);
      const removed = await ssh.removeDirectory(remote('upload', 'tree'));
      assert.ok(removed.files >= 43);
      // The symlink was unlinked, its target is untouched.
      assert.ok((await ssh.list('/etc')).files.length > 0);
    });
  } finally {
    if (ssh.connected) {
      await ssh.removeDirectory(REMOTE_ROOT).catch(error => console.error('cleanup failed:', error.message));
      const left = (await ssh.list('/tmp')).files.some(f => f.name === 'termlo-sftp-test');
      console.log(left ? 'cleanup: remote directory still present!' : `cleanup: removed ${REMOTE_ROOT}`);
    }
    ssh.close();
    fs.rmSync(local, { recursive: true, force: true });
  }
  console.log('sftp integration: all checks passed');
}

main().catch(error => {
  console.error('sftp integration FAILED:', error);
  process.exitCode = 1;
});
