// One observable output channel per host. It never accepts terminal input.
class AgentConsole {
  constructor({task,resources,redact,notify,save}) {
    this.task=task; this.resources=resources; this.redact=redact; this.notify=notify; this.save=save;
    task.terminals ||= []; this.pending=new Map(); this.dirty=new Set(); this.timer=null; this.savedAt=0; this.unsaved=false; this.sent=new Map();
  }
  row(hostId) {
    let row=this.task.terminals.find(r=>r.hostId===hostId);
    if(!row) { const host=this.resources.find(h=>h.id===hostId); row={hostId,name:host?.name||hostId,address:host?.address||'',text:'',seq:0,status:'idle',activeJobs:0}; this.task.terminals.push(row); }
    return row;
  }
  append(hostId,text) {
    const row=this.row(hostId); row.text+=text.replace(/\r?\n/g,'\r\n');
    if(row.text.length>120000) { row.text=row.text.slice(-100000); row.truncated=true; }
    row.seq++; row.updatedAt=new Date().toISOString(); this.dirty.add(hostId);
    if(!this.timer) this.timer=setTimeout(()=>this.flush(),150);
  }
  handle(event) {
    const {job,type}=event, row=this.row(job.hostId);
    if(type==='start') {
      this.pending.set(job.id,{stdout:'',stderr:''}); row.activeJobs++; row.status='running';
      this.append(job.hostId,`\n\x1b[36m[${new Date().toLocaleTimeString('zh-CN',{hour12:false})}] ${this.redact(row.name)} · ${job.id.slice(0,8)}\x1b[0m\n$ ${this.redact(job.command)}\n`);
    } else if(type==='data') {
      const pending=this.pending.get(job.id); if(!pending) return;
      pending[event.channel]+=event.text;
      // Hold an unfinished line so a credential split across SSH packets is never published piecemeal.
      const last=pending[event.channel].lastIndexOf('\n');
      if(last>=0) { this.append(job.hostId,this.redact(pending[event.channel].slice(0,last+1))); pending[event.channel]=pending[event.channel].slice(last+1); }
      if(pending[event.channel].length>65536) { pending[event.channel]=''; this.append(job.hostId,'\n[超长未换行输出已省略，请查看操作结果]\n'); }
    } else if(type==='end') {
      const pending=this.pending.get(job.id);
      if(pending) for(const text of Object.values(pending)) if(text) this.append(job.hostId,this.redact(text));
      this.pending.delete(job.id); row.activeJobs=Math.max(0,row.activeJobs-1); row.status=row.activeJobs?'running':job.status;
      const label={completed:'已完成',failed:'失败',timeout:'超时',interrupted:'中断，远端状态待核对'}[job.status]||job.status;
      this.append(job.hostId,`\n\x1b[${job.status==='completed'?'32':'33'}m[${job.id.slice(0,8)} · ${label} · exit ${job.exitCode??'—'}]\x1b[0m\n`);
      this.flush(true);
    }
  }
  flush(force=false) {
    clearTimeout(this.timer); this.timer=null;
    if(this.dirty.size)this.unsaved=true;
    for(const hostId of this.dirty) {
      const row=this.row(hostId), previous=this.sent.get(hostId), {text,...meta}=row;
      const terminal=previous&&text.startsWith(previous.text)?{...meta,baseSeq:previous.seq,delta:text.slice(previous.text.length)}:{...row};
      this.notify({type:'agent-terminal',taskId:this.task.id,terminal});this.sent.set(hostId,{seq:row.seq,text});
    }
    this.dirty.clear();
    // UI updates are frequent; disk snapshots need not be rewritten for every output burst.
    if(this.unsaved&&(force||Date.now()-this.savedAt>=1000)){this.save();this.savedAt=Date.now();this.unsaved=false;}
  }
  close() { this.flush(true); this.pending.clear(); }
}
module.exports={AgentConsole};
