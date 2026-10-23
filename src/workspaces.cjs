const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Profiles are local data containers, not authenticated cloud identities.
class Workspaces {
  constructor(root) {
    this.root = root; this.file = path.join(root, 'workspaces.json');
    fs.mkdirSync(root, { recursive: true });
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {
      version: 1, activeAccount: 'local', accounts: [{ id: 'local', name: '本地账户', activeSpace: 'default', spaces: [{ id: 'default', name: '默认项目' }] }],
    };
    if (this.data.version !== 1 || !Array.isArray(this.data.accounts) || !this.data.accounts.length) throw new Error('账户空间数据损坏，请备份 workspaces.json');
    for (const a of this.data.accounts) {
      if (!/^(local|[a-f0-9-]{36})$/.test(a.id) || !Array.isArray(a.spaces) || !a.spaces.length) throw new Error('账户数据无效');
      for (const s of a.spaces) if (!/^(default|[a-f0-9-]{36})$/.test(s.id)) throw new Error('项目空间数据无效');
      if (!a.spaces.some(s => s.id === a.activeSpace)) throw new Error('账户当前空间不存在');
    }
    this.find(this.data.activeAccount); this.commit(); this.recoverMove();
  }
  commit() { const temp = this.file + '.' + randomUUID() + '.tmp'; try { fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 }); fs.renameSync(temp, this.file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); } }
  name(value) { if (typeof value !== 'string' || !value.trim() || value.trim().length > 60) throw new Error('名称应为 1–60 个字符'); return value.trim(); }
  find(accountId, spaceId) {
    const account = this.data.accounts.find(a => a.id === accountId); if (!account) throw new Error('账户不存在');
    const space = account.spaces.find(s => s.id === (spaceId || account.activeSpace)); if (!space) throw new Error('空间不属于此账户');
    const accountDirectory = account.id === 'local' ? this.root : path.join(this.root, 'accounts', account.id);
    // Keep the legacy directory and encryption identity intact. No copy/delete migration.
    const directory = account.id === 'local' && space.id === 'default' ? this.root : path.join(accountDirectory, 'spaces', space.id);
    return { account, space, directory, settingsDirectory: path.join(accountDirectory, 'assistant'), key: account.id + '/' + space.id };
  }
  current() { return this.find(this.data.activeAccount); }
  select(accountId, spaceId) { const target = this.find(accountId, spaceId); this.data.activeAccount = target.account.id; target.account.activeSpace = target.space.id; this.commit(); return target; }
  create(kind, name, accountId) {
    name = this.name(name);
    if (kind === 'account') {
      if (this.data.accounts.length >= 30) throw new Error('最多 30 个本地账户');
      if (this.data.accounts.some(a => a.name === name)) throw new Error('账户名称已存在');
      const id = randomUUID(), spaceId = randomUUID();
      this.data.accounts.push({ id, name, activeSpace: spaceId, spaces: [{ id: spaceId, name: '默认项目' }] }); this.commit(); return { accountId: id, spaceId };
    }
    if (kind !== 'space') throw new Error('创建类型无效');
    const { account } = accountId?this.find(accountId):this.current();
    if (account.spaces.length >= 100) throw new Error('每个账户最多 100 个空间');
    if (account.spaces.some(s => s.name === name)) throw new Error('项目空间名称已存在');
    const id = randomUUID(); account.spaces.push({ id, name }); this.commit(); return { accountId: account.id, spaceId: id };
  }
  rename(kind,accountId,spaceId,value){
    const target=this.find(accountId,spaceId),name=this.name(value);
    if(kind==='account'){if(this.data.accounts.some(a=>a.id!==accountId&&a.name===name))throw new Error('账户名称已存在');target.account.name=name;}
    else if(kind==='space'){if(target.account.spaces.some(s=>s.id!==target.space.id&&s.name===name))throw new Error('空间名称已存在');target.space.name=name;}
    else throw new Error('类型无效');this.commit();
  }
  remove(kind,accountId,spaceId){
    const target=this.find(accountId,spaceId);
    if(accountId===this.data.activeAccount&&(kind==='account'||target.space.id===this.current().space.id))throw new Error('请先切换到其他账户或空间');
    if(accountId==='local'&&(kind==='account'||target.space.id==='default'))throw new Error('默认本地账户和项目需要保留');
    const spaces=kind==='account'?target.account.spaces:[target.space];
    for(const s of spaces){const dir=this.find(accountId,s.id).directory;for(const [file,key]of [['hosts.json','hosts'],['assistant/tasks.json',null],['assistant/attachments.json',null]]){const full=path.join(dir,file);if(fs.existsSync(full)){const data=JSON.parse(fs.readFileSync(full));if((key?data[key]:data)?.length)throw new Error('仅能移除没有主机、任务和附件的空间；请先整理数据');}}}
    if(kind==='account')this.data.accounts=this.data.accounts.filter(a=>a.id!==accountId);
    else if(kind==='space'){if(target.account.spaces.length===1)throw new Error('账户至少保留一个空间');target.account.spaces=target.account.spaces.filter(s=>s.id!==target.space.id);if(target.account.activeSpace===target.space.id)target.account.activeSpace=target.account.spaces[0].id;}
    else throw new Error('类型无效');this.commit(); // Existing files are retained, never recursively deleted.
  }
  remoteAccount(baseUrl,user){
    let account=this.data.accounts.find(a=>a.identity?.baseUrl===baseUrl&&a.identity.userId===user.id);
    if(!account){const created=this.create('account',this.data.accounts.some(a=>a.name===user.name)?user.name.slice(0,55)+' '+randomUUID().slice(0,4):user.name);account=this.find(created.accountId).account;}
    account.identity={baseUrl,userId:user.id,email:user.email,displayName:user.name,profile:user.profile||{}};this.commit();return account.id;
  }
  recoverMove(){
    const journal=path.join(this.root,'host-move.json');if(!fs.existsSync(journal))return;
    const record=JSON.parse(fs.readFileSync(journal));
    for(const side of ['destination','source']){const item=record[side],target=this.find(record.accountId,item.spaceId);const {Store}=require('./store.cjs');new Store(target.directory,{}).commit(item.data);}
    fs.unlinkSync(journal);
  }
  spaceHosts(source,spaceId){const target=this.find(this.current().account.id,spaceId);const {Store}=require('./store.cjs');return new Store(target.directory,source.vault).list();}
  transferPlan(source,id,mode){
    if(!['move','copy'].includes(mode))throw new Error('操作无效');source.get(id);
    const selected=new Set([id]);let changed=true;
    while(changed){changed=false;for(const h of source.data.hosts){if(selected.has(h.id)&&h.jumpHostId&&!selected.has(h.jumpHostId)){source.get(h.jumpHostId);selected.add(h.jumpHostId);changed=true;}if(mode==='move'&&selected.has(h.jumpHostId)&&!selected.has(h.id)){selected.add(h.id);changed=true;}}}
    if(selected.size>100)throw new Error('关联主机过多，请先整理跳板链路');return source.list().filter(h=>selected.has(h.id));
  }
  mergeTrust(source,destination,hosts){
    const knownHosts={...destination.data.knownHosts};
    for(const h of hosts){const key=source.key(h),fingerprint=source.data.knownHosts[key];if(fingerprint&&knownHosts[key]&&knownHosts[key]!==fingerprint)throw new Error('目标空间的服务器指纹冲突，请先核实');if(fingerprint)knownHosts[key]=fingerprint;}
    return knownHosts;
  }
  copyHosts(source,destinationId,ids){
    const current=this.current(),target=this.find(current.account.id,destinationId);
    if(target.key===current.key)throw new Error('请选择其他空间');
    if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length)throw new Error('请选择主机');
    const {Store,connectionRoute}=require('./store.cjs'),destination=new Store(target.directory,source.vault),hosts=ids.map(id=>source.get(id)),mapping=new Map(ids.map(id=>[id,randomUUID()]));
    for(const h of hosts)if(h.jumpHostId&&!mapping.has(h.jumpHostId))throw new Error('复制时请包含跳板链路');
    const copies=hosts.map(({specifications,cloudIdentity,...h})=>({...h,id:mapping.get(h.id),jumpHostId:h.jumpHostId?mapping.get(h.jumpHostId):''})),combined=[...destination.data.hosts,...copies];
    for(const h of combined)connectionRoute(combined,h.id);
    destination.commit({...destination.data,hosts:combined,knownHosts:this.mergeTrust(source,destination,hosts)});return source.list();
  }
  saveHost(source,input,spaceId){
    const current=this.current(),target=this.find(current.account.id,spaceId||current.space.id);
    if(target.key===current.key)return source.save(input);
    const {Store}=require('./store.cjs'),destination=new Store(target.directory,source.vault);
    if(!input.id){destination.save(input);return source.list();}
    const original=source.get(input.id),remaining=source.data.hosts.filter(h=>h.id!==original.id);
    if(remaining.some(h=>h.jumpHostId===original.id))throw new Error('有其他主机使用此跳板机，请从卡片菜单一起移动链路');
    if(destination.data.hosts.some(h=>h.id===original.id))throw new Error('目标空间已存在此主机');
    // Validate destination routes and edits before committing either store.
    const draft=Object.create(Store.prototype);draft.vault=source.vault;draft.data={...destination.data,hosts:[...destination.data.hosts,original]};draft.commit=next=>{draft.data=next;};draft.save(input);
    const edited=draft.get(original.id);draft.data.knownHosts=this.mergeTrust(source,destination,[edited]);
    this.commitMove(source,destination,{accountId:current.account.id,source:{spaceId:current.space.id,data:{...source.data,hosts:remaining}},destination:{spaceId:target.space.id,data:draft.data}});return source.list();
  }
  moveHosts(source,destinationId,ids){
    if(this.moveBlocked)throw new Error('主机移动尚未恢复，请重启应用后再操作');
    const current=this.current(),target=this.find(current.account.id,destinationId);
    if(target.key===current.key)throw new Error('目标空间与当前空间相同');
    if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length)throw new Error('请选择要移动的主机');
    const {Store,connectionRoute}=require('./store.cjs'),destination=new Store(target.directory,source.vault),moving=ids.map(id=>source.get(id));
    const remaining=source.data.hosts.filter(h=>!ids.includes(h.id)),combined=[...destination.data.hosts,...moving];
    if(moving.some(h=>destination.data.hosts.some(d=>d.id===h.id)))throw new Error('目标已存在此主机');
    for(const h of remaining)if(ids.includes(h.jumpHostId))throw new Error('还有主机依赖所选跳板机，请一起选择整条链路');
    for(const h of moving)if(h.jumpHostId&&!ids.includes(h.jumpHostId))throw new Error('请同时选择此主机的跳板机链路');
    for(const h of combined)connectionRoute(combined,h.id);
    const knownHosts=this.mergeTrust(source,destination,moving);
    const record={accountId:current.account.id,source:{spaceId:current.space.id,data:{...source.data,hosts:remaining}},destination:{spaceId:target.space.id,data:{...destination.data,hosts:combined,knownHosts}}};
    this.commitMove(source,destination,record);return source.list();
  }
  commitMove(source,destination,record){
    if(this.moveBlocked)throw new Error('主机移动尚未恢复，请重启应用后再操作');
    const {ledgerFile}=require('./host-ledger.cjs');
    const sourceDir=this.find(record.accountId,record.source.spaceId).directory,destinationDir=this.find(record.accountId,record.destination.spaceId).directory;
    const remaining=new Set(record.source.data.hosts.map(h=>h.id));
    for(const host of source.data.hosts.filter(h=>!remaining.has(h.id))){
      const from=ledgerFile(sourceDir,host.id),to=ledgerFile(destinationDir,host.id);
      if(fs.existsSync(from)){fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);}
    }
    const file=path.join(this.root,'host-move.json'),temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(record),{mode:0o600});fs.renameSync(temp,file);
    try{destination.commit(record.destination.data);source.commit(record.source.data);fs.unlinkSync(file);}
    catch(error){
      // A durable journal is the decision to complete the move. Retry both stores
      // before exposing state, or freeze subsequent IPC until startup recovers it.
      try{this.recoverMove();source.data=record.source.data;}
      catch{this.moveBlocked=true;throw new Error('主机移动写入未完成，已暂停操作以保护数据。请释放磁盘空间后重启应用，系统会自动恢复。');}
    }
  }
  public() {
    const current = this.current();
    return { accountId: current.account.id, spaceId: current.space.id, key: current.key, accounts: this.data.accounts.map(a => ({ id: a.id, name: a.name, identity:a.identity||null, activeSpace: a.activeSpace, spaces: a.spaces.map(s => ({ ...s })) })) };
  }
}
module.exports = { Workspaces };
