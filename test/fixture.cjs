// An isolated SSH/SFTP server for automated tests. Never uses real credentials.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { Server, utils } = require('ssh2');
const { createHash } = require('node:crypto');
const { STATUS_CODE: S, flagsToString } = utils.sftp;
// ssh2's generated OpenSSH keys occasionally fail its own parser on this runtime.
// Validate fixture material before opening any listening socket; never weaken auth.
function fixtureKey(options={}){for(let attempt=0;attempt<4;attempt++){const pair=utils.generateKeyPairSync('ed25519',options),parsed=utils.parseKey(pair.private,options.passphrase);if(parsed&&typeof parsed.getPublicSSH==='function')return pair;}throw new Error('SSH fixture generated no parseable key');}
function startFixture(root, options = {}) {
  fs.mkdirSync(root, { recursive: true });
  const hostKey = fixtureKey();
  const clientKey = fixtureKey({ passphrase: 'key-test', cipher: 'aes256-ctr' });
  const publicKey = utils.parseKey(clientKey.public);
  const clients = new Set();
  const forwarded = [];
  const received = [], shells = [], terminalSizes = [];
  const fingerprint = 'SHA256:' + createHash('sha256').update(utils.parseKey(hostKey.private).getPublicSSH()).digest('base64').replace(/=+$/, '');
  const server = new Server({ hostKeys: [hostKey.private] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('tcpip', (accept, reject, info) => {
      const port = options.forward?.[info.destIP];
      if (!port || info.destPort !== 22) { reject(); return; }
      forwarded.push(info.destIP);
      const socket = net.connect(port, '127.0.0.1');
      let channel;
      socket.on('connect', () => { channel = accept(); channel.on('error', () => socket.destroy()); channel.on('close', () => socket.destroy()); channel.pipe(socket).pipe(channel); });
      socket.on('error', () => { if (channel) channel.destroy(); else reject(); });
      client.on('close', () => socket.destroy());
    });
    client.on('authentication', context => {
      if (context.username !== 'tester') return context.reject();
      if (context.method === 'password' && context.password === 'local-test') return context.accept();
      if (context.method === 'publickey' && context.key.data.equals(publicKey.getPublicSSH()) && (!context.signature || publicKey.verify(context.blob, context.signature, context.hashAlgo) === true)) return context.accept();
      context.reject();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', (acceptPty, _reject, size) => { terminalSizes.push(size); acceptPty(); });
      session.on('window-change', (acceptWindow, _reject, size) => { terminalSizes.push(size); acceptWindow?.(); });
      session.on('exec', (acceptExec, reject, info) => {
        if(info.command.startsWith('# TERMUS_OS_V1')){const stream=acceptExec();stream.on('error',()=>{});stream.write('Linux\nID=ubuntu\nPRETTY_NAME="Ubuntu 24.04 LTS"\nTERMUS_ARCH=x86_64\nTERMUS_CPUS=4\nTERMUS_MEMORY=8589934592\nTERMUS_ROOT=107374182400\n');stream.exit(0);stream.end();return;}
        if(info.command.startsWith('# TERMUS_CLOUD_V1')){const stream=acceptExec();stream.on('error',()=>{});stream.write(options.cloud||'VENDOR=QEMU\nVIRT=kvm\n');stream.exit(0);stream.end();return;}
        if(info.command.startsWith('# TERMUS_METRICS_V1')){const stream=acceptExec();stream.on('error',()=>{});stream.write(require('./metrics-fixture.cjs').metricsFixture(Math.floor(Date.now()/5000)));stream.exit(0);stream.end();return;}
        if(info.command.startsWith('# TERMUS_HOST_LEDGER_V1')){const stream=acceptExec();stream.on('error',()=>{});stream.write('BOOT=fixture-boot\nKERNEL=Linux 6.1\nOS="Fixture Linux"\nMEM=8192\nROOT=10000 1000 9000\nEND\n');stream.exit(0);stream.end();return;}
        if (!options.exec) return reject();
        const stream = acceptExec(); stream.on('error', () => {});
        options.exec(info.command, stream);
      });
      session.on('shell', acceptShell => {
        const stream = acceptShell(), shell = shells.length; shells.push(stream);
        stream.write('Termus test server\r\ntester@fixture:~$ ');
        stream.on('data', chunk => { const text = chunk.toString(); received.push({ shell, text }); if (text.trim() === 'exit') { stream.exit(0); stream.end(); } else stream.write('received: ' + text + '\r\ntester@fixture:~$ '); });
      });
      session.on('sftp', acceptSftp => serveSftp(acceptSftp(), root));
    }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, fingerprint, clientKey, forwarded, received, shells, terminalSizes,
    active: () => clients.size,
    close: () => new Promise(done => { for (const client of clients) client.end(); server.close(done); }),
  })));
}
function serveSftp(sftp, root) {
  let nextHandle = 1; const handles = new Map();
  const local = remote => { const full = path.resolve(root, '.' + path.posix.resolve('/', remote)); if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Outside fixture'); return full; };
  const attrs = stat => ({ mode: stat.mode, uid: 1000, gid: 1000, size: stat.size, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) });
  function on(name, action) { sftp.on(name, (id, ...args) => { try { action(id, ...args); } catch (error) { sftp.status(id, error.code === 'ENOENT' ? S.NO_SUCH_FILE : S.FAILURE, error.message); } }); }
  function handle(id, value) { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(nextHandle++); handles.set(buffer.toString('hex'), value); sftp.handle(id, buffer); }
  const get = buffer => { const value = handles.get(buffer.toString('hex')); if (!value) throw new Error('Bad handle'); return value; };
  on('REALPATH', (id, remote) => { const name = path.posix.resolve('/', remote); sftp.name(id, [{ filename: name, longname: name, attrs: attrs(fs.statSync(local(name))) }]); });
  for (const command of ['STAT', 'LSTAT']) on(command, (id, remote) => sftp.attrs(id, attrs(fs.statSync(local(remote)))));
  on('OPENDIR', (id, remote) => handle(id, { directory: local(remote), read: false }));
  on('READDIR', (id, buffer) => { const value = get(buffer); if (value.read) return sftp.status(id, S.EOF); value.read = true; const list = fs.readdirSync(value.directory).map(name => ({ filename: name, longname: name, attrs: attrs(fs.statSync(path.join(value.directory, name))) })); if (!list.length) sftp.status(id, S.EOF); else sftp.name(id, list); });
  on('OPEN', (id, remote, flags) => handle(id, { fd: fs.openSync(local(remote), flagsToString(flags)) }));
  on('FSTAT', (id, buffer) => sftp.attrs(id, attrs(fs.fstatSync(get(buffer).fd))));
  on('READ', (id, buffer, offset, length) => { const data = Buffer.alloc(length); const read = fs.readSync(get(buffer).fd, data, 0, length, offset); if (!read) sftp.status(id, S.EOF); else sftp.data(id, data.subarray(0, read)); });
  on('WRITE', (id, buffer, offset, data) => { fs.writeSync(get(buffer).fd, data, 0, data.length, offset); sftp.status(id, S.OK); });
  on('CLOSE', (id, buffer) => { const value = get(buffer); if (value.fd !== undefined) fs.closeSync(value.fd); handles.delete(buffer.toString('hex')); sftp.status(id, S.OK); });
  on('MKDIR', (id, remote) => { fs.mkdirSync(local(remote)); sftp.status(id, S.OK); });
  on('REMOVE', (id, remote) => { fs.unlinkSync(local(remote)); sftp.status(id, S.OK); });
  on('RMDIR', (id, remote) => { fs.rmdirSync(local(remote)); sftp.status(id, S.OK); });
  on('SETSTAT', (id, remote, attributes) => { if(attributes.mode!==undefined)fs.chmodSync(local(remote),attributes.mode);sftp.status(id,S.OK); });
  on('RENAME', (id, from, to) => { if (fs.existsSync(local(to))) throw new Error('Exists'); fs.renameSync(local(from), local(to)); sftp.status(id, S.OK); });
  sftp.on('close', () => { for (const value of handles.values()) if (value.fd !== undefined) try { fs.closeSync(value.fd); } catch {} });
}
module.exports = { startFixture };

