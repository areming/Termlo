# Termlo 2.0.2

- **One name everywhere**: the local data folder moves from `Termus` to `Termlo` on first launch. The whole folder is renamed in one step, so hosts, tasks and saved passwords come along; if the rename fails, the old folder keeps working and the move is retried next time.
- Files the assistant leaves on servers (undo backups, attachment staging, temporary files) now use a `termlo-` prefix. Undo and cleanup still work for tasks from 2.0.1 and earlier.
- The Windows installer keeps its previous identity and upgrades the installed version in place.

## 中文

- **统一改名为 Termlo**：本地数据目录在首次启动时从 `Termus` 改名为 `Termlo`。整个文件夹一次改名，主机、任务和保存的密码都随之迁移；改名失败时继续使用旧目录，下次启动再试。
- 助手在服务器上留下的文件（撤销备份、附件暂存、临时文件）改用 `termlo-` 前缀；2.0.1 及更早的任务仍可撤销和清理。
- Windows 安装包保持原有安装标识，直接覆盖升级。
