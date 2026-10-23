import test from 'node:test';
import assert from 'node:assert/strict';
import { recordingSteps, routineFrameworkQuery } from '../dist/review/recording-view.js';
import { recordingMarkdown, recordingJson } from '../dist/review/recording.js';
import { createReviewEngine } from '../dist/review/session.js';

test('simple presentation groups only successful framework traffic; errors, user actions and notes remain', () => {
  const event = { id: 'e', kind: 'fetch', resource: 'Recurso no identificado', method: 'GET', stepId: 's', status: 200, outcome: 'success', simulated: false,
    responseBody: { contentType: 'text/x-component', status: 'captured', text: 'framework data', charLimit: 8000 } };
  const step = { id: 's', label: 'GET Recurso no identificado', notes: '' };
  assert.equal(routineFrameworkQuery(event), true);
  assert.deepEqual(recordingSteps([step], [event], true), []);
  assert.deepEqual(recordingSteps([step], [event], false), [step]);
  for (const change of [{ outcome: 'http_error', status: 500 }, { outcome: 'pending' }, { simulated: true }, { responseBody: { contentType: 'application/json' } }])
    assert.deepEqual(recordingSteps([step], [{ ...event, ...change }], true), [step]);
  for (const change of [{ notes: 'Revisar la carga' }, { targetId: 'mark-1' }, { label: 'Abrir animales' }])
    assert.equal(recordingSteps([{ ...step, ...change }], [event], true).length, 1);
  assert.equal(recordingSteps([step], [event, { ...event, id: 'e2', outcome: 'network_error' }], true).length, 1);
});

test('simple Markdown stays short without losing raw evidence or silently hiding failed requests', () => {
  const engine = createReviewEngine(), scope = { origin: 'https://preview.example.test', pathname: '/cuidados' };
  engine.startSession({ requestId: 'start', objective: 'Recorrido', scope });
  engine.startRecording({ requestId: 'record', authorized: true });
  engine.checkpoint({ requestId: 'framework', label: 'GET Recurso no identificado', pathname: scope.pathname });
  engine.recordEvent({ requestId: 'fetch', kind: 'fetch', resource: 'Recurso no identificado', method: 'GET', outcome: 'success', status: 200,
    stepId: engine.getSnapshot().steps[0].id, responseBody: { status: 'captured', text: 'framework data '.repeat(400), contentType: 'text/x-component', charLimit: 8000 } });
  engine.updateLocation({ ...scope, targetId: 'mark-1' });
  engine.checkpoint({ requestId: 'mark', label: 'Marca', pathname: scope.pathname, targetId: 'mark-1' });
  engine.recordEvent({ requestId: 'error', kind: 'fetch', resource: 'Animales', method: 'GET', outcome: 'http_error', status: 500, simulated: true,
    stepId: engine.getSnapshot().steps[1].id, responseBody: { status: 'captured', text: '{"error":"Carga de ejemplo fallida"}', contentType: 'application/json', charLimit: 8000 } });
  const original = engine.getSnapshot(), at = new Date().toISOString();
  const annotations = [{ id: 'mark-1', caseId: original.session.id, kind: 'area', label: 'Tabla', note: 'El filtro debería mantenerse', pathname: scope.pathname,
    createdAt: at, updatedAt: at, viewport: { width: 1440, height: 900 }, bounds: { x: 20, y: 100, width: 300, height: 250 }, element: null, relatedElements: [] }];
  const packet = { review: original, context: { schemaVersion: '1.0', capturedAt: at,
    page: { url: scope.origin + scope.pathname, pathname: scope.pathname, title: 'Cuidados', viewport: { width: 1826, height: 1079 } },
    build: { environment: 'preview' }, annotations, rules: [], target: null, privacy: { redactions: [] } } };
  const before = JSON.stringify(packet), simple = recordingMarkdown(packet, { compact: true }), full = recordingMarkdown(packet);
  assert(simple.length < full.length / 3);
  for (const mark of annotations) assert(simple.includes(mark.note));
  assert.match(simple, /internal framework request/);
  assert.match(simple, /HTTP 500/);
  assert.match(simple, /simulated/);
  assert.match(simple, /copy JSON/);
  assert.doesNotMatch(simple, /## Request data/);
  assert.equal(JSON.stringify(packet), before);
  const raw = JSON.parse(recordingJson(packet));
  assert.equal(raw.events.length, original.events.length);
  assert.deepEqual(raw.steps, original.steps);
});
