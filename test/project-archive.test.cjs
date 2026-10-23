const {test}=require('node:test'),assert=require('node:assert/strict');const {zip}=require('./zip-fixture.cjs'),{inspectArchive}=require('../src/project-archive.cjs');
test('project ZIP exposes bounded deployment manifests, never executes code or reads ordinary secrets',async()=>{
 const report=await inspectArchive(zip([{name:'app/package.json',data:'{"scripts":{"start":"node server.cjs"}}'},{name:'app/README.md',data:'Deploy with Node 24'},{name:'app/.env',data:'VERY_PRIVATE'},{name:'app/server.cjs',data:'throw Error("DO NOT RUN")'}]));
 assert.equal(report.files.length,4);assert.equal(report.manifests.length,2);assert.ok(!JSON.stringify(report).includes('VERY_PRIVATE'));assert.ok(!JSON.stringify(report).includes('DO NOT RUN'));
});
test('project ZIP rejects traversal, duplicate/case collision, special files, oversized payloads and corrupt archives',async()=>{
 for(const entries of [[{name:'../escape',data:'x'}],[{name:'A'},{name:'a'}],[{name:'link',attrs:0xa1ff0000}],[{name:'large',size:101*1024*1024}]])await assert.rejects(inspectArchive(zip(entries)));
 await assert.rejects(inspectArchive(Buffer.from('not a zip')));
});
