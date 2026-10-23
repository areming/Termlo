const {_electron:electron}=require('playwright-core');const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const {startFixture}=require('../test/fixture.cjs');
require('./build.cjs').build();const root=path.join(__dirname,'..'),output=path.join(root,'test-output');const run=fs.mkdtempSync(path.join(output,'design-'));
async function main(){
  const fixture=await startFixture(path.join(run,'remote'));let app;const errors=[];
  try{
    const packaged=process.argv.includes('--packaged'),env={...process.env,TERMUS_DATA_DIR:path.join(run,'data')};delete env.ELECTRON_RUN_AS_NODE;
    app=await electron.launch({args:packaged?[]:[root],...(packaged?{executablePath:path.join(root,require('../package.json').build.directories.output,'win-unpacked/Termlo.exe')}:{}),env});const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,900));await page.waitForFunction(()=>!!window.termus);
    const host=await page.evaluate(async port=>(await window.termus.saveHost({name:'Development server',address:'127.0.0.1',port,username:'tester',auth:'password',password:'local-test',rememberPassword:true,group:'Development',tags:'Linux, Staging',color:'mint'}))[0],fixture.port);
    await page.reload();await page.locator('#theme-toggle').click();await require('./host-action.cjs')(page,page.locator('.host-card').first());
    await page.locator('#app-prompt-dialog').waitFor({state:'visible'});assert.match(await page.locator('#app-prompt-detail').textContent(),/SHA256:/);
    await page.screenshot({path:path.join(output,'design-trust-light.png')});await page.locator('#app-prompt-dialog [data-response="0"]').click();
    await page.waitForFunction(()=>document.querySelector('#terminal-status').textContent.includes('已断开'));assert.equal((await page.evaluate(()=>window.termus.knownHosts())).length,0);
    await page.locator('#reconnect').click();await page.locator('#app-prompt-dialog').waitFor({state:'visible'});await page.locator('#app-prompt-dialog [data-response="1"]').click();
    await page.waitForFunction(()=>document.querySelector('#terminal-metrics[data-status="live"]')?.textContent.includes('40%'),null,{timeout:15000});
    assert.equal((await page.evaluate(()=>window.termus.hostMetrics())).length,1);
    assert.match(await page.locator('#terminal-metrics').textContent(),/38%/);assert.match(await page.locator('#terminal-metrics').textContent(),/30%/);assert.match(await page.locator('#terminal-metrics').textContent(),/64.0 KB/);
    await page.screenshot({path:path.join(output,'design-terminal-light.png')});
    assert.equal(await page.locator('.terminal-pane:not(.hidden) .xterm-viewport').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(248, 250, 251)');
    await page.locator('[data-view="hosts"]').click();assert.match(await page.locator('.host-card .host-metrics').textContent(),/40%/);await page.screenshot({path:path.join(output,'design-hosts-light.png')});
    await page.locator('#new-host').click();await page.screenshot({path:path.join(output,'design-form-light.png')});await page.locator('#host-dialog [data-close]').first().click();
    await require('./host-action.cjs')(page,page.locator('.host-card').first());await page.waitForFunction(()=>document.querySelector('#session-count').textContent==='2');assert.equal((await page.evaluate(()=>window.termus.hostMetrics())).length,1);
    await page.locator('#open-sftp').click();await page.waitForFunction(()=>document.querySelector('#sftp-metrics').textContent.includes('40%'));await page.screenshot({path:path.join(output,'design-sftp-light.png')});
    await page.locator('#security-open').click();await page.screenshot({path:path.join(output,'design-security-light.png')});await page.keyboard.press('Escape');
    await page.locator('#theme-toggle').click();await page.locator('[data-view="terminal"]').click();await page.screenshot({path:path.join(output,'design-terminal-dark.png')});
    await page.locator('#disconnect').click();await page.locator('#app-prompt-dialog').waitFor({state:'visible'});await page.keyboard.press('Escape');assert.equal(await page.locator('#disconnect').isDisabled(),false);
    await page.locator('#disconnect').click();await page.locator('#app-prompt-dialog [data-response="1"]').click();await page.waitForFunction(()=>document.querySelector('#terminal-status').textContent.includes('已断开'));
    assert.equal((await page.evaluate(()=>window.termus.hostMetrics()))[0].status,'live');
    await page.locator('.tab:has(.tab-dot.ready)').first().click();await page.locator('#disconnect').click();await page.locator('#app-prompt-dialog [data-response="1"]').click();
    await page.locator('[data-view="sftp"]').click();assert.equal(await page.locator('#sftp-state').textContent(),'已连接');await page.locator('#sftp-disconnect').click();await page.locator('#app-prompt-dialog [data-response="1"]').click();await page.waitForFunction(()=>document.querySelector('#terminal-metrics').dataset.status==='disconnected');
    assert.match(await page.locator('#terminal-metrics').textContent(),/已断开/);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1000,700));await page.locator('#theme-toggle').click();await page.locator('[data-view="hosts"]').click();await page.locator('#new-host').click();assert.ok(await page.locator('#host-dialog .dialog-actions').isVisible());await page.screenshot({path:path.join(output,'design-form-compact.png')});await page.keyboard.press('Escape');
    assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'design-report.json'),JSON.stringify({ok:true,packaged,version:require('../package.json').version,checks:['custom fingerprint reject/accept','no trust on rejection','CPU/memory/network/root disk','shared monitor across sessions','host/terminal/SFTP metrics','explicit disconnect state','light terminal viewport','unified forms and confirmations','Esc cancellation','compact form actions'],errors},null,2));console.log('Design integration passed',JSON.stringify({packaged,run}));
  }finally{if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close();}await fixture.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
