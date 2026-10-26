# Termlo 1.2.0

Remote account sign-in now loads encrypted spaces, host settings, trusted server fingerprints, and non-secret model settings. The account service stores only client-encrypted data. SSH passwords, private-key files, model API keys, task history, and host change ledgers remain local to each device. A revision conflict can be resolved by choosing the cloud or local configuration.

The user dashboard groups account details, spaces, and common actions in one place. The bundled User API deployment now performs a read-only Linux, Docker Compose, resource, and port preflight, then runs a fixed installer script and verifies health, OpenAPI, and Swagger. This dedicated flow makes no model calls and initially binds only to the server loopback address. Existing deployments are not overwritten.

The standalone User API is version 1.2.0. It adds version-checked encrypted configuration sync and rotates the wrapped sync key atomically when the account password changes. SSH and SFTP remain available without a remote account.

## 中文

远程账户登录后会载入端到端加密的空间、主机设置、服务器指纹和非密钥模型设置。账户服务只保存客户端加密后的密文。SSH 密码、私钥文件、模型 API 密钥、任务历史和主机变更账本仍保存在各自设备。遇到多设备版本冲突时，可选择载入云端配置或用本机配置覆盖。

用户看板将账户资料、空间和常用操作集中在一个界面。内置 User API 部署会先只读检查 Linux、Docker Compose、资源和端口，再运行固定脚本，并核验健康接口、OpenAPI 与 Swagger。这条专用流程不调用大模型，服务默认只监听服务器本机地址，也不会覆盖已有部署。

独立 User API 升级到 1.2.0，新增带版本校验的加密配置同步，并在改密时原子轮换同步密钥包装。普通 SSH 和 SFTP 仍可脱离远程账户使用。
