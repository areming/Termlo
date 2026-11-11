const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

function build() {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  esbuild.buildSync({
    entryPoints: [path.join(root, 'src/app/main.js')],
    bundle: true,
    format: 'iife',
    outfile: path.join(dist, 'app.js'),
    platform: 'browser',
    target: 'chrome140',
    minify: false,
    logLevel: 'warning',
  });
  const copies = {
    'index.html': 'src/app/index.html',
    'app.css': 'src/app/app.css',
    'tokens.css': 'src/ui/tokens.css',
    'base.css': 'src/ui/base.css',
    'termlo.svg': 'assets/termlo.svg',
  };
  for (const [target, source] of Object.entries(copies)) fs.copyFileSync(path.join(root, source), path.join(dist, target));
  fs.copyFileSync(require.resolve('@xterm/xterm/css/xterm.css'), path.join(dist, 'xterm.css'));
}

module.exports = { build };
if (require.main === module) { build(); console.log('Termlo build complete'); }
