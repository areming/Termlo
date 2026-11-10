# Termlo

<img src="assets/termlo.png" alt="Termlo logo" width="80" height="80">

**让 AI 在你选定的服务器上干活：每一步看得见、有证据、尽量能撤回。**
本地优先的 SSH / SFTP 桌面客户端，内置受约束的服务器智能体。Electron + xterm.js + ssh2。

*A local-first SSH/SFTP desktop client with a constrained server agent that shows every step, proves results with evidence, and keeps changes reversible where it can.*

## 使用

从 [Releases](https://github.com/areming/Termlo/releases) 下载（Windows x64 / macOS Intel / Apple Silicon，安装包暂未签名）。

1. 添加主机，首次连接核对 SSH 指纹；需要跳板时选择已保存的跳板主机。
2. 用终端或 SFTP 直接管理服务器。
3. 在助手中填写兼容 OpenAI 的接口、模型和密钥；选择主机，用 **Plan** 讨论确认后执行，或直接自主执行。

智能体拥有所选 SSH 账户的权限，任务内容和必要输出会发给你配置的模型服务。自由 Shell 无法保证自动回滚，高影响操作前请确认恢复手段。SSH 密码、私钥和模型密钥只保存在本机。

## 开发

需要 Node.js 24.13+：

```sh
npm ci
npm test          # 单元测试
npm run test:ui   # Electron 冒烟测试
npm run start
```

- 打包：`npm run dist:win` / `npm run dist:mac`（需在对应系统上运行）。推送 `v*` 标签后，GitHub Actions 会构建三个平台的安装包，并以 `RELEASE_NOTES.md` 作为 Release 说明发布。
- 可选的账户同步服务见 [services/user-api](services/user-api/README.md)。
- 为兼容旧数据，本地数据目录仍为 `Termus`。
- 产品方向与路线图见 [product/](product/README.md)。

本仓库尚未选择开源许可证。
