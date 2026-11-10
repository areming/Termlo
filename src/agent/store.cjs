// Settings and task persistence. One file per task; ordinary updates are coalesced,
// while state that crash recovery depends on is written immediately (save(task, true)).
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const atomicFile = require('../atomic-file.cjs');

const MAX_TASKS = 200;
const COALESCE_MS = 300;
const now = () => new Date().toISOString();

function writeJson(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    atomicFile.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

class TaskStore {
  constructor(directory, vault) {
    this.vault = vault;
    this.directory = path.join(directory, 'agent');
    this.taskDirectory = path.join(this.directory, 'tasks');
    fs.mkdirSync(this.taskDirectory, { recursive: true });
    this.settingsFile = path.join(this.directory, 'settings.json');
    this.settings = readJson(this.settingsFile, { baseUrl: '', model: '', maxRounds: 60 });
    this.tasks = [];
    this.dirty = new Set();
    this.timer = null;
    for (const name of fs.readdirSync(this.taskDirectory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const task = readJson(path.join(this.taskDirectory, name), null);
      if (task?.id) this.tasks.push(task);
    }
    this.tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ---- settings -------------------------------------------------------------
  publicSettings() {
    const { encryptedKey, ...settings } = this.settings;
    return { ...settings, hasKey: !!encryptedKey };
  }

  key() {
    return this.settings.encryptedKey ? this.vault.decryptString(Buffer.from(this.settings.encryptedKey, 'base64')) : '';
  }

  configure(input) {
    const baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '');
    let url;
    try { url = new URL(baseUrl); } catch { throw new Error('API 地址格式无效'); }
    if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('API 地址格式无效');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('远程模型接口请使用 HTTPS，本机接口可使用 HTTP');
    const model = String(input.model || '').trim();
    if (!model || model.length > 200) throw new Error('请填写模型名称');
    const maxRounds = Number(input.maxRounds || 60);
    if (!Number.isInteger(maxRounds) || maxRounds < 5 || maxRounds > 300) throw new Error('单次运行的模型调用上限应为 5–300');
    const next = { baseUrl, model, maxRounds };
    // A stored key is never forwarded to a different endpoint.
    if (baseUrl === this.settings.baseUrl && !input.clearKey) next.encryptedKey = this.settings.encryptedKey;
    if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
      if (!this.vault.isEncryptionAvailable()) throw new Error('系统加密不可用，无法保存 API 密钥');
      if (input.apiKey.length > 8192) throw new Error('API 密钥无效');
      next.encryptedKey = this.vault.encryptString(input.apiKey.trim()).toString('base64');
    }
    if (!next.encryptedKey) delete next.encryptedKey;
    writeJson(this.settingsFile, next);
    this.settings = next;
    return this.publicSettings();
  }

  // ---- tasks ----------------------------------------------------------------
  get(id) {
    const task = this.tasks.find(t => t.id === id);
    if (!task) throw new Error('任务不存在');
    return task;
  }

  create({ prompt, hostIds, mode }) {
    if (this.tasks.length >= MAX_TASKS) throw new Error(`任务已达 ${MAX_TASKS} 个，请删除不需要的历史任务`);
    const task = {
      id: randomUUID(), title: prompt.replace(/\s+/g, ' ').slice(0, 40), prompt, hostIds, mode,
      status: 'idle', notice: '', createdAt: now(), updatedAt: now(),
      rounds: 0, tokens: 0, model: '',
      messages: [{ role: 'user', content: prompt }],
      events: [], followups: [], operations: [], fileChanges: [], stagingChanges: [], attachments: [],
      proposal: null, approvedPlan: null, interaction: null, report: null,
    };
    this.tasks.unshift(task);
    this.save(task, true);
    return task;
  }

  save(task, immediate = false) {
    task.updatedAt = now();
    this.dirty.add(task.id);
    if (immediate) return this.flush();
    if (!this.timer) this.timer = setTimeout(() => this.flush(), COALESCE_MS);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const id of this.dirty) {
      const task = this.tasks.find(t => t.id === id);
      if (task) writeJson(path.join(this.taskDirectory, `${id}.json`), task);
    }
    this.dirty.clear();
  }

  remove(id) {
    this.get(id);
    this.tasks = this.tasks.filter(t => t.id !== id);
    this.dirty.delete(id);
    fs.rmSync(path.join(this.taskDirectory, `${id}.json`), { force: true });
  }

  // AgentAttachments compatibility: it stores its index next to the tasks.
  read(file, fallback) { return readJson(path.join(this.directory, file), fallback); }
  write(file, data) { writeJson(path.join(this.directory, file), data); }
}

module.exports = { TaskStore, now };
