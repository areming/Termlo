const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/app/highlight-rules.mjs');
const kinds = (matches, text) => matches.map(m => [m.kind, text.slice(m.start, m.end)]);

test('prompt command and flags, addresses, paths and status words are found', async () => {
  const { matchHighlights } = await load();
  let text = 'root@web:~# systemctl status nginx --no-pager';
  assert.deepEqual(kinds(matchHighlights(text), text), [['prompt', 'root@web'], ['cwd', '~'], ['command', 'systemctl'], ['option', '--no-pager']]);
  text = 'Connecting to 10.0.0.12:22 and https://example.com/a).';
  assert.deepEqual(kinds(matchHighlights(text), text), [['network', '10.0.0.12:22'], ['network', 'https://example.com/a']]);
  text = 'ERROR: cannot open /etc/nginx/nginx.conf';
  assert.deepEqual(kinds(matchHighlights(text), text), [['error', 'ERROR'], ['path', '/etc/nginx/nginx.conf']]);
  text = '部署成功，警告 1 条，失败 0 条';
  assert.deepEqual(kinds(matchHighlights(text), text).map(k => k[0]), ['success', 'warning', 'error']);
});

test('no false positives on versions, times and plain words', async () => {
  const { matchHighlights } = await load();
  for (const text of ['nginx/1.25.3 started at 12:30:45', 'version 999.1.2.3', 'Okay, looking good', 'the path is clear']) {
    assert.deepEqual(matchHighlights(text).filter(m => m.kind === 'network' || m.kind === 'success'), [], text);
  }
  assert.deepEqual(matchHighlights('x'.repeat(9000)), []);
});

test('the prompt user@host and working directory are colored', async () => {
  const { matchHighlights } = await load();
  const text = 'root@ubuntu2204:/etc/nginx# ls -la';
  assert.deepEqual(kinds(matchHighlights(text), text), [['prompt', 'root@ubuntu2204'], ['cwd', '/etc/nginx'], ['command', 'ls'], ['option', '-la']]);
  const home = 'ops@web:~$ ';
  assert.deepEqual(kinds(matchHighlights(home), home), [['prompt', 'ops@web'], ['cwd', '~']]);
});

test('a prompt waiting for input (trailing space trimmed) is still recognized', async () => {
  const { matchHighlights } = await load();
  const text = 'root@ubuntu2204:~#';
  assert.deepEqual(kinds(matchHighlights(text), text), [['prompt', 'root@ubuntu2204'], ['cwd', '~']]);
});
