const {randomUUID}=require('node:crypto');
class PromptBroker {
  constructor(notify){this.notify=notify;this.pending=new Map();}
  ask(options){
    const id=randomUUID();return new Promise(resolve=>{
      const timer=setTimeout(()=>this.answer(id,0),120000);this.pending.set(id,{resolve,timer,count:(options.buttons||['取消','确定']).length});
      this.notify({type:'app-prompt',id,options});
    });
  }
  answer(id,response){const item=this.pending.get(id);if(!item)return false;if(!Number.isInteger(response)||response<0||response>=item.count)throw new Error('确认结果无效');clearTimeout(item.timer);this.pending.delete(id);item.resolve({response});this.notify({type:'app-prompt-closed',id});return true;}
  cancelAll(){for(const id of [...this.pending.keys()])this.answer(id,0);}
}
module.exports={PromptBroker};
