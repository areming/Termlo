# Termlo 3.0.0

SSH / SFTP 桌面客户端，内置一个守规矩的服务器助手。第一个正式版本。

*A local-first SSH/SFTP desktop client with a constrained server assistant. First formal release.*

## 能做什么

- **在终端里直接问**：命令行输入 `# 一句话` 回车，助手就在这个终端里查看、思考、动手、验证。需要你决定时用 ↑↓ 选择、↵ 确认；回答后可以接着问，Esc 把 shell 原样还给你。选中一段输出右键"问 AI"交给它看。
- **助手页**：问题直接回答；改动大的先给方案，点"执行方案"后自己做完，逐项报告验收结果。最多 4 个对话同时进行，按主机归类。
- **危险操作先问你**：删数据、停止或重启服务、重启机器、改防火墙 / SSH / 账户、卸载软件、下载脚本直接执行，会先给出确切命令，你允许才执行，只放行这一次。
- **改过的文件能撤销**：助手改文件前必须先读过，改动自动备份；结果由检查项说话，有检查没通过就不会标成"已完成"。
- **主机**：卡片或列表，分组、拖动排序；在线主机显示实时 CPU、内存、磁盘、网速；密码、私钥、多级跳板机（最多 4 级）；可从 `~/.ssh/config` 导入；首次连接核对服务器指纹。
- **终端**：多标签、查找、语义高亮、实时状态栏、断线按 Enter 重连。
- **文件**：拖进来就上传，文件夹上传下载，传输队列，同名冲突处理。
- **桌面**：关闭后留在托盘、只运行一个实例、Ctrl K 搜索、深浅两套主题、第一次打开有三步上手引导、顶栏 ? 是使用说明、自动检查新版本。
- **模型**：任何兼容 OpenAI 的接口（OpenRouter、DeepSeek、OpenAI、本机 Ollama…），可设置备用模型，主模型限流时自动接力。

## 安全边界

- 助手拥有你所选 SSH 账户的权限，只能操作这次对话选中的主机；它用自己的连接执行命令，不会往你的终端里敲字。
- 命令输出（以及你交给它的终端内容）会发给你配置的模型服务；密码、私钥和常见令牌在发送前会被隐藏。少于 8 个字符的密码无法可靠隐藏，会提示你。
- SSH 密码、私钥口令和模型密钥用系统加密保存在本机，不上传。

## 安装

- Windows x64：`Termlo-Setup-3.0.0-x64.exe`。如果提示"已保护你的电脑"，点"更多信息" → "仍要运行"（安装包暂未签名）。
- macOS（Intel / Apple Silicon）：`.dmg`。如果提示"无法打开"，在访达里右键 Termlo → "打开"。
- 从旧版本升级：直接安装即可，主机、密码、指纹、模型设置和对话都会保留。1.x 的主机和设置会自动迁移。

## English

- **Ask in the terminal**: type `# what you want` at the prompt and press Enter. The assistant looks around, thinks, acts and verifies right in that terminal; decisions are keyboard menus; Esc hands your shell back untouched.
- **Assistant page**: questions are answered directly; bigger changes come as a plan first, then run to the end with every check reported. Up to 4 conversations at once, grouped by host.
- **Risky actions wait for you**: deleting data, stopping services, rebooting, firewall / SSH / account changes, uninstalling and piping downloaded scripts stop with the exact command; allowing runs exactly that once.
- **Undoable file changes**, evidence-based results, live host metrics, multi-hop jump hosts, `~/.ssh/config` import, SFTP drag and drop, tray, two themes, a three-step first-run guide, in-app help and an update check.
- Any OpenAI-compatible endpoint, with a fallback model.
- Secrets stay on your machine (OS encryption); passwords, keys and common tokens are hidden before output reaches the model.
- Installers are not signed yet: on Windows choose "More info" → "Run anyway"; on macOS right-click → Open.
