const fs=require('node:fs'),path=require('node:path');const {zip}=require('../test/zip-fixture.cjs');
const root=path.join(__dirname,'..'),service=path.join(root,'services/user-api'),output=path.join(root,'artifacts');fs.mkdirSync(output,{recursive:true});
const names=['package.json','server.cjs','docs.cjs','openapi.cjs','Dockerfile','compose.yaml','.dockerignore','README.md','test/api.test.cjs',...fs.readdirSync(path.join(service,'public')).map(file=>'public/'+file)];
const files=names.map(name=>({name:'user-api/'+name,data:fs.readFileSync(path.join(service,name))}));
const target=path.join(output,'user-api-'+require('../services/user-api/package.json').version+'.zip');fs.writeFileSync(target,zip(files));console.log(target);
