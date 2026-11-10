// Atomic replace via temp file + rename.
// On Windows, rename fails with EPERM/EACCES/EBUSY while another process (antivirus,
// search indexer, backup/sync tools) briefly holds the destination open. Those locks
// clear within milliseconds, so retry with backoff instead of failing the caller.
const fs = require('node:fs');

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const DELAYS = [10, 20, 40, 80, 160, 200, 200, 200, 200]; // ~1.1 s worst case
const defaultAttempts = () => (process.platform === 'win32' ? DELAYS.length + 1 : 1);

function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function renameSync(from, to, { attempts = defaultAttempts(), rename = fs.renameSync, wait = pause } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return rename(from, to); }
    catch (error) {
      if (attempt >= attempts - 1 || !TRANSIENT.has(error.code)) throw error;
      wait(DELAYS[Math.min(attempt, DELAYS.length - 1)]);
    }
  }
}

async function rename(from, to, { attempts = defaultAttempts(), rename = fs.promises.rename, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); }
    catch (error) {
      if (attempt >= attempts - 1 || !TRANSIENT.has(error.code)) throw error;
      await wait(DELAYS[Math.min(attempt, DELAYS.length - 1)]);
    }
  }
}

module.exports = { renameSync, rename, TRANSIENT };
