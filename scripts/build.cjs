const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
function build() {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  esbuild.buildSync({ entryPoints: [path.join(root, 'src/renderer.js')], bundle: true, outfile: path.join(root, 'dist/renderer.js'), platform: 'browser', minify: false });
  for (const file of ['index.html', 'styles.css', 'assistant.css', 'appearance.css']) fs.copyFileSync(path.join(root, 'src', file), path.join(root, 'dist', file));
  fs.copyFileSync(require.resolve('@xterm/xterm/css/xterm.css'), path.join(root, 'dist/xterm.css'));
}
module.exports = { build };
if (require.main === module) { build(); console.log('Termlo build complete'); }
