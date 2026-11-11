// End-to-end smoke test of the 2.0 shell against a local SSH fixture and a scripted model.
// Walks the main flows (add host, terminal, files, model settings, assistant task) and saves
// screenshots of every page in both themes to test-output/shell/.
const { _electron: electron } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { startFixture } = require('../test/fixture.cjs');
const { startProvider, call, response, history } = require('../test/agent-fixture.cjs');

const root = path.join(__dirname, '..');
const output = path.join(root, 'test-output', 'shell');

async function main() {
  require('./build.cjs').build();
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const run = fs.mkdtempSync(path.join(root, 'test-output', 'shell-run-'));

  const remoteRoot = path.join(run, 'remote');
  fs.mkdirSync(path.join(remoteRoot, 'etc', 'nginx'), { recursive: true });
  fs.writeFileSync(path.join(remoteRoot, 'etc', 'nginx', 'nginx.conf'), 'server { listen 80; }\n');
  fs.writeFileSync(path.join(remoteRoot, 'readme.txt'), 'hello');
  const commands = [];
  const fixture = await startFixture(remoteRoot, {
    exec(command, stream) {
      commands.push(command);
      stream.write(command.includes('=== SYSTEM ===') ? '=== SYSTEM ===\nLinux fixture 6.1\n' : 'ok\n');
      stream.exit(0);
      stream.end();
    },
  });
  const provider = await startProvider(input => {
    if (input.tools?.[0]?.function.name === 'connection_check') return response([call('connection_check', {})]);
    const done = history(input).map(h => h.name);
    if (!done.includes('inspect')) return response([call('inspect', { hostId: hostId(), topic: 'overview' })], '先看一下服务器现状。');
    if (!done.includes('run')) return response([call('run', { hostId: hostId(), command: 'systemctl reload nginx' })], '配置正常，重新加载 nginx。');
    return response([call('finish', { outcome: 'completed', headline: 'nginx 已重新加载', summary: '检查了系统，重新加载了 nginx。', checks: [{ label: 'nginx 重新加载成功', status: 'passed' }], artifacts: [{ label: '配置文件', value: '/etc/nginx/nginx.conf' }] })], '完成，结果如下：\n| 项目 | 状态 |\n|---|---|\n| nginx | `active` |\n\n- 配置检查通过\n- 已重新加载');
  });

  let app, page, hostIdValue;
  const hostId = () => hostIdValue;
  const errors = [];
  const shot = async name => page.screenshot({ path: path.join(output, name + '.png') });
  const step = async (name, action) => {
    const started = Date.now();
    await action();
    console.log(`ok  ${name} (${Date.now() - started} ms)`);
  };

  try {
    const env = { ...process.env, TERMUS_DATA_DIR: path.join(run, 'data') };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: [root], env, timeout: 30000 });
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForSelector('html[data-ready="true"]');

    await step('empty hosts page', async () => {
      await page.getByRole('heading', { name: '添加第一台服务器' }).waitFor();
      await shot('dark-hosts-empty');
    });

    await step('add host', async () => {
      await page.getByRole('button', { name: '添加主机' }).first().click();
      await page.getByLabel('地址').fill('127.0.0.1');
      await page.getByLabel('端口').fill(String(fixture.port));
      await page.getByLabel('用户名').fill('tester');
      await page.getByLabel('名称').fill('fixture-web');
      await page.locator('#h-password').fill('local-test');
      await shot('dark-host-form');
      await page.getByRole('button', { name: '添加主机', exact: true }).last().click();
      await page.getByRole('link', { name: 'fixture-web' }).waitFor();
      hostIdValue = await page.locator('[data-host]').first().getAttribute('data-host');
      await shot('dark-hosts');
    });

    await step('terminal connects after trusting the host key', async () => {
      await page.getByRole('link', { name: 'fixture-web' }).click();
      await page.getByRole('button', { name: '信任并连接' }).click();
      await page.locator('.xterm-rows').filter({ hasText: 'Termus test server' }).waitFor({ timeout: 15000 });
      await page.locator('.xterm-helper-textarea').focus();
      await page.keyboard.type('hello');
      await page.keyboard.press('Enter');
      await page.locator('.xterm-rows').filter({ hasText: 'received: o' }).waitFor({ timeout: 10000 });
      assert.ok(fixture.received.map(r => r.text).join('').includes('hello'));
      await shot('dark-terminal');
    });

    await step('terminal search opens with Ctrl+F', async () => {
      await page.locator('.xterm-helper-textarea').focus();
      await page.keyboard.press('Control+f');
      await page.getByLabel('在终端中查找').waitFor();
      await page.keyboard.press('Escape');
    });

    await step('files list, new folder, rename, delete', async () => {
      await page.locator('.rail-item[data-page="files"]').click();
      await page.getByRole('button', { name: /fixture-web/ }).click();
      await page.locator('.files-list').getByText('readme.txt').waitFor({ timeout: 15000 });
      await shot('dark-files');
      await page.getByRole('button', { name: '新建文件夹' }).click();
      await page.getByLabel('名称').fill('site');
      await page.getByRole('button', { name: '新建', exact: true }).click();
      await page.locator('.files-list').getByText('site', { exact: true }).waitFor();
      assert.ok(fs.existsSync(path.join(remoteRoot, 'site')));
      const row = page.locator('.files-list .row', { hasText: 'readme.txt' });
      await row.hover();
      await row.getByRole('button', { name: '更多操作' }).click();
      await page.getByRole('menuitem', { name: '重命名' }).click();
      await page.getByLabel('新名称').fill('notes.txt');
      await page.getByRole('button', { name: '重命名', exact: true }).click();
      await page.locator('.files-list').getByText('notes.txt').waitFor();
      assert.ok(fs.existsSync(path.join(remoteRoot, 'notes.txt')));
      const renamed = page.locator('.files-list .row', { hasText: 'notes.txt' });
      await renamed.hover();
      await renamed.getByRole('button', { name: '更多操作' }).click();
      await page.getByRole('menuitem', { name: '删除…' }).click();
      await page.getByRole('button', { name: '删除文件' }).click();
      await page.locator('.files-list').getByText('notes.txt').waitFor({ state: 'detached' });
      assert.ok(!fs.existsSync(path.join(remoteRoot, 'notes.txt')));
    });

    await step('assistant asks for a model first', async () => {
      await page.locator('.rail-item[data-page="assistant"]').click();
      await page.getByRole('heading', { name: '先连接一个模型' }).waitFor();
      await shot('dark-assistant-setup');
    });

    await step('model settings save and test', async () => {
      await page.getByRole('button', { name: '设置模型' }).click();
      await page.getByLabel('接口地址').fill(provider.url);
      await page.getByLabel('模型名称').fill('fixture-model');
      await page.getByRole('button', { name: '保存' }).click();
      await page.getByText('已保存模型设置').waitFor();
      await page.getByRole('button', { name: '测试连接' }).click();
      await page.getByText('连接正常，模型支持工具调用').waitFor({ timeout: 15000 });
      await shot('dark-settings');
    });

    await step('assistant runs a task to a verified result', async () => {
      await page.locator('.rail-item[data-page="assistant"]').click();
      await page.getByRole('heading', { name: '要在服务器上做什么？' }).waitFor();
      await page.getByLabel('任务目标').fill('重新加载 nginx 配置');
      await page.getByRole('radio', { name: '直接执行' }).click();
      await page.getByRole('button', { name: '选择主机' }).click();
      await page.getByRole('checkbox', { name: /fixture-web/ }).check();
      await page.getByRole('button', { name: '确定' }).click();
      await shot('dark-assistant-compose');
      await page.getByRole('button', { name: '开始' }).click();
      await page.locator('.decision[data-kind="result"]').waitFor({ timeout: 30000 });
      assert.ok(commands.includes('systemctl reload nginx'));
      assert.equal(await page.locator('.msg-assistant .md-table td').count(), 2);
      assert.equal(await page.locator('.msg-assistant .md-list li').count(), 2);
      await page.locator('.console-row').first().click();
      await shot('dark-assistant-result');
    });

    await step('task manager lists and deletes tasks', async () => {
      await page.locator('[data-action="tasks"]').click();
      await page.getByRole('menuitem', { name: /全部任务/ }).click();
      await page.getByLabel('筛选任务').fill('nginx');
      await page.locator('#task-list [data-open-task]').first().waitFor();
      await shot('dark-task-manager');
      await page.locator('#task-list .row').first().hover();
      await page.locator('#task-list [data-remove-task]').first().click();
      await page.getByRole('button', { name: '删除任务' }).click();
      await page.getByRole('heading', { name: '要在服务器上做什么？' }).waitFor();
      assert.equal(await page.evaluate(async () => (await window.termlo.agentState()).tasks.length), 0);
    });

    await step('command palette', async () => {
      await page.keyboard.press('Control+k');
      await page.getByLabel('搜索主机或操作').fill('fixture');
      await shot('dark-palette');
      await page.keyboard.press('Escape');
    });

    await step('light theme', async () => {
      await page.getByRole('button', { name: '切换到亮色主题' }).click();
      await page.locator('html[data-theme="light"]').waitFor();
      await shot('light-assistant-compose');
      for (const name of ['hosts', 'terminal', 'files', 'settings']) {
        await page.locator(`.rail-item[data-page="${name}"]`).click();
        await page.waitForTimeout(250);
        await shot('light-' + name);
      }
    });

    await step('minimum window size', async () => {
      await page.setViewportSize({ width: 1000, height: 680 });
      for (const name of ['hosts', 'assistant', 'files']) {
        await page.locator(`.rail-item[data-page="${name}"]`).click();
        await page.waitForTimeout(250);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        assert.ok(!overflow, `${name} overflows horizontally at 1000px`);
        await shot('light-1000-' + name);
      }
    });

    assert.deepEqual(errors, [], 'renderer errors');
    console.log(`shell smoke passed · screenshots in ${path.relative(root, output)}`);
  } catch (error) {
    if (page) { await shot('failure').catch(() => {}); console.error('toasts:', await page.locator('#toasts').innerText().catch(() => '')); }
    if (errors.length) console.error('renderer errors:', errors);
    throw error;
  } finally {
    await app?.close().catch(() => {});
    await fixture.close();
    await provider.close();
    fs.rmSync(run, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
