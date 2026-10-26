const fs=require('node:fs'),path=require('node:path');
const {randomBytes,randomUUID,createCipheriv,createDecipheriv,scrypt}=require('node:crypto');
const {promisify}=require('node:util');
const {normalizeHost,connectionRoute}=require('./store.cjs');
const derive=promisify(scrypt),UUID=/^[a-f0-9-]{36}$/i,MAX_PLAINTEXT=8*1024*1024;
function atomicJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}
function seal(key,value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),ciphertext=Buffer.concat([cipher.update(value),cipher.final()]);return{iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};}
function open(key,value){const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(value.iv,'base64'));decipher.setAuthTag(Buffer.from(value.tag,'base64'));return Buffer.concat([decipher.update(Buffer.from(value.ciphertext,'base64')),decipher.final()]);}
async function wrappingKey(password,salt){return derive(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});}
class AccountSync{
 constructor(root,vault,workspaces){this.root=root;this.vault=vault;this.workspaces=workspaces;}
 spaceDirectory(accountId,spaceId){const accountRoot=accountId==='local'?this.root:path.join(this.root,'accounts',accountId);return accountId==='local'&&spaceId==='default'?this.root:path.join(accountRoot,'spaces',spaceId);}
 snapshot(accountId){
  const target=this.workspaces.find(accountId),account=target.account,spaces=[];
  for(const space of account.spaces){const file=path.join(this.workspaces.find(accountId,space.id).directory,'hosts.json');let data={version:1,hosts:[],knownHosts:{}};if(fs.existsSync(file))data=JSON.parse(fs.readFileSync(file,'utf8'));
   const hosts=data.hosts.map(host=>{const{encryptedPassword,...safe}=host;return{...safe,hasPassword:!!encryptedPassword,...(host.auth==='key'?{keyPath:'',needsKeyFile:true}:{})};});
   spaces.push({id:space.id,name:space.name,hosts,knownHosts:data.knownHosts||{}});
  }
  const file=path.join(target.settingsDirectory,'settings.json');let settings={baseUrl:'',model:'',maxRounds:80};if(fs.existsSync(file))settings=JSON.parse(fs.readFileSync(file,'utf8'));
  return{version:1,accountName:account.name,spaces,agent:{baseUrl:settings.baseUrl||'',model:settings.model||'',maxRounds:Number(settings.maxRounds)||80,hasApiKey:!!(settings.encryptedKey||settings.needsApiKey)}};
 }
 apply(accountId,payload){
  if(!payload||payload.version!==1||!Array.isArray(payload.spaces)||payload.spaces.length<1||payload.spaces.length>100)throw new Error('账户同步数据结构无效，未覆盖本机数据');
  const account=this.workspaces.find(accountId).account,spaceIds=new Set(),prepared=[];
  for(const space of payload.spaces){
   if(!space||!UUID.test(space.id)||spaceIds.has(space.id)||typeof space.name!=='string'||!space.name.trim()||space.name.trim().length>60||!Array.isArray(space.hosts)||space.hosts.length>100)throw new Error('同步空间数据无效，未覆盖本机数据');
   spaceIds.add(space.id);const ids=new Set(),hosts=[];
   for(const source of space.hosts){
    if(!source||!UUID.test(source.id)||ids.has(source.id))throw new Error('同步主机标识无效，未覆盖本机数据');ids.add(source.id);
    const{hasPassword,...fields}=source,host={...source,...normalizeHost(fields),id:source.id};delete host.hasPassword;delete host.encryptedPassword;
    if(source.operatingSystem&&typeof source.operatingSystem==='object')host.operatingSystem=source.operatingSystem;
    if(source.specifications&&typeof source.specifications==='object')host.specifications=source.specifications;
    if(source.cloudIdentity&&typeof source.cloudIdentity==='object')host.cloudIdentity=source.cloudIdentity;
    const currentDir=path.join(this.spaceDirectory(accountId,space.id),'hosts.json');let current={hosts:[]};if(fs.existsSync(currentDir))current=JSON.parse(fs.readFileSync(currentDir,'utf8'));
    const previous=current.hosts.find(item=>item.id===host.id),sameAuth=previous&&['address','port','username','auth','jumpHostId'].every(k=>previous[k]===host[k]);
    if(sameAuth&&previous.encryptedPassword&&host.auth==='password')host.encryptedPassword=previous.encryptedPassword;
    hosts.push(host);
   }
   for(const host of hosts)connectionRoute(hosts,host.id);
   const knownHosts=space.knownHosts&&typeof space.knownHosts==='object'&&!Array.isArray(space.knownHosts)?space.knownHosts:{};
   if(Object.keys(knownHosts).length>1000||Object.entries(knownHosts).some(([key,value])=>{try{const parts=JSON.parse(key);return!Array.isArray(parts)||parts.length!==2||typeof parts[0]!=='string'||!Number.isInteger(parts[1])||typeof value!=='string'||value.length>200;}catch{return true;}}))throw new Error('同步服务器指纹数据无效，未覆盖本机数据');
   prepared.push({space:{id:space.id,name:space.name.trim()},data:{version:1,hosts,knownHosts}});
  }
  const agent=payload.agent;if(!agent||typeof agent!=='object'||typeof agent.baseUrl!=='string'||agent.baseUrl.length>300||typeof agent.model!=='string'||agent.model.length>200||!Number.isInteger(agent.maxRounds)||agent.maxRounds<5||agent.maxRounds>300||typeof agent.hasApiKey!=='boolean')throw new Error('同步模型配置无效，未覆盖本机数据');
  if(agent.baseUrl){const url=new URL(agent.baseUrl);if(url.username||url.password||url.search||url.hash||!['http:','https:'].includes(url.protocol)||(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('同步模型地址不符合安全规则，未覆盖本机数据');}
  for(const item of prepared)atomicJson(path.join(this.spaceDirectory(accountId,item.space.id),'hosts.json'),item.data);
  account.spaces=prepared.map(item=>item.space);if(!account.spaces.some(space=>space.id===account.activeSpace))account.activeSpace=account.spaces[0].id;
  if(typeof payload.accountName==='string'&&payload.accountName.trim()&&payload.accountName.trim().length<=60)account.name=payload.accountName.trim();this.workspaces.commit();
  const target=this.workspaces.find(accountId),settingsFile=path.join(target.settingsDirectory,'settings.json');let previous={};if(fs.existsSync(settingsFile))previous=JSON.parse(fs.readFileSync(settingsFile,'utf8'));
  const sameProvider=previous.baseUrl===agent.baseUrl&&previous.model===agent.model;
  const encryptedKey=sameProvider?previous.encryptedKey:null,needsApiKey=agent.hasApiKey&&!encryptedKey;
  atomicJson(settingsFile,{baseUrl:agent.baseUrl.trim().replace(/\/+$/,''),model:agent.model.trim(),maxRounds:agent.maxRounds,...(encryptedKey?{encryptedKey}:{}),...(needsApiKey?{needsApiKey:true}:{})});
 }
 async newEnvelope(password,payload){const plain=Buffer.from(JSON.stringify(payload));if(plain.length>MAX_PLAINTEXT)throw new Error('同步配置超过 8 MB，请整理空间或主机');const key=randomBytes(32),salt=randomBytes(16),derived=await wrappingKey(password,salt);try{const wrapped=seal(derived,key);return{key,blob:{version:1,keyWrap:{salt:salt.toString('base64'),iv:wrapped.iv,tag:wrapped.tag,key:wrapped.ciphertext},...seal(key,plain)}};}finally{derived.fill(0);plain.fill(0);}}
 async unwrap(password,blob){if(!blob||blob.version!==1||!blob.keyWrap)throw new Error('账户服务同步数据无效');const wrap=blob.keyWrap,salt=Buffer.from(wrap.salt,'base64'),derived=await wrappingKey(password,salt);try{const key=open(derived,{iv:wrap.iv,tag:wrap.tag,ciphertext:wrap.key});if(key.length!==32)throw new Error('同步密钥长度无效');return key;}finally{derived.fill(0);}}
 async decrypt(password,blob){const key=await this.unwrap(password,blob);try{const plain=open(key,blob);if(plain.length>MAX_PLAINTEXT)throw new Error('同步配置超过 8 MB');let payload;try{payload=JSON.parse(plain.toString('utf8'));}catch{throw new Error('账户同步数据无法解析');}return{key,payload};}catch(error){key.fill(0);throw error;}}
 decryptWithKey(key,blob){const plain=open(key,blob);if(plain.length>MAX_PLAINTEXT)throw new Error('同步配置超过 8 MB');try{return JSON.parse(plain.toString('utf8'));}catch{throw new Error('账户同步数据无法解析');}}
 encrypt(key,blob,payload){const plain=Buffer.from(JSON.stringify(payload));if(plain.length>MAX_PLAINTEXT)throw new Error('同步配置超过 8 MB，请整理空间或主机');return{version:1,keyWrap:blob.keyWrap,...seal(key,plain)};}
 async rewrap(oldPassword,newPassword,blob){const key=await this.unwrap(oldPassword,blob),salt=randomBytes(16),derived=await wrappingKey(newPassword,salt);try{const wrapped=seal(derived,key);return{key,blob:{...blob,keyWrap:{salt:salt.toString('base64'),iv:wrapped.iv,tag:wrapped.tag,key:wrapped.ciphertext}}};}finally{derived.fill(0);}}
}
module.exports={AccountSync,MAX_PLAINTEXT};
