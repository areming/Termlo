# Termlo 2.0.3

- **See the assistant think**: while the model reasons, the assistant shows "思考中… N 秒" and the latest line of its reasoning (passwords hidden, never saved in the task). The first visible feedback now arrives in about 2 seconds instead of about 6.
- The assistant asks before stopping or deleting processes, containers or files that the task did not create.
- More accurate reports: checks only state whether the goal was met. When some checks are only unverified, the headline says so instead of "failed". Risks and disruptive checks that were skipped (such as rebooting) go in the summary.
- The assistant no longer reads shell history or other unrelated files while troubleshooting, and always explains in Chinese.
- Three real troubleshooting scenarios added to the benchmark (broken systemd unit, old log cleanup, port held by a leftover process); all 9 scenarios pass.

## 中文

- **看得见助手在想什么**：模型思考时，界面显示"思考中… N 秒"和一行最新的思考内容（会隐藏密码，不保存进任务记录）。首个可见反馈从 6 秒左右提前到 2 秒左右。
- 助手要停止或删除不是本任务创建的进程、容器、文件时，会先问你。
- 报告更准确：验收项只写目标是否达成；只有"未验证"的项时，标题如实写"未验证"而不是"未通过"。发现的风险和没做的中断性验证（如重启主机）写在总结里。
- 助手排查时不再翻看 shell 历史等与任务无关的文件，说明和报告统一用中文。
- 基准新增 3 个真实排障场景：systemd 服务起不来、清理旧日志、端口被遗留进程占用。9 个场景全部通过。
