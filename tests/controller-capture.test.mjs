import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

let server, browser, base;
before(async () => {
  server = createServer(async (request, response) => {
    const path = (request.url ?? '').split('?')[0];
    if (path === '/') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>Controller capture gate</title><style>body{margin:0;background:white}button{margin:20px}input{display:block;margin:20px}</style><button data-ai-id="selected">Animales</button><input aria-label="Privado" value="private field"><div data-ai-toolbar-root id="toolbar">Toolbar</div>');
      return;
    }
    if (!/^\/dist\/[a-z0-9/_-]+\.js$/i.test(path)) { response.writeHead(404).end(); return; }
    try {
      response.setHeader('content-type', 'text/javascript');
      response.end(await readFile(fileURLToPath(new URL(`..${path}`, import.meta.url))));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function fixture({ accelerateExpiry = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(base);
  await page.evaluate(async accelerateExpiry => {
    if (accelerateExpiry) {
      const original = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => original(callback,
        delay >= 29_000 && delay <= 61_000 ? 100 : delay, ...args);
    }
    const { createReviewController } = await import('/dist/review/controller.js');
    const { captureContext } = await import('/dist/browser/context.js');
    const { createAgentContext } = await import('/dist/core/agent.js');
    window.contextReads = 0;
    window.delayedRead = false;
    window.autoReads = [];
    window.controller = createReviewController({ locale: 'es', window,
      getTarget: () => document.querySelector('[data-ai-id="selected"]'),
      getLegacyContext: async () => {
        window.contextReads += 1;
        if (window.delayedRead) {
          window.delayedRead = false;
          await new Promise(resolve => { window.resolveDelayedRead = resolve; });
        }
        return createAgentContext(captureContext({ build: { environment: 'preview' }, target: document.querySelector('[data-ai-id="selected"]') }));
      },
      onChange: () => {
        if (window.controller) window.autoReads.push(window.controller.getContext().catch(error => ({ error: error.code })));
      },
    });
    await window.controller.operations.startSession({ requestId: 'session', objective: 'Revisar animales' });
    await Promise.all(window.autoReads);
  }, accelerateExpiry);
  return page;
}
async function prepareWithPendingReader(page) {
  await page.evaluate(() => {
    window.delayedRead = true;
    window.pendingRead = window.controller.getContext();
  });
  const prepared = await page.evaluate(() => window.controller.operations.checkpoint({ requestId: 'external', label: 'Estado visible', capture: { phase: 'begin' } }));
  assert.equal(prepared.status, 'ok', JSON.stringify(prepared));
  await page.evaluate(() => window.resolveDelayedRead());
  return prepared.data.capture;
}

async function useFreeRegion(page) {
  await page.exposeFunction('captureRealViewport', async () => {
    const bytes = await page.screenshot({ type: 'png', caret: 'initial' });
    return { base64: bytes.toString('base64'), capturedAt: new Date().toISOString() };
  });
  await page.evaluate(async () => {
    window.controller.dispose();
    const { createReviewController } = await import('/dist/review/controller.js');
    const { captureContext } = await import('/dist/browser/context.js');
    const { createAgentContext } = await import('/dist/core/agent.js');
    window.freeRegion = { x: 20, y: 20, width: 80, height: 40 };
    window.selectedAreaId = 'area-observation';
    const at = new Date().toISOString();
    window.annotations = [{ id: 'area-observation', kind: 'area', pathname: '/', createdAt: at, updatedAt: at,
      label: 'Zona de animales', note: 'La zona elegida requiere revisión.',
      bounds: { ...window.freeRegion }, viewport: { width: innerWidth, height: innerHeight }, element: null, relatedElements: [] }];
    window.controller = createReviewController({ locale: 'es', window, getTarget: () => null,
      getRegionBounds: () => window.freeRegion, getSelectionId: () => window.selectedAreaId,
      getLegacyContext: async () => {
        const context = createAgentContext(captureContext({ build: { environment: 'preview' } }));
        context.context.annotations = window.annotations;
        return context;
      },
      review: { captureProvider: { name: 'real-playwright-viewport', kind: 'real-browser',
        async captureViewport(request) {
          await request.ready;
          const image = await window.captureRealViewport();
          return { bytes: Uint8Array.from(atob(image.base64), char => char.charCodeAt(0)), capturedAt: image.capturedAt,
            pixelWidth: innerWidth, pixelHeight: innerHeight, provider: 'real-playwright-viewport' };
        } } },
    });
    await window.controller.operations.startSession({ requestId: 'free-session', objective: 'Revisar área' });
  });
}

test('ticket preparation captures a real free region and includes its saved annotation without a DOM target', async () => {
  const page = await fixture();
  try {
    await useFreeRegion(page);
    const result = await page.evaluate(() => window.controller.operations.prepareTicket({ requestId: 'free-ticket' }));
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.match(result.data.ticket.markdown, /Área libre seleccionada/);
    assert.match(result.data.ticket.markdown, /Anotaciones del usuario/);
    assert.match(result.data.ticket.markdown, /La zona elegida requiere revisión/);
    const image = await page.evaluate(async id => {
      const file = window.controller.readFile(id);
      const bitmap = await createImageBitmap(new Blob([file.bytes], { type: file.mimeType }));
      const dimensions = { width: bitmap.width, height: bitmap.height }; bitmap.close();
      return { ...dimensions, signature: Array.from(file.bytes.subarray(0, 8)),
        artifact: window.controller.snapshot().artifacts.find(artifact => artifact.id === id) };
    }, result.data.artifactId);
    assert.deepEqual(image.signature, [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(image.width, 80); assert.equal(image.height, 40);
    assert.equal(image.artifact.capture.kind, 'region');
    assert.equal(image.artifact.redactionStatus, 'disabled');
  } finally { await page.close(); }
});

test('external controller region preserves selection identity and rejects another area at the same coordinates', async () => {
  const page = await fixture();
  try {
    await useFreeRegion(page);
    const prepared = await page.evaluate(() => window.controller.operations.checkpoint({ requestId: 'free-external',
      label: 'Área visible', capture: { phase: 'begin', kind: 'region' } }));
    assert.equal(prepared.status, 'ok', JSON.stringify(prepared));
    const bytes = await page.screenshot({ type: 'png', caret: 'initial' });
    await page.evaluate(() => { window.selectedAreaId = 'another-area'; });
    const result = await page.evaluate(({ token, base64, capturedAt }) => window.controller.operations.checkpoint({
      requestId: 'changed-area', capture: { phase: 'complete', token, base64, capturedAt,
        pixelWidth: 1000, pixelHeight: 700, provider: 'real-playwright-screenshot' } }),
    { token: prepared.data.capture.token, base64: bytes.toString('base64'), capturedAt: new Date().toISOString() });
    assert.equal(result.status, 'error', JSON.stringify(result));
    assert.equal(result.error.code, 'STALE_CAPTURE');
    assert.equal(await page.evaluate(() => window.controller.snapshot().artifacts.some(artifact => artifact.status === 'available')), false);
    assert.equal(await page.locator('#toolbar').evaluate(element => element.style.visibility), '');
  } finally { await page.close(); }
});

test('external pending context is readable without masked DOM reads and cancellation releases prior reads', async () => {
  const page = await fixture();
  try {
    const prepared = await prepareWithPendingReader(page);
    const state = await page.evaluate(async () => {
      const before = window.contextReads;
      const context = await window.controller.getContext();
      return { before, after: window.contextReads, context };
    });
    assert.equal(state.after, state.before, 'pending getContext uses its pre-mask public snapshot');
    assert.equal(state.context.capturePending.kind, 'external');
    assert.equal(state.context.context.target.accessibleName, 'Animales');
    assert.equal((await page.evaluate(() => window.controller.operations.reviewPrivacy({ requestId: 'blocked-review', expectedRevision: window.controller.snapshot().revision, confirmed: true }))).error.code, 'CAPABILITY_UNAVAILABLE');
    const cancel = await page.evaluate(token => window.controller.operations.checkpoint({ requestId: 'cancel', capture: { phase: 'cancel', token } }), prepared.token);
    assert.equal(cancel.status, 'ok');
    const restored = await page.evaluate(() => window.pendingRead);
    assert.equal(restored.capturePending, undefined);
    assert.equal(restored.context.target.accessibleName, 'Animales');
    assert.equal(await page.locator('[data-ai-capture-shield]').count(), 0);
    assert.equal((await page.evaluate(() => window.controller.getContext())).capturePending, undefined);
  } finally { await page.close(); }
});

test('external expiry restores the page, records the missing image and releases pending readers', async () => {
  const page = await fixture({ accelerateExpiry: true });
  try {
    await prepareWithPendingReader(page);
    const restored = await page.evaluate(() => window.pendingRead);
    assert.equal(restored.capturePending, undefined);
    assert.equal(restored.review.artifacts.some(artifact => artifact.status === 'failed'), true);
    assert.equal(await page.locator('[data-ai-capture-shield]').count(), 0);
    assert.equal(await page.locator('#toolbar').evaluate(element => element.style.visibility), '');
  } finally { await page.close(); }
});

test('actual external image completes after metadata revisions without losing its genuine frame', async () => {
  const page = await fixture();
  try {
    const prepared = await prepareWithPendingReader(page);
    await page.evaluate(() => window.controller.operations.updateNotes({ requestId: 'metadata', stepId: window.controller.snapshot().steps[0].id, notes: 'Nota de la evidencia' }));
    const pending = await page.evaluate(() => window.controller.getContext());
    assert.ok(pending.revision > prepared.revision, 'metadata changed the review revision only');
    const bytes = await page.screenshot({ type: 'png', caret: 'initial' });
    const completed = await page.evaluate(({ token, bytes, capturedAt }) => window.controller.operations.checkpoint({ requestId: 'complete', capture: { phase: 'complete', token, base64: bytes, capturedAt, pixelWidth: 1000, pixelHeight: 700, provider: 'real-playwright-screenshot' } }), { token: prepared.token, bytes: bytes.toString('base64'), capturedAt: new Date().toISOString() });
    assert.equal(completed.status, 'ok', JSON.stringify(completed));
    const context = await page.evaluate(() => window.pendingRead);
    assert.equal(context.capturePending, undefined);
    assert.equal(context.review.artifacts.filter(artifact => artifact.status === 'available').length, 1);
    assert.equal(context.review.artifacts.filter(artifact => artifact.status === 'failed').length, 0);
    assert.equal(await page.locator('[data-ai-capture-shield]').count(), 0);
  } finally { await page.close(); }
});

test('DOM handoff publishes actual export files with MIME parameters and canonical image previews', async () => {
  const page = await fixture();
  try {
    const screenshot = await page.screenshot({ type: 'png' });
    const state = await page.evaluate(async image => {
      const { installAgentDomTransport } = await import('/dist/browser/agent-transport.js');
      const root = document.createElement('div');
      document.body.append(root);
      const port = installAgentDomTransport({ root,
        getContext: () => window.controller.getContext(), operations: window.controller.operations,
        readFile: id => window.controller.readFile(id),
      });
      port.publishArtifacts([
        { id: 'context-file', filename: 'context.json', mimeType: 'application/json; charset=utf-8', bytes: new TextEncoder().encode('{"selection":"Animales"}') },
        { id: 'ticket-file', filename: 'ticket.md', mimeType: 'text/markdown;charset=UTF-8', bytes: new TextEncoder().encode('# Ticket\nEvidencia real') },
        { id: 'ticket-html', filename: 'ticket.html', mimeType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode('<h1>Ticket</h1>') },
        { id: 'actual-image', filename: 'actual.png', mimeType: 'Image/PNG', bytes: Uint8Array.from(atob(image), value => value.charCodeAt(0)) },
      ]);
      window.handoffPort = port;
      return JSON.parse(root.querySelector('[data-ai-context-agent-port-state]').textContent);
    }, screenshot.toString('base64'));
    assert.equal(state.artifacts.length, 4);
    assert.equal(state.artifacts[0].mimeType, 'application/json; charset=utf-8');
    assert.equal(await page.locator('img[data-ai-context-image-id="actual-image"]').count(), 1);
    const [download] = await Promise.all([
      page.waitForEvent('download'), page.locator('[data-ai-context-download-id="context-file"]').click(),
    ]);
    assert.equal(download.suggestedFilename(), 'context.json');
    assert.equal((await readFile(await download.path())).toString(), '{"selection":"Animales"}');
  } finally { await page.close(); }
});

test('controller defaults to visible screenshots and honors explicit redact per checkpoint', async () => {
  const page = await fixture();
  try {
    for (const privacy of ['visible', 'redact']) {
      const prepared = await page.evaluate(privacy => window.controller.operations.checkpoint({
        requestId: `privacy-${privacy}`, label: privacy,
        capture: { phase: 'begin', ...(privacy === 'redact' ? { privacy } : {}) },
      }), privacy);
      assert.equal(prepared.status, 'ok', JSON.stringify(prepared));
      assert.equal((await page.evaluate(() => window.controller.getContext())).capturePending.privacy, privacy);
      const bytes = await page.screenshot({ type: 'png', caret: 'initial' });
      const completed = await page.evaluate(({ token, bytes, capturedAt, privacy }) => window.controller.operations.checkpoint({ requestId: `complete-${privacy}`, capture: { phase: 'complete', token, base64: bytes, capturedAt, pixelWidth: 1000, pixelHeight: 700, provider: 'real-playwright-screenshot' } }), { token: prepared.data.capture.token, bytes: bytes.toString('base64'), capturedAt: new Date().toISOString(), privacy });
      assert.equal(completed.status, 'ok', JSON.stringify(completed));
      assert.equal(completed.data.redactionStatus, privacy === 'visible' ? 'disabled' : 'applied');
      const pixel = await page.evaluate(async id => {
        const image = window.controller.readFile(id);
        const bitmap = await createImageBitmap(new Blob([image.bytes], { type: image.mimeType }));
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
        const bounds = document.querySelector('input').getBoundingClientRect();
        const value = Array.from(context.getImageData(bounds.x + 5, bounds.y + 5, 1, 1).data);
        bitmap.close(); return value;
      }, completed.data.id);
      if (privacy === 'redact') assert.deepEqual(pixel, [24, 24, 27, 255]);
      else assert.notDeepEqual(pixel, [24, 24, 27, 255], 'visible screenshots contain the real field pixels, without black masks');
    }
  } finally { await page.close(); }
});

test('Chrome DOM fallback completes a real screenshot through an actionable form without page-global operations', async () => {
  const page = await fixture();
  try {
    await page.evaluate(async () => {
      const { installAgentDomTransport } = await import('/dist/browser/agent-transport.js');
      const root = document.querySelector('#toolbar').attachShadow({ mode: 'open' });
      let port;
      const operations = Object.fromEntries(Object.entries(window.controller.operations).map(([name, fn]) => [name, async input => {
        const result = await fn(input);
        port.publishArtifacts(window.controller.snapshot().artifacts.filter(artifact => artifact.status === 'available')
          .map(artifact => ({ id: artifact.id, ...window.controller.readFile(artifact.id) })));
        port.refresh(await window.controller.getContext());
        return result;
      }]));
      port = installAgentDomTransport({ root,
        getContext: () => window.controller.getContext(), operations,
        readFile: id => window.controller.readFile(id),
      });
      port.refresh(await window.controller.getContext());
      port.setCommandsEnabled(true);
    });
    const state = JSON.parse(await page.locator('[data-ai-context-agent-port-state]').textContent());
    assert.equal(await page.getByLabel('Solicitud del chat', { exact: true }).isVisible(), false, 'enabling chat access leaves its technical controls collapsed');
    await page.getByText('Acceso del chat', { exact: true }).click();
    const request = page.getByLabel('Solicitud del chat', { exact: true });
    const submit = page.getByRole('button', { name: 'Procesar pedido del chat', exact: true });
    assert.equal(await request.getAttribute('type'), 'text');
    async function command(requestId, operation, input, expectedRevision) {
      await request.fill(JSON.stringify({ version: '1.0', nonce: state.nonce, requestId, operation, input,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}) }));
      await submit.click();
      await page.waitForFunction(id => {
        const host = document.querySelector('#toolbar');
        const value = host.shadowRoot.querySelector('[data-ai-context-agent-result]').textContent;
        try { return JSON.parse(value).requestId === id; } catch { return false; }
      }, requestId);
      return JSON.parse(await page.locator('[data-ai-context-agent-result]').textContent());
    }
    // All operations from here use the real DOM form. No application global is executed.
    const prepared = await command('dom-begin', 'checkpoint', { label: 'Chrome browser screenshot', capture: { phase: 'begin' } }, state.revision);
    assert.equal(prepared.status, 'ok', JSON.stringify(prepared));
    assert.equal(await request.isVisible(), true, 'the external adapter can still deliver complete');
    assert.equal(await submit.isVisible(), true);
    const screenshot = await page.screenshot({ type: 'png', caret: 'initial' });
    const completed = await command('dom-complete', 'checkpoint', { capture: { phase: 'complete', token: prepared.data.capture.token,
      base64: screenshot.toString('base64'), capturedAt: new Date().toISOString(), pixelWidth: 1000, pixelHeight: 700,
      provider: 'real-playwright-browser-screenshot' } }, prepared.revision);
    assert.equal(completed.status, 'ok', JSON.stringify(completed));
    assert.equal(completed.data.redactionStatus, 'disabled');
    assert.equal(completed.data.capture.toolbarHidden, false);
    const id = completed.data.id;
    const [download] = await Promise.all([
      page.waitForEvent('download'), page.locator(`[data-ai-context-download-id="${id}"]`).click(),
    ]);
    const actual = await readFile(await download.path());
    assert.deepEqual(Array.from(actual.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(createHash('sha256').update(actual).digest('hex'), completed.data.sha256);
    const reconstructed = [];
    let offset = 0;
    do {
      const chunk = await command(`dom-chunk-${offset}`, 'readArtifactChunk', { artifactId: id, offset });
      assert.equal(chunk.status, 'ok');
      reconstructed.push(Buffer.from(chunk.data.base64, 'base64'));
      offset = chunk.data.nextOffset;
    } while (offset !== null);
    assert.deepEqual(Buffer.concat(reconstructed), actual, 'DOM chunks return the same genuine PNG bytes as the actual browser download');
    assert.equal(await page.locator('[data-ai-context-agent-result]').evaluate(element => element.tagName), 'SCRIPT');
    assert.equal(await page.locator('[data-ai-context-agent-result]').isVisible(), false, 'base64 and JSON are available to the agent without appearing in the interface');
    assert.equal(await page.getByRole('status').textContent(), 'Pedido completado');
    assert.equal(await request.inputValue(), '', 'successful requests do not leave screenshot base64 visible in the field');
    const failed = await command('dom-invalid', 'evaluate', {});
    assert.equal(failed.status, 'error');
    assert.equal(await page.getByRole('status').textContent(), failed.error.message);
    assert.ok((await request.inputValue()).includes('dom-invalid'), 'an unsuccessful request remains available for correction or retry');
  } finally { await page.close(); }
});
