# Termlo

<img src="assets/termlo.png" alt="Termlo logo" width="80" height="80">

**SSH / SFTP 桌面客户端，内置一个守规矩的服务器助手。**
终端、文件、助手三件事做好：每一步看得见，改过的文件能撤销，密码和密钥只留在本机。

*A local-first SSH/SFTP desktop client with a constrained server assistant: every step is visible, file changes can be undone, and secrets never leave your machine.*

## 能做什么

- **主机**：卡片或列表，按分组整理；支持密码、私钥和多级跳板机；可从 `~/.ssh/config` 导入。首次连接核对服务器指纹。
- **终端**：多标签、Ctrl F 查找、字号调整；选中输出后右键"问助手"。断线后按 Enter 重连。
- **文件**：浏览服务器目录，把本机文件拖进来就上传；文件夹上传下载、传输队列、同名冲突处理（覆盖 / 跳过 / 保留两者）。
- **助手**：用一句话说目标，选择"先规划"或"直接执行"。左边是对话，右边执行台列出每一步的原始命令和输出。只有方案、提问、恢复、结果这四种情况会弹出卡片让你决定。
  - 改文件前必须先读过同一个文件，改动会自动备份，可以撤销。
  - 结果由检查项说话：有检查没通过，就不会标成"已完成"。
  - 支持任何兼容 OpenAI 的接口；可以设置备用模型，主模型限流或额度用完时自动接力。

## 安全边界

- 助手拥有你所选 SSH 账户的权限，只能操作你为这个任务选中的主机。
- 命令输出会发给你配置的模型服务。密码、私钥和常见令牌在发送前会被隐藏；少于 8 个字符的密码无法可靠隐藏，界面会提示。
- 撤销只覆盖助手通过"修改文件"做的改动；通过命令安装软件、启动服务等操作需要另行检查。
- SSH 密码、私钥口令和模型密钥用系统加密保存在本机，不上传。

## 下载

从 [Releases](https://github.com/areming/Termlo/releases) 下载（Windows x64 / macOS Intel / Apple Silicon，安装包暂未签名）。

从 1.x 升级时，所有空间（包括已登录账户下的空间）里的主机会合并到同一个列表，原空间名变成分组；服务器指纹和模型设置一并迁移。1.x 的助手任务历史不迁移，旧文件保留在数据目录里不动。

## 开发

需要 Node.js 24.13+：

```sh
npm ci
npm test          # 单元测试
npm run test:ui   # Electron 端到端冒烟测试（本地 SSH 夹具 + 脚本化模型）
npm start
```

- 打包：`npm run dist:win` / `npm run dist:mac`（需在对应系统上运行）。推送 `v*` 标签后，GitHub Actions 会构建三个平台的安装包，并以 `RELEASE_NOTES.md` 作为 Release 说明发布。
- 助手基准：`node scripts/bench.cjs`，用真实模型在一台可丢弃的服务器上跑部署和修复任务，结果由服务器上的检查命令判定。配置写在 `~/.config/termlo/bench.env`，不要用生产服务器。
- 本地数据目录为 `Termlo`（2.0.1 及更早版本的 `Termus` 目录会在首次启动时整体改名过来）。

本仓库尚未选择开源许可证。
