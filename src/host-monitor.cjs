// Live host metrics for hosts the user already has open (a terminal or a files tab).
// Sampling reuses that SSH connection: one read-only exec of /proc and df every few seconds.
// No connection is ever opened just for monitoring, and nothing is written to disk.
const MONITOR_COMMAND = [
  '# TERMLO_METRICS_V1',
  "if [ ! -r /proc/stat ] || [ ! -r /proc/meminfo ]; then printf 'UNSUPPORTED\\n'; exit 0; fi",
  'LC_ALL=C; export LC_ALL',
  "printf 'STAT\\n'; head -n 1 /proc/stat",
  "printf 'UPTIME\\n'; cat /proc/uptime",
  "printf 'LOAD\\n'; cat /proc/loadavg",
  "printf 'MEM\\n'; cat /proc/meminfo",
  "printf 'NET\\n'; cat /proc/net/dev",
  "printf 'DISK\\n'; df -Pk /",
  "printf 'END\\n'",
].join('\n');

const SECTIONS = ['STAT', 'UPTIME', 'LOAD', 'MEM', 'NET', 'DISK', 'END'];
const number = s => /^\d+(?:\.\d+)?$/.test(s || '') ? Number(s) : null;

function parseSample(raw) {
  const text = '\n' + String(raw).replace(/\r/g, '');
  const section = name => {
    const after = text.split('\n' + name + '\n')[1];
    if (after === undefined) return '';
    return after.split(new RegExp(`\\n(?:${SECTIONS.join('|')})\\n`))[0];
  };
  const cpu = section('STAT').trim().split(/\s+/);
  if (cpu.shift() !== 'cpu' || cpu.length < 4) throw new Error('此主机暂不支持 Linux 监控');
  const counters = cpu.slice(0, 8).map(number);
  if (counters.some(n => n === null)) throw new Error('CPU 采样无效');

  const uptime = number(section('UPTIME').trim().split(/\s+/)[0]);
  const load = number(section('LOAD').trim().split(/\s+/)[0]);
  const mem = Object.fromEntries([...section('MEM').matchAll(/^(\w+):\s+(\d+) kB$/gm)].map(m => [m[1], Number(m[2]) * 1024]));
  const memory = mem.MemTotal > 0 && Number.isFinite(mem.MemAvailable)
    ? { total: mem.MemTotal, used: Math.max(0, Math.min(mem.MemTotal, mem.MemTotal - mem.MemAvailable)) }
    : null;

  const interfaces = {};
  for (const line of section('NET').split('\n')) {
    const match = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!match || match[1] === 'lo' || /^(docker|veth|br-|virbr)/.test(match[1])) continue;
    const values = match[2].trim().split(/\s+/);
    const rx = number(values[0]), tx = number(values[8]);
    if (rx !== null && tx !== null) interfaces[match[1]] = { rx, tx };
  }

  const row = section('DISK').split('\n').map(line => line.trim().split(/\s+/)).find(r => r.at(-1) === '/' && r.length >= 6);
  const disk = row && [row[1], row[2], row[3]].every(s => number(s) !== null)
    ? { total: Number(row[1]) * 1024, used: Number(row[2]) * 1024, percent: Math.min(100, Number(row[4].replace('%', ''))) }
    : null;

  return { cpu: { total: counters.reduce((a, b) => a + b, 0), idle: counters[3] + (counters[4] || 0) }, uptime, load, memory, interfaces, disk };
}

// Turn two consecutive samples into rates (CPU %, network bytes per second).
function deriveSample(current, previous) {
  let cpu = null, network = null;
  const elapsed = previous && current.uptime - previous.uptime;
  if (previous && elapsed > 0 && elapsed <= 60) {
    const total = current.cpu.total - previous.cpu.total, idle = current.cpu.idle - previous.cpu.idle;
    if (total > 0 && idle >= 0 && idle <= total) cpu = Math.round(1000 * (1 - idle / total)) / 10;
    const names = Object.keys(current.interfaces).filter(n => previous.interfaces[n]);
    const deltas = names.map(n => ({ rx: current.interfaces[n].rx - previous.interfaces[n].rx, tx: current.interfaces[n].tx - previous.interfaces[n].tx }));
    if (names.length && deltas.every(d => d.rx >= 0 && d.tx >= 0)) {
      network = { rx: deltas.reduce((n, d) => n + d.rx, 0) / elapsed, tx: deltas.reduce((n, d) => n + d.tx, 0) / elapsed };
    }
  }
  return {
    cpu,
    load: current.load,
    uptime: current.uptime,
    memory: current.memory ? { ...current.memory, percent: Math.round(1000 * current.memory.used / current.memory.total) / 10 } : null,
    disk: current.disk,
    network,
  };
}

function readSample(ssh, timeout = 4000) {
  return new Promise((resolve, reject) => {
    let stream = null, finished = false, text = '', exit = null;
    const done = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ssh.client.off('close', closed);
      try { stream?.close(); } catch {}
      error ? reject(error) : resolve(text);
    };
    const closed = () => done(new Error('连接已断开'));
    const timer = setTimeout(() => done(new Error('监控采样超时')), timeout);
    ssh.client.once('close', closed);
    try {
      ssh.client.exec(MONITOR_COMMAND, (error, channel) => {
        if (error) return done(error);
        if (finished) return channel.close();
        stream = channel;
        channel.on('data', chunk => { text += chunk; if (text.length > 65536) done(new Error('采样输出过长')); });
        channel.stderr.on('data', () => {});
        channel.on('exit', code => { exit = code; });
        channel.on('error', done);
        channel.on('close', () => done(exit === 0 || exit === null ? null : new Error('主机拒绝监控采样')));
      });
    } catch (error) { done(error); }
  });
}

class HostMonitor {
  constructor({ notify = () => {}, interval = 5000, read = readSample } = {}) {
    this.notify = notify;
    this.interval = interval;
    this.read = read;
    this.hosts = new Map();   // hostId -> { sessions, previous, value, timer, busy }
    this.stopped = false;
  }

  snapshot() { return [...this.hosts.values()].map(h => h.value); }

  emit(host) { this.notify({ type: 'host-metrics', metrics: host.value }); }

  attach(hostId, ssh) {
    if (this.stopped) return;
    let host = this.hosts.get(hostId);
    if (!host) {
      host = { id: hostId, sessions: new Set(), previous: null, value: { hostId, status: 'sampling', updatedAt: null }, timer: null, busy: false };
      this.hosts.set(hostId, host);
    }
    if (host.sessions.has(ssh)) return;
    host.sessions.add(ssh);
    const onStatus = status => {
      if (status !== 'closed') return;
      ssh.off('status', onStatus);
      host.sessions.delete(ssh);
      if (!host.sessions.size) {
        clearTimeout(host.timer);
        host.timer = null;
        host.previous = null;
        host.value = { hostId, status: 'offline', updatedAt: null };
        this.emit(host);
      }
    };
    ssh.on('status', onStatus);
    if (!host.timer && !host.busy) {
      host.value = { ...host.value, status: 'sampling' };
      this.emit(host);
      host.timer = setTimeout(() => this.poll(host), 300);   // let the shell open first
    }
  }

  async poll(host) {
    host.timer = null;
    if (host.busy || this.stopped || !host.sessions.size) return;
    host.busy = true;
    const ssh = [...host.sessions].find(s => s.connected && !s.closed);
    try {
      if (!ssh) throw new Error('连接已断开');
      const raw = parseSample(await this.read(ssh));
      if (!host.sessions.has(ssh)) return;
      host.value = { hostId: host.id, status: 'live', updatedAt: Date.now(), ...deriveSample(raw, host.previous) };
      host.previous = raw;
    } catch {
      host.previous = null;
      if (host.sessions.size) host.value = { hostId: host.id, status: 'unavailable', updatedAt: null };
    } finally {
      host.busy = false;
      if (host.sessions.size) {
        this.emit(host);
        // A first sample has no rates yet: take the second one quickly.
        const delay = host.value.status === 'unavailable' ? 30000 : host.value.cpu === null ? 1500 : this.interval;
        if (!this.stopped) host.timer = setTimeout(() => this.poll(host), delay);
      }
    }
  }

  close() {
    this.stopped = true;
    for (const host of this.hosts.values()) clearTimeout(host.timer);
  }
}

module.exports = { MONITOR_COMMAND, parseSample, deriveSample, readSample, HostMonitor };
