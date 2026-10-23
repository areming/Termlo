const assert = require('node:assert/strict');
const path = require('node:path');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition) { const deadline = Date.now() + 8000; while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out waiting for SSH clipboard input'); await pause(25); } }

module.exports = async function checkClipboard(application, page, fixture, output) {
  // Keep the original multi-format clipboard in the Electron process, never in logs.
  const backupReady = await application.evaluate(async ({ clipboard, ClipboardItem }) => {
    const items = await clipboard.read();
    const usable = items.filter(item => item.types.length);
    if (usable.length !== items.length) return false;
    globalThis.clipboardTestBackup = await Promise.all(usable.map(async item => {
      const entries = await Promise.all(item.types.map(async type => [type, await item.getType(type)]));
      return new ClipboardItem(Object.fromEntries(entries));
    }));
    return true;
  });
  if (!backupReady) { console.log('Clipboard regression skipped: current OS formats cannot be backed up losslessly; clipboard left untouched.'); return false; }
  const writeClipboard = text => application.evaluate(async ({ clipboard }, text) => { await clipboard.writeText(text); globalThis.clipboardTestOwned = text; }, text);
  const clipboardText = () => application.evaluate(async ({ clipboard }) => { const text = await clipboard.readText(); globalThis.clipboardTestOwned = text; return text; });
  const pane = () => page.locator('.terminal-pane:not(.hidden)');
  const focus = () => pane().locator('.xterm-helper-textarea').focus();
  const capture = () => fixture.received.length;
  const received = start => fixture.received.slice(start).map(item => item.text).join('');
  async function expectPaste(action, expected) {
    const start = capture(); await action(); await until(() => received(start).length >= expected.length); await pause(120);
    assert.equal(received(start), expected, 'paste must reach SSH exactly once');
    assert.ok(fixture.received.slice(start).every(item => item.shell === 1), 'paste targets the active session');
  }
  try {
    for (const shortcut of ['Control+v', 'Control+Shift+v', 'Shift+Insert']) {
      const value = `echo 中文-${shortcut}`; await writeClipboard(value); await focus();
      await expectPaste(() => page.keyboard.press(shortcut), value);
    }
    await writeClipboard('echo toolbar'); await expectPaste(() => page.locator('#terminal-paste').click(), 'echo toolbar');
    await writeClipboard('echo context');
    await pane().click({ button: 'right', position: { x: 40, y: 40 } });
    await page.locator('#terminal-menu').waitFor();
    await page.screenshot({ path: path.join(output, 'clipboard-menu.png') });
    await expectPaste(() => page.locator('#menu-paste').click(), 'echo context');

    // Copy selected scrollback into the real Windows clipboard; Ctrl+C stays local.
    await pane().click({ button: 'right', position: { x: 40, y: 40 } });
    await page.locator('#menu-select').click();
    for (const shortcut of ['Control+c', 'Control+Shift+c', 'Control+Insert']) {
      const start = capture(); await focus(); await page.keyboard.press(shortcut);
      await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已复制'));
      await pause(120); assert.equal(capture(), start);
      assert.ok((await clipboardText()).includes('Termus test server'));
    }
    await page.locator('#terminal-copy').click(); await pause(120);
    assert.ok((await clipboardText()).includes('echo context'));
    await pane().click({ button: 'right', position: { x: 40, y: 40 } });
    await page.locator('#menu-copy').click(); await pause(120);
    assert.ok((await clipboardText()).includes('echo context'));
    // Paste clears the selection, then Ctrl+C must still send ETX to the server.
    await writeClipboard('selection reset'); await expectPaste(() => page.locator('#terminal-paste').click(), 'selection reset');
    await focus(); await expectPaste(() => page.keyboard.press('Control+c'), '\x03');

    await writeClipboard('echo 第一行\r\necho 第二行\r\n');
    let start = capture(); await focus(); await page.keyboard.press('Control+v');
    await page.locator('#paste-dialog').waitFor(); await pause(120); assert.equal(capture(), start);
    assert.ok((await page.locator('#paste-target').textContent()).includes('Development SSH'));
    assert.equal(await page.locator('#paste-trim').isChecked(), true);
    await page.screenshot({ path: path.join(output, 'clipboard-preview.png') });
    await page.keyboard.press('Escape'); await page.locator('#paste-dialog').waitFor({ state: 'hidden' });
    assert.equal(capture(), start);
    await page.waitForFunction(() => document.querySelector('#paste-preview').value === '');
    assert.equal(await page.locator('#paste-preview').inputValue(), '');
    await focus(); await page.keyboard.press('Control+v'); await page.locator('#paste-dialog').waitFor();
    await page.locator('#paste-preview').fill('echo reviewed\necho second\n');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 700));
    await page.screenshot({ path: path.join(output, 'clipboard-compact.png') });
    const bounds = await page.locator('#paste-dialog').boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    await expectPaste(() => page.locator('#paste-confirm').click(), 'echo reviewed\recho second');

    // OS paste events also go through review, with no xterm double-send.
    start = capture();
    await pane().locator('.xterm-helper-textarea').evaluate(el => {
      const data = new DataTransfer(); data.setData('text/plain', 'event first\nevent second\n');
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    });
    await page.locator('#paste-dialog').waitFor(); assert.equal(capture(), start);
    await page.locator('#paste-trim').uncheck();
    await expectPaste(() => page.locator('#paste-confirm').click(), 'event first\revent second\r');

    // A shell enabling bracketed paste receives the delimiters, including after review.
    fixture.shells[1].write('\x1b[?2004h'); await pause(150);
    await writeClipboard('bracketed\nsecond\n'); await page.locator('#terminal-paste').click();
    await page.locator('#paste-dialog').waitFor();
    await expectPaste(() => page.locator('#paste-confirm').click(), '\x1b[200~bracketed\rsecond\x1b[201~');
    fixture.shells[1].write('\x1b[?2004l'); await pause(150);
    await writeClipboard(''); start = capture(); await page.locator('#terminal-paste').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('没有可粘贴')); assert.equal(capture(), start);
    await writeClipboard('x'.repeat(256 * 1024 + 1)); await page.locator('#terminal-paste').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('分段')); assert.equal(capture(), start);

    // Ordinary fields retain native copy/paste and are not sent to SSH.
    await page.keyboard.press('Control+n'); await page.locator('#host-dialog').waitFor();
    await writeClipboard('外部主机名称'); await page.locator('[name="name"]').focus(); await page.keyboard.press('Control+v');
    assert.equal(await page.locator('[name="name"]').inputValue(), '外部主机名称');
    await page.keyboard.press('Control+a'); await page.keyboard.press('Control+c'); await pause(120);
    assert.equal(await clipboardText(), '外部主机名称');
    await writeClipboard('fake-test-password'); await page.locator('[name="password"]').focus(); await page.keyboard.press('Control+v');
    assert.equal(await page.locator('[name="password"]').inputValue(), 'fake-test-password');
    await page.locator('#host-dialog [data-close]').first().click(); assert.equal(capture(), start);

    // An already displayed preview cannot send if its original connection disappears.
    await writeClipboard('never\nsend'); await page.locator('#terminal-paste').click(); await page.locator('#paste-dialog').waitFor();
    const id = await pane().getAttribute('data-id'); await page.evaluate(id => window.termus.disconnect(id), id);
    await page.waitForFunction(() => document.querySelector('#paste-confirm').disabled);
    assert.equal(capture(), start); await page.locator('#paste-cancel').click();
    assert.equal(await page.locator('#terminal-paste').isDisabled(), true);
    // Restore a live second tab for the rest of the existing smoke scenario.
    await page.locator('#reconnect').click(); await page.waitForFunction(() => document.querySelector('#session-count').textContent === '2');
    console.log('Clipboard integration passed: OS text, shortcuts, context menu, preview/cancel, bracketed paste, fields and disconnected target.');
  } finally {
    await application.evaluate(async ({ clipboard }) => {
      // Do not overwrite something the user copied during the test.
      if (await clipboard.readText() === globalThis.clipboardTestOwned) {
        if (globalThis.clipboardTestBackup.length) await clipboard.write(globalThis.clipboardTestBackup);
        else clipboard.clear();
      }
      delete globalThis.clipboardTestBackup; delete globalThis.clipboardTestOwned;
    });
  }
  return true;
};
