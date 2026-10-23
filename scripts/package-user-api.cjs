const fs=require('node:fs'),path=require('node:path');const {zip}=require('../test/zip-fixture.cjs');
const root=path.join(__dirname,'..'),service=path.join(root,'services/user-api');
const version=require('../services/user-api/package.json').version;
function packageUserApi(target=path.join(root,'artifacts',`user-api-${version}.zip`)){
  const names=['package.json','server.cjs','docs.cjs','openapi.cjs','Dockerfile','compose.yaml','.dockerignore','README.md','test/api.test.cjs',...fs.readdirSync(path.join(service,'public')).map(file=>'public/'+file)];
  const files=names.map(name=>({name:'user-api/'+name,data:fs.readFileSync(path.join(service,name))}));
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,zip(files));
  return target;
}
module.exports={packageUserApi};
if(require.main===module)console.log(packageUserApi());
