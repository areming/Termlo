import {icon} from './icons.js';
import {specificationText} from './host-specs-ui.js';
const cache=new Map();
const hosts=new Map();
const el=(tag,cls,text)=>{const node=document.createElement(tag);node.className=cls;if(text!==undefined)node.textContent=text;return node;};
const bytes=n=>{if(!Number.isFinite(n))return '—';const units=['B','KiB','MiB','GiB','TiB'];let index=0;while(n>=1024&&index<4){n/=1024;index++;}return `${n>=100?Math.round(n):n.toFixed(index?1:0)} ${units[index]}`;};
const percent=n=>Number.isFinite(n)?Math.round(n)+'%':'—';
function render(node){
  const row=cache.get(node.dataset.metricHost);node.replaceChildren();
  const specs=specificationText(hosts.get(node.dataset.metricHost));if(specs&&!node.closest('.host-card')){const config=el('span','metric-specs',specs);config.title='最近连接时识别的规格';node.append(config);}
  if(!row){node.dataset.status='idle';node.append(el('span','metric-idle','连接后显示监控'));return;}
  const stale=row.status==='live'&&Date.now()-row.updatedAt>15000,status=stale?'stale':row.status;
  node.dataset.status=status;
  const state=el('span','metric-state');state.append(el('i','metric-dot'));
  state.title=({live:'每 5 秒更新',sampling:'正在采样',disconnected:'已断开 · 以下为最后一次采样',unavailable:row.error,stale:'采样已过期'})[status];state.setAttribute('aria-label',state.title);node.append(state);
  if(status!=='live')node.append(el('small','metric-age',({sampling:'采样中',disconnected:'已断开',unavailable:'监控不可用',stale:'已过期'})[status]));
  for(const [name,label,value,detail,usage] of [
    ['cpu','CPU',percent(row.cpu),row.cpu===null?'CPU 需要两次采样':'CPU 使用率（含所有核心）',row.cpu],
    ['memory','内存',row.memory?`${bytes(row.memory.used)} / ${bytes(row.memory.total)}`:'—',row.memory?`${percent(row.memory.percent)} · 按 MemAvailable 计算`:'内存数据不可用',row.memory?.percent],
    ['disk','根分区',row.disk?`${bytes(row.disk.used)} / ${bytes(row.disk.total)}`:'—',row.disk?`${percent(row.disk.percent)} · 可用 ${bytes(row.disk.available)}`:'根目录磁盘数据不可用',row.disk?.percent],
    ['transfer','网络',row.network?`↓${bytes(row.network.rx)}/s ↑${bytes(row.network.tx)}/s`:'—','非回环接口流量合计，含虚拟网卡；需要两次采样',null],
  ]){
    const item=el('span','metric-item'+(usage>=90?' critical':usage>=75?' elevated':''));item.title=label+' · '+detail;item.setAttribute('aria-label',label+' '+value);item.append(icon(name),el('span','metric-name',label),el('strong','',value));
    if(Number.isFinite(usage)){const meter=el('i','metric-meter');meter.style.setProperty('--usage',Math.max(0,Math.min(100,usage))+'%');item.append(meter);}
    node.append(item);
  }
  if(row.updatedAt)node.title='最后采样：'+new Date(row.updatedAt).toLocaleTimeString('zh-CN')+'；不发送给模型、不保存历史';
}
export function metricStrip(hostId){const node=el('div','host-metrics');node.dataset.metricHost=hostId||'';render(node);return node;}
export function setMetricHost(node,hostId){node.dataset.metricHost=hostId||'';render(node);}
export function initMetrics(api){
  const update=()=>{document.querySelectorAll('[data-metric-host]').forEach(render);window.dispatchEvent(new Event('termus-metrics'));};
  api.hostMetrics().then(rows=>{for(const row of rows)cache.set(row.hostId,row);update();}).catch(()=>{});
  api.init().then(info=>{for(const h of info.hosts)hosts.set(h.id,h);update();}).catch(()=>{});
  api.onEvent(event=>{if(event.type==='host-metrics'){cache.set(event.metrics.hostId,event.metrics);update();}if(event.type==='host-os'){hosts.set(event.hostId,{id:event.hostId,specifications:event.specifications});update();}});
  setInterval(update,5000);
}
