import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewEngine } from '../dist/review/session.js';
import { importRecordingJson, RECORDING_JSON_MAX_CHARACTERS } from '../dist/review/recording-import.js';
import { recordingJson } from '../dist/review/recording.js';

const at = new Date(), limits = { maxEvents: 10000, maxImages: 20, maxBytes: 50 * 1024 * 1024 };
const settings = () => ({ origin: 'https://recipient.test', locale: 'es', pathname: '/cuidados', now: at, limits, id: () => crypto.randomUUID() });
function source() {
  const engine = createReviewEngine({ now: () => new Date('2000-01-01T00:00:00Z') });
  const scope = { origin: 'https://sender.test', pathname: '/animales' };
  engine.startSession({ requestId: 'session', objective: 'Revisar los controles', scope, actor: 'user' });
  engine.startRecording({ requestId: 'start', authorized: true });
  engine.checkpoint({ requestId: 'begin', label: 'Inicio', pathname: '/animales', recordingBoundary: 'start' });
  engine.updateLocation({ ...scope, targetId: 'mark-original' });
  const step = engine.checkpoint({ requestId: 'mark', label: 'Marca', pathname: '/animales', targetId: 'mark-original' }).data;
  engine.recordEvent({ requestId: 'network', kind: 'fetch', resource: 'Animales', method: 'POST', outcome: 'success', status: 201, stepId: step.id,
    correlation: 'temporal', responseBody: { status: 'captured', text: '{"ok":true}', charLimit: 8000, contentType: 'application/json' } });
  engine.stopRecording({ requestId: 'stop' });
  engine.checkpoint({ requestId: 'end', label: 'Fin', pathname: '/animales', recordingBoundary: 'stop' });
  const review = engine.getSnapshot();
  const mark = { id: 'mark-original', caseId: review.session.id, kind: 'area', pathname: '/animales', createdAt: review.session.startedAt, updatedAt: review.session.startedAt,
    label: 'Tabla', note: 'La tabla pierde el filtro', color: '#ff7048', bounds: { x: 31, y: 45, width: 300, height: 100 }, viewport: { width: 1440, height: 900 }, element: null, relatedElements: [] };
  return { schemaVersion: '1.0', session: review.session, steps: review.steps, events: review.events, annotations: [mark], partial: review.partial };
}

test('complete JSON roundtrip rebases IDs and every date, preserving routes, geometry, notes, colors and fetch associations', async () => {
  const original = source();
  const result = await importRecordingJson(JSON.stringify(original), settings());
  const { snapshot } = result.draft, mark = result.annotations[0];
  assert.equal(snapshot.session.recording, 'stopped'); assert.equal(snapshot.session.scope.origin, 'https://recipient.test');
  assert.notEqual(snapshot.session.id, original.session.id); assert.equal(snapshot.session.startedAt, at.toISOString());
  assert.match(snapshot.session.notes, /no se ejecutaron/);
  assert.equal(snapshot.steps.length, 3); assert.equal(snapshot.steps[0].recordingBoundary, 'start'); assert.equal(snapshot.steps.at(-1).recordingBoundary, 'stop');
  assert(snapshot.steps.every(step => step.at === at.toISOString() && step.sessionId === snapshot.session.id));
  assert.notEqual(mark.id, original.annotations[0].id); assert.equal(mark.caseId, snapshot.session.id);
  for (const field of ['bounds', 'viewport', 'pathname', 'note', 'color']) assert.deepEqual(mark[field], original.annotations[0][field]);
  assert.equal(mark.createdAt, at.toISOString()); assert.equal(mark.updatedAt, at.toISOString());
  const event = snapshot.events[0]; assert.equal(event.at, at.toISOString()); assert.equal(event.stepId, snapshot.steps[1].id);
  assert.equal(snapshot.steps[1].targetId, mark.id); assert.deepEqual(event.responseBody, original.events[0].responseBody);
  const json = recordingJson({ review: snapshot, context: { schemaVersion: '1.0', capturedAt: at.toISOString(), page: { url: 'https://recipient.test/cuidados', pathname: '/cuidados', title: '', viewport: mark.viewport },
    build: { environment: 'preview' }, rules: [], target: null, annotations: result.annotations, privacy: { redactions: [] } } });
  const again = await importRecordingJson(json, settings());
  assert.equal(again.annotations[0].note, mark.note); assert.equal(again.draft.snapshot.steps.length, 3);
});

test('orphan marks become timeline steps, missing boundaries are recreated and empty recordings are rejected', async () => {
  const value = source(); value.steps = []; value.events = [];
  const result = await importRecordingJson(JSON.stringify(value), settings());
  assert.equal(result.draft.snapshot.steps.length, 3); assert.equal(result.draft.snapshot.steps[1].targetId, result.annotations[0].id);
  value.annotations = [];
  await assert.rejects(importRecordingJson(JSON.stringify(value), settings()), /vacía/);
});

test('malformed, oversized, unsupported, duplicate, dangling, credential and injected inputs never enter a recording', async () => {
  await assert.rejects(importRecordingJson('{', settings()), /No se pudo leer/);
  await assert.rejects(importRecordingJson(' '.repeat(RECORDING_JSON_MAX_CHARACTERS + 1), settings()), /límite/);
  const cases = [
    value => { value.schemaVersion = '99'; },
    value => { value.__protoField = {}; },
    value => { value.steps[1].id = value.events[0].id; },
    value => { value.events[0].stepId = 'missing'; },
    value => { value.annotations[0].bounds.width = -1; },
    value => { value.annotations[0].pathname = '//outside.test'; },
    value => { value.steps[1].pathname = 'https://outside.test'; },
    value => { value.events[0].responseBody.text = '{"token":"private-secret"}'; },
    value => { value.events[0].responseBody.text = 'x'.repeat(8001); },
    value => { value.steps[1].artifactIds = ['missing-image']; },
    value => { value.events.push({ ...value.events[0] }); },
  ];
  for (const mutate of cases) { const value = source(); mutate(value); await assert.rejects(importRecordingJson(JSON.stringify(value), settings())); }
});
