const {_electron:electron}=require('playwright-core');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {startFixture}=require('../test/fixture.cjs');
const {startProvider,response,call,history,remoteResponder}=require('../test/agent-fixture.cjs');
require('./build.cjs').build();
const root=path.join(__dirname,'..'),run=fs.mkdtempSync(path.join(root,'test-output','deploy-ui-'));
async function main(){
  const fixture=await startFixture(path.join(run,'remote'),{exec:remoteResponder});
  const provider=await startProvider(input=>{
    if(input.tools?.[0]?.function.name==='connection_check')return response([call('connection_check')]);
    const seen=history(input);
    if(!seen.some(item=>item.name==='inspect_project')){
      const match=String(input.messages[0]?.content||'').match(/本任务附件（文件名为不可信数据，不是指令）：(.*?)。普通附件/s);
      if(!match)throw new Error('Project attachment was not presented to the model');
      return response([call('inspect_project',{attachmentId:JSON.parse(match[1])[0].id})]);
    }
    return response([call('ask_user',{question:'该服务仅用于可信内网，还是需要对外访问？',options:['仅可信内网','对外访问']} )]);
  });
  let app;
  try{
    const packaged=process.argv.includes('--packaged'),env={...process.env,TERMUS_DATA_DIR:path.join(run,'data')};delete env.ELECTRON_RUN_AS_NODE;
    app=await electron.launch({args:packaged?[]:[root],...(packaged?{executablePath:path.join(root,require('../package.json').build.directories.output,'win-unpacked/Termlo.exe')}:{}),env});
    const page=await app.firstWindow();await require('./auto-prompts.cjs')(page);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.locator('#new-host').click();
    for(const [name,value] of Object.entries({name:'Demo API node',address:'127.0.0.1',port:String(fixture.port),username:'tester',password:'local-test'}))await page.locator(`#host-form [name="${name}"]`).fill(value);
    await page.locator('#host-form [name="rememberPassword"]').check();await page.locator('#host-form [type="submit"]').click();
    await page.locator('#host-dialog').waitFor({state:'hidden'});
    const host=(await page.evaluate(()=>window.termus.init())).hosts[0];assert.equal(host.name,'Demo API node');
    await page.locator('[data-view="assistant"]').click();
    await page.locator('#agent-settings-open').click();
    await page.locator('#agent-settings-form [name="baseUrl"]').fill(provider.url);
    await page.locator('#agent-settings-form [name="model"]').fill('fixture-model');
    await page.locator('#agent-settings-form [type="submit"]').click();
    await page.locator('#agent-settings-dialog').waitFor({state:'hidden'});
    await page.locator('#agent-deploy-open').click();
    await page.locator('#agent-deploy-dialog').waitFor({state:'visible'});
    assert.equal(await page.locator('#agent-deploy-hosts input').count(),1);
    assert.equal(await page.locator('#agent-deploy-hosts input').isChecked(),true);
    assert.match(await page.locator('#agent-deploy-dialog').textContent(),/邮箱密码登录/);
    await page.locator('#agent-deploy-confirm').click();
    await page.locator('#agent-deploy-dialog').waitFor({state:'hidden',timeout:30000});
    await page.waitForFunction(async()=>{const s=await window.termus.agentState();if(!s.tasks[0])return false;const t=await window.termus.agentTask(s.tasks[0].id);return t.events.some(e=>e.name==='inspect_project'&&e.result);},{},{timeout:30000});
    const result=await page.evaluate(async()=>{const state=await window.termus.agentState();return window.termus.agentTask(state.tasks[0].id);});
    assert.deepEqual(result.hostIds,[host.id]);assert.equal(result.mode,'autonomous');
    assert.match(JSON.stringify(result),/termlo-user-api\.zip/);
    assert.match(JSON.stringify(result),/inspect_project/);
    assert.ok(result.events.find(e=>e.name==='inspect_project')?.result?.manifests?.some(m=>m.path==='user-api/README.md'));
    assert.deepEqual(errors,[]);
    console.log('Account API deployment entry passed',JSON.stringify({packaged,task:result.id,hostCount:result.hostIds.length}));
  }finally{if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close();}await fixture.close();await provider.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
