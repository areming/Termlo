const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Workspaces}=require('../src/workspaces.cjs'),{Store}=require('../src/store.cjs');
const vault={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'termus-host-spaces-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const w=new Workspaces(root),s=new Store(root,vault),lab=w.create('space','Lab').spaceId;return {root,w,s,lab,target:()=>new Store(w.find('local',lab).directory,vault)};}
const base={address:'example.test',username:'admin',port:22,name:'Server',auth:'password',password:'secret',rememberPassword:true};
test('copy creates independent IDs and jump routes, keeps source and credentials, and rejects cross-account or conflicting trust',t=>{
 const {w,s,lab,target}=fixture(t);s.save({...base,name:'Gateway'});const g=s.list()[0].id;s.save({...base,name:'App',address:'app.internal',jumpHostId:g});const app=s.list()[1].id;s.save({...base,name:'DB',address:'db.internal',jumpHostId:g});const db=s.list()[2].id;s.trust(s.get(g),'SHA256:key');
 assert.deepEqual(w.transferPlan(s,app,'copy').map(h=>h.id),[g,app]);assert.deepEqual(w.transferPlan(s,app,'move').map(h=>h.id),[g,app,db]);assert.throws(()=>w.copyHosts(s,lab,[app]),/跳板/);
 w.copyHosts(s,lab,[g,app]);const copied=target(),a=copied.list().find(h=>h.name==='App'),gateway=copied.list().find(h=>h.name==='Gateway');assert.notEqual(a.id,app);assert.equal(a.jumpHostId,gateway.id);assert.equal(copied.password(a.id),'secret');assert.equal(copied.route(a.id).length,2);assert.equal(copied.known(copied.get(gateway.id)),'SHA256:key');assert.equal(s.list().length,3);
 copied.save({...a,name:'Independent'});assert.equal(s.get(app).name,'App');
 const other=w.create('account','Other');assert.throws(()=>w.copyHosts(s,other.spaceId,[g,app]),/不属于/);assert.throws(()=>w.spaceHosts(s,other.spaceId),/不属于/);assert.throws(()=>w.copyHosts(s,'invented',[g]),/不属于/);
 copied.trust(copied.get(gateway.id),'SHA256:changed');assert.throws(()=>w.copyHosts(s,lab,[g,app]),/指纹冲突/);assert.equal(target().list().length,2);
});
test('editor creates directly in chosen space and moves edited hosts atomically with destination route validation',t=>{
 const {w,s,lab,target}=fixture(t);w.saveHost(s,{...base,name:'Target gateway'},lab);assert.equal(s.list().length,0);const gateway=target().list()[0].id;
 s.save({...base,name:'Original',address:'original.test'});const id=s.list()[0].id;s.trust(s.get(id),'SHA256:original');
 const before=JSON.stringify(s.data);assert.throws(()=>w.saveHost(s,{...s.list()[0],name:'Invalid edit',jumpHostId:'missing'},lab),/不存在/);assert.equal(JSON.stringify(s.data),before);assert.equal(target().list().length,1);
 w.saveHost(s,{...s.list()[0],name:'Moved edit',jumpHostId:gateway},lab);assert.equal(s.list().length,0);assert.equal(target().get(id).name,'Moved edit');assert.equal(target().password(id),'secret');assert.equal(target().known(target().get(id)),'SHA256:original');assert.equal(target().route(id).length,2);
 s.save(base);const changed=s.list()[0];w.saveHost(s,{...changed,address:'changed.test'},lab);assert.equal(target().password(changed.id),undefined);
 const other=w.create('account','Other');assert.throws(()=>w.saveHost(s,base,other.spaceId),/不属于/);
});
