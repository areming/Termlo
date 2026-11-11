# Termlo 2.0.0

Termlo 2.0 is a rebuild. The SSH layer, host storage and security baseline carry over; the assistant kernel and the whole interface are new.

- **Four pages and settings**: hosts, terminal, files and assistant, with a Ctrl+K command palette and dark and light themes.
- **Terminal**: tabs, find, font size, "ask the assistant" on selected output, reconnect with Enter.
- **Files**: browse a server and drop local files to upload; folder transfers, a transfer queue and name-conflict handling.
- **Assistant**: a conversation next to an execution console that shows every command and its output. Only plans, questions, recovery and results ask for a decision. Files must be read before they are changed, and changes can be undone. A result is marked done only when its checks pass. An optional fallback model takes over when the primary model is rate-limited or out of quota.
- **Faster and cheaper**: on the same deployment and repair benchmark with the same free model, the pass rate went from 2/3 to 3/3, tokens from 726k to 170k, and time from 318 s to 134 s.
- **Upgrading from 1.x**: hosts from every space, including signed-in account spaces, are merged into one list with the space name as the group. Fingerprints and model settings move too. Old files are left untouched; 1.x task history is not converted.
- **Removed**: accounts and sync, the User API and its deployment, workspaces, cloud deployment protection, the host ledger, project ZIP analysis and the onboarding tour.

## 中文

Termlo 2.0 是一次重建：保留 SSH 连接层、主机存储和安全基线，助手内核和整个界面重新实现。

- **四个页面加设置**：主机、终端、文件、助手，Ctrl K 命令面板，暗色和亮色主题。
- **终端**：多标签、查找、字号、选中输出后"问助手"、断线后按 Enter 重连。
- **文件**：浏览服务器，拖入本机文件即上传；文件夹传输、传输队列、同名冲突处理。
- **助手**：对话旁边是执行台，每条命令和输出都看得见；只有方案、提问、恢复、结果需要你决定。改文件前必须先读过，改动可撤销；检查项全部通过才算完成。可设置备用模型，主模型限流或额度用完时自动接力。
- **更快更省**：同样的部署和修复基准、同一个免费模型，通过率从 2/3 到 3/3，token 从 72.6 万降到 17.0 万，耗时从 318 秒降到 134 秒。
- **从 1.x 升级**：所有空间（含已登录账户下的空间）的主机合并为一个列表，原空间名变成分组；指纹和模型设置一并迁移。旧文件不改动，1.x 任务历史不迁移。
- **移除**：账户与同步、User API 及其部署、工作空间、云部署保护、主机账本、项目 ZIP 分析、首次引导。
