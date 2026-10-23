const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {Workspaces}=require('../src/workspaces.cjs');const {Store}=require('../src/store.cjs');const {AgentStorage}=require('../src/agent-storage.cjs');
const vault={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
test('legacy data remains in place; account and space stores isolate hosts, credentials and tasks; settings follow account',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'termus-spaces-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const old=new Store(root,vault);old.save({name:'Legacy',address:'192.0.2.1',username:'admin',password:'old-secret',rememberPassword:true});const hostId=old.list()[0].id;
 const oldAgent=new AgentStorage(root,vault);oldAgent.configure({baseUrl:'https://example.com/v1',model:'personal',apiKey:'personal-key'});const oldTask=oldAgent.create('legacy task',[hostId],'plan');
 const before=fs.readFileSync(old.file,'utf8'),spaces=new Workspaces(root);assert.equal(spaces.current().directory,root);assert.equal(fs.readFileSync(old.file,'utf8'),before);
 const lab=spaces.create('space','实验项目');spaces.select(lab.accountId,lab.spaceId);const target=spaces.current(),hosts=new Store(target.directory,vault),agent=new AgentStorage(target.directory,vault,target.settingsDirectory);
 assert.deepEqual(hosts.list(),[]);assert.throws(()=>hosts.get(hostId));assert.throws(()=>agent.get(oldTask.id));assert.equal(agent.key(),'personal-key');
 const other=spaces.create('account','工作账户');spaces.select(other.accountId);const account=spaces.current();const otherAgent=new AgentStorage(account.directory,vault,account.settingsDirectory);assert.equal(otherAgent.key(),'');assert.equal(otherAgent.tasks.length,0);
 assert.throws(()=>spaces.select(other.accountId,'default'),/空间不属于/);assert.throws(()=>spaces.find('../evil'),/账户不存在/);
 spaces.select('local');assert.equal(spaces.current().space.id,lab.spaceId);spaces.select('local','default');assert.equal(new Store(spaces.current().directory,vault).password(hostId),'old-secret');
 const restored=new Workspaces(root);assert.equal(restored.current().key,'local/default');assert.equal(new AgentStorage(root,vault).get(oldTask.id).prompt,'legacy task');
});
