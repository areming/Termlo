const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createService}=require('../server.cjs');
async function fixture(t,options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'termus-user-api-'));const service=createService({database:path.join(dir,'users.sqlite'),...options});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});const base='http://127.0.0.1:'+service.server.address().port;const request=async(route,method='GET',body,token)=>{const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};return {...service,base,request,dir};}
const user={email:'tester@example.com',password:'a-long-test-password-42',name:'Tester',profile:{locale:'zh-CN',timeZone:'Asia/Shanghai'}};

test('Swagger documents all operations, serves local assets and supports only same-origin browser API calls',async t=>{
 const f=await fixture(t);const r=await fetch(f.base+'/openapi.json'),spec=await r.json();assert.equal(spec.openapi,'3.0.3');assert.equal(Object.values(spec.paths).reduce((n,p)=>n+Object.keys(p).length,0),7);assert.equal(spec.components.schemas.Session.properties.expiresAt.format,'int64');
 assert.deepEqual(spec.paths['/v1/me'].get.security,[{bearerAuth:[]}]);assert.deepEqual(spec.paths['/v1/auth/register'].post.security,[]);
 for(const route of ['/docs','/docs/','/docs/swagger-ui-bundle.js','/docs/swagger-ui.css','/docs/swagger-init.js']){const r=await fetch(f.base+route);assert.equal(r.status,200);assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.match(r.headers.get('content-security-policy'),/connect-src 'self'/);assert.ok((await r.text()).length>50);}
 const registered=await fetch(f.base+'/v1/auth/register',{method:'POST',headers:{Origin:f.base,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},body:JSON.stringify(user)});assert.equal(registered.status,201);const session=await registered.json();
 assert.equal((await fetch(f.base+'/v1/me',{headers:{Origin:f.base,Authorization:'Bearer '+session.token}})).status,200);
 for(const origin of ['null','https://evil.example',f.base+'.evil.example'])assert.equal((await fetch(f.base+'/v1/me',{headers:{Origin:origin}})).status,403);
 assert.equal((await fetch(f.base+'/v1/me',{headers:{Origin:f.base,'Sec-Fetch-Site':'cross-site'}})).status,403);
 assert.equal((await fetch(f.base+'/docs/server.cjs')).status,404);
 const hidden=await fixture(t,{docs:false});assert.equal((await fetch(hidden.base+'/docs')).status,404);assert.equal((await fetch(hidden.base+'/openapi.json')).status,404);
 const proxy=await fixture(t,{publicOrigin:'https://accounts.example.com'});assert.equal((await fetch(proxy.base+'/v1/me',{headers:{Origin:'https://accounts.example.com'}})).status,401);assert.equal((await fetch(proxy.base+'/v1/me',{headers:{Origin:proxy.base}})).status,403);
});
test('API registration, profile extension, login, logout and expiry keep password/token secrets out of responses and database',async t=>{
 let now=Date.now();const f=await fixture(t,{now:()=>now,sessionSeconds:60}),r=await f.request('/v1/auth/register','POST',user);assert.equal(r.status,201);assert.equal(r.data.user.profile.locale,'zh-CN');assert.equal(r.data.user.emailVerified,false);
 assert.equal(f.db.prepare('SELECT password_hash FROM users').get().password_hash.length,128);assert.notEqual(f.db.prepare('SELECT token_hash FROM sessions').get().token_hash,r.data.token);assert.ok(!JSON.stringify(r.data.user).includes('password'));
 assert.equal((await f.request('/v1/me','GET',null,r.data.token)).status,200);
 assert.equal((await f.request('/v1/me','PATCH',{profile:{role:'admin'}},r.data.token)).status,400);
 assert.equal((await f.request('/v1/auth/login','POST',{...user,password:'wrong-password-42'})).status,401);
 assert.equal((await f.request('/v1/auth/register','POST',user)).status,409);
 const login=await f.request('/v1/auth/login','POST',user);assert.equal(login.status,200);
 await f.request('/v1/auth/logout','POST',{},login.data.token);assert.equal((await f.request('/v1/me','GET',null,login.data.token)).status,401);
 now+=61000;assert.equal((await f.request('/v1/me','GET',null,r.data.token)).status,401);
});
test('API password change invalidates every session and accepts only the new password',async t=>{
 const f=await fixture(t),r=await f.request('/v1/auth/register','POST',user),second=await f.request('/v1/auth/login','POST',user);
 const changed=await f.request('/v1/auth/password','POST',{oldPassword:user.password,password:'replacement-password-99'},r.data.token);assert.equal(changed.status,200);
 assert.equal((await f.request('/v1/me','GET',null,second.data.token)).status,401);assert.equal((await f.request('/v1/auth/login','POST',user)).status,401);
 assert.equal((await f.request('/v1/auth/login','POST',{...user,password:'replacement-password-99'})).status,200);
});
test('API rejects malformed/oversized requests, browser origins, closed registration and auth bursts',async t=>{
 const f=await fixture(t,{registration:false});assert.equal((await f.request('/healthz')).status,200);
 assert.equal((await f.request('/v1/auth/register','POST',user)).status,403);
 assert.equal((await f.request('/v1/auth/login','POST',{...user,password:'short'})).status,400);
 assert.equal((await f.request('/v1/auth/login','POST',{...user,name:'x'.repeat(9000)})).status,413);
 assert.equal((await fetch(f.base+'/v1/me',{headers:{Origin:'https://evil.example'}})).status,403);
 for(let i=0;i<31;i++)await f.request('/v1/auth/login','POST',{...user,password:'short'});
 assert.equal((await f.request('/v1/auth/login','POST',user)).status,429);
});
