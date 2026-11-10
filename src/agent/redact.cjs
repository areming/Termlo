// Redaction for data leaving the trust boundary: server output sent to the model, and
// anything shown in the UI or written to disk. It must never be applied to arguments
// that are about to be executed — that would silently change what runs on the server.

// Secrets shorter than this cannot be replaced literally without corrupting ordinary
// text (a password of "root" would rewrite every "/root" path and nginx "root" directive).
const MIN_LITERAL_LENGTH = 8;

const PATTERNS = [
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[已隐藏私钥]'],
  [/\b(Bearer\s+)[\w.+/=-]{8,}/gi, '$1[已隐藏]'],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,})/g, '[已隐藏令牌]'],
  [/\b([\w-]*?(?:password|passwd|passphrase|pwd|api[_-]?key|access[_-]?key|access[_-]?token|secret[_-]?key|client[_-]?secret))(\s*[:=]\s*)(["']?)[^\s"',;]+\3/gi, '$1$2$3[已隐藏]$3'],
];

function createRedactor(secrets = []) {
  const literal = [...new Set(secrets.filter(s => typeof s === 'string' && s.length >= MIN_LITERAL_LENGTH))]
    .sort((a, b) => b.length - a.length);
  const weak = secrets.some(s => typeof s === 'string' && s.length > 0 && s.length < MIN_LITERAL_LENGTH);

  function text(value) {
    if (typeof value !== 'string' || !value) return value;
    let result = value;
    for (const secret of literal) result = result.split(secret).join('[已隐藏凭据]');
    for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
    return result;
  }

  function deep(value) {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(deep);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item)]));
    return value;
  }

  // weak: at least one credential is too short to be hidden reliably in free-form output.
  return { text, deep, weak };
}

module.exports = { createRedactor, MIN_LITERAL_LENGTH };
