const {_electron:electron}=require('playwright-core');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {startFixture}=require('../test/fixture.cjs');
const {startProvider,response,call,history,remoteResponder}=require('../test/agent-fixture.cjs');
require('./build.cjs').build();
const root=path.join(__dirname,'..'),output=path.join(root,'test-output');fs.mkdirSync(output,{recursive:true});
const run=fs.mkdtempSync(path.join(output,'workspaces-'));
async function main(){
 let app,hostId,release,followupIds=[],hold=false,first=true;const skipSystemClipboard=process.argv.includes('--skip-system-clipboard');
 const commands=[],errors=[];
 const fixture=await startFixture(path.join(run,'remote'),{exec:(cmd,s)=>{commands.push(cmd);remoteResponder(cmd,s);}});
 const provider=await startProvider(async input=>{
   if(hold)return new Promise(r=>release=r);
   if(first){first=false;return new Promise(r=>release=r);}
   const h=history(input);
   if(!h.some(e=>e.name==='apply_followup'))return response([call('apply_followup',{ids:followupIds,status:'applied',note:'只检查现场，不安装、不重启。'})]);
   if(!h.some(e=>e.name==='inspect_host'))return response([call('inspect_host',{hostId})]);
   const proof=h.find(e=>e.name==='inspect_host').result.evidenceId;
   return response([call('finish_task',{outcome:'completed',headline:'现场检查完成',summary:'已按新增约束完成只读检查。',evidenceIds:[proof],checks:[{label:'环境可读取',status:'passed',hostId,evidenceIds:[proof],method:'inspect_host',expected:'成功返回系统状态'}],artifacts:[{label:'测试站点',value:'https://example.com',hostId}]})]);
 });
 try{
   const packaged=process.argv.includes('--packaged'),env={...process.env,TERMUS_DATA_DIR:path.join(run,'data')};delete env.ELECTRON_RUN_AS_NODE;
   app=await electron.launch({args:packaged?[]:[root],...(packaged?{executablePath:path.join(root,require('../package.json').build.directories.output,'win-unpacked/Termlo.exe')}:{}),env});
   const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
   if(skipSystemClipboard)await app.evaluate(({clipboard})=>{global.__termusClipboardWrites=[];const write=clipboard.writeText.bind(clipboard);clipboard.writeText=async text=>{global.__termusClipboardWrites.push(text);return write(text);};});
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,900));
   await require('./auto-prompts.cjs')(page);
   await page.waitForFunction(()=>document.querySelector('#workspace-name')?.textContent==='默认项目');
   hostId=await page.evaluate(async({port,url})=>{
     const hosts=await window.termus.saveHost({name:'Legacy host',address:'127.0.0.1',port,username:'tester',auth:'password',password:'local-test',rememberPassword:true});
     await window.termus.agentConfigure({baseUrl:url,model:'workspace-fixture',apiKey:'isolated-secret-key',maxRounds:20});return hosts[0].id;
   },{port:fixture.port,url:provider.url});
   await page.reload();await page.locator('#workspace-switch').click();await page.locator('#workspace-menu button').filter({hasText:'新建项目空间'}).click();
   await page.locator('#workspace-create-dialog input').fill('实验项目');await page.locator('#workspace-create-dialog [type=submit]').click();
   await page.locator('#workspace-menu').waitFor({state:'visible'});await page.screenshot({path:path.join(output,'workspace-dark.png')});
   await page.keyboard.press('Escape');assert.equal(await page.locator('#workspace-menu').isVisible(),false);
   await page.locator('[data-view="assistant"]').click();await require('./select-option.cjs')(page,'#agent-mode','autonomous');
   await page.locator('#agent-hosts-open').click();await page.locator(`#agent-host-picker input[value="${hostId}"]`).check();await page.locator('[data-close="agent-hosts-dialog"]').last().click();
   await page.locator('#agent-prompt').fill('检查机器环境');await page.locator('#agent-send').click();
   await page.waitForFunction(()=>document.querySelector('#agent-status').textContent==='进行中');
   while(!release)await new Promise(r=>setTimeout(r,20));
   for(const text of ['只读取，不安装软件','不要重启']){await page.locator('#agent-prompt').fill(text);await page.locator('#agent-send').click();}
   await page.waitForFunction(()=>document.querySelectorAll('.followup-receipt.queued').length===2);
   const taskId=await page.evaluate(async()=>{const s=await window.termus.agentState();return s.activeId;});
   followupIds=await page.evaluate(async id=>(await window.termus.agentTask(id)).followups.map(x=>x.id),taskId);
   await page.screenshot({path:path.join(output,'agent-followups.png')});
   release(response([call('exec_remote',{hostId,command:'stale-must-not-run'})]));release=null;
   await page.waitForFunction(()=>document.querySelector('#agent-status').textContent==='已完成');
   assert.equal(await page.locator('.followup-receipt.applied').count(),2);assert.ok(!commands.includes('stale-must-not-run'));
   await require('./wait-for-api.cjs')(page,async id=>{const s=await window.termus.agentState(),t=await window.termus.agentTask(id);return !s.activeId&&JSON.parse(document.querySelector('#agent-feed').dataset.revision)[1]===t.feedRevision;},taskId);
   await page.locator('.result-artifact').click();
   if(skipSystemClipboard){await page.waitForFunction(()=>document.querySelector('.toast')?.textContent==='已复制');assert.equal(await app.evaluate(()=>global.__termusClipboardWrites.at(-1)),'https://example.com');}
   else{await require('./wait-for-api.cjs')(page,async()=>await window.termus.readClipboard()==='https://example.com');assert.equal(await app.evaluate(async({clipboard})=>await clipboard.readText()),'https://example.com');}
   assert.match(await page.locator('.result-check').getAttribute('title'),/inspect_host/);
   await page.locator('#agent-feed').evaluate(el=>el.scrollTop=el.scrollHeight);await page.screenshot({path:path.join(output,'agent-verified-result.png')});
   const switchTo=async(account,space,name)=>{await page.evaluate(({account,space})=>window.termus.workspaceSwitch(account,space),{account,space});await page.waitForEvent('load');await page.waitForFunction(name=>document.querySelector('#workspace-name')?.textContent===name,name);};
   const spaces=await page.evaluate(()=>window.termus.workspaceState()),lab=spaces.accounts[0].spaces.find(s=>s.name==='实验项目').id;
   // A running agent and an independent SFTP connection must be paused/closed on switching.
   await page.evaluate(id=>window.termus.connectFiles('scope-files',id,{}),hostId);
   hold=true;const pausedId=(await page.evaluate(id=>window.termus.agentStart({prompt:'等待中的隔离任务',hostIds:[id]}),hostId)).id;
   await switchTo('local',lab,'实验项目');
   assert.equal((await page.evaluate(()=>window.termus.init())).hosts.length,0);
   assert.equal((await page.evaluate(()=>window.termus.agentState())).tasks.length,0);
   assert.equal((await page.evaluate(()=>window.termus.agentState())).settings.model,'workspace-fixture');
   for(const action of ['host','task','connection']){const error=await page.evaluate(async({action,hostId,taskId})=>{try{if(action==='host')await window.termus.connectionPlan(hostId);if(action==='task')await window.termus.agentTask(taskId);if(action==='connection')await window.termus.listRemote('scope-files','/');return '';}catch(e){return e.message;}},{action,hostId,taskId});assert.ok(error,action+' must be inaccessible');}
   await page.locator('#account-add-button').click();await page.locator('.management-add-choice').filter({hasText:'本地用户'}).click();
   await page.locator('.management-form input').fill('Studio');await page.locator('.management-form [type=submit]').click();await page.locator('[aria-label="关闭管理"]').click();
   const other=(await page.evaluate(()=>window.termus.workspaceState())).accounts.find(a=>a.name==='Studio');
   await page.keyboard.press('Escape');await switchTo(other.id,other.activeSpace,'默认项目');
   assert.equal((await page.evaluate(()=>window.termus.init())).hosts.length,0);assert.equal((await page.evaluate(()=>window.termus.agentState())).settings.model,'');
   await page.locator('#theme-toggle').click();await page.locator('#account-profile-button').click();await page.screenshot({path:path.join(output,'workspace-accounts-light.png')});await page.keyboard.press('Escape');
   await switchTo('local',undefined,'实验项目');await switchTo('local','default','默认项目');
   assert.equal((await page.evaluate(()=>window.termus.init())).hosts[0].id,hostId);
   assert.equal((await page.evaluate(id=>window.termus.agentTask(id),pausedId)).status,'paused');
   assert.equal((await page.evaluate(id=>window.termus.agentTask(id),taskId)).followups[0].status,'applied');
   await page.evaluate(()=>{window.badScopeEvents=0;window.termus.onEvent(e=>{if(e.type==='bad-scope')window.badScopeEvents++;});});
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('termus:event',{scopeToken:'previous-scope',type:'bad-scope'}));
   await page.evaluate(()=>new Promise(r=>setTimeout(r,80)));assert.equal(await page.evaluate(()=>window.badScopeEvents),0);
   await page.locator('#sidebar-toggle').click();await page.locator('#workspace-switch').click();assert.ok(await page.locator('#workspace-menu').isVisible());await page.keyboard.press('Escape');
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1000,700));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'workspace-report.json'),JSON.stringify({ok:true,packaged,version:require('../package.json').version,checks:['legacy preservation','account-space isolation','account model settings','active pause and connection close','cross-scope IDs rejected','late events rejected','followup queued/adopted','stale command rejected',skipSystemClipboard?'copy artifact dispatch only':'copy artifact','dark/light/collapsed/compact UI'],skipped:skipSystemClipboard?['OS clipboard readback unavailable in both 0.13.1 and 0.14.0; see clipboard-environment-report.json']:[],errors},null,2));
   console.log('Workspace and live workflow integration passed',JSON.stringify({packaged,run}));
 }catch(error){if(app){const p=await app.firstWindow();console.error('Workspace diagnostic',await p.evaluate(()=>({toast:document.querySelector('.toast')?.textContent,status:document.querySelector('#agent-status')?.textContent,artifact:document.querySelector('.result-artifact')?.textContent})));console.error('Clipboard diagnostic',await app.evaluate(async({clipboard})=>({text:await clipboard.readText()})));}throw error;}finally{if(release)release(response([]));if(app)await app.close();await fixture.close();await provider.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
