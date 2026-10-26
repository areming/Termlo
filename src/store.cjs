const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function text(value, limit = 200) { return typeof value === 'string' ? value.trim().slice(0, limit) : ''; }
function normalizeHost(input) {
  if (!input || typeof input !== 'object') throw new Error('主机信息无效');
  const host = {
    name: text(input.name), address: text(input.address, 253),
    port: Number(input.port || 22), username: text(input.username),
    group: text(input.group) || '未分组', tags: text(input.tags),
    auth: input.auth === 'key' ? 'key' : 'password',
    keyPath: text(input.keyPath, 4096) || (input.needsKeyFile===true?'__TERMLO_KEY_REQUIRED__':''), ...(input.needsKeyFile===true&&!text(input.keyPath,4096)?{needsKeyFile:true}:{}), color: ['mint', 'blue', 'purple', 'amber'].includes(input.color) ? input.color : 'mint',
    jumpHostId: text(input.jumpHostId, 100),
  };
  if (!host.name || !host.address || !host.username) throw new Error('请填写名称、地址和用户名');
  if (/[\s/\\\x00-\x1f]/.test(host.address)) throw new Error('主机地址应为 IP 或域名，不包含协议和路径');
  if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535) throw new Error('端口范围为 1–65535');
  if (host.auth === 'key' && !host.keyPath) throw new Error('请选择私钥文件');
  return host;
}

class Store {
  constructor(directory, vault) {
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'hosts.json');
    this.vault = vault;
    this.data = { version: 1, hosts: [], knownHosts: {} };
    if (fs.existsSync(this.file)) {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.hosts) || typeof data.knownHosts !== 'object' || !data.knownHosts) {
        throw new Error('主机数据格式不正确，请先备份 hosts.json');
      }
      this.data = data;
    }
  }
  commit(next) {
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
      this.data = next;
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  list() { return this.data.hosts.map(({ encryptedPassword, ...host }) => ({ ...host, hasPassword: !!encryptedPassword })); }
  get(id) {
    const host = this.data.hosts.find(h => h.id === id);
    if (!host) throw new Error('主机不存在');
    return host;
  }
  save(input) {
    const previous = input.id ? this.get(input.id) : null;
    const host = { ...normalizeHost(input), id: previous?.id || randomUUID() };
    // A saved credential is valid only for the same endpoint and user.
    const sameEndpoint = previous && ['address', 'port', 'username', 'auth'].every(k => previous[k] === host[k]);
    if(sameEndpoint&&previous.jumpHostId===host.jumpHostId){if(previous.operatingSystem)host.operatingSystem=previous.operatingSystem;if(previous.specifications)host.specifications=previous.specifications;if(previous.cloudIdentity)host.cloudIdentity=previous.cloudIdentity;}
    if(previous)host.color=previous.color;
    if (sameEndpoint && !input.clearPassword && host.auth === 'password') host.encryptedPassword = previous.encryptedPassword;
    if (input.rememberPassword && input.password && host.auth === 'password') {
      if (!this.vault.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，无法保存密码');
      host.encryptedPassword = this.vault.encryptString(input.password).toString('base64');
    }
    const hosts = this.data.hosts.filter(h => h.id !== host.id);
    hosts.push(host);
    // Validate every affected route, including hosts already using this gateway.
    for (const entry of hosts) connectionRoute(hosts, entry.id);
    this.commit({ ...this.data, hosts });
    return this.list();
  }
  password(id) {
    const encrypted = this.get(id).encryptedPassword;
    if (!encrypted) return undefined;
    try { return this.vault.decryptString(Buffer.from(encrypted, 'base64')); }
    catch { throw new Error('无法解密已保存密码，请编辑主机并清除后重新保存'); }
  }
  route(id) { return connectionRoute(this.list(), id); }
  cacheOperatingSystem(id,os,key){const {OS_NAMES,identityKey}=require('./host-os.cjs');const host=this.get(id);if(!OS_NAMES[os]||identityKey(host)!==key)return false;this.commit({...this.data,hosts:this.data.hosts.map(h=>h.id===id?{...h,operatingSystem:{id:os,observedAt:new Date().toISOString()}}:h)});return true;}
  cacheInventory(id,info,key){const {OS_NAMES,identityKey}=require('./host-os.cjs');if(!OS_NAMES[info?.id]||identityKey(this.get(id))!==key)return false;const observedAt=new Date().toISOString();this.commit({...this.data,hosts:this.data.hosts.map(h=>h.id===id?{...h,operatingSystem:{id:info.id,name:info.name,family:info.family,observedAt},specifications:{architecture:info.architecture,cpuCount:info.cpuCount,memoryTotal:info.memoryTotal,rootTotal:info.rootTotal,observedAt}}:h)});return true;}
  cacheCloud(id,cloud,key){const {identityKey}=require('./host-os.cjs');if(identityKey(this.get(id))!==key)return false;this.commit({...this.data,hosts:this.data.hosts.map(h=>h.id===id?{...h,cloudIdentity:cloud}:h)});return true;}
  remove(id) {
    this.get(id);
    const dependent = this.data.hosts.find(host => host.jumpHostId === id);
    if (dependent) throw new Error(`“${dependent.name}”正在使用此跳板机，请先修改该主机的连接设置`);
    this.commit({ ...this.data, hosts: this.data.hosts.filter(h => h.id !== id) });
  }
  key(host) { return JSON.stringify([host.address.toLowerCase(), host.port]); }
  known(host) { return this.data.knownHosts[this.key(host)]; }
  trust(host, fingerprint) { this.commit({ ...this.data, knownHosts: { ...this.data.knownHosts, [this.key(host)]: fingerprint } }); }
  forget(key) { const next = { ...this.data.knownHosts }; delete next[key]; this.commit({ ...this.data, knownHosts: next }); }
}
function connectionRoute(hosts, id) {
  const route = [], seen = new Set();
  while (id) {
    if (seen.has(id)) throw new Error('跳板机配置存在循环，请选择其他主机');
    if (route.length >= 5) throw new Error('最多支持 4 级跳板机');
    seen.add(id);
    const host = hosts.find(h => h.id === id);
    if (!host) throw new Error('跳板机或目标主机不存在');
    route.unshift({ ...host }); id = host.jumpHostId;
  }
  return route;
}
module.exports = { Store, normalizeHost, connectionRoute };
