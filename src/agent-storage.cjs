const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const now = () => new Date().toISOString();
const { interrupted } = require('./agent-ledger.cjs');
class AgentStorage {
  constructor(directory, vault, settingsDirectory) {
    this.directory = path.join(directory, 'assistant'); this.vault = vault;
    fs.mkdirSync(this.directory, { recursive: true });
    this.settingsDirectory = settingsDirectory || this.directory;
    fs.mkdirSync(this.settingsDirectory, { recursive: true });
    const settingsFile = path.join(this.settingsDirectory, 'settings.json');
    this.settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : { baseUrl: '', model: '', maxRounds: 80 };
    this.tasks = this.read('tasks.json', []); this.memory = this.read('memory.json', []);
    for (const task of this.tasks) { interrupted(task); if (task.status === 'running') { for(const terminal of task.terminals||[])if(terminal.activeJobs){terminal.status='interrupted';terminal.activeJobs=0;} task.status = 'paused'; task.notice = '应用曾中断。继续前需核实远端状态，未完成操作不会自动重放。'; } }
    this.commitTasks();
  }
  read(file, fallback) { const full = path.join(this.directory, file); return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : fallback; }
  write(file, data) {
    const full = path.join(file === 'settings.json' ? this.settingsDirectory : this.directory, file), temp = full + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 }); fs.renameSync(temp, full); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  publicSettings() { const { encryptedKey, ...settings } = this.settings; return { ...settings, hasKey: !!encryptedKey }; }
  key() { return this.settings.encryptedKey ? this.vault.decryptString(Buffer.from(this.settings.encryptedKey, 'base64')) : ''; }
  configure(input) {
    const baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '');
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('API 地址格式无效');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('远程模型接口请使用 HTTPS，本机接口可使用 HTTP');
    const model = String(input.model || '').trim(); if (!model || model.length > 200) throw new Error('请填写模型名称');
    const maxRounds = Number(input.maxRounds || 80); if (!Number.isInteger(maxRounds) || maxRounds < 5 || maxRounds > 300) throw new Error('每轮任务预算应为 5–300 次模型调用');
    const next = { baseUrl, model, maxRounds };
    // Changing providers must not silently forward an existing key to a new endpoint.
    if (baseUrl === this.settings.baseUrl && !input.clearKey) next.encryptedKey = this.settings.encryptedKey;
    if ((this.settings.needsApiKey || (this.settings.encryptedKey && baseUrl !== this.settings.baseUrl)) && !String(input.apiKey || '').trim() && !input.clearKey) next.needsApiKey = true;
    if (input.apiKey) {
      if (!this.vault.isEncryptionAvailable()) throw new Error('系统加密不可用，无法保存 API 密钥');
      if (typeof input.apiKey !== 'string' || input.apiKey.length > 8192) throw new Error('API 密钥无效');
      if (input.apiKey.trim()) next.encryptedKey = this.vault.encryptString(input.apiKey.trim()).toString('base64');
      else delete next.encryptedKey;
    }
    this.write('settings.json', next); this.settings = next; return this.publicSettings();
  }
  commitTasks() { this.write('tasks.json', this.tasks); }
  get(id) { const task = this.tasks.find(t => t.id === id); if (!task) throw new Error('任务不存在'); return task; }
  create(prompt, hostIds, mode) {
    if (this.tasks.length >= 100) throw new Error('任务已达 100 个，请删除不需要的历史任务');
    const task = { id: randomUUID(), title: prompt.slice(0, 38), prompt, hostIds, mode, createdAt: now(), updatedAt: now(), status: 'paused', rounds: 0, tokens: 0, checkpoint: '', plan: [], messages: [{ role: 'user', content: prompt }], events: [], notice: '' };
    this.tasks.unshift(task); this.commitTasks(); return task;
  }
  save(task) { task.updatedAt = now(); this.commitTasks(); }
  remove(id) { this.get(id); this.tasks = this.tasks.filter(t => t.id !== id); this.commitTasks(); }
  remember({ hostId, title, content, source, taskId, evidenceId, kind = 'observation' }) {
    const record = { id: randomUUID(), hostId: hostId || null, title: String(title).slice(0, 200), content: String(content).slice(0, 12000), source: String(source).slice(0, 1000), taskId, evidenceId, kind, observedAt: now() };
    // Keep history: an observation is dated evidence, not a silently replaced fact.
    this.memory.unshift(record); this.memory = this.memory.slice(0, 1500); this.write('memory.json', this.memory); return record;
  }
  search(query, hostIds, limit = 12) {
    const terms = String(query || '').toLowerCase().match(/[a-z0-9_./:-]+|[\u3400-\u9fff]{1,2}/g) || [];
    return this.memory.filter(row => !row.hostId || hostIds.includes(row.hostId)).map(row => {
      const content = (row.title + ' ' + row.content + ' ' + row.source).toLowerCase();
      return { ...row, score: terms.reduce((score, term) => score + (content.includes(term) ? 1 : 0), 0) };
    }).filter(row => !terms.length || row.score).sort((a,b) => b.score - a.score || b.observedAt.localeCompare(a.observedAt)).slice(0, limit);
  }
}
module.exports = { AgentStorage, now };
