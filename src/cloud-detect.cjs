const {readSample}=require('./host-monitor.cjs');
// Fixed allowlisted identity fields only. Never query ram/security-credentials.
const CLOUD_COMMAND=`# TERMUS_CLOUD_V1
v=$(cat /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/product_name 2>/dev/null | tr '\\n' ' '); printf 'VENDOR=%s\\n' "$v"; printf 'VIRT='; systemd-detect-virt 2>/dev/null || true
command -v curl >/dev/null 2>&1 || exit 0
t=$(curl --noproxy '*' -fsS --connect-timeout 1 --max-time 1 -X PUT -H 'X-aliyun-ecs-metadata-token-ttl-seconds: 60' http://100.100.100.200/latest/api/token 2>/dev/null) || exit 0
[ -n "$t" ] || exit 0
for k in instance-id region-id; do printf '%s=' "$k"; curl --noproxy '*' -fsS --connect-timeout 1 --max-time 1 -H "X-aliyun-ecs-metadata-token: $t" "http://100.100.100.200/latest/meta-data/$k" 2>/dev/null; printf '\\n'; done
unset t`;
function parseCloud(text){text=String(text).slice(0,4096).replace(/\r/g,'');const instanceId=text.match(/^instance-id=(i-[a-zA-Z0-9]+)\s*$/m)?.[1],region=text.match(/^region-id=([a-z]{2}-[a-z0-9-]+)\s*$/m)?.[1];const vendor=(text.match(/^VENDOR=(.*)$/m)?.[1]||'')+' '+(text.match(/^VIRT=(.*)$/m)?.[1]||'');if(instanceId&&region)return {provider:'aliyun',instanceId,region,observedAt:new Date().toISOString()};const platform=/vmware/i.test(vendor)?'vmware':/hyper-v|microsoft.*virtual machine/i.test(vendor)?'hyperv':/qemu|kvm/i.test(vendor)?'kvm':/virtualbox|innotek|oracle.*virtualbox/i.test(vendor)?'virtualbox':/alibaba|aliyun/i.test(vendor)?'aliyun':null;return platform?{provider:platform,observedAt:new Date().toISOString()}:null;}
async function detectCloud(ssh){try{return parseCloud(await readSample(ssh,4500,CLOUD_COMMAND));}catch{return null;}}
module.exports={CLOUD_COMMAND,parseCloud,detectCloud};
