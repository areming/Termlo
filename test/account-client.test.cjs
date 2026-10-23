const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createCipheriv,createDecipheriv,randomBytes}=require('node:crypto');
const {AccountClient,endpoint}=require('../src/account-client.cjs'),{Workspaces}=require('../src/workspaces.cjs'),{createService}=require('../services/user-api/server.cjs');
test('account client retains encrypted sessions across restart, reuses identity and clears revoked sessions',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'termus-account-client-'));const key=randomBytes(32),vault={isEncryptionAvailable:()=>true,encryptString:s=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([c.update(s,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]);},decryptString:b=>{const d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString();}};
 let service=createService({database:path.join(root,'users.sqlite')});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const port=service.server.address().port;
 t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
 const input={baseUrl:'http://127.0.0.1:'+port,mode:'register',email:'client@example.com',name:'客户端测试',password:'client-test-password-42'};
 let spaces=new Workspaces(root),client=new AccountClient(root,vault,spaces);const {accountId}=await client.authenticate({...input,baseUrl:input.baseUrl+'/v1/auth/register'}),token=client.token(accountId),saved=fs.readFileSync(client.file,'utf8');assert.ok(!saved.includes(token));assert.ok(!saved.includes(input.password));assert.equal(spaces.find(accountId).account.identity.displayName,input.name);assert.equal(spaces.find(accountId).account.identity.baseUrl,input.baseUrl);
 await service.close();service=createService({database:path.join(root,'users.sqlite')});await new Promise(r=>service.server.listen(port,'127.0.0.1',r));
 spaces=new Workspaces(root);client=new AccountClient(root,vault,spaces);assert.equal((await client.verify(accountId)).signedIn,true);
 assert.equal((await client.authenticate({...input,baseUrl:input.baseUrl+'/v1/auth/login',mode:'login'})).accountId,accountId);assert.equal(spaces.public().accounts.length,2);
 await client.password(accountId,{oldPassword:input.password,password:'changed-client-password-42'});assert.equal(client.status(accountId).signedIn,false);
 const previous=new AccountClient(root,vault,spaces);previous.sessions[accountId]={encryptedToken:vault.encryptString(token).toString('base64'),expiresAt:Date.now()+60000};await assert.rejects(previous.verify(accountId),e=>e.status===401);assert.equal(previous.status(accountId).signedIn,false);
 assert.equal(endpoint('http://accounts.example.com'),'http://accounts.example.com');assert.throws(()=>endpoint('https://user:secret@example.com'));assert.throws(()=>endpoint('https://example.com/?token=x'));assert.equal(endpoint('https://example.com/'),'https://example.com');
});

test('account URLs accept root, API and Swagger links while retaining proxy prefixes and rejecting credentials',()=>{
 const base='http://192.0.2.10:8008';for(const suffix of ['', '/', '/v1','/v1/','/v1/auth/register','/v1/auth/login/','/v1/me','/docs','/docs#/认证/register','/openapi.json'])assert.equal(endpoint(base+suffix),base,suffix);
 for(const suffix of ['/v1/auth/register','/v1/auth/login','/docs#/认证/register'])assert.equal(endpoint(base+'/accounts'+suffix),base+'/accounts');
 assert.equal(endpoint('https://example.com/custom-root/'),'https://example.com/custom-root');
 for(const value of ['invalid','file:///api','http://user:secret@example.com/v1/auth/register',base+'/?token=secret',base+'/v1/auth/register#token'])assert.throws(()=>endpoint(value));
});

test('offline logout is immediate and a verified service move keeps the same local account and spaces',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'termus-account-move-'));
 const vault={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
 let service=createService({database:path.join(root,'users.sqlite')});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{if(service)await service.close();fs.rmSync(root,{recursive:true,force:true});});
 const oldBase='http://127.0.0.1:'+service.server.address().port,workspaces=new Workspaces(root),client=new AccountClient(root,vault,workspaces);
 const credentials={email:'moved@example.com',password:'moved-password-123',name:'Moved user'};
 const {accountId}=await client.authenticate({baseUrl:oldBase,mode:'register',...credentials}),space=workspaces.create('space','Production',accountId).spaceId;
 await service.close();service=null;
 const started=Date.now();assert.deepEqual(await client.logout(accountId),{local:true,remote:'attempted'});assert.ok(Date.now()-started<1000);assert.equal(client.status(accountId).signedIn,false);assert.equal(new AccountClient(root,vault,workspaces).status(accountId).hasSession,false);
 service=createService({database:path.join(root,'users.sqlite')});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
 const newBase='http://127.0.0.1:'+service.server.address().port;
 assert.equal((await client.reconnect(accountId,{baseUrl:newBase,...credentials})).accountId,accountId);
 assert.equal(workspaces.find(accountId,space).space.name,'Production');assert.equal(workspaces.find(accountId).account.identity.baseUrl,newBase);assert.equal(workspaces.public().accounts.length,2);
 assert.equal((await client.verify(accountId)).signedIn,true);
 const other=createService({database:path.join(root,'other.sqlite')});await new Promise(r=>other.server.listen(0,'127.0.0.1',r));
 try{const otherBase='http://127.0.0.1:'+other.server.address().port;await fetch(otherBase+'/v1/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});await assert.rejects(client.reconnect(accountId,{baseUrl:otherBase,...credentials}),/身份.*不符/);assert.equal(workspaces.find(accountId).account.identity.baseUrl,newBase);}finally{await other.close();}
});
