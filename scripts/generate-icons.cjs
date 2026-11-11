// Regenerate the app icons from the vector sources (run when the logo changes; builds use the
// committed files):
//   npx electron scripts/generate-icons.cjs
// assets/termlo.svg is the full mark (48 px and up); assets/termlo-small.svg has heavier strokes
// for 16–32 px. Chromium rasterizes each size directly from the vector, so small sizes stay crisp.
// Writes assets/termlo.png (512), termlo.ico (PNG frames 16–256) and termlo.icns (16–1024).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const assets = path.join(__dirname, '..', 'assets');
const source = size => fs.readFileSync(path.join(assets, size <= 32 ? 'termlo-small.svg' : 'termlo.svg'), 'utf8');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

async function rasterize(window, size) {
  const url = 'data:image/svg+xml;base64,' + Buffer.from(source(size)).toString('base64');
  const data = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const image = new Image(${size}, ${size});
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = ${size};
      canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size});
      resolve(canvas.toDataURL('image/png').split(',')[1]);
    };
    image.onerror = reject;
    image.src = ${JSON.stringify(url)};
  })`);
  return Buffer.from(data, 'base64');
}

// ICO with PNG frames (Windows Vista and later).
function ico(frames) {
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(([size, png], i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at); header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...frames.map(([, png]) => png)]);
}

// ICNS with PNG payloads.
function icns(entries) {
  const chunks = entries.map(([type, png]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii'); head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii'); head.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4);
  return Buffer.concat([head, ...chunks]);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await window.loadURL('data:text/html,<meta charset="utf-8">');
  const png = {};
  for (const size of SIZES) png[size] = await rasterize(window, size);
  fs.writeFileSync(path.join(assets, 'termlo.png'), png[512]);
  fs.writeFileSync(path.join(assets, 'termlo.ico'), ico([16, 24, 32, 48, 64, 128, 256].map(s => [s, png[s]])));
  fs.writeFileSync(path.join(assets, 'termlo.icns'), icns([['icp4', png[16]], ['icp5', png[32]], ['icp6', png[64]], ['ic07', png[128]], ['ic08', png[256]], ['ic09', png[512]], ['ic10', png[1024]]]));
  console.log('Generated termlo.png, termlo.ico and termlo.icns');
  app.quit();
});
