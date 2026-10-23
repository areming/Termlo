const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
process.env.electron_config_cache ||= path.join(root, '.cache/electron');
process.env.ELECTRON_BUILDER_CACHE ||= path.join(root, '.cache/builder');
require('electron');
const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), '--dir'], { cwd: root, stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
