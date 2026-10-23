const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),version=require('../package.json').version;
const destination=path.join(root,'git-ready',`Termlo-${version}`);
if(fs.existsSync(destination))throw new Error('源码导出目录已存在：'+destination);
const roots=['.github','assets','docs','src','scripts','test','services/user-api'];
const singles=['.gitignore','package.json','package-lock.json','README.md','README.zh-CN.md','RELEASE_NOTES.md','CHANGELOG.md','FEATURE-GAPS.md','RELEASING.md'];
const files=[];
function collect(relative){
 const absolute=path.join(root,relative),stat=fs.lstatSync(absolute);
 if(stat.isSymbolicLink())throw new Error('源码导出不跟随符号链接：'+relative);
 if(stat.isDirectory()){for(const name of fs.readdirSync(absolute))collect(path.join(relative,name));return;}
 if(!stat.isFile())throw new Error('源码导出遇到非常规文件：'+relative);
 files.push(relative);
}
for(const entry of [...singles,...roots])collect(entry);
for(const relative of files){const target=path.join(destination,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(root,relative),target);}
const report={version,destination,files:files.length,bytes:files.reduce((n,file)=>n+fs.statSync(path.join(root,file)).size,0)};
fs.writeFileSync(path.join(destination,'SOURCE_EXPORT.json'),JSON.stringify({version,files:report.files,bytes:report.bytes},null,2)+'\n');
console.log(JSON.stringify(report));
