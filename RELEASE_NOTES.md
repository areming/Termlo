# Termlo 1.1.0

Termlo is an Electron/JavaScript desktop client for SSH, independent SFTP, and agent-assisted server work. Version 1.1.0 adds an **Account service** entry in Assistant: select one saved host, attach the bundled User API package automatically, and start an autonomous deployment task with visible checks and command output. The optional service provides email/password identity and Swagger documentation; local SSH does not require it.

The repository home is now bilingual, with four illustrated guides for hosts, terminals, the agent, and account service deployment. All illustrations contain fictional demo data, not screenshots of user servers or accounts.

Windows and macOS installers remain unsigned. Deployment success depends on the target host, available permissions, and network setup; public HTTPS and rollback are never assumed without verification. See the [guide](README.md) and [account API details](services/user-api/README.md).

## 中文

1.1.0 在助手中新增**账户服务**入口：选一台已保存的服务器，自动附上用户 API 包并发起自主部署任务。检查、执行与验收仍由智能体根据现场完成，命令可在执行台查看。普通 SSH 无需使用账户服务。

仓库首页改为页内中英双语，并加入四个功能介绍页。所有配图均由虚构示例制作，不包含真实主机、账户或任务截图。安装包尚未签名；目标主机的权限、依赖与网络条件会影响部署结果。
