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
function deploymentModel(ids){return input=>{
  if(input.tools?.[0]?.function.name==='connection_check')return response([call('connection_check')]);
  const h=history(input),last=name=>h.filter(r=>r.name===name).at(-1)?.result;
  const user=input.messages.filter(m=>m.role==='user').map(m=>m.content).join('\n');
  if(user.includes('暂停验证')){
    if(user.includes('核对并继续')){
      const boundary=input.messages.findLastIndex(m=>m.role==='user'&&m.content.includes('核对并继续'));
      const recent=history({...input,messages:input.messages.slice(boundary)}), latest=name=>recent.filter(r=>r.name===name).at(-1)?.result;
      if(!latest('inspect_host'))return response([call('inspect_host',{hostId:ids[0]})]);
      if(!last('review_operation'))return response([call('review_operation',{operationId:last('exec_remote').evidenceId,resolution:'not_applied',evidenceIds:[latest('inspect_host').evidenceId],note:'隔离测试：已重新检查环境，原任务不重复执行。'})]);
      if(!recent.some(r=>r.result.command==='verify-after-pause'))return response([call('exec_remote',{hostId:ids[0],command:'verify-after-pause'})]);
      return response([call('finish_task',{outcome:'completed',summary:'已重新检查远端状态，恢复完成。',evidenceIds:[latest('exec_remote').evidenceId]})]);
    }
    if(!last('exec_remote'))return response([call('exec_remote',{hostId:ids[0],command:'long-running'})],'正在运行一个可暂停的测试任务。');
    return response([call('read_job',{jobId:last('exec_remote').id,waitSeconds:20})]);
  }
  if(!last('checkpoint'))return response([call('checkpoint',{summary:'先检查两台服务器，再部署测试服务并验证。',steps:[{title:'确认服务器环境',status:'running'},{title:'部署并处理异常',status:'pending'},{title:'验证结果',status:'pending'}]})],'我会先读取服务器实际环境，再根据结果继续。');
  if(!last('inspect_host'))return response(ids.map(hostId=>call('inspect_host',{hostId})));
  const running=h.filter(r=>['inspect_host','exec_remote','read_job'].includes(r.name)&&r.result.status==='running').filter(r=>!h.some(x=>x.name==='read_job'&&x.result.id===r.result.id&&x.result.status!=='running'));
  if(running.length)return response(running.map(r=>call('read_job',{jobId:r.result.id,waitSeconds:2})));
  if(!h.some(r=>r.result.command==='deploy-test'))return response([call('exec_remote',{hostId:ids[0],command:'deploy-test'})],'环境已确认，正在部署测试服务。');
  if(!h.some(r=>r.result.command==='repair-test'))return response([call('exec_remote',{hostId:ids[0],command:'repair-test'})],'首次部署返回缺少依赖。我会补齐依赖后重新验证。');
  if(!h.some(r=>r.result.command==='verify-test'))return response(ids.map(hostId=>call('exec_remote',{hostId,command:'verify-test'})));
  if(last('checkpoint') && h.filter(r=>r.name==='checkpoint').length===1)return response([call('checkpoint',{summary:'两台主机均完成验证，测试服务正常。',steps:[{title:'确认服务器环境',status:'done'},{title:'部署并处理异常',status:'done'},{title:'验证结果',status:'done'}]})]);
  return response([call('finish_task',{outcome:'completed',summary:'## 测试任务已完成\n选中服务器均已检查，测试服务健康检查通过。\n首次部署缺少依赖，已补齐并重新验证。\n现场验证已完成，记录保留在当前任务。\n\n这是本地隔离环境的功能测试，没有部署真实 Kubernetes 集群。',evidenceIds:h.filter(r=>r.result.command==='verify-test'&&r.result.status==='completed').map(r=>r.result.evidenceId)})]);
};}
function remoteResponder(command,stream){
  if(command==='long-running'){stream.write('任务运行中\n');return;}
  const failure=command==='deploy-test';
  if(failure)stream.stderr.write('dependency missing\n');
  else stream.write(command.includes('=== SYSTEM')?'Linux fixture 6.8\nUbuntu 24.04\nCPU 4 / RAM 8192 MB\n10.0.0.10\nssh.service running\n':'Ready: service healthy\n');
  stream.exit(failure?1:0);stream.end();
}
module.exports={call,response,startProvider,history,deploymentModel,remoteResponder};
