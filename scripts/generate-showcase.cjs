// Public showcase art uses documentation-only identities. Never source values from app data.
const fs=require('node:fs'),path=require('node:path');
const out=path.join(__dirname,'..','docs','images');fs.mkdirSync(out,{recursive:true});
const esc=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
const text=(x,y,value,size=16,color='#e8edf4',weight=400)=>`<text x="${x}" y="${y}" fill="${color}" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="${size}" font-weight="${weight}">${esc(value)}</text>`;
const rect=(x,y,w,h,fill='#171d29',radius=12,stroke='none')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}"/>`;
const line=(x1,y1,x2,y2,color='#283447')=>`<path d="M${x1} ${y1}H${x2}" stroke="${color}"/>`;
const pill=(x,y,w,label,fill='#243b3b',color='#8ce2c7')=>rect(x,y-17,w,26,fill,13)+text(x+12,y+1,label,12,color,600);
const head=(title,section)=>`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="680" viewBox="0 0 1200 680"><rect width="1200" height="680" fill="#0b1018"/>${rect(22,22,1156,636,'#121925',18,'#293447')}${rect(22,22,205,636,'#151e2b',18)}${rect(205,22,22,636,'#151e2b',0)}${text(50,69,'◈',32,'#7bdac4',700)}${text(91,67,'Termlo',22,'#f5f7f9',700)}${line(46,92,202,92)}${text(49,125,'DEMO WORKSPACE',11,'#7790a4',600)}${pill(44,165,164,'◉  示例项目','#223344','#d6e5ef')}${text(55,223,'✧  智能助手',15,section==='agent'?'#7bdac4':'#afbdca',600)}${text(55,268,'▣  主机',15,section==='hosts'?'#7bdac4':'#afbdca',600)}${text(55,313,'⌘  终端',15,section==='terminal'?'#7bdac4':'#afbdca',600)}${text(55,358,'⇄  文件传输',15,section==='terminal'?'#7bdac4':'#afbdca',600)}${text(55,630,'●  示例账户',13,'#9cb0be')}${rect(227,22,951,62,'#182230',0)}${text(256,62,title,20,'#f2f6f8',650)}${pill(1031,63,118,'示意数据','#24423f','#9be5d1')}`;
const end='</svg>';
const hosts=head('主机 · 项目空间','hosts')+
  text(259,132,'当前空间的服务器',26,'#f1f5f7',650)+text(260,161,'一眼看清系统、配置与连接状态',14,'#9aabba')+
  rect(259,185,884,48,'#1a2532',10)+text(281,216,'⌕  搜索名称、地址或标签…',14,'#8195a7')+pill(1027,217,93,'全部分组')+
  [[259,'Web / production','192.0.2.10','Ubuntu 24.04','4 vCPU  ·  8 GB RAM  ·  80 GB','CPU 18%   MEM 46%'],[559,'API / staging','192.0.2.20','Debian 12','2 vCPU  ·  4 GB RAM  ·  40 GB','CPU 8%   MEM 31%'],[859,'Bastion / demo','192.0.2.30','Linux','2 vCPU  ·  2 GB RAM  ·  30 GB','待连接']].map(([x,name,ip,os,spec,metric])=>rect(x,260,284,275,'#1b2635',14,'#334257')+text(x+21,299,'◉',26,'#75dac1')+text(x+60,297,name,17,'#eff5f7',650)+text(x+21,335,ip,14,'#9aafc1')+line(x+20,358,x+264,358)+text(x+21,389,os,15,'#dbe7ed',600)+text(x+21,422,spec,12,'#96aabd')+pill(x+20,466,244,metric,'#203a3a','#9fe4d3')+text(x+21,510,'终端   ·   文件传输   ·   更多 ⋯',12,'#9cb0c3')).join('')+
  text(261,604,'示例地址使用文档专用网段 192.0.2.0/24；未展示真实主机。',13,'#8095a7')+end;
const terminal=head('终端与独立 SFTP','terminal')+
  pill(259,132,172,'●  Web / production')+pill(445,132,152,'●  API / staging','#25394b','#cadce7')+
  rect(258,156,512,409,'#0d141d',12,'#344354')+text(280,188,'⌘  SSH 终端',14,'#a6bbcc',600)+line(280,205,750,205)+
  text(283,247,'$ ssh demo@192.0.2.10',15,'#a3e4c8')+text(283,283,'Last login: demo session',14,'#b9cad7')+text(283,319,'$ systemctl status example-api',15,'#a3e4c8')+text(283,354,'● example-api.service   active (running)',14,'#b8e5b1')+text(283,391,'$ curl http://127.0.0.1:8080/healthz',15,'#a3e4c8')+text(283,426,'{ "ok": true }',14,'#d9c6a5')+text(283,466,'$ _',16,'#c6d9e2')+
  rect(791,156,352,409,'#1a2634',12,'#344354')+text(814,190,'⇄  独立文件连接',15,'#dbe7ed',650)+text(814,226,'本地',12,'#91aabb')+text(970,226,'服务器',12,'#91aabb')+line(814,243,1121,243)+text(816,283,'▣  site.zip',14,'#d9e4ec')+text(971,283,'▣  /srv/site',14,'#d9e4ec')+text(816,326,'▣  config.json',14,'#d9e4ec')+text(971,326,'▣  logs',14,'#d9e4ec')+text(816,369,'▣  README.md',14,'#d9e4ec')+rect(817,441,301,57,'#24433f',9)+text(839,476,'⇧  上传 / 下载，独立于终端',13,'#afe8d9',600)+
  text(260,608,'多标签 SSH 与单独的文件连接；命令、状态和路径用不同颜色区分。',13,'#8fa5b6')+end;
const agent=head('智能助手 · Plan 与执行','agent')+
  rect(258,113,526,436,'#172332',12,'#334456')+text(281,151,'项目部署',21,'#ecf3f5',650)+pill(629,149,125,'Plan · 先规划')+
  rect(279,176,478,91,'#203144',10)+text(298,209,'我有一个站点包，先检查两台服务器，',15,'#d5e3eb')+text(298,237,'规划部署与验收方案。',15,'#d5e3eb')+
  text(282,308,'助手已检查当前环境',16,'#ccebdd',650)+text(282,342,'✓  已读取项目清单与依赖',14,'#a9c8c4')+text(282,373,'✓  已核对服务器系统和端口',14,'#a9c8c4')+text(282,405,'?  生产域名与 TLS 方案需要确认',14,'#e7c68e')+
  rect(280,447,476,65,'#25394b',10)+text(299,474,'确认方案后切换到自主执行',14,'#edf5f6',600)+text(299,497,'可在右侧看到每台机器的命令和结果',12,'#9bb4c4')+
  rect(805,113,338,436,'#101923',12,'#344456')+text(827,150,'⌘  执行台',17,'#e6eef2',650)+pill(1004,149,115,'双终端','#263d4b','#bed7e5')+line(826,167,1123,167)+text(829,208,'WEB  ·  192.0.2.10',13,'#86d8c3',650)+text(829,241,'$ uname -a',14,'#dce7ed')+text(829,269,'Linux demo 6.x',13,'#a1b5c2')+line(827,288,1122,288)+text(829,329,'API  ·  192.0.2.20',13,'#86d8c3',650)+text(829,362,'$ df -h',14,'#dce7ed')+text(829,390,'/dev/demo   40G   9G',13,'#a1b5c2')+pill(825,491,293,'执行记录可追溯','#20423d','#a9e5cf')+
  text(259,602,'所有主机、命令与检查结果均为设计示意，不来自真实任务。',13,'#8fa5b6')+end;
const account=head('账户服务 · 选主机部署','agent')+
  rect(276,123,784,457,'#1b2837',16,'#435365')+text(310,164,'部署 Termlo User API',24,'#f1f5f7',650)+text(310,196,'可选独立服务 · 邮箱密码登录 · 单实例 SQLite',14,'#a6bbca')+
  rect(310,225,716,83,'#263b4a',12)+text(334,260,'▣  内置服务包',17,'#e5f0f2',650)+text(334,285,'自动附加到智能体任务，无需手动准备 ZIP',13,'#a5bbca')+
  text(310,349,'选择部署服务器',15,'#e7eff2',650)+rect(310,367,716,76,'#24443f',10,'#6acbb3')+text(336,398,'◉  API / staging',17,'#f1f5f6',650)+text(337,424,'192.0.2.20  ·  Debian 12  ·  2 vCPU / 4 GB',13,'#a5cbca')+
  rect(777,480,248,55,'#72d1b9',10)+text(804,514,'开始检查并部署 →',16,'#0e2729',700)+
  text(310,523,'助手会检查环境并询问缺少的域名、访问方式等信息。',13,'#a7bac8')+
  text(278,618,'部署是智能体任务：执行过程可见，结果需实际验收。示意数据。',13,'#8fa5b6')+end;
for(const [name,svg] of Object.entries({hosts,terminal,agent,account}))fs.writeFileSync(path.join(out,`${name}.svg`),svg+'\n');
console.log('Generated four fictional Termlo showcase illustrations');
