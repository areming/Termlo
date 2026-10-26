const ref=name=>({$ref:'#/components/schemas/'+name});
const json=schema=>({'application/json':{schema}});
const error=description=>({description,content:json(ref('Error'))});
const errors={400:error('字段或 JSON 格式无效'),401:error('凭据错误、会话过期或未登录'),403:error('注册关闭或请求来自其他网站'),409:error('邮箱已注册、同步版本冲突或密码并发变更'),413:error('请求体超过接口限制'),415:error('请使用 application/json'),429:{...error('触发限流，10 分钟后重试'),headers:{'Retry-After':{schema:{type:'integer'},description:'等待秒数'}}},503:error('密码计算繁忙，请稍后重试')};
const response=(description,schema)=>({description,content:json(schema)});
const body=(name,example)=>({required:true,content:{'application/json':{schema:ref(name),example}}});
const operation=(id,summary,tag,success,schema,{authenticated=false,request,description='',codes=[]}={})=>({operationId:id,summary,description,tags:[tag],security:authenticated?[{bearerAuth:[]}]:[],...(request?{requestBody:request}:{}),responses:{[success]:response('成功',schema),...Object.fromEntries(codes.map(code=>[code,errors[code]]))}});
const password={type:'string',format:'password',minLength:12,maxLength:128,writeOnly:true};
const email={type:'string',format:'email',maxLength:254,example:'demo@example.com'};
const name={type:'string',minLength:1,maxLength:60,example:'Demo'};
module.exports={openapi:'3.0.3',info:{title:'Termlo User API',version:require('./package.json').version,description:'独立邮箱密码账户服务。先注册或登录，复制响应 token，点击 Authorize 粘贴令牌（无需 Bearer 前缀），再调试个人资料接口。令牌仅保存在本页内存，刷新即清除。Try it out 会真实修改当前服务数据，请使用测试账户。\n\nTermlo 客户端可将空间、主机和模型设置同步到此服务；同步包在客户端使用账户密码加密，服务端只保存密文。同步最多 8 MB，服务端无法解密。该服务不提供邮箱验证、密码找回、订阅或团队权限。SQLite 为单实例存储。错误统一返回 {error}。'},servers:[{url:'/',description:'当前服务'}],tags:[{name:'健康',description:'运行状态'},{name:'认证',description:'注册、登录、退出与改密'},{name:'个人资料',description:'当前用户及可扩展资料'},{name:'客户端同步',description:'仅保存客户端加密后的账户配置密文'}],paths:{
 '/healthz':{get:operation('health','检查服务健康','健康',200,ref('Health'))},
 '/v1/auth/register':{post:operation('register','注册并登录','认证',201,ref('Session'),{request:body('Register',{email:'demo@example.com',password:'change-this-demo-password',name:'Demo',profile:{locale:'zh-CN',timeZone:'Asia/Shanghai'}}),codes:[400,403,409,413,415,429,503],description:'邮箱转小写；密码 12–128 字符。返回一次性可见的会话令牌。ALLOW_REGISTRATION=false 时禁止注册。'})},
 '/v1/auth/login':{post:operation('login','邮箱密码登录','认证',200,ref('Session'),{request:body('Login',{email:'demo@example.com',password:'change-this-demo-password'}),codes:[400,401,403,413,415,429,503],description:'令牌默认有效 7 天，每个用户最多 20 个会话。认证按 IP / 邮箱限流。'})},
 '/v1/me':{get:operation('getMe','读取当前用户','个人资料',200,ref('UserResponse'),{authenticated:true,codes:[401,403,429]}),patch:operation('updateMe','更新名称与扩展资料','个人资料',200,ref('UserResponse'),{authenticated:true,request:body('UpdateProfile',{name:'Demo updated',profile:{locale:'zh-CN',timeZone:'Asia/Shanghai'}}),codes:[400,401,403,413,415,429],description:'省略字段保持不变；传入 profile 会整体替换原 profile。暂不支持修改邮箱；扩展资料仅允许 locale、timeZone，不能写入角色或订阅权限。'})},
 '/v1/auth/logout':{post:operation('logout','退出当前会话','认证',200,ref('Ok'),{authenticated:true,codes:[401,403,429],description:'只撤销当前 Bearer 令牌，无需请求体。'})},
 '/v1/auth/password':{post:operation('changePassword','修改密码并撤销全部会话','认证',200,ref('PasswordChanged'),{authenticated:true,request:body('ChangePassword',{oldPassword:'change-this-demo-password',password:'another-demo-password-42'}),codes:[400,401,403,409,413,415,429,503],description:'需提供当前密码。成功后所有设备的令牌立即失效，必须重新登录。客户端同步已启用时，会在同一事务中轮换密文的密码包装密钥。'})},
 '/v1/sync/state':{get:operation('getSyncState','读取账户同步密文','客户端同步',200,ref('SyncState'),{authenticated:true,codes:[401,403,429],description:'仅返回当前账户绑定的密文和版本号；服务端不持有解密密钥。'}),put:operation('putSyncState','保存账户同步密文','客户端同步',200,ref('SyncRevision'),{authenticated:true,request:body('SyncUpdate',{expectedRevision:0,blob:{version:1,keyWrap:{salt:'AAAAAAAAAAAAAAAAAAAAAA==',iv:'AAAAAAAAAAAAAAAA',tag:'AAAAAAAAAAAAAAAAAAAAAA==',key:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='},iv:'AAAAAAAAAAAAAAAA',tag:'AAAAAAAAAAAAAAAAAAAAAA==',ciphertext:'eyJ2ZXJzaW9uIjoxfQ=='}}),codes:[400,401,403,409,413,429],description:'比较并交换 expectedRevision；密文最多 8 MB。并发写入返回 409，客户端应先重新加载。'})}
},components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer',description:'使用注册/登录响应中的 token；不是 JWT。'}},schemas:{
 Error:{type:'object',required:['error'],properties:{error:{type:'string',example:'请重新登录'}}},
 Profile:{type:'object',additionalProperties:false,properties:{locale:{type:'string',maxLength:80,example:'zh-CN'},timeZone:{type:'string',maxLength:80,example:'Asia/Shanghai'}}},
 Login:{type:'object',required:['email','password'],properties:{email,password}},
 Register:{type:'object',required:['email','password','name'],properties:{email,password,name,profile:ref('Profile')}},
 UpdateProfile:{type:'object',properties:{name,profile:ref('Profile')}},
 ChangePassword:{type:'object',required:['oldPassword','password'],properties:{oldPassword:password,password,syncState:ref('SyncUpdate')}},
 SyncBlob:{type:'object',required:['version','keyWrap','iv','tag','ciphertext'],properties:{version:{type:'integer',enum:[1]},keyWrap:{type:'object',required:['salt','iv','tag','key'],properties:{salt:{type:'string'},iv:{type:'string'},tag:{type:'string'},key:{type:'string'}}},iv:{type:'string'},tag:{type:'string'},ciphertext:{type:'string',description:'客户端加密的配置数据，最多 8 MB'}}},
 SyncUpdate:{type:'object',required:['expectedRevision','blob'],properties:{expectedRevision:{type:'integer',minimum:0},blob:ref('SyncBlob')}},
 SyncState:{type:'object',required:['revision','blob'],properties:{revision:{type:'integer'},blob:{...ref('SyncBlob'),nullable:true},updatedAt:{type:'string',format:'date-time',nullable:true}}},
 SyncRevision:{type:'object',required:['revision','updatedAt'],properties:{revision:{type:'integer'},updatedAt:{type:'string',format:'date-time'}}},
 User:{type:'object',required:['id','email','name','profile','emailVerified','createdAt'],properties:{id:{type:'string',format:'uuid'},email,name,profile:ref('Profile'),emailVerified:{type:'boolean',enum:[false],description:'当前版本尚未实现邮箱验证'},createdAt:{type:'string',format:'date-time'}}},
 UserResponse:{type:'object',required:['user'],properties:{user:ref('User')}},
 Session:{type:'object',required:['user','token','expiresAt'],properties:{user:ref('User'),token:{type:'string',minLength:43,maxLength:43,description:'随机不透明令牌，仅签发时返回。数据库只保存哈希。'},expiresAt:{type:'integer',format:'int64',description:'Unix 毫秒时间戳'}}},
 Ok:{type:'object',required:['ok'],properties:{ok:{type:'boolean',enum:[true]}}},
 PasswordChanged:{type:'object',required:['ok','reauthenticate'],properties:{ok:{type:'boolean',enum:[true]},reauthenticate:{type:'boolean',enum:[true]}}},
 Health:{type:'object',required:['ok','service','version'],properties:{ok:{type:'boolean'},service:{type:'string',example:'user-api'},version:{type:'string',example:'1.2.0'}}}
}}};
