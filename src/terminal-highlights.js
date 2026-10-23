import { HIGHLIGHT_COLORS, normalizeHighlights, matchHighlights } from './highlight-rules.cjs';
const LIGHT_HIGHLIGHTS={network:'#215eb3',path:'#007679',command:'#397021',option:'#7848a2',error:'#b72f40',warning:'#8e610e',success:'#397021'};
const colors=()=>document.documentElement.dataset.theme==='light'?LIGHT_HIGHLIGHTS:HIGHLIGHT_COLORS;

export const TERMINAL_THEME = {
  background: '#0e1216', foreground: '#c9d1dd', cursor: '#a7ecd0', cursorAccent: '#0e1216',
  selectionBackground: '#38536b', selectionForeground: '#ffffff',
  black: '#1c222c', red: '#ed9292', green: '#9cdbac', yellow: '#dfc78e', blue: '#88b8e8', magenta: '#c3a2df', cyan: '#8fcec6', white: '#c9d1dd',
  brightBlack: '#8491a3', brightRed: '#ffacac', brightGreen: '#b8edb5', brightYellow: '#f5dc9e', brightBlue: '#aacdff', brightMagenta: '#d8b8f3', brightCyan: '#b0e6df', brightWhite: '#eff3f8',
};

export class SemanticHighlights {
  constructor(term, settings) {
    this.term = term; this.settings = normalizeHighlights(settings); this.decorations = []; this.markers = [];
    this.visible = true; this.disposed = false; this.signature = '';
    const schedule = () => this.schedule();
    this.listeners = [term.onWriteParsed(schedule), term.onScroll(schedule), term.onResize(() => { this.clear(); schedule(); }), term.buffer.onBufferChange(() => { this.clear(); schedule(); })];
    this.schedule();
  }
  configure(settings) { this.settings = normalizeHighlights(settings); this.clear(); this.schedule(); }
  setVisible(visible) {
    if (this.visible === visible) return;
    this.visible = visible;
    if (!visible) this.clear(); else this.schedule();
  }
  clear() {
    for (const decoration of this.decorations) decoration.dispose();
    for (const marker of this.markers) marker.dispose();
    this.decorations = []; this.markers = []; this.signature = '';
  }
  schedule() {
    if (this.disposed || this.timer || !this.visible || !this.settings.enabled) return;
    this.timer = setTimeout(() => { this.timer = null; if (!this.disposed) this.render(); }, 80);
  }
  render() {
    const term = this.term, buffer = term.buffer.active;
    if (!this.visible || !this.settings.enabled || buffer.type !== 'normal') { this.clear(); return; }
    const first = buffer.viewportY, last = Math.min(buffer.length - 1, first + term.rows - 1);
    // Only inspect the viewport and up to eight wrapped rows on either side.
    let start = first, end = last;
    while (start > 0 && start > first - 8 && buffer.getLine(start)?.isWrapped) start--;
    while (end + 1 < buffer.length && end < last + 8 && buffer.getLine(end + 1)?.isWrapped) end++;
    const groups = [];
    let group, cellsRead = 0, lastRead = start - 1;
    for (let y = start; y <= end && cellsRead < 60000; y++) {
      const line = buffer.getLine(y); if (!line) continue;
      lastRead = y;
      if (!group || !line.isWrapped) { group = { text: '', cells: [], truncated: y === start && line.isWrapped }; groups.push(group); }
      for (let x = 0; x < Math.min(line.length, term.cols); x++) {
        const cell = line.getCell(x); cellsRead++;
        if (!cell || cell.getWidth() === 0) continue;
        const chars = cell.getChars() || ' ', offset = group.text.length;
        group.text += chars;
        group.cells.push({ start: offset, end: offset + chars.length, x, y, width: cell.getWidth(), plain: cell.isFgDefault() && cell.isBgDefault() && !cell.isInverse() && !cell.isInvisible() });
      }
    }
    if (group && buffer.getLine(lastRead + 1)?.isWrapped) group.truncated = true;
    const spans = [];
    for (const group of groups) {
      // Skip giant/incomplete logical lines rather than guessing at token boundaries.
      if (group.truncated || group.text.length > 8192) continue;
      for (const match of matchHighlights(group.text.trimEnd(), this.settings)) {
        const cells = group.cells.filter(cell => cell.end > match.start && cell.start < match.end);
        // Respect remote ANSI styling for the whole token, including hidden text.
        if (!cells.length || cells.some(cell => !cell.plain)) continue;
        let span;
        for (const cell of cells) {
          if (cell.y < first || cell.y > last) continue;
          if (span && span.y === cell.y && span.x + span.width === cell.x) span.width += cell.width;
          else { span = { x: cell.x, y: cell.y, width: cell.width, kind: match.kind }; spans.push(span); }
        }
        if (spans.length >= 400) break;
      }
      if (spans.length >= 400) break;
    }
    const signature = JSON.stringify([first, term.cols, term.rows, spans]);
    if (signature === this.signature && this.markers.every(marker => !marker.isDisposed && marker.line === marker.expectedLine)) return;
    this.clear(); this.signature = signature;
    const rowMarkers = new Map();
    for (const span of spans.slice(0, 400)) {
      let marker = rowMarkers.get(span.y);
      if (!marker) {
        marker = term.registerMarker(span.y - buffer.baseY - buffer.cursorY);
        if (!marker) continue;
        marker.expectedLine = span.y; rowMarkers.set(span.y, marker); this.markers.push(marker);
      }
      const decoration = term.registerDecoration({ marker, x: span.x, width: span.width, foregroundColor: colors()[span.kind], layer: 'bottom' });
      if (decoration) {
        decoration.onRender(element => { element.dataset.highlight = span.kind; element.style.pointerEvents = 'none'; });
        this.decorations.push(decoration);
      }
    }
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); for (const listener of this.listeners) listener.dispose(); this.clear(); }
}

export function highlightPreferences({ state, showError }) {
  const key = 'termus.terminal.highlights.v1';
  let settings;
  try { settings = normalizeHighlights(JSON.parse(localStorage.getItem(key))); } catch { settings = normalizeHighlights(); }
  const dialog = document.querySelector('#highlight-dialog');
  const controls = [...dialog.querySelectorAll('[data-highlight-setting]')];
  const refresh = () => {
    for (const control of controls) {
      control.checked = settings[control.dataset.highlightSetting];
      control.disabled = control.dataset.highlightSetting !== 'enabled' && !settings.enabled;
    }
    document.querySelector('#terminal-highlights').classList.toggle('highlight-on', settings.enabled);
    const toggle = document.querySelector('#terminal-highlight-toggle');
    toggle.textContent = settings.enabled ? '智能高亮' : '原始配色';
    toggle.setAttribute('aria-pressed', String(settings.enabled));
    toggle.classList.toggle('highlight-on', settings.enabled);
    document.querySelector('#terminal-highlights').title = settings.enabled ? '语义高亮已开启 · 调整高亮规则' : '语义高亮已关闭 · 调整高亮规则';
    for (const element of dialog.querySelectorAll('[data-color]')) element.style.color = settings.enabled ? colors()[element.dataset.color] : '';
  };
  for (const control of controls) control.addEventListener('change', () => {
    settings = { ...settings, [control.dataset.highlightSetting]: control.checked };
    try { localStorage.setItem(key, JSON.stringify(settings)); } catch { showError('高亮设置暂时无法保存，本次仍然生效'); }
    for (const session of state.sessions.values()) session.highlights?.configure(settings);
    refresh();
  });
  document.querySelector('#terminal-highlights').addEventListener('click', () => { refresh(); dialog.showModal(); });
  document.querySelector('#terminal-highlight-toggle').addEventListener('click', () => {
    settings = { ...settings, enabled: !settings.enabled };
    try { localStorage.setItem(key, JSON.stringify(settings)); } catch { showError('高亮设置暂时无法保存，本次仍然生效'); }
    for (const session of state.sessions.values()) session.highlights?.configure(settings);
    refresh();
    state.sessions.get(state.active)?.term.focus();
  });
  dialog.addEventListener('close', () => { if (state.view === 'terminal') state.sessions.get(state.active)?.term.focus(); });
  refresh();
  return { current: () => settings, updateVisibility: () => { for (const session of state.sessions.values()) session.highlights?.setVisible(state.view === 'terminal' && session.id === state.active); } };
}
