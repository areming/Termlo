const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {packageUserApi}=require('../scripts/package-user-api.cjs');
const {inspectArchive}=require('../src/project-archive.cjs');
const {deploymentPrompt}=require('../src/user-api-deployment.cjs');

test('bundled account API is a valid project attachment with deployment instructions',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'termlo-user-api-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const target=packageUserApi(path.join(folder,'termlo-user-api.zip'));
  const archive=await inspectArchive(fs.readFileSync(target));
  const paths=new Set(archive.files.map(file=>file.path));
  for(const required of ['user-api/server.cjs','user-api/Dockerfile','user-api/compose.yaml','user-api/README.md','user-api/public/swagger-ui-bundle.js'])assert.ok(paths.has(required),required);
  assert.ok(archive.manifests.some(file=>file.path==='user-api/README.md'&&file.content.includes('SQLite')));
  const prompt=deploymentPrompt();
  for(const phrase of ['唯一选中','inspect_project','ask_user','/healthz','/docs','持久化 SQLite','不要在正式数据库遗留演示账户'])assert.ok(prompt.includes(phrase),phrase);
  assert.ok(!prompt.includes('127.0.0.1:8008'));
});
