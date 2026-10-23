const waitForApi=require('./wait-for-api.cjs');
const {_electron:electron}=require('playwright-core');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {startFixture}=require('../test/fixture.cjs');const {startProvider,deploymentModel,remoteResponder,response,call,history}=require('../test/agent-fixture.cjs');
require('./build.cjs').build();const root=path.join(__dirname,'..'),output=path.join(root,'test-output');fs.mkdirSync(output,{recursive:true});const run=fs.mkdtempSync(path.join(output,'workbench-'));
async function main(){
 const commands=[],timers=new Set();let finished=0,ids=[];
 const fixture=await startFixture(path.join(run,'remote'),{exec:(command,stream)=>{
   commands.push(command);
   if(command!=='verify-test')return remoteResponder(command,stream);
   stream.write('\x1b[36m正在校验节点 · 10.20.0.12\x1b[0m\n第一阶段：检查网络与服务\n');
   const timer=setTimeout(()=>{timers.delete(timer);finished++;if(!stream.destroyed){stream.write('\x1b[32mReady · 健康检查通过\x1b[0m\n');stream.exit(0);stream.end();}},5000);timers.add(timer);
 }});
 const gateway=await startFixture(path.join(run,'gateway'),{forward:{'worker.internal':fixture.port}});
 const provider=await startProvider(input=>{
   if(input.tools.some(t=>t.function.name==='propose_plan')){
     const h=history(input);if(!h.some(r=>r.name==='inspect_host'))return response([call('inspect_host',{hostId:ids[0]})],'先读取环境，再一起确定部署规模。');
     const revised=input.messages.some(m=>m.role==='user'&&m.content.includes('四台'));
     return response([call('propose_plan',{title:revised?'四节点部署与验收':'确认部署规模',summary:'先核对环境，再部署测试服务，最后逐台验证。',steps:['核对节点资源与网络','部署服务并处理依赖','验证节点和服务健康'],checks:['全部节点 Ready','服务健康检查通过'],risks:['部署期间测试服务会重启'],questions:revised?[]:['这次使用几台机器？']})]);
   }
   const result=deploymentModel(ids)(input);
   for(const tool of result.choices[0].message.tool_calls||[])if(tool.function.name==='finish_task'&&!input.messages.some(m=>m.role==='user'&&m.content.includes('暂停验证'))){
     const args=JSON.parse(tool.function.arguments);Object.assign(args,{headline:'4 台节点已就绪',highlights:['补齐缺失依赖','四台主机健康检查通过','现场验收已完成'],checks:[{label:'全部节点 Ready',status:'passed'},{label:'服务健康检查通过',status:'passed'},{label:'生产负载',status:'unknown'}]});tool.function.arguments=JSON.stringify(args);
   }
   return result;
 });
 let app;const errors=[];
 try{
   const packaged=process.argv.includes('--packaged'),env={...process.env,TERMUS_DATA_DIR:path.join(run,'data')};delete env.ELECTRON_RUN_AS_NODE;
   app=await electron.launch({args:packaged?[]:[root],...(packaged?{executablePath:path.join(root,require('../package.json').build.directories.output,'win-unpacked/Termlo.exe')}:{}),env,timeout:30000});const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
   await app.evaluate(({dialog,BrowserWindow})=>{dialog.showMessageBox=async()=>({response:1});dialog.showMessageBoxSync=()=>1;BrowserWindow.getAllWindows()[0].setContentSize(1580,940);});
   await page.waitForFunction(()=>!!window.termus);
   await require('./auto-prompts.cjs')(page);
   for(const theme of ['dark','light']){
     if(theme==='light')await page.locator('#theme-toggle').click();
     await page.locator('#security-open').click();await page.locator('#security-dialog').waitFor({state:'visible'});
     assert.equal(await page.locator('#security-dialog [data-close] svg').count(),1,'close icon must be initialized');
     await page.locator('#security-dialog [data-close]').click();await page.locator('#security-dialog').waitFor({state:'hidden'});
     await page.locator('#security-open').click();await page.keyboard.press('Escape');await page.locator('#security-dialog').waitFor({state:'hidden'});
   }
   await page.locator('#theme-toggle').click();
   ids=await page.evaluate(async({port,jumpPort,url})=>{
     const base={username:'tester',auth:'password',password:'local-test',rememberPassword:true,group:'Workbench 测试',tags:'isolated',color:'mint'};let hosts=await window.termus.saveHost({...base,name:'bastion',address:'127.0.0.1',port:jumpPort});const gateway=hosts.at(-1).id,result=[];
     for(const name of ['control-plane','worker-01','worker-02','worker-03']){hosts=await window.termus.saveHost({...base,name,address:name==='worker-03'?'worker.internal':'127.0.0.1',port:name==='worker-03'?22:port,jumpHostId:name==='worker-03'?gateway:''});result.push(hosts.at(-1).id);}
     await window.termus.agentConfigure({baseUrl:url,model:'workbench-fixture',apiKey:'workbench-test-key',maxRounds:30});return result;
   },{port:fixture.port,jumpPort:gateway.port,url:provider.url});
   await page.reload();await page.locator('[data-view="assistant"]').click();assert.equal(await page.locator('#agent-mode').inputValue(),'plan');
   await page.screenshot({path:path.join(output,'workbench-welcome.png')});
   await page.locator('#agent-hosts-open').click();for(const id of ids.slice(0,2))await page.locator(`#agent-host-picker input[value="${id}"]`).check();await page.locator('[data-close="agent-hosts-dialog"]').last().click();
   await page.locator('#agent-prompt').fill('我们先一起规划测试服务的部署方案');await page.locator('#agent-send').click();await page.waitForFunction(()=>document.querySelector('#agent-status').textContent==='方案待确认');
   assert.equal(await page.locator('.execute-plan').isDisabled(),true);assert.ok(commands.every(c=>c.includes('=== SYSTEM')));assert.equal(await page.locator('.agent-proposal').count(),1);
   await page.locator('#agent-hosts-open').click();for(const id of ids.slice(2))await page.locator(`#agent-host-picker input[value="${id}"]`).check();await page.locator('[data-close="agent-hosts-dialog"]').last().click();
   await page.locator('#agent-prompt').fill('使用四台机器，验收时逐台检查 Ready 状态');await page.locator('#agent-send').click();await page.waitForFunction(()=>document.querySelector('.agent-proposal[data-revision="2"] .execute-plan')?.disabled===false);
   assert.equal(await page.locator('.execute-plan').count(),1);assert.ok(commands.every(c=>c.includes('=== SYSTEM')));
   await page.locator('#agent-feed').evaluate(el=>el.scrollTop=el.scrollHeight);await page.screenshot({path:path.join(output,'workbench-plan.png')});
   await page.locator('#agent-prompt').fill('尚未发送的修改');assert.equal(await page.locator('.execute-plan').isDisabled(),true);assert.equal(await page.locator('#agent-plan-primary').textContent(),'更新方案');assert.equal(await page.locator('#agent-mode').inputValue(),'plan');await page.locator('#agent-prompt').fill('');await page.locator('.execute-plan').click();
   await page.waitForFunction(()=>document.querySelectorAll('.agent-terminal-pane').length===4&&document.querySelector('#agent-terminal-grid').textContent.includes('第一阶段'),null,{timeout:30000});assert.equal(finished,0,'streamed SSH output must be visible before command completion');
   await page.locator('[data-console-layout="4"]').click();assert.equal(await page.locator('.agent-terminal-pane:not(.hidden)').count(),4);
   await page.locator('#agent-console-expand').click();await page.screenshot({path:path.join(output,'workbench-four-terminals.png')});
   assert.equal(await page.locator('.agent-workspace').isVisible(),false);
   await page.locator('#agent-console-expand').click();
   await page.waitForFunction(()=>document.querySelector('#agent-status').textContent==='需要补充',null,{timeout:30000});
   assert.ok(gateway.forwarded.includes('worker.internal'));assert.equal(await page.locator('.result-headline').last().textContent(),'尚有验收项未通过或未验证');assert.equal(await page.locator('.result-check.passed').count(),2);assert.equal(await page.locator('.result-check.unknown').count(),1);assert.equal(await page.locator('.agent-message.result .message-details').getAttribute('open'),null);
   await page.locator('#agent-feed').evaluate(el=>el.scrollTop=el.scrollHeight);await page.screenshot({path:path.join(output,'workbench-result.png')});
   const firstText=await page.locator('.agent-terminal-pane').first().textContent();assert.match(firstText,/Ready/);
   await page.locator('[data-console-layout="1"]').click();assert.equal(await page.locator('.agent-terminal-pane:not(.hidden)').count(),1);await page.locator('.execution-tab').last().click();assert.equal(await page.locator('.agent-terminal-pane:not(.hidden)').getAttribute('data-host-id'),ids.at(-1));
   await page.locator('[data-console-layout="2"]').click();assert.equal(await page.locator('.agent-terminal-pane:not(.hidden)').count(),2);
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1000,700));await page.screenshot({path:path.join(output,'workbench-compact.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.ok(await page.locator('#agent-send').isVisible());
   await page.reload();await page.locator('[data-view="assistant"]').click();await page.locator('.task-item').first().click();await page.waitForFunction(()=>document.querySelectorAll('.agent-terminal-pane').length===4);await page.waitForFunction(()=>document.querySelector('#agent-terminal-grid').textContent.includes('Ready'));
   const task=await page.evaluate(async()=>{const s=await window.termus.agentState();return window.termus.agentTask(s.tasks[0].id);});assert.equal(task.approvedProposal.revision,2);assert.equal(task.terminals.length,4);assert.ok(task.terminals.every(row=>row.activeJobs===0));assert.ok(!JSON.stringify(task.terminals).includes('local-test'));
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1580,940));
   await page.locator('#theme-toggle').click();await page.locator('#sidebar-toggle').click();
   assert.equal(await page.locator('html').getAttribute('data-theme'),'light');assert.equal(await page.locator('.sidebar').evaluate(el=>el.offsetWidth),64);
   await page.screenshot({path:path.join(output,'workbench-light.png')});
   await page.reload();await page.locator('[data-view="assistant"]').click();assert.equal(await page.locator('html').getAttribute('data-theme'),'light');assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'),'false');
   await require('./select-option.cjs')(page,'#agent-mode','autonomous');await page.locator('#agent-hosts-open').click();for(const id of ids)await page.locator(`#agent-host-picker input[value="${id}"]`).check();await page.locator('[data-close="agent-hosts-dialog"]').last().click();
   await page.locator('#agent-prompt').fill('暂停验证：手动终端接管测试');await page.locator('#agent-send').click();
   await waitForApi(page,async()=>{const s=await window.termus.agentState();if(!s.activeId)return false;return (await window.termus.agentTask(s.activeId)).events.some(e=>e.name==='read_job');});
   const liveId=await page.evaluate(async()=>(await window.termus.agentState()).activeId);
   await page.locator('[data-console-layout="4"]').click();
   const firstPane=page.locator(`.agent-terminal-pane[data-host-id="${ids[0]}"]`),jumpPane=page.locator(`.agent-terminal-pane[data-host-id="${ids[3]}"]`);
   await firstPane.locator('.manual-toggle').click();await page.waitForFunction(()=>document.querySelector('.manual-screen')?.textContent.includes('tester@fixture'));
   assert.equal((await page.evaluate(()=>window.termus.agentState())).activeId,null);assert.equal(await page.locator('#agent-status').textContent(),'已暂停');
   await firstPane.locator('.manual-screen textarea').pressSequentially('manual-private-probe');await firstPane.locator('.manual-screen textarea').press('Enter');
   await page.waitForFunction(()=>document.querySelector('.manual-screen')?.textContent.includes('received:'));
   assert.ok(fixture.received.map(x=>x.text).join('').includes('manual-private-probe'));
   await firstPane.locator('.manual-screen textarea').focus();
   await firstPane.locator('.manual-screen textarea').evaluate(el=>{const data=new DataTransfer();data.setData('text/plain','paste-review-one\npaste-review-two\n');el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});
   await page.locator('#paste-dialog').waitFor({state:'visible'});assert.ok(!fixture.received.map(x=>x.text).join('').includes('paste-review-one'));
   await page.locator('#paste-confirm').click();await page.waitForFunction(()=>document.querySelector('.manual-screen')?.textContent.includes('paste-review-two'));
   assert.ok(fixture.received.map(x=>x.text).join('').includes('paste-review-one\rpaste-review-two'));
   const blocked=await page.evaluate(async id=>{try{await window.termus.agentResume({id,message:'核对并继续'});return '';}catch(e){return e.message;}},liveId);assert.match(blocked,/手动终端/);
   const rejected=await page.evaluate(async id=>{try{await window.termus.agentManualOpen('out-of-scope',id,'missing',{},{});return '';}catch(e){return e.message;}},liveId);assert.match(rejected,/范围/);
   await jumpPane.locator('.manual-toggle').click();await page.waitForFunction(()=>document.querySelectorAll('.manual-screen').length===2&&[...document.querySelectorAll('.manual-screen')].every(p=>p.textContent.includes('tester@fixture')));
   await jumpPane.locator('.manual-screen textarea').pressSequentially('jump-probe');await jumpPane.locator('.manual-screen textarea').press('Enter');
   await page.locator('#agent-console-expand').click();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   assert.ok(await page.locator('.agent-terminal-pane').evaluateAll(panes=>panes.every(p=>p.getBoundingClientRect().right<=innerWidth+1)),'all four panes must fit inside the window');
   await page.screenshot({path:path.join(output,'workbench-interactive-light.png')});await page.locator('#theme-toggle').click();await page.screenshot({path:path.join(output,'workbench-interactive-dark.png')});await page.locator('#agent-console-expand').click();
   await firstPane.locator('.manual-toggle').click();await jumpPane.locator('.manual-toggle').click();assert.equal(await page.locator('.manual-screen').count(),0);
   await page.locator('#agent-prompt').fill('核对并继续');await page.locator('#agent-send').click();await page.waitForFunction(()=>document.querySelector('#agent-status').textContent==='已完成');
   assert.ok(commands.includes('verify-after-pause'));assert.ok(!JSON.stringify(provider.requests).includes('manual-private-probe'));
   const updated=await page.evaluate(id=>window.termus.agentTask(id),liveId);assert.ok(!JSON.stringify(updated).includes('manual-private-probe'));assert.equal((await page.evaluate(()=>window.termus.agentState())).memoryCount,0);
   await firstPane.locator('.manual-toggle').click();await page.waitForFunction(()=>document.querySelector('.manual-screen')?.textContent.includes('tester@fixture'));await page.reload();
   const resumed=await page.evaluate(async id=>window.termus.agentResume({id,message:'核对并继续'}),liveId);assert.equal(resumed.id,liveId);await waitForApi(page,async id=>{const state=await window.termus.agentState();const task=await window.termus.agentTask(id);return !state.activeId&&task.status!=='running';},liveId);
   assert.equal((await page.evaluate(id=>window.termus.agentTask(id),liveId)).status,'completed');
   assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'workbench-report.json'),JSON.stringify({ok:true,packaged,version:require('../package.json').version,commands:commands.length,checks:['Plan read-only','proposal revision','live SSH output','1/2/4 layouts','concise result','theme persistence','collapsed sidebar','interactive PTY and jump host','automatic pause','backend execution interlock','manual host scope','manual input privacy','resume live inspection','reload closes manual sessions','no automatic memory'],errors},null,2));console.log('Workbench integration passed',JSON.stringify({packaged,run,commands:commands.length}));
 }finally{if(app)await app.close();for(const timer of timers)clearTimeout(timer);await provider.close();await gateway.close();await fixture.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});


