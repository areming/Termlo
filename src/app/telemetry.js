// Live host telemetry in the renderer: keeps the last five minutes per host (memory only)
// and draws it as small SVG instruments. Updates patch [data-telemetry] blocks in place so a
// sample every few seconds never re-renders a page, steals focus or resets hover.
import { html, raw, bytes, $$ } from './ui.js';

const WINDOW = 60;   // samples kept (5 minutes at one sample every 5 seconds)

export function createTelemetry(app) {
  const latest = new Map();    // hostId -> metrics
  const history = new Map();   // hostId -> [{ cpu, mem }]
  const listeners = new Set();

  function accept(metrics) {
    if (!metrics?.hostId) return;
    latest.set(metrics.hostId, metrics);
    if (metrics.status === 'offline') history.delete(metrics.hostId);
    if (metrics.status === 'live' && metrics.cpu !== null && metrics.cpu !== undefined) {
      const points = history.get(metrics.hostId) || [];
      points.push({ cpu: metrics.cpu, mem: metrics.memory?.percent ?? null });
      if (points.length > WINDOW) points.shift();
      history.set(metrics.hostId, points);
    }
    for (const listener of listeners) listener(metrics.hostId);
  }

  app.on('host-metrics', event => accept(event.metrics));

  return {
    accept,
    get: hostId => latest.get(hostId) || null,
    history: hostId => history.get(hostId) || [],
    // live or still taking the first sample: the host has an open connection
    online: hostId => ['live', 'sampling', 'unavailable'].includes(latest.get(hostId)?.status),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    // Re-render every telemetry block for this host inside root.
    patch(root, hostId) {
      for (const block of $$(`[data-telemetry="${CSS.escape(hostId)}"]`, root)) {
        block.innerHTML = view(block.dataset.variant, this.get(hostId), this.history(hostId)).value;
      }
    },
  };
}

// ---- formatting ----------------------------------------------------------------------
export const percent = value => Number.isFinite(value) ? `${value >= 10 ? Math.round(value) : value.toFixed(1)}%` : '—';
export const rate = value => Number.isFinite(value) ? `${bytes(value)}/s` : '—';
export function uptime(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`;
}

// ---- instruments -----------------------------------------------------------------------
// The top of the CPU chart: at least 25%, otherwise a round number above the recent peak,
// so a quiet server still shows its movement instead of a line on the floor.
export function scaleTop(values) {
  const peak = Math.max(0, ...values.filter(Number.isFinite));
  if (peak * 1.3 <= 25) return 25;
  if (peak * 1.3 <= 50) return 50;
  return 100;
}

// A filled trend line of 0–top values. Fewer than two points draws a flat baseline.
export function sparkline(values, { width = 240, height = 44, kind = 'cpu', label = '', top = 100 } = {}) {
  const pts = values.filter(Number.isFinite);
  // The window grows from one minute to five, so a new connection fills the chart quickly.
  const slots = Math.max(12, Math.min(WINDOW, pts.length));
  const step = width / (slots - 1);
  const offset = (slots - pts.length) * step;   // new samples enter from the right
  const y = v => (height - 2) - (Math.max(0, Math.min(top, v)) / top) * (height - 6);
  const coords = pts.map((v, i) => [offset + i * step, y(v)]);
  if (coords.length === 1) coords.unshift([Math.max(0, offset - step), coords[0][1]]);
  let line = '', area = '';
  if (coords.length) {
    line = coords.map(([x, yy], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${yy.toFixed(1)}`).join(' ');
    area = `${line} L${coords.at(-1)[0].toFixed(1)} ${height} L${coords[0][0].toFixed(1)} ${height} Z`;
  }
  const [lx, ly] = coords.at(-1) || [width, height - 2];
  return raw(`<svg class="spark" data-kind="${kind}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${label}">
    <defs><linearGradient id="g-${kind}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="spark-stop-top"/><stop offset="1" class="spark-stop-bottom"/></linearGradient></defs>
    <line class="spark-grid" x1="0" x2="${width}" y1="${y(top / 2)}" y2="${y(top / 2)}"/>
    ${area ? `<path class="spark-area" d="${area}" fill="url(#g-${kind})"/><path class="spark-line" d="${line}"/>` : `<line class="spark-base" x1="0" x2="${width}" y1="${height - 2}" y2="${height - 2}"/>`}
    ${coords.length ? `<circle class="spark-head" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.5"/>` : ''}
  </svg>`);
}

// A small ring gauge for a percentage.
export function ring(value, kind) {
  const r = 15, c = 2 * Math.PI * r;
  const filled = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) / 100 * c : 0;
  return raw(`<svg class="ring" data-kind="${kind}" viewBox="0 0 36 36" aria-hidden="true">
    <circle class="ring-track" cx="18" cy="18" r="${r}"/>
    <circle class="ring-fill" cx="18" cy="18" r="${r}" stroke-dasharray="${filled.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 18 18)"/>
  </svg>`);
}

// ---- views -----------------------------------------------------------------------------
const level = value => !Number.isFinite(value) ? '' : value >= 90 ? 'critical' : value >= 75 ? 'high' : '';

export function view(variant, metrics, points) {
  if (!metrics || metrics.status === 'offline') return html``;
  if (metrics.status === 'unavailable') return html`<p class="tm-note">这台主机不支持实时状态（需要 Linux 的 /proc）</p>`;
  const cpu = metrics.cpu, mem = metrics.memory?.percent, disk = metrics.disk?.percent;
  const net = metrics.network;
  const waiting = metrics.status === 'sampling' || !Number.isFinite(cpu);
  if (variant === 'bar') {
    return html`
      <span class="tm-item tm-cpu" data-level="${level(cpu)}" title="CPU 使用率">
        ${sparkline(points.map(p => p.cpu), { width: 96, height: 18, kind: 'cpu', label: 'CPU 近 5 分钟', top: scaleTop(points.map(p => p.cpu)) })}
        <span class="tm-key">CPU</span><span class="tm-val">${waiting ? '…' : percent(cpu)}</span>
      </span>
      <span class="tm-item" data-level="${level(mem)}" title="内存 ${metrics.memory ? bytes(metrics.memory.used) + ' / ' + bytes(metrics.memory.total) : ''}">
        ${ring(mem, 'mem')}<span class="tm-key">内存</span><span class="tm-val">${percent(mem)}</span>
      </span>
      <span class="tm-item" data-level="${level(disk)}" title="根分区 ${metrics.disk ? bytes(metrics.disk.used) + ' / ' + bytes(metrics.disk.total) : ''}">
        ${ring(disk, 'disk')}<span class="tm-key">磁盘</span><span class="tm-val">${percent(disk)}</span>
      </span>
      <span class="tm-item tm-net" title="网络（不含本机回环和容器网桥）">
        <span class="tm-key">↓</span><span class="tm-val">${rate(net?.rx)}</span>
        <span class="tm-key">↑</span><span class="tm-val">${rate(net?.tx)}</span>
      </span>
      ${metrics.uptime ? html`<span class="tm-item tm-uptime" title="系统运行时长"><span class="tm-key">运行</span><span class="tm-val">${uptime(metrics.uptime)}</span></span>` : ''}`;
  }
  // card
  const cpuPoints = points.map(p => p.cpu);
  const top = scaleTop(cpuPoints);
  return html`
    <div class="tm-chart" data-level="${level(cpu)}">
      <div class="tm-chart-head"><span class="tm-key">CPU</span><span class="tm-big">${waiting ? '…' : percent(cpu)}</span>
        ${Number.isFinite(metrics.load) ? html`<span class="tm-aside" title="1 分钟平均负载">负载 ${metrics.load.toFixed(2)}</span>` : ''}</div>
      <div class="tm-plot">
        ${sparkline(cpuPoints, { kind: 'cpu', label: `CPU 近 5 分钟走势，纵轴上限 ${top}%`, top })}
        <span class="tm-scale" aria-hidden="true">${top}%</span>
      </div>
    </div>
    <div class="tm-stats">
      <span class="tm-stat" data-level="${level(mem)}" title="${metrics.memory ? bytes(metrics.memory.used) + ' / ' + bytes(metrics.memory.total) : ''}">${ring(mem, 'mem')}<span><span class="tm-key">内存</span><span class="tm-val">${percent(mem)}</span></span></span>
      <span class="tm-stat" data-level="${level(disk)}" title="${metrics.disk ? bytes(metrics.disk.used) + ' / ' + bytes(metrics.disk.total) : ''}">${ring(disk, 'disk')}<span><span class="tm-key">磁盘</span><span class="tm-val">${percent(disk)}</span></span></span>
      <span class="tm-stat tm-net"><span class="tm-key">↓ ${rate(net?.rx)}</span><span class="tm-key">↑ ${rate(net?.tx)}</span></span>
    </div>`;
}
