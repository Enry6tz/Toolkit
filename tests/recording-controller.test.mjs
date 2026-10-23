import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewController } from '../dist/review/controller.js';
import { createReviewEngine } from '../dist/review/session.js';
import { validateReviewDraft } from '../dist/review/persistence.js';
import { sanitizeActivityBody } from '../dist/core/activity.js';
import { recordingJson } from '../dist/review/recording.js';

function fixture(fetch = () => Promise.resolve(new Response('{"flights":[]}', { headers: { 'content-type': 'application/json' } }))) {
  const microtasks = [];
  const listeners = new Map(), navigationListeners = new Map();
  const add = (map, type, listener) => { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(listener); };
  let captureCalls = 0;
  const document = { defaultView: null, documentElement: {}, querySelector: () => null,
    addEventListener(type, listener) { add(listeners, type, listener); }, removeEventListener(type, listener) { listeners.get(type)?.delete(listener); } };
  class Action {
    nodeType = 1; tagName = 'BUTTON'; isConnected = true; parentElement = null; ownerDocument = document;
    childNodes = { length: 0, item() { return null; } };
    constructor(label) { this.label = label; }
    matches(selector) { return selector.split(',').some(part => part.trim() === 'button'); }
    closest() { return this; } getRootNode() { return document; }
    getAttribute(name) { return name === 'aria-label' ? this.label : null; }
    getBoundingClientRect() { return { x: 20, y: 20, width: 100, height: 30 }; }
  }
  const view = { document, fetch, URL, Request, Element: Action, crypto: globalThis.crypto,
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    navigator: { mediaDevices: { getDisplayMedia() { captureCalls++; throw new Error('No screen picker is part of recording.'); }, setCaptureHandleConfig() {} } },
    location: { href: 'https://preview.example.test/pasajero/buscar-vuelos', origin: 'https://preview.example.test', pathname: '/pasajero/buscar-vuelos' },
    performance, queueMicrotask: task => microtasks.push(task), getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    addEventListener(type, listener) { add(listeners, type, listener); }, removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    navigation: { addEventListener(type, listener) { add(navigationListeners, type, listener); }, removeEventListener(type, listener) { navigationListeners.get(type)?.delete(listener); } },
  };
  document.defaultView = view;
  const controller = createReviewController({ locale: 'es', window: view, getTarget: () => null, review: { persistence: false },
    activity: { resources: [{ name: 'Vuelos', path: '/api/flights' }], maxBodyChars: 128 },
    getLegacyContext: async () => ({ schemaVersion: '1.0', markdown: '', context: { schemaVersion: '1.0', capturedAt: new Date().toISOString(),
      page: { url: view.location.href, pathname: view.location.pathname, title: 'Vuelos', viewport: { width: 1280, height: 800 } },
      build: { environment: 'preview' }, target: null, rules: [], privacy: { redactions: [] } } }),
  });
  return { controller, view, captureCalls: () => captureCalls,
    click(label) { const target = new Action(label); for (const listener of listeners.get('click') ?? []) listener({ type: 'click', composedPath: () => [target, document] }); },
    navigate(path) { const parsed = new URL(path, view.location.href); view.location.href = parsed.href; view.location.origin = parsed.origin; view.location.pathname = parsed.pathname;
      for (const listener of navigationListeners.get('currententrychange') ?? []) listener(); while (microtasks.length) microtasks.shift()(); },
  };
}
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('The recorded network preview did not become available.');
}
const fetches = controller => controller.snapshot().events.filter(event => event.kind === 'fetch');

test('importing complete JSON creates stopped work without collection, rejects invalid input atomically and can resume', async () => {
  const f = fixture();
  try {
    await f.controller.operations.beginRecording({ requestId: 'share-start', authorized: true });
    f.click('Acción compartida');
    await assert.rejects(f.controller.importRecording('{}'), /Detené/);
    await f.controller.operations.stopRecording({ requestId: 'share-stop' });
    const original = f.controller.snapshot(), json = recordingJson(await f.controller.getContext());
    await assert.rejects(f.controller.importRecording('{'), /JSON/);
    assert.deepEqual(f.controller.snapshot(), original);
    const beforeImport = Date.now();
    const marks = await f.controller.importRecording(json), imported = f.controller.snapshot();
    assert.deepEqual(marks, []); assert.notEqual(imported.session.id, original.session.id);
    assert.equal(imported.session.recording, 'stopped'); assert.equal(imported.steps.length, original.steps.length);
    assert(imported.steps.every(step => step.at === imported.session.startedAt && Date.parse(step.at) >= beforeImport));
    f.click('No se debe registrar'); await f.view.fetch('/api/flights');
    assert.equal(f.controller.snapshot().steps.length, imported.steps.length);
    assert.equal(f.controller.snapshot().events.length, imported.events.length);
    await f.controller.operations.startRecording({ requestId: 'import-resume', authorized: true, captureRequired: false });
    f.click('Acción nueva');
    assert(f.controller.snapshot().steps.some(step => step.label === 'Acción nueva'));
    assert.equal(f.captureCalls(), 0);
  } finally { f.controller.dispose(); }
});

test('a recording starts directly without a case form, screenshots or screen-sharing permission', async () => {
  const f = fixture();
  assert.equal((await f.controller.operations.beginRecording({ requestId: 'unauthorized' })).error.code, 'RECORDING_NOT_AUTHORIZED');
  const started = await f.controller.operations.beginRecording({ requestId: 'begin', authorized: true });
  assert.equal(started.status, 'ok');
  assert.equal(f.controller.snapshot().session.recording, 'active');
  assert.equal(f.controller.snapshot().case, undefined);
  assert.equal(f.controller.snapshot().artifacts.length, 0);
  assert.equal(f.controller.snapshot().steps[0].label, 'Inicio de la grabación');
  assert.equal(f.controller.snapshot().steps[0].recordingBoundary, 'start');
  assert.equal(f.captureCalls(), 0);
  const repeat = await f.controller.operations.beginRecording({ requestId: 'begin-again', authorized: true });
  assert.equal(repeat.data.session.id, started.data.session.id, 'a second click does not replace an active recording');
  const stopped = await f.controller.operations.stopRecording({ requestId: 'stop' });
  assert.equal(stopped.status, 'ok');
  assert.equal(stopped.data.discarded, true, 'start and stop alone do not leave an empty saved recording');
  assert.equal(f.controller.snapshot().session, null);
  assert.deepEqual(f.controller.snapshot().steps, []);
  assert.equal(f.controller.snapshot().artifacts.length, 0);
  assert.equal(f.captureCalls(), 0);
  f.controller.dispose();
});

test('resuming preserves the same recording, ignores the stopped interval and captures automatic fetch again', async () => {
  const f = fixture();
  try {
    await f.controller.operations.beginRecording({ requestId: 'resume-begin', authorized: true });
    f.click('Primera acción');
    await f.controller.operations.stopRecording({ requestId: 'resume-first-stop' });
    const original = f.controller.snapshot(), id = original.session.id;
    f.click('Fuera de la grabación');
    await f.view.fetch('/api/flights');
    assert.deepEqual(f.controller.snapshot().steps, original.steps);
    const resumed = await f.controller.operations.startRecording({ requestId: 'resume-same', sessionId: id, authorized: true, captureRequired: false });
    assert.equal(resumed.status, 'ok');
    assert.equal(f.controller.snapshot().session.id, id);
    assert.equal(f.controller.snapshot().session.recording, 'active');
    assert.ok(original.steps.every(step => f.controller.snapshot().steps.some(current => current.id === step.id)));
    assert.equal(f.controller.snapshot().steps.filter(step => step.label === 'Grabación reanudada').length, 1);
    await f.controller.operations.startRecording({ requestId: 'resume-same', sessionId: id, authorized: true });
    assert.equal(f.controller.snapshot().steps.filter(step => step.label === 'Grabación reanudada').length, 1);
    await f.view.fetch('/api/flights');
    const event = await until(() => fetches(f.controller)[0]?.responseBody && fetches(f.controller)[0]);
    assert.ok(f.controller.snapshot().steps.some(step => step.id === event.stepId && step.label === 'GET Vuelos'));
    await f.controller.operations.stopRecording({ requestId: 'resume-second-stop' });
    assert.equal(f.controller.snapshot().session.id, id);
    assert.equal(fetches(f.controller).length, 1);
    assert.equal(f.captureCalls(), 0);
  } finally { f.controller.dispose(); }
});

test('asynchronous body completion updates the original recorded event without duplicate fetches', async () => {
  let source;
  const response = new Response(new ReadableStream({ start(controller) { source = controller; } }), { status: 201, headers: { 'content-type': 'application/json' } });
  const f = fixture(() => Promise.resolve(response));
  await f.controller.operations.beginRecording({ requestId: 'begin-async', authorized: true });
  f.click('Buscar vuelos');
  assert.equal(await f.view.fetch('/api/flights', { method: 'POST', body: '{"destination":"SCL","password":"private-password"}' }), response);
  assert.equal(fetches(f.controller).length, 1);
  const originalId = fetches(f.controller)[0].id;
  assert.equal(fetches(f.controller)[0].status, 201);
  assert.equal(JSON.parse(fetches(f.controller)[0].requestBody.text).destination, 'SCL');
  source.enqueue(new TextEncoder().encode('{"results":["flight-1"],"access_token":"private-token"}')); source.close();
  const event = await until(() => fetches(f.controller)[0]?.responseBody?.text && fetches(f.controller)[0]);
  assert.equal(fetches(f.controller).length, 1);
  assert.equal(event.id, originalId);
  assert.deepEqual(JSON.parse(event.responseBody.text).results, ['flight-1']);
  assert.doesNotMatch(JSON.stringify(event), /private-password|private-token/);
  assert.equal(response.bodyUsed, false);
  const stopped = await f.controller.operations.stopRecording({ requestId: 'stop-async' });
  assert.equal(stopped.status, 'ok');
  assert.deepEqual(fetches(f.controller)[0].responseBody, event.responseBody);
  assert.equal(fetches(f.controller).length, 1);
  assert.equal(f.captureCalls(), 0);
  await response.text(); f.controller.dispose();
});

test('deleting the last meaningful step discards the stopped recording, while identical user boundary labels count as content', async () => {
  const f = fixture();
  await f.controller.operations.beginRecording({ requestId: 'last-step-start', authorized: true });
  const user = await f.controller.operations.checkpoint({ requestId: 'last-step-user', label: 'Inicio de la grabación' });
  assert.equal(user.status, 'ok');
  assert.equal(user.data.recordingBoundary, undefined);
  const stopped = await f.controller.operations.stopRecording({ requestId: 'last-step-stop' });
  assert.equal(stopped.data.discarded, undefined);
  assert.equal(f.controller.snapshot().steps.at(-1).recordingBoundary, 'stop');
  const removed = await f.controller.operations.removeStep({ requestId: 'last-step-remove', stepId: user.data.id });
  assert.equal(removed.status, 'ok');
  assert.equal(removed.data.discarded, true);
  assert.equal(f.controller.snapshot().session, null);
  assert.deepEqual(f.controller.snapshot().events, []);
  f.controller.dispose();
});

test('automatic pending requests and failed responses preserve recordings without a user interaction', async () => {
  for (const pending of [true, false]) {
    const f = fixture(pending ? () => new Promise(() => {}) : () => Promise.resolve(new Response('{"error":"unavailable"}', { status: 500, headers: { 'content-type': 'application/json' } })));
    await f.controller.operations.beginRecording({ requestId: `automatic-${pending}-start`, authorized: true });
    const request = f.view.fetch('/api/flights');
    if (!pending) { await request; await until(() => fetches(f.controller)[0]?.responseBody); }
    assert.equal(fetches(f.controller).length, 1);
    const stopped = await f.controller.operations.stopRecording({ requestId: `automatic-${pending}-stop` });
    assert.equal(stopped.data.discarded, undefined);
    assert.equal(f.controller.snapshot().session.recording, 'stopped');
    assert.equal(fetches(f.controller).length, 1);
    if (!pending) assert.equal(fetches(f.controller)[0].outcome, 'http_error');
    f.controller.dispose();
  }
});

test('same-origin subpage navigation remains in one recording and new clicks own their temporal fetch association', async () => {
  const f = fixture();
  await f.controller.operations.beginRecording({ requestId: 'begin-navigation', authorized: true });
  const sessionId = f.controller.snapshot().session.id;
  f.click('Buscar vuelos'); await f.view.fetch('/api/flights');
  await until(() => fetches(f.controller)[0]?.responseBody);
  f.navigate('/pasajero/reserva?flight=demo');
  assert.equal(f.controller.snapshot().session.recording, 'active');
  f.click('Revisar reserva'); await f.view.fetch('/api/reservations');
  await until(() => fetches(f.controller)[1]?.responseBody);
  await f.controller.operations.stopRecording({ requestId: 'stop-navigation' });
  const snapshot = f.controller.snapshot();
  assert.equal(snapshot.session.id, sessionId);
  assert.equal(snapshot.steps.filter(step => /^Naveg(?:ó|ación) a \/pasajero\/reserva$/.test(step.label) && step.pathname === '/pasajero/reserva').length, 1);
  const second = fetches(f.controller)[1];
  assert.equal(snapshot.steps.find(step => step.id === second.stepId).label, 'Revisar reserva');
  assert.equal(second.correlation, 'temporal');
  assert.equal(second.resource, 'Recurso no identificado');
  assert.equal(snapshot.artifacts.length, 0);
  f.controller.dispose();
});

test('query-only navigation is retained and ends the previous click association', async () => {
  const f = fixture();
  await f.controller.operations.beginRecording({ requestId: 'begin-query', authorized: true });
  f.click('Buscar vuelos');
  f.navigate('/pasajero/buscar-vuelos?destination=SCL');
  await f.view.fetch('/api/flights');
  await until(() => fetches(f.controller)[0]?.responseBody);
  const snapshot = f.controller.snapshot();
  assert.equal(snapshot.steps.filter(step => step.label === 'Navegó a /pasajero/buscar-vuelos').length, 1);
  assert.equal(snapshot.session.recording, 'active');
  const request = fetches(f.controller)[0];
  assert.equal(request.correlation, 'explicit', 'automatic fetch belongs directly to its own step, not the prior URL click');
  assert.equal(snapshot.steps.find(step => step.id === request.stepId)?.label, 'GET Vuelos');
  f.controller.dispose();
});

test('offline simulation is recorded explicitly, retains request previews and resets after stopping', async () => {
  let realRequests = 0;
  const f = fixture(() => { realRequests++; return Promise.resolve(new Response('actual')); });
  assert.equal((await f.controller.operations.setNetworkSimulation({ requestId: 'offline-before', mode: 'offline' })).error.code, 'RECORDING_NOT_AUTHORIZED');
  await f.controller.operations.beginRecording({ requestId: 'begin-offline', authorized: true });
  assert.equal((await f.controller.operations.setNetworkSimulation({ requestId: 'offline', mode: 'offline' })).status, 'ok');
  await assert.rejects(f.view.fetch('/api/flights', { method: 'POST', body: '{"destination":"SCL"}' }), TypeError);
  assert.equal(realRequests, 0);
  const event = fetches(f.controller)[0];
  assert.equal(event.simulation, 'offline'); assert.equal(event.simulated, true); assert.equal(event.outcome, 'network_error');
  assert.equal(JSON.parse(event.requestBody.text).destination, 'SCL');
  await f.controller.operations.stopRecording({ requestId: 'stop-offline' });
  assert.equal(f.controller.getNetworkSimulation(), 'normal');
  assert.deepEqual(fetches(f.controller)[0].requestBody, event.requestBody);
  assert.equal((await f.controller.operations.setNetworkSimulation({ requestId: 'after-stop', mode: 'slow' })).error.code, 'RECORDING_NOT_AUTHORIZED');
  await f.view.fetch('/api/flights'); assert.equal(realRequests, 1);
  f.controller.dispose();
});

test('engine body updates survive validated draft restoration and reject unsafe imported body fields', async () => {
  const engine = createReviewEngine();
  const scope = { origin: 'https://preview.example.test', pathname: '/flights' };
  assert.equal(engine.startSession({ requestId: 'engine-start', objective: 'Grabación', scope }).status, 'ok');
  assert.equal(engine.startRecording({ requestId: 'engine-record', authorized: true }).status, 'ok');
  const recorded = engine.recordEvent({ requestId: 'engine-fetch', kind: 'fetch', resource: 'Vuelos', method: 'POST', outcome: 'pending', status: null,
    simulated: true, simulation: 'slow', requestBody: { status: 'captured', charLimit: 128, text: '{"destination":"SCL","password":"unsafe-password"}', contentType: 'application/json' } });
  assert.equal(recorded.status, 'ok');
  const responseBody = sanitizeActivityBody({ status: 'truncated', charLimit: 24, text: '{"name":"Luna","token":"unsafe-token"}', contentType: 'application/json' });
  assert.equal(engine.updateNetworkEvent({ requestId: 'engine-update', eventId: recorded.data.id, outcome: 'success', status: 200, durationMs: 830, responseBody }).status, 'ok');
  engine.stopRecording({ requestId: 'engine-stop' });
  const draft = engine.exportDraft();
  const checked = await validateReviewDraft(draft, { origin: scope.origin });
  const restored = createReviewEngine();
  assert.equal((await restored.restoreDraft(checked)).status, 'ok');
  const event = restored.getSnapshot().events[0];
  assert.equal(event.simulation, 'slow'); assert.equal(event.simulated, true);
  assert.equal(event.status, 200); assert.deepEqual(event.responseBody, responseBody);
  assert.equal(JSON.parse(event.requestBody.text).destination, 'SCL');
  assert.doesNotMatch(JSON.stringify(event), /unsafe-password|unsafe-token/);
  const unsafe = structuredClone(draft); unsafe.snapshot.events[0].requestBody.text = '{"password":"unsafe-password"}';
  await assert.rejects(validateReviewDraft(unsafe, { origin: scope.origin }), /cuerpo de una consulta/);
  const extra = structuredClone(draft); extra.snapshot.events[0].requestBody.headers = { authorization: 'unsafe-header' };
  await assert.rejects(validateReviewDraft(extra, { origin: scope.origin }), /cuerpo de una consulta/);
});

test('deleting a stopped recording cannot erase another recording started concurrently', async () => {
  const f = fixture();
  await f.controller.operations.beginRecording({ requestId: 'race-first', authorized: true });
  f.click('Abrir lista de vuelos');
  await f.controller.operations.stopRecording({ requestId: 'race-first-stop' });
  const previous = f.controller.snapshot().session.id;
  const deletion = f.controller.deleteSavedRecording(previous).then(() => ({ status: 'ok' }), error => ({ status: 'error', message: error.message }));
  const starting = f.controller.operations.beginRecording({ requestId: 'race-second', authorized: true });
  const [removed, started] = await Promise.all([deletion, starting]);
  if (started.status === 'ok') {
    assert.equal(f.controller.snapshot().session?.id, started.data.session.id, 'a successful new recording must remain live after deletion resolves');
    assert.equal(f.controller.snapshot().session.recording, 'active');
  } else {
    assert.equal(removed.status, 'ok', 'one operation should complete; the conflicting operation may decline');
    assert.ok(['CAPABILITY_UNAVAILABLE', 'REVISION_CONFLICT'].includes(started.error.code));
    const retry = await f.controller.operations.beginRecording({ requestId: 'race-second-retry', authorized: true });
    assert.equal(retry.status, 'ok', 'the operation lock is released after deletion');
    assert.equal(f.controller.snapshot().session.id, retry.data.session.id);
  }
  f.controller.dispose();
});
