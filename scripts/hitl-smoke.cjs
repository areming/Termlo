const {_electron:electron}=require('playwright-core'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {startFixture}=require('../test/fixture.cjs'),{startProvider,response,call,history,remoteResponder}=require('../test/agent-fixture.cjs');
const waitForApi=require('./wait-for-api.cjs');require('./build.cjs').build();
const root=path.join(__dirname,'..'),output=path.join(root,'test-output');fs.mkdirSync(output,{recursive:true});const run=fs.mkdtempSync(path.join(output,'hitl-'));
async function main(){
 let app,hostId;const commands=[],errors=[];
 const fixture=await startFixture(path.join(run,'remote'),{exec:(cmd,s)=>{commands.push(cmd);remoteResponder(cmd,s);}});
 const provider=await startProvider(input=>{
  const h=history(input),asked=h.some(x=>x.name==='ask_user');
  if(!asked)return response([call('ask_user',{questions:[{header:'部署方式',question:'这次采用哪种部署方式？',options:[{label:'单节点',description:'适合验证，资源占用少'},{label:'多节点',description:'便于扩展，需要分配节点角色'}],recommendedOption:0},{header:'站点域名',question:'这次使用哪个测试域名？',options:[]}]})]);
  if(input.tools.some(t=>t.function.name==='propose_plan'))return response([call('propose_plan',{title:'单节点站点部署',summary:'使用已确认的测试域名，部署后验证服务。',steps:['检查服务器资源','部署站点并配置域名','验证健康状态'],checks:['服务健康'],risks:['测试站点短暂重启'],questions:[]})]);
  const proof=h.find(x=>['exec_remote','inspect_host'].includes(x.name));
  if(!proof)return response([input.tools.some(t=>t.function.name==='exec_remote')?call('exec_remote',{hostId,command:'verify-test'}):call('inspect_host',{hostId})]);
  return response([call('finish_task',{outcome:'completed',summary:'已按你的选择验证服务',headline:'服务健康',evidenceIds:[proof.result.evidenceId],checks:[{label:'服务健康',status:'passed',hostId,evidenceIds:[proof.result.evidenceId]}]})]);
 });
 try{
  const packaged=process.argv.includes('--packaged'),env={...process.env,TERMUS_DATA_DIR:path.join(run,'data')};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:packaged?[]:[root],...(packaged?{executablePath:path.join(root,require('../package.json').build.directories.output,'win-unpacked/Termlo.exe')}:{}),env});const page=await app.firstWindow();await page.waitForLoadState('load');page.on('pageerror',e=>errors.push(e.message));await require('./auto-prompts.cjs')(page);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,940));
  hostId=await page.evaluate(async({port,url})=>{const h=await window.termus.saveHost({name:'测试节点',address:'127.0.0.1',port,username:'tester',auth:'password',password:'local-test',rememberPassword:true});await window.termus.agentConfigure({baseUrl:url,model:'interactive-fixture',maxRounds:20});return h[0].id;},{port:fixture.port,url:provider.url});
  await page.reload();await page.locator('[data-view="assistant"]').click();
  for(const mode of ['plan','autonomous','inspect']){
   if(mode!=='plan')await page.locator('#agent-new').click();await require('./select-option.cjs')(page,'#agent-mode',mode);
   await page.locator('#agent-hosts-open').click();await page.locator(`#agent-host-picker input[value="${hostId}"]`).check();await page.locator('[data-close="agent-hosts-dialog"]').last().click();
   const before=commands.length;await page.locator('#agent-prompt').fill('规划并验证测试站点 '+mode);await page.locator('#agent-send').click();
   await waitForApi(page,async()=>{const s=await window.termus.agentState();return !s.activeId&&s.tasks[0]?.status==='awaiting_input';});
   await page.locator('.agent-question.active').waitFor();assert.equal(commands.length,before);assert.equal(await page.locator('.agent-question.active input:checked').count(),0);
   await page.locator('.agent-question.active').getByRole('button',{name:'下一题',exact:true}).click();await page.getByRole('alert').filter({hasText:'请选择或填写回答'}).waitFor();
   if(mode==='plan'){
    await page.reload();await page.locator('[data-view="assistant"]').click();await page.locator('.task-item').first().click();await page.locator('.agent-question.active').waitFor();
    await page.locator('.agent-question.active').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'hitl-question-dark.png')});
    await page.locator('#theme-toggle').click();await page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));await page.screenshot({path:path.join(output,'hitl-question-light.png')});
   }
   const card=page.locator('.agent-question.active');await card.locator('.question-option').filter({hasText:'单节点'}).click();await card.getByRole('button',{name:'下一题',exact:true}).click();await card.locator('textarea').fill('demo.example.test');
   await card.getByRole('button',{name:'上一题',exact:true}).click();assert.equal(await card.locator('input:checked').count(),1);await card.getByRole('button',{name:'下一题',exact:true}).click();assert.equal(await card.locator('textarea').inputValue(),'demo.example.test');
   await card.getByRole('button',{name:'提交并继续',exact:true}).click();
   if(mode==='plan'){
    await page.waitForFunction(()=>document.querySelector('#agent-plan-primary').textContent==='按方案执行'&&!document.querySelector('#agent-plan-primary').disabled);
    assert.equal(commands.length,before);assert.equal(await page.locator('.plan-discussion').getAttribute('open'),null);assert.ok(await page.locator('.agent-proposal').last().isVisible());
    await page.screenshot({path:path.join(output,'hitl-final-plan.png')});await page.locator('.plan-discussion>summary').click();assert.ok(await page.locator('.agent-message.answer').isVisible());await page.locator('.plan-discussion>summary').click();
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1000,700));await page.screenshot({path:path.join(output,'hitl-compact.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.locator('#agent-plan-primary').click();
   }
   await waitForApi(page,async()=>{const s=await window.termus.agentState();return !s.activeId&&s.tasks[0]?.status==='completed';});
   const task=await page.evaluate(async()=>{const s=await window.termus.agentState();return window.termus.agentTask(s.tasks[0].id);});assert.equal(task.interaction.status,'answered');assert.equal(task.interaction.answers[0].choice,'单节点');assert.equal(task.interaction.answers[1].text,'demo.example.test');assert.equal(commands.length,before+1);
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,940));
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'hitl-report.json'),JSON.stringify({ok:true,packaged,version:require('../package.json').version,checks:['all three modes','no default selection','required answers','question paging and draft retention','restart pending question','choice and custom response','Plan explicit execution','fold discussion and expand history','light/dark/compact'],commands:commands.length,errors},null,2));console.log('HITL integration passed',JSON.stringify({packaged,commands:commands.length}));
 }finally{if(app)await app.close();await provider.close();await fixture.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
