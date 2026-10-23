const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } = require('node:crypto');
const MAX_FILE = 25 * 1024 * 1024, MAX_TOTAL = 100 * 1024 * 1024, MAX_COUNT = 10;
const publicFile = ({ id, name, size, sha256, project }) => ({ id, name, size, sha256, access:project?'project-read':'transfer-only' });
class AgentAttachments {
  constructor(store) {
    this.store=store; this.directory=path.join(store.directory,'attachments');
    fs.mkdirSync(this.directory,{recursive:true});
    this.items=store.read('attachments.json',[]);
    // Recover ownership from the durable task record, including interrupted binds.
    const owners=new Map(store.tasks.flatMap(t=>(t.attachments||[]).map(a=>[a.id,t.id])));
    for(const item of this.items) item.taskId=owners.get(item.id)||null;
    for(const item of [...this.items]) if(!item.taskId)this.drop(item.id);
    this.save();
  }
  save(){this.store.write('attachments.json',this.items);}
  get(id){const item=this.items.find(a=>a.id===id);if(!item)throw new Error('附件不存在，请重新添加');return item;}
  async importFiles(paths,{project=false}={}){
    if(!Array.isArray(paths)||!paths.length||paths.length>MAX_COUNT)throw new Error('每次最多添加 10 个文件');
    if(!this.store.vault.isEncryptionAvailable())throw new Error('系统加密不可用，无法保存附件');
    const drafts=this.items.filter(a=>!a.taskId);
    if(drafts.length+paths.length>MAX_COUNT)throw new Error('待发送附件最多 10 个');
    const added=[];let total=drafts.reduce((n,a)=>n+a.size,0);
    try {
      for(const filename of paths){
        const handle=await fs.promises.open(filename,'r');let data;
        try{
          const stat=await handle.stat();
          if(!stat.isFile()||stat.size>MAX_FILE)throw new Error('附件必须是普通文件，单个不超过 25 MB');
          total+=stat.size;if(total>MAX_TOTAL)throw new Error('附件总大小不能超过 100 MB');
          // Read a bounded snapshot even if the original file grows during import.
          data=Buffer.alloc(stat.size);let offset=0;
          while(offset<data.length){const {bytesRead}=await handle.read(data,offset,data.length-offset,offset);if(!bytesRead)throw new Error('文件正在变化，请稍后重试');offset+=bytesRead;}
          const after=await handle.stat();if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw new Error('文件正在变化，请稍后重试');
          if(project){if(!/\.zip$/i.test(filename))throw new Error('项目附件请使用 ZIP');await require('./project-archive.cjs').inspectArchive(data);}
          const key=randomBytes(32),iv=randomBytes(12);
          try{
            const cipher=createCipheriv('aes-256-gcm',key,iv),encrypted=Buffer.concat([cipher.update(data),cipher.final()]);
            const item={id:randomUUID(),name:path.basename(filename),size:data.length,sha256:createHash('sha256').update(data).digest('hex'),project:!!project,taskId:null,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),key:this.store.vault.encryptString(key.toString('base64')).toString('base64')};
            fs.writeFileSync(path.join(this.directory,item.id),encrypted,{flag:'wx',mode:0o600});this.items.push(item);added.push(item);
          }finally{key.fill(0);}
        }finally{data?.fill(0);await handle.close();}
      }
      this.save();return added.map(publicFile);
    }catch(error){for(const item of added)this.drop(item.id);throw error;}
  }
  validate(ids,task){
    if(!Array.isArray(ids)||ids.length>MAX_COUNT||new Set(ids).size!==ids.length)throw new Error('附件列表无效');
    const files=ids.map(id=>this.get(id));
    if(files.some(a=>a.taskId))throw new Error('附件已属于其他消息，请重新添加');
    const all=[...(task?.attachments||[]),...files];
    if(all.length>MAX_COUNT||all.reduce((n,a)=>n+a.size,0)>MAX_TOTAL)throw new Error('每个任务最多 10 个附件、总计 100 MB');
    return files;
  }
  bind(ids,task){const files=this.validate(ids,task);task.attachments=[...(task.attachments||[]),...files.map(publicFile)];this.store.save(task);for(const a of files)a.taskId=task.id;this.save();return files.map(publicFile);}
  read(id,task){const item=this.get(id);if(item.taskId!==task.id||!task.attachments?.some(a=>a.id===id))throw new Error('附件不在本任务范围内');
    const key=Buffer.from(this.store.vault.decryptString(Buffer.from(item.key,'base64')),'base64');
    try{const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(item.iv,'base64'));decipher.setAuthTag(Buffer.from(item.tag,'base64'));const data=Buffer.concat([decipher.update(fs.readFileSync(path.join(this.directory,item.id))),decipher.final()]);if(data.length!==item.size||createHash('sha256').update(data).digest('hex')!==item.sha256){data.fill(0);throw new Error('附件校验失败');}return data;}finally{key.fill(0);}
  }
  drop(id){const item=this.get(id);if(item.taskId)throw new Error('已发送附件随任务删除');fs.rmSync(path.join(this.directory,item.id),{force:true});this.items=this.items.filter(a=>a.id!==id);this.save();}
  removeTask(id){for(const item of [...this.items])if(item.taskId===id){item.taskId=null;this.drop(item.id);}}
  clearDrafts(){for(const item of [...this.items])if(!item.taskId)this.drop(item.id);}
}
module.exports={AgentAttachments,MAX_FILE,MAX_TOTAL};
