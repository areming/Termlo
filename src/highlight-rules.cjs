const DEFAULT_HIGHLIGHTS = Object.freeze({ enabled: true, network: true, paths: true, commands: true, status: true });
const HIGHLIGHT_COLORS = Object.freeze({ network: '#82b4ff', path: '#77cfce', command: '#a8d98b', option: '#c4a2ee', error: '#ff8d94', warning: '#edc179', success: '#a8d98b' });
function normalizeHighlights(input) {
  return Object.fromEntries(Object.entries(DEFAULT_HIGHLIGHTS).map(([key, value]) => [key, typeof input?.[key] === 'boolean' ? input[key] : value]));
}
function isIPv4(value) { return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every(part => Number(part) <= 255); }
function isIPv6(value) {
  if (!value.includes(':')) return false;
  try { return new URL('http://[' + value.split('%')[0] + ']/').hostname.startsWith('['); } catch { return false; }
}
function matchHighlights(text, input = DEFAULT_HIGHLIGHTS) {
  const settings = normalizeHighlights(input), matches = [];
  if (!settings.enabled || text.length > 8192) return matches;
  function add(start, end, kind) {
    if (end <= start || matches.length >= 128 || matches.some(item => start < item.end && end > item.start)) return;
    matches.push({ start, end, kind });
  }
  if (settings.network) {
    for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"'\x00-\x1f]+/gi)) {
      const value = m[0].replace(/[),.;!?]+$/, '');
      add(m.index, m.index + value.length, 'network');
    }
    for (const m of text.matchAll(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g)) if (isIPv4(m[0])) add(m.index, m.index + m[0].length, 'network');
    for (const m of text.matchAll(/(?<![\w:])[\da-f]*:[\da-f:.]+(?:%[\w.-]+)?(?![\w:])/gi)) if (isIPv6(m[0])) add(m.index, m.index + m[0].length, 'network');
  }
  if (settings.commands) {
    // Conservative prompt recognition, not a shell parser or command validation.
    const prompt = text.match(/^(?:[\w.-]+@[\w.-]+:[^$#%\r\n]*|\[[\w.-]+@[\w.-]+[^\]\r\n]*\]|[~\/][^$#%\r\n]*)?[$#%]\s+/);
    if (prompt) {
      const command = text.slice(prompt[0].length);
      const token = command.match(/^(?:[A-Za-z_]\w*=(?:[^\s"']+|"[^"]*"|'[^']*')\s+)*([\w./~+-]+)/);
      if (token) {
        const start = prompt[0].length + token[0].length - token[1].length;
        add(start, start + token[1].length, 'command');
        // Quoted strings are consumed as a whole, so their flags stay plain.
        for (const m of command.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|(?<!\S)--?[A-Za-z][\w-]*/g)) {
          if (m[0].startsWith('-')) add(prompt[0].length + m.index, prompt[0].length + m.index + m[0].length, 'option');
        }
      }
    }
  }
  if (settings.paths) {
    for (const m of text.matchAll(/(?<![\w:/\\])(?:[A-Za-z]:[\\/]|~\/|\.{1,2}\/|\/)[^\s"'<>|;&()\[\]{}]+/g)) {
      const value = m[0].replace(/[.,!?]+$/, ''); add(m.index, m.index + value.length, 'path');
    }
  }
  if (settings.status) {
    for (const [kind, pattern] of [
      ['error', /\b(?:ERROR|FATAL|FAIL(?:ED|URE)?|PANIC|DENIED)\b/gi],
      ['warning', /\b(?:WARN(?:ING)?|TIMEOUT|TIMED OUT|DEPRECATED)\b/gi],
      ['success', /\b(?:OK|SUCCESS(?:FUL(?:LY)?)?|PASSED)\b/gi],
    ]) for (const m of text.matchAll(pattern)) add(m.index, m.index + m[0].length, kind);
  }
  return matches.sort((a, b) => a.start - b.start);
}
module.exports = { DEFAULT_HIGHLIGHTS, HIGHLIGHT_COLORS, normalizeHighlights, matchHighlights };
