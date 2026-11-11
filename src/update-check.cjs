// Update check: asks GitHub for the latest published release and compares versions. It only
// tells the user; downloading is theirs to do from the release page (builds are not signed, so
// installing silently in the background is not something we do). Sends no data about the user:
// one anonymous GET with a generic User-Agent.
const REPO = 'areming/Termlo';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const PAGE = `https://github.com/${REPO}/releases/`;
const TIMEOUT_MS = 10000;

// "2.10.1" > "2.9.3"; a pre-release ("2.5.0-beta.1") sorts before its release.
function compareVersions(a, b) {
  const parse = v => {
    const [core, pre = ''] = String(v).trim().replace(/^v/i, '').split('-', 2);
    return { parts: core.split('.').map(n => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] || 0) - (y.parts[i] || 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

const VERSION = /^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/;

// Only a release page of this repository may be opened from the app.
function releaseUrl(url) {
  return typeof url === 'string' && url.startsWith(PAGE) && !/[\s"'<>]/.test(url) ? url : '';
}

async function checkForUpdate({ current, fetch, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const response = await fetch(API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Termlo-update-check' }, signal: controller.signal });
    if (response.status === 404) return { current, latest: '', newer: false };   // nothing published yet
    if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
    const release = await response.json();
    const tag = String(release?.tag_name || '');
    if (release?.draft || release?.prerelease || !VERSION.test(tag)) return { current, latest: '', newer: false };
    const latest = tag.replace(/^v/i, '');
    return {
      current,
      latest,
      newer: compareVersions(latest, current) > 0,
      url: releaseUrl(release.html_url) || PAGE + 'latest',
      publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
    };
  } catch (error) {
    throw new Error(error.name === 'AbortError' ? '检查更新超时' : `检查更新失败：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkForUpdate, compareVersions, releaseUrl, RELEASES_PAGE: PAGE };
