// Main-process interlock. Reservations include connection setup, not only open PTYs.
class ManualControl {
  constructor() { this.sessions = new Map(); }
  reserve(id, task, hostId) {
    if (!task.hostIds.includes(hostId)) throw new Error('主机不在当前任务范围内');
    if (this.sessions.has(id) || [...this.sessions.values()].some(s => s.hostId === hostId)) throw new Error('此主机已有手动终端');
    this.sessions.set(id, {taskId:task.id, hostId});
  }
  release(id) { this.sessions.delete(id); }
  assertFree() { if (this.sessions.size) throw new Error('请先关闭执行台中的手动终端，再继续助手任务'); }
}
module.exports = { ManualControl };
