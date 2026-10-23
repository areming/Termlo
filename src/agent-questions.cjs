const {randomUUID}=require('node:crypto');
const text=(maxLength)=>({type:'string',minLength:1,maxLength});
const schema={type:'object',properties:{questions:{type:'array',maxItems:3,items:{type:'object',properties:{header:text(30),question:text(400),options:{type:'array',maxItems:4,items:{type:'object',properties:{label:text(80),description:text(200)},required:['label','description'],additionalProperties:false}},recommendedOption:{type:'integer',minimum:0,maximum:3}},required:['header','question','options'],additionalProperties:false}}},required:['questions'],additionalProperties:false};
function createRequest(questions){
 if(!questions.length)throw Error('至少提出一个问题');
 for(const q of questions){if(q.options.length===1)throw Error('请提供 2–4 个选项，或空数组以自由回答');if(q.recommendedOption!==undefined&&q.recommendedOption>=q.options.length)throw Error('推荐选项不存在');if(new Set(q.options.map(o=>o.label)).size!==q.options.length)throw Error('选项不能重复');}
 return {id:randomUUID(),status:'pending',createdAt:new Date().toISOString(),questions:questions.map(q=>({...q,id:randomUUID()}))};
}
function normalizeAnswers(request,answers){
 if(!Array.isArray(answers)||answers.length!==request.questions.length)throw Error('请回答全部问题后提交');
 const seen=new Set();return answers.map(a=>{
  if(!a||typeof a!=='object'||Object.keys(a).some(k=>!['questionId','optionIndex','text'].includes(k)))throw Error('回答格式无效');
  const q=request.questions.find(q=>q.id===a.questionId);if(!q||seen.has(q.id))throw Error('问题已变化，请刷新后回答');seen.add(q.id);
  const custom=a.text===undefined?'':a.text;if(typeof custom!=='string'||custom.length>4000)throw Error('补充回答最多 4000 字符');
  const chosen=a.optionIndex!==undefined;if(chosen&&(!Number.isInteger(a.optionIndex)||!q.options[a.optionIndex]))throw Error('选项不存在');
  if(!chosen&&!custom.trim())throw Error('请选择选项或填写回答');
  return {questionId:q.id,question:q.question,...(chosen?{optionIndex:a.optionIndex,choice:q.options[a.optionIndex].label}:{}),text:custom.trim()};
 });
}
module.exports={schema,createRequest,normalizeAnswers};
