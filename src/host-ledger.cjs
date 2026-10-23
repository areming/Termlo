const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {identityKey}=require('./host-os.cjs');
const {readSample}=require('./host-monitor.cjs');

// This is deliberately a small read-only sample, not a filesystem inventory or a backup.
const PROBE_COMMAND=String.raw`# TERMUS_HOST_LEDGER_V1
LC_ALL=C; export LC_ALL; printf 'BOOT='; cat /proc/sys/kernel/random/boot_id 2>/dev/null; printf 'KERNEL='; uname -sr 2>/dev/null; printf 'OS='; sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | head -n 1; printf 'MEM='; awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null; printf 'ROOT='; df -Pk / 2>/dev/null | awk 'NR==2 {print $2 " " $3 " " $4}'; printf 'CPU='; getconf _NPROCESSORS_ONLN 2>/dev/null; printf '\nPKG='; stat -c '%Y:%s' /var/lib/dpkg/status /usr/lib/sysimage/rpm/rpmdb.sqlite /var/lib/rpm/Packages /lib/apk/db/installed 2>/dev/null | head -n 1; printf '\nUNITS='; stat -c '%Y:%s' /etc/systemd/system 2>/dev/null; printf '\nEND\n'`;
const fileKey=id=>/^[a-zA-Z0-9_-]{1,100}$/.test(id)?id:createHash('sha256').update(id).digest('hex');
const ledgerFile=(directory,id)=>path.join(directory,'assistant','host-ledger',fileKey(id)+'.json');
const fingerprint=sample=>createHash('sha256').update(JSON.stringify([sample.bootId,sample.kernel,sample.os,sample.memoryTotalKiB,sample.rootTotalKiB,sample.cpuCount,sample.packageStamp,sample.serviceConfigStamp])).digest('hex');
function parseProbe(raw){
  const fields=Object.fromEntries(String(raw).replace(/\r/g,'').split('\n').map(line=>{const i=line.indexOf('=');return i<1?[]:[line.slice(0,i),line.slice(i+1).trim()]}).filter(row=>row.length===2));
  const root=(fields.ROOT||'').split(/\s+/).map(Number),memory=Number(fields.MEM);
  if(!fields.KERNEL||!fields.BOOT||!Number.isFinite(memory)||memory<=0||root.length!==3||root.some(n=>!Number.isFinite(n)||n<0))throw new Error('主机不支持轻量状态采样');
  const cpu=Number(fields.CPU);
  const sample={bootId:fields.BOOT.slice(0,80),kernel:fields.KERNEL.slice(0,120),os:(fields.OS||'').replace(/^['"]|['"]$/g,'').slice(0,120),cpuCount:Number.isInteger(cpu)&&cpu>0?cpu:null,packageStamp:(fields.PKG||'').slice(0,60),serviceConfigStamp:(fields.UNITS||'').slice(0,60),memoryTotalKiB:memory,rootTotalKiB:root[0],rootUsedKiB:root[1],rootAvailableKiB:root[2]};
  return {...sample,fingerprint:fingerprint(sample)};
}
async function defaultProbe(remote,id){
  let timer;
  try{
    const connection=remote.connection(id);
    const ssh=await Promise.race([connection,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('连接采样超时')),8000);})]);
    return parseProbe(await readSample(ssh,4000,PROBE_COMMAND));
  }finally{clearTimeout(timer);}
}
class HostLedger {
  constructor(directory,{probe=defaultProbe,notify=()=>{}}={}){
    this.directory=path.join(directory,'assistant','host-ledger');fs.mkdirSync(this.directory,{recursive:true});this.cache=new Map();this.probe=probe;this.notify=notify;
  }
  file(id){return path.join(this.directory,fileKey(id)+'.json');}
  read(id){
    if(this.cache.has(id))return this.cache.get(id);
    let record={schema:1,hostId:id,identity:null,revision:0,observation:null,check:null,entries:[]};
    const file=this.file(id);if(fs.existsSync(file))try{const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.hostId===id&&saved.schema===1&&Array.isArray(saved.entries))record=saved;}catch{}
    this.cache.set(id,record);return record;
  }
  write(record){
    const file=this.file(record.hostId),temp=file+'.'+randomUUID()+'.tmp';
    try{fs.writeFileSync(temp,JSON.stringify(record,null,2),{mode:0o600});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
    this.notify();
  }
  identity(host){return identityKey({...host,address:String(host.address||'')});}
  status(host){
    const record=this.read(host.id),changed=!!record.identity&&record.identity!==this.identity(host);
    const stale=record.check?.at&&Date.now()-Date.parse(record.check.at)>10*60*1000;
    const state=changed?'identity_changed':record.check?.status==='checking'?'checking':record.check?.status==='unavailable'?'unavailable':stale?'stale':record.check?.status==='changed'?'changed':record.observation?'tracked':'untracked';
    return {hostId:host.id,status:state,revision:record.revision,checkedAt:record.check?.at||null,observedAt:record.observation?.at||null,changeCount:record.entries.filter(e=>e.kind==='change').length};
  }
  summaries(hosts){return hosts.map(h=>this.status(h));}
  summary(hosts){return this.summaries(hosts).map(({hostId,status,revision,checkedAt,changeCount})=>({hostId,status,revision,checkedAt,changeCount}));}
  syncTask(task,hosts,changed=new Set()){
    const flush=arguments.length<3;
    for(const change of task.changeLedger?.changes||[]){
      const host=hosts.find(h=>h.id===change.hostId);if(!host||change.identity&&change.identity!==this.identity(host))continue;
      const record=this.read(host.id),identity=this.identity(host);
      if(record.identity&&record.identity!==identity)continue;
      record.identity=identity;
      const key=task.id+':'+change.id;
      const prior=[...record.entries].reverse().find(e=>e.kind==='change'&&e.key===key);
      if(prior?.state===change.state)continue;
      record.revision++;
      record.entries.push({version:record.revision,at:change.observedAt||new Date().toISOString(),kind:'change',key,taskId:task.id,changeId:change.id,operationId:change.operationId,action:change.kind,resource:String(change.resource||'').slice(0,500),state:change.state,reversibility:change.reversibility});
      changed.add(record);
    }
    if(flush)for(const record of changed)this.write(record);
    return changed;
  }
  syncTasks(tasks,hosts){const changed=new Set();for(const task of [...tasks].sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||''))))this.syncTask(task,hosts,changed);for(const record of changed)this.write(record);}
  async check(host,remote,signal){
    const record=this.read(host.id),identity=this.identity(host),at=new Date().toISOString();
    if(record.identity&&record.identity!==identity){record.revision++;record.entries.push({version:record.revision,at,kind:'identity_changed'});record.observation=null;}
    record.identity=identity;record.check={status:'checking',at};this.notify();
    try{
      const sample=await this.probe(remote,host.id);signal?.throwIfAborted();
      const previous=record.observation,changed=!!previous&&previous.fingerprint!==sample.fingerprint;
      record.observation={...sample,at:new Date().toISOString()};record.check={status:changed?'changed':'tracked',at:record.observation.at};
      if(!previous||changed){record.revision++;record.entries.push({version:record.revision,at:record.observation.at,kind:previous?'drift':'baseline',fingerprint:sample.fingerprint,bootChanged:!!previous&&previous.bootId!==sample.bootId});}
    }catch(error){record.check={status:'unavailable',at:new Date().toISOString(),reason:signal?.aborted?'核对已中断':'连接或采样不可用'};this.write(record);if(signal?.aborted)throw error;return this.status(host);}
    this.write(record);return this.status(host);
  }
  async checkAll(hosts,remote,signal){
    const results=[];let next=0;
    await Promise.all(Array.from({length:Math.min(4,hosts.length)},async()=>{while(next<hosts.length){const host=hosts[next++];results.push(await this.check(host,remote,signal));}}));
    return results;
  }
  page(host,{offset,limit=20}={}){
    if(!Number.isInteger(limit)||limit<1||limit>50||offset!==undefined&&(!Number.isInteger(offset)||offset<0||offset>100000))throw new Error('账本分页范围无效');
    const record=this.read(host.id),entries=record.entries;offset??=Math.max(0,entries.length-limit);
    return {hostId:host.id,referenceOnly:true,identityMatches:record.identity===this.identity(host),status:this.status(host).status,revision:record.revision,observation:record.observation?{at:record.observation.at,kernel:record.observation.kernel,os:record.observation.os,cpuCount:record.observation.cpuCount,memoryTotalKiB:record.observation.memoryTotalKiB,rootTotalKiB:record.observation.rootTotalKiB,rootAvailableKiB:record.observation.rootAvailableKiB}:null,total:entries.length,previousOffset:offset>0?Math.max(0,offset-limit):null,nextOffset:offset+limit<entries.length?offset+limit:null,entries:entries.slice(offset,offset+limit)};
  }
}
module.exports={HostLedger,PROBE_COMMAND,parseProbe,defaultProbe,ledgerFile};
