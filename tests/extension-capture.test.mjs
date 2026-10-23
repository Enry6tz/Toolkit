import assert from 'node:assert/strict';
import test from 'node:test';
import { createExtensionCaptureProvider } from '../dist/review/extension-capture.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=';
const MARKER = 'data-ai-context-capture-extension';
function fixture({ marked = true, respond, fastTimeout = false } = {}) {
  const listeners = new Map(), attributes = new Map(marked ? [[MARKER, '1']] : []), requests = [], timers = new Set();
  const document = { defaultView: null, documentElement: { getAttribute: name => attributes.get(name) ?? null } };
  const emit = (data, options = {}) => {
    for (const handler of listeners.get('message') ?? []) handler({ source: options.source ?? view, origin: options.origin ?? view.location.origin, data });
  };
  const reply = (request, values = {}) => emit({ source: 'ai-context-capture-extension', version: 1,
    type: request.type === 'capture-request' ? 'capture-result' : 'capture-status', requestId: request.requestId,
    href: request.href, ...(request.type === 'capture-status' ? { connected: true } : {
      ok: true, dataUrl: `data:image/png;base64,${PNG}`, capturedAt: new Date().toISOString(), viewport: { width: 1, height: 1, dpr: 1 },
    }), ...values });
  const view = {
    document, crypto: globalThis.crypto, atob,
    location: { href: 'https://app.example.test/animals?status=open', origin: 'https://app.example.test', protocol: 'https:' },
    addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler); },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
    setTimeout(handler, delay) { const timer = setTimeout(() => { timers.delete(timer); handler(); }, fastTimeout ? Math.min(delay, 15) : delay); timers.add(timer); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    postMessage(request, origin) {
      requests.push({ request, origin });
      queueMicrotask(() => respond ? respond(request, { reply, emit, view, attributes }) : reply(request));
    },
  };
  document.defaultView = view;
  const provider = createExtensionCaptureProvider(document);
  const capture = (overrides = {}) => provider.captureViewport({ document, viewport: { width: 1, height: 1, dpr: 1 }, pathname: '/animals', revision: 0,
    redactions: [], ready: Promise.resolve(), assertCurrent() {}, ...overrides });
  return { provider, capture, document, view, requests, emit, reply, attributes, timers, listeners };
}

test('extension provider verifies a live handshake instead of trusting a stale DOM marker', async () => {
  const f = fixture({ respond() {}, fastTimeout: true });
  assert.equal(f.provider.isConnected(), false);
  await assert.rejects(f.provider.connect(), error => error.code === 'CAPABILITY_UNAVAILABLE' && /ícono de la extensión/.test(error.message));
  assert.equal(f.provider.isConnected(), false);
  assert.equal(f.requests.length, 1);
  assert.equal(f.timers.size, 0);
  f.provider.disconnect();
});

test('connection and capture use the current origin, opaque IDs and actual PNG bytes without media permission APIs', async () => {
  const f = fixture();
  await f.provider.connect();
  assert.equal(f.provider.isConnected(), true);
  const frame = await f.capture();
  assert.equal(frame.provider, 'chrome-extension-visible-tab');
  assert.deepEqual(frame.bytes, new Uint8Array(Buffer.from(PNG, 'base64')));
  assert.equal(frame.pixelWidth, 1); assert.equal(frame.pixelHeight, 1);
  assert.ok(f.requests.every(({ request, origin }) => request.source === 'ai-context-toolbar' && request.version === 1
    && /^[a-f0-9-]{36}$/.test(request.requestId) && request.href === f.view.location.href && origin === f.view.location.origin));
  assert.equal(f.requests.filter(({ request }) => request.type === 'capture-request').length, 1);
  assert.equal(f.timers.size, 0);
  f.provider.disconnect();
  assert.equal(f.listeners.get('message').size, 0);
});

test('bridge ignores messages from a different window, origin, version or request', async () => {
  const f = fixture({ respond(request, { emit, view, reply }) {
    const message = { source: 'ai-context-capture-extension', version: 1, type: 'capture-status', requestId: request.requestId, connected: true, href: request.href };
    emit(message, { source: {} });
    emit(message, { origin: 'https://foreign.example.test' });
    emit({ ...message, source: 'other-script' });
    emit({ ...message, version: 2 });
    emit({ ...message, requestId: 'unrelated-request' });
    assert.equal(view.location.origin, 'https://app.example.test');
    reply(request);
  } });
  await f.provider.connect();
  assert.equal(f.provider.isConnected(), true);
  f.provider.disconnect();
});

test('capture waits for prepared paint and rechecks the page before retaining bytes', async () => {
  const f = fixture();
  await f.provider.connect();
  let release, checks = 0;
  const ready = new Promise(resolve => { release = resolve; });
  const pending = f.capture({ ready, assertCurrent() { checks++; } });
  await Promise.resolve();
  assert.equal(f.requests.filter(({ request }) => request.type === 'capture-request').length, 0);
  release(); await pending;
  assert.equal(checks, 2);
  f.provider.disconnect();
});

test('changed full URL, viewport, missing PNG bytes and extension errors fail explicitly', async () => {
  const cases = [
    [{ href: 'https://app.example.test/animals?status=closed' }, 'STALE_CAPTURE'],
    [{ viewport: { width: 2, height: 1, dpr: 1 } }, 'STALE_CAPTURE'],
    [{ dataUrl: 'blob:https://app.example.test/image' }, 'BINARY_TRANSPORT_UNAVAILABLE'],
    [{ dataUrl: 'data:image/png;base64,%%%%' }, 'BINARY_TRANSPORT_UNAVAILABLE'],
    [{ dataUrl: 'data:image/png;base64,aGVsbG8=' }, 'BINARY_TRANSPORT_UNAVAILABLE'],
    [{ capturedAt: 'unknown' }, 'STALE_CAPTURE'],
    [{ ok: false, error: 'La pestaña autorizada ya no está activa.' }, 'CAPABILITY_UNAVAILABLE'],
  ];
  for (const [values, code] of cases) {
    const f = fixture({ respond(request, { reply }) { reply(request, request.type === 'capture-request' ? values : {}); } });
    await f.provider.connect();
    await assert.rejects(f.capture(), error => error.code === code, JSON.stringify(values));
    assert.equal(f.timers.size, 0);
    f.provider.disconnect();
  }
});

test('disconnect cancels pending capture requests and cannot leave a connected stale page', async () => {
  let capturing;
  const requested = new Promise(resolve => { capturing = resolve; });
  const f = fixture({ respond(request, { reply }) { if (request.type === 'capture-status') reply(request); else capturing(); } });
  await f.provider.connect();
  const pending = f.capture();
  await requested;
  f.provider.disconnect();
  await assert.rejects(pending, error => error.code === 'CAPABILITY_UNAVAILABLE');
  assert.equal(f.provider.isConnected(), false);
  assert.equal(f.timers.size, 0);
});
