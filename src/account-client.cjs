const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
function endpoint(value){
 let u;try{u=new URL(String(value).trim());}catch{throw new Error('请输入完整账户服务地址，例如 http://服务器:端口');}
 const docs=/\/docs(?:\/index\.html)?\/?$/i.test(u.pathname);
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||(u.hash&&!docs))throw new Error('API 地址无效，请勿包含凭据或查询参数');
 u.hash='';u.pathname=u.pathname.replace(/\/+$/,'').replace(/\/(?:v1(?:\/(?:auth\/(?:register|login|logout|password)|me))?|docs(?:\/index\.html)?|openapi\.json)$/i,'');
 return u.href.replace(/\/$/,'');
}
class AccountClient{
 constructor(root,vault,workspaces){this.file=path.join(root,'account-sessions.json');this.vault=vault;this.workspaces=workspaces;this.sessions=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file)):{};}
 save(){const temp=this.file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.sessions),{mode:0o600});fs.renameSync(temp,this.file);}
 async request(base,route,method='GET',body,token){const res=await fetch(base+route,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});const chunks=[];let size=0;for await(const chunk of res.body){size+=chunk.length;if(size>65536)throw new Error('账户服务返回内容过大');chunks.push(Buffer.from(chunk));}let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('账户服务返回格式无效');}if(!res.ok)throw Object.assign(new Error(typeof data.error==='string'?data.error.slice(0,200):'账户服务请求失败'),{status:res.status});return data;}
 status(id){const entry=this.sessions[id];return entry?{signedIn:entry.expiresAt>Date.now(),hasSession:true,expiresAt:entry.expiresAt,verifiedAt:entry.verifiedAt}: {signedIn:false,hasSession:false};}
 token(id){const entry=this.sessions[id];if(!entry||entry.expiresAt<=Date.now())throw new Error('请先登录此账户');return this.vault.decryptString(Buffer.from(entry.encryptedToken,'base64'));}
 async authenticate({baseUrl,mode,email,password,name}){
  if(!['login','register'].includes(mode))throw new Error('登录方式无效');if(!this.vault.isEncryptionAvailable())throw new Error('系统凭据加密不可用');const base=endpoint(baseUrl);
  const data=await this.request(base,'/v1/auth/'+mode,'POST',{email,password,...(mode==='register'?{name}:{})});
  if(!data.user||typeof data.user.id!=='string'||typeof data.user.email!=='string'||typeof data.user.name!=='string'||!/^[\w-]{43}$/.test(data.token)||!Number.isFinite(data.expiresAt)||data.expiresAt<=Date.now())throw new Error('账户服务响应无效');
  const encryptedToken=this.vault.encryptString(data.token).toString('base64'),id=this.workspaces.remoteAccount(base,data.user);
  this.sessions[id]={encryptedToken,expiresAt:data.expiresAt,verifiedAt:Date.now()};this.save();return {accountId:id};
 }
 async verify(id){const a=this.workspaces.find(id).account;if(!a.identity)throw new Error('这是本地账户');const entry=this.sessions[id],token=this.token(id);try{const data=await this.request(a.identity.baseUrl,'/v1/me','GET',null,token);if(data.user?.id!==a.identity.userId)throw new Error('账户身份不匹配');if(this.sessions[id]===entry){entry.verifiedAt=Date.now();this.save();}return this.status(id);}catch(e){if(e.status===401&&this.sessions[id]===entry){delete this.sessions[id];this.save();}throw e;}}
 async logout(id){const a=this.workspaces.find(id).account,entry=this.sessions[id];if(!a.identity)throw new Error('这是本地账户');let token;if(entry?.expiresAt>Date.now())try{token=this.token(id);}catch{}delete this.sessions[id];try{this.save();}catch(e){if(entry)this.sessions[id]=entry;throw e;}if(token)void this.request(a.identity.baseUrl,'/v1/auth/logout','POST',{},token).catch(()=>{});return {local:true,remote:token?'attempted':'not-applicable'};}
 async reconnect(id,{baseUrl,email,password}){
  const account=this.workspaces.find(id).account;if(!account.identity)throw new Error('这是本地账户');if(!this.vault.isEncryptionAvailable())throw new Error('系统凭据加密不可用');
  const base=endpoint(baseUrl),data=await this.request(base,'/v1/auth/login','POST',{email,password});
  if(!data.user||data.user.id!==account.identity.userId||typeof data.user.email!=='string'||data.user.email.toLowerCase()!==account.identity.email.toLowerCase())throw new Error('新地址返回的用户身份与当前账户不符，原地址和空间未更改');
  if(!/^[\w-]{43}$/.test(data.token)||!Number.isFinite(data.expiresAt)||data.expiresAt<=Date.now())throw new Error('账户服务响应无效');
  if(this.workspaces.data.accounts.some(a=>a.id!==id&&a.identity?.baseUrl===base&&a.identity.userId===data.user.id))throw new Error('新地址已绑定到另一位本地用户，请先整理账户');
  const encryptedToken=this.vault.encryptString(data.token).toString('base64'),previous=account.identity,oldEntry=this.sessions[id];let oldToken;if(oldEntry?.expiresAt>Date.now())try{oldToken=this.token(id);}catch{}
  account.identity={baseUrl:base,userId:data.user.id,email:data.user.email,displayName:data.user.name,profile:data.user.profile||{}};
  try{this.workspaces.commit();this.sessions[id]={encryptedToken,expiresAt:data.expiresAt,verifiedAt:Date.now()};this.save();}catch(e){account.identity=previous;if(oldEntry)this.sessions[id]=oldEntry;else delete this.sessions[id];this.workspaces.commit();throw e;}
  if(oldToken)void this.request(previous.baseUrl,'/v1/auth/logout','POST',{},oldToken).catch(()=>{});
  return {accountId:id};
 }
 async update(id,input){const a=this.workspaces.find(id).account;if(!a.identity)throw new Error('请先登录');const data=await this.request(a.identity.baseUrl,'/v1/me','PATCH',{name:input.name,profile:{locale:input.locale||'',timeZone:input.timeZone||''}},this.token(id));if(data.user?.id!==a.identity.userId)throw new Error('账户身份不匹配');a.identity.displayName=data.user.name;a.identity.profile=data.user.profile;this.workspaces.commit();return {ok:true};}
 async password(id,input){const a=this.workspaces.find(id).account;if(!a.identity)throw new Error('请先登录');await this.request(a.identity.baseUrl,'/v1/auth/password','POST',{oldPassword:input.oldPassword,password:input.password},this.token(id));delete this.sessions[id];this.save();return {ok:true};}
 forget(id){delete this.sessions[id];this.save();}
}
module.exports={AccountClient,endpoint};
