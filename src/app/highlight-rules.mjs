// Semantic terminal highlights: which parts of a plain-text line deserve a color.
// Only text the server left unstyled is ever highlighted (checked by the caller).

function isIPv4(value) { return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every(part => Number(part) <= 255); }
function isIPv6(value) {
  if (!value.includes(':') || value.length < 3) return false;
  try { return new URL('http://[' + value.split('%')[0] + ']/').hostname.startsWith('['); } catch { return false; }
}

export function matchHighlights(text) {
  const matches = [];
  if (text.length > 8192) return matches;
  const add = (start, end, kind) => {
    if (end <= start || matches.length >= 128 || matches.some(m => start < m.end && end > m.start)) return;
    matches.push({ start, end, kind });
  };

  // A shell prompt followed by a command: color the command word and its flags.
  const prompt = text.match(/^(?:[\w.-]+@[\w.-]+:[^$#%\r\n]*|\[[\w.-]+@[\w.-]+[^\]\r\n]*\]|[~/][^$#%\r\n]*)?[$#%](?:\s+|$)/);
  if (prompt) {
    const who = prompt[0].match(/^\[?([\w.-]+@[\w.-]+)/);
    if (who) add(prompt[0].indexOf(who[1]), prompt[0].indexOf(who[1]) + who[1].length, 'prompt');
    const cwd = prompt[0].match(/:([^$#%\]\s]+)/) || prompt[0].match(/^([~/][^$#%\s]*)/);
    if (cwd) { const at = prompt[0].indexOf(cwd[1], who ? prompt[0].indexOf(who[1]) + who[1].length : 0); add(at, at + cwd[1].length, 'cwd'); }
    const command = text.slice(prompt[0].length);
    const token = command.match(/^(?:[A-Za-z_]\w*=(?:[^\s"']+|"[^"]*"|'[^']*')\s+)*([\w./~+-]+)/);
    if (token) {
      const start = prompt[0].length + token[0].length - token[1].length;
      add(start, start + token[1].length, 'command');
      for (const m of command.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|(?<!\S)--?[A-Za-z][\w-]*/g)) {
        if (m[0].startsWith('-')) add(prompt[0].length + m.index, prompt[0].length + m.index + m[0].length, 'option');
      }
    }
  }

  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"'\x00-\x1f]+/gi)) {
    const value = m[0].replace(/[),.;!?]+$/, '');
    add(m.index, m.index + value.length, 'network');
  }
  for (const m of text.matchAll(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?![\w.])/g)) {
    if (isIPv4(m[0].split(':')[0])) add(m.index, m.index + m[0].length, 'network');
  }
  for (const m of text.matchAll(/(?<![\w:])[\da-f]*:[\da-f:.]+(?:%[\w.-]+)?(?![\w:])/gi)) {
    if (/[\da-f]{1,4}:[\da-f]{0,4}:/i.test(m[0]) && isIPv6(m[0])) add(m.index, m.index + m[0].length, 'network');
  }

  for (const [kind, pattern] of [
    ['error', /\b(?:ERROR|ERR|FATAL|FAIL(?:ED|URE)?|PANIC|DENIED|REFUSED)\b|错误|失败|拒绝/gi],
    ['warning', /\b(?:WARN(?:ING)?|TIMEOUT|TIMED OUT|DEPRECATED)\b|警告/gi],
    ['success', /\b(?:OK|SUCCESS(?:FUL(?:LY)?)?|PASSED)\b|active \(running\)|成功/gi],
  ]) for (const m of text.matchAll(pattern)) add(m.index, m.index + m[0].length, kind);

  for (const m of text.matchAll(/(?<![\w:/\\.])(?:~\/|\.{1,2}\/|\/)[^\s"'<>|;&()[\]{}:]+/g)) {
    const value = m[0].replace(/[.,!?]+$/, '');
    if (value.length > 1) add(m.index, m.index + value.length, 'path');
  }
  return matches.sort((a, b) => a.start - b.start);
}
