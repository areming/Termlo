// Text layout for the terminal assistant: cell widths, single live rows, wrapped lines.
const sgr = (code, text) => `\x1b[${code}m${text}\x1b[0m`;

export function cellWidth(ch) {
  const c = ch.codePointAt(0);
  return c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
    || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || c >= 0x20000) ? 2 : 1;
}

// One live row: [style, text] parts cut to the terminal width, so the live region's height is
// exactly its number of rows and can be redrawn in place.
export function row(width, ...parts) {
  let out = '', used = 0;
  for (const [style, text] of parts) {
    let piece = '';
    for (const ch of String(text).replace(/[\x00-\x1f\x7f]/g, ' ')) {
      const w = cellWidth(ch);
      if (used + w > width - 2) { out += style ? sgr(style, piece + '…') : piece + '…'; return out; }
      piece += ch; used += w;
    }
    out += style ? sgr(style, piece) : piece;
  }
  return out;
}

// The end of a long input line, so the cursor stays visible.
export function tail(text, width) {
  const chars = [...text];
  let used = 0, i = chars.length;
  while (i > 0 && used + cellWidth(chars[i - 1]) <= width) used += cellWidth(chars[--i]);
  return (i > 0 ? '…' : '') + chars.slice(i).join('');
}

// Committed lines wrapped to the terminal width with a hanging indent: a long line continues
// under its own text ("● ", "  ⎿ ", "  1. "), not at column 0. Escape sequences pass through
// (SGR state carries over the line break); Latin text breaks at a space when one is near.
const LEAD = /^(\s*(?:[●◆✔✕!⚠?❯›→$⎿]\s+|\d+\.\s+)?(?:⎿\s+|\$\s+)?)/;
export function hang(text, width) {
  const max = Math.max(20, width) - 1;
  return String(text).split('\r\n').map(line => {
    const visible = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const lead = Math.min([...LEAD.exec(visible)[1]].reduce((n, ch) => n + cellWidth(ch), 0), Math.floor(max / 2));
    const pad = ' '.repeat(lead);
    let out = '', cur = '', used = 0, space = -1, spaceUsed = 0;
    for (let i = 0; i < line.length;) {
      const esc = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(line.slice(i));
      if (esc) { cur += esc[0]; i += esc[0].length; continue; }
      const ch = String.fromCodePoint(line.codePointAt(i));
      i += ch.length;
      const w = cellWidth(ch);
      if (used + w > max) {
        if (space > 0 && used - spaceUsed < 24 && ch !== ' ') {   // carry the last word over
          out += cur.slice(0, space) + '\r\n';
          cur = pad + cur.slice(space + 1).replace(/^ +/, '');
          used = lead + (used - spaceUsed - 1);
        } else {
          out += cur + '\r\n';
          cur = pad; used = lead;
          if (ch === ' ') { space = -1; continue; }
        }
        space = -1;
      }
      if (ch === ' ' && used >= lead) { space = cur.length; spaceUsed = used; }
      cur += ch; used += w;
    }
    return out + cur;
  }).join('\r\n');
}

