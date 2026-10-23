const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {Workspaces}=require('../src/workspaces.cjs'),{Store}=require('../src/store.cjs');
const vault={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
test('management renames/removes empty spaces and moves intact jump chains with credentials and trust, retaining old histories',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'termus-management-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const w=new Workspaces(root),s=new Store(root,vault),lab=w.create('space','Lab').spaceId,other=w.create('account','Other');
 const base={address:'127.0.0.1',port:22,username:'a',auth:'password',password:'saved-secret',rememberPassword:true};s.save({...base,name:'Gateway'});const gateway=s.list()[0].id;s.save({...base,name:'Target',address:'internal',jumpHostId:gateway});const target=s.list()[1].id;s.trust(s.get(gateway),'SHA256:fixture');
 fs.mkdirSync(path.join(root,'assistant'),{recursive:true});fs.writeFileSync(path.join(root,'assistant/tasks.json'),JSON.stringify([{id:'history',hostIds:[target]}]));
 assert.throws(()=>w.moveHosts(s,other.spaceId,[target]),/不属于/);assert.throws(()=>w.moveHosts(s,lab,[target]),/跳板/);assert.throws(()=>w.moveHosts(s,lab,[gateway]),/依赖/);
 w.moveHosts(s,lab,[gateway,target]);assert.equal(s.list().length,0);const moved=new Store(w.find('local',lab).directory,vault);assert.equal(moved.password(target),'saved-secret');assert.equal(moved.route(target).length,2);assert.equal(moved.known(moved.get(gateway)),'SHA256:fixture');assert.match(fs.readFileSync(path.join(root,'assistant/tasks.json'),'utf8'),/history/);
 w.rename('space','local',lab,'Production');assert.equal(w.find('local',lab).space.name,'Production');assert.throws(()=>w.remove('space','local',lab),/没有主机/);
 const empty=w.create('space','Empty').spaceId;w.remove('space','local',empty);assert.throws(()=>w.find('local',empty));assert.throws(()=>w.remove('account','local'),/切换/);
 // Simulate a crash with a committed move journal; startup rolls forward idempotently.
 const source={spaceId:'default',data:s.data},destination={spaceId:lab,data:moved.data};fs.writeFileSync(path.join(root,'host-move.json'),JSON.stringify({accountId:'local',source,destination}));new Workspaces(root);assert.equal(fs.existsSync(path.join(root,'host-move.json')),false);assert.equal(new Store(w.find('local',lab).directory,vault).list().length,2);
});
test('host moves recover transient write failure and block on persistent failure until restart',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'termus-move-recovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const w=new Workspaces(root),s=new Store(root,vault),lab=w.create('space','Lab').spaceId;
 s.save({name:'One',address:'localhost',port:22,username:'a'});const id=s.list()[0].id;
 const commit=s.commit;s.commit=()=>{throw new Error('transient write failure');};w.moveHosts(s,lab,[id]);s.commit=commit;
 assert.equal(s.list().length,0);assert.equal(new Store(w.find('local',lab).directory,vault).list()[0].id,id);assert.equal(fs.existsSync(path.join(root,'host-move.json')),false);
 s.save({name:'Two',address:'localhost',port:22,username:'a'});const second=s.list()[0].id;
 const original=Store.prototype.commit;Store.prototype.commit=()=>{throw new Error('disk full');};
 try{assert.throws(()=>w.moveHosts(s,lab,[second]),/重启/);assert.equal(w.moveBlocked,true);assert.throws(()=>w.moveHosts(s,lab,[second]),/重启/);}finally{Store.prototype.commit=original;}
 const recovered=new Workspaces(root);assert.equal(fs.existsSync(path.join(root,'host-move.json')),false);assert.equal(new Store(root,vault).list().length,0);assert.equal(new Store(recovered.find('local',lab).directory,vault).list().length,2);
});
