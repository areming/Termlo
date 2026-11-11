// Scripted OpenAI-compatible model server for smoke tests (non-streaming JSON replies).
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const call = (name,args={}) => ({id:'call_'+randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
const response = (calls,content=null) => ({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content,tool_calls:calls}}],usage:{total_tokens:120}});
async function startProvider(answer) {
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    try {const input=JSON.parse(body);requests.push({path:req.url,authorization:req.headers.authorization,input});const result=await answer(input);if(res.destroyed)return;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));}
    catch(error){res.writeHead(500);res.end(JSON.stringify({error:error.message}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}/v1`,requests,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
function history(input){const calls=new Map();for(const m of input.messages)for(const c of m.tool_calls||[])calls.set(c.id,c.function.name);return input.messages.filter(m=>m.role==='tool').map(m=>({name:calls.get(m.tool_call_id),result:JSON.parse(m.content)}));}
module.exports={call,response,startProvider,history};
