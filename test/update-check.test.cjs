const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkForUpdate, compareVersions, releaseUrl } = require('../src/update-check.cjs');

const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('versions compare by number, and a pre-release comes before its release', () => {
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1);
  assert.equal(compareVersions('v2.4.1', '2.4.1'), 0);
  assert.equal(compareVersions('2.4.0', '2.4.1'), -1);
  assert.equal(compareVersions('2.5.0-beta.1', '2.5.0'), -1);
  assert.equal(compareVersions('2.5.0', '2.4.9-rc.1'), 1);
});

test('a newer release is reported with its page; an older or equal one is not', async () => {
  const newer = await checkForUpdate({ current: '2.4.1', fetch: reply(200, { tag_name: 'v2.5.0', html_url: 'https://github.com/areming/Termlo/releases/tag/v2.5.0', published_at: '2026-12-01T00:00:00Z' }) });
  assert.deepEqual([newer.newer, newer.latest, newer.url], [true, '2.5.0', 'https://github.com/areming/Termlo/releases/tag/v2.5.0']);
  const older = await checkForUpdate({ current: '2.4.1', fetch: reply(200, { tag_name: 'v2.0.3', html_url: 'https://github.com/areming/Termlo/releases/tag/v2.0.3' }) });
  assert.equal(older.newer, false);
});

test('drafts, pre-releases, odd tags and missing releases never prompt; only this repo\'s pages open', async () => {
  for (const body of [{ tag_name: 'v9.0.0', draft: true }, { tag_name: 'v9.0.0', prerelease: true }, { tag_name: 'nightly' }]) {
    assert.equal((await checkForUpdate({ current: '2.4.1', fetch: reply(200, body) })).newer, false);
  }
  assert.equal((await checkForUpdate({ current: '2.4.1', fetch: reply(404, {}) })).newer, false);
  const elsewhere = await checkForUpdate({ current: '2.4.1', fetch: reply(200, { tag_name: 'v3.0.0', html_url: 'https://evil.example/download' }) });
  assert.equal(elsewhere.url, 'https://github.com/areming/Termlo/releases/latest');
  assert.equal(releaseUrl('https://github.com/areming/Termlo/releases/tag/v1 "x'), '');
  await assert.rejects(checkForUpdate({ current: '2.4.1', fetch: reply(403, {}) }), /检查更新失败：GitHub 返回 403/);
});

test('the request carries no user data: one GET to the GitHub API with a generic agent', async () => {
  const seen = [];
  await checkForUpdate({ current: '2.4.1', fetch: async (url, options) => { seen.push({ url, options }); return { status: 404, ok: false }; } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.github.com/repos/areming/Termlo/releases/latest');
  assert.deepEqual(Object.keys(seen[0].options.headers).sort(), ['Accept', 'User-Agent']);
  assert.equal(seen[0].options.headers['User-Agent'], 'Termlo-update-check');
});
