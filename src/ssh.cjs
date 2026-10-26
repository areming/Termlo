const { Client } = require('ssh2');
const { EventEmitter } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const call = (object, method, ...args) => new Promise((resolve, reject) => object[method](...args, (error, value) => error ? reject(error) : resolve(value)));
function remotePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 8192) throw new Error('远程路径无效');
  return value;
}
class SSHSession extends EventEmitter {
  constructor() {
    super(); this.client = new Client(); this.closed = false; this.connected = false; this.transferring = false; this.hops = [];
    this.client.on('close', () => this.close());
    this.client.on('error', error => this.emit('fault', error.message));
  }
  async connectRoute(route, credentials, verifyHost) {
    try {
      if (!Array.isArray(route) || !route.length || route.length > 5) throw new Error('连接路径无效');
      let previous;
      for (let i = 0; i < route.length; i++) {
        const host = route[i], target = i === route.length - 1;
        if (this.closed) throw new Error('连接已取消');
        this.emit('stage', `${target ? '目标主机' : '跳板机 ' + (i + 1)}：${host.name}`);
        const peer = target ? this : new SSHSession();
        if (!target) {
          this.hops.push(peer);
          peer.on('fault', error => this.emit('fault', `${host.name}：${error}`));
          peer.on('status', status => { if (status === 'closed' && !this.closed) { this.emit('fault', `跳板机 ${host.name} 已断开`); this.close(); } });
        }
        // Remote name resolution happens on the preceding SSH server, never locally.
        const socket = previous ? await previous.forward(host) : undefined;
        if (this.closed) { socket?.destroy(); throw new Error('连接已取消'); }
        try { await peer.connect(host, credentials[host.id] || {}, fingerprint => verifyHost(host, fingerprint), socket); }
        catch (error) { socket?.destroy(); throw new Error(`${host.name}：${error.message}`); }
        previous = peer;
      }
      SSHSession.observe?.(route.at(-1).id, this);
    } catch (error) { this.close(); throw error; }
  }
  forward(host) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error, socket) => {
        if (settled) { socket?.destroy(); return; }
        settled = true; clearTimeout(timer); this.client.off('close', closed);
        if (error) reject(error); else resolve(socket);
      };
      const closed = () => done(new Error('跳板机在转发期间断开'));
      const timer = setTimeout(() => done(new Error(`跳板机无法连接 ${host.address}:${host.port}，转发超时`)), 30000);
      this.client.once('close', closed);
      try { this.client.forwardOut('127.0.0.1', 0, host.address, host.port, done); } catch (error) { done(error); }
    });
  }
  async connect(host, credentials, verifyHost, socket) {
    if (this.closed) throw new Error('连接已取消');
    const client = this.client;
    const options = {
      host: host.address, port: host.port, username: host.username,
      readyTimeout: 120000, keepaliveInterval: 15000, keepaliveCountMax: 3,
      ...(socket ? { sock: socket } : {}),
      hostVerifier: (key, callback) => {
        const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        Promise.resolve().then(() => verifyHost(fingerprint)).then(accept => callback(!!accept), () => callback(false));
      },
    };
    if (host.auth === 'key') {
      if (host.needsKeyFile || !host.keyPath || host.keyPath === '__TERMLO_KEY_REQUIRED__') throw new Error('这台主机的私钥需在本机重新选择');
      const stat = fs.statSync(host.keyPath);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('私钥文件无效或大于 1 MB');
      options.privateKey = fs.readFileSync(host.keyPath);
      options.passphrase = credentials.passphrase || undefined;
    } else { options.password = credentials.password; }
    await new Promise((resolve, reject) => {
      const fail = error => { cleanup(); reject(error); };
      const close = () => fail(new Error('连接在认证完成前已关闭'));
      const ready = () => { cleanup(); this.connected = true; resolve(); };
      const cleanup = () => { client.off('error', fail); client.off('close', close); client.off('ready', ready); };
      client.once('error', fail); client.once('close', close); client.once('ready', ready);
      try { client.connect(options); } catch (error) { fail(error); }
    });
  }
  async shell(cols = 100, rows = 30) {
    this.stream = await new Promise((resolve, reject) => this.client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => err ? reject(err) : resolve(stream)));
    this.stream.on('data', chunk => this.emit('data', chunk.toString('base64')));
    this.stream.stderr.on('data', chunk => this.emit('data', chunk.toString('base64')));
    this.stream.on('error', error => this.emit('fault', error.message));
    this.stream.on('close', () => this.close());
    this.emit('status', 'ready');
  }
  write(data) {
    if (typeof data !== 'string' || data.length > 1024 * 1024) throw new Error('终端输入过长');
    if (!this.connected || !this.stream) throw new Error('终端尚未连接');
    this.stream.write(data);
  }
  resize(cols, rows) {
    if (![cols, rows].every(x => Number.isInteger(x) && x >= 1 && x <= 1000)) throw new Error('终端尺寸无效');
    if (this.stream && this.connected) this.stream.setWindow(rows, cols, 0, 0);
  }
  async sftp() {
    if (!this.connected) throw new Error('SSH 已断开');
    if (!this.sftpPromise) this.sftpPromise = call(this.client, 'sftp').catch(error => { this.sftpPromise = null; throw error; });
    return this.sftpPromise;
  }
  async list(directory) {
    const sftp = await this.sftp();
    const resolved = await call(sftp, 'realpath', remotePath(directory));
    const files = await call(sftp, 'readdir', resolved);
    return {
      path: resolved,
      files: files.filter(f => !['.', '..'].includes(f.filename)).map(f => ({
        name: f.filename, path: path.posix.join(resolved, f.filename),
        directory: f.attrs.isDirectory(), symlink: f.attrs.isSymbolicLink(),
        size: f.attrs.size, modified: f.attrs.mtime * 1000,
      })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)),
    };
  }
  async mkdir(directory) { await call(await this.sftp(), 'mkdir', remotePath(directory)); }
  async transfer(direction, local, remote, progress = () => {}) {
    if (this.transferring) throw new Error('当前连接已有文件正在传输，请稍后');
    this.transferring = true;
    let temporary, sftp;
    try {
      sftp = await this.sftp(); remotePath(remote);
      let total;
      if (direction === 'upload') {
        const stat = await fs.promises.stat(local);
        if (!stat.isFile()) throw new Error('请选择单个文件');
        total = stat.size;
        let exists = false;
        try { await call(sftp, 'lstat', remote); exists = true; } catch (error) { if (error.code !== 2) throw error; }
        if (exists) throw new Error('远程同名文件已存在，请更改名称后上传');
      } else {
        const stat = await call(sftp, 'stat', remote);
        if (!stat.isFile()) throw new Error('仅支持下载普通文件');
        total = stat.size;
      }
      let transferred = 0, last = 0;
      const meter = new Transform({ transform(chunk, encoding, callback) {
        transferred += chunk.length;
        if (Date.now() - last > 100) { last = Date.now(); progress({ transferred, total }); }
        callback(null, chunk);
      } });
      if (direction === 'upload') {
        temporary = remote + '.termus-' + randomUUID() + '.part';
        await pipeline(fs.createReadStream(local), meter, sftp.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
        await call(sftp, 'rename', temporary, remote);
      } else {
        temporary = local + '.termus-' + randomUUID() + '.part';
        await pipeline(sftp.createReadStream(remote), meter, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
        await fs.promises.rename(temporary, local);
      }
      temporary = null;
      progress({ transferred, total, done: true });
    } finally {
      if (temporary) {
        if (direction === 'upload' && this.connected) await call(sftp, 'unlink', temporary).catch(() => {});
        else if (direction !== 'upload') await fs.promises.unlink(temporary).catch(() => {});
      }
      this.transferring = false;
    }
  }
  close() {
    if (this.closed) return;
    this.connected = false; this.closed = true;
    this.client.destroy();
    for (const hop of this.hops) hop.close();
    this.emit('status', 'closed');
  }
}
module.exports = { SSHSession, remotePath };
