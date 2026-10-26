const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {AccountSync}=require('./account-sync.cjs');
function endpoint(value){
 let u;try{u=new URL(String(value).trim());}catch{throw new Error('请输入完整账户服务地址，例如 http://服务器:端口');}
 const docs=/\/docs(?:\/index\.html)?\/?$/i.test(u.pathname);
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||(u.hash&&!docs))throw new Error('API 地址无效，请勿包含凭据或查询参数');
 u.hash='';u.pathname=u.pathname.replace(/\/+$/,'').replace(/\/(?:v1(?:\/(?:auth\/(?:register|login|logout|password)|me))?|docs(?:\/index\.html)?|openapi\.json)$/i,'');
 return u.href.replace(/\/$/,'');
}
class AccountClient{
 constructor(root,vault,workspaces){this.file=path.join(root,'account-sessions.json');this.syncFile=path.join(root,'account-sync.json');this.vault=vault;this.workspaces=workspaces;this.sync=new AccountSync(root,vault,workspaces);this.sessions=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file)):{};this.syncEntries=fs.existsSync(this.syncFile)?JSON.parse(fs.readFileSync(this.syncFile)):{};}
 save(){const temp=this.file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.sessions),{mode:0o600});fs.renameSync(temp,this.file);}
 saveSync(){const temp=this.syncFile+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.syncEntries),{mode:0o600});fs.renameSync(temp,this.syncFile);}
 async request(base,route,method='GET',body,token,maxBytes=65536){const encoded=body?JSON.stringify(body):undefined;if(encoded&&Buffer.byteLength(encoded)>12*1024*1024)throw new Error('账户服务请求内容超过 12 MB');const res=await fetch(base+route,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(encoded?{body:encoded}:{})});const chunks=[];let size=0;for await(const chunk of res.body||[]){size+=chunk.length;if(size>maxBytes)throw new Error('账户服务返回内容过大');chunks.push(Buffer.from(chunk));}let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('账户服务返回格式无效');}if(!res.ok)throw Object.assign(new Error(typeof data.error==='string'?data.error.slice(0,200):'账户服务请求失败'),{status:res.status});return data;}
 syncStatus(id){const entry=this.syncEntries[id];return entry?{status:entry.status||'pending',revision:entry.revision||0,dirty:!!entry.dirty,lastSyncAt:entry.lastSyncAt||null,message:entry.message||''}:{status:'not-loaded',revision:0,dirty:false,lastSyncAt:null,message:''};}
 status(id){const entry=this.sessions[id],sync=this.syncStatus(id);return entry?{signedIn:entry.expiresAt>Date.now(),hasSession:true,expiresAt:entry.expiresAt,verifiedAt:entry.verifiedAt,sync}: {signedIn:false,hasSession:false,sync};}
 token(id){const entry=this.sessions[id];if(!entry||entry.expiresAt<=Date.now())throw new Error('请先登录此账户');return this.vault.decryptString(Buffer.from(entry.encryptedToken,'base64'));}
 async authenticate({baseUrl,mode,email,password,name}){
  if(!['login','register'].includes(mode))throw new Error('登录方式无效');if(!this.vault.isEncryptionAvailable())throw new Error('系统凭据加密不可用');const base=endpoint(baseUrl);
  const data=await this.request(base,'/v1/auth/'+mode,'POST',{email,password,...(mode==='register'?{name}:{})});
  if(!data.user||typeof data.user.id!=='string'||typeof data.user.email!=='string'||typeof data.user.name!=='string'||!/^[\w-]{43}$/.test(data.token)||!Number.isFinite(data.expiresAt)||data.expiresAt<=Date.now())throw new Error('账户服务响应无效');
  const encryptedToken=this.vault.encryptString(data.token).toString('base64'),id=this.workspaces.remoteAccount(base,data.user);
  this.sessions[id]={encryptedToken,expiresAt:data.expiresAt,verifiedAt:Date.now()};this.save();return {accountId:id};
 }
 syncKey(id){const encrypted=this.syncEntries[id]?.encryptedKey;if(!encrypted)return null;const value=Buffer.from(this.vault.decryptString(Buffer.from(encrypted,'base64')),'base64');if(value.length!==32)throw new Error('本机同步密钥无效，请重新登录');return value;}
 saveSyncState(id,entry,key){this.syncEntries[id]={...entry,...(key?{encryptedKey:this.vault.encryptString(key.toString('base64')).toString('base64')}:{})};this.saveSync();}
 async syncOnLogin(id,password,retry=0){
  const account=this.workspaces.find(id).account;if(!account.identity)throw new Error('这是本地账户');
  let remote;try{remote=await this.request(account.identity.baseUrl,'/v1/sync/state','GET',null,this.token(id),12*1024*1024);}catch(error){if(error.status===404){this.saveSyncState(id,{...this.syncEntries[id],status:'unsupported',message:'账户服务版本较旧，请更新 User API 后启用同步。'},null);return this.syncStatus(id);}this.saveSyncState(id,{...this.syncEntries[id],status:'error',message:error.message},null);return this.syncStatus(id);}
  const local=this.syncEntries[id]||{};
  if(local.dirty&&local.revision!==remote.revision){this.saveSyncState(id,{...local,status:'conflict',message:'云端数据已在其他设备更新；本机保留未同步修改。'},null);return this.syncStatus(id);}
  if(remote.blob&&local.dirty){
   const key=this.syncKey(id);if(!key){this.saveSyncState(id,{...local,status:'conflict',message:'本机有未同步修改；请重新登录后同步。'},null);return this.syncStatus(id);}
   const blob=this.sync.encrypt(key,remote.blob,this.sync.snapshot(id));
   try{const saved=await this.request(account.identity.baseUrl,'/v1/sync/state','PUT',{expectedRevision:remote.revision,blob},this.token(id),65536);this.saveSyncState(id,{revision:saved.revision,dirty:false,status:'synced',lastSyncAt:saved.updatedAt,message:''},key);return this.syncStatus(id);}catch(error){key.fill(0);if(error.status===409&&retry<1)return this.syncOnLogin(id,password,retry+1);this.saveSyncState(id,{...local,status:'conflict',message:error.message},null);return this.syncStatus(id);}
  }
  if(remote.blob){
   let opened;try{opened=await this.sync.decrypt(password,remote.blob);this.sync.apply(id,opened.payload);}catch(error){opened?.key?.fill(0);this.saveSyncState(id,{...local,status:'error',message:'同步失败，本机数据保留：'+error.message},null);return this.syncStatus(id);}
   this.saveSyncState(id,{revision:remote.revision,dirty:false,status:'synced',lastSyncAt:remote.updatedAt||new Date().toISOString(),message:''},opened.key);opened.key.fill(0);return this.syncStatus(id);
  }
  const created=await this.sync.newEnvelope(password,this.sync.snapshot(id));
  try{const saved=await this.request(account.identity.baseUrl,'/v1/sync/state','PUT',{expectedRevision:remote.revision||0,blob:created.blob},this.token(id),65536);this.saveSyncState(id,{revision:saved.revision,dirty:false,status:'synced',lastSyncAt:saved.updatedAt,message:''},created.key);return this.syncStatus(id);}catch(error){created.key.fill(0);if(error.status===409&&retry<1)return this.syncOnLogin(id,password,retry+1);this.saveSyncState(id,{...local,status:error.status===404?'unsupported':'error',message:error.message},null);return this.syncStatus(id);}
 }
 markSyncDirty(id){if(!this.workspaces.find(id).account.identity)return;const previous=this.syncEntries[id]||{};this.saveSyncState(id,{...previous,dirty:true,status:previous.status==='unsupported'?'unsupported':'pending',message:previous.status==='unsupported'?previous.message:''},null);}
 async syncNow(id){
  const account=this.workspaces.find(id).account;if(!account.identity)throw new Error('这是本地账户');const token=this.token(id);let remote;
  try{remote=await this.request(account.identity.baseUrl,'/v1/sync/state','GET',null,token,12*1024*1024);}catch(error){if(error.status===404){this.saveSyncState(id,{...this.syncEntries[id],status:'unsupported',message:'账户服务版本较旧，请更新 User API。'},null);return this.syncStatus(id);}throw error;}
  const local=this.syncEntries[id]||{},key=this.syncKey(id);if(!key)throw new Error('请重新登录以解锁账户同步');
  if(remote.revision!==local.revision){if(local.dirty||remote.revision<local.revision){this.saveSyncState(id,{...local,status:'conflict',message:'本机与云端版本不一致；本机数据未被覆盖。'},null);key.fill(0);return this.syncStatus(id);}if(remote.blob){const payload=this.sync.decryptWithKey(key,remote.blob);this.sync.apply(id,payload);this.saveSyncState(id,{revision:remote.revision,dirty:false,status:'synced',lastSyncAt:remote.updatedAt||new Date().toISOString(),message:''},key);key.fill(0);return this.syncStatus(id);}key.fill(0);throw new Error('云端没有同步数据，请重新登录后初始化');}
  if(!local.dirty){this.saveSyncState(id,{...local,status:'synced',lastSyncAt:remote.updatedAt||local.lastSyncAt||new Date().toISOString(),message:''},key);key.fill(0);return this.syncStatus(id);}
  if(!remote.blob){key.fill(0);throw new Error('云端数据已重置，请重新登录后初始化');}
  const blob=this.sync.encrypt(key,remote.blob,this.sync.snapshot(id));try{const saved=await this.request(account.identity.baseUrl,'/v1/sync/state','PUT',{expectedRevision:remote.revision,blob},token,65536);this.saveSyncState(id,{revision:saved.revision,dirty:false,status:'synced',lastSyncAt:saved.updatedAt,message:''},key);return this.syncStatus(id);}catch(error){this.saveSyncState(id,{...local,status:error.status===409?'conflict':'error',message:error.message},null);throw error;}finally{key.fill(0);}
 }
 async resolveSyncConflict(id,choice){
  if(!['cloud','local'].includes(choice))throw new Error('同步处理方式无效');const account=this.workspaces.find(id).account;if(!account.identity)throw new Error('这是本地账户');const token=this.token(id),remote=await this.request(account.identity.baseUrl,'/v1/sync/state','GET',null,token,12*1024*1024),local=this.syncEntries[id]||{},key=this.syncKey(id);if(!key)throw new Error('请重新登录以解锁账户同步');if(!remote.blob){key.fill(0);throw new Error('云端没有可用的同步版本，请重新登录后初始化');}
  try{if(choice==='cloud'){const payload=this.sync.decryptWithKey(key,remote.blob);this.sync.apply(id,payload);this.saveSyncState(id,{...local,revision:remote.revision,dirty:false,status:'synced',lastSyncAt:remote.updatedAt||new Date().toISOString(),message:''},key);return this.syncStatus(id);}
   const blob=this.sync.encrypt(key,remote.blob,this.sync.snapshot(id)),saved=await this.request(account.identity.baseUrl,'/v1/sync/state','PUT',{expectedRevision:remote.revision,blob},token,65536);this.saveSyncState(id,{...local,revision:saved.revision,dirty:false,status:'synced',lastSyncAt:saved.updatedAt,message:''},key);return this.syncStatus(id);
  }catch(error){this.saveSyncState(id,{...local,status:error.status===409?'conflict':'error',message:error.message},null);throw error;}finally{key.fill(0);}
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
 async password(id,input){
  const a=this.workspaces.find(id).account;if(!a.identity)throw new Error('请先登录');const token=this.token(id);let syncState=null,key=null;
  try{
   try{const current=await this.request(a.identity.baseUrl,'/v1/sync/state','GET',null,token,12*1024*1024);if(current.blob){const wrapped=await this.sync.rewrap(input.oldPassword,input.password,current.blob);key=wrapped.key;syncState={expectedRevision:current.revision,blob:wrapped.blob};}}catch(error){if(error.status!==404)throw error;}
   await this.request(a.identity.baseUrl,'/v1/auth/password','POST',{oldPassword:input.oldPassword,password:input.password,...(syncState?{syncState}:{})},token,65536);
   if(syncState)this.saveSyncState(id,{...(this.syncEntries[id]||{}),revision:syncState.expectedRevision+1,dirty:false,status:'synced',lastSyncAt:new Date().toISOString(),message:''},key);
   delete this.sessions[id];this.save();return {ok:true};
  }finally{key?.fill(0);}
 }
 forget(id){delete this.sessions[id];this.save();}
}
module.exports={AccountClient,endpoint};
