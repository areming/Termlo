const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { parseSample, deriveSample, HostMonitor, MONITOR_COMMAND } = require('../src/host-monitor.cjs');

const sample = ({ user = 100, idle = 900, uptime = 1000, rx = 1000, tx = 500, avail = 6 * 1048576 } = {}) => [
  'STAT', `cpu  ${user} 0 0 ${idle} 0 0 0 0 0 0`,
  'UPTIME', `${uptime}.00 4000.00`,
  'LOAD', '0.42 0.30 0.20 1/200 1234',
  'MEM', 'MemTotal:       8388608 kB', `MemAvailable:   ${avail} kB`,
  'NET', 'Inter-|   Receive', ' face |bytes', `  eth0: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0`, '    lo: 99 0 0 0 0 0 0 0 99 0 0 0 0 0 0 0',
  `docker0: 5000 0 0 0 0 0 0 0 5000 0 0 0 0 0 0 0`,
  'DISK', 'Filesystem 1024-blocks Used Available Capacity Mounted on', '/dev/sda1 100000 25000 75000 25% /',
  'END', '',
].join('\n');

test('a sample parses memory, disk, load and interfaces (loopback and docker bridges skipped)', () => {
  const s = parseSample(sample());
  assert.equal(s.memory.total, 8 * 1024 ** 3);
  assert.equal(s.memory.used, 2 * 1024 ** 3);
  assert.equal(s.disk.percent, 25);
  assert.equal(s.load, 0.42);
  assert.deepEqual(Object.keys(s.interfaces), ['eth0']);
  assert.throws(() => parseSample('UNSUPPORTED\n'), /不支持/);
  assert.match(MONITOR_COMMAND, /TERMLO_METRICS_V1/);
});

test('two samples give CPU percent and network rates; a single sample gives none', () => {
  const first = parseSample(sample());
  const second = parseSample(sample({ user: 150, idle: 1050, uptime: 1005, rx: 6000, tx: 1500 }));
  assert.equal(deriveSample(first, null).cpu, null);
  const d = deriveSample(second, first);
  assert.equal(d.cpu, 25);
  assert.deepEqual(d.network, { rx: 1000, tx: 200 });
  assert.equal(d.memory.percent, 25);
});

test('the monitor samples only while a session is open and reports offline after the last one closes', async () => {
  const events = [];
  let reads = 0;
  const monitor = new HostMonitor({
    interval: 20,
    notify: e => events.push(e.metrics.status),
    read: async () => sample({ user: 100 + 50 * reads, idle: 900 + 150 * reads, uptime: 1000 + 5 * reads++ }),
  });
  const ssh = Object.assign(new EventEmitter(), { connected: true, closed: false });
  monitor.attach('h1', ssh);
  monitor.attach('h1', ssh);   // same session twice: one listener
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.ok(events.includes('live'));
  assert.equal(monitor.snapshot()[0].cpu, 25);
  ssh.emit('status', 'closed');
  const after = reads;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(reads, after, 'no sampling after the session closed');
  assert.equal(events.at(-1), 'offline');
  monitor.close();
});
