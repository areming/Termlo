const waitForApi=require('./wait-for-api.cjs');
const {_electron:electron}=require('playwright-core');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {startFixture}=require('../test/fixture.cjs');
const {startProvider,response,call,history,remoteResponder}=require('../test/agent-fixture.cjs');
require('./build.cjs').build();
const root=path.join(__dirname,'..'),output=path.join(root,'test-output');fs.mkdirSync(output,{recursive:true});
const run=fs.mkdtempSync(path.join(output,'plan-entry-'));
async function main(){
 let app,hostId,planningCalls=0,plainNext=false;const errors=[],commands=[];
 const fixture=await startFixture(path.join(run,'remote'),{exec:(command,stream)=>{commands.push(command);remoteResponder(command,stream);}});
 const provider=await startProvider(input=>{
  if(input.tools.some(t=>t.function.name==='propose_plan')){
   planningCalls++;
   if(planningCalls===1||plainNext){plainNext=false;return response([],'方案已经讨论完成，请点击执行按钮。');}
   return response([call('propose_plan',{title:'本机测试服务验收',summary:'按讨论后的目标检查服务健康。',steps:['核对当前服务状态','执行健康检查','返回验收结果'],checks:['服务健康'],risks:[],questions:[]})]);
  }
  const verified=history(input).find(h=>h.result.command==='verify-test');
  return response(verified?[call('finish_task',{outcome:'completed',summary:'本机服务验收通过',headline:'服务健康',checks:[{label:'服务健康',status:'passed',hostId,evidenceIds:[verified.result.evidenceId]}],evidenceIds:[verified.result.evidenceId]})]:[call('exec_remote',{hostId,command:'verify-test'})]);
 });
 try{
  const packaged=process.argv.includes('--packaged'),env={...process.env,TERMUS_DATA_DIR:path.join(run,'data')};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:packaged?[]:[root],...(packaged?{executablePath:path.join(root,require('../package.json').build.directories.output,'win-unpacked/Termlo.exe')}:{}),env,timeout:30000});
  const page=await app.firstWindow();await page.waitForLoadState('load');page.on('pageerror',e=>errors.push(e.message));
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1500,900));
  await page.waitForFunction(()=>!!window.termus);await require('./auto-prompts.cjs')(page);
  hostId=await page.evaluate(async({port,url})=>{
   const hosts=await window.termus.saveHost({name:'验收节点',address:'127.0.0.1',port,username:'tester',auth:'password',password:'local-test',rememberPassword:true,group:'隔离测试',tags:'',color:'mint'});
   await window.termus.agentConfigure({baseUrl:url,model:'plan-entry-fixture',maxRounds:20});return hosts.at(-1).id;
  },{port:fixture.port,url:provider.url});
  await page.reload();await page.locator('[data-view="assistant"]').click();
  await page.locator('#agent-hosts-open').click();await page.locator(`#agent-host-picker input[value="${hostId}"]`).check();await page.locator('[data-close="agent-hosts-dialog"]').last().click();
  await page.locator('#agent-prompt').fill('一起规划服务验收');await page.locator('#agent-send').click();
  await page.waitForFunction(()=>document.querySelector('#agent-status').textContent==='等待讨论');
  assert.equal(await page.locator('#agent-plan-primary').textContent(),'整理方案');assert.equal(commands.length,0);
  await page.locator('#agent-plan-primary').click();
  await page.waitForFunction(()=>document.querySelector('#agent-plan-primary').textContent==='按方案执行'&&!document.querySelector('#agent-plan-primary').disabled);
  assert.equal(await page.locator('.agent-proposal').count(),1);assert.equal(commands.length,0);
  plainNext=true;await page.locator('#agent-prompt').fill('就这么定了');
  assert.equal(await page.locator('#agent-plan-primary').textContent(),'更新方案');assert.equal(await page.locator('.execute-plan').isDisabled(),true);
  await page.locator('#agent-send').click();
  await page.waitForFunction(()=>!!document.querySelector('.agent-proposal[data-revision="2"] .execute-plan')&&!document.querySelector('#agent-plan-primary').disabled);
  assert.equal(planningCalls,4);assert.equal(commands.length,0);
  await page.locator('#agent-feed').evaluate(el=>el.scrollTop=0);
  assert.ok(await page.locator('#agent-plan-primary').isVisible());
  await page.screenshot({path:path.join(output,'plan-entry-dark.png')});
  await page.locator('#theme-toggle').click();await page.screenshot({path:path.join(output,'plan-entry-light.png')});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1000,700));
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const box=await page.locator('#agent-plan-primary').boundingBox();assert.ok(box&&box.y>0&&box.y+box.height<700);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(output,'plan-entry-compact.png')});
  await page.locator('#agent-hosts-open').click();await page.locator(`#agent-host-picker input[value="${hostId}"]`).uncheck();await page.locator('[data-close="agent-hosts-dialog"]').last().click();
  assert.equal(await page.locator('#agent-plan-primary').textContent(),'更新方案');assert.equal(await page.locator('.execute-plan').isDisabled(),true);
  await page.locator('#agent-hosts-open').click();await page.locator(`#agent-host-picker input[value="${hostId}"]`).check();await page.locator('[data-close="agent-hosts-dialog"]').last().click();
  await page.reload();await page.locator('[data-view="assistant"]').click();await page.locator('.task-item').first().click();
  await page.waitForFunction(()=>document.querySelector('#agent-plan-primary').textContent==='按方案执行'&&!document.querySelector('#agent-plan-primary').disabled);
  await page.locator('#agent-plan-primary').click();
  await waitForApi(page,async()=>{const s=await window.termus.agentState();return !s.activeId&&s.tasks[0]?.status==='completed';});
  assert.deepEqual(commands,['verify-test']);await page.locator('#agent-plan-bar').waitFor({state:'hidden'});
  const task=await page.evaluate(async()=>{const s=await window.termus.agentState();return window.termus.agentTask(s.tasks[0].id);});assert.equal(task.approvedProposal.revision,2);
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'plan-entry-report.json'),JSON.stringify({ok:true,packaged,version:require('../package.json').version,planningCalls,commands,checks:['plain reply recovery','fixed execution entry','discussion regenerates plan','draft and scope guards','dark/light/compact','reload persistence','explicit SSH execution'],errors},null,2));
  console.log('Plan entry integration passed',JSON.stringify({packaged,planningCalls,commands}));
 }finally{if(app)await app.close();await provider.close();await fixture.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
