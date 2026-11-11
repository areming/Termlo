// One-time migration from 1.x data. Read-only towards the old files: nothing is deleted,
// so 1.x can still open the same directory if the user goes back.
//
// - The default space already lives in <root>/hosts.json and is used as-is.
// - Hosts from other local spaces are merged in; the space name becomes their group.
// - Known host fingerprints are merged (existing entries win).
// - Model settings move from <root>/assistant/settings.json to <root>/agent/settings.json.
// - Spaces of signed-in remote accounts are not merged (they belong to that account).
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const atomicFile = require('./atomic-file.cjs');

const MARKER = 'migration-2.json';

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

function migrate(root) {
  const marker = path.join(root, MARKER);
  if (fs.existsSync(marker)) return null;   // already migrated on an earlier launch
  const report = { version: 2, at: new Date().toISOString(), hosts: 0, knownHosts: 0, settings: false, skippedAccounts: 0 };

  const hostFile = path.join(root, 'hosts.json');
  const data = readJson(hostFile) || { version: 1, hosts: [], knownHosts: {} };
  const workspaces = readJson(path.join(root, 'workspaces.json'));

  for (const account of workspaces?.accounts || []) {
    if (account.id !== 'local') { report.skippedAccounts++; continue; }
    for (const space of account.spaces || []) {
      if (space.id === 'default' || !/^[a-f0-9-]{36}$/.test(space.id)) continue;
      const source = readJson(path.join(root, 'spaces', space.id, 'hosts.json'));
      if (!source?.hosts?.length && !source?.knownHosts) continue;
      const ids = new Map((source.hosts || []).map(host => [host.id, randomUUID()]));
      const group = String(space.name || '项目').slice(0, 60);
      for (const host of source.hosts || []) {
        data.hosts.push({
          ...host,
          id: ids.get(host.id),
          group: !host.group || host.group === '未分组' ? group : `${group} · ${host.group}`.slice(0, 200),
          jumpHostId: host.jumpHostId ? ids.get(host.jumpHostId) || '' : '',
        });
        report.hosts++;
      }
      for (const [key, fingerprint] of Object.entries(source.knownHosts || {})) {
        if (!(key in data.knownHosts)) { data.knownHosts[key] = fingerprint; report.knownHosts++; }
      }
    }
  }
  if (report.hosts || report.knownHosts) writeJson(hostFile, data);

  const oldSettings = readJson(path.join(root, 'assistant', 'settings.json'));
  const newSettings = path.join(root, 'agent', 'settings.json');
  if (oldSettings?.baseUrl && !fs.existsSync(newSettings)) {
    const { baseUrl, model, encryptedKey } = oldSettings;
    writeJson(newSettings, { baseUrl, model, maxRounds: 60, ...(encryptedKey ? { encryptedKey } : {}) });
    report.settings = true;
  }

  writeJson(marker, report);
  return report.hosts || report.knownHosts || report.settings ? report : null;
}

module.exports = { migrate, MARKER };
