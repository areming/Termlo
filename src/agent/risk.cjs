// Risk gate: actions that need the user's explicit "允许" before they run, whatever the mode or
// plan. This is an extra hard stop on top of the guard's invariants, never a replacement.
// A false positive costs one click; a false negative can cost a server, so patterns are broad.
const { createHash } = require('node:crypto');

// Cleaning up its own scratch files in /tmp is routine and needs no click.
const TMP_CLEANUP = /^\s*rm\s+-[a-zA-Z]+(?:\s+\/tmp\/(?!\.\.)[^\s;&|*`$()<>]+)+\s*$/;

const COMMAND_RULES = [
  [/\brm\s+(?:-[a-zA-Z]*[rRf]|--recursive|--force)/, '删除文件或目录'],
  [/\b(?:shred|wipefs|mkfs(?:\.\w+)?|fdisk|sfdisk|parted|lvremove|vgremove|pvremove)\b/, '改动磁盘或文件系统'],
  [/\bdd\b[^|;&]*\bof=/, '直接写入设备或文件'],
  [/>\s*\/dev\/(?:sd|nvme|vd|xvd|hd|mmcblk)/, '直接写入磁盘设备'],
  [/\b(?:shutdown|reboot|poweroff|halt)\b|\binit\s+[06]\b|systemctl\s+(?:reboot|poweroff|halt|kexec)/, '重启或关闭机器'],
  [/\bsystemctl\s+(?:[\w-]+\s+)*(?:stop|restart|disable|mask|kill|isolate)\b/, '停止、重启或禁用服务'],
  [/\bservice\s+\S+\s+(?:stop|restart)\b/, '停止或重启服务'],
  [/\b(?:kill|pkill|killall)\b/, '结束进程'],
  [/\bdocker(?:-compose|\s+compose)?\s+(?:[\w-]+\s+)*(?:rm|rmi|kill|stop|restart|down|prune)\b/, '停止或删除容器、镜像、卷'],
  [/\b(?:kubectl|helm)\s+(?:[\w-]+\s+)*(?:delete|uninstall|drain|scale)\b/, '删除或缩容集群资源'],
  [/\b(?:drop\s+(?:database|schema|table|user)|truncate\s+(?:table\s+)?\w|delete\s+from\s+\w)/i, '删除数据库数据'],
  [/\b(?:flushall|flushdb)\b/i, '清空缓存数据'],
  [/\b(?:iptables|ip6tables|nft|ufw|firewall-cmd)\b/, '改动防火墙'],
  [/(?:^|[;&|(]\s*|\bsudo\s+(?:-\S+\s+)*)(?:useradd|userdel|usermod|groupdel|passwd|chpasswd|visudo)\b/, '改动系统账户或权限'],
  // Writing (not reading) login, permission or mount configuration.
  [/(?:>>?|\btee\b|\bsed\s+(?:-\S+\s+)*-i|\b(?:cp|mv|rm|ln|install|truncate|chmod|chown)\b)[^;&|]*(?:sshd_config|authorized_keys|\/etc\/sudoers|\/etc\/shadow|\/etc\/passwd|\/etc\/fstab)/, '改动登录、权限或挂载配置'],
  [/\b(?:apt|apt-get|yum|dnf|zypper|apk|pacman|snap)\s+(?:[\w-]+\s+)*(?:remove|purge|autoremove|erase|del|-R\w*)\b/, '卸载软件'],
  [/\b(?:chmod|chown|chgrp)\s+(?:-\w*R|--recursive)/, '批量改动权限或属主'],
  [/\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/, '下载脚本并直接执行'],
  [/\bgit\s+(?:reset\s+--hard|clean\s+-\w*f|push\s+[^;&|]*(?:--force|-f\b))/, '丢弃或强制覆盖代码'],
  [/\bcrontab\s+-r\b/, '清空定时任务'],
];

const SENSITIVE_FILES = [
  [/(?:^|\/)(?:sshd_config|authorized_keys)$|^\/etc\/ssh\//, '改动 SSH 登录配置'],
  [/^\/etc\/(?:sudoers(?:\.d\/.*)?|shadow|passwd|group|gshadow)$/, '改动系统账户或权限'],
  [/^\/etc\/(?:fstab|crypttab)$/, '改动磁盘挂载'],
  [/^\/etc\/(?:iptables|nftables|ufw|firewalld)\b|^\/etc\/nftables\.conf$/, '改动防火墙'],
  [/^\/boot\//, '改动启动配置'],
];

// Returns a short Chinese reason when the action needs approval, otherwise null.
function riskOf(name, args) {
  if (name === 'run') {
    const command = String(args.command || '');
    if (TMP_CLEANUP.test(command) && !/\/\.\.(?:\/|\s|$)/.test(command)) return null;
    for (const [pattern, reason] of COMMAND_RULES) if (pattern.test(command)) return reason;
  }
  if (name === 'write_file') {
    const path = String(args.path || '');
    for (const [pattern, reason] of SENSITIVE_FILES) if (pattern.test(path)) return reason;
  }
  return null;
}

// What exactly is being approved: the same tool, host and command (or path and content).
function approvalKey(name, args) {
  const what = name === 'run' ? args.command : args.path + '\n' + createHash('sha256').update(String(args.content ?? '')).digest('hex');
  return JSON.stringify([name, args.hostId || '', what]);
}

module.exports = { riskOf, approvalKey };
