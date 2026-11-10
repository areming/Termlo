// Visual + static checks for the 2.0 design system (src/ui).
// Opens src/ui/gallery.html in Electron at 1280×800 and the minimum window
// 1000×680, in dark and light, and writes screenshots to test-output/design-gallery/.
//
//   node scripts/design-gallery-smoke.cjs

const { _electron: electron } = require('playwright-core');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const uiDir = path.join(root, 'src', 'ui');
const output = path.join(root, 'test-output', 'design-gallery');
const galleryUrl = pathToFileURL(path.join(uiDir, 'gallery.html')).href;

const SIZES = [
  { width: 1280, height: 800 },
  { width: 1000, height: 680 },
];
const THEMES = ['dark', 'light'];
const SECTIONS = ['foundations', 'buttons', 'forms', 'hosts', 'lists', 'status', 'overlays', 'feedback', 'assistant'];

// ── Static checks: tokens are the only place for raw values ─────────────

function staticChecks() {
  const problems = [];
  const base = fs.readFileSync(path.join(uiDir, 'base.css'), 'utf8');
  const gallery = fs.readFileSync(path.join(uiDir, 'gallery.html'), 'utf8');
  const tokens = fs.readFileSync(path.join(uiDir, 'tokens.css'), 'utf8');

  for (const [name, text] of [['base.css', base], ['gallery.html', gallery]]) {
    const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of withoutComments.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      problems.push(`${name}: hex color ${match[0]}`);
    }
    for (const match of withoutComments.matchAll(/font-size:\s*(10|11)px/g)) problems.push(`${name}: forbidden font size ${match[0]}`);
    for (const match of withoutComments.matchAll(/transition:\s*all/g)) problems.push(`${name}: ${match[0]}`);
    for (const match of withoutComments.matchAll(/border-radius:\s*([^;"]+)/g)) {
      if (!/^(var\(--r-(sm|md|lg|round)\)|0|calc\(var\(--r-sm\)[^;]*\))$/.test(match[1].trim())) problems.push(`${name}: radius ${match[1]}`);
    }
  }
  for (const match of base.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/:\s*[^;{}]*?\b(\d+(?:\.\d+)?)(px|ms)\b/g)) {
    if (match[1] !== '1' && match[1] !== '0') problems.push(`base.css: raw value ${match[1]}${match[2]}`);
  }
  for (const size of tokens.matchAll(/--fs-[a-z]+:\s*(\d+)px/g)) {
    if (Number(size[1]) < 12) problems.push(`tokens.css: font size below 12px (${size[0]})`);
  }
  return problems;
}

// ── In-page checks ──────────────────────────────────────────────────────

// Runs in the page: WCAG contrast of semantic text tokens on their surfaces.
function contrastReport() {
  const probe = document.createElement('span');
  document.body.append(probe);
  const read = (token) => {
    probe.style.color = `var(--${token})`;
    const [r, g, b, a = 1] = getComputedStyle(probe).color.match(/[\d.]+/g).map(Number);
    return { r, g, b, a };
  };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const luminance = ({ r, g, b }) => {
    const channel = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (fg, bg) => {
    const [l1, l2] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  const panel = read('panel');
  const pairs = [
    ['text', 'bg'], ['text', 'panel'], ['text', 'surface-raised'], ['text', 'hover'],
    ['muted', 'bg'], ['muted', 'panel'], ['muted', 'surface-raised'], ['muted', 'surface-inset'], ['muted', 'sidebar-bg'],
    ['accent-text', 'panel'], ['accent-text', 'accent-soft'], ['accent-ink', 'accent'], ['accent-ink', 'accent-hover'],
    ['danger-ink', 'danger'], ['danger', 'panel'], ['danger', 'danger-soft'],
    ['success', 'panel'], ['success', 'success-soft'], ['warning', 'panel'], ['warning', 'warning-soft'],
    ['info', 'panel'], ['info', 'info-soft'], ['terminal-text', 'terminal-bg'], ['terminal-muted', 'terminal-bg'],
  ];
  const result = pairs.map(([fg, bg]) => {
    const background = over(read(bg), panel);
    return { pair: `${fg} on ${bg}`, ratio: Math.round(ratio(over(read(fg), background), background) * 100) / 100 };
  });
  probe.remove();
  return result;
}

// Runs in the page: every focusable control must show a visible focus indicator.
function focusReport() {
  const selector = 'a[href], button:not(:disabled), input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])';
  const failures = [];
  for (const element of document.querySelectorAll(selector)) {
    if (element.closest('dialog:not([open])') || element.offsetParent === null && getComputedStyle(element).position !== 'fixed') continue;
    element.focus({ preventScroll: true });
    const style = getComputedStyle(element);
    const after = getComputedStyle(element, '::after');
    const choice = element.closest('.choice, .composer');
    const visible =
      (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) ||
      style.boxShadow.includes('inset') ||
      (after.outlineStyle !== 'none' && parseFloat(after.outlineWidth) > 0) ||
      (choice && (getComputedStyle(choice).outlineStyle !== 'none' || choice.matches(':focus-within')));
    if (!visible) failures.push(element.outerHTML.slice(0, 90));
  }
  document.activeElement?.blur();
  return failures;
}

// Runs in the page: icon-only buttons need a name; form controls need a label.
function a11yReport() {
  const failures = [];
  for (const button of document.querySelectorAll('button')) {
    const text = button.textContent.trim();
    if (!text && !button.getAttribute('aria-label')) failures.push(`unnamed button: ${button.outerHTML.slice(0, 80)}`);
    if (button.classList.contains('btn-icon') && !button.title) failures.push(`icon button without title: ${button.getAttribute('aria-label')}`);
  }
  for (const control of document.querySelectorAll('input, select, textarea')) {
    const labelled = control.labels?.length || control.getAttribute('aria-label') || control.getAttribute('aria-labelledby');
    if (!labelled) failures.push(`unlabelled control: ${control.outerHTML.slice(0, 80)}`);
  }
  for (const svg of document.querySelectorAll('svg.icon')) {
    if (!svg.hasAttribute('aria-hidden') && !svg.getAttribute('aria-label')) failures.push('icon without aria-hidden or label');
  }
  // Text below 12px anywhere.
  for (const element of document.querySelectorAll('body *')) {
    if (!element.childNodes.length || ![...element.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const size = parseFloat(getComputedStyle(element).fontSize);
    if (size < 12) failures.push(`text below 12px (${size}px): ${element.outerHTML.slice(0, 60)}`);
  }
  return failures;
}

function overflowReport() {
  const content = document.querySelector('.content');
  const page = document.querySelector('.page');
  return {
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    content: content.scrollWidth - content.clientWidth,
    widest: [...page.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > content.getBoundingClientRect().right + 1)
      .filter((el) => !el.closest('.tabs, .terminal, .code, .console-list, .stream'))
      .slice(0, 5)
      .map((el) => el.outerHTML.slice(0, 80)),
  };
}

// ── Runner ──────────────────────────────────────────────────────────────

async function main() {
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });

  const problems = staticChecks();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termlo-gallery-'));
  const mainFile = path.join(tmp, 'main.cjs');
  fs.writeFileSync(
    mainFile,
    `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1280, height: 800, useContentSize: true, backgroundColor: '#181a1f',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.loadURL(${JSON.stringify(galleryUrl)});
});
app.on('window-all-closed', () => app.quit());
`,
  );

  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [mainFile], env, timeout: 30000 });
  const report = { contrast: {}, focus: {}, a11y: [], overflow: {}, reducedMotion: {}, screenshots: [] };
  const errors = [];

  try {
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    const shot = async (name, options = {}) => {
      const file = path.join(output, `${name}.png`);
      await page.screenshot({ path: file, ...options });
      report.screenshots.push(path.relative(root, file));
    };

    for (const theme of THEMES) {
      for (const { width, height } of SIZES) {
        const tag = `${theme}-${width}x${height}`;
        await app.evaluate(({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height);
        }, { width, height });

        // Real shell at window size.
        await page.goto(`${galleryUrl}?theme=${theme}`);
        await page.waitForSelector('html[data-ready="true"]');
        await page.evaluate(() => document.fonts.ready);
        await shot(`${tag}-shell`);

        report.overflow[tag] = await page.evaluate(overflowReport);
        const { document: docOverflow, content: contentOverflow, widest } = report.overflow[tag];
        if (docOverflow > 0 || contentOverflow > 0) problems.push(`${tag}: horizontal overflow ${JSON.stringify({ docOverflow, contentOverflow, widest })}`);

        // Hover states: host card quick actions and list row.
        await page.locator('#hosts').scrollIntoViewIfNeeded();
        await page.locator('#hosts').evaluate((el) => el.scrollIntoView({ block: 'start' }));
        await page.locator('#host-hovered').hover();
        await shot(`${tag}-hosts-hover`);

        // Keyboard focus ring on a quick action.
        await page.locator('#row-hovered').scrollIntoViewIfNeeded();
        await page.locator('#row-hovered .quick-actions button').first().focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await shot(`${tag}-focus`);

        // Live modal dialog.
        await page.mouse.move(0, 0);
        await page.locator('#open-dialog').click();
        await page.waitForTimeout(300);
        await shot(`${tag}-dialog`);
        await page.keyboard.press('Escape');

        if (width === SIZES[0].width) {
          report.contrast[theme] = await page.evaluate(contrastReport);
          for (const { pair, ratio } of report.contrast[theme]) {
            if (ratio < 4.5) problems.push(`${theme}: contrast ${pair} = ${ratio}`);
          }
          report.focus[theme] = await page.evaluate(focusReport);
          for (const failure of report.focus[theme]) problems.push(`${theme}: no visible focus on ${failure}`);
        }

        // Every section, full height (capture mode lets the shell grow).
        await page.goto(`${galleryUrl}?theme=${theme}&capture=1`);
        await page.waitForSelector('html[data-ready="true"]');
        for (const section of SECTIONS) {
          const file = path.join(output, `${tag}-${section}.png`);
          const box = await page.locator(`#${section}`).boundingBox();
          const pad = 12;
          await page.screenshot({
            path: file,
            fullPage: true,
            clip: { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 },
          });
          report.screenshots.push(path.relative(root, file));
        }
      }
    }

    report.a11y = await page.evaluate(a11yReport);
    problems.push(...report.a11y);

    // Reduced motion: decorative loops stop.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    report.reducedMotion = await page.evaluate(() => ({
      caret: getComputedStyle(document.querySelector('.caret')).animationName,
      skeleton: getComputedStyle(document.querySelector('.skeleton')).animationName,
      transition: getComputedStyle(document.querySelector('.btn')).transitionDuration,
    }));
    if (report.reducedMotion.caret !== 'none' || report.reducedMotion.skeleton !== 'none') {
      problems.push(`reduced motion: loops still animate ${JSON.stringify(report.reducedMotion)}`);
    }
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  problems.push(...errors.map((error) => `page error: ${error}`));
  report.problems = problems;
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));

  assert.deepEqual(problems, [], `Design gallery problems:\n${problems.join('\n')}`);
  console.log(`Design gallery passed: ${report.screenshots.length} screenshots in ${path.relative(root, output)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
