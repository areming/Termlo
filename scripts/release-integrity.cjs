const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),asar=require('@electron/asar');
const root=path.join(__dirname,'..'),pkg=require('../package.json'),out=path.join(root,pkg.build.directories.output,'win-unpacked'),archive=path.join(out,'resources','app.asar');
const entries=asar.listPackage(archive).map(p=>p.replace(/^[/\\]/,'')).filter(p=>/^(src|dist)[/\\]/.test(p));
let checked=0;for(const entry of entries){const local=path.join(root,entry),stat=fs.existsSync(local)&&fs.statSync(local);if(!stat?.isFile())continue;const actual=asar.extractFile(archive,entry.replace(/\\/g,'/'));if(!fs.readFileSync(local).equals(actual))throw Error('打包内容与源码不一致：'+entry);checked++;}
if(checked<40)throw Error('打包文件核对数量过少：'+checked);
const exe=path.join(out,'Termlo.exe'),sha256=crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
const report={ok:true,version:pkg.version,checked,exe,sha256};fs.mkdirSync(path.join(root,'test-output'),{recursive:true});fs.writeFileSync(path.join(root,'test-output',`release-${pkg.version}-integrity.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
