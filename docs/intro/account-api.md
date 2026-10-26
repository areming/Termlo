# 可选账户服务 / Optional account API

[返回首页 / Home](../../README.md)

![虚构账户服务部署示意](../images/account.svg)

**普通 SSH 与本地空间不需要账户服务。** 如果需要邮箱密码身份，可另行部署 Termlo User API。它提供注册、登录、资料、退出、改密、账户配置密文同步和 [Swagger 接口文档](../../services/user-api/README.md)，使用单实例 SQLite；它尚不提供邮件验证、订阅计费或团队权限。

在新版 Termlo 中打开**智能助手 → 账户服务**，选定一台已保存的 Linux 服务器，点击**开始检查并部署**。桌面端先检查 Docker Compose、磁盘、内存和端口；通过后用内置脚本构建、启动并检查健康接口、OpenAPI 和 Swagger。所有步骤会显示在执行台，这条固定流程不调用大模型。目标目录或服务端口已被占用时会停止，不覆盖已有服务。部署后仅监听服务器本机地址；公网访问、域名和 HTTPS 需另行配置。

登录后，空间、主机配置、服务器指纹和模型服务设置会加密后同步到该账户。SSH 密码、私钥文件和模型 API 密钥不上传；新设备需重新录入或选择这些认证信息。多设备同时修改时，服务端用版本号阻止静默覆盖。任务历史和变更账本不参与同步。

**Local SSH does not require this service.** The optional User API supplies email/password identity, encrypted configuration sync, and Swagger, using a single SQLite instance. It does not yet provide billing or team permissions. In a current Termlo build, open **Assistant → Account service**, select one saved Linux host, and start the deployment. A fixed read-only check runs first; if ready, one bundled script builds, starts, and verifies the service without model calls. The service initially listens only on the server's loopback address.

After sign-in, spaces, host settings, trusted server fingerprints, and non-secret model settings sync as encrypted data. SSH passwords, private key files, and model API keys remain on each device. Task history and change ledgers do not sync. Concurrent changes are protected by a revision check instead of silent overwrite.
