const {_electron:electron}=require('playwright-core');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {startFixture}=require('../test/fixture.cjs');
require('./build.cjs').build();
const root=path.join(__dirname,'..'),run=fs.mkdtempSync(path.join(root,'test-output','deploy-ui-')),commands=[];
function deployResponder(command,stream){
  commands.push(command);
  if(command.includes('TERMLO_PREFLIGHT=READY'))stream.write('Linux fixture\nDocker Compose v2\nDisk 20 GB free\nMemory 8192 MB\nTERMLO_PREFLIGHT=READY\n');
  else if(command.includes('TERMLO_DEPLOYMENT=READY'))stream.write('SERVICE_URL=http://127.0.0.1:8080\nSWAGGER_URL=http://127.0.0.1:8080/docs\nINSTALL_DIR=$HOME/termlo-user-api-1.2.0/user-api\nDATA_VOLUME=termlo-user-api_users\nTERMLO_DEPLOYMENT=READY\n');
  else{stream.stderr.write('Unexpected remote deployment command\n');stream.exit(2);stream.end();return;}
  stream.exit(0);stream.end();
}
async function main(){
  const remoteRoot=path.join(run,'remote');fs.mkdirSync(path.join(remoteRoot,'tmp'),{recursive:true});
  const fixture=await startFixture(remoteRoot,{exec:deployResponder});let app;
  try{
    const packaged=process.argv.includes('--packaged'),env={...process.env,TERMUS_DATA_DIR:path.join(run,'data')};delete env.ELECTRON_RUN_AS_NODE;
    app=await electron.launch({args:packaged?[]:[root],...(packaged?{executablePath:path.join(root,require('../package.json').build.directories.output,'win-unpacked/Termlo.exe')}:{}),env});
    const page=await app.firstWindow();await require('./auto-prompts.cjs')(page);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.locator('#onboarding:not(.hidden)').waitFor();await page.locator('#onboarding-exit').click();await page.locator('#onboarding').waitFor({state:'hidden'});
    await page.locator('#new-host').click();
    for(const [name,value] of Object.entries({name:'Demo API node',address:'127.0.0.1',port:String(fixture.port),username:'tester',password:'local-test'}))await page.locator(`#host-form [name="${name}"]`).fill(value);
    await page.locator('#host-form [name="rememberPassword"]').check();await page.locator('#host-form [type="submit"]').click();await page.locator('#host-dialog').waitFor({state:'hidden'});
    const host=(await page.evaluate(()=>window.termus.init())).hosts[0];assert.equal(host.name,'Demo API node');
    await page.locator('[data-view="assistant"]').click();
    const before=await page.evaluate(()=>window.termus.agentState());assert.equal(before.settings.baseUrl,'');assert.equal(before.settings.model,'');
    await page.locator('#agent-deploy-open').click();await page.locator('#agent-deploy-dialog').waitFor({state:'visible'});
    assert.equal(await page.locator('#agent-deploy-hosts input').count(),1);assert.equal(await page.locator('#agent-deploy-hosts input').isChecked(),true);
    assert.match(await page.locator('#agent-deploy-dialog').textContent(),/不调用大模型/);
    await page.locator('#agent-deploy-confirm').click();await page.locator('#agent-deploy-dialog').waitFor({state:'hidden',timeout:30000});
    await page.waitForFunction(async()=>{const s=await window.termus.agentState();if(!s.tasks[0]||s.activeId)return false;const t=await window.termus.agentTask(s.tasks[0].id);return t.status==='completed'&&t.stagingChanges?.length===1&&t.stagingChanges[0].state==='cleaned';},{},{timeout:30000});
    const result=await page.evaluate(async()=>{const state=await window.termus.agentState();return window.termus.agentTask(state.tasks[0].id);});
    assert.deepEqual(result.hostIds,[host.id]);assert.equal(result.mode,'autonomous');assert.equal(result.status,'completed');
    assert.equal(result.model,'Termlo 内置部署');assert.equal(result.rounds,0);assert.equal(result.tokens,0);
    assert.equal(commands.length,2);assert.ok(commands[0].includes('TERMLO_PREFLIGHT=READY'));assert.ok(commands[1].includes('TERMLO_DEPLOYMENT=READY'));
    assert.match(commands[1],/docker compose -p termlo-user-api/);assert.ok(result.events.some(e=>e.type==='result'&&e.report?.headline==='用户服务已安装并通过接口检查'));
    assert.deepEqual(errors,[]);
    console.log('Account API fixed deployment passed',JSON.stringify({packaged,task:result.id,hostCount:result.hostIds.length,modelRequests:result.rounds,remoteScripts:commands.length}));
  }finally{if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close();}await fixture.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
