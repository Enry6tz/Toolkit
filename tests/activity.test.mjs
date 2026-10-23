import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeActivityConfig, resolveActivityResource, sanitizeActivityEntries, sanitizeActivityBody, UNKNOWN_ACTIVITY_RESOURCE,
} from '../dist/core/activity.js';
import { createActivityRecorder, fetchOutsideRecording } from '../dist/browser/activity.js';
import { createAgentContext } from '../dist/core/agent.js';
import { createArtifact } from '../dist/core/artifacts.js';

const at = '2026-10-14T12:00:00.000Z';
const config = { resources: [
  { name: 'Animales', path: '/api/animals', method: 'GET' },
  { name: 'Actualizar animal', path: '/api/animals/:id', method: 'PATCH' },
] };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeWindow(fetchImplementation = () => Promise.resolve(new Response('ok'))) {
  let time = 0;
  let selecting = false;
  const listeners = new Map();
  const references = new Map();
  const document = {
    defaultView: null,
    querySelector(selector) { return selector === '[data-ai-toolbar-selecting]' && selecting ? {} : null; },
    getElementById(id) { return references.get(id) ?? null; },
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
  };
  class Action {
    nodeType = 1;
    isConnected = true;
    parentElement = null;
    ownerDocument = document;
    tagName = 'BUTTON';
    childNodes = { length: 0, item() { return null; } };
    attributes = {};
    constructor(label, privateElement = false) { this.label = label; this.privateElement = privateElement; }
    matches(selector) {
      return (this.privateElement && selector.includes('[data-ai-private]'))
        || selector.split(',').some(part => part.trim() === this.tagName.toLowerCase())
        || (this.disabled && selector.includes(':disabled'))
        || ('readonly' in this.attributes && selector.includes('[readonly]'));
    }
    closest() { return this; }
    getRootNode() { return document; }
    getAttribute(name) { return this.attributes[name] ?? (name === 'aria-label' ? this.label : null); }
    getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 30 }; }
  }
  const view = {
    document, fetch: fetchImplementation, URL, Request, Element: Action,
    location: { href: 'https://preview.example.test/page?token=page-secret', origin: 'https://preview.example.test' },
    performance: { now: () => time },
    getComputedStyle: element => ({ display: element.display ?? 'block', visibility: element.visibility ?? 'visible' }),
  };
  document.defaultView = view;
  return {
    view, Action, references,
    advance(ms) { time += ms; },
    setSelecting(value) { selecting = value; },
    listenerCount() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
    click(action) {
      for (const listener of listeners.get('click') ?? []) listener({ type: 'click', composedPath: () => [action, document] });
    },
    change(control, path = [control, document]) {
      for (const listener of listeners.get('change') ?? []) listener({ type: 'change', composedPath: () => path });
    },
    submit(action) {
      for (const listener of listeners.get('submit') ?? []) listener({ type: 'submit', submitter: action, composedPath: () => [action, document] });
    },
  };
}

function controlIn(environment, label = 'Destino', tag = 'SELECT') {
  const control = new environment.Action(label);
  control.tagName = tag;
  control.parentElement = new environment.Action('Contenedor público');
  control.parentElement.tagName = 'DIV';
  // Fail the test if observation reads an editable value, state or the control's text/options.
  for (const name of ['value', 'options', 'selectedOptions', 'selectedIndex', 'checked', 'textContent', 'innerText'])
    Object.defineProperty(control, name, { get() { throw new Error(`Control ${name} must never be read`); } });
  return control;
}

function labelWith(environment, text, children = []) {
  const label = new environment.Action(null);
  label.tagName = 'LABEL';
  const nodes = [{ nodeType: 3, nodeValue: text }, ...children];
  label.childNodes = { length: nodes.length, item: index => nodes[index] ?? null };
  return label;
}

test('committed changes record only a public control label, and collection stays explicit', () => {
  const environment = fakeWindow();
  const recorder = createActivityRecorder({ window: environment.view, config, locale: 'es' });
  const control = controlIn(environment);
  environment.change(control);
  assert.deepEqual(recorder.getEntries(), []);
  recorder.start();
  environment.change(control);
  assert.deepEqual(recorder.getEntries().map(entry => ({ kind: entry.kind, label: entry.label })), [
    { kind: 'interaction', label: 'Cambió Destino' },
  ]);
  assert.deepEqual(Object.keys(recorder.getEntries()[0]).sort(), ['id', 'kind', 'at', 'label'].sort());
  recorder.stop();
  environment.change(control);
  assert.equal(recorder.getEntries().length, 1);
  assert.equal(environment.listenerCount(), 0);
});

test('change labels use public aria references or native labels, excluding editable descendants', () => {
  const environment = fakeWindow();
  const recorder = createActivityRecorder({ window: environment.view, config, locale: 'es' });
  recorder.start();
  const referenced = controlIn(environment, null);
  referenced.attributes['aria-labelledby'] = 'private hidden public';
  const hidden = labelWith(environment, 'hidden-label-secret'); hidden.display = 'none';
  const privateLabel = labelWith(environment, 'private-label-secret'); privateLabel.privateElement = true;
  environment.references.set('private', privateLabel);
  environment.references.set('hidden', hidden);
  environment.references.set('public', labelWith(environment, 'Destino'));
  environment.change(referenced);
  const wrapped = controlIn(environment, null);
  const label = labelWith(environment, 'Fecha de ida', [wrapped]);
  wrapped.parentElement = label; wrapped.labels = [hidden, privateLabel, label];
  environment.change(wrapped);
  const textInput = controlIn(environment, null, 'INPUT');
  textInput.labels = [labelWith(environment, 'Comentario')];
  environment.change(textInput);
  assert.deepEqual(recorder.getEntries().map(entry => entry.label), ['Cambió Destino', 'Cambió Fecha de ida', 'Cambió Comentario']);
  assert.doesNotMatch(JSON.stringify(recorder.getEntries()), /hidden-label-secret|private-label-secret/);
  recorder.dispose();
});

test('private, password, detached, hidden, disabled, readonly and inspector changes are omitted', () => {
  const environment = fakeWindow();
  const recorder = createActivityRecorder({ window: environment.view, config });
  recorder.start();
  const controls = [];
  const password = controlIn(environment, 'password-label-secret', 'INPUT'); password.attributes.type = 'password'; controls.push(password);
  const privateControl = controlIn(environment, 'private-label-secret'); privateControl.privateElement = true; controls.push(privateControl);
  const privateParent = controlIn(environment, 'parent-label-secret'); privateParent.parentElement.privateElement = true; controls.push(privateParent);
  const detached = controlIn(environment, 'detached-label-secret'); detached.isConnected = false; controls.push(detached);
  const hidden = controlIn(environment, 'hidden-label-secret'); hidden.visibility = 'hidden'; controls.push(hidden);
  const disabled = controlIn(environment, 'disabled-label-secret'); disabled.disabled = true; controls.push(disabled);
  const readonly = controlIn(environment, 'readonly-label-secret'); readonly.attributes.readonly = ''; controls.push(readonly);
  const unlabeled = controlIn(environment, null); controls.push(unlabeled);
  for (const control of controls) environment.change(control);
  environment.setSelecting(true);
  environment.change(controlIn(environment, 'selecting-label-secret'));
  environment.setSelecting(false);
  const toolbar = new environment.Action('Toolbar'); toolbar.matches = selector => selector.includes('[data-ai-toolbar-host]');
  const toolbarControl = controlIn(environment, 'toolbar-label-secret');
  environment.change(toolbarControl, [toolbarControl, toolbar, environment.view.document]);
  assert.deepEqual(recorder.getEntries(), []);
  recorder.dispose();
});

test('a change does not suppress a keyboard submit, while a click followed by submit remains one action', () => {
  const environment = fakeWindow();
  const recorder = createActivityRecorder({ window: environment.view, config, locale: 'es' });
  recorder.start();
  environment.change(controlIn(environment));
  environment.submit(new environment.Action('Buscar vuelos'));
  const save = new environment.Action('Guardar');
  environment.click(save); environment.submit(save);
  assert.deepEqual(recorder.getEntries().map(entry => entry.label), ['Cambió Destino', 'Buscar vuelos', 'Guardar']);
  recorder.dispose();
});

test('activity config retains only bounded public aliases and exact pathname templates', () => {
  const normalized = normalizeActivityConfig({
    maxEntries: 9_999,
    headers: 'header-secret',
    resources: [
      ...config.resources,
      { name: 'Contacto owner@example.test token=alias-secret', path: '/api/contacts' },
      { name: 'External', path: 'https://external.example.test/api/animals' },
      { name: 'Query', path: '/api/animals?token=query-secret' },
      { name: 'Wildcard', path: '/api/*' },
      { name: 'Invalid verb', path: '/api/animals', method: 'CONNECT' },
    ],
  });
  assert.equal(normalized.maxEntries, 50);
  assert.equal(normalized.resources.length, 3);
  assert.equal(resolveActivityResource(normalized, 'GET', '/api/animals'), 'Animales');
  assert.equal(resolveActivityResource(normalized, 'PATCH', '/api/animals/sensitive-id'), 'Actualizar animal');
  for (const [method, path] of [
    ['POST', '/api/animals'], ['PATCH', '/api/animals'], ['PATCH', '/api/animals/a/b'],
    ['GET', '/api/animals/'], ['GET', '/api/animals?token=secret'], ['GET', '/api/other'],
  ]) assert.equal(resolveActivityResource(normalized, method, path), UNKNOWN_ACTIVITY_RESOURCE);
  assert.equal(resolveActivityResource({ resources: [] }, 'GET', '/secret/path'), UNKNOWN_ACTIVITY_RESOURCE);
  const serialized = JSON.stringify(normalized);
  assert.doesNotMatch(serialized, /owner@example|alias-secret|header-secret|query-secret|external.example/);
  assert.equal(normalizeActivityConfig({ resources: Array(101).fill(config.resources[0]) }).resources.length, 100);
  assert.equal(normalizeActivityConfig(null).maxEntries, 50);
});

test('activity imports whitelist fields, redact labels, cap entries and remove broken correlations', () => {
  const entries = sanitizeActivityEntries([
    { id: 'activity-1-1', kind: 'interaction', at, label: 'Guardar owner@example.test token=label-secret', html: 'html-secret' },
    {
      id: 'activity-1-2', kind: 'fetch', at, resource: 'Animales https://private.example.test?token=url-secret',
      method: 'GET', status: 200, outcome: 'success', durationMs: 12.6,
      interactionId: 'activity-1-1', correlation: 'temporal',
      url: 'https://private.example.test/raw-secret', headers: { authorization: 'header-secret' },
      body: 'body-secret', response: 'response-secret', error: 'error-secret',
    },
    { id: 'activity-1-3', kind: 'fetch', at, resource: 'Animals', method: 'Bearer method-secret', outcome: 'pending', durationMs: 50, status: 200, correlation: 'causal', interactionId: 'activity-1-1' },
    { id: 'activity-1-4', kind: 'unknown', at, label: 'unknown-secret' },
  ]);
  assert.equal(entries.length, 3);
  assert.equal(entries[1].durationMs, 13);
  assert.equal(entries[1].correlation, 'temporal');
  assert.equal(entries[2].method, 'OTHER');
  assert.equal(entries[2].status, null);
  assert.equal(entries[2].durationMs, null);
  assert.equal(entries[2].correlation, null);
  assert.equal(entries[2].interactionId, null);
  const serialized = JSON.stringify(entries);
  assert.doesNotMatch(serialized, /owner@example|label-secret|url-secret|raw-secret|header-secret|body-secret|response-secret|error-secret|unknown-secret|method-secret/);
  assert.doesNotMatch(serialized, /https:\/\//);
  const trimmed = sanitizeActivityEntries(entries, 2);
  assert.equal(trimmed.length, 2);
  assert.equal(trimmed[0].interactionId, null);
  assert.equal(trimmed[0].correlation, null);
  assert.deepEqual(sanitizeActivityEntries([{ ...entries[0], at: 'invalid' }, { ...entries[0], id: 'https://secret.test' }]), []);
  assert.equal(sanitizeActivityEntries(Array.from({ length: 1_000 }, (_, index) => ({ ...entries[0], id: `activity-1-${index}` }))).length, 50);
});

test('simulated marker is boolean-true only and is absent from the unchanged legacy default shape', () => {
  const input = { id: 'activity-1-1', kind: 'interaction', at, label: 'Simular consulta' };
  assert.deepEqual(sanitizeActivityEntries([input]), [input]);
  assert.deepEqual(sanitizeActivityEntries([{ ...input, simulated: false }]), [input]);
  assert.deepEqual(sanitizeActivityEntries([{ ...input, simulated: 'true' }]), [input]);
  assert.equal(sanitizeActivityEntries([{ ...input, simulated: true }])[0].simulated, true);
  const fetchEntry = { id: 'activity-1-2', kind: 'fetch', at, resource: 'Animales', method: 'GET', status: 500, outcome: 'http_error', durationMs: 20, interactionId: input.id, correlation: 'temporal', simulated: true };
  assert.equal(sanitizeActivityEntries([{ ...input, simulated: true }, fetchEntry])[1].simulated, true);
  const context = {
    schemaVersion: '1.0', capturedAt: at,
    page: { url: 'https://example.test/animals', pathname: '/animals', title: 'Demo', viewport: { width: 1200, height: 800 } },
    build: { environment: 'preview' }, target: null, rules: [], privacy: { redactions: [] },
    activity: [{ ...input, simulated: true }, fetchEntry],
  };
  const report = createArtifact({ mode: 'report', title: 'Consulta de ejemplo', detail: 'Simular un resultado de error.' }, context);
  assert.equal((report.markdown.match(/SIMULADO/g) ?? []).length, 2);
  assert.match(report.markdown, /no confirma un defecto real/);
});

test('only an explicitly marked public action marks its temporally associated fetch as simulated', async () => {
  const environment = fakeWindow(() => Promise.resolve(new Response('simulated', { status: 500 })));
  const recorder = createActivityRecorder({ window: environment.view, config });
  recorder.start();
  const simulated = new environment.Action('Simular error de consulta');
  const attributes = simulated.getAttribute.bind(simulated);
  simulated.getAttribute = name => name === 'data-ai-simulated' ? 'true' : attributes(name);
  environment.click(simulated);
  await environment.view.fetch('/api/animals');
  const entries = recorder.getEntries();
  assert.equal(entries[0].simulated, true);
  assert.equal(entries[1].simulated, true);
  assert.equal(entries[1].correlation, 'temporal');
  environment.click(new environment.Action('Consultar animales'));
  await environment.view.fetch('/api/animals');
  assert.equal(Object.hasOwn(recorder.getEntries()[2], 'simulated'), false);
  assert.equal(Object.hasOwn(recorder.getEntries()[3], 'simulated'), false, 'HTTP 500 alone is not a simulation declaration');
  environment.click(simulated);
  environment.advance(1_501);
  await environment.view.fetch('/api/animals');
  assert.equal(Object.hasOwn(recorder.getEntries().at(-1), 'simulated'), false, 'expired temporal association cannot pass its marker');
  recorder.dispose();
});

test('agent context and report exports both sanitize abstract activity instead of serializing raw extras', () => {
  const context = {
    schemaVersion: '1.0', capturedAt: at,
    page: { url: 'https://preview.example.test/animals?token=page-secret', pathname: '/animals', title: 'Animales', viewport: { width: 1280, height: 800 } },
    build: { environment: 'preview' }, target: null, rules: [], privacy: { redactions: [] },
    activity: [
      { id: 'activity-2-1', kind: 'interaction', at, label: 'Actualizar animales', targetHtml: 'html-secret' },
      {
        id: 'activity-2-2', kind: 'fetch', at, resource: 'Animales', method: 'GET',
        status: 503, outcome: 'http_error', durationMs: 12,
        interactionId: 'activity-2-1', correlation: 'temporal',
        url: 'https://private.example.test/path-secret?token=query-secret', headers: { authorization: 'header-secret' },
        body: 'request-secret', response: 'response-secret', error: 'error-secret',
      },
    ],
  };
  const agentContext = createAgentContext(context);
  const report = createArtifact({ mode: 'report', title: 'Error al actualizar', detail: 'El listado no se actualiza.' }, context);
  assert.equal(agentContext.context.activity[1].resource, 'Animales');
  assert.equal(report.json.context.activity[1].outcome, 'http_error');
  assert.match(report.markdown, /Recorrido grabado/);
  assert.match(report.markdown, /asociación temporal/);
  const serialized = agentContext.markdown + JSON.stringify(agentContext) + report.markdown + JSON.stringify(report.json);
  assert.doesNotMatch(serialized, /page-secret|html-secret|path-secret|query-secret|header-secret|request-secret|response-secret|error-secret|private.example/);
  context.activity[1].resource = 'Mutated';
  assert.equal(agentContext.context.activity[1].resource, 'Animales');
  assert.equal(report.json.context.activity[1].resource, 'Animales');
});

test('recorder starts stopped, shares one fetch wrapper, and restores only its own wrapper', async () => {
  const environment = fakeWindow();
  const original = environment.view.fetch;
  const first = createActivityRecorder({ window: environment.view, config });
  const second = createActivityRecorder({ window: environment.view, config });
  assert.equal(first.isRecording(), false);
  assert.equal(environment.view.fetch, original);
  assert.equal(environment.listenerCount(), 0);
  await environment.view.fetch('/api/animals');
  assert.deepEqual(first.getEntries(), []);
  first.start();
  const wrapper = environment.view.fetch;
  second.start();
  first.start();
  assert.equal(environment.view.fetch, wrapper);
  assert.equal(environment.listenerCount(), 3);
  await environment.view.fetch('/api/animals');
  assert.equal(first.getEntries().length, 1);
  assert.equal(second.getEntries().length, 1);
  first.stop();
  assert.equal(environment.view.fetch, wrapper);
  second.stop();
  assert.equal(environment.view.fetch, original);
  assert.equal(environment.listenerCount(), 0);
  first.start();
  const captured = environment.view.fetch;
  const foreign = function (...args) { return Reflect.apply(captured, this, args); };
  environment.view.fetch = foreign;
  first.dispose();
  assert.equal(environment.view.fetch, foreign);
  assert.equal(environment.listenerCount(), 0);
  assert.equal(first.isRecording(), false);
  first.start();
  assert.equal(environment.view.fetch, foreign);
  second.dispose();
});

test('fetch preserves this, args, original Promise, Request body and Response identity', async () => {
  const completion = deferred();
  let receivedThis;
  let receivedArgs;
  const environment = fakeWindow(function (...args) { receivedThis = this; receivedArgs = args; return completion.promise; });
  const recorder = createActivityRecorder({ window: environment.view, config, onChange() { throw new Error('observer failure'); } });
  recorder.start();
  const request = new Request('https://preview.example.test/api/animals/secret-id?token=query-secret', { method: 'PATCH', body: 'request-body-secret' });
  const init = { headers: { authorization: 'header-secret' } };
  const receiver = {};
  const promise = environment.view.fetch.call(receiver, request, init);
  assert.equal(promise, completion.promise);
  assert.equal(receivedThis, receiver);
  assert.equal(receivedArgs[0], request);
  assert.equal(receivedArgs[1], init);
  assert.equal(request.bodyUsed, false);
  assert.equal(recorder.getEntries()[0].outcome, 'pending');
  assert.equal(recorder.getEntries()[0].resource, 'Actualizar animal');
  environment.advance(42);
  const response = new Response('response-body-secret', { status: 200 });
  completion.resolve(response);
  assert.equal(await promise, response);
  assert.equal(response.bodyUsed, false);
  assert.equal(recorder.getEntries()[0].durationMs, 42);
  assert.equal(recorder.getEntries()[0].outcome, 'success');
  assert.doesNotMatch(JSON.stringify(recorder.getEntries()), /secret-id|query-secret|request-body-secret|response-body-secret|header-secret/);
  recorder.dispose();
});

test('trace associates only recent public actions temporally and keeps abstract resource aliases', async () => {
  const environment = fakeWindow();
  const recorder = createActivityRecorder({ window: environment.view, config });
  recorder.start();
  environment.click(new environment.Action('Guardar owner@example.test'));
  await environment.view.fetch('/api/animals?password=query-secret');
  let entries = recorder.getEntries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'interaction');
  assert.match(entries[0].label, /email oculto/);
  assert.equal(entries[1].resource, 'Animales');
  assert.equal(entries[1].interactionId, entries[0].id);
  assert.equal(entries[1].correlation, 'temporal');
  environment.click(new environment.Action('Private secret', true));
  environment.advance(1_501);
  await environment.view.fetch('https://external.example.test/api/animals?token=foreign-secret');
  entries = recorder.getEntries();
  assert.equal(entries.length, 3);
  assert.equal(entries[2].resource, UNKNOWN_ACTIVITY_RESOURCE);
  assert.equal(entries[2].interactionId, null);
  assert.doesNotMatch(JSON.stringify(entries), /query-secret|foreign-secret|Private secret|external.example/);
  recorder.dispose();
});

test('selection inspector clicks are omitted while actual requests can still be recorded', async () => {
  const environment = fakeWindow();
  const recorder = createActivityRecorder({ window: environment.view, config });
  recorder.start();
  environment.setSelecting(true);
  environment.click(new environment.Action('Elegir este botón'));
  assert.deepEqual(recorder.getEntries(), []);
  await environment.view.fetch('/api/animals');
  assert.equal(recorder.getEntries().length, 1);
  assert.equal(recorder.getEntries()[0].kind, 'fetch');
  assert.equal(recorder.getEntries()[0].interactionId, null);
  environment.setSelecting(false);
  environment.click(new environment.Action('Actualizar animales'));
  assert.equal(recorder.getEntries()[1].kind, 'interaction');
  recorder.dispose();
});

test('stop freezes pending requests as incomplete and late completion never mutates a new recording', async () => {
  const first = deferred();
  const environment = fakeWindow(() => first.promise);
  const recorder = createActivityRecorder({ window: environment.view, config });
  recorder.start();
  const request = environment.view.fetch('/api/animals');
  assert.equal(recorder.getEntries()[0].durationMs, null);
  environment.advance(40);
  recorder.stop();
  const frozen = recorder.getEntries();
  assert.equal(frozen[0].outcome, 'incomplete');
  assert.equal(frozen[0].durationMs, 40);
  recorder.start();
  first.resolve(new Response('late'));
  await request;
  assert.deepEqual(recorder.getEntries(), frozen);
  recorder.dispose();
});

test('clear invalidates in-flight updates, bounds history and protects returned snapshots', async () => {
  const pending = deferred();
  let first = true;
  const environment = fakeWindow(() => { if (first) { first = false; return pending.promise; } return Promise.resolve(new Response('ok')); });
  const recorder = createActivityRecorder({ window: environment.view, config: { ...config, maxEntries: 2 } });
  recorder.start();
  const late = environment.view.fetch('/api/animals');
  recorder.clear();
  pending.resolve(new Response('late'));
  await late;
  assert.deepEqual(recorder.getEntries(), []);
  for (let index = 0; index < 3; index += 1) await environment.view.fetch('/api/animals');
  assert.equal(recorder.getEntries().length, 2);
  const snapshot = recorder.getEntries();
  snapshot[0].resource = 'Mutated';
  assert.equal(recorder.getEntries()[0].resource, 'Animales');
  recorder.dispose();
});

test('HTTP errors, network failures, aborts and synchronous throws retain application behavior', async () => {
  for (const [status, outcome] of [[503, 'http_error'], [204, 'success']]) {
    const response = new Response(null, { status });
    const environment = fakeWindow(() => Promise.resolve(response));
    const recorder = createActivityRecorder({ window: environment.view, config });
    recorder.start();
    assert.equal(await environment.view.fetch('/api/animals'), response);
    assert.equal(recorder.getEntries()[0].outcome, outcome);
    assert.equal(recorder.getEntries()[0].status, status);
    recorder.dispose();
  }
  for (const [name, outcome] of [['TypeError', 'network_error'], ['AbortError', 'aborted']]) {
    const error = Object.assign(new Error('network-secret'), { name });
    const environment = fakeWindow(() => Promise.reject(error));
    const recorder = createActivityRecorder({ window: environment.view, config });
    recorder.start();
    await assert.rejects(environment.view.fetch('/api/animals'), actual => actual === error);
    assert.equal(recorder.getEntries()[0].outcome, outcome);
    assert.doesNotMatch(JSON.stringify(recorder.getEntries()), /network-secret/);
    recorder.dispose();
  }
  const error = new Error('sync-secret');
  const environment = fakeWindow(() => { throw error; });
  const recorder = createActivityRecorder({ window: environment.view, config });
  recorder.start();
  assert.throws(() => environment.view.fetch('/api/animals'), actual => actual === error);
  assert.equal(recorder.getEntries()[0].outcome, 'network_error');
  recorder.dispose();
});

async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('The bounded body preview did not become available.');
}

test('recording retains useful request and response JSON, masking credential keys recursively', async () => {
  const response = new Response(JSON.stringify({ animals: [{ name: 'Luna', access_token: 'response-token' }], password: 'response-password' }), { headers: { 'content-type': 'application/json' } });
  const environment = fakeWindow(() => Promise.resolve(response));
  const recorder = createActivityRecorder({ window: environment.view, config: { ...config, maxBodyChars: 8000 } });
  recorder.start();
  const original = environment.view.fetch('/api/new-resource', { method: 'POST', body: JSON.stringify({ name: 'Luna', nested: { password: 'request-password', API_KEY: 'request-api-key' }, active: true }) });
  assert.equal(await original, response);
  const entry = await until(() => recorder.getEntries()[0]?.responseBody?.text && recorder.getEntries()[0]);
  assert.equal(entry.resource, UNKNOWN_ACTIVITY_RESOURCE, 'requests without a configured alias remain in the recording');
  assert.equal(entry.requestBody.status, 'captured');
  assert.equal(JSON.parse(entry.requestBody.text).name, 'Luna');
  assert.equal(JSON.parse(entry.requestBody.text).nested.password, '[oculto]');
  assert.equal(JSON.parse(entry.responseBody.text).animals[0].name, 'Luna');
  assert.equal(entry.requestBody.redacted, true);
  assert.doesNotMatch(JSON.stringify(entry), /request-password|request-api-key|response-token|response-password/);
  assert.equal(response.bodyUsed, false);
  assert.match(await response.text(), /response-token/, 'the application receives its original untouched body');
  recorder.dispose();
});

test('streaming response previews stop at the character limit without waiting for the original body', async () => {
  let source;
  const response = new Response(new ReadableStream({ start(controller) { source = controller; controller.enqueue(new TextEncoder().encode('x'.repeat(50_000))); } }), { headers: { 'content-type': 'text/plain' } });
  const environment = fakeWindow(() => Promise.resolve(response));
  const recorder = createActivityRecorder({ window: environment.view, config: { ...config, maxBodyChars: 32 } });
  recorder.start();
  assert.equal(await environment.view.fetch('/api/animals'), response);
  const body = await until(() => recorder.getEntries()[0]?.responseBody);
  assert.equal(body.status, 'truncated'); assert.equal(body.charLimit, 32); assert.equal(body.text.length, 32);
  assert.equal(response.bodyUsed, false, 'preview cancellation never consumes the app branch');
  source.enqueue(new TextEncoder().encode('tail')); source.close();
  assert.equal((await response.text()).length, 50_004);
  recorder.dispose();
});

test('Request streams are never cloned or consumed; string, form and text Blob previews are bounded', async () => {
  const environment = fakeWindow();
  const recorder = createActivityRecorder({ window: environment.view, config: { ...config, maxBodyChars: 64 } });
  recorder.start();
  const request = new Request('https://preview.example.test/api/animals', { method: 'POST', body: 'body kept for app' });
  request.clone = () => assert.fail('The observer must not tee a Request body.');
  await environment.view.fetch(request);
  assert.equal(request.bodyUsed, false);
  assert.equal(recorder.getEntries()[0].requestBody.reason, 'stream');
  await environment.view.fetch('/api/animals', { method: 'POST', body: new URLSearchParams({ name: 'Luna', access_token: 'form-token' }) });
  assert.match(recorder.getEntries()[1].requestBody.text, /name=Luna/);
  assert.doesNotMatch(recorder.getEntries()[1].requestBody.text, /form-token/);
  await environment.view.fetch('/api/animals', { method: 'POST', body: new Blob(['blob'.repeat(1000)], { type: 'text/plain' }) });
  const blob = await until(() => recorder.getEntries()[2]?.requestBody);
  assert.equal(blob.status, 'truncated'); assert.equal(blob.text.length, 64);
  await environment.view.fetch('/api/animals', { method: 'POST', body: new Uint8Array([1, 2, 3]) });
  assert.equal(recorder.getEntries()[3].requestBody.reason, 'binary');
  recorder.dispose();
});

test('binary and disabled response capture do not clone or consume the response', async () => {
  for (const [captureBodies, contentType, expected] of [[true, 'image/png', 'binary'], [false, 'application/json', 'disabled']]) {
    const response = new Response('original data', { headers: { 'content-type': contentType } });
    response.clone = () => assert.fail('No body clone is needed.');
    const environment = fakeWindow(() => Promise.resolve(response));
    const recorder = createActivityRecorder({ window: environment.view, config: { ...config, captureBodies } });
    recorder.start(); await environment.view.fetch('/api/animals');
    assert.equal(recorder.getEntries()[0].responseBody.reason, expected);
    assert.equal(response.bodyUsed, false); recorder.dispose();
  }
});

test('stopping cancels only pending preview readers and ignores late data', async () => {
  let source;
  const response = new Response(new ReadableStream({ start(controller) { source = controller; } }), { headers: { 'content-type': 'text/plain' } });
  const environment = fakeWindow(() => Promise.resolve(response));
  const recorder = createActivityRecorder({ window: environment.view, config });
  recorder.start(); await environment.view.fetch('/api/animals');
  recorder.stop();
  const stopped = recorder.getEntries();
  assert.equal(stopped[0].responseBody.reason, 'recording_stopped');
  source.enqueue(new TextEncoder().encode('late app data')); source.close();
  assert.equal(await response.text(), 'late app data');
  await Promise.resolve(); assert.deepEqual(recorder.getEntries(), stopped);
  recorder.dispose();
});

test('global body budget and dropped history are explicit rather than unbounded or silent', async () => {
  const environment = fakeWindow(() => Promise.resolve(new Response('response')));
  const recorder = createActivityRecorder({ window: environment.view, config: { ...config, maxEntries: 2, maxBodyChars: 50, maxNetworkChars: 12 } });
  recorder.start();
  for (let index = 0; index < 4; index++) await environment.view.fetch('/api/animals', { method: 'POST', body: 'request' });
  await until(() => recorder.getEntries().every(entry => entry.responseBody));
  assert.equal(recorder.getSummary().droppedEntries, 2);
  assert.ok(recorder.getSummary().bodyChars <= 12);
  assert.ok(recorder.getEntries().some(entry => entry.requestBody.reason === 'network_limit' || entry.responseBody.reason === 'network_limit'));
  recorder.clear();
  assert.equal(recorder.getSummary().droppedEntries, 0); assert.equal(recorder.getSummary().bodyChars, 0);
  recorder.dispose();
});

test('body imports are credential-redacted, bounded, field-whitelisted and idempotent', () => {
  for (const text of ['{"name":"Luna","password":"private","nested":{"Authorization":"Bearer secret"}}', 'name=Luna&password=private&token=secret', '{"name":"Luna","password":"unfinished-private', 'plain Authorization: Bearer secret']) {
    const body = sanitizeActivityBody({ status: 'captured', text, charLimit: 8000, url: 'not allowed' });
    assert.doesNotMatch(body.text, /private|unfinished-private|Bearer secret/);
    assert.deepEqual(sanitizeActivityBody(body), body);
    assert.equal('url' in body, false);
  }
  const limited = sanitizeActivityBody({ status: 'captured', text: 'a'.repeat(500), charLimit: 16 });
  assert.equal(limited.text.length, 16); assert.equal(limited.status, 'truncated');
  for (let charLimit = 1; charLimit < 70; charLimit++) {
    const body = sanitizeActivityBody({ status: 'truncated', text: '{"name":"Luna","password":"[oculto]","other":"value"}', charLimit, reason: 'network_limit' });
    assert.deepEqual(sanitizeActivityBody(body), body, `prefix boundary ${charLimit}`);
  }
  const json = sanitizeActivityBody({ status: 'captured', text: '{"url":"https://example.test?token=private&name=Luna"}', charLimit: 8000 });
  assert.match(JSON.parse(json.text).url, /name=Luna/);
  assert.doesNotMatch(json.text, /private/);
  assert.deepEqual(sanitizeActivityBody(json), json);
});

test('offline simulation makes zero real requests and disappears on stop; active recorders share one effect', async () => {
  let realRequests = 0;
  const environment = fakeWindow(() => { realRequests++; return Promise.resolve(new Response('actual')); });
  const first = createActivityRecorder({ window: environment.view, config });
  const second = createActivityRecorder({ window: environment.view, config });
  first.setNetworkSimulation('offline'); assert.equal(first.getNetworkSimulation(), 'normal');
  first.start(); second.start();
  first.setNetworkSimulation('slow'); second.setNetworkSimulation('offline');
  await assert.rejects(environment.view.fetch('/api/animals'), TypeError);
  assert.equal(realRequests, 0);
  assert.equal(first.getEntries()[0].simulation, 'offline'); assert.equal(first.getEntries()[0].simulated, true);
  assert.equal(second.getEntries()[0].simulation, 'offline');
  second.stop(); first.stop();
  assert.equal(first.getNetworkSimulation(), 'normal'); assert.equal(second.getNetworkSimulation(), 'normal');
  assert.equal(await (await environment.view.fetch('/api/animals')).text(), 'actual');
  assert.equal(realRequests, 1);
  first.dispose(); second.dispose();
});

test('slow fetch simulation respects cancellation before dispatch and normal retains the original Promise', async () => {
  let realRequests = 0;
  const expected = Promise.resolve(new Response('actual'));
  const environment = fakeWindow(() => { realRequests++; return expected; });
  const recorder = createActivityRecorder({ window: environment.view, config });
  recorder.start(); recorder.setNetworkSimulation('slow');
  const abort = new AbortController();
  const pending = environment.view.fetch('/api/animals', { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(realRequests, 0);
  assert.equal(recorder.getEntries()[0].simulation, 'slow'); assert.equal(recorder.getEntries()[0].outcome, 'aborted');
  recorder.setNetworkSimulation('normal');
  assert.equal(environment.view.fetch('/api/animals'), expected);
  assert.equal(realRequests, 1);
  recorder.dispose();
});

test('multiple slow recorders delay a single real dispatch rather than duplicating the request', async () => {
  let requests = 0;
  const environment = fakeWindow(() => { requests++; return Promise.resolve(new Response('actual')); });
  const first = createActivityRecorder({ window: environment.view, config });
  const second = createActivityRecorder({ window: environment.view, config });
  first.start(); second.start(); first.setNetworkSimulation('slow'); second.setNetworkSimulation('slow');
  const before = performance.now();
  const pending = environment.view.fetch('/api/animals');
  assert.equal(requests, 0);
  await pending;
  assert.ok(performance.now() - before >= 750);
  assert.equal(requests, 1);
  assert.equal(first.getEntries()[0].simulation, 'slow'); assert.equal(second.getEntries()[0].simulation, 'slow');
  first.dispose(); second.dispose();
});

test('continuing a recording seeds its previous body budget and cannot reset it while active', async () => {
  const environment = fakeWindow();
  const recorder = createActivityRecorder({ window: environment.view, config: { ...config, maxNetworkChars: 20 } });
  recorder.seedBodyBudget(20);
  assert.equal(recorder.getSummary().bodyChars, 20);
  recorder.start(); recorder.seedBodyBudget(0);
  assert.equal(recorder.getSummary().bodyChars, 20);
  await environment.view.fetch('/api/animals', { method: 'POST', body: 'request' });
  const entry = recorder.getEntries()[0];
  assert.equal(entry.requestBody.reason, 'network_limit');
  assert.equal(entry.responseBody.reason, 'network_limit');
  assert.equal(recorder.getSummary().bodyChars, 20);
  recorder.stop(); recorder.clear();
  assert.equal(recorder.getSummary().bodyChars, 0);
  recorder.dispose();
});

test('network recording observes idle GET, POST, DELETE and PATCH without interaction or resource aliases', async () => {
  const promises = [];
  const environment = fakeWindow(() => {
    const promise = Promise.resolve(new Response('{"error":"table load failed"}', { status: 503, headers: { 'content-type': 'application/json' } }));
    promises.push(promise); return promise;
  });
  const recorder = createActivityRecorder({ window: environment.view, config: { resources: [] } });
  assert.equal(normalizeActivityConfig({ resources: [] }).recordNetwork, true);
  assert.equal(recorder.getNetworkRecording(), true);
  recorder.start();
  for (const method of ['GET', 'POST', 'DELETE', 'PATCH']) {
    const promise = environment.view.fetch('/api/background-table', { method, ...(method === 'GET' ? {} : { body: '{"table":"flights"}' }) });
    assert.equal(promise, promises.at(-1), 'network collection never replaces the original Promise');
    await promise;
  }
  await until(() => recorder.getEntries().length === 4 && recorder.getEntries().every(entry => entry.responseBody?.text));
  const entries = recorder.getEntries();
  assert.deepEqual(entries.map(entry => entry.method), ['GET', 'POST', 'DELETE', 'PATCH']);
  for (const entry of entries) {
    assert.equal(entry.kind, 'fetch'); assert.equal(entry.resource, UNKNOWN_ACTIVITY_RESOURCE);
    assert.equal(entry.interactionId, null); assert.equal(entry.correlation, null);
    assert.equal(entry.status, 503); assert.equal(entry.outcome, 'http_error');
    assert.equal(JSON.parse(entry.responseBody.text).error, 'table load failed');
  }
  assert.equal(JSON.parse(entries[1].requestBody.text).table, 'flights');
  recorder.dispose();
});

test('turning network recording off retains clicks and application fetch behavior, then captures later requests when enabled', async () => {
  let actual = 0;
  const environment = fakeWindow(() => { actual++; return Promise.resolve(new Response('actual response')); });
  const recorder = createActivityRecorder({ window: environment.view, config: { ...config, recordNetwork: false } });
  assert.equal(recorder.getNetworkRecording(), false);
  recorder.start(); environment.click(new environment.Action('Buscar vuelos'));
  await environment.view.fetch('/api/animals');
  assert.equal(actual, 1);
  assert.deepEqual(recorder.getEntries().map(entry => entry.kind), ['interaction']);
  assert.equal(recorder.getSummary().bodyChars, 0);
  recorder.setNetworkRecording(true);
  assert.equal(recorder.getNetworkRecording(), true);
  await environment.view.fetch('/api/animals');
  await until(() => recorder.getEntries()[1]?.responseBody?.text);
  assert.equal(recorder.getEntries()[1].kind, 'fetch'); assert.equal(actual, 2);
  recorder.stop(); assert.equal(recorder.getNetworkRecording(), true, 'the preference survives a stop');
  recorder.dispose();
});

test('switching network recording off does not discard a previously observed pending request or its response body', async () => {
  const completion = deferred();
  let requests = 0;
  const environment = fakeWindow(() => { requests++; return requests === 1 ? completion.promise : Promise.resolve(new Response('not recorded')); });
  const recorder = createActivityRecorder({ window: environment.view, config });
  recorder.start();
  const pending = environment.view.fetch('/api/animals');
  const id = recorder.getEntries()[0].id;
  assert.equal(recorder.getEntries()[0].outcome, 'pending');
  recorder.setNetworkRecording(false);
  await environment.view.fetch('/api/animals');
  completion.resolve(new Response('{"error":"background failure"}', { status: 500, headers: { 'content-type': 'application/json' } }));
  await pending;
  const entry = await until(() => recorder.getEntries()[0]?.responseBody?.text && recorder.getEntries()[0]);
  assert.equal(recorder.getEntries().length, 1); assert.equal(entry.id, id);
  assert.equal(entry.status, 500); assert.equal(entry.outcome, 'http_error');
  assert.equal(JSON.parse(entry.responseBody.text).error, 'background failure');
  assert.equal(recorder.getNetworkRecording(), false);
  recorder.dispose();
});

test('enabling network collection is prospective and does not attach to requests initiated while disabled', async () => {
  const completion = deferred();
  const environment = fakeWindow(() => completion.promise);
  const recorder = createActivityRecorder({ window: environment.view, config: { ...config, recordNetwork: false } });
  recorder.start();
  const pending = environment.view.fetch('/api/animals');
  recorder.setNetworkRecording(true);
  completion.resolve(new Response('already started'));
  await pending; await Promise.resolve();
  assert.deepEqual(recorder.getEntries(), []);
  recorder.dispose();
});

test('network recording flags are per recorder while the shared hub dispatches a single actual fetch', async () => {
  let actual = 0;
  const environment = fakeWindow(() => { actual++; return Promise.resolve(new Response('actual')); });
  const on = createActivityRecorder({ window: environment.view, config });
  const off = createActivityRecorder({ window: environment.view, config: { ...config, recordNetwork: false } });
  on.start(); off.start(); await environment.view.fetch('/api/animals');
  assert.equal(actual, 1); assert.equal(on.getEntries().length, 1); assert.deepEqual(off.getEntries(), []);
  environment.click(new environment.Action('Ver vuelos'));
  assert.equal(on.getEntries().filter(entry => entry.kind === 'interaction').length, 1);
  assert.equal(off.getEntries().filter(entry => entry.kind === 'interaction').length, 1);
  on.dispose(); off.dispose();
});
