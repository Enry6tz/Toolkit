import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePublicQueryParams, sanitizeUrl } from '../dist/core/privacy.js';
import { sanitizeContext, createArtifact } from '../dist/core/artifacts.js';
import { createAgentContext } from '../dist/core/agent.js';
import { captureContext } from '../dist/browser/context.js';

const publicKeys = ['origin', 'destination', 'date', 'returnDate', 'passengers', 'trip', 'cabin'];
const url = 'http://user:password@localhost:3002/pasajero/buscar-vuelos?origin=EZE&destination=BRC&date=2026-10-21&returnDate=2026-10-28&passengers=1&trip=one-way&cabin=economy&token=hidden-value&email=qa%40example.test#private';
const expected = 'http://localhost:3002/pasajero/buscar-vuelos?origin=EZE&destination=BRC&date=2026-10-21&returnDate=2026-10-28&passengers=1&trip=one-way&cabin=economy';
const snapshot = (keys = publicKeys) => ({ schemaVersion: '1.0', capturedAt: '2026-10-14T23:00:00.000Z',
  page: { url, pathname: '/pasajero/buscar-vuelos', publicQueryParams: keys, title: 'Buscar vuelos', viewport: { width: 1920, height: 889 } },
  build: { environment: 'preview', buildId: 'sigv-query-proof' }, target: null, rules: [], privacy: { redactions: [] },
});

test('public functional route state survives only an explicit allowlist; the default still removes every query', () => {
  assert.equal(sanitizeUrl(url), 'http://localhost:3002/pasajero/buscar-vuelos');
  assert.equal(sanitizeUrl(url, publicKeys), expected);
  assert.equal(sanitizeUrl(expected, publicKeys), expected, 'repeated sanitization keeps the same functional state');
  assert.equal(sanitizeUrl('javascript:alert(1)', publicKeys), '[URL no disponible]');
});

test('imported allowlists cannot retain common private names, secret values or unbounded route state', () => {
  const unsafeKeys = ['origin', 'origin', 'token', 'refreshToken', 'password', 'passwd', 'apiKey', 'key', 'private-key', 'sessionId',
    'cookie', 'authorization', 'email', 'phone', 'csrf', 'jwt', 'Bearer', 'bad[]', 'x'.repeat(49), 1, null];
  assert.deepEqual(normalizePublicQueryParams(unsafeKeys), ['origin']);
  assert.deepEqual(normalizePublicQueryParams('origin'), []);
  assert.equal(sanitizeUrl('https://example.test/search?origin=EZE&token=x&sessionId=y&apiKey=z', unsafeKeys), 'https://example.test/search?origin=EZE');
  const state = new URL('https://example.test/search');
  state.searchParams.set('origin', 'qa@example.test');
  state.searchParams.set('destination', 'Bearer unsafe-credential');
  state.searchParams.set('date', 'https://other.example.test/?token=private');
  state.searchParams.set('returnDate', 'A'.repeat(257));
  state.searchParams.set('trip', 'one-way');
  assert.equal(sanitizeUrl(state.href, publicKeys), 'https://example.test/search?trip=one-way');
  assert.equal(sanitizeUrl('https://example.test/?origin=A&origin=B&origin=C&origin=D&origin=E', ['origin']),
    'https://example.test/?origin=A&origin=B&origin=C&origin=D');
  const boundedKeys = Array.from({ length: 50 }, (_, i) => `filter${i}`);
  const bounded = new URL('https://example.test/search');
  for (const key of boundedKeys) bounded.searchParams.set(key, 'A'.repeat(256));
  const cleaned = sanitizeUrl(bounded.href, boundedKeys);
  assert.ok(new URL(cleaned).search.length <= 3073);
  assert.ok(normalizePublicQueryParams(boundedKeys).length <= 20);
  assert.equal(sanitizeUrl(cleaned, boundedKeys), cleaned);
});

test('context, agent handoff and artifact retain the declared URL state and the pathname stays path-only', () => {
  const safe = sanitizeContext(snapshot([...publicKeys, 'token', 'email', 'sessionId']));
  assert.equal(safe.page.url, expected);
  assert.equal(safe.page.pathname, '/pasajero/buscar-vuelos');
  assert.deepEqual(safe.page.publicQueryParams, publicKeys);
  assert.deepEqual(sanitizeContext(safe), safe);
  assert.match(safe.privacy.redactions.join('\n'), /Solo parámetros de URL declarados públicos/);
  assert.doesNotMatch(safe.privacy.redactions.join('\n'), /^Parámetros de URL, fragmentos/m);
  const handoff = createAgentContext(safe);
  assert.equal(handoff.context.page.url, expected);
  const artifact = createArtifact({ mode: 'report', title: 'Validar búsqueda', detail: 'Comparar la búsqueda con los parámetros declarados.' }, safe);
  assert.equal(artifact.json.context.page.url, expected);
  assert.match(artifact.markdown, /origin=EZE&destination=BRC/);
  assert.doesNotMatch(JSON.stringify(handoff), /hidden-value|qa%40example|user:password|#private/);
  const removed = sanitizeContext(snapshot('origin'));
  assert.equal(removed.page.url, 'http://localhost:3002/pasajero/buscar-vuelos');
  assert.equal(removed.page.publicQueryParams, undefined);
});

test('browser capture carries validated functional query metadata without reading editable field values', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: url, pathname: '/pasajero/buscar-vuelos' }, innerWidth: 1920, innerHeight: 889 } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { title: 'Buscar vuelos',
      querySelectorAll() { assert.fail('route metadata must not inspect form values'); },
    } });
    const captured = captureContext({ build: { environment: 'production' }, publicQueryParams: [...publicKeys, 'token'] });
    assert.equal(captured.page.url, expected);
    assert.deepEqual(captured.page.publicQueryParams, publicKeys);
    assert.deepEqual(sanitizeContext(captured).page, captured.page);
    const defaultCapture = captureContext({ build: { environment: 'production' } });
    assert.equal(defaultCapture.page.url, 'http://localhost:3002/pasajero/buscar-vuelos');
    assert.equal(defaultCapture.page.publicQueryParams, undefined);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else delete globalThis.window;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else delete globalThis.document;
  }
});
