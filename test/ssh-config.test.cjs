const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseSshConfig, readSshConfig, parseJumpSpec, splitArguments, IMPORT_GROUP } = require('../src/ssh-config.cjs');
const { normalizeHost, connectionRoute } = require('../src/store.cjs');

function home(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'termlo-sshconfig-'));
  fs.mkdirSync(path.join(folder, '.ssh'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

const parse = (text, homeDir, extra = {}) => parseSshConfig(text, { homeDir, localUser: 'local', ...extra });
const byName = hosts => Object.fromEntries(hosts.map(host => [host.name, host]));

test('basic host fields map to Termlo host entries', t => {
  const homeDir = home(t);
  fs.writeFileSync(path.join(homeDir, '.ssh', 'id_web'), 'key');
  const { hosts, warnings } = parse(
    [
      '# comment',
      'Host web',
      '  HostName 10.0.0.5',
      '  User deploy',
      '  Port 2222',
      '  IdentityFile ~/.ssh/id_web',
      '',
      'Host db',
      '  hostname=db.example.com',
      '  USER = postgres',
    ].join('\n'),
    homeDir,
  );
  assert.deepEqual(warnings, []);
  const { web, db } = byName(hosts);
  assert.deepEqual(web, {
    id: 'ssh-config:web',
    name: 'web',
    address: '10.0.0.5',
    port: 2222,
    username: 'deploy',
    auth: 'key',
    keyPath: path.join(homeDir, '.ssh', 'id_web'),
    group: IMPORT_GROUP,
    tags: '',
    jumpHostId: '',
  });
  assert.equal(db.address, 'db.example.com');
  assert.equal(db.username, 'postgres');
  assert.equal(db.port, 22);
  assert.equal(db.auth, 'password');
  assert.equal(db.keyPath, '');
  for (const host of hosts) {
    assert.equal(normalizeHost(host).group, 'SSH config');
    assert.ok(!Object.keys(host).some(key => /password/i.test(key)), 'no password fields are ever imported');
  }
});

test('wildcard hosts are not imported but supply defaults; first value wins', t => {
  const homeDir = home(t);
  const { hosts } = parse(
    [
      'User globaluser',
      'Host special',
      '  User first',
      '  Port 2200',
      'Host special',
      '  User second',
      'Host *.corp !skip.corp',
      '  User corpuser',
      '  Port 2022',
      'Host app.corp skip.corp other?',
      '  HostName %h.internal',
      'Host *',
      '  User fallback',
      '  Port 22',
    ].join('\n'),
    homeDir,
  );
  const map = byName(hosts);
  assert.deepEqual(Object.keys(map).sort(), ['app.corp', 'skip.corp', 'special']);
  assert.equal(map.special.username, 'globaluser', 'options before any Host apply to everyone and come first');
  assert.equal(map.special.port, 2200);
  assert.equal(map['app.corp'].port, 2022);
  assert.equal(map['app.corp'].address, 'app.corp.internal');
  assert.equal(map['skip.corp'].port, 22, 'negated pattern excludes the block');
});

test('defaults user to the local account with a warning, and bad ports fall back to 22', t => {
  const homeDir = home(t);
  const { hosts, warnings } = parse('Host a\n  Port 99999\n', homeDir);
  assert.equal(hosts[0].username, 'local');
  assert.equal(hosts[0].port, 22);
  assert.equal(warnings.length, 2);
  assert.match(warnings.map(w => w.message).join('\n'), /端口 99999 无效[\s\S]*本机用户名/);
  assert.equal(warnings[0].line, 2);
});

test('IdentityFile expands ~, %d, %r and relative paths; missing keys warn', t => {
  const homeDir = home(t);
  const { hosts, warnings } = parse(
    [
      'Host a',
      '  User root',
      '  IdentityFile %d/.ssh/%r_key',
      '  IdentityFile ~/.ssh/ignored_second_identity',
      'Host b',
      '  User u',
      '  IdentityFile "keys/my key"',
      'Host c',
      '  User u',
      '  IdentityFile none',
    ].join('\n'),
    homeDir,
  );
  const map = byName(hosts);
  assert.equal(map.a.keyPath, path.join(homeDir, '.ssh', 'root_key'));
  assert.equal(map.b.keyPath, path.join(homeDir, 'keys', 'my key'));
  assert.equal(map.c.auth, 'password');
  assert.equal(warnings.filter(w => /私钥文件不存在/.test(w.message)).length, 2);
});

test('ProxyJump maps to a jump host chain by alias', t => {
  const homeDir = home(t);
  const { hosts, warnings } = parse(
    [
      'Host bastion',
      '  HostName 1.2.3.4',
      '  User jump',
      'Host inner',
      '  HostName 10.0.0.2',
      '  User ops',
      '  ProxyJump bastion',
      'Host target',
      '  HostName 10.0.0.3',
      '  User app',
      '  ProxyJump inner',
      'Host direct',
      '  User x',
      '  ProxyJump none',
    ].join('\n'),
    homeDir,
  );
  assert.deepEqual(warnings, []);
  const map = byName(hosts);
  assert.equal(map.inner.jumpHostId, 'ssh-config:bastion');
  assert.equal(map.target.jumpHostId, 'ssh-config:inner');
  assert.equal(map.direct.jumpHostId, '');
  assert.deepEqual(connectionRoute(hosts, 'ssh-config:target').map(h => h.name), ['bastion', 'inner', 'target']);
  // Jump hosts come before the hosts that use them, so they can be saved in order.
  const ids = hosts.map(h => h.id);
  assert.ok(ids.indexOf('ssh-config:bastion') < ids.indexOf('ssh-config:inner'));
  assert.ok(ids.indexOf('ssh-config:inner') < ids.indexOf('ssh-config:target'));
});

test('multi-hop ProxyJump lists chain hops and synthesize entries for unknown hops', t => {
  const homeDir = home(t);
  const { hosts, warnings } = parse(
    [
      'Host a',
      '  HostName 1.1.1.1',
      '  User ua',
      'Host b',
      '  HostName 2.2.2.2',
      '  User ub',
      'Host target',
      '  User ut',
      '  ProxyJump a,b',
      'Host far',
      '  User uf',
      '  ProxyJump admin@gw.example.com:2201,ssh://[fd00::1]:2202',
      'Host *.example.com',
      '  User pattern',
    ].join('\n'),
    homeDir,
  );
  assert.deepEqual(warnings.map(w => w.message), ['fd00::1：未指定 User，已使用本机用户名 local']);
  const map = byName(hosts);
  assert.deepEqual(connectionRoute(hosts, 'ssh-config:target').map(h => h.address), ['1.1.1.1', '2.2.2.2', 'target']);
  // b itself stays direct; the chain uses a variant of b reached via a.
  assert.equal(map.b.jumpHostId, '');
  const route = connectionRoute(hosts, 'ssh-config:far');
  assert.deepEqual(
    route.map(h => [h.address, h.port, h.username]),
    [
      ['gw.example.com', 2201, 'admin'],
      ['fd00::1', 2202, 'local'],
      ['far', 22, 'uf'],
    ],
  );
  assert.ok(hosts.every(host => normalizeHost(host)));
});

test('ProxyJump cycles and over-deep chains are reported, never imported broken', t => {
  const homeDir = home(t);
  const cyclic = parse('Host a\n User u\n ProxyJump b\nHost b\n User u\n ProxyJump a\n', homeDir);
  assert.match(cyclic.warnings.map(w => w.message).join('\n'), /循环/);
  for (const host of cyclic.hosts) assert.doesNotThrow(() => connectionRoute(cyclic.hosts, host.id));

  const deep = parse('Host t\n User u\n ProxyJump h1,h2,h3,h4,h5\nHost h*\n User u\n', homeDir);
  assert.ok(!deep.hosts.some(host => host.name === 't'));
  assert.match(deep.warnings.map(w => w.message).join('\n'), /4 级/);
});

test('Include resolves relative to ~/.ssh, supports globs and stops cycles', t => {
  const homeDir = home(t);
  const ssh = path.join(homeDir, '.ssh');
  fs.mkdirSync(path.join(ssh, 'conf.d'));
  fs.writeFileSync(path.join(ssh, 'conf.d', '10-one.conf'), 'Host one\n  User u1\n');
  fs.writeFileSync(path.join(ssh, 'conf.d', '20-two.conf'), 'Host two\n  User u2\nInclude ~/.ssh/config\n');
  fs.writeFileSync(path.join(ssh, 'conf.d', '.hidden'), 'Host hidden\n  User h\n');
  fs.writeFileSync(path.join(ssh, 'extra'), 'Port 2022\n');
  const configText = 'Include conf.d/*.conf\nHost main\n  User m\n  Include extra\n  HostName main.example\nInclude missing-file\n';
  fs.writeFileSync(path.join(ssh, 'config'), configText);

  const { hosts, warnings } = readSshConfig({ homeDir, localUser: 'local' });
  const map = byName(hosts);
  assert.deepEqual(Object.keys(map).sort(), ['main', 'one', 'two']);
  assert.equal(map.main.port, 2022, 'option-only include continues the current Host block');
  assert.equal(map.main.address, 'main.example', 'the including block resumes after Include');
  const messages = warnings.map(w => w.message).join('\n');
  assert.match(messages, /循环引用/);
  assert.match(messages, /未找到文件：missing-file/);
});

test('missing config file and Match/ProxyCommand produce warnings, not errors', t => {
  const homeDir = home(t);
  const missing = readSshConfig({ homeDir });
  assert.deepEqual(missing.hosts, []);
  assert.match(missing.warnings[0].message, /未找到/);

  const { hosts, warnings } = parse(
    'Host a\n User u\n ProxyCommand nc %h %p\nMatch host a\n User wrong\nHost "bad host"\n User u\n',
    homeDir,
  );
  assert.equal(byName(hosts).a.username, 'u');
  const messages = warnings.map(w => w.message).join('\n');
  assert.match(messages, /ProxyCommand/);
  assert.match(messages, /Match/);
  assert.match(messages, /bad host.*未导入/);
});

test('helpers: argument splitting and jump spec parsing', () => {
  assert.deepEqual(splitArguments('a "b c"  d'), ['a', 'b c', 'd']);
  assert.equal(splitArguments('"unterminated'), null);
  assert.deepEqual(parseJumpSpec('user@host:2200'), { user: 'user', host: 'host', port: '2200' });
  assert.deepEqual(parseJumpSpec('ssh://h'), { user: '', host: 'h', port: '' });
  assert.deepEqual(parseJumpSpec('[::1]:22'), { user: '', host: '::1', port: '22' });
  assert.deepEqual(parseJumpSpec('fe80::1'), { user: '', host: 'fe80::1', port: '' });
});
