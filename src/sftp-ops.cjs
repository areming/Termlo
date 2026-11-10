// SFTP file operations for the file manager: remove, rename, mkdir -p and
// recursive transfers with progress, cancellation and conflict handling.
//
// Transfers work on two "adapters" (local disk and remote SFTP) that expose the
// same small interface, so upload and download share one engine and the engine
// can be tested with two local adapters.
//
// Safety rules:
// - Symlinks are never followed: they are skipped during transfers and removed
//   as links (not their targets) during recursive deletes.
// - Every file is written to a temporary name and renamed into place, so an
//   interrupted transfer never leaves a truncated file under the real name.
// - Recursive delete refuses '/', empty paths and top-level paths ('/etc')
//   unless the caller explicitly passes { force: true }.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const atomicFile = require('./atomic-file.cjs');

const CONFLICT_POLICIES = ['ask', 'overwrite', 'skip', 'rename'];
const CONFLICT_CHOICES = ['overwrite', 'skip', 'rename'];
const SFTP_NO_SUCH_FILE = 2;
const MAX_ENTRIES = 200000;
const MAX_RENAME_ATTEMPTS = 9999;
const PROGRESS_INTERVAL_MS = 100;
const STREAM_CHUNK = 256 * 1024;
const DEFAULT_CONCURRENCY = 4;

function call(object, method, ...args) {
  return new Promise((resolve, reject) => {
    object[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
  });
}

function checkPath(value, label = '远程路径') {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 8192) {
    throw new Error(`${label}无效`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Path guard for destructive operations
// ---------------------------------------------------------------------------

// Returns the normalized absolute path, or throws when the path is too dangerous
// to delete recursively. Only '/a/b' (two segments) and deeper pass without force;
// '/' never passes.
function guardRemovalPath(target, { force = false } = {}) {
  if (typeof target !== 'string' || !target.trim()) throw new Error('删除路径为空');
  if (target.includes('\0')) throw new Error('删除路径无效');
  if (!target.startsWith('/')) throw new Error('删除目录需要使用绝对路径');
  const normalized = path.posix.normalize(target).replace(/\/+$/, '') || '/';
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length) throw new Error('拒绝删除根目录 /');
  if (segments.length < 2 && !force) {
    throw new Error(`拒绝递归删除顶层目录 ${normalized}，如确需删除请显式确认`);
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Conflict handling
// ---------------------------------------------------------------------------

// 'archive.tar.gz' -> ['archive.tar', '.gz']; '.bashrc' -> ['.bashrc', ''].
function splitExtension(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}

// numberedName('report.pdf', 1) -> 'report (1).pdf'.
// An existing counter is continued: numberedName('report (3).pdf', 1) -> 'report (4).pdf'.
function numberedName(name, attempt, { directory = false } = {}) {
  const [stem, extension] = directory ? [name, ''] : splitExtension(name);
  const counted = stem.match(/^(.*) \((\d+)\)$/);
  const base = counted ? counted[1] : stem;
  const start = counted ? Number(counted[2]) : 0;
  return `${base} (${start + attempt})${extension}`;
}

// Finds the first free "name (n).ext" inside `directory` on the given adapter.
async function freeName(adapter, directory, name, { directory: isDirectory = false } = {}) {
  for (let attempt = 1; attempt <= MAX_RENAME_ATTEMPTS; attempt++) {
    const candidate = numberedName(name, attempt, { directory: isDirectory });
    if (!(await adapter.stat(adapter.join(directory, candidate)))) return candidate;
  }
  throw new Error(`无法为 ${name} 找到可用的新名称`);
}

// Turns a policy (+ optional async `ask` callback) into a per-conflict resolver.
// `ask(conflict)` may return 'overwrite' | 'skip' | 'rename' | 'cancel', or
// { policy, applyToAll }. With applyToAll the answer is reused for later conflicts.
function createConflictResolver(policy = 'ask', ask) {
  if (!CONFLICT_POLICIES.includes(policy)) throw new Error(`未知的冲突策略：${policy}`);
  if (policy === 'ask' && typeof ask !== 'function') {
    throw new Error('冲突策略为 ask 时需要提供冲突处理回调');
  }
  let remembered = policy === 'ask' ? null : policy;
  return async conflict => {
    if (remembered) return remembered;
    const answer = await ask(conflict);
    const { policy: choice, applyToAll = false } = typeof answer === 'string' ? { policy: answer } : answer || {};
    if (choice === 'cancel') throw abortError('已取消传输');
    if (!CONFLICT_CHOICES.includes(choice)) throw new Error('冲突处理结果无效');
    if (applyToAll) remembered = choice;
    return choice;
  };
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

function typeOf(stats) {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return 'other';
}

function describe(stats, mtimeMs) {
  return { type: typeOf(stats), size: Number(stats.size) || 0, mode: stats.mode & 0o7777, modified: mtimeMs };
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

function localAdapter() {
  const windows = process.platform === 'win32';
  return {
    kind: 'local',
    join: (...parts) => path.join(...parts),
    basename: value => path.basename(value),
    checkName(name) {
      if (windows && (/[<>:"\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || WINDOWS_RESERVED.test(name))) {
        throw new Error(`文件名在 Windows 上不可用：${name}`);
      }
    },
    async stat(target) {
      try {
        const stats = await fs.promises.lstat(target);
        return describe(stats, stats.mtimeMs);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
      }
    },
    async list(directory) {
      const names = await fs.promises.readdir(directory);
      const entries = [];
      for (const name of names) {
        const stat = await this.stat(path.join(directory, name));
        if (stat) entries.push({ name, stat });
      }
      return entries;
    },
    mkdir: target => fs.promises.mkdir(target),
    createReadStream: target => fs.createReadStream(target, { highWaterMark: STREAM_CHUNK }),
    createWriteStream: (target, mode) => fs.createWriteStream(target, { flags: 'wx', mode: mode ?? 0o666 }),
    replace: (from, to) => atomicFile.rename(from, to),
    async renameNew(from, to) {
      if (await this.stat(to)) throw new Error(`目标在传输期间被创建：${to}`);
      await atomicFile.rename(from, to);
    },
    unlink: target => fs.promises.unlink(target),
    // Local files keep sensible permissions; uploads from Windows have no POSIX modes.
    fileMode: stat => (windows ? null : stat.mode & 0o777),
  };
}

function remoteAdapter(sftp) {
  return {
    kind: 'remote',
    join: (...parts) => path.posix.join(...parts),
    basename: value => path.posix.basename(value),
    checkName() {},
    async stat(target) {
      try {
        const stats = await call(sftp, 'lstat', target);
        return describe(stats, (stats.mtime || 0) * 1000);
      } catch (error) {
        if (error.code === SFTP_NO_SUCH_FILE) return null;
        throw error;
      }
    },
    async list(directory) {
      const items = await call(sftp, 'readdir', directory);
      return items
        .filter(item => item.filename !== '.' && item.filename !== '..')
        .map(item => ({ name: item.filename, stat: describe(item.attrs, (item.attrs.mtime || 0) * 1000) }));
    },
    mkdir: target => call(sftp, 'mkdir', target, {}),
    createReadStream: target => sftp.createReadStream(target, { highWaterMark: STREAM_CHUNK }),
    createWriteStream: (target, mode) =>
      sftp.createWriteStream(target, { flags: 'wx', mode: mode ?? 0o644, highWaterMark: STREAM_CHUNK }),
    replace: (from, to) => replaceRemote(sftp, from, to),
    // SFTP v3 RENAME (as implemented by OpenSSH) fails when the destination exists.
    renameNew: (from, to) => call(sftp, 'rename', from, to),
    unlink: target => call(sftp, 'unlink', target),
    fileMode: stat => stat.mode & 0o777,
  };
}

// Rename that overwrites the destination. Uses the atomic posix-rename extension
// when the server offers it, otherwise removes the destination first.
async function replaceRemote(sftp, from, to) {
  try {
    await call(sftp, 'ext_openssh_rename', from, to);
    return;
  } catch (error) {
    if (!/does not support/i.test(error.message)) throw error;
  }
  try {
    await call(sftp, 'unlink', to);
  } catch (error) {
    if (error.code !== SFTP_NO_SUCH_FILE) throw error;
  }
  await call(sftp, 'rename', from, to);
}

// ---------------------------------------------------------------------------
// Simple remote operations
// ---------------------------------------------------------------------------

async function remoteStat(sftp, target) {
  return remoteAdapter(sftp).stat(target);
}

async function removeFile(sftp, target) {
  checkPath(target);
  const normalized = path.posix.normalize(target);
  if (normalized === '/' || normalized === '.' || normalized === '..') throw new Error('删除路径无效');
  const stat = await remoteStat(sftp, normalized);
  if (!stat) throw new Error(`文件不存在：${normalized}`);
  if (stat.type === 'directory') throw new Error(`${normalized} 是目录，请使用删除目录`);
  await call(sftp, 'unlink', normalized);
}

// Deletes a directory tree. Symlinks inside are removed as links; their targets
// are untouched. Returns { files, directories } removed.
async function removeTree(sftp, target, { force = false, signal, onProgress } = {}) {
  const normalized = guardRemovalPath(target, { force });
  // Re-check after resolving symlinks in the parent path ('/tmp/rootlink/etc').
  const realParent = await call(sftp, 'realpath', path.posix.dirname(normalized));
  const real = guardRemovalPath(path.posix.join(realParent, path.posix.basename(normalized)), { force });

  const stat = await remoteStat(sftp, real);
  if (!stat) throw new Error(`目录不存在：${real}`);
  const counts = { files: 0, directories: 0 };
  if (stat.type !== 'directory') {
    await call(sftp, 'unlink', real);
    counts.files++;
    return counts;
  }

  const walk = async directory => {
    signal?.throwIfAborted();
    const items = await call(sftp, 'readdir', directory);
    for (const item of items) {
      if (item.filename === '.' || item.filename === '..' || item.filename.includes('/')) continue;
      const child = path.posix.join(directory, item.filename);
      if (item.attrs.isDirectory() && !item.attrs.isSymbolicLink()) {
        await walk(child);
      } else {
        signal?.throwIfAborted();
        await call(sftp, 'unlink', child);
        counts.files++;
        onProgress?.({ ...counts, current: child });
      }
    }
    await call(sftp, 'rmdir', directory);
    counts.directories++;
    onProgress?.({ ...counts, current: directory });
  };
  await walk(real);
  return counts;
}

// Renames or moves a remote path. Refuses to replace an existing destination
// unless { overwrite: true } (files only).
async function renameRemote(sftp, from, to, { overwrite = false } = {}) {
  checkPath(from);
  checkPath(to);
  const source = await remoteStat(sftp, from);
  if (!source) throw new Error(`源路径不存在：${from}`);
  const existing = await remoteStat(sftp, to);
  if (existing) {
    if (!overwrite) throw new Error(`目标已存在：${to}`);
    if (existing.type === 'directory' || source.type === 'directory') throw new Error('不能用重命名覆盖目录');
    await replaceRemote(sftp, from, to);
    return;
  }
  await call(sftp, 'rename', from, to);
}

// mkdir -p. Existing directories are fine; an existing non-directory is an error.
async function mkdirp(sftp, directory) {
  checkPath(directory);
  const normalized = path.posix.normalize(directory);
  const absolute = normalized.startsWith('/');
  const segments = normalized.split('/').filter(segment => segment && segment !== '.');
  let current = absolute ? '/' : '';
  for (const segment of segments) {
    current = current ? path.posix.join(current, segment) : segment;
    const stat = await remoteStat(sftp, current);
    if (stat?.type === 'directory') continue;
    if (stat) throw new Error(`路径已存在且不是目录：${current}`);
    try {
      await call(sftp, 'mkdir', current, {});
    } catch (error) {
      // Lost a race with another creator: accept if it is now a directory.
      if ((await remoteStat(sftp, current))?.type !== 'directory') throw error;
    }
  }
  return absolute ? path.posix.normalize(current) : current;
}

// ---------------------------------------------------------------------------
// Transfer engine
// ---------------------------------------------------------------------------

function abortError(message = '已取消传输') {
  return new DOMException(message, 'AbortError');
}

// Waits for `promise`, but rejects as soon as `signal` aborts.
function untilAborted(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function checkEntryName(name, adapter) {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new Error(`文件名无效：${JSON.stringify(name)}`);
  }
  adapter.checkName(name);
}

// Lists the source tree in pre-order (directories before their contents).
async function scanTree(adapter, root, signal) {
  const rootStat = await adapter.stat(root);
  if (!rootStat) throw new Error(`源路径不存在：${root}`);
  const entries = [];
  const visit = async (sourcePath, rel, stat) => {
    signal?.throwIfAborted();
    if (entries.length >= MAX_ENTRIES) throw new Error(`文件数量超过 ${MAX_ENTRIES}，请分批传输`);
    entries.push({ source: sourcePath, rel, ...stat });
    if (stat.type !== 'directory') return;
    const children = await adapter.list(sourcePath);
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      await visit(adapter.join(sourcePath, child.name), [...rel, child.name], child.stat);
    }
  };
  await visit(root, [], rootStat);
  return entries;
}

// Copies `source` (file or directory, on adapter `from`) into `targetDirectory`
// (on adapter `to`). Options:
//   name              target name for the top entry (default: source basename)
//   conflict          'ask' | 'overwrite' | 'skip' | 'rename' (default 'ask')
//   resolveConflict   async (conflict) => choice, required for 'ask'
//   onProgress        ({ bytesDone, bytesTotal, filesDone, filesTotal, currentFile, done })
//   signal            AbortSignal
//   concurrency       files copied in parallel (default 4)
// Resolves to { target, files, directories, bytes, skipped: [{ path, reason }] }.
// On error or abort, files already completed stay in place; partial files are removed.
// Retrying with conflict 'skip' therefore resumes an interrupted transfer.
async function transferTree({
  from,
  to,
  source,
  targetDirectory,
  name,
  conflict = 'ask',
  resolveConflict,
  onProgress,
  signal,
  concurrency = DEFAULT_CONCURRENCY,
}) {
  signal?.throwIfAborted();
  const resolve = createConflictResolver(conflict, resolveConflict);
  const targetStat = await to.stat(targetDirectory);
  if (targetStat?.type !== 'directory') throw new Error(`目标目录不存在：${targetDirectory}`);

  const entries = await scanTree(from, source, signal);
  const fileEntries = entries.filter(entry => entry.type === 'file');
  const state = {
    bytesDone: 0,
    bytesTotal: fileEntries.reduce((sum, entry) => sum + entry.size, 0),
    filesDone: 0,
    filesTotal: fileEntries.length,
    currentFile: null,
  };
  let lastReport = 0;
  const report = (force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
    lastReport = now;
    onProgress({ ...state });
  };
  const dropFromTotals = entry => {
    if (entry.type !== 'file') return;
    state.bytesTotal -= entry.size;
    state.filesTotal -= 1;
  };

  // Parallel file copies. The first failure (or the caller's abort) stops the rest.
  const internal = new AbortController();
  const jobSignal = signal ? AbortSignal.any([signal, internal.signal]) : internal.signal;
  const running = new Set();
  let failure = null;
  const checkStopped = () => {
    signal?.throwIfAborted();
    if (failure) throw failure;
  };
  const launch = async job => {
    while (running.size >= Math.max(1, concurrency)) await Promise.race(running);
    checkStopped();
    const task = job()
      .catch(error => {
        if (!failure) failure = error;
        internal.abort(error);
      })
      .finally(() => running.delete(task));
    running.add(task);
  };

  const result = { target: null, files: 0, directories: 0, bytes: 0, skipped: [] };
  // rel key of a created/merged directory -> { path, fresh }. Nothing can conflict
  // inside a directory this transfer just created, so its children skip the stat.
  const destinations = new Map();
  const keyOf = rel => rel.join('\0');

  try {
    for (const entry of entries) {
      checkStopped();
      const top = entry.rel.length === 0;
      const parent = top
        ? { path: targetDirectory, fresh: false }
        : destinations.get(keyOf(entry.rel.slice(0, -1)));
      if (!parent) {
        dropFromTotals(entry); // inside a skipped directory
        continue;
      }
      if (entry.type === 'symlink' || entry.type === 'other') {
        result.skipped.push({ path: entry.source, reason: entry.type });
        continue;
      }
      let destName = top ? name ?? from.basename(source) : entry.rel.at(-1);
      checkEntryName(destName, to);
      let destination = to.join(parent.path, destName);
      let mode = 'create';

      const existing = parent.fresh ? null : await to.stat(destination);
      if (existing) {
        const mergeQuietly = !top && entry.type === 'directory' && existing.type === 'directory';
        const choice = mergeQuietly
          ? 'overwrite'
          : await untilAborted(
              resolve({
                source: entry.source,
                target: destination,
                name: destName,
                type: entry.type,
                incoming: { type: entry.type, size: entry.size, modified: entry.modified },
                existing: { type: existing.type, size: existing.size, modified: existing.modified },
              }),
              jobSignal,
            );
        if (choice === 'skip') {
          result.skipped.push({ path: entry.source, reason: 'conflict' });
          dropFromTotals(entry);
          if (top) result.target = destination;
          continue;
        }
        if (choice === 'rename') {
          destName = await freeName(to, parent.path, destName, { directory: entry.type === 'directory' });
          destination = to.join(parent.path, destName);
        } else {
          const incomingIsDirectory = entry.type === 'directory';
          if (incomingIsDirectory !== (existing.type === 'directory')) {
            throw new Error(
              incomingIsDirectory
                ? `无法用目录覆盖同名文件：${destination}`
                : `无法用文件覆盖同名目录：${destination}`,
            );
          }
          mode = incomingIsDirectory ? 'merge' : 'overwrite';
        }
      }
      if (top) result.target = destination;

      if (entry.type === 'directory') {
        if (mode === 'create') await to.mkdir(destination);
        destinations.set(keyOf(entry.rel), { path: destination, fresh: mode === 'create' });
        result.directories++;
        continue;
      }

      const overwrite = mode === 'overwrite';
      await launch(async () => {
        state.currentFile = entry.source;
        report(true);
        const written = await copyFile({ from, to, entry, destination, overwrite, state, report, signal: jobSignal });
        result.files++;
        result.bytes += written;
        state.filesDone++;
      });
    }
    await Promise.all(running);
    checkStopped();
  } catch (error) {
    internal.abort(error);
    await Promise.all(running);
    // Prefer the caller's abort, then the first copy failure, over secondary errors.
    signal?.throwIfAborted();
    throw failure || error;
  }

  state.currentFile = null;
  onProgress?.({ ...state, done: true });
  return result;
}

async function copyFile({ from, to, entry, destination, overwrite, state, report, signal }) {
  const temporary = `${destination}.termlo-${randomUUID().slice(0, 8)}.part`;
  const mode = from.fileMode(entry) ?? undefined;
  let created = false;
  let written = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      written += chunk.length;
      state.bytesDone += chunk.length;
      report();
      callback(null, chunk);
    },
  });
  try {
    const output = to.createWriteStream(temporary, mode);
    created = true;
    await pipeline(from.createReadStream(entry.source), meter, output, { signal });
    // Never clobber a destination that appeared while copying unless overwriting was chosen.
    if (overwrite) await to.replace(temporary, destination);
    else await to.renameNew(temporary, destination);
    created = false;
    return written;
  } catch (error) {
    // Undo this file's contribution so totals stay meaningful.
    state.bytesDone -= written;
    throw error;
  } finally {
    if (created) await to.unlink(temporary).catch(() => {});
  }
}

module.exports = {
  CONFLICT_POLICIES,
  guardRemovalPath,
  splitExtension,
  numberedName,
  freeName,
  createConflictResolver,
  localAdapter,
  remoteAdapter,
  removeFile,
  removeTree,
  renameRemote,
  mkdirp,
  transferTree,
};
