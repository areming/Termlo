const MONITOR_COMMAND = "# TERMUS_METRICS_V1\nif [ ! -r /proc/stat ] || [ ! -r /proc/meminfo ]; then printf 'UNSUPPORTED\\n'; exit 0; fi; LC_ALL=C; export LC_ALL; printf 'STAT\\n'; head -n 1 /proc/stat; printf 'UPTIME\\n'; cat /proc/uptime; printf 'MEM\\n'; cat /proc/meminfo; printf 'NET\\n'; cat /proc/net/dev; printf 'DISK\\n'; df -Pk /; printf 'END\\n'";
const number=s=>/^\d+(?:\.\d+)?$/.test(s||'')&&Number.isFinite(Number(s))?Number(s):null;
function parseSample(text) {
  const section=name=>text.split('\n'+name+'\n')[1]?.split(/\n(?:STAT|UPTIME|MEM|NET|DISK|END)\n/)[0]||'';
  text='\n'+text.replace(/\r/g,'');
  const cpu=section('STAT').trim().split(/\s+/);if(cpu.shift()!=='cpu'||cpu.length<4)throw new Error('此主机暂不支持 Linux 监控');
  const counters=cpu.slice(0,8).map(number);if(counters.some(n=>n===null))throw new Error('CPU 采样无效');
  const uptime=number(section('UPTIME').trim().split(/\s+/)[0]);
  const mem=Object.fromEntries([...section('MEM').matchAll(/^(\w+):\s+(\d+) kB$/gm)].map(m=>[m[1],Number(m[2])*1024]));
  const memory=mem.MemTotal>0&&Number.isFinite(mem.MemAvailable)?{total:mem.MemTotal,used:Math.max(0,Math.min(mem.MemTotal,mem.MemTotal-mem.MemAvailable))}:null;
  const interfaces={};for(const line of section('NET').split('\n')){const match=line.match(/^\s*([^:]+):\s*(.*)$/);if(!match||match[1]==='lo')continue;const values=match[2].trim().split(/\s+/);const rx=number(values[0]),tx=number(values[8]);if(rx!==null&&tx!==null)interfaces[match[1]]={rx,tx};}
  const diskRow=section('DISK').split('\n').map(line=>line.trim().split(/\s+/)).find(row=>row.at(-1)==='/'&&row.length>=6);
  const disk=diskRow&&[diskRow[1],diskRow[2],diskRow[3]].every(s=>number(s)!==null)?{total:Number(diskRow[1])*1024,used:Number(diskRow[2])*1024,available:Number(diskRow[3])*1024,percent:Math.min(100,Number(diskRow[4].replace('%','')))}:null;
  return {cpu:{total:counters.reduce((a,b)=>a+b,0),idle:counters[3]+(counters[4]||0)},uptime,memory,interfaces,disk};
}
function deriveSample(current,previous) {
  let cpu=null,network=null;const elapsed=previous&&current.uptime-previous.uptime;
  if(previous&&elapsed>0&&elapsed<=60){
    const total=current.cpu.total-previous.cpu.total,idle=current.cpu.idle-previous.cpu.idle;
    if(total>0&&idle>=0&&idle<=total)cpu=Math.round(1000*(1-idle/total))/10;
    const names=Object.keys(current.interfaces).sort();
    if(names.length&&JSON.stringify(names)===JSON.stringify(Object.keys(previous.interfaces).sort())){
      const deltas=names.map(name=>({rx:current.interfaces[name].rx-previous.interfaces[name].rx,tx:current.interfaces[name].tx-previous.interfaces[name].tx}));
      if(deltas.every(x=>x.rx>=0&&x.tx>=0))network={rx:deltas.reduce((n,v)=>n+v.rx,0)/elapsed,tx:deltas.reduce((n,v)=>n+v.tx,0)/elapsed};
    }
  }
  return {cpu,memory:current.memory?{...current.memory,percent:100*current.memory.used/current.memory.total}:null,disk:current.disk,network};
}
function readSample(ssh,timeout=4000,command=MONITOR_COMMAND){
  return new Promise((resolve,reject)=>{
    let stream,finished=false,text='',exit=null;
    const done=(error)=>{if(finished)return;finished=true;clearTimeout(timer);ssh.client.off('close',closed);stream?.close();error?reject(error):resolve(parseSafe());};
    const parseSafe=()=>text;
    const closed=()=>done(new Error('连接已断开'));ssh.client.once('close',closed);
    const timer=setTimeout(()=>done(new Error('监控采样超时')),timeout);
    try{ssh.client.exec(command,(error,channel)=>{
      if(error){done(error);return;}if(finished){channel.close();return;}stream=channel;
      channel.on('data',chunk=>{text+=chunk.toString();if(text.length>65536)done(new Error('采样输出超限'));});
      channel.stderr.on('data',()=>{});channel.on('exit',code=>{exit=code;});channel.on('error',done);channel.on('close',()=>done(exit===0?null:new Error('主机拒绝监控采样')));
    });}catch(error){done(error);}
  });
}
class HostMonitor {
  constructor({notify=()=>{},interval=5000,read=readSample}={}){this.notify=notify;this.interval=interval;this.read=read;this.hosts=new Map();this.stopped=false;}
  snapshot(){return [...this.hosts.values()].map(h=>h.value);}
  emit(host){this.notify({type:'host-metrics',metrics:host.value});}
  attach(hostId,ssh){
    if(this.stopped)return;
    let host=this.hosts.get(hostId);if(!host){host={id:hostId,sessions:new Set(),previous:null,value:{hostId,status:'sampling',updatedAt:null},busy:false};this.hosts.set(hostId,host);}
    if(host.sessions.has(ssh))return;host.sessions.add(ssh);
    const close=status=>{if(status!=='closed')return;ssh.off('status',close);host.sessions.delete(ssh);if(!host.sessions.size){clearTimeout(host.timer);host.timer=null;host.previous=null;host.value={...host.value,status:'disconnected'};this.emit(host);}};ssh.on('status',close);
    if(!host.timer&&!host.busy){host.value={...host.value,status:'sampling'};this.emit(host);this.poll(host);}
  }
  async poll(host){
    if(host.busy||this.stopped||!host.sessions.size)return;host.timer=null;host.busy=true;
    const ssh=[...host.sessions].find(s=>s.connected&&!s.closed);
    try{
      if(!ssh)throw new Error('连接已断开');
      const raw=parseSample(await this.read(ssh));
      if(!host.sessions.has(ssh))return;
      host.value={hostId:host.id,status:'live',updatedAt:Date.now(),...deriveSample(raw,host.previous)};host.previous=raw;
    }catch(error){host.previous=null;if(host.sessions.size)host.value={...host.value,status:'unavailable',error:'采样不可用：需要 Linux /proc 和 df 读取权限'};}
    finally{host.busy=false;this.emit(host);if(!this.stopped&&host.sessions.size)host.timer=setTimeout(()=>this.poll(host),host.value.status==='unavailable'?30000:this.interval);}
  }
  close(){this.stopped=true;for(const host of this.hosts.values())clearTimeout(host.timer);}
}
module.exports={MONITOR_COMMAND,parseSample,deriveSample,readSample,HostMonitor};
