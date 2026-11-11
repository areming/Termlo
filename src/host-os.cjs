const OS_NAMES={ubuntu:'Ubuntu',debian:'Debian',fedora:'Fedora',rhel:'Red Hat',centos:'CentOS',rocky:'Rocky Linux',almalinux:'AlmaLinux',alpine:'Alpine Linux',arch:'Arch Linux',opensuse:'openSUSE',alinux:'Alibaba Cloud Linux',amzn:'Amazon Linux',ol:'Oracle Linux',linux:'Linux',macos:'macOS',freebsd:'FreeBSD',windows:'Windows'};
const OS_COMMAND="# TERMUS_OS_V1\nuname -s 2>/dev/null; if [ -r /etc/os-release ]; then cat /etc/os-release; elif [ -r /usr/lib/os-release ]; then cat /usr/lib/os-release; fi; printf '\\nTERMUS_ARCH='; uname -m 2>/dev/null; printf 'TERMUS_CPUS='; getconf _NPROCESSORS_ONLN 2>/dev/null; printf 'TERMUS_MEMORY='; awk '/^MemTotal:/ {printf \"%.0f\\n\",$2*1024}' /proc/meminfo 2>/dev/null; printf 'TERMUS_ROOT='; LC_ALL=C df -Pk / 2>/dev/null | awk 'NR==2 {printf \"%.0f\\n\",$2*1024}'; printf 'TERMUS_VENDOR='; cat /sys/class/dmi/id/sys_vendor 2>/dev/null";
function fields(text){return Object.fromEntries([...String(text).replace(/\r/g,'').matchAll(/^([A-Z_]+)=(.*)$/gm)].map(m=>[m[1],m[2].trim().replace(/^(["'])(.*)\1$/,'$2')]));}
function parseOS(text){
 text=String(text).slice(0,16384);const f=fields(text),id=f.ID?.toLowerCase();if(id&&OS_NAMES[id])return id;if(id?.startsWith('opensuse')||id==='sles')return 'opensuse';if(id==='archlinux')return 'arch';
 if(/Darwin/i.test(text))return 'macos';if(/FreeBSD/i.test(text))return 'freebsd';if(/Microsoft Windows|Windows_NT/i.test(text))return 'windows';
 return /Linux/i.test(text)?'linux':null;
}
function parseInventory(text){const f=fields(text),id=parseOS(text);if(!id)return null;const positive=(value,max)=>{const n=Number(value);return Number.isFinite(n)&&n>0&&n<=max?n:null;};return {id,name:(f.PRETTY_NAME||OS_NAMES[id]).slice(0,100),family:(f.ID_LIKE||'').slice(0,100).toLowerCase(),architecture:(f.TERMUS_ARCH||'').slice(0,40),cpuCount:positive(f.TERMUS_CPUS,1048576),memoryTotal:positive(f.TERMUS_MEMORY,2**60),rootTotal:positive(f.TERMUS_ROOT,2**60),vendor:(f.TERMUS_VENDOR||'').slice(0,100)};}
const identityKey=host=>JSON.stringify([host.address.toLowerCase(),host.port,host.username,host.jumpHostId||'']);
// Run one short read-only command on an existing connection and collect stdout.
function readSample(ssh,timeout,command){
  return new Promise((resolve,reject)=>{
    let stream,finished=false,text='',exit=null;
    const done=(error)=>{if(finished)return;finished=true;clearTimeout(timer);ssh.client.off('close',closed);stream?.close();error?reject(error):resolve(parseSafe());};
    const parseSafe=()=>text;
    const closed=()=>done(new Error('连接已断开'));ssh.client.once('close',closed);
    const timer=setTimeout(()=>done(new Error('读取主机信息超时')),timeout);
    try{ssh.client.exec(command,(error,channel)=>{
      if(error){done(error);return;}if(finished){channel.close();return;}stream=channel;
      channel.on('data',chunk=>{text+=chunk.toString();if(text.length>65536)done(new Error('主机信息输出超限'));});
      channel.stderr.on('data',()=>{});channel.on('exit',code=>{exit=code;});channel.on('error',done);channel.on('close',()=>done(exit===0?null:new Error('主机拒绝读取系统信息')));
    });}catch(error){done(error);}
  });
}
async function probeOS(ssh){let result;try{result=parseOS(await readSample(ssh,2500,OS_COMMAND));}catch{}if(!result&&!ssh.closed)try{result=parseOS(await readSample(ssh,2000,'cmd /c ver'));}catch{}return result;}
async function probeInventory(ssh){try{const data=parseInventory(await readSample(ssh,5000,OS_COMMAND));if(data)return data;}catch{}const id=await probeOS(ssh);return id?{id,name:OS_NAMES[id]}:null;}
module.exports={OS_NAMES,OS_COMMAND,parseOS,parseInventory,probeOS,probeInventory,identityKey};
