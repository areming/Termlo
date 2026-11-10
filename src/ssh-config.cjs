// Imports hosts from an OpenSSH client config (~/.ssh/config) into Termlo host entries.
//
// Follows OpenSSH semantics where they matter for the result:
// - Keywords are case-insensitive; "Keyword value" and "Keyword=value" both work.
// - For each host, the first value obtained for a keyword wins, scanning blocks
//   in file order. Wildcard blocks (Host *, Host *.corp) therefore provide
//   defaults to concrete hosts but are never imported themselves.
// - Include is expanded in place (relative paths resolve against ~/.ssh, globs
//   are supported, cycles and runaway nesting are refused).
// - ProxyJump "a,b" means: reach b through a, then the target through b.
//
// Passwords are never imported (OpenSSH config has none; nothing password-like
// is read). Match blocks and ProxyCommand are not supported and produce warnings.
//
// The returned hosts use Termlo's host fields (see store.cjs normalizeHost) with
// provisional ids ("ssh-config:<alias>"); jumpHostId refers to those ids. Hosts
// are ordered so every jump host precedes the hosts that use it; the importer
// must save them in that order and remap the provisional ids to the real ones.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeHost, connectionRoute } = require('./store.cjs');

const IMPORT_GROUP = 'SSH config';
const ID_PREFIX = 'ssh-config:';
const MAX_INCLUDE_DEPTH = 16;
const MAX_ROUTE_LENGTH = 5;

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

// Splits arguments on whitespace, honouring double quotes.
function splitArguments(text) {
  const args = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(char)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quoted) return null;
  if (started) args.push(current);
  return args;
}

// Parses one line into { keyword, args } or null for blank/comment lines.
function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = trimmed.match(/^([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+)(.*)$/);
  if (!match) return { keyword: trimmed.toLowerCase(), args: [] };
  const args = splitArguments(match[2]);
  return { keyword: match[1].toLowerCase(), args, invalid: args === null };
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const hasWildcard = value => /[*?]/.test(value);

function wildcardRegExp(pattern, flags = 'i') {
  const source = pattern
    .split('')
    .map(char => (char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[\\^$.|+()[\]{}]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`, flags);
}

// OpenSSH: a block applies when some positive pattern matches and no negated one does.
function blockMatches(block, name) {
  let matched = false;
  for (const { pattern, negated } of block.patterns) {
    if (!wildcardRegExp(pattern).test(name)) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Files and Include
// ---------------------------------------------------------------------------

function expandTilde(value, homeDir) {
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homeDir, value.slice(2));
  return value;
}

// Expands a path that may contain * or ? in any segment. Results are sorted, like glob(3).
function expandGlob(pattern, listDir) {
  if (!hasWildcard(pattern)) return [pattern];
  const resolved = path.resolve(pattern);
  const { root } = path.parse(resolved);
  const segments = resolved.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let candidates = [root];
  for (const segment of segments) {
    const next = [];
    for (const base of candidates) {
      if (!hasWildcard(segment)) {
        next.push(path.join(base, segment));
        continue;
      }
      const matcher = wildcardRegExp(segment, process.platform === 'win32' ? 'i' : '');
      let names = [];
      try {
        names = listDir(base);
      } catch {
        continue;
      }
      for (const name of names.sort()) {
        // Like glob(3), wildcards do not match a leading dot.
        if (name.startsWith('.') && !segment.startsWith('.')) continue;
        if (matcher.test(name)) next.push(path.join(base, name));
      }
    }
    candidates = next;
  }
  return candidates;
}

// Reads the config into a list of blocks:
// { patterns: [{ pattern, negated }], options: [{ keyword, args, file, line }], match? }
function collectBlocks(text, context) {
  const blocks = [{ patterns: [{ pattern: '*', negated: false }], options: [], global: true }];
  let current = blocks[0];

  const readText = (content, file, stack) => {
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const where = { file, line: index + 1 };
      const parsed = parseLine(lines[index]);
      if (!parsed) continue;
      if (parsed.invalid) {
        context.warn('引号不成对，已忽略此行', where);
        continue;
      }
      const { keyword, args } = parsed;
      if (keyword === 'host') {
        if (!args.length) {
          context.warn('Host 后缺少主机名，已忽略此块', where);
          current = { patterns: [], options: [] };
        } else {
          current = {
            patterns: args.map(arg => ({ pattern: arg.replace(/^!/, ''), negated: arg.startsWith('!') })),
            options: [],
            where,
          };
        }
        blocks.push(current);
      } else if (keyword === 'match') {
        context.warn('暂不支持 Match 块，其中的设置已忽略', where);
        current = { patterns: [], options: [], match: true };
        blocks.push(current);
      } else if (keyword === 'include') {
        // Included files continue the current block until they start their own;
        // afterwards the including file's block resumes (as in OpenSSH).
        const resume = current;
        for (const arg of args) includeFile(arg, where, stack);
        current = resume;
        if (current !== blocks.at(-1)) {
          current = { patterns: current.patterns, options: [], where: current.where, match: current.match };
          blocks.push(current);
        }
      } else {
        current.options.push({ keyword, args, ...where });
      }
    }
  };

  const includeFile = (argument, where, stack) => {
    if (stack.length >= MAX_INCLUDE_DEPTH) {
      context.warn(`Include 嵌套超过 ${MAX_INCLUDE_DEPTH} 层，已停止展开`, where);
      return;
    }
    const expanded = expandTilde(argument, context.homeDir);
    const absolute = path.isAbsolute(expanded) ? expanded : path.join(context.sshDir, expanded);
    const files = expandGlob(absolute, context.listDir);
    if (!files.length || (!hasWildcard(absolute) && !context.exists(absolute))) {
      context.warn(`Include 未找到文件：${argument}`, where);
      return;
    }
    for (const file of files) {
      const key = path.resolve(file).toLowerCase();
      if (stack.includes(key)) {
        context.warn(`Include 存在循环引用，已跳过：${file}`, where);
        continue;
      }
      let content;
      try {
        content = context.readFile(file);
      } catch (error) {
        if (error.code !== 'EISDIR') context.warn(`无法读取 Include 文件 ${file}：${error.message}`, where);
        continue;
      }
      readText(content, file, [...stack, key]);
    }
  };

  readText(text, context.file, context.file ? [path.resolve(context.file).toLowerCase()] : []);
  return blocks;
}

// ---------------------------------------------------------------------------
// Host resolution
// ---------------------------------------------------------------------------

// Effective settings for `name`: first value per keyword wins.
function effectiveSettings(blocks, name) {
  const settings = new Map();
  for (const block of blocks) {
    if (!blockMatches(block, name)) continue;
    for (const option of block.options) {
      if (!settings.has(option.keyword)) settings.set(option.keyword, option);
    }
  }
  return settings;
}

// Parses a ProxyJump hop: [user@]host[:port] or ssh://[user@]host[:port].
function parseJumpSpec(spec) {
  let value = spec.trim();
  if (value.startsWith('ssh://')) value = value.slice(6).replace(/\/$/, '');
  const at = value.lastIndexOf('@');
  const user = at >= 0 ? value.slice(0, at) : '';
  let hostPort = at >= 0 ? value.slice(at + 1) : value;
  let host = hostPort;
  let port = '';
  const bracketed = hostPort.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    host = bracketed[1];
    port = bracketed[2] || '';
  } else if ((hostPort.match(/:/g) || []).length === 1) {
    [host, port] = hostPort.split(':');
  }
  if (!host) return null;
  return { user, host, port };
}

function expandTokens(value, values, warn, where) {
  return value.replace(/%(.)/g, (whole, token) => {
    if (token === '%') return '%';
    if (token in values) return values[token];
    warn(`不支持的占位符 ${whole}，已原样保留`, where);
    return whole;
  });
}

function parseSshConfig(text, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const warnings = [];
  const warn = (message, where = {}) => warnings.push({ message, file: where.file || null, line: where.line || null });
  const context = {
    homeDir,
    sshDir: options.sshDir || path.join(homeDir, '.ssh'),
    file: options.file || null,
    warn,
    readFile: options.readFile || (file => fs.readFileSync(file, 'utf8')),
    listDir: options.listDir || (directory => fs.readdirSync(directory)),
    exists: options.exists || (file => fs.existsSync(file)),
  };
  const localUser = options.localUser ?? safeLocalUser();
  const blocks = collectBlocks(String(text ?? ''), context);

  // Concrete aliases, in config order.
  const aliases = [];
  for (const block of blocks) {
    if (block.global || block.match) continue;
    for (const { pattern, negated } of block.patterns) {
      if (negated || hasWildcard(pattern) || aliases.includes(pattern)) continue;
      aliases.push(pattern);
    }
  }

  const entries = new Map(); // id -> host entry
  const order = []; // ids in dependency order (jump hosts first)
  const building = new Set();

  const settingValue = (settings, keyword) => settings.get(keyword)?.args.join(' ');

  // Builds (or reuses) the entry for `name` reached through its own ProxyJump.
  const buildNatural = (name, overrides = {}) => {
    const plain = !overrides.user && !overrides.port;
    const id = plain
      ? ID_PREFIX + name
      : `${ID_PREFIX}${overrides.user ? overrides.user + '@' : ''}${name}${overrides.port ? ':' + overrides.port : ''}`;
    if (entries.has(id)) return entries.get(id);
    if (building.has(id)) throw Object.assign(new Error('cycle'), { cycle: true });
    building.add(id);
    try {
      const settings = effectiveSettings(blocks, name);
      const where = settings.get('hostname') || settings.get('user') || settings.get('port') || {};
      const hostname = expandTokens(settingValue(settings, 'hostname') || name, { h: name }, warn, where);

      const portText = overrides.port || settingValue(settings, 'port') || '22';
      let port = Number(portText);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        warn(`${name}：端口 ${portText} 无效，已使用 22`, settings.get('port'));
        port = 22;
      }

      let username = overrides.user || settingValue(settings, 'user') || '';
      if (!username) {
        username = localUser;
        warn(`${name}：未指定 User，已使用本机用户名 ${localUser || '（空）'}`, where);
      }

      const host = {
        id,
        name: plain ? name : `${overrides.user ? overrides.user + '@' : ''}${name}${overrides.port ? ':' + overrides.port : ''}`,
        address: hostname,
        port,
        username,
        auth: 'password',
        keyPath: '',
        group: IMPORT_GROUP,
        tags: '',
        jumpHostId: '',
      };

      const identity = settings.get('identityfile');
      if (identity && identity.args[0] && identity.args[0].toLowerCase() !== 'none') {
        const tokens = { d: homeDir, u: localUser, h: hostname, r: username, p: String(port), n: name };
        const raw = expandTokens(identity.args[0], tokens, warn, identity);
        const expanded = expandTilde(raw, homeDir);
        host.auth = 'key';
        host.keyPath = path.isAbsolute(expanded) ? path.normalize(expanded) : path.join(homeDir, expanded);
        if (!context.exists(host.keyPath)) warn(`${name}：私钥文件不存在 ${host.keyPath}`, identity);
      }

      if (settings.has('proxycommand') && !settings.has('proxyjump')) {
        const command = settingValue(settings, 'proxycommand');
        if (command.toLowerCase() !== 'none') warn(`${name}：暂不支持 ProxyCommand，已按直连导入`, settings.get('proxycommand'));
      }

      const proxyJump = settings.get('proxyjump');
      if (proxyJump) {
        const value = proxyJump.args.join('');
        if (value.toLowerCase() !== 'none') {
          try {
            host.jumpHostId = resolveChain(value, proxyJump, name);
          } catch (error) {
            if (!error.cycle) throw error;
            warn(`${name}：ProxyJump 存在循环引用，已忽略跳板设置`, proxyJump);
          }
        }
      }

      entries.set(id, host);
      order.push(id);
      return host;
    } finally {
      building.delete(id);
    }
  };

  // Entry for `name` that must be reached via `via` (a jump host id).
  const buildVia = (name, overrides, via) => {
    const natural = buildNatural(name, overrides);
    if (via === undefined || natural.jumpHostId === via) return natural;
    const id = `${natural.id}|via:${via}`;
    if (entries.has(id)) return entries.get(id);
    const viaName = entries.get(via)?.name || via;
    const variant = { ...natural, id, name: `${natural.name} (经 ${viaName})`, jumpHostId: via };
    entries.set(id, variant);
    order.push(id);
    return variant;
  };

  // Resolves "a,b,c" into the id of the last hop, wiring each hop through the previous one.
  const resolveChain = (value, where, owner) => {
    let previous;
    for (const spec of value.split(',')) {
      const hop = parseJumpSpec(spec);
      if (!hop || hasWildcard(hop.host)) {
        warn(`${owner}：无法解析跳板 ${spec}`, where);
        return '';
      }
      // A hop naming a config alias (without user/port) reuses that alias's entry;
      // other hops become entries of their own, still picking up matching Host patterns.
      previous = buildVia(hop.host, { user: hop.user, port: hop.port }, previous?.id);
    }
    return previous ? previous.id : '';
  };

  for (const alias of aliases) {
    try {
      buildNatural(alias);
    } catch (error) {
      if (!error.cycle) throw error;
    }
  }

  // Validate against Termlo's own rules; drop invalid hosts and anything routed through them.
  let hosts = order.map(id => entries.get(id));
  const rejected = new Set();
  for (const host of hosts) {
    try {
      normalizeHost(host);
    } catch (error) {
      warn(`${host.name}：${error.message}，未导入`);
      rejected.add(host.id);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const host of hosts) {
      if (rejected.has(host.id)) continue;
      const valid = hosts.filter(entry => !rejected.has(entry.id));
      try {
        const route = connectionRoute(valid, host.id);
        if (route.length > MAX_ROUTE_LENGTH) throw new Error('最多支持 4 级跳板机');
      } catch (error) {
        warn(`${host.name}：${error.message}，未导入`);
        rejected.add(host.id);
        changed = true;
      }
    }
  }
  hosts = hosts.filter(host => !rejected.has(host.id));
  return { hosts, warnings };
}

function safeLocalUser() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || '';
  }
}

// Reads ~/.ssh/config (or options.file) and parses it.
function readSshConfig(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const file = options.file || path.join(homeDir, '.ssh', 'config');
  let text;
  try {
    text = (options.readFile || (target => fs.readFileSync(target, 'utf8')))(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { hosts: [], warnings: [{ message: `未找到 SSH 配置文件：${file}`, file, line: null }] };
    }
    throw error;
  }
  return parseSshConfig(text, { ...options, homeDir, file });
}

module.exports = {
  IMPORT_GROUP,
  ID_PREFIX,
  parseSshConfig,
  readSshConfig,
  parseJumpSpec,
  splitArguments,
};
