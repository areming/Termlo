const { spawn } = require('node:child_process');
require('./build.cjs').build();
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [require('node:path').join(__dirname, '..')], { stdio: 'inherit', env, windowsHide: false });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
