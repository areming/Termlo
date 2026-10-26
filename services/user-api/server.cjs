const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {scrypt,randomBytes,randomUUID,createHash,timingSafeEqual}=require('node:crypto');
const {promisify}=require('node:util');
const serveDocs=require('./docs.cjs');
const derive=promisify(scrypt),digest=s=>createHash('sha256').update(s).digest('hex');
const cost={N:131072,r:8,p:1,maxmem:160*1024*1024};
const fail=(status,message)=>Object.assign(new Error(message),{status});
const cleanUser=u=>({id:u.id,email:u.email,name:u.name,profile:JSON.parse(u.profile||'{}'),emailVerified:false,createdAt:u.created_at});
function profile(value={}){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['locale','timeZone'].includes(k))||Object.values(value).some(v=>typeof v!=='string'||v.length>80))throw fail(400,'用户扩展资料无效');return JSON.stringify(value);}
function email(value){if(typeof value!=='string'||value.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(value))throw fail(400,'请输入有效邮箱');return value.trim().toLowerCase();}
function password(value){if(typeof value!=='string'||value.length<12||value.length>128)throw fail(400,'密码须为 12–128 个字符');return value;}
function name(value){if(typeof value!=='string'||!value.trim()||value.trim().length>60)throw fail(400,'名称须为 1–60 个字符');return value.trim();}
const MAX_SYNC_BYTES=8*1024*1024,MAX_SYNC_REQUEST=12*1024*1024;
async function body(req,limit=8192){if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw fail(415,'请使用 application/json');let chunks=[],size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw fail(413,'请求过大');chunks.push(chunk);}try{const value=JSON.parse(Buffer.concat(chunks));if(!value||Array.isArray(value)||typeof value!=='object')throw 0;return value;}catch{throw fail(400,'JSON 格式无效');}}
function syncBlob(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||!value.keyWrap||typeof value.keyWrap!=='object')throw fail(400,'同步数据格式无效');
 const base64=(v,bytes,max=MAX_SYNC_BYTES)=>typeof v==='string'&&v.length<=max&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v)&&(bytes===undefined||Buffer.from(v,'base64').length===bytes);
 const wrap=value.keyWrap;
 if(!base64(wrap.salt,16)||!base64(wrap.iv,12)||!base64(wrap.tag,16)||!base64(wrap.key,32)||!base64(value.iv,12)||!base64(value.tag,16)||!base64(value.ciphertext,undefined,Math.ceil(MAX_SYNC_BYTES/3)*4)||!value.ciphertext)throw fail(400,'同步数据格式无效');
 if(Buffer.from(value.ciphertext,'base64').length>MAX_SYNC_BYTES)throw fail(413,'同步数据超过 8 MB');
 return JSON.stringify(value);
}
function createService({database,registration=true,sessionSeconds=604800,now=()=>Date.now(),docs=true,publicOrigin=''}={}){
 if(publicOrigin&&new URL(publicOrigin).origin!==publicOrigin)throw Error('PUBLIC_ORIGIN 必须是完整来源，例如 https://accounts.example.com');
 if(database!==':memory:'){fs.mkdirSync(path.dirname(database),{recursive:true,mode:0o700});}
 const db=new DatabaseSync(database);if(database!==':memory:')fs.chmodSync(database,0o600);
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,salt TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
 CREATE TABLE IF NOT EXISTS sync_state(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,revision INTEGER NOT NULL,blob TEXT NOT NULL,updated_at TEXT NOT NULL);`);
 if(!db.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='profile'))db.exec("ALTER TABLE users ADD COLUMN profile TEXT NOT NULL DEFAULT '{}'");
 const buckets=new Map();let hashes=0;
 function rate(key,max){const time=now();let b=buckets.get(key);if(!b||b.until<=time){if(buckets.size>=10000){for(const [k,v]of buckets)if(v.until<=time)buckets.delete(k);if(buckets.size>=10000)throw fail(429,'请求过多，请稍后重试');}b={count:0,until:time+600000};buckets.set(key,b);}if(++b.count>max)throw fail(429,'请求过多，请稍后重试');}
 async function hash(p,salt){if(hashes>=2)throw fail(503,'认证繁忙，请稍后重试');hashes++;try{return (await derive(p,salt,64,cost)).toString('hex');}finally{hashes--;}}
 function session(req){const header=req.headers.authorization||'';if(!/^Bearer [A-Za-z0-9_-]{43}$/.test(header))throw fail(401,'请重新登录');const tokenHash=digest(header.slice(7));const u=db.prepare('SELECT users.*,sessions.expires_at FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?').get(tokenHash,now());if(!u)throw fail(401,'登录已失效');return {u,tokenHash};}
 function issue(u){db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now());const count=db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(u.id).n;if(count>=20)db.prepare('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY expires_at LIMIT ?)').run(u.id,count-19);const token=randomBytes(32).toString('base64url'),expiresAt=now()+sessionSeconds*1000;db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token),u.id,expiresAt);return {user:cleanUser(u),token,expiresAt};}
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  const send=(status,value)=>{res.writeHead(status);res.end(JSON.stringify(value));};
  try{
   const route=new URL(req.url,'http://localhost').pathname,ip=req.socket.remoteAddress||'unknown';
   if(route==='/healthz'&&req.method==='GET'){db.prepare('SELECT 1').get();return send(200,{ok:true,service:'user-api',version:require('./package.json').version});}
   if(docs&&serveDocs(req,res,route))return;
   // Permit the same-origin Swagger page without allowing cross-site requests or cookies.
   const origin=publicOrigin||`${req.socket.encrypted?'https':'http'}://${req.headers.host}`;
   if(req.headers.origin&&(req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'))throw fail(403,'此接口不接受浏览器跨站请求');
   rate('all:'+ip,300);
   if(req.method==='POST'&&['/v1/auth/register','/v1/auth/login'].includes(route)){
    rate('auth:'+ip,30);const input=await body(req),mail=email(input.email),pass=password(input.password);rate('mail:'+mail,15);
    if(route.endsWith('/register')){
     if(!registration)throw fail(403,'注册已关闭');const display=name(input.name),salt=randomBytes(16).toString('hex'),hashed=await hash(pass,salt);
     if(db.prepare('SELECT id FROM users WHERE email=?').get(mail))throw fail(409,'此邮箱已注册，请登录');
     const u={id:randomUUID(),email:mail,name:display,password_hash:hashed,salt,created_at:new Date(now()).toISOString()};
     db.prepare('INSERT INTO users(id,email,name,password_hash,salt,created_at,profile) VALUES(?,?,?,?,?,?,?)').run(u.id,u.email,u.name,u.password_hash,u.salt,u.created_at,profile(input.profile));return send(201,issue(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)));
    }
    const u=db.prepare('SELECT * FROM users WHERE email=?').get(mail),computed=await hash(pass,u?.salt||'00000000000000000000000000000000');
    if(!u||!timingSafeEqual(Buffer.from(computed,'hex'),Buffer.from(u.password_hash,'hex')))throw fail(401,'邮箱或密码不正确');
    if(db.prepare('SELECT password_hash FROM users WHERE id=?').get(u.id)?.password_hash!==u.password_hash)throw fail(401,'密码已变更，请重新登录');
    return send(200,issue(u));
   }
   if(route==='/v1/me'&&req.method==='GET')return send(200,{user:cleanUser(session(req).u)});
   if(route==='/v1/me'&&req.method==='PATCH'){const {u}=session(req),input=await body(req);db.prepare('UPDATE users SET name=?,profile=? WHERE id=?').run(input.name===undefined?u.name:name(input.name),input.profile===undefined?u.profile:profile(input.profile),u.id);return send(200,{user:cleanUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id))});}
   if(route==='/v1/sync/state'&&req.method==='GET'){const {u}=session(req),row=db.prepare('SELECT revision,blob,updated_at FROM sync_state WHERE user_id=?').get(u.id);return send(200,{revision:row?.revision||0,blob:row?JSON.parse(row.blob):null,updatedAt:row?.updated_at||null});}
   if(route==='/v1/sync/state'&&req.method==='PUT'){
    const {u}=session(req),input=await body(req,MAX_SYNC_REQUEST),expected=Number(input.expectedRevision);
    if(!Number.isSafeInteger(expected)||expected<0)throw fail(400,'同步版本无效');const blob=syncBlob(input.blob),current=db.prepare('SELECT revision FROM sync_state WHERE user_id=?').get(u.id),revision=current?.revision||0;
    if(expected!==revision)throw fail(409,'同步数据已在其他设备更新，请先重新加载');
    const next=revision+1,updatedAt=new Date(now()).toISOString();
    db.prepare('INSERT INTO sync_state(user_id,revision,blob,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,blob=excluded.blob,updated_at=excluded.updated_at').run(u.id,next,blob,updatedAt);
    return send(200,{revision:next,updatedAt});
   }
   if(route==='/v1/auth/logout'&&req.method==='POST'){const {tokenHash}=session(req);db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash);return send(200,{ok:true});}
   if(route==='/v1/auth/password'&&req.method==='POST'){
    rate('password:'+ip,10);const {u}=session(req),input=await body(req,MAX_SYNC_REQUEST);const old=password(input.oldPassword),next=password(input.password),computed=await hash(old,u.salt);
    if(!timingSafeEqual(Buffer.from(computed,'hex'),Buffer.from(u.password_hash,'hex')))throw fail(401,'当前密码不正确');
    const salt=randomBytes(16).toString('hex'),hashed=await hash(next,salt);
    let nextSyncBlob=null,syncExpected=null;if(input.syncState!==undefined){if(!input.syncState||!Number.isSafeInteger(input.syncState.expectedRevision)||input.syncState.expectedRevision<0)throw fail(400,'同步版本无效');syncExpected=input.syncState.expectedRevision;nextSyncBlob=syncBlob(input.syncState.blob);}
    db.exec('BEGIN IMMEDIATE');try{const changed=db.prepare('UPDATE users SET password_hash=?,salt=? WHERE id=? AND password_hash=?').run(hashed,salt,u.id,u.password_hash);if(!changed.changes)throw fail(409,'密码已变化，请重新登录');if(syncExpected!==null){const current=db.prepare('SELECT revision FROM sync_state WHERE user_id=?').get(u.id),revision=current?.revision||0;if(revision!==syncExpected)throw fail(409,'同步数据已在其他设备更新，请重试修改密码');db.prepare('INSERT INTO sync_state(user_id,revision,blob,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,blob=excluded.blob,updated_at=excluded.updated_at').run(u.id,revision+1,nextSyncBlob,new Date(now()).toISOString());}db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
    return send(200,{ok:true,reauthenticate:true});
   }
   throw fail(404,'接口不存在');
  }catch(e){if(e.status===429||e.status===503)res.setHeader('Retry-After',e.status===429?'600':'2');if(!res.headersSent)send(e.status||500,{error:e.status?e.message:'服务暂时不可用'});else res.end();}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=100;
 return {server,db,close:()=>new Promise(resolve=>{server.close(()=>{db.close();resolve();});server.closeAllConnections();})};
}
if(require.main===module){const service=createService({database:process.env.DATABASE_PATH||path.join(__dirname,'data/users.sqlite'),registration:process.env.ALLOW_REGISTRATION!=='false',docs:process.env.DOCS_ENABLED!=='false',publicOrigin:process.env.PUBLIC_ORIGIN||''});service.server.listen(Number(process.env.PORT||8080),process.env.HOST||'127.0.0.1',()=>console.log('User API ready · Swagger: /docs · OpenAPI: /openapi.json'));for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>service.close().then(()=>process.exit(0)));}
module.exports={createService,MAX_SYNC_BYTES};
