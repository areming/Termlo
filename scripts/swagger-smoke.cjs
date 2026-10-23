const {_electron:electron}=require('playwright-core'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createService}=require('../services/user-api/server.cjs');
const root=path.join(__dirname,'..'),output=path.join(root,'test-output');fs.mkdirSync(output,{recursive:true});const run=fs.mkdtempSync(path.join(output,'swagger-'));
async function main(){
 const service=createService({database:path.join(run,'users.sqlite')});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+service.server.address().port;
 const driver=path.join(run,'viewer.cjs');fs.writeFileSync(driver,"const {app,BrowserWindow}=require('electron');const path=require('path');app.setPath('userData',path.join(__dirname,'browser'));app.whenReady().then(()=>{const w=new BrowserWindow({width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadURL(process.env.TEST_DOCS_URL);});");
 let app,page;const errors=[],external=[],consoleErrors=[];
 try{
  const env={...process.env,TEST_DOCS_URL:url+'/docs'};delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({args:[driver],env});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});page.on('request',r=>{if(!r.url().startsWith(url))external.push(r.url());});
  await page.locator('.swagger-ui .info .title').waitFor();assert.match(await page.locator('.info .title').textContent(),/Termlo User API/);assert.equal(await page.locator('.opblock').count(),7);
  const register=page.locator('[id="operations-认证-register"]');await register.locator('.opblock-summary').click();await register.getByRole('button',{name:'Try it out',exact:true}).click();await register.locator('textarea').fill(JSON.stringify({email:'swagger@example.com',password:'swagger-test-password-123',name:'Swagger test',profile:{locale:'zh-CN'}}));
  const pending=page.waitForResponse(r=>r.url()===url+'/v1/auth/register'&&r.request().method()==='POST');await register.getByRole('button',{name:'Execute',exact:true}).click();const response=await pending;assert.equal(response.status(),201);const session=await response.json();assert.equal(service.db.prepare('SELECT count(*) AS n FROM users').get().n,1);
  await page.locator('.auth-wrapper .authorize').click();const modal=page.locator('.dialog-ux');await modal.locator('input').fill(session.token);await modal.locator('button').filter({hasText:/^Authorize$/}).click();await modal.locator('button').filter({hasText:/^Close$/}).click();
  const me=page.locator('[id="operations-个人资料-getMe"]');await me.locator('.opblock-summary').click();await me.getByRole('button',{name:'Try it out',exact:true}).click();const mePending=page.waitForResponse(r=>r.url()===url+'/v1/me');await me.getByRole('button',{name:'Execute',exact:true}).click();assert.equal((await mePending).status(),200);
  await page.reload();await page.locator('.swagger-ui .info .title').waitFor();assert.equal(await page.evaluate(()=>window.ui.authSelectors.authorized().size),0);
  await page.screenshot({path:path.join(output,'user-api-swagger.png'),fullPage:true});assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  fs.writeFileSync(path.join(output,'swagger-report.json'),JSON.stringify({ok:true,apiVersion:require('../services/user-api/package.json').version,checks:['seven documented operations','real Swagger registration','Bearer authorized me request','authorization cleared on reload','no external browser requests','CSP compatible local assets'],errors},null,2));console.log('Swagger browser integration passed');
 }catch(e){console.error(JSON.stringify({errors,consoleErrors,url:page?.url()}));if(page)await page.screenshot({path:path.join(output,'swagger-failure.png')});throw e;}finally{if(app)await app.close();await service.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
