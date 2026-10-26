# Termlo User API

独立用户服务，Node.js 24.13+（24.x）及内置 SQLite，无第三方运行依赖。支持邮箱密码注册、登录、当前用户、资料更新、退出、改密撤销全部会话，并为 Termlo 客户端保存端到端加密的账户配置。邮箱是登录标识，**本版本没有邮件验证、邮件找回、MFA、订阅或团队权限**。

## Swagger 接口文档

启动后打开 [Swagger UI](http://127.0.0.1:8080/docs)，可查看全部接口、字段约束、请求示例、响应结构与错误码。机器可读定义位于 [/openapi.json](http://127.0.0.1:8080/openapi.json)，可导入 Postman 等工具。

1. 展开注册或登录接口，点击 **Try it out → Execute**，用测试账户请求。
2. 复制成功响应的 `token`，在顶部 **Authorize** 中粘贴（不加 Bearer 前缀）。
3. 调试 `/v1/me`、资料更新、退出、改密。执行会真实修改当前服务数据；改密会撤销所有会话。

Swagger UI 5.34.0 的前端资源随包提供，服务器无需访问 CDN，浏览器不会调用外部校验服务。令牌只保存在当前页面内存，刷新即清除。前端资源来源与许可证见 `public/VENDOR.md`、`public/LICENSE`、`public/NOTICE`；集成方式参考 [Swagger UI 官方说明](https://swagger.io/docs/open-source-tools/swagger-ui/usage/installation/)。

接口仅允许本服务同源页面调试，其他网站请求仍拒绝，不开启宽松 CORS 或 cookie 认证。反向代理使用 HTTPS 时，设置 `PUBLIC_ORIGIN=https://accounts.example.com`（不带结尾斜杠或路径），使来源校验与外部地址一致；不读取不可信的转发头。设置 `DOCS_ENABLED=false` 可关闭 `/docs`、静态资源及 `/openapi.json`。当前路由以域名根路径部署。

## 启动

开发运行 `npm start`，默认只监听 `127.0.0.1:8080`。数据保存于 `data/users.sqlite`。环境变量：`HOST`、`PORT`、`DATABASE_PATH`、`ALLOW_REGISTRATION`（false 关闭注册）。测试运行 `npm test`。

Linux 容器运行 `docker compose up -d --build`。服务端口绑定宿主机回环地址，持久卷 `users` 存放数据库；使用非 root 用户。对外发布请在同机反向代理配置 HTTPS，转发到 `127.0.0.1:8080`。不要直接暴露明文登录接口，也不要把数据库目录加入网站静态文件目录。

应用中的“账户与空间管理 → 登录 / 注册”填写 API 根地址，例如 `https://accounts.example.com`（不要加 /v1）。本机调试可填写 `http://127.0.0.1:8080`。启用账户数据同步后，客户端使用账户密码派生包装密钥并加密空间、主机和模型服务设置；服务器只存放不可读密文。SSH 密码、私钥文件和模型 API 密钥都不会同步，换设备后需重新录入密码、选择私钥并配置模型密钥。服务器不保存账户密码，登录令牌与本机解密密钥由桌面系统加密保存。

## API v1

请求/响应采用 JSON。认证使用 `Authorization: Bearer <token>`，令牌不能放在 URL。响应默认禁止缓存。错误格式为 `{"error":"说明"}`。

| 方法与路径 | 输入 | 成功响应 |
|---|---|---|
| GET /healthz | 无 | 200，ok/service/version |
| POST /v1/auth/register | email、password、name，可选 profile | 201，user/token/expiresAt |
| POST /v1/auth/login | email、password | 200，user/token/expiresAt |
| GET /v1/me | Bearer | 200，user |
| PATCH /v1/me | Bearer，可选 name、profile | 200，user |
| POST /v1/auth/logout | Bearer | 200，ok |
| POST /v1/auth/password | Bearer、oldPassword、password | 200，ok/reauthenticate |
| GET /v1/sync/state | Bearer | 200，当前账户密文及版本号 |
| PUT /v1/sync/state | Bearer、expectedRevision、blob | 200，新版本号；并发更新返回 409 |

`user` 包含稳定 UUID、email、name、profile、emailVerified=false、createdAt。`profile` 为扩展字段容器，当前允许 locale 和 timeZone（各最多 80 字符）。后续扩展字段需明确验证，不允许用户提交 role、plan 等权限字段。PATCH 的 profile 替换现有 profile；不修改 email。

客户端同步按账户隔离，以版本号执行比较并交换。加密使用随机数据密钥、AES-256-GCM 和 scrypt 密码包装；每次保存生成新的认证加密 nonce。服务端只校验密文大小与结构，不具备解密能力。配置密文上限为 8 MB。密码修改时，客户端会在一次账户服务事务中轮换密钥包装并撤销全部旧会话。并发设备修改会收到 409，防止静默覆盖；私钥文件内容、任务历史和服务器变更账本不参与同步。

邮箱大小写归一化；密码 12–128 字符。scrypt N=131072/r=8/p=1，加随机盐；同时最多执行两次密码派生。令牌使用 32 随机字节，有效 7 天，数据库只保存 SHA-256；每用户最多 20 个会话。改密撤销所有会话。请求体最多 8 KB，认证有 IP/邮箱限流。当前不信任 X-Forwarded-For，因此代理后的 IP 限流可能对所有客户端共用，公网较大规模部署应在可信代理层设计独立限流。

SQLite 是**单实例**存储方案，不能将此服务多副本直接挂载同一个跨机器文件，也不提供高可用。多机先确定主机角色；要多副本认证服务，应另行迁移共享数据库、分布式限流和会话存储。当前实例的限流在重启后重置。

密码哈希和会话设计参考 [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)、[OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)；SQLite API 参考 [Node.js 官方文档](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)。Node 24 此模块仍有实验性提示，运行时应锁定并先测试升级。

## 交给智能体部署

在支持固定部署流程的 Termlo 版本中，打开**智能助手 → 账户服务**，选择一台已保存的 Linux 主机，点击**开始检查并部署**。桌面端先用固定只读命令检查 Docker/Compose、磁盘、内存和端口；通过后上传内置部署包并用一条脚本构建、启动和验收。命令与输出在执行台可见，此专用流程不调用大模型。服务器需要预先安装 Docker Compose，并允许当前 SSH 用户使用 Docker；公网访问、域名、HTTPS 与反向代理需另行配置。部署包只监听服务器回环地址。

也可手动走 Plan 流程：

用 Termlo 的“项目 ZIP”附件按钮选择本服务的部署包，选中服务器并保持 Plan 模式，发送：

> 读取项目包和所选服务器现状，规划部署这个用户 API。先确认已有业务、端口、域名/TLS、持久化目录与备份，不覆盖现有站点。此版使用单实例 SQLite；多台机器先明确角色，不把副本数当成高可用。列出回滚步骤和逐项验收，等我确认方案后再执行。

批准后，智能体可上传、构建、启动、检查接口，并返回访问地址和文件位置。不要把真实数据库、.env、私钥和日志打入项目包。ZIP 上限 25 MB、解压后 100 MB、3000 个条目；分析仅读取目录和部署清单，不执行源码。

## 部署验收与回滚

1. 检查 Linux、可用内存（建议至少 1 GB）、Docker/Compose 或 Node 24、磁盘、端口占用；不擅自卸载现有软件。
2. 使用独立版本目录；ZIP 解压前验证路径、禁止链接和路径穿越；不要直接覆盖现有目录。配置持久卷与权限，设置反向代理和 TLS。
3. 健康端点可访问；使用随机测试邮箱/密码验证注册、登录、/me、错误密码被拒绝、退出后旧 token 失效。测试密码/token 不回显到报告。
4. 重启服务，确认同一测试账户仍可登录（数据库持久化）；验证外部 HTTPS 访问路径与证书。未提供域名时不要虚构公网验收结果。
5. 升级前使用 SQLite backup API 或短暂停机复制完整数据库（不要只复制正在写入的主数据库文件而遗漏 WAL）。保留旧镜像和旧版本目录；失败时回退应用版本，涉及数据结构变更必须先评估恢复备份是否会丢失新数据。

本包提供部署材料；没有随包内置服务器、生产域名、账户凭据或自动部署授权。
