const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {parseOS,parseInventory,identityKey}=require('../src/host-os.cjs'),{Store}=require('../src/store.cjs');
test('OS identification accepts known systems, handles unknown Linux and rejects unrecognized output',()=>{
 for(const [sample,id]of [['Linux\nID="ubuntu"\n','ubuntu'],['Linux\nID=debian\n','debian'],['Linux\nID=rocky\n','rocky'],['Darwin\n','macos'],['FreeBSD\n','freebsd'],['Microsoft Windows [Version 10.0]','windows'],['Linux\nID=custom\n','linux'],['hello world',null]])assert.equal(parseOS(sample),id);
});
test('cached OS survives ordinary edits and restart but cannot follow an endpoint or route change',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'termus-os-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let store=new Store(dir,{});
 const original={name:'A',address:'example.test',username:'tester',group:'Test'};store.save(original);const host=store.list()[0],key=identityKey(host);
 assert.equal(store.cacheOperatingSystem(host.id,'ubuntu',key),true);store.save({...host,name:'Renamed'});assert.equal(store.get(host.id).operatingSystem.id,'ubuntu');
 store=new Store(dir,{});assert.equal(store.get(host.id).operatingSystem.id,'ubuntu');
 store.save({...store.get(host.id),address:'other.test'});assert.equal(store.get(host.id).operatingSystem,undefined);assert.equal(store.cacheOperatingSystem(host.id,'ubuntu',key),false);assert.equal(store.cacheOperatingSystem(host.id,'untrusted-svg',identityKey(store.get(host.id))),false);
});
test('inventory parses CRLF cloud distributions, safe values and unknown family without mislabeling',()=>{const sample='Linux\r\nID=alinux\r\nPRETTY_NAME="Alibaba Cloud Linux 3"\r\nID_LIKE="rhel fedora"\r\nTERMUS_ARCH=x86_64\r\nTERMUS_CPUS=4\r\nTERMUS_MEMORY=8589934592\r\nTERMUS_ROOT=85899345920\r\n';const i=parseInventory(sample);assert.equal(i.id,'alinux');assert.equal(i.name,'Alibaba Cloud Linux 3');assert.equal(i.cpuCount,4);assert.equal(i.memoryTotal,8*1024**3);assert.equal(i.rootTotal,80*1024**3);assert.equal(parseOS('Linux\nID=amzn\n'),'amzn');assert.equal(parseOS('Linux\nID=ol\n'),'ol');assert.equal(parseInventory('Linux\nID=unknown\nID_LIKE=debian\n').id,'linux');assert.equal(parseInventory('Linux\nTERMUS_CPUS=-3\nTERMUS_MEMORY=NaN\n').cpuCount,null);});
