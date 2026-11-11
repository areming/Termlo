# Termlo 2.5.0

Everything since 2.1.3.

- **The assistant works inside the terminal.** Type `# what you want` at the prompt and press Enter: the assistant looks around, thinks, acts and verifies right in that terminal. Decisions (risky commands, plans, questions) are keyboard menus (↑↓, Enter, number keys). Ask follow-ups, or press Esc to get your shell back exactly as it was. Select output and right-click "问 AI" to hand it over.
- **One conversation, no modes.** Questions are answered directly; bigger changes come as a plan first, and "执行方案" runs it to the end with every check reported.
- **Risky actions wait for you.** Deleting data, stopping or restarting services, rebooting, firewall / SSH / account changes, uninstalling software and piping downloaded scripts to a shell stop with the exact command. Allowing runs exactly that command once. Viewing the firewall is no longer gated.
- **Several conversations at once** (up to 4). Changes to the same host queue up; after one conversation changes a host, the others look again before acting. Conversations are grouped by host.
- **Multi-hop jump hosts** (up to 4 levels), with the whole route shown.
- **Update check**: installed builds look for a new release twice a day and tell you; download it from the release page. Can be turned off in Settings.
- Enter sends, Shift+Enter adds a line.
- Fixes: the terminal's last line hid under the status bar; dark edges around the light terminal; jump host menu could not be clicked in the host dialog; menus spilling over the navigation; invisible delete buttons; grey menu text. A short host password is pointed out once (and in the host dialog), not in every conversation.

## 中文

自 2.1.3 以来的全部改动。

- **助手直接在终端里工作**：命令行输入 `# 一句话` 回车，助手就在这个终端里查看、思考、动手、验证。需要你决定的（危险操作、方案、提问）都是键盘菜单（↑↓、↵、数字键）。可以接着问，Esc 把 shell 原样还给你。选中输出右键"问 AI"交给它看。
- **一个对话，不分模式**：问题直接回答；改动大的先给方案，点"执行方案"后它自己做完并逐项报告验收结果。
- **危险操作先问你**：删数据、停止或重启服务、重启机器、改防火墙 / SSH / 账户、卸载软件、下载脚本直接执行，会先停下给出确切命令，允许后只原样执行这一次。只是查看防火墙不再需要确认。
- **多个对话同时进行**（最多 4 个）：同一台主机上的改动排队；一个对话改过主机后，其他对话动手前会重新查看现场。对话按主机归类。
- **多级跳板机**（最多 4 级），显示完整路径。
- **检查更新**：安装版每天检查两次有没有新版本，有就提醒，到发布页下载；设置里可以关掉。
- Enter 发送，Shift+Enter 换行。
- 修复：终端最后一行被状态栏遮住；浅色终端四周黑边；主机弹框里跳板机下拉点不动；菜单伸进导航栏；删除按钮看不见；菜单文字发灰。主机密码太短时只提醒一次（以及在主机弹框里当场提示），不再每个对话都提醒。
