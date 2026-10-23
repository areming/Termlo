const { randomUUID, createHash } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const posix = require('node:path').posix;
const { SSHSession } = require('./ssh.cjs');
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const hash = text => createHash('sha256').update(text).digest('hex');
const call = (object, method, ...args) => new Promise((resolve,reject) => object[method](...args,(error,value) => error ? reject(error) : resolve(value)));
class AgentRemote {
  constructor({ routes, credentials, verify, signal, recoveryId=null, onFileChange=()=>{}, onStagingChange=()=>{}, onOutput = ()=>{} }) { this.routes = routes; this.credentials = credentials; this.verify = verify; this.signal = signal; this.onOutput=onOutput; this.onFileChange=onFileChange;this.onStagingChange=onStagingChange;this.connections = new Map(); this.jobs = new Map(); this.connecting = new Map();this.recoveryId=/^[a-f0-9-]{36}$/.test(recoveryId||'')?recoveryId:null; }
  async connection(hostId) {
    this.signal.throwIfAborted();
    if (!this.routes.has(hostId)) throw new Error('主机不在本次任务授权范围内');
    if (this.connections.get(hostId)?.connected) return this.connections.get(hostId);
    if (this.connecting.has(hostId)) return this.connecting.get(hostId);
    const promise = (async () => {
      const ssh = new SSHSession(); ssh.on('fault', () => {}); this.connections.set(hostId, ssh);
      const cancel = () => ssh.close(); this.signal.addEventListener('abort', cancel, { once: true });
      try { await ssh.connectRoute(this.routes.get(hostId), this.credentials, this.verify); this.signal.throwIfAborted(); return ssh; }
      catch (error) { ssh.close(); throw error; }
      finally { this.signal.removeEventListener('abort', cancel); }
    })();
    this.connecting.set(hostId,promise);
    try { return await promise; } finally { this.connecting.delete(hostId); }
  }
  async start(hostId, command, timeoutSeconds = 300) {
    if (typeof command !== 'string' || !command.trim() || command.length > 64000 || command.includes('\0')) throw new Error('命令为空或超过 64 KB');
    if (this.jobs.size >= 100) { for (const [id,job] of this.jobs) if (job.status !== 'running') this.jobs.delete(id); }
    if ([...this.jobs.values()].filter(job => job.status === 'running').length >= 6) throw new Error('最多同时运行 6 个远程操作，请先等待已有操作');
    const ssh = await this.connection(hostId);
    const job = { id: randomUUID(), hostId, command, status: 'running', startedAt: new Date().toISOString(), stdout: '', stderr: '', truncated: false, exitCode: null };
    this.jobs.set(job.id,job);
    this.onOutput({type:'start',job:this.snapshot(job)});
    const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
    const append = (key,text) => { if(!text || job.status!=='running')return; job[key] += text; if (job[key].length > 24000) { job[key] = job[key].slice(-24000); job.truncated = true; } this.onOutput({type:'data',job:{id:job.id,hostId},channel:key,text}); };
    const done = (status, error) => {
      if (job.status !== 'running') return;
      job.status = status; job.finishedAt = new Date().toISOString(); if (error) job.error = error;
      clearTimeout(job.timer); this.signal.removeEventListener('abort', cancel); ssh.client.off('close', disconnected);
      this.onOutput({type:'end',job:this.snapshot(job)});
    };
    const cancel = () => { try { job.stream?.signal('TERM'); } catch {} job.stream?.close(); done('interrupted', '已请求停止；远端子进程状态需重新核对，不能假定已撤销'); };
    const disconnected = () => done('interrupted', 'SSH 连接中断，操作结果未知，重连后请检查实际状态');
    job.cancel = cancel; this.signal.addEventListener('abort', cancel, { once: true }); ssh.client.once('close', disconnected);
    job.timer = setTimeout(() => { try { job.stream?.signal('TERM'); } catch {} job.stream?.close(); done('timeout', '命令达到时间上限，远端状态需检查'); }, Math.max(1, Math.min(1800, Number(timeoutSeconds) || 300)) * 1000);
    try {
      ssh.client.exec(command, (error,stream) => {
        if (error) { done('failed', error.message); return; }
        job.stream = stream;
        if (job.status !== 'running' || this.signal.aborted) { stream.close(); return; }
        stream.on('data', chunk => append('stdout', stdoutDecoder.write(chunk)));
        stream.stderr.on('data', chunk => append('stderr', stderrDecoder.write(chunk)));
        stream.on('exit', code => { job.exitCode = Number.isInteger(code) ? code : null; });
        stream.on('error', error => done('failed',error.message));
        stream.on('close', () => { append('stdout',stdoutDecoder.end()); append('stderr',stderrDecoder.end()); done(job.exitCode === 0 ? 'completed' : job.exitCode === null ? 'interrupted' : 'failed'); });
      });
    } catch (error) { done('failed',error.message); }
    return this.wait(job.id, 0.2);
  }
  snapshot(job) { const { stream, timer, cancel, ...data } = job; return data; }
  async wait(id, seconds = 10) {
    const job = this.jobs.get(id); if (!job) throw new Error('操作不存在；若应用已重启，请检查远端状态，历史操作不能直接重放');
    const deadline = Date.now()+Math.max(0,Math.min(20,Number(seconds)||0))*1000;
    while (job.status === 'running' && Date.now() < deadline) { this.signal.throwIfAborted(); await new Promise(resolve => setTimeout(resolve,100)); }
    return this.snapshot(job);
  }
  cancelJob(id) { const job = this.jobs.get(id); if (!job) throw new Error('操作不存在'); job.cancel(); return this.snapshot(job); }
  async file(hostId, filename) {
    if (typeof filename !== 'string' || !filename || filename.length > 4096 || filename.includes('\0')) throw new Error('文件路径无效');
    const ssh = await this.connection(hostId), sftp = await ssh.sftp();
    return { ssh, sftp, filename };
  }
  async bounded(hostId, action, timeout=30000) {
    const ssh = await this.connection(hostId);
    let timer;
    const cancel = () => ssh.close(); this.signal.addEventListener('abort',cancel,{ once:true });
    try { return await Promise.race([action(), new Promise((_,reject) => { timer = setTimeout(() => { ssh.close(); reject(new Error('远程文件操作超时，需核对实际状态')); },timeout); })]); }
    finally { clearTimeout(timer); this.signal.removeEventListener('abort',cancel); }
  }
  async uploadAttachment(hostId,directory,item,data,onProgress=()=>{}) {
    if(typeof directory!=='string'||!directory.startsWith('/')||directory.length>3500||/[\x00-\x1f\x7f]/.test(directory))throw new Error('暂存父目录必须是有效绝对路径');
    return this.bounded(hostId,async()=>{
      const {sftp}=await this.file(hostId,directory);
      const folder=posix.join(directory,'termus-'+randomUUID());
      const filename=posix.join(folder,'payload'+(item.name.match(/(?:\.[a-zA-Z0-9]{1,10}){1,2}$/)?.[0]||''));
      const staging={id:randomUUID(),hostId,attachmentId:item.id,folder,path:filename,sha256:item.sha256,state:'prepared'};
      if(this.recoveryId)this.onStagingChange(staging);
      await call(sftp,'mkdir',folder,{mode:0o700});let complete=false;
      try{
        // Correct permissions despite permissive server defaults/umask implementations.
        await call(sftp,'chmod',folder,0o700);
        let sent=0,last=-10;
        const meter=new Transform({transform(chunk,_encoding,callback){sent+=chunk.length;const percent=Math.floor(sent/Math.max(data.length,1)*90);if(percent>=last+10){last=percent;onProgress(percent);}callback(null,chunk);}});
        function* chunks(){for(let i=0;i<data.length;i+=65536)yield data.subarray(i,i+65536);}
        await pipeline(Readable.from(chunks()),meter,sftp.createWriteStream(filename,{flags:'wx',mode:0o600}),{signal:this.signal});
        await call(sftp,'chmod',filename,0o600);
        const digest=createHash('sha256');let size=0;
        for await(const chunk of sftp.createReadStream(filename)){this.signal.throwIfAborted();size+=chunk.length;if(size>data.length)throw new Error('远端附件大小不符');digest.update(chunk);}
        const sha256=digest.digest('hex');if(size!==data.length||sha256!==item.sha256)throw new Error('远端附件校验失败');
        complete=true;if(this.recoveryId)this.onStagingChange({...staging,state:'applied'});onProgress(100);return {hostId,attachmentId:item.id,name:item.name,path:filename,stagingDirectory:folder,bytes:size,sha256,verified:true,mode:'0600',deploymentVerified:false};
      }finally{if(!complete){await call(sftp,'unlink',filename).catch(()=>{});await call(sftp,'rmdir',folder).catch(()=>{});if(this.recoveryId)this.onStagingChange({...staging,state:'unknown'});}}
    },120000);
  }
  async readFile(hostId, filename) {
    return this.bounded(hostId, async () => {
      const { sftp } = await this.file(hostId,filename), stat = await call(sftp,'stat',filename);
      if (!stat.isFile()) throw new Error('只能读取普通文件');
      const chunks = []; let bytes = 0;
      await new Promise((resolve,reject) => { const stream = sftp.createReadStream(filename,{ start:0, end:65535 }); stream.on('data',chunk => { chunks.push(chunk); bytes += chunk.length; if (bytes > 65536) stream.destroy(new Error('文件读取超限')); }); stream.on('end',resolve); stream.on('error',reject); });
      const data = Buffer.concat(chunks); if (data.includes(0)) throw new Error('文件似乎是二进制，请通过终端工具选择合适的检查方式');
      return { hostId, path: filename, size: stat.size, modifiedAt: new Date(stat.mtime*1000).toISOString(), content: data.toString('utf8'), truncated: stat.size > data.length, sha256: stat.size > data.length ? null : hash(data) };
    });
  }
  async writeFile(hostId, filename, content, expectedSha256) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 65536) throw new Error('文件内容上限 64 KB');
    if (typeof expectedSha256 !== 'string' || !/^(missing|[a-f0-9]{64})$/.test(expectedSha256)) throw new Error('需先读取文件并提供 sha256；新文件填写 missing');
    return this.bounded(hostId, async () => {
      const { sftp } = await this.file(hostId,filename); let previous, mode = 0o600;
      try { const stat = await call(sftp,'lstat',filename); if (!stat.isFile()) throw new Error('不替换目录或符号链接'); mode = stat.mode & 0o777; previous = await this.readFile(hostId,filename); }
      catch (error) { if (error.code !== 2) throw error; }
      if (previous ? previous.sha256 !== expectedSha256 : expectedSha256 !== 'missing') throw new Error('文件内容已变化或过大，请重新读取，不能按旧内容覆盖');
      const write = (file,text,flags) => new Promise((resolve,reject) => { const stream = sftp.createWriteStream(file,{ flags, mode }); stream.on('error',reject); stream.on('close',resolve); stream.end(text); });
      const recoveryDirectory=this.recoveryId?'/tmp/termus-recovery-'+this.recoveryId:null;
      if(recoveryDirectory){try{await call(sftp,'mkdir',recoveryDirectory,{mode:0o700});}catch(e){const stat=await call(sftp,'lstat',recoveryDirectory);if(!stat.isDirectory())throw new Error('任务恢复目录不安全');}await call(sftp,'chmod',recoveryDirectory,0o700);}
      const backup = previous ? recoveryDirectory?posix.join(recoveryDirectory,hash(filename)+'-'+randomUUID()+'.original'):filename+'.termus-backup-'+randomUUID() : null;
      if (backup) await write(backup,previous.content,'wx');
      const record={id:randomUUID(),hostId,path:filename,backup,sha256:hash(content),bytes:Buffer.byteLength(content),recovery:recoveryDirectory?{directory:recoveryDirectory,backup,existed:!!previous,originalSha256:previous?.sha256||null,mode}:undefined};
      if(recoveryDirectory)this.onFileChange({...record,state:'prepared'});
      // Exclusive temporary file; standard SFTP rename is used after a checked read.
      const temporary = filename+'.termus-'+randomUUID()+'.tmp';
      try {
        await write(temporary,content,'wx');
        if (previous && typeof sftp.ext_openssh_rename === 'function') {
          try { await call(sftp,'ext_openssh_rename',temporary,filename); }
          catch (error) { if (error.code !== 8 && !/not supported|does not support/i.test(error.message)) throw error; throw new Error('服务器不支持原子替换，原文件保持不变；可由命令工具明确完成替换。备份：'+backup); }
        } else await call(sftp,'rename',temporary,filename);
        if(recoveryDirectory)this.onFileChange({...record,state:'applied'});return record;
      } catch(error){if(recoveryDirectory)this.onFileChange({...record,state:'unknown'});throw error;
      } finally { await call(sftp,'unlink',temporary).catch(() => {}); }
    });
  }
  async undoWrite(record){
    const {hostId,path:filename,sha256,recovery:r}=record;if(!this.recoveryId||r?.directory!=='/tmp/termus-recovery-'+this.recoveryId||r.backup&&!r.backup.startsWith(r.directory+'/'))throw new Error('撤销记录无效');
    return this.bounded(hostId,async()=>{const {sftp}=await this.file(hostId,filename);let current;try{current=await this.readFile(hostId,filename);}catch(error){if(error.code===2&&!r.existed)return {hostId,path:filename,restored:true,verified:true};throw error;}if(r.existed&&current.sha256===r.originalSha256)return {hostId,path:filename,restored:true,verified:true};if(current.sha256!==sha256)throw new Error('文件在任务之后发生变化，未覆盖：'+filename);if(r.existed){const original=await this.readFile(hostId,r.backup);if(original.sha256!==r.originalSha256)throw new Error('原文件材料校验失败');const temporary=filename+'.termus-undo-'+randomUUID()+'.tmp';try{await new Promise((resolve,reject)=>{const stream=sftp.createWriteStream(temporary,{flags:'wx',mode:r.mode});stream.on('error',reject);stream.on('close',resolve);stream.end(original.content);});if(typeof sftp.ext_openssh_rename!=='function')throw new Error('服务器不支持原子恢复');await call(sftp,'ext_openssh_rename',temporary,filename);await call(sftp,'chmod',filename,r.mode);}finally{await call(sftp,'unlink',temporary).catch(()=>{});}const verified=await this.readFile(hostId,filename);if(verified.sha256!==r.originalSha256)throw new Error('恢复后文件哈希校验失败');}else{await call(sftp,'unlink',filename);try{await call(sftp,'lstat',filename);throw new Error('撤销后文件仍存在');}catch(error){if(error.code!==2)throw error;}}return {hostId,path:filename,restored:true,verified:true};});
  }
  async cleanRecovery(records){for(const record of records){const r=record.recovery;if(!r||!this.recoveryId||r.directory!=='/tmp/termus-recovery-'+this.recoveryId)throw new Error('清理记录无效');await this.bounded(record.hostId,async()=>{const {sftp}=await this.file(record.hostId,r.directory);if(r.backup){if(posix.dirname(r.backup)!==r.directory)throw new Error('清理路径不属于本任务');await call(sftp,'unlink',r.backup).catch(e=>{if(e.code!==2)throw e;});}await call(sftp,'rmdir',r.directory).catch(e=>{if(e.code!==2&&e.code!==4)throw e;});});}return {cleaned:true};}
  async cleanStaging(record){
    if(!this.recoveryId||!record||!this.routes.has(record.hostId)||!/^\/[^\x00-\x1f]*\/termus-[a-f0-9-]{36}$/.test(record.folder)||posix.dirname(record.path)!==record.folder||!/^payload(?:\.[a-zA-Z0-9]{1,10}){0,2}$/.test(posix.basename(record.path)))throw new Error('附件暂存记录无效');
    return this.bounded(record.hostId,async()=>{const {sftp}=await this.file(record.hostId,record.folder);
      let folder;try{folder=await call(sftp,'lstat',record.folder);}catch(e){if(e.code===2)return {cleaned:true};throw e;}
      if(!folder.isDirectory())throw new Error('暂存目录已变化，拒绝清理');
      let file;try{file=await call(sftp,'lstat',record.path);}catch(e){if(e.code!==2)throw e;}
      if(file){if(!file.isFile())throw new Error('暂存文件已变化，拒绝清理');const digest=createHash('sha256');for await(const chunk of sftp.createReadStream(record.path)){this.signal.throwIfAborted();digest.update(chunk);}if(digest.digest('hex')!==record.sha256)throw new Error('暂存文件内容已变化，拒绝清理');await call(sftp,'unlink',record.path);}
      try{await call(sftp,'rmdir',record.folder);}catch(e){if(e.code!==2)throw new Error('暂存目录有其他文件，未递归清理');}
      return {cleaned:true};});
  }
  close() { for (const job of this.jobs.values()) if (job.status === 'running') job.cancel(); for (const ssh of this.connections.values()) ssh.close(); this.credentials = {}; }
}
module.exports = { AgentRemote, quote };
