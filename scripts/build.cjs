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
  // Terminal font, bundled so it looks the same on every platform (SIL Open Font License).
  const fonts = path.join(path.dirname(require.resolve('@fontsource/jetbrains-mono/package.json')), 'files');
  fs.mkdirSync(path.join(dist, 'fonts'));
  for (const weight of [400, 700]) fs.copyFileSync(path.join(fonts, `jetbrains-mono-latin-${weight}-normal.woff2`), path.join(dist, 'fonts', `jetbrains-mono-${weight}.woff2`));
  fs.copyFileSync(path.join(fonts, '..', 'LICENSE'), path.join(dist, 'fonts', 'JetBrainsMono-OFL.txt'));
}

module.exports = { build };
if (require.main === module) { build(); console.log('Termlo build complete'); }
