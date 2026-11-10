const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const ops = require('../src/sftp-ops.cjs');
const { SSHSession } = require('../src/ssh.cjs');
const { startFixture } = require('./fixture.cjs');

function temp(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'termlo-sftp-ops-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// Lists every file under `root` as relative posix paths with content.
function snapshot(root) {
  const out = {};
  const walk = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out[rel + '/'] = true;
        walk(full, rel);
      } else if (entry.isFile()) out[rel] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(root, '');
  return out;
}

const local = ops.localAdapter();
const copy = options => ops.transferTree({ from: local, to: local, ...options });

test('removal guard refuses root, empty, relative and top-level paths unless forced', () => {
  for (const bad of ['', '   ', '/', '//', '/./', '/..', '/tmp/..', 'relative/path']) {
    assert.throws(() => ops.guardRemovalPath(bad), Error, bad);
  }
  assert.throws(() => ops.guardRemovalPath('/', { force: true }), /根目录/);
  assert.throws(() => ops.guardRemovalPath('/etc'), /顶层目录/);
  assert.throws(() => ops.guardRemovalPath('/home/user/..'), /顶层目录/);
  assert.equal(ops.guardRemovalPath('/etc', { force: true }), '/etc');
  assert.equal(ops.guardRemovalPath('/tmp/a/'), '/tmp/a');
  assert.equal(ops.guardRemovalPath('/tmp//x/../y'), '/tmp/y');
});

test('numbered names keep the extension and continue existing counters', () => {
  assert.equal(ops.numberedName('report.pdf', 1), 'report (1).pdf');
  assert.equal(ops.numberedName('report.pdf', 2), 'report (2).pdf');
  assert.equal(ops.numberedName('archive.tar.gz', 1), 'archive.tar (1).gz');
  assert.equal(ops.numberedName('.bashrc', 1), '.bashrc (1)');
  assert.equal(ops.numberedName('README', 1), 'README (1)');
  assert.equal(ops.numberedName('report (3).pdf', 1), 'report (4).pdf');
  assert.equal(ops.numberedName('release.v1.2', 1, { directory: true }), 'release.v1.2 (1)');
});

test('conflict resolver: fixed policies, ask, apply-to-all, cancel and validation', async () => {
  assert.throws(() => ops.createConflictResolver('merge'), /未知/);
  assert.throws(() => ops.createConflictResolver('ask'), /回调/);
  assert.equal(await ops.createConflictResolver('skip')({}), 'skip');

  const asked = [];
  const answers = ['rename', { policy: 'overwrite', applyToAll: true }];
  const resolve = ops.createConflictResolver('ask', async conflict => {
    asked.push(conflict.name);
    return answers.shift();
  });
  assert.equal(await resolve({ name: 'a' }), 'rename');
  assert.equal(await resolve({ name: 'b' }), 'overwrite');
  assert.equal(await resolve({ name: 'c' }), 'overwrite');
  assert.deepEqual(asked, ['a', 'b'], 'apply-to-all stops further questions');

  await assert.rejects(ops.createConflictResolver('ask', async () => 'cancel')({}), { name: 'AbortError' });
  await assert.rejects(ops.createConflictResolver('ask', async () => 'ask')({}), /无效/);
});

test('directory transfer copies the tree with progress and leaves no temporary files', async t => {
  const root = temp(t);
  const source = path.join(root, 'src', 'site');
  write(path.join(source, 'index.html'), 'hello');
  write(path.join(source, 'assets', 'app.js'), 'x'.repeat(300000));
  write(path.join(source, 'assets', 'deep', 'empty.txt'), '');
  fs.mkdirSync(path.join(source, 'empty-dir'));
  const target = path.join(root, 'dst');
  fs.mkdirSync(target);

  const events = [];
  const result = await copy({ source, targetDirectory: target, conflict: 'overwrite', onProgress: event => events.push(event) });
  assert.equal(result.target, path.join(target, 'site'));
  assert.equal(result.files, 3);
  assert.equal(result.directories, 4);
  assert.equal(result.bytes, 300005);
  assert.deepEqual(snapshot(target), {
    'site/': true,
    'site/assets/': true,
    'site/assets/app.js': 'x'.repeat(300000),
    'site/assets/deep/': true,
    'site/assets/deep/empty.txt': '',
    'site/empty-dir/': true,
    'site/index.html': 'hello',
  });
  const last = events.at(-1);
  assert.deepEqual(last, { bytesDone: 300005, bytesTotal: 300005, filesDone: 3, filesTotal: 3, currentFile: null, done: true });
  assert.ok(events.some(event => event.currentFile === path.join(source, 'assets', 'app.js')));
  for (let i = 1; i < events.length; i++) assert.ok(events[i].bytesDone >= events[i - 1].bytesDone);
});

test('conflict policies: skip, overwrite (merge), rename and ask per file', async t => {
  const root = temp(t);
  const source = path.join(root, 'src', 'proj');
  write(path.join(source, 'a.txt'), 'new-a');
  write(path.join(source, 'sub', 'b.txt'), 'new-b');
  write(path.join(source, 'sub', 'c.txt'), 'new-c');
  const seed = name => {
    const target = path.join(root, name);
    write(path.join(target, 'proj', 'a.txt'), 'old-a');
    write(path.join(target, 'proj', 'sub', 'b.txt'), 'old-b');
    write(path.join(target, 'proj', 'keep.txt'), 'keep');
    return target;
  };

  const skipTarget = seed('skip');
  const skipped = await copy({ source, targetDirectory: skipTarget, conflict: 'skip' });
  assert.deepEqual(skipped.skipped, [{ path: source, reason: 'conflict' }]);
  assert.equal(skipped.files, 0);
  assert.equal(fs.readFileSync(path.join(skipTarget, 'proj', 'a.txt'), 'utf8'), 'old-a');

  const overwriteTarget = seed('overwrite');
  await copy({ source, targetDirectory: overwriteTarget, conflict: 'overwrite' });
  assert.deepEqual(snapshot(path.join(overwriteTarget, 'proj')), {
    'a.txt': 'new-a',
    'keep.txt': 'keep',
    'sub/': true,
    'sub/b.txt': 'new-b',
    'sub/c.txt': 'new-c',
  });

  const renameTarget = seed('rename');
  fs.mkdirSync(path.join(renameTarget, 'proj (1)'));
  const renamed = await copy({ source, targetDirectory: renameTarget, conflict: 'rename' });
  assert.equal(renamed.target, path.join(renameTarget, 'proj (2)'));
  assert.equal(fs.readFileSync(path.join(renameTarget, 'proj (2)', 'sub', 'b.txt'), 'utf8'), 'new-b');

  // Ask: top directory -> merge, a.txt -> rename, b.txt -> skip.
  const askTarget = seed('ask');
  const conflicts = [];
  const answers = { proj: 'overwrite', 'a.txt': 'rename', 'b.txt': 'skip' };
  const asked = await copy({
    source,
    targetDirectory: askTarget,
    conflict: 'ask',
    resolveConflict: async conflict => {
      conflicts.push([conflict.name, conflict.type, conflict.existing.type]);
      return answers[conflict.name];
    },
  });
  assert.deepEqual(conflicts, [
    ['proj', 'directory', 'directory'],
    ['a.txt', 'file', 'file'],
    ['b.txt', 'file', 'file'],
  ]);
  assert.deepEqual(snapshot(path.join(askTarget, 'proj')), {
    'a (1).txt': 'new-a',
    'a.txt': 'old-a',
    'keep.txt': 'keep',
    'sub/': true,
    'sub/b.txt': 'old-b',
    'sub/c.txt': 'new-c',
  });
  assert.equal(asked.files, 2);
});

test('single-file transfer: overwrite replaces, type mismatches are refused', async t => {
  const root = temp(t);
  const file = path.join(root, 'notes.txt');
  write(file, 'v2');
  const target = path.join(root, 'out');
  write(path.join(target, 'notes.txt'), 'v1');
  await copy({ source: file, targetDirectory: target, conflict: 'overwrite' });
  assert.equal(fs.readFileSync(path.join(target, 'notes.txt'), 'utf8'), 'v2');

  fs.mkdirSync(path.join(target, 'dir.txt'));
  await assert.rejects(copy({ source: file, targetDirectory: target, name: 'dir.txt', conflict: 'overwrite' }), /覆盖同名目录/);
  await assert.rejects(copy({ source: file, targetDirectory: path.join(root, 'missing'), conflict: 'skip' }), /目标目录不存在/);
  assert.deepEqual(fs.readdirSync(target).sort(), ['dir.txt', 'notes.txt']);
});

test('symlinks and junctions are skipped, never followed', async t => {
  const root = temp(t);
  const outside = path.join(root, 'outside');
  write(path.join(outside, 'secret.txt'), 'secret');
  const source = path.join(root, 'tree');
  write(path.join(source, 'real.txt'), 'real');
  try {
    fs.symlinkSync(outside, path.join(source, 'link-dir'), 'junction');
  } catch (error) {
    t.skip(`cannot create links here: ${error.code}`);
    return;
  }
  const target = path.join(root, 'out');
  fs.mkdirSync(target);
  const result = await copy({ source, targetDirectory: target, conflict: 'overwrite' });
  assert.deepEqual(result.skipped, [{ path: path.join(source, 'link-dir'), reason: 'symlink' }]);
  assert.deepEqual(snapshot(target), { 'tree/': true, 'tree/real.txt': 'real' });
});

test('abort cancels mid-file, removes the partial file and keeps completed files', async t => {
  const root = temp(t);
  const source = path.join(root, 'big');
  write(path.join(source, 'a-small.txt'), 'done');
  write(path.join(source, 'b-large.bin'), Buffer.alloc(8 * 1024 * 1024, 7));
  const target = path.join(root, 'out');
  fs.mkdirSync(target);
  const controller = new AbortController();
  // A source that delivers one chunk and then stalls, so the abort lands mid-file.
  let partialSeen = false;
  const stalling = {
    ...local,
    createReadStream(file) {
      if (!file.endsWith('b-large.bin')) return local.createReadStream(file);
      let sent = false;
      return new Readable({
        read() {
          if (sent) return;
          sent = true;
          this.push(Buffer.alloc(1024, 1));
          setTimeout(() => {
            partialSeen = fs.readdirSync(path.join(target, 'big')).some(name => name.endsWith('.part'));
            controller.abort();
          }, 30);
        },
      });
    },
  };
  const events = [];
  await assert.rejects(
    ops.transferTree({
      from: stalling,
      to: local,
      source,
      targetDirectory: target,
      conflict: 'overwrite',
      signal: controller.signal,
      onProgress: event => events.push(event),
    }),
    { name: 'AbortError' },
  );
  assert.ok(partialSeen, 'data was being written to a temporary .part file');
  assert.ok(events.some(event => event.currentFile?.endsWith('b-large.bin')));
  assert.deepEqual(fs.readdirSync(path.join(target, 'big')), ['a-small.txt']);

  // Abort while waiting for the user to answer a conflict.
  const waiting = new AbortController();
  const pending = copy({
    source,
    targetDirectory: target,
    conflict: 'ask',
    signal: waiting.signal,
    resolveConflict: () => new Promise(() => {}),
  });
  setTimeout(() => waiting.abort(), 20);
  await assert.rejects(pending, { name: 'AbortError' });
});

test('a failing file stops the parallel transfer and leaves no partial files', async t => {
  const root = temp(t);
  const source = path.join(root, 'many');
  for (let i = 0; i < 12; i++) write(path.join(source, `f${String(i).padStart(2, '0')}.txt`), 'x'.repeat(50000));
  const target = path.join(root, 'out');
  fs.mkdirSync(target);
  const failing = {
    ...local,
    createReadStream(file) {
      if (file.endsWith('f05.txt')) {
        return new Readable({
          read() {
            this.destroy(new Error('disk read failed'));
          },
        });
      }
      return local.createReadStream(file);
    },
  };
  await assert.rejects(
    ops.transferTree({ from: failing, to: local, source, targetDirectory: target, conflict: 'overwrite', concurrency: 3 }),
    /disk read failed/,
  );
  const left = fs.readdirSync(path.join(target, 'many'));
  assert.ok(!left.some(name => name.endsWith('.part')), left.join(', '));
  assert.ok(!left.includes('f05.txt'));
  assert.ok(left.length < 12);
});

test('SSHSession SFTP operations against the fixture server', { timeout: 30000 }, async t => {
  const root = temp(t);
  const serverRoot = path.join(root, 'server');
  const fixture = await startFixture(serverRoot);
  t.after(() => fixture.close());
  const ssh = new SSHSession();
  t.after(() => ssh.close());
  await ssh.connectRoute(
    [{ id: 'h', name: 'fixture', address: '127.0.0.1', port: fixture.port, username: 'tester', auth: 'password' }],
    { h: { password: 'local-test' } },
    () => true,
  );

  // mkdir -p, idempotent, refuses to descend through a file.
  assert.equal(await ssh.mkdirp('/work/a/b/c'), '/work/a/b/c');
  await ssh.mkdirp('/work/a/b');
  fs.writeFileSync(path.join(serverRoot, 'work', 'file'), 'x');
  await assert.rejects(ssh.mkdirp('/work/file/sub'), /不是目录/);

  // Upload a tree, then upload again with rename.
  const local = path.join(root, 'local', 'site');
  write(path.join(local, 'index.html'), 'hello');
  write(path.join(local, 'css', 'app.css'), 'body{}');
  const uploaded = await ssh.upload(local, '/work', { conflict: 'ask', resolveConflict: async () => 'rename' });
  assert.equal(uploaded.target, '/work/site');
  const again = await ssh.upload(local, '/work', { conflict: 'rename' });
  assert.equal(again.target, '/work/site (1)');
  assert.equal(fs.readFileSync(path.join(serverRoot, 'work', 'site', 'css', 'app.css'), 'utf8'), 'body{}');

  // Overwrite a single remote file (server lacks posix-rename: unlink + rename fallback).
  write(path.join(local, 'index.html'), 'hello v2');
  await ssh.upload(path.join(local, 'index.html'), '/work/site', { conflict: 'overwrite' });
  assert.equal(fs.readFileSync(path.join(serverRoot, 'work', 'site', 'index.html'), 'utf8'), 'hello v2');
  assert.ok(!fs.readdirSync(path.join(serverRoot, 'work', 'site')).some(name => name.endsWith('.part')));

  // Download the tree back.
  const downloads = path.join(root, 'downloads');
  fs.mkdirSync(downloads);
  const downloaded = await ssh.download('/work/site', downloads, { conflict: 'overwrite' });
  assert.equal(downloaded.files, 2);
  assert.deepEqual(snapshot(downloads), {
    'site/': true,
    'site/css/': true,
    'site/css/app.css': 'body{}',
    'site/index.html': 'hello v2',
  });

  // Rename refuses to clobber; remove file / directory with guard.
  await assert.rejects(ssh.rename('/work/site/index.html', '/work/site/css/app.css'), /目标已存在/);
  await ssh.rename('/work/site/index.html', '/work/site/home.html');
  assert.ok(fs.existsSync(path.join(serverRoot, 'work', 'site', 'home.html')));
  await assert.rejects(ssh.removeFile('/work/site/css'), /是目录/);
  await ssh.removeFile('/work/site/home.html');
  assert.ok(!fs.existsSync(path.join(serverRoot, 'work', 'site', 'home.html')));

  await assert.rejects(ssh.removeDirectory('/work'), /顶层目录/);
  await assert.rejects(ssh.removeDirectory('/', { force: true }), /根目录/);
  const removed = await ssh.removeDirectory('/work/site (1)');
  assert.deepEqual(removed, { files: 2, directories: 2 });
  assert.ok(!fs.existsSync(path.join(serverRoot, 'work', 'site (1)')));
  await ssh.removeDirectory('/work', { force: true });
  assert.deepEqual(fs.readdirSync(serverRoot), []);
});
