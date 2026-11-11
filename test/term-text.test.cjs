const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/app/term-text.mjs');
const plain = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

test('long committed lines continue under their own text, never past the width', async () => {
  const { hang, cellWidth } = await load();
  const width = 24;
  const lines = plain(hang('● 这台机器正在监听二十二号端口和八十号端口，分别对应 SSH 与 nginx 服务。', width)).split('\r\n');
  assert.ok(lines.length > 2);
  assert.ok(lines[0].startsWith('● '));
  for (const line of lines.slice(1)) assert.ok(line.startsWith('  ') && !line.startsWith('   '));
  for (const line of lines) assert.ok([...line].reduce((n, ch) => n + cellWidth(ch), 0) < width);
  assert.equal(lines.join('').replace(/\s/g, ''), '●这台机器正在监听二十二号端口和八十号端口，分别对应SSH与nginx服务。');
});

test('Latin text breaks at a space; tool output and numbered steps keep their indent; styles pass through', async () => {
  const { hang } = await load();
  const out = hang('  $ \x1b[36msystemctl restart cron && systemctl status cron --no-pager\x1b[0m', 30);
  const lines = plain(out).split('\r\n');
  assert.deepEqual(lines.map(l => l.trimEnd()), ['  $ systemctl restart cron &&', '    systemctl status cron', '    --no-pager']);
  assert.ok(out.startsWith('  $ \x1b[36m') && out.endsWith('\x1b[0m'));
  assert.deepEqual(plain(hang('  1. 先停止服务再备份配置文件然后重启', 20)).split('\r\n')[1].slice(0, 5), '     ');
  assert.equal(hang('short line\r\nsecond', 40), 'short line\r\nsecond');
});
