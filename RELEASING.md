# Termlo 构建与发布

## 项目文件

仓库根目录包含桌面源码 `src/`、图标 `assets/`、构建脚本 `scripts/`、测试 `test/`、独立的 `services/user-api/`、中英文 README 和 GitHub Actions 工作流。运行 `npm ci` 后即可在 Node.js 24.13+ 上构建。`node scripts/export-source.cjs` 会生成可单独复制到新 Git 仓库的 `git-ready/Termlo-<版本>/`；它不包含依赖、安装包、测试数据、缓存或本地账户信息。需要公开授权他人使用、修改源码时，请在发布前自行选择并添加 LICENSE；当前项目没有默认授予开源许可证。

## 构建

| 平台 | 命令 | 输出 | 当前验证 |
| --- | --- | --- | --- |
| Windows x64 | `npm ci`、`npm test`、`npm run dist:win` | `release/<版本>/Termlo-Setup-<版本>-x64.exe` | 本机成功生成 NSIS，打包程序桌面流程通过；完整安装/卸载待隔离虚拟机验证 |
| macOS Intel | 在 Intel Mac 上运行 `npm ci`、`npm test`、`npm run dist:mac` | `release/<版本>/Termlo-<版本>-x64.dmg` | GitHub Actions 构建配置，待 Mac 执行结果 |
| macOS Apple Silicon | 在 Apple Silicon Mac 上运行相同命令 | `release/<版本>/Termlo-<版本>-arm64.dmg` | GitHub Actions 构建配置，待 Mac 执行结果 |

GitHub Actions 的 **Build installers** 工作流在推送 `v*` 标签或手动触发时，分别在 Windows、Intel Mac 和 Apple Silicon Mac 上测试、构建并上传工作流构件。推送标签且三个构建全部成功后，会按 `RELEASE_NOTES.md` 自动建立 GitHub Release 并附上三个安装文件；手动运行只生成工作流构件。若某平台失败，不会发布不完整的版本，先修复并重新运行。源码由 Git 仓库提供。不要把 `node_modules/`、`release/`、`test-output/`、`data/`、`.cache/`、`artifacts/` 或 `git-ready/` 提交到仓库。

## 签名与兼容性边界

Windows 安装器采用当前用户安装，可选安装目录，不要求管理员权限。没有代码签名证书时 Windows 可能显示未知发布者警告。macOS 的 DMG 需要在 Mac 构建；用于公开直接下载时，应使用 Apple Developer ID 签名并完成 Apple 公证，否则 Gatekeeper 可能阻止正常打开。[Electron 签名文档](https://www.electronjs.org/docs/latest/tutorial/code-signing) 和 [electron-builder v26 DMG 文档](https://www.electron.build/v26/docs/dmg/) 说明了发行要求。当前仓库未配置签名密钥，不应在 Git 中保存证书或密码。

显示名称已改为 Termlo，但本机数据目录和内部设置键继续使用旧的 Termus 标识，以保留现有主机、空间与任务。旧 Windows 用户升级前先退出旧程序；新安装版仍读取 `%APPDATA%/Termus/`。macOS 使用 `~/Library/Application Support/Termus/`。这不是跨操作系统的凭据迁移：系统加密的密码、令牌和密钥口令不能直接从 Windows 拷到 Mac，迁移时需重新输入。SSH、SFTP 和助手的跨平台核心代码保持一致；macOS 的 Keychain、文件选择、剪贴板、Intel/Apple Silicon 安装及运行仍需在真实 Mac 验收。用户 API 是独立服务，不随桌面安装器自动部署。
