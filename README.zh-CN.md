# Termlo

简体中文 · [English](README.md)

![Termlo 标志](assets/termlo.png)

**Termlo，让服务器管理更省心。** 它把熟悉的 SSH/SFTP 桌面工具与智能体结合起来：连接主机、检查环境、讨论方案、执行命令，并核对结果。

Termlo 是面向 Windows 和 macOS 的本地优先应用，桌面端使用 Electron、xterm.js 和 ssh2。日常 SSH 连接不要求注册账户；账户 API 是可选的独立服务。

## 下载与安装

安装文件见 [GitHub Releases](https://github.com/areming/Termlo/releases)。**1.0.0** 面向 Windows x64、macOS Intel 和 macOS Apple Silicon。

| 系统 | 文件 | 验证状态 |
| --- | --- | --- |
| Windows x64 | `Termlo-Setup-1.0.0-x64.exe` | 已在 Windows 构建并验证打包程序；完整安装/卸载仍需在独立环境验收 |
| macOS Intel | `Termlo-1.0.0-x64.dmg` | 已配置 Mac CI 构建；以发布工作流结果为准，并需实机验收 |
| macOS Apple Silicon | `Termlo-1.0.0-arm64.dmg` | 已配置 Mac CI 构建；以发布工作流结果为准，并需实机验收 |

当前安装包没有数字签名。Windows 可能提示“未知发布者”；macOS 的 Gatekeeper 可能拦截未经签名和公证的应用。正式发行的签名、兼容性和验证边界见[发布说明](RELEASING.md)。

## 核心能力

- **SSH 多标签终端**：跳板机链路、服务器指纹核对、主机分组、命令高亮、昼夜主题与便捷复制粘贴。
- **独立 SFTP**：无需先打开终端即可连接文件服务，支持浏览、上传、下载和传输进度。
- **主机概览**：尽可能识别操作系统，连接后展示 CPU、内存、磁盘规格及实时资源信息。
- **智能体工作台**：自填兼容 OpenAI 的接口地址、模型和密钥；先在 Plan 模式讨论，再对一台或多台已选主机自主执行并验收。执行命令可在终端看到，也能打开独立的交互终端手动操作。
- **文件与项目部署**：对话中添加文件或项目 ZIP，让智能体检查资料、规划部署、通过 SSH 传输并汇报精简结果。
- **变更参考**：按主机记录有限状态，按任务记录操作，便于跨会话、跨模型接手。受控文件修改可尝试撤销；需要时可另行配置阿里云 ECS 云盘快照。
- **空间与账户**：按项目空间组织主机，在已知空间间移动或复制；可选连接独立的邮箱密码账户服务。

智能体使用的是所选 SSH 账号的真实权限，远端机器没有系统级沙箱。主机跟踪只提供有限观察，不是整机快照；任意 Shell、软件安装、数据库和多机操作不能保证原子性或自动回滚。执行高影响任务前应确认目标和可用的恢复手段。

## 快速开始

1. 安装 Termlo，添加主机地址、SSH 用户及密码或私钥；首次连接时核对服务器指纹。
2. 打开 SSH 终端，或直接进入独立 SFTP。需要跳板机时，在目标主机编辑页选择已保存的跳板主机。
3. 使用智能体时，在**助手**中填写兼容 OpenAI 的 API 地址、模型和密钥，并选择授权访问的主机。
4. 用 **Plan** 先完善方案，确认后进入执行；在执行终端查看命令和检查结果。

SSH 密码与模型密钥可使用系统提供的加密能力保存。任务文本、所选主机信息与必要的命令输出会发送给你配置的模型服务；本地任务记录不是整体加密数据库。

## 源码运行与构建

需要 Node.js **24.13+** 和 npm：

```sh
npm ci
npm test
npm run start
```

请在目标系统构建安装包：

```sh
npm run dist:win   # Windows x64
npm run dist:mac   # macOS，按当前机器架构
```

推送 `v*` 标签后，[GitHub Actions](.github/workflows/build-installers.yml)会在 Windows、Intel Mac 和 Apple Silicon Mac 上测试与构建，并将成功的安装文件发布到 GitHub Release。[独立账户 API](services/user-api/README.md)有自己的启动说明和 Swagger 文档，不会随桌面安装器自动部署。

## 数据与兼容性

界面名称已改为 Termlo，但为保留既有主机和任务，仍沿用原来的 Termus 数据目录及少量内部标识：

- Windows：`%APPDATA%/Termus/`
- macOS：`~/Library/Application Support/Termus/`
- 源码运行：`data/`

系统加密的凭据不能可靠地跨系统复制；升级前请备份数据。更多实现范围和限制见[功能差异](FEATURE-GAPS.md)、[变更记录](CHANGELOG.md)与[发布说明](RELEASING.md)。

本仓库尚未选择开源许可证。公开源码和安装包本身不代表已授权他人复用或再分发。
