const MAX_CLIPBOARD_TEXT = 256 * 1024;
function validateText(text) {
  if (typeof text !== 'string') throw new Error('剪贴板内容必须是文本');
  if (text.length > MAX_CLIPBOARD_TEXT) throw new Error('文本超过 26 万字符，请分段复制粘贴');
  return text;
}
function preparePaste(value, trimFinalNewline = false) {
  const original = validateText(value).replace(/\r\n?/g, '\n');
  // Keep text, tabs and line breaks; never forward pasted escape/control bytes.
  let text = original.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
  const removed = original.length - text.length;
  const review = removed > 0 || /[\n\t]/.test(text) || text.length > 4000;
  if (trimFinalNewline) text = text.replace(/\n+$/, '');
  return { text, removed, review };
}
module.exports = { MAX_CLIPBOARD_TEXT, validateText, preparePaste };
