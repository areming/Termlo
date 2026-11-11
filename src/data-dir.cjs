// Where Termlo keeps its data: <appData>/Termlo.
// Versions up to 2.0.1 used <appData>/Termus (the 1.x name). On first launch the whole folder
// is renamed in one step, so hosts, tasks and Electron's "Local State" (which holds the key
// that decrypts saved passwords) move together. If the rename fails (for example a file is
// locked), the old folder keeps being used and the move is tried again on the next launch.
const fs = require('node:fs');
const path = require('node:path');

const NAME = 'Termlo';
const LEGACY = 'Termus';

function resolveDataDir(appData, { rename = fs.renameSync } = {}) {
  const current = path.join(appData, NAME);
  const legacy = path.join(appData, LEGACY);
  if (fs.existsSync(current) || !fs.existsSync(legacy)) return { directory: current, moved: false };
  try {
    rename(legacy, current);
    return { directory: current, moved: true };
  } catch (error) {
    return { directory: legacy, moved: false, error: error.message };
  }
}

module.exports = { resolveDataDir, NAME, LEGACY };
