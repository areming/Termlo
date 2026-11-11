// One-time migration from 1.x data. Read-only towards the old files: nothing is deleted,
// so 1.x can still open the same directory if the user goes back.
//
// 2.0 has no accounts or spaces, so every host the user could see in 1.x must end up in
// the single host list:
// - <root>/hosts.json (the local default space) is the base and is kept as-is.
// - Every other space found on disk is merged in: local spaces (<root>/spaces/<id>) and
//   spaces of signed-in or signed-out accounts (<root>/accounts/<account>/spaces/<id>).
//   Disk is scanned rather than workspaces.json, which can miss orphaned spaces.
// - The space (and account) name becomes the host's group.
// - A host already present with the same address, port, user and jump route is skipped.
// - Known host fingerprints are merged; an existing entry wins.
// - Model settings move from <root>/assistant/settings.json to <root>/agent/settings.json.
// - 1.x task history is not converted (different format); it stays on disk untouched.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const atomicFile = require('./atomic-file.cjs');

const MARKER = 'migration-2.json';
const ID = /^[a-f0-9-]{36}$/;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    atomicFile.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

const subdirectories = directory => {
  try { return fs.readdirSync(directory, { withFileTypes: true }).filter(d => d.isDirectory() && ID.test(d.name)).map(d => d.name); }
  catch { return []; }
};

// Every non-default space on disk, with a readable group name.
function findSpaces(root, workspaces) {
  const accounts = new Map((workspaces?.accounts || []).map(a => [a.id, a]));
  const spaceName = (account, id) => account?.spaces?.find(s => s.id === id)?.name;
  const spaces = [];
  for (const id of subdirectories(path.join(root, 'spaces'))) {
    spaces.push({ directory: path.join(root, 'spaces', id), group: spaceName(accounts.get('local'), id) || '本地项目' });
  }
  for (const accountId of subdirectories(path.join(root, 'accounts'))) {
    const account = accounts.get(accountId);
    for (const id of subdirectories(path.join(root, 'accounts', accountId, 'spaces'))) {
      const name = spaceName(account, id);
      const group = [account?.name, name].filter(Boolean).join(' · ') || '账户项目';
      spaces.push({ directory: path.join(root, 'accounts', accountId, 'spaces', id), group });
    }
  }
  return spaces;
}

function migrate(root) {
  const marker = path.join(root, MARKER);
  if (fs.existsSync(marker)) return null;   // already migrated on an earlier launch
  const report = { version: 2, at: new Date().toISOString(), hosts: 0, duplicates: 0, knownHosts: 0, settings: false, spaces: 0 };

  const hostFile = path.join(root, 'hosts.json');
  const data = readJson(hostFile) || { version: 1, hosts: [], knownHosts: {} };
  data.hosts ||= [];
  data.knownHosts ||= {};
  const workspaces = readJson(path.join(root, 'workspaces.json'));

  for (const space of findSpaces(root, workspaces)) {
    const source = readJson(path.join(space.directory, 'hosts.json'));
    if (!source) continue;
    report.spaces++;
    const hosts = source.hosts || [];
    // Old ids are remapped so a jump host keeps pointing at its (possibly deduplicated) target.
    const ids = new Map();
    const identity = (host, jumpHostId) => JSON.stringify([String(host.address).toLowerCase(), Number(host.port), host.username, jumpHostId || '']);
    // Jump hosts first, at any depth: take a host once its jump host has been placed.
    const known = new Set(hosts.map(h => h.id));
    const ordered = [];
    let pending = [...hosts];
    while (pending.length) {
      const ready = pending.filter(h => !h.jumpHostId || !known.has(h.jumpHostId) || ordered.some(o => o.id === h.jumpHostId));
      const batch = ready.length ? ready : pending;   // a cycle: place the rest as they are
      ordered.push(...batch);
      pending = pending.filter(h => !batch.includes(h));
    }
    for (const host of ordered) {
      const jumpHostId = host.jumpHostId ? ids.get(host.jumpHostId) || '' : '';
      const existing = data.hosts.find(h => identity(h, h.jumpHostId) === identity(host, jumpHostId));
      if (existing) { ids.set(host.id, existing.id); report.duplicates++; continue; }
      const id = randomUUID();
      ids.set(host.id, id);
      const group = !host.group || host.group === '未分组' ? space.group : `${space.group} · ${host.group}`;
      data.hosts.push({ ...host, id, group: group.slice(0, 200), jumpHostId });
      report.hosts++;
    }
    for (const [key, fingerprint] of Object.entries(source.knownHosts || {})) {
      if (!(key in data.knownHosts)) { data.knownHosts[key] = fingerprint; report.knownHosts++; }
    }
  }
  if (report.hosts || report.knownHosts) writeJson(hostFile, data);

  const oldSettings = readJson(path.join(root, 'assistant', 'settings.json'));
  const newSettings = path.join(root, 'agent', 'settings.json');
  if (oldSettings?.baseUrl && !fs.existsSync(newSettings)) {
    const { baseUrl, model, encryptedKey } = oldSettings;
    writeJson(newSettings, { baseUrl, model: model || '', maxRounds: 60, ...(encryptedKey ? { encryptedKey } : {}) });
    report.settings = true;
  }

  writeJson(marker, report);
  return report.hosts || report.knownHosts || report.settings ? report : null;
}

module.exports = { migrate, MARKER };
