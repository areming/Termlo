const waitForApi=require('./wait-for-api.cjs');
const {_electron:electron}=require('playwright-core');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {startFixture}=require('../test/fixture.cjs');const {startProvider,deploymentModel,remoteResponder}=require('../test/agent-fixture.cjs');
require('./build.cjs').build();
const root=path.join(__dirname,'..'),output=path.join(root,'test-output');fs.mkdirSync(output,{recursive:true});
const run=fs.mkdtempSync(path.join(output,'agent-')),data=path.join(run,'data');
async function main(){
 const commands=[];const fixture=await startFixture(path.join(run,'remote'),{exec:(cmd,stream)=>{commands.push(cmd);remoteResponder(cmd,stream);}});
 const gateway=await startFixture(path.join(run,'gateway'),{forward:{'worker.internal':fixture.port}});
 let ids=[];const provider=await startProvider(input=>deploymentModel(ids)(input));
 let app;const errors=[];
 try{
  const env={...process.env,TERMUS_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
  const packaged=process.argv.includes('--packaged');
  app=await electron.launch({args:packaged?[]:[root],...(packaged?{executablePath:path.join(root,require('../package.json').build.directories.output,'win-unpacked/Termlo.exe')}:{}),env,timeout:30000});
  app.process().stderr.on('data',d=>fs.appendFileSync(path.join(run,'electron.log'),d));
  const page=await app.firstWindow();
  await require('./auto-prompts.cjs')(page);
  await app.evaluate(({dialog,BrowserWindow},target)=>{dialog.showMessageBox=async()=>({response:1});dialog.showMessageBoxSync=()=>1;dialog.showSaveDialog=async()=>({canceled:false,filePath:target});BrowserWindow.getAllWindows()[0].setContentSize(1500,940);},path.join(run,'export.json'));
  page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>!!window.termus);
  ids=await page.evaluate(async({port,gatewayPort})=>{
   const base={username:'tester',auth:'password',password:'local-test',rememberPassword:true,group:'集群实验室',tags:'test, cluster',color:'mint'};
   let hosts=await window.termus.saveHost({...base,name:'control-plane',address:'127.0.0.1',port});const first=hosts.at(-1).id;
   hosts=await window.termus.saveHost({...base,name:'bastion',address:'127.0.0.1',port:gatewayPort});const jump=hosts.at(-1).id;
   hosts=await window.termus.saveHost({...base,name:'worker-01',address:'worker.internal',port:22,jumpHostId:jump});return [first,hosts.at(-1).id];
  },{port:fixture.port,gatewayPort:gateway.port});
  await page.reload();await page.locator('[data-view="assistant"]').click();
  await page.screenshot({path:path.join(output,'assistant-welcome.png')});
  await page.locator('#agent-settings-open').click();await page.locator('#agent-base-url').fill(provider.url);await page.locator('#agent-model').fill('fixture-compatible-model');await page.locator('#agent-key').fill('fixture-api-key-123');
  await page.locator('[name="clearKey"]').check();
  await page.locator('#agent-test').click();await page.waitForFunction(()=>document.querySelector('#agent-settings-result').textContent.includes('工具调用正常'));
  assert.equal(await page.locator('#agent-key').inputValue(),'');
  assert.equal(await page.locator('[name="clearKey"]').isChecked(),false);assert.match(await page.locator('#agent-key').getAttribute('placeholder'),/已加密/);
  await page.screenshot({path:path.join(output,'assistant-settings.png')});
  await page.locator('#agent-settings-form [type="submit"]').click();await page.locator('#agent-settings-dialog').waitFor({state:'hidden'});
  await page.locator('#agent-hosts-open').click();for(const id of ids)await page.locator(`#agent-host-picker input[value="${id}"]`).check();
  await page.locator('[data-close="agent-hosts-dialog"]').last().click();
  await require('./select-option.cjs')(page,'#agent-mode','autonomous');
  await page.locator('#agent-prompt').fill('检查两台机器，部署测试服务；遇到错误自行修复，最后验证结果。');await page.locator('#agent-send').click();
  await page.waitForFunction(()=>document.querySelector('#agent-status').textContent==='已完成',null,{timeout:30000});
  assert.ok(gateway.forwarded.includes('worker.internal'));assert.ok(commands.includes('repair-test'));assert.ok(commands.includes('verify-test'));
  const task=await page.evaluate(async()=>{const s=await window.termus.agentState();return window.termus.agentTask(s.tasks[0].id);});
  assert.equal(task.status,'completed');assert.equal(task.hostIds.length,2);assert.ok(task.events.some(e=>e.result?.exitCode===1));
  assert.equal(task.messages,undefined);assert.equal(await page.locator('.plan-step.done').count(),3);
  const group=page.locator('.tool-group').filter({hasText:'执行远程命令'}).last();if(await group.count())await group.locator(':scope > summary').click();
  await page.locator('.agent-tool').filter({hasText:'执行远程命令'}).last().locator('summary').click();
  await page.locator('#agent-feed').evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await page.locator('#toast').waitFor({state:'hidden'});
  await page.screenshot({path:path.join(output,'assistant-result.png')});
  assert.equal((await page.evaluate(()=>window.termus.agentState())).memoryCount,0);
  await page.locator('#agent-export').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('导出'));assert.equal(JSON.parse(fs.readFileSync(path.join(run,'export.json'))).id,task.id);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1000,700));await page.screenshot({path:path.join(output,'assistant-compact.png')});
  assert.ok(await page.locator('#agent-send').isVisible());assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#agent-new').click();await page.locator('#agent-prompt').fill('暂停验证：运行任务后暂停');await page.locator('#agent-send').click();
  await waitForApi(page,async()=>{const s=await window.termus.agentState();if(!s.activeId)return false;const t=await window.termus.agentTask(s.activeId);return t.events.some(e=>e.name==='read_job');});
  await page.locator('#agent-stop').click();await page.waitForFunction(()=>document.querySelector('#agent-status').textContent==='已暂停');
  await page.locator('#agent-prompt').fill('核对并继续');await page.locator('#agent-send').click();await page.waitForFunction(()=>document.querySelector('#agent-status').textContent==='已完成');
  assert.ok(commands.includes('verify-after-pause'));assert.equal(commands.filter(c=>c==='long-running').length,1);
  await page.reload();await page.locator('[data-view="assistant"]').click();await page.waitForFunction(()=>document.querySelectorAll('.task-item').length===2);
  await page.locator('.task-item').last().click();await page.waitForFunction(()=>document.querySelector('.agent-message.result')?.textContent.includes('测试任务已完成'));
  const settings=await page.evaluate(async()=> (await window.termus.agentState()).settings);assert.equal(settings.hasKey,true);assert.equal(settings.encryptedKey,undefined);
  assert.ok(!fs.existsSync(path.join(data,'assistant','memory.json')));
  for(const file of ['tasks.json','settings.json']){const text=fs.readFileSync(path.join(data,'assistant',file),'utf8');assert.ok(!text.includes('fixture-api-key-123'));assert.ok(!text.includes('local-test'));}
  const sent=JSON.stringify(provider.requests.map(r=>r.input));assert.ok(!sent.includes('local-test'));assert.ok(!sent.includes('fixture-api-key-123'));
  await page.evaluate(()=>{window.confirm=()=>true;});
  await page.locator('#agent-delete').click();await page.waitForFunction(()=>document.querySelectorAll('.task-item').length===1);
  assert.equal((await page.evaluate(()=>window.termus.agentState())).memoryCount,0);
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'agent-report.json'),JSON.stringify({ok:true,packaged,commands:commands.length,modelRequests:provider.requests.length,taskId:task.id,checked:['encrypted provider settings','tool calling','two hosts with jump','failure/recovery','live evidence without cross-task memory','export','pause/resume','reload','compact layout'],errors},null,2));
  console.log('Agent desktop integration passed:',JSON.stringify({packaged,commands:commands.length,requests:provider.requests.length,run}));
 }finally{if(app)await app.close();await provider.close();await gateway.close();await fixture.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});

