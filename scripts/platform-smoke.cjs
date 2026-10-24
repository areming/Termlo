const { _electron:electron }=require('playwright-core');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
require('./build.cjs').build();
const root=path.join(__dirname,'..'),output=path.join(root,'test-output');fs.mkdirSync(output,{recursive:true});
async function main(){
 const packaged=process.argv.includes('--packaged'),data=fs.mkdtempSync(path.join(output,'termlo-platform-'));
 const executable=path.join(root,require('../package.json').build.directories.output,'win-unpacked','Termlo.exe');
 const env={...process.env,TERMUS_DATA_DIR:path.join(data,'user-data')};delete env.ELECTRON_RUN_AS_NODE;
 let app;const errors=[];
 try{
  app=await electron.launch({args:packaged?[]:[root],...(packaged?{executablePath:executable}:{}),env});
  const page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.waitForLoadState('load');
  assert.equal(await page.title(),'Termlo');
  await page.waitForFunction(()=>document.querySelector('.brand-mark img')?.naturalWidth>0);
  await page.locator('#onboarding:not(.hidden)').waitFor();
  await page.locator('#onboarding-exit').click();
  await page.locator('#onboarding').waitFor({state:'hidden'});
  assert.equal(await page.locator('#topbar-workspace-name').textContent(),'默认项目');
  await page.locator('#topbar-assistant').click();assert.equal(await page.locator('#assistant-view').isVisible(),true);
  await page.locator('#topbar-search').click();assert.equal(await page.locator('#hosts-view').isVisible(),true);assert.equal(await page.locator('#search').evaluate(el=>document.activeElement===el),true);
  await page.locator('#theme-toggle').click();assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
  await page.screenshot({path:path.join(output,'termlo-topbar-light.png')});
  await page.locator('#theme-toggle').click();await page.screenshot({path:path.join(output,'termlo-topbar-dark.png')});
  await page.addInitScript(()=>Object.defineProperty(navigator,'platform',{configurable:true,get:()=> 'MacIntel'}));await page.reload();
  await page.waitForFunction(()=>document.querySelector('#topbar-shortcut')?.textContent==='⌘ K');
  await page.locator('#topbar-assistant').click();await page.keyboard.press('Meta+K');assert.equal(await page.locator('#search').evaluate(el=>document.activeElement===el),true);
  assert.deepEqual(errors,[]);console.log('Termlo platform shell passed',JSON.stringify({platform:process.platform,packaged,data}));
 }finally{if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close();}}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
