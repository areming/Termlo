# Termlo 2.0.1

- **Fixed**: in the host list view, clicking anywhere on the page opened a terminal. Row actions are now always visible.
- **Groups**: rename a group (renaming to an existing name merges them) or ungroup it from the group bar; move a host with "Move to group…".
- **Settings** has a safety section: what the assistant can do, what is sent to the model, what can be undone and where secrets are kept.
- **Fixed**: undoing the assistant's file changes left the backups in /tmp on the server. They are now removed once the original is restored and verified.
- **Assistant**: a revised plan no longer keeps the previous plan's questions, and the model is told when a file write drops the final newline.

## 中文

- **修复**：主机页切到列表视图后，点页面任何地方都会打开终端。列表行的快捷按钮改为常显。
- **分组管理**：选中分组后可"管理分组"，重命名（改成已有名称即合并）或解散；主机菜单新增"移到分组…"。
- **设置页**新增"安全说明"：助手能做什么、什么会发给模型、什么能撤销、密钥保存在哪。
- **修复**：撤销助手的文件改动后，服务器 /tmp 下的备份不会被删除。现在撤销校验通过后立即删除。
- **助手**：修改后的方案不再残留上一版的问题；写文件漏掉末尾换行时会提示模型。
