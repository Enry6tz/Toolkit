import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createReviewController } from '../dist/review/controller.js';

function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(options = {}) {
  const microtasks = [];
  const listeners = new Map(), navigationListeners = new Map();
  const add = (map, type, handler) => { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(handler); };
  const document = { documentElement: {}, defaultView: null, querySelector: () => null,
    addEventListener(type, handler) { add(listeners, type, handler); }, removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
  };
  const originalFetch = () => Promise.resolve(new Response('ok'));
  const view = {
    document, fetch: originalFetch, URL, Request, crypto: globalThis.crypto, navigator: {}, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    location: { origin: 'https://preview.example.test', pathname: '/animals', href: 'https://preview.example.test/animals' },
    performance: { now: () => 0 }, queueMicrotask: task => microtasks.push(task),
    addEventListener(type, handler) { add(listeners, type, handler); }, removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
    navigation: { addEventListener(type, handler) { add(navigationListeners, type, handler); }, removeEventListener(type, handler) { navigationListeners.get(type)?.delete(handler); } },
  };
  document.defaultView = view;
  const context = (pathname = view.location.pathname) => ({ schemaVersion: '1.0', markdown: '', context: {
    schemaVersion: '1.0', capturedAt: new Date().toISOString(), page: { url: `${view.location.origin}${pathname}`, pathname, title: 'Animales', viewport: { width: view.innerWidth, height: view.innerHeight } },
    build: { environment: 'preview' }, target: null, rules: [], privacy: { redactions: [] },
  } });
  const controller = createReviewController({ locale: 'es', window: view, getTarget: () => null, getLegacyContext: options.getLegacyContext ?? (async () => context()),
    activity: { resources: [{ name: 'Animales', path: '/api/animals' }] }, ...options });
  return { controller, view, originalFetch, context,
    navigate(pathname, origin = view.location.origin) { view.location.origin = origin; view.location.pathname = pathname; view.location.href = `${origin}${pathname}`; for (const listener of navigationListeners.get('currententrychange') ?? []) listener(); while (microtasks.length) microtasks.shift()(); },
    listeners, navigationListeners,
  };
}
async function start(f) { return f.controller.operations.startSession({ requestId: 'session', objective: 'Revisar animales', actor: 'agent' }); }
async function prepareCase(f) {
  await f.controller.getContext();
  const started = await f.controller.operations.startCase({ requestId: 'case-start', mode: 'test', title: 'Revisar el buscador' });
  assert.equal(started.status, 'ok');
  const result = await f.controller.operations.prepareCase({ requestId: 'case-prepare', caseId: started.data.id, expectedRevision: f.controller.snapshot().revision });
  assert.equal(result.status, 'ok');
  return result;
}

test('opening a browser assistant side panel preserves a prepared case across viewport-only context reads', async () => {
  const f = fixture();
  const prepared = await prepareCase(f);
  const revision = prepared.revision;
  f.view.innerWidth = 920; f.view.innerHeight = 792;
  const current = await f.controller.getContext();
  assert.deepEqual(current.context.page.viewport, { width: 920, height: 792 });
  assert.equal(current.review.case.status, 'prepared');
  assert.equal(current.revision, revision, 'viewport metadata is not a new case evidence revision');
  f.controller.dispose();
});

test('the case packet guides refinement in the chat without asking for a toolbar return, approval or export', async () => {
  const f = fixture();
  await f.controller.operations.startCase({ requestId: 'one-way-case', mode: 'report', title: 'Revisar el listado' });
  const current = await f.controller.getContext();
  assert.match(current.instructions, /este chat como Markdown listo para copiar/);
  assert.match(current.instructions, /marcas, notas, documentos y recorrido/);
  assert.doesNotMatch(current.instructions, /submitRefinement|aprueba en la toolbar|Devolvé una propuesta/);
  assert.deepEqual(await f.controller.listSavedCases(), []);
  await assert.rejects(f.controller.restoreSavedCase('unknown-local-id'), /historial local no está disponible/);
  f.controller.dispose();
});

test('case geometry, focus and hover remain live observations without revoking prepared evidence; target semantics still invalidate CAS', async () => {
  let f, label = 'Buscar vuelos', hovered = false, disabled = false;
  let bounds = { x: 20, y: 30, width: 120, height: 40 };
  const target = { isConnected: true, ownerDocument: null, parentElement: null, localName: 'button',
    getRootNode: () => f.view.document,
    getBoundingClientRect: () => ({ ...bounds }),
    getAttribute: () => null, contains: node => node === target,
    matches: selector => selector === ':hover' ? hovered : selector === ':disabled, [aria-disabled="true"]' && disabled,
  };
  f = fixture({ getTarget: () => target, getLegacyContext: async () => {
    const value = f.context();
    value.context.target = { tag: 'button', role: 'button', accessibleName: label, text: label,
      selector: '[data-ai-id="search"]', bounds: { ...bounds } };
    return value;
  } });
  target.ownerDocument = f.view.document;
  f.view.getComputedStyle = () => ({ display: 'block', visibility: 'visible', getPropertyValue: key =>
    key === 'width' ? `${bounds.width}px` : key === 'outline-color' ? hovered ? 'rgb(100, 90, 200)' : 'rgb(20, 20, 20)' : '' });
  const prepared = await prepareCase(f);
  f.view.innerWidth = 920; f.view.innerHeight = 792;
  bounds = { x: 8, y: -30, width: 90, height: 40 }; hovered = true;
  f.view.document.activeElement = target;
  const resized = await f.controller.getContext();
  assert.equal(resized.review.case.status, 'prepared');
  assert.equal(resized.revision, prepared.revision);
  assert.deepEqual(resized.context.target.bounds, bounds);
  assert.deepEqual(resized.design.observed.bounds, bounds);
  assert.equal(resized.design.observed.styles.width, '90px');
  assert.ok(resized.design.observed.states.includes('focus'));
  assert.ok(resized.design.observed.states.includes('hover'));
  label = 'No se pudo buscar';
  const changed = await f.controller.getContext();
  assert.equal(changed.review.case.status, 'draft');
  assert.ok(changed.revision > prepared.revision);
  const stale = await f.controller.operations.submitRefinement({ requestId: 'stale-case-return', caseId: changed.review.case.id, expectedRevision: prepared.revision,
    proposal: { title: 'Propuesta antigua', steps: [], expected: '' } });
  assert.equal(stale.error.code, 'REVISION_CONFLICT');
  const preparedAgain = await f.controller.operations.prepareCase({ requestId: 'prepare-current-semantics', caseId: changed.review.case.id,
    expectedRevision: changed.revision });
  assert.equal(preparedAgain.status, 'ok');
  disabled = true;
  const disabledContext = await f.controller.getContext();
  assert.equal(disabledContext.review.case.status, 'draft', 'disabled is a functional state, unlike focus or hover');
  assert.ok(disabledContext.revision > preparedAgain.revision);
  f.controller.dispose();
});

test('case note, rule and document edits still revoke preparation while preserving original evidence', async () => {
  for (const kind of ['note', 'rule', 'document']) {
    let f, note = 'Revisar el buscador', rule = 'Origen y destino distintos', content = 'Regla publicada';
    const markedAt = new Date().toISOString();
    f = fixture({ getLegacyContext: async () => {
      const value = f.context();
      value.context.rules = [rule];
      value.context.knowledge = { schemaVersion: '1.0', documents: [{ id: 'domain', label: 'Dominio', content, checksum: createHash('sha256').update(content).digest('hex') }] };
      value.context.annotations = [{ id: 'saved-mark', kind: 'area', pathname: '/animals', createdAt: markedAt, updatedAt: markedAt,
        label: 'Buscador', note, bounds: { x: 20, y: 30, width: 120, height: 40 }, viewport: { width: 1280, height: 800 }, element: null, relatedElements: [] }];
      return value;
    } });
    const prepared = await prepareCase(f);
    if (kind === 'note') note = 'Nueva observación del usuario';
    else if (kind === 'rule') rule = 'Regla de negocio modificada';
    else content = 'Documento modificado';
    const changed = await f.controller.getContext();
    assert.equal(changed.review.case.status, 'draft', kind);
    assert.ok(changed.revision > prepared.revision, kind);
    assert.equal(changed.review.case.preparedRevision, undefined);
    assert.equal(changed.review.case.original.title, 'Revisar el buscador');
    f.controller.dispose();
  }
});

test('legacy viewport context changes keep their existing privacy revision policy', async () => {
  const f = fixture(); await start(f);
  const reviewed = await f.controller.operations.reviewPrivacy({ requestId: 'legacy-review', confirmed: true, expectedRevision: f.controller.snapshot().revision });
  assert.equal(reviewed.status, 'ok');
  f.view.innerWidth = 920;
  const changed = await f.controller.getContext();
  assert.ok(changed.revision > reviewed.revision);
  assert.equal(changed.review.privacy.reviewedRevision, null);
  f.controller.dispose();
});

test('controller read and session start do not instrument fetch, and unavailable capture still allows authorized abstract recording', async () => {
  const f = fixture();
  assert.equal((await f.controller.getContext()).review.session, null);
  assert.equal(f.view.fetch, f.originalFetch);
  await start(f);
  assert.equal(f.view.fetch, f.originalFetch);
  const result = await f.controller.operations.startRecording({ requestId: 'record', authorized: true, captureRequired: false });
  assert.equal(result.status, 'ok');
  assert.equal(result.data.capture, null);
  assert.equal(f.controller.snapshot().partial.isPartial, false);
  assert.deepEqual(f.controller.snapshot().artifacts, []);
  assert.notEqual(f.view.fetch, f.originalFetch);
  await f.view.fetch('/api/animals');
  await f.view.fetch('/api/animals');
  assert.equal(f.controller.snapshot().events.length, 2);
  assert.equal(f.controller.snapshot().session.recording, 'active');
  assert.equal(f.controller.activityEntries().length, 2);
  const stopped = await f.controller.operations.stopRecording({ requestId: 'stop' });
  assert.equal(stopped.data.capture, null);
  assert.deepEqual(f.controller.snapshot().artifacts, []);
  assert.equal(f.controller.snapshot().session.recording, 'stopped');
  assert.equal(f.view.fetch, f.originalFetch);
  f.controller.dispose();
});

test('concurrent fetches outliving the activity buffer remain in the case as incomplete and completed requests', async () => {
  const first = deferred(), second = deferred();
  const f = fixture({ activity: { resources: [{ name: 'Vuelos', path: '/api/flights' }], maxEntries: 1 } });
  let issued = 0;
  f.view.fetch = () => (++issued === 1 ? first.promise : second.promise);
  await start(f);
  await f.controller.operations.startRecording({ requestId: 'record-concurrent', authorized: true, captureRequired: false });
  const firstRequest = f.view.fetch('/api/flights'), secondRequest = f.view.fetch('/api/flights');
  const [incomplete] = f.controller.snapshot().events;
  assert.equal(incomplete.resource, 'Vuelos');
  assert.equal(incomplete.outcome, 'incomplete');
  assert.equal(incomplete.status, null);
  second.resolve(new Response('second response', { status: 200 }));
  assert.equal((await secondRequest).status, 200);
  first.resolve(new Response('late first response', { status: 503 }));
  assert.equal((await firstRequest).status, 503, 'instrumentation preserves the application response');
  const events = f.controller.snapshot().events;
  assert.equal(events.length, 2, 'both issued requests remain in the durable case');
  assert.deepEqual(events[0], incomplete, 'a response after eviction never invents a result for the frozen event');
  assert.equal(events[1].resource, 'Vuelos');
  assert.equal(events[1].outcome, 'success');
  assert.equal(events[1].status, 200);
  assert.equal(f.controller.snapshot().session.recording, 'active');
  f.controller.dispose();
});

test('flushing an evicted fetch obeys the engine event limit without appending after recording stops', async () => {
  const response = deferred();
  const f = fixture({ activity: { resources: [{ name: 'Vuelos', path: '/api/flights' }], maxEntries: 1 }, review: { limits: { maxEvents: 2 } } });
  const originalFetch = () => response.promise;
  f.view.fetch = originalFetch;
  await start(f);
  await f.controller.operations.startRecording({ requestId: 'record-concurrent-limit', authorized: true, captureRequired: false });
  const requests = [f.view.fetch('/api/flights'), f.view.fetch('/api/flights'), f.view.fetch('/api/flights')];
  const snapshot = f.controller.snapshot();
  assert.equal(snapshot.session.recording, 'stopped');
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].outcome, 'incomplete');
  assert.equal(snapshot.partial.isPartial, true);
  assert.equal(snapshot.partial.droppedEvents, 1);
  assert.equal(f.view.fetch, originalFetch);
  response.resolve(new Response('still delivered'));
  await Promise.all(requests);
  assert.deepEqual(f.controller.snapshot(), snapshot, 'late responses cannot reopen or mutate a stopped recording');
  f.controller.dispose();
});

test('toolbar unload flushing never cancels application navigation and only pagehide stops the recording', async () => {
  const f = fixture();
  await f.controller.operations.startCase({ requestId: 'navigation-case', mode: 'test', title: 'Enviar un formulario normal' });
  await f.controller.operations.startRecording({ requestId: 'navigation-record', authorized: true, captureRequired: false });
  let prevented = 0;
  const event = { preventDefault() { prevented++; }, returnValue: 'untouched-by-toolbar' };
  for (const listener of f.listeners.get('beforeunload') ?? []) listener(event);
  assert.equal(prevented, 0);
  assert.equal(event.returnValue, 'untouched-by-toolbar');
  assert.equal(f.controller.snapshot().session.recording, 'active', 'another application guard can still cancel navigation without stopping this visit');
  for (const listener of f.listeners.get('pagehide') ?? []) listener();
  assert.equal(f.controller.snapshot().session.recording, 'stopped');
  assert.equal(f.view.fetch, f.originalFetch);
  f.controller.dispose();
  assert.equal(f.listeners.get('beforeunload').size, 0);
  assert.equal(f.listeners.get('pagehide').size, 0);
  assert.equal(f.listeners.get('visibilitychange').size, 0);
});

test('Navigation API keeps same-origin subpages in the recording and stops before another origin can capture or export', async () => {
  const f = fixture(); await start(f); await f.controller.operations.startRecording({ requestId: 'record', authorized: true });
  const before = f.controller.snapshot().revision;
  const wrapped = f.view.fetch;
  f.navigate('/care');
  assert.equal(f.controller.snapshot().session.recording, 'active');
  assert.equal(f.view.fetch, wrapped);
  assert.equal(f.controller.snapshot().session.scope.pathname, '/care');
  assert.equal(f.controller.snapshot().steps.at(-1).label, 'Navegó a /care');
  assert.ok(f.controller.snapshot().revision > before);
  assert.equal((await f.controller.operations.checkpoint({ requestId: 'subpage', label: 'Cuidados' })).status, 'ok');
  const fresh = await f.controller.getContext(); assert.equal(fresh.context.page.pathname, '/care');
  f.navigate('/care', 'https://another.example.test');
  assert.equal(f.controller.snapshot().session.recording, 'stopped');
  assert.equal(f.view.fetch, f.originalFetch);
  assert.equal((await f.controller.operations.checkpoint({ requestId: 'outside', label: 'Otro origen', capture: { mode: 'native' } })).error.code, 'STALE_TARGET');
  assert.equal((await f.controller.operations.startRecording({ requestId: 'outside-record', authorized: true })).error.code, 'STALE_TARGET');
  assert.equal((await f.controller.operations.exportBundle({ requestId: 'outside-export', profile: 'bug', expectedRevision: f.controller.snapshot().revision })).error.code, 'STALE_TARGET');
  f.controller.dispose();
  assert.equal(f.navigationListeners.get('currententrychange').size, 0);
});

test('a rapid route change and return end old click correlation without rewriting requests already in flight', async () => {
  const pending = deferred();
  const f = fixture();
  const document = f.view.document;
  let elapsed = 100, issued = 0;
  f.view.performance.now = () => elapsed;
  f.view.fetch = () => ++issued === 1 ? pending.promise : Promise.resolve(new Response('current visit', { status: 200 }));
  class Action {
    nodeType = 1;
    isConnected = true;
    parentElement = null;
    ownerDocument = document;
    tagName = 'BUTTON';
    childNodes = { length: 0, item() { return null; } };
    constructor(label) { this.label = label; }
    matches(selector) { return selector.split(',').some(part => part.trim() === 'button'); }
    closest() { return this; }
    getRootNode() { return document; }
    getAttribute(name) { return name === 'aria-label' ? this.label : null; }
    getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 30 }; }
  }
  f.view.Element = Action;
  f.view.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  const click = label => {
    const action = new Action(label);
    for (const listener of f.listeners.get('click') ?? []) listener({ type: 'click', composedPath: () => [action, document] });
  };
  await start(f);
  await f.controller.operations.startRecording({ requestId: 'record-route-boundaries', authorized: true, captureRequired: false });
  click('Iniciar sesión');
  const previousRequest = f.view.fetch('/api/animals');
  elapsed = 200;
  f.navigate('/care');
  elapsed = 300;
  f.navigate('/animals');
  elapsed = 350;
  await f.view.fetch('/api/animals');
  elapsed = 400;
  click('Actualizar animales');
  await f.view.fetch('/api/animals');
  pending.resolve(new Response('previous visit', { status: 201 }));
  assert.equal((await previousRequest).status, 201);

  const snapshot = f.controller.snapshot();
  const previousStep = snapshot.steps.find(step => step.label === 'Iniciar sesión');
  const currentStep = snapshot.steps.find(step => step.label === 'Actualizar animales');
  assert.ok(previousStep && currentStep);
  const requests = snapshot.events.filter(event => event.kind === 'fetch');
  assert.equal(requests.length, 3);
  assert.equal(requests.find(event => event.status === 201).stepId, previousStep.id, 'a request started before navigation keeps its observed action');
  assert.equal(requests.filter(event => event.status === 200)[0].stepId, undefined, 'a background request after returning cannot inherit the old click');
  assert.equal(requests.filter(event => event.status === 200)[0].correlation, undefined);
  assert.equal(requests.filter(event => event.status === 200)[1].stepId, currentStep.id, 'a new public action on the current visit may correlate temporally');
  const activity = f.controller.activityEntries();
  const previousAction = activity.find(entry => entry.kind === 'interaction' && entry.label === 'Iniciar sesión');
  const currentAction = activity.find(entry => entry.kind === 'interaction' && entry.label === 'Actualizar animales');
  const rawRequests = activity.filter(entry => entry.kind === 'fetch');
  assert.equal(rawRequests[0].interactionId, previousAction.id);
  assert.equal(rawRequests[1].interactionId, null, 'the public activity packet also ends the old correlation');
  assert.equal(rawRequests[1].correlation, null);
  assert.equal(rawRequests[2].interactionId, currentAction.id);
  assert.equal(snapshot.session.recording, 'active');
  f.controller.dispose();
});

test('stale async legacy reads fail rather than mixing a previous page context with a current session revision', async () => {
  const wait = deferred();
  const f = fixture({ getLegacyContext: () => wait.promise });
  const pending = f.controller.getContext();
  f.navigate('/care'); wait.resolve(f.context('/animals'));
  await assert.rejects(pending, error => error.code === 'STALE_TARGET');
  f.controller.dispose();
});

test('stale end/stop inputs never stop the actual recorder and event limits synchronize actual collection state', async () => {
  const f = fixture({ review: { limits: { maxEvents: 2 } } });
  await start(f); await f.controller.operations.startRecording({ requestId: 'record', authorized: true });
  const wrapped = f.view.fetch;
  assert.equal((await f.controller.operations.endSession({ requestId: 'wrong-session', sessionId: 'other' })).error.code, 'SESSION_NOT_FOUND');
  assert.equal((await f.controller.operations.stopRecording({ requestId: 'wrong-revision', expectedRevision: 0 })).error.code, 'REVISION_CONFLICT');
  assert.equal(f.view.fetch, wrapped);
  await f.view.fetch('/api/animals'); await f.view.fetch('/api/animals');
  assert.equal(f.controller.snapshot().partial.droppedEvents, 1);
  assert.equal(f.controller.snapshot().session.recording, 'stopped');
  assert.equal(f.view.fetch, f.originalFetch);
  f.controller.dispose();
});

test('export retries validate current privacy and revision; artifact reads return real ZIP bytes without caching mutable data', async () => {
  const f = fixture(); await start(f);
  await f.controller.operations.checkpoint({ requestId: 'point', label: 'Listado visible' });
  const confirm = await f.controller.operations.reviewPrivacy({ requestId: 'privacy', confirmed: true, expectedRevision: f.controller.snapshot().revision });
  const input = { requestId: 'export', expectedRevision: confirm.revision, profile: 'bug' };
  const exported = await f.controller.operations.exportBundle(input);
  assert.equal(exported.status, 'ok'); assert.equal(exported.data.status, 'draft');
  const file = await f.controller.operations.getArtifact({ artifactId: exported.data.bundleId, transport: 'base64' });
  assert.equal(file.status, 'ok'); assert.equal(Buffer.from(file.data.base64, 'base64').subarray(0, 2).toString(), 'PK');
  const retry = await f.controller.operations.exportBundle(input); assert.deepEqual(retry, exported);
  exported.data.bundleId = 'client-mutation';
  assert.notEqual((await f.controller.operations.exportBundle(input)).data.bundleId, 'client-mutation');
  await f.controller.operations.updateNotes({ requestId: 'notes', stepId: f.controller.snapshot().steps[0].id, notes: 'Nueva evidencia declarada' });
  assert.equal((await f.controller.operations.exportBundle(input)).error.code, 'REVISION_CONFLICT');
  assert.equal((await f.controller.operations.exportBundle({ ...input, expectedRevision: f.controller.snapshot().revision })).error.code, 'PRIVACY_REVIEW_REQUIRED');
  assert.equal((await f.controller.operations.getArtifact({ artifactId: file.data.artifactId, transport: 'blob-url' })).error.code, 'BINARY_TRANSPORT_UNAVAILABLE');
  f.controller.dispose();
});

test('a new selected element invalidates the package privacy revision without starting collection', async () => {
  let selected = null;
  const f = fixture({ getTarget: () => selected });
  f.view.getComputedStyle = () => ({ display: 'block', visibility: 'visible', getPropertyValue: () => '' });
  const element = () => ({ ownerDocument: f.view.document, isConnected: true, parentElement: null, localName: 'button', matches: () => false,
    getRootNode: () => f.view.document, getBoundingClientRect: () => ({ x: 0, y: 0, width: 50, height: 20 }), getAttribute: () => null, contains: () => false });
  selected = element();
  await start(f);
  await f.controller.operations.reviewPrivacy({ requestId: 'privacy', confirmed: true, expectedRevision: f.controller.snapshot().revision });
  const oldRevision = f.controller.snapshot().revision;
  selected = element(); f.controller.updateLocation();
  assert.ok(f.controller.snapshot().revision > oldRevision);
  assert.equal(f.controller.snapshot().privacy.reviewedRevision, null);
  assert.equal(f.view.fetch, f.originalFetch);
  f.controller.dispose();
});

test('changed public rules are detected before exporting a previously approved context', async () => {
  let f; const rules = ['Nombre requerido'];
  f = fixture({ getLegacyContext: async () => { const value = f.context(); value.context.rules = [...rules]; return value; } });
  await start(f);
  const privacy = await f.controller.operations.reviewPrivacy({ requestId: 'privacy', confirmed: true, expectedRevision: f.controller.snapshot().revision });
  assert.equal(privacy.status, 'ok');
  rules.push('Peso positivo');
  const exported = await f.controller.operations.exportBundle({ requestId: 'export', profile: 'bug', expectedRevision: privacy.revision });
  assert.equal(exported.error.code, 'REVISION_CONFLICT');
  assert.equal(f.controller.snapshot().privacy.reviewedRevision, null);
  f.controller.dispose();
});

test('expired capture completion is rejected after a subpage change and a new preparation remains forbidden on another origin', async () => {
  const f = fixture(); await start(f); f.navigate('/care');
  const late = await f.controller.operations.checkpoint({ requestId: 'late-complete', capture: { phase: 'complete', token: 'unknown-or-expired' } });
  assert.equal(late.error.code, 'STALE_CAPTURE');
  assert.equal((await f.controller.operations.checkpoint({ requestId: 'new-subpage', label: 'Otro estado' })).status, 'ok');
  f.navigate('/care', 'https://another.example.test');
  const begin = await f.controller.operations.checkpoint({ requestId: 'outside-begin', label: 'Otro estado', capture: { phase: 'begin' } });
  assert.equal(begin.error.code, 'STALE_TARGET');
  f.controller.dispose();
});

test('different exports of one revision keep distinct byte references and retries retain the same package', async () => {
  const f = fixture(); await start(f);
  const review = await f.controller.operations.reviewPrivacy({ requestId: 'privacy-distinct', confirmed: true, expectedRevision: f.controller.snapshot().revision });
  const firstInput = { requestId: 'export-first', profile: 'bug', expectedRevision: review.revision, impact: 'Primer impacto declarado' };
  const first = await f.controller.operations.exportBundle(firstInput);
  const original = f.controller.readFile(first.data.bundleId).bytes;
  const second = await f.controller.operations.exportBundle({ ...firstInput, requestId: 'export-second', impact: 'Otro impacto declarado' });
  assert.notEqual(first.data.bundleId, second.data.bundleId);
  assert.deepEqual(f.controller.readFile(first.data.bundleId).bytes, original);
  assert.equal((await f.controller.operations.exportBundle(firstInput)).data.bundleId, first.data.bundleId);
  f.controller.dispose();
});

test('capture connection preserves the direct user click and is closed when the review ends', async () => {
  let connected = false, connects = 0, disconnects = 0;
  const provider = { name: 'verified-test-adapter', kind: 'real-browser',
    connect() { connects += 1; connected = true; return Promise.resolve(); },
    isConnected: () => connected,
    disconnect() { disconnects += 1; connected = false; },
    async captureViewport() { throw new Error('not requested'); },
  };
  const f = fixture({ review: { captureProvider: provider } });
  assert.equal(f.controller.isCaptureConnected(), false);
  const before = await f.controller.getContext();
  assert.equal(before.capabilities.captureViewport.status, 'unavailable');
  assert.match(before.capabilities.captureViewport.reason, /adaptador de captura configurado no está conectado/);
  const promise = f.controller.connectCapture();
  assert.equal(connects, 1, 'the native permission call happens synchronously, before the caller awaits');
  await promise;
  assert.equal(f.controller.isCaptureConnected(), true);
  assert.equal((await f.controller.getContext()).capabilities.captureViewport.status, 'supported');
  assert.equal(f.controller.snapshot().session, null, 'permission connection does not create a session');
  await start(f);
  await f.controller.operations.endSession({ requestId: 'end-connected' });
  assert.equal(connected, false);
  assert.equal(disconnects, 1);
  f.controller.dispose();
});

test('default capture requires the Chrome extension and never falls back to sharing the screen', async () => {
  const f = fixture();
  let mediaCalls = 0;
  f.view.navigator.mediaDevices = { getDisplayMedia() { mediaCalls++; throw new Error('No screen picker should open'); }, setCaptureHandleConfig() {} };
  const current = await f.controller.getContext();
  assert.equal(current.capabilities.captureViewport.status, 'unavailable');
  assert.match(current.capabilities.captureViewport.reason, /ícono de la extensión de Chrome/);
  await assert.rejects(f.controller.connectCapture(), error => error.code === 'CAPABILITY_UNAVAILABLE' && /ícono de la extensión de Chrome/.test(error.message));
  assert.equal(f.controller.isCaptureConnected(), false);
  assert.equal(mediaCalls, 0);
  f.controller.dispose();
});

test('recording with required images and ticket preparation fail before collecting when capture is disconnected', async () => {
  let captures = 0;
  const f = fixture({ review: { captureProvider: {
    name: 'disconnected', kind: 'real-browser', isConnected: () => false,
    async captureViewport() { captures += 1; throw new Error('not connected'); },
  } } });
  assert.equal((await f.controller.operations.prepareTicket({ requestId: 'without-session' })).error.code, 'SESSION_NOT_ACTIVE');
  await start(f);
  const initial = f.controller.snapshot();
  const record = await f.controller.operations.startRecording({ requestId: 'required-recording', authorized: true, captureRequired: true });
  assert.equal(record.error.code, 'CAPABILITY_UNAVAILABLE');
  const ticket = await f.controller.operations.prepareTicket({ requestId: 'required-ticket' });
  assert.equal(ticket.error.code, 'CAPABILITY_UNAVAILABLE');
  assert.deepEqual(f.controller.snapshot(), initial);
  assert.equal(f.view.fetch, f.originalFetch);
  assert.equal(captures, 0);
  f.controller.dispose();
});

test('a capture connection resolved after disposal is closed and cannot enable the stale tab', async () => {
  const wait = deferred();
  let connected = false, disconnected = 0;
  const f = fixture({ review: { captureProvider: {
    name: 'delayed', kind: 'real-browser',
    connect: () => wait.promise.then(() => { connected = true; }), isConnected: () => connected,
    disconnect() { disconnected += 1; connected = false; },
    async captureViewport() { throw new Error('not requested'); },
  } } });
  const pending = f.controller.connectCapture();
  f.controller.dispose();
  wait.resolve();
  await assert.rejects(pending, /conexión terminó/);
  assert.equal(connected, false);
  assert.equal(disconnected, 2);
  assert.equal(f.controller.isCaptureConnected(), false);
});

test('an initial capture failure prevents a required-image recording from claiming to be active', async () => {
  const f = fixture({ review: { captureProvider: {
    name: 'connected-but-failing', kind: 'real-browser', isConnected: () => true,
    async captureViewport() { throw new Error('No frame'); },
  } } });
  await start(f);
  const result = await f.controller.operations.startRecording({ requestId: 'failing-required-capture', authorized: true, captureRequired: true });
  assert.equal(result.status, 'error');
  assert.equal(f.controller.snapshot().session.recording, 'stopped');
  assert.equal(f.view.fetch, f.originalFetch);
  assert.equal(f.controller.snapshot().artifacts.some(item => item.status === 'failed'), true);
  f.controller.dispose();
});

test('context reads overlapping a capture discard their pre-mask result and read the restored page', async () => {
  const wait = deferred();
  let reads = 0, f;
  f = fixture({ getLegacyContext: () => {
    reads += 1;
    return reads === 1 ? wait.promise : Promise.resolve(f.context());
  } });
  await start(f);
  const pendingRead = f.controller.getContext();
  assert.equal(reads, 1);
  const pendingCapture = f.controller.operations.checkpoint({ requestId: 'overlapping-native', label: 'Observed state', capture: { mode: 'native' } });
  // The controller starts the operation in a microtask. Resolve the old read
  // while that capture owns its gate; the fixture has no native DOM provider.
  await Promise.resolve();
  wait.resolve(f.context());
  const [context, capture] = await Promise.all([pendingRead, pendingCapture]);
  assert.equal(capture.status, 'error');
  assert.equal(context.status, 'ok');
  assert.equal(reads, 2, 'the pre-mask async snapshot was not committed as current context');
  assert.equal(context.revision, f.controller.snapshot().revision);
  f.controller.dispose();
});
