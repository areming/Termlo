const fs=require('node:fs'),path=require('node:path');
const spec=require('./openapi.cjs');
const assets=new Map([
 ['/docs/swagger-ui.css',['swagger-ui.css','text/css']],
 ['/docs/swagger-ui-bundle.js',['swagger-ui-bundle.js','application/javascript']],
 ['/docs/swagger-init.js',['swagger-init.js','application/javascript']],
]);
const html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Termlo User API · Swagger</title><link rel="stylesheet" href="/docs/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/docs/swagger-ui-bundle.js"></script><script src="/docs/swagger-init.js"></script></body></html>';
module.exports=function serveDocs(req,res,route){
 if(req.method!=='GET')return false;
 let content,type;
 if(route==='/openapi.json'){content=JSON.stringify(spec);type='application/json';}
 else if(route==='/docs'||route==='/docs/'){content=html;type='text/html';}
 else if(assets.has(route)){const [file,mime]=assets.get(route);content=fs.readFileSync(path.join(__dirname,'public',file));type=mime;}
 else return false;
 res.setHeader('Content-Type',type+'; charset=utf-8');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 res.writeHead(200);res.end(content);return true;
};
