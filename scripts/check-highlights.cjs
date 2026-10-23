const assert = require('node:assert/strict');
const path = require('node:path');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
module.exports = async function checkHighlights(application, page, fixture, output) {
  const stream = fixture.shells.at(-1), before = fixture.received.length;
  const pane = page.locator('.terminal-pane:not(.hidden)');
  const count = kind => pane.locator(`[data-highlight${kind ? '="' + kind + '"' : ''}]`).count();
  const write = async text => { stream.write(text); await pause(220); };
  const sample = [
    'Termus · semantic highlighting', '',
    'root@prod-api:~# ssh -p 22 admin@192.168.10.24',
    'root@prod-api:~# tail -f /var/log/nginx/error.log', '',
    '2026-10-21 14:32:08 INFO  连接目标 192.168.10.24:443',
    '2026-10-21 14:32:09 OK    Health check passed: https://api.example.com/health',
    '2026-10-21 14:32:10 WARN  Upstream TIMEOUT after 5000ms',
    '2026-10-21 14:32:11 ERROR Connection refused: 10.0.2.15:5432',
    '2026-10-21 14:32:12 INFO  IPv6 upstream [2001:db8::42]',
    '2026-10-21 14:32:13 INFO  Config loaded from /etc/nginx/nginx.conf',
    '', '\x1b[31mRemote ANSI: ERROR 172.16.0.2\x1b[0m',
    'Unicode 宽字符 👋 203.0.113.9 /目录/日志.txt', '',
  ].join('\r\n');
  await write('\x1b[2J\x1b[H' + sample);
  await pane.locator('[data-highlight="network"]').first().waitFor();
  for (const kind of ['network', 'path', 'command', 'option', 'error', 'warning', 'success']) assert.ok(await count(kind) > 0, kind);
  const colors = await pane.locator('.xterm-rows').evaluate(rows => {
    return [...rows.children].map(row => {
      const spans = [];
      for (const span of row.querySelectorAll('span')) {
        const color = getComputedStyle(span).color;
        if (spans.at(-1)?.color === color) spans.at(-1).text += span.textContent;
        else spans.push({ text: span.textContent, color });
      }
      return { text: row.textContent, spans };
    });
  });
  await page.locator('#toast').evaluate(el => el.classList.add('hidden'));
  await page.screenshot({ path: path.join(output, 'terminal-highlights.png') });
  require('node:fs').writeFileSync(path.join(output, 'highlight-render.json'), JSON.stringify(colors, null, 2));
  assert.ok(colors.find(row => row.text.includes('连接目标')).spans.some(span => span.text.includes('192.168.10.24') && span.color === 'rgb(130, 180, 255)'));
  assert.ok(colors.find(row => row.text.includes('root@prod-api:~# ssh')).spans.some(span => span.text === 'ssh' && span.color === 'rgb(168, 217, 139)'));
  const remote = colors.find(row => row.text.includes('Remote ANSI'));
  assert.ok(remote.spans.some(span => span.text.includes('ERROR 172.16.0.2') && span.color === 'rgb(237, 146, 146)'), 'remote ANSI wins');
  assert.ok(colors.find(row => row.text.includes('Unicode')).spans.some(span => span.text.includes('203.0.113.9') && span.color === 'rgb(130, 180, 255)'), 'CJK/emoji offsets');
  await page.screenshot({ path: path.join(output, 'terminal-highlights.png') });
  await page.locator('#terminal-highlights').click();
  await page.screenshot({ path: path.join(output, 'highlight-settings.png') });
  await page.locator('[data-highlight-setting="network"]').uncheck(); await pause(160);
  assert.equal(await count('network'), 0); assert.ok(await count('error') > 0);
  await page.locator('[data-highlight-setting="enabled"]').uncheck(); await pause(160);
  assert.equal(await count(), 0);
  assert.equal(await page.locator('[data-highlight-setting="paths"]').isDisabled(), true);
  await page.locator('[data-highlight-setting="enabled"]').check();
  await page.locator('[data-highlight-setting="network"]').check(); await pause(160);
  await page.locator('#highlight-dialog .primary').click();

  // Alternate-screen programs keep their own colors and are not decorated.
  await write('\x1b[?1049h\x1b[HERROR 198.51.100.10'); assert.equal(await count(), 0);
  await write('\x1b[?1049l'); assert.ok(await count('network') > 0);
  // Rewriting a line must not leave old highlights over unrelated text.
  await write('\x1b[2J\x1b[HERROR 198.51.100.10'); assert.ok(await count('error') > 0);
  await write('\r\x1b[2Kordinary progress 50%'); assert.equal(await count(), 0);
  // A network token split over terminal rows is highlighted on both rows.
  const cols = fixture.terminalSizes.at(-1).cols;
  await write('\x1b[2J\x1b[H' + ' '.repeat(cols - 5) + '203.0.113.20\r\n');
  assert.equal(await count('network'), 2, 'wrapped IP spans both rows');
  // Resize forces a buffer reflow, including wide glyph mapping.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 700));
  await pause(250);
  assert.ok(await count('network') > 0);
  await write('\x1b[2J\x1b[H' + sample);
  await page.screenshot({ path: path.join(output, 'highlight-compact.png') });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await pause(160);
  // Scrollback trim and rapid log output remain bounded, and old rows can be revisited.
  await write('\r\n' + 'ERROR 10.0.0.1 /var/log/app.log\r\n'.repeat(5100));
  assert.ok(await count() <= 400); assert.ok(await count() > 0);
  await pane.locator('.xterm-viewport').evaluate(el => { el.scrollTop = 0; }); await pause(180);
  assert.ok(await count() > 0);
  await write('\x1b[3J\x1b[2J\x1b[H' + sample);
  assert.equal(fixture.received.length, before, 'highlighting must never send commands');
  await page.locator('#terminal-highlight-toggle').click(); await pause(150);
  assert.equal(await count(),0); assert.equal(await page.locator('#terminal-highlight-toggle').textContent(),'原始配色');
  await page.locator('#terminal-highlight-toggle').click(); await pause(150);
  assert.ok(await count()>0); assert.equal(await page.locator('#terminal-highlight-toggle').getAttribute('aria-pressed'),'true');
  // Leave one category off so the existing reload step verifies persistence.
  await page.locator('#terminal-highlights').click(); await page.locator('[data-highlight-setting="status"]').uncheck();
  await page.locator('#highlight-dialog .primary').click();
  console.log('Highlight integration passed: rendered colors, remote ANSI, Unicode, toggle, alternate screen, rewrite, reflow and scrollback.');
};
