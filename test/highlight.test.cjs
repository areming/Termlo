const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchHighlights, normalizeHighlights } = require('../src/highlight-rules.cjs');
const tokens = (text, options) => matchHighlights(text, options).map(m => [text.slice(m.start, m.end), m.kind]);
test('valid IPv4, IPv6 and URLs highlight without matching malformed addresses or timestamps', () => {
  assert.deepEqual(tokens('10.0.0.1 255.255.255.255 [2001:db8::1] ::1 fe80::a%eth0'), [['10.0.0.1','network'],['255.255.255.255','network'],['2001:db8::1','network'],['::1','network'],['fe80::a%eth0','network']]);
  assert.deepEqual(tokens('999.1.1.1 1.2.3.4.5 a1.2.3.4 12:30:59 12345::1'), []);
  assert.deepEqual(tokens('see https://example.com/ERROR?q=10.0.0.1.'), [['https://example.com/ERROR?q=10.0.0.1','network']]);
});
test('prompt commands and options are conservative and preserve quoted arguments', () => {
  assert.deepEqual(tokens('root@server:~# curl -I "--not-a-flag" https://example.com'), [['curl','command'],['-I','option'],['https://example.com','network']]);
  assert.deepEqual(tokens('[root@server ~]# systemctl --no-pager status'), [['systemctl','command'],['--no-pager','option']]);
  assert.deepEqual(tokens('$ LANG=en_US.UTF-8 ls -l'), [['ls','command'],['-l','option']]);
  assert.deepEqual(tokens('This log mentions ssh -p 22 and curl'), []);
});
test('paths and bounded status keywords do not double-highlight contained tokens', () => {
  assert.deepEqual(tokens('ERROR /var/log/error.log WARN C:\\Logs\\app.log SUCCESS ~/app'), [['ERROR','error'],['/var/log/error.log','path'],['WARN','warning'],['C:\\Logs\\app.log','path'],['SUCCESS','success'],['~/app','path']]);
  assert.deepEqual(tokens('error_count warnings booking successful failed'), [['successful','success'],['failed','error']]);
});
test('Unicode offsets are preserved and groups can be switched off independently', () => {
  assert.deepEqual(tokens('连接 👋 10.0.0.1 /目录/文件 ERROR'), [['10.0.0.1','network'],['/目录/文件','path'],['ERROR','error']]);
  assert.deepEqual(tokens('$ ssh 10.0.0.1 ERROR', { enabled: false }), []);
  assert.deepEqual(tokens('$ ssh 10.0.0.1 ERROR', { network: false, status: false }), [['ssh','command']]);
  assert.equal(normalizeHighlights({ enabled: 'false' }).enabled, true);
});
test('long lines and many tokens have bounded highlighting work', () => {
  assert.deepEqual(tokens('10.0.0.1 '.repeat(1000)), []);
  assert.ok(tokens('ERROR '.repeat(500)).length <= 128);
});
