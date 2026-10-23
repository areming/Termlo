const {_electron:electron}=require('playwright-core');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {startFixture}=require('../test/fixture.cjs');const select=require('./select-option.cjs');
require('./build.cjs').build();const root=path.join(__dirname,'..'),output=path.join(root,'test-output');fs.mkdirSync(output,{recursive:true});const run=fs.mkdtempSync(path.join(output,'file-workspace-'));
async function main(){
  const remoteA=path.join(run,'remote-a'),remoteB=path.join(run,'remote-b');fs.mkdirSync(path.join(remoteA,'folder'),{recursive:true});fs.mkdirSync(remoteB,{recursive:true});fs.writeFileSync(path.join(remoteA,'hello.txt'),'server A');fs.writeFileSync(path.join(remoteB,'beta.txt'),'server B');
  const a=await startFixture(remoteA),b=await startFixture(remoteB),gateway=await startFixture(path.join(run,'gateway'),{forward:{'beta.internal':b.port}});
  const source=path.join(run,'roundtrip.bin'),target=path.join(run,'download.bin');fs.writeFileSync(source,Buffer.from([0,255,128,13,10,37,26]));let app;const errors=[];
  try{
    const packaged=process.argv.includes('--packaged'),env={...process.env,TERMUS_DATA_DIR:path.join(run,'data')};delete env.ELECTRON_RUN_AS_NODE;
    app=await electron.launch({args:packaged?[]:[root],...(packaged?{executablePath:path.join(root,require('../package.json').build.directories.output,'win-unpacked/Termlo.exe')}:{}),env});const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
    await app.evaluate(({BrowserWindow,dialog},{source,target})=>{BrowserWindow.getAllWindows()[0].setContentSize(1440,900);dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});dialog.showSaveDialog=async()=>({canceled:false,filePath:target});},{source,target});await page.waitForFunction(()=>!!window.termus);await require('./auto-prompts.cjs')(page);
    const ids=await page.evaluate(async({a,jump})=>{
      const base={username:'tester',auth:'password',password:'local-test',rememberPassword:true,group:'Files',color:'mint'};
      const one=(await window.termus.saveHost({...base,name:'Alpha web',address:'127.0.0.1',port:a})).at(-1).id;
      const gateway=(await window.termus.saveHost({...base,name:'Bastion',address:'127.0.0.1',port:jump})).at(-1).id;
      const two=(await window.termus.saveHost({...base,name:'Beta storage',address:'beta.internal',port:22,jumpHostId:gateway})).at(-1).id;
      const prompt=(await window.termus.saveHost({...base,password:'',rememberPassword:false,name:'Ask password',address:'127.0.0.1',port:a})).at(-1).id;
      return {one,two,prompt};
    },{a:a.port,jump:gateway.port});
    await page.reload();await page.locator('[data-view="sftp"]').click();assert.equal(await page.locator('#sftp-connect').isDisabled(),true);
    await select(page,'#sftp-session',ids.one);await page.locator('#sftp-connect').click();await page.waitForFunction(()=>document.querySelector('#remote-files').textContent.includes('hello.txt'));
    assert.equal(await page.locator('.terminal-pane').count(),0);assert.equal(a.shells.length,0,'file connection must never request a PTY/shell');
    await page.locator('#remote-files .file-row').filter({hasText:'folder'}).dblclick();await page.waitForFunction(()=>document.querySelector('#remote-path').value==='/folder');
    await page.locator('#upload').click();await page.waitForFunction(()=>document.querySelector('#remote-files').textContent.includes('roundtrip.bin'));
    assert.deepEqual(fs.readFileSync(path.join(remoteA,'folder','roundtrip.bin')),fs.readFileSync(source));
    await page.locator('#remote-files .file-row').filter({hasText:'roundtrip.bin'}).getByRole('button').click();await page.waitForFunction(()=>document.querySelector('#transfer-title').textContent.includes('已完成'));assert.deepEqual(fs.readFileSync(target),fs.readFileSync(source));
    await select(page,'#sftp-session',ids.two);assert.equal(await page.locator('#remote-files .file-row').count(),0);await page.locator('#sftp-connect').click();await page.waitForFunction(()=>document.querySelector('#remote-files').textContent.includes('beta.txt'));
    assert.equal(b.shells.length,0);assert.ok(gateway.forwarded.includes('beta.internal'));
    await select(page,'#sftp-session',ids.one);assert.equal(await page.locator('#remote-path').inputValue(),'/folder');assert.match(await page.locator('#remote-files').textContent(),/roundtrip.bin/);
    await page.locator('[data-view="hosts"]').click();await require('./host-action.cjs')(page,page.locator('.host-card').filter({hasText:'Alpha web'}),'编辑');await page.locator('#host-form [name="address"]').fill('changed.example.test');await page.locator('#host-form [type="submit"]').click();
    await page.locator('[data-view="sftp"]').click();assert.match(await page.locator('#sftp-session-trigger').textContent(),/127\.0\.0\.1/);assert.doesNotMatch(await page.locator('#sftp-session-trigger').textContent(),/changed/);
    await page.locator('[data-view="hosts"]').click();await require('./host-action.cjs')(page,page.locator('.host-card').filter({hasText:'Alpha web'}),'编辑');await page.locator('#host-form [name="address"]').fill('127.0.0.1');await page.locator('#host-form [name="password"]').fill('local-test');await page.locator('#host-form [name="rememberPassword"]').check();await page.locator('#host-form [type="submit"]').click();await page.locator('[data-view="sftp"]').click();
    await page.locator('#sftp-session-trigger').click();await page.screenshot({path:path.join(output,'files-dropdown-dark.png')});await page.keyboard.press('Escape');
    await page.locator('#theme-toggle').click();await page.locator('#sftp-session-trigger').click();await page.waitForTimeout(180);await page.screenshot({path:path.join(output,'files-dropdown-light.png')});await page.keyboard.press('Escape');
    await page.locator('[data-view="hosts"]').click();await require('./host-action.cjs')(page,page.locator('.host-card').filter({hasText:'Alpha web'}));await page.waitForFunction(()=>document.querySelector('#terminal-status').textContent.includes('已连接'));assert.equal(a.shells.length,1);
    await page.locator('#disconnect').click();await page.waitForFunction(()=>document.querySelector('#terminal-status').textContent.includes('已断开'));
    await page.locator('[data-view="sftp"]').click();assert.equal(await page.locator('#sftp-state').textContent(),'已连接');await page.locator('#remote-refresh').click();await page.waitForFunction(()=>document.querySelector('#remote-files').textContent.includes('roundtrip.bin'));
    await page.locator('[data-view="terminal"]').click();await page.locator('#reconnect').click();await page.waitForFunction(()=>document.querySelector('#terminal-status').textContent.includes('已连接'));
    await page.locator('[data-view="sftp"]').click();await page.locator('#sftp-disconnect').click();await page.waitForFunction(()=>document.querySelector('#sftp-state').textContent==='已断开');assert.equal(await page.locator('#remote-files .file-row').count(),0);
    await page.locator('[data-view="terminal"]').click();assert.match(await page.locator('#terminal-status').textContent(),/已连接/);
    await page.locator('[data-view="sftp"]').click();await select(page,'#sftp-session',ids.prompt);await page.locator('#sftp-connect').click();await page.locator('#credential-dialog').waitFor();await page.keyboard.press('Escape');await page.locator('#credential-dialog').waitFor({state:'hidden'});assert.equal(await page.locator('#sftp-state').textContent(),'未连接');
    await select(page,'#sftp-session',ids.one);await page.locator('#sftp-connect').click();await page.waitForFunction(()=>document.querySelector('#sftp-state').textContent==='已连接');await page.waitForFunction(()=>document.querySelector('#remote-files').textContent.includes('hello.txt'));
    await page.locator('[data-view="hosts"]').click();await page.locator('#new-host').click();
    await page.locator('#auth-trigger').focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');assert.equal(await page.locator('#host-form [name="auth"]').inputValue(),'key');assert.equal(await page.locator('#key-fields').isVisible(),true);
    await page.locator('#jump-host-trigger').click();await page.screenshot({path:path.join(output,'select-dialog-light.png')});await page.keyboard.press('Escape');assert.equal(await page.locator('#host-dialog').isVisible(),true);assert.equal(await page.locator('#jump-host-trigger').getAttribute('aria-expanded'),'false');
    await page.keyboard.press('Escape');await page.locator('#new-host').click();assert.match(await page.locator('#auth-trigger').textContent(),/密码/);assert.equal(await page.locator('#password-fields').isVisible(),true);await page.keyboard.press('Escape');
    await page.locator('[data-view="sftp"]').click();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1000,700));await page.locator('#sftp-session-trigger').click();await page.screenshot({path:path.join(output,'files-compact-light.png')});
    const bounds=await page.locator('#sftp-session-trigger-menu').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=1001);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.keyboard.press('Escape');
    const activeBefore=a.active()+b.active();assert.ok(activeBefore>=3);
    await page.reload();await page.locator('[data-view="sftp"]').click();await select(page,'#sftp-session',ids.two);assert.equal(await page.locator('#sftp-state').textContent(),'未连接');
    assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'file-workspace-report.json'),JSON.stringify({ok:true,packaged,version:require('../package.json').version,checks:['SFTP without shell or terminal','binary upload/download','independent close in both directions','multi-host switching retains path','jump host SFTP','credentials cancellation','reconnect and reload cleanup','themed popup and keyboard selection','Escape preserves dialog','form reset/programmatic values','light/dark/compact layouts'],errors},null,2));console.log('File workspace integration passed',JSON.stringify({packaged,run}));
  }catch(error){if(app){const page=await app.firstWindow();await page.screenshot({path:path.join(output,'files-failure.png')}).catch(()=>{});console.log(await page.evaluate(()=>({toast:document.querySelector('#toast').textContent,state:document.querySelector('#sftp-state').textContent,selected:document.querySelector('#sftp-session').value,notice:document.querySelector('#sftp-empty').textContent})),errors);}throw error;}
  finally{if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close();}await gateway.close();await a.close();await b.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
