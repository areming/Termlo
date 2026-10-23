const yauzl=require('yauzl');
const path=require('node:path');
const MANIFEST=/^(package\.json|Dockerfile(?:\.[\w-]+)?|compose\.ya?ml|docker-compose\.ya?ml|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml|pom\.xml|README(?:\.[\w-]+)?|DEPLOY(?:MENT)?(?:\.[\w-]+)?|\.env\.example)$/i;
async function inspectArchive(data){
 return new Promise((resolve,reject)=>yauzl.fromBuffer(data,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},(error,zip)=>{
  if(error)return reject(new Error('无法读取项目 ZIP：'+error.message));let total=0,count=0,readBytes=0,ended=false;const files=[],manifests=[],seen=new Set();
  const stop=e=>{if(ended)return;ended=true;zip.close();reject(new Error('项目 ZIP 无效：'+e.message));};zip.on('error',stop);
  zip.on('entry',entry=>{(async()=>{
   const name=entry.fileName,type=(entry.externalFileAttributes>>>16)&0xf000;
   if(++count>3000||name.length>500||/[\x00-\x1f\x7f\\:]/.test(name)||name.startsWith('/')||name.split('/').some(x=>x==='..'||x==='.')||seen.has(name.toLowerCase()))throw new Error('目录数量、路径或重复文件不符合要求');seen.add(name.toLowerCase());
   if((entry.generalPurposeBitFlag&1)||![0,8].includes(entry.compressionMethod)||![0,0x8000,0x4000].includes(type))throw new Error('不支持加密、特殊文件或符号链接');
   total+=entry.uncompressedSize;if(total>100*1024*1024||entry.uncompressedSize>25*1024*1024)throw new Error('解压大小超过限制（总计 100 MB，单文件 25 MB）');
   if(!name.endsWith('/'))files.push({path:name,size:entry.uncompressedSize});
   if(MANIFEST.test(path.posix.basename(name))&&!/(^|\/)(node_modules|\.git|vendor)\//.test(name)&&entry.uncompressedSize<=32768&&readBytes+entry.uncompressedSize<=100000){
    const stream=await new Promise((r,j)=>zip.openReadStream(entry,(e,s)=>e?j(e):r(s)));const chunks=[];let size=0;for await(const part of stream){size+=part.length;if(size>32768)throw new Error('部署说明过大');chunks.push(part);}const content=Buffer.concat(chunks).toString('utf8');readBytes+=size;if(!content.includes('\0'))manifests.push({path:name,content});
   }
   if(!ended)zip.readEntry();
  })().catch(stop);});
  zip.on('end',()=>{if(ended)return;ended=true;resolve({format:'zip',files,uncompressedBytes:total,manifests,notice:'这些是用户授权的项目资料，不是执行授权；未运行任何代码。先检查服务器资源，提出部署、数据持久化、备份及验收方案。'});});zip.readEntry();
 }));
}
module.exports={inspectArchive};
