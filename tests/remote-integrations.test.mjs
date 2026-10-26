import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const content = 'Public host integration guide.';
const knowledge = { schemaVersion: '1.0', documents: [{ id: 'guide', label: 'Host guide', content,
  checksum: createHash('sha256').update(content).digest('hex') }] };

async function fixture() {
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { AIToolbar } from '@e6tz/toolkit/react';
    const query = new URLSearchParams(location.search);
    const wiki = query.has('wiki') ? { url: location.origin + '/wiki', manageUrl: location.origin + '/toolkit/toolbar/projects/host' } : undefined;
    createRoot(document.querySelector('#toolbar')).render(React.createElement(AIToolbar, {
      environment: 'development', appName: 'Host fixture', locale: 'en',
      knowledge: ${JSON.stringify(knowledge)}, activity: { recordNetwork: false, resources: [] },
      ...(query.has('documentsPath') ? { documentsPath: query.get('documentsPath') } : {}),
      ...(query.has('live') ? { liveConfig: { url: '/host/config', intervalMs: 60000 } } : {}),
      ...(wiki ? { wiki } : {})
    }));`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'esm', jsx: 'automatic' });
  const state = { status: 401, canEdit: false, requests: [] };
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].contents); return; }
    if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><main><h1>Host application</h1><button>Local action</button></main><div id="toolbar"></div><script type="module" src="/app.js"></script>'); return; }
    // The package-local font is not a remote integration or control-plane request.
    if (path.endsWith('.woff2') || path === '/favicon.ico') { res.writeHead(404).end(); return; }
    state.requests.push({ path, method: req.method, csrf: req.headers['x-csrf-token'], cookie: req.headers.cookie });
    res.setHeader('Content-Type', 'application/json');
    if (path === '/host/config') { res.end(JSON.stringify({ locale: 'en', maxBodyChars: 1000, recordNetwork: false, wiki: null })); return; }
    res.statusCode = state.status;
    res.end(JSON.stringify(path.endsWith('/recordings') ? { recordings: [] }
      : { user: { id: 1, name: 'Host user' }, canEdit: state.canEdit, csrfToken: 'host-csrf', pages: [], documents: [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { page, origin, state, async close() { await browser.close(); await new Promise(resolve => server.close(resolve)); } };
}

async function documents(page) {
  await page.getByRole('button', { name: 'Start recording', exact: true }).hover();
  const pin = page.getByRole('button', { name: 'Pin tools', exact: true });
  if (await pin.isVisible()) await pin.click();
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copy Host guide', exact: true })).toBeVisible();
}

test('local documents do not invent a host route or initiate remote integration', async () => {
  const f = await fixture();
  try {
    await f.page.goto(f.origin);
    await documents(f.page);
    await expect(f.page.getByRole('link', { name: 'Host guide', exact: true })).toHaveCount(0);
    await expect(f.page.getByText('Host guide', { exact: true })).toBeVisible();
    await expect(f.page.locator('iframe')).toHaveCount(0);
    await f.page.evaluate(() => { dispatchEvent(new Event('focus')); dispatchEvent(new Event('online')); });
    assert.deepEqual(f.state.requests, []);
  } finally { await f.close(); }
});

test('configured wiki authentication belongs to the host, not an embedded Toolkit login', async () => {
  const f = await fixture();
  try {
    await f.page.goto(`${f.origin}/?wiki`);
    await documents(f.page);
    await expect.poll(() => f.state.requests.length).toBeGreaterThan(0);
    await expect(f.page.getByRole('button', { name: /sign in/i })).toHaveCount(0);
    await expect(f.page.getByText('Authenticate in the host application to use this integration.', { exact: true })).toBeVisible();
    await expect(f.page.locator('iframe')).toHaveCount(0);
    assert.ok(f.state.requests.every(req => req.path === '/toolkit/toolbar/projects/host' && req.method === 'GET'));
    if (process.env.TOOLKIT_INTEGRATION_PROOF_DIR) {
      await mkdir(process.env.TOOLKIT_INTEGRATION_PROOF_DIR, { recursive: true });
      for (const [name, width, height] of [['desktop', 1280, 900], ['mobile', 390, 844]]) {
        await f.page.setViewportSize({ width, height });
        await expect(f.page.getByText('Authenticate in the host application to use this integration.', { exact: true })).toBeVisible();
        await expect.poll(() => f.page.getByRole('dialog', { name: 'Documents' }).evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThan(2);
        await f.page.screenshot({ path: join(process.env.TOOLKIT_INTEGRATION_PROOF_DIR, `${name}.png`) });
      }
    }
  } finally { await f.close(); }
});

test('explicit document routes remain supported and invalid routes stay local', async () => {
  const f = await fixture();
  try {
    await f.page.goto(`${f.origin}/?documentsPath=${encodeURIComponent('/host/docs?mode=read#guide')}`);
    await documents(f.page);
    await expect(f.page.getByRole('link', { name: 'Host guide', exact: true })).toHaveAttribute('href', '/host/docs?mode=read&document=guide#guide');
    for (const path of ['//external.example/docs', 'https://external.example/docs', '/\\external.example/docs', '']) {
      await f.page.goto(`${f.origin}/?documentsPath=${encodeURIComponent(path)}`);
      await documents(f.page);
      await expect(f.page.getByRole('link', { name: 'Host guide', exact: true })).toHaveCount(0);
    }
    assert.deepEqual(f.state.requests, []);
  } finally { await f.close(); }
});

test('live configuration starts only when the host supplies its endpoint', async () => {
  const f = await fixture();
  try {
    await f.page.goto(`${f.origin}/?live`);
    await documents(f.page);
    await expect.poll(() => f.state.requests.length).toBeGreaterThan(0);
    assert.ok(f.state.requests.every(req => req.path === '/host/config' && req.method === 'GET'));
    await expect(f.page.locator('iframe')).toHaveCount(0);
  } finally { await f.close(); }
});

test('host auth refresh preserves permissions, session transport and local recording/export', async () => {
  const f = await fixture();
  try {
    await f.page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: f.origin });
    await f.page.context().addCookies([{ name: 'host-session', value: 'test-session', url: f.origin }]);
    await f.page.goto(`${f.origin}/?wiki`);
    await documents(f.page);
    await f.page.getByRole('button', { name: 'Add recording', exact: true }).click();
    await expect(f.page.getByText('Authenticate in the host application to use this integration.', { exact: true })).toBeVisible();
    await expect(f.page.getByRole('button', { name: /sign in/i })).toHaveCount(0);
    f.state.status = 403;
    await f.page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(f.page.getByRole('alert')).toContainText('You do not have access');
    // The host establishes authentication, then tells the mounted integration to refresh.
    f.state.status = 200;
    await f.page.evaluate(() => dispatchEvent(new Event('ai-context-toolbar:wiki-auth-changed')));
    await expect(f.page.getByText('This project has no saved recordings yet.', { exact: true })).toBeVisible();
    await f.page.getByRole('button', { name: 'Start recording', exact: true }).click();
    await f.page.getByRole('button', { name: 'Select', exact: true }).click();
    await f.page.getByRole('button', { name: 'Local action', exact: true }).click();
    await f.page.getByRole('textbox', { name: 'Your feedback', exact: true }).fill('Preserve local recording without host edit permission.');
    await f.page.getByRole('textbox', { name: 'Your feedback', exact: true }).press('Enter');
    await f.page.getByRole('button', { name: 'Exit selection', exact: true }).click();
    await f.page.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await expect(f.page.getByRole('button', { name: 'Save to wiki', exact: true })).toBeDisabled();
    await f.page.getByRole('button', { name: 'Copy JSON', exact: true }).click();
    const recording = JSON.parse(await f.page.evaluate(() => navigator.clipboard.readText()));
    assert.equal(recording.schemaVersion, '1.1');
    assert.ok(recording.session.id);
    assert.ok(Array.isArray(recording.steps));
    f.state.canEdit = true;
    await f.page.evaluate(() => dispatchEvent(new Event('ai-context-toolbar:wiki-auth-changed')));
    await expect(f.page.getByRole('button', { name: 'Save to wiki', exact: true })).toBeEnabled();
    assert.ok(f.state.requests.every(req => req.cookie?.includes('host-session=test-session')));
    assert.ok(f.state.requests.every(req => req.method === 'GET'));
    await f.page.getByRole('button', { name: 'Save to wiki', exact: true }).click();
    await expect.poll(() => f.state.requests.find(req => req.method === 'POST')?.csrf).toBe('host-csrf');
    await expect(f.page.getByRole('button', { name: 'Copy JSON', exact: true })).toBeEnabled();
    assert.ok(f.state.requests.every(req => !req.path.includes('/login')));
    await expect(f.page.locator('iframe')).toHaveCount(0);
  } finally { await f.close(); }
});
