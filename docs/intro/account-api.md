# 可选账户服务 / Optional account API

[返回首页 / Home](../../README.md)

![虚构账户服务部署示意](../images/account.svg)

**普通 SSH 与本地空间不需要账户服务。** 如果需要邮箱密码身份，可另行部署 Termlo User API。它当前提供注册、登录、资料、退出、改密和 [Swagger 接口文档](../../services/user-api/README.md)，使用单实例 SQLite；它尚不提供邮件验证、订阅计费、团队权限或跨设备主机同步。

在 Termlo 中打开**智能助手 → 账户服务**，选定一台已保存的服务器，点击**开始检查并部署**。Termlo 会自动附上内置服务包，启动限定在所选主机的自主任务。助手应先检查系统、端口、资源和现有服务，再选择部署方式；如需公网访问而缺少域名、代理或 TLS 信息，会向你提问。命令与输出在执行台可见。完成后应核验健康接口、Swagger、实际访问地址、持久化数据和回退方式。

这是**一键发起智能体部署任务**，并非不经检查的固定安装脚本。部署成功取决于远端权限、依赖与网络条件，不能预先承诺 HTTPS 或完整自动回滚。首次联通后，在用户看板的登录/注册表单填写 API 根地址（例如 `https://accounts.example.test`，不要填写 `/v1/auth/register`）。完整部署与接口说明见[服务文档](../../services/user-api/README.md)。

**Local SSH does not require this service.** The optional User API supplies email/password identity and Swagger, using a single SQLite instance. It does not yet provide billing, team permissions, or host synchronization. Open **Assistant → Account service**, select one saved host, and start the task. Termlo attaches the bundled package and limits the agent to that host. The agent checks the environment, asks for missing exposure details, deploys, and verifies. Commands appear in the execution console. This launches an autonomous deployment task, not a guaranteed unattended installation. Enter the resulting API root URL in the account panel after verifying it.
