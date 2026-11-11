// Draws semantic highlights over the visible part of an xterm buffer using decorations.
// Text the server already styled (colors, inverse, hidden) is never touched.
import { matchHighlights } from './highlight-rules.mjs';

const KINDS = ['prompt', 'cwd', 'network', 'path', 'command', 'option', 'error', 'warning', 'success'];
function palette() {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(KINDS.map(kind => [kind, style.getPropertyValue('--hl-' + kind).trim()]));
}

export class SemanticHighlights {
  constructor(term, enabled = true) {
    this.term = term;
    this.enabled = enabled;
    this.decorations = [];
    this.markers = [];
    this.signature = '';
    this.colors = palette();
    const schedule = () => this.schedule();
    this.listeners = [
      term.onWriteParsed(schedule),
      term.onScroll(schedule),
      term.onResize(() => { this.clear(); schedule(); }),
      term.buffer.onBufferChange(() => { this.clear(); schedule(); }),
    ];
    this.schedule();
  }

  setEnabled(enabled) { this.enabled = enabled; this.clear(); this.schedule(); }
  refreshColors() { this.colors = palette(); this.clear(); this.schedule(); }

  clear() {
    for (const d of this.decorations) d.dispose();
    for (const m of this.markers) m.dispose();
    this.decorations = [];
    this.markers = [];
    this.signature = '';
  }

  schedule() {
    if (this.disposed || this.timer || !this.enabled) return;
    this.timer = setTimeout(() => { this.timer = null; if (!this.disposed) this.render(); }, 80);
  }

  render() {
    const term = this.term, buffer = term.buffer.active;
    if (!this.enabled || buffer.type !== 'normal') return this.clear();
    const first = buffer.viewportY, last = Math.min(buffer.length - 1, first + term.rows - 1);
    // Read the viewport plus up to eight wrapped rows on either side, as logical lines.
    let start = first, end = last;
    while (start > 0 && start > first - 8 && buffer.getLine(start)?.isWrapped) start--;
    while (end + 1 < buffer.length && end < last + 8 && buffer.getLine(end + 1)?.isWrapped) end++;
    const groups = [];
    let group = null, cellsRead = 0, lastRead = start - 1;
    for (let y = start; y <= end && cellsRead < 60000; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      lastRead = y;
      if (!group || !line.isWrapped) { group = { text: '', cells: [], truncated: y === start && line.isWrapped }; groups.push(group); }
      for (let x = 0; x < Math.min(line.length, term.cols); x++) {
        const cell = line.getCell(x);
        cellsRead++;
        if (!cell || cell.getWidth() === 0) continue;
        const chars = cell.getChars() || ' ', offset = group.text.length;
        group.text += chars;
        group.cells.push({ start: offset, end: offset + chars.length, x, y, width: cell.getWidth(),
          plain: cell.isFgDefault() && cell.isBgDefault() && !cell.isInverse() && !cell.isInvisible() });
      }
    }
    if (group && buffer.getLine(lastRead + 1)?.isWrapped) group.truncated = true;

    const spans = [];
    for (const g of groups) {
      if (g.truncated || g.text.length > 8192) continue;
      for (const match of matchHighlights(g.text.trimEnd())) {
        const cells = g.cells.filter(c => c.end > match.start && c.start < match.end);
        if (!cells.length || cells.some(c => !c.plain)) continue;
        let span = null;
        for (const c of cells) {
          if (c.y < first || c.y > last) continue;
          if (span && span.y === c.y && span.x + span.width === c.x) span.width += c.width;
          else { span = { x: c.x, y: c.y, width: c.width, kind: match.kind }; spans.push(span); }
        }
        if (spans.length >= 400) break;
      }
      if (spans.length >= 400) break;
    }

    const signature = JSON.stringify([first, term.cols, term.rows, spans]);
    if (signature === this.signature && this.markers.every(m => !m.isDisposed && m.line === m.expectedLine)) return;
    this.clear();
    this.signature = signature;
    const rows = new Map();
    for (const span of spans) {
      let marker = rows.get(span.y);
      if (!marker) {
        marker = term.registerMarker(span.y - buffer.baseY - buffer.cursorY);
        if (!marker) continue;
        marker.expectedLine = span.y;
        rows.set(span.y, marker);
        this.markers.push(marker);
      }
      const decoration = term.registerDecoration({ marker, x: span.x, width: span.width, foregroundColor: this.colors[span.kind], layer: 'bottom' });
      if (decoration) {
        decoration.onRender(el => { el.dataset.highlight = span.kind; el.style.pointerEvents = 'none'; });
        this.decorations.push(decoration);
      }
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    for (const l of this.listeners) l.dispose();
    this.clear();
  }
}
