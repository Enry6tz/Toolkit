import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewEngine } from '../dist/review/session.js';
import { validateReviewDraft } from '../dist/review/persistence.js';

const at = new Date().toISOString();
const scope = { origin: 'https://preview.example.test', pathname: '/flights' };
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4x8AAAAASUVORK5CYII=', 'base64'));
const capture = { kind: 'viewport', provider: 'real-browser-fixture', viewport: { width: 1, height: 1, dpr: 1 }, toolbarHidden: true };
function fixture(limits) {
  const engine = createReviewEngine({ now: () => new Date(at), ...(limits ? { limits } : {}) });
  engine.startSession({ requestId: 'session', objective: 'Grabación', scope, actor: 'user' });
  engine.startRecording({ requestId: 'record', authorized: true });
  return engine;
}
let nextPoint = 0;
function step(engine, label, extra = {}) { return engine.checkpoint({ requestId: `checkpoint-${++nextPoint}`, label, pathname: scope.pathname, ...extra }).data; }
function image(engine, requestId, stepId) { return engine.addArtifact({ requestId, stepId, bytes: png, mimeType: 'image/png', capturedAt: at, pathname: scope.pathname, capture, redactionStatus: 'disabled' }); }
function fetched(engine, requestId, stepId, text) {
  return engine.recordEvent({ requestId, stepId, kind: 'fetch', resource: 'Vuelos', method: 'POST', status: 200, outcome: 'success', durationMs: 20,
    requestBody: { status: 'captured', charLimit: 128, text: JSON.stringify({ request: text }), contentType: 'application/json' },
    responseBody: { status: 'captured', charLimit: 128, text: JSON.stringify({ response: text }), contentType: 'application/json' } });
}

test('removing a click deletes its linked requests and bodies while preserving other steps and the active recording', () => {
  const engine = fixture();
  const first = step(engine, 'Buscar vuelos'), second = step(engine, 'Elegir vuelo');
  const clicked = engine.recordEvent({ requestId: 'click-first', kind: 'interaction', stepId: first.id, label: 'Buscar vuelos' });
  const deleted = fetched(engine, 'fetch-first', first.id, 'deleted flight payload');
  fetched(engine, 'fetch-second', second.id, 'retained flight payload');
  engine.addFinding({ requestId: 'finding', expectedRevision: engine.getSnapshot().revision, title: 'Observación', type: 'observation', observed: 'Flujo revisado', stepIds: [first.id, second.id], artifactIds: [] });
  const privacy = { requestId: 'privacy-before-removal', expectedRevision: engine.getSnapshot().revision, confirmed: true };
  assert.equal(engine.reviewPrivacy(privacy).status, 'ok');
  const retained = engine.getSnapshot().events.find(event => event.stepId === second.id);
  const removed = engine.removeStep({ requestId: 'remove-first', stepId: first.id });
  assert.equal(removed.status, 'ok');
  assert.deepEqual(removed.data.eventIds, [clicked.data.id, deleted.data.id]);
  assert.deepEqual(removed.data.artifactIds, []);
  const snapshot = engine.getSnapshot();
  assert.deepEqual(snapshot.steps, [second]);
  assert.deepEqual(snapshot.events, [retained]);
  assert.deepEqual(snapshot.findings[0].stepIds, [second.id]);
  assert.deepEqual(snapshot.session.scope, scope);
  assert.equal(snapshot.session.recording, 'active');
  assert.doesNotMatch(JSON.stringify(snapshot), /deleted flight payload/);
  const replay = fetched(engine, 'fetch-first', first.id, 'deleted flight payload');
  assert.equal(replay.error.code, 'REFERENCE_NOT_FOUND', 'idempotent caches do not retain a removed body');
  const oldSnapshot = engine.reviewPrivacy(privacy);
  assert.equal(oldSnapshot.error.code, 'REFERENCE_NOT_FOUND', 'a cached full snapshot cannot expose the deleted body');
  assert.doesNotMatch(JSON.stringify(oldSnapshot), /deleted flight payload/);
  assert.equal(engine.getSnapshot().events.length, 1);
});

test('removing a pure selection checkpoint deletes its stored comment without ending the recording', async () => {
  const engine = fixture();
  engine.updateLocation({ ...scope, targetId: 'mark-1' });
  const mark = step(engine, 'Marca de la tabla', { targetId: 'mark-1', notes: 'Comentario de la marca que se quita' });
  const removed = engine.removeStep({ requestId: 'remove-mark', stepId: mark.id });
  assert.equal(removed.status, 'ok');
  assert.equal(engine.getSnapshot().steps.length, 0);
  assert.equal(engine.getSnapshot().events.length, 0);
  assert.equal(engine.getSnapshot().session.recording, 'active');
  assert.doesNotMatch(JSON.stringify(engine.exportDraft()), /Comentario de la marca/);
  await validateReviewDraft(engine.exportDraft(), { origin: scope.origin });
});

test('late completion of a removed pending request cannot recreate its event or payload', () => {
  const engine = fixture(), first = step(engine, 'Consulta pendiente');
  const pending = engine.recordEvent({ requestId: 'pending', kind: 'fetch', stepId: first.id, resource: 'Vuelos', method: 'GET', outcome: 'pending', status: null });
  engine.removeStep({ requestId: 'remove-pending', stepId: first.id });
  const revision = engine.getSnapshot().revision;
  const late = engine.updateNetworkEvent({ requestId: 'late', eventId: pending.data.id, status: 500, outcome: 'http_error', responseBody: { status: 'captured', charLimit: 128, text: '{"error":"late payload"}' } });
  assert.equal(late.error.code, 'REFERENCE_NOT_FOUND');
  assert.equal(engine.getSnapshot().revision, revision);
  assert.equal(engine.getSnapshot().events.length, 0);
  const recreate = fetched(engine, 'new-fetch-stale-step', first.id, 'late payload');
  assert.equal(recreate.error.code, 'REFERENCE_NOT_FOUND');
  assert.equal(engine.getSnapshot().events.length, 0);
});

test('removing a step frees legacy image bytes and exclusions and strips finding references', async () => {
  const engine = fixture({ maxBytes: png.length, maxImages: 1 });
  const first = step(engine, 'Pantalla anterior'), second = step(engine, 'Pantalla siguiente');
  const old = await image(engine, 'old-image', first.id);
  assert.equal(old.status, 'ok');
  engine.setEvidenceExcluded({ requestId: 'exclude-old', artifactId: old.data.id, excluded: true });
  engine.addFinding({ requestId: 'image-finding', expectedRevision: engine.getSnapshot().revision, title: 'Referencia de pantalla', type: 'observation', observed: 'Referencia registrada', stepIds: [first.id, second.id], artifactIds: [old.data.id] });
  assert.equal(engine.getSnapshot().bytesStored, png.length);
  const removed = engine.removeStep({ requestId: 'remove-image-step', stepId: first.id });
  assert.deepEqual(removed.data.artifactIds, [old.data.id]);
  assert.equal(engine.readArtifact(old.data.id), null);
  assert.equal(engine.getSnapshot().bytesStored, 0);
  assert.deepEqual(engine.getSnapshot().findings[0].artifactIds, []);
  assert.deepEqual(engine.getSnapshot().findings[0].stepIds, [second.id]);
  assert.deepEqual(engine.exportDraft().excludedStatuses, []);
  const next = await image(engine, 'next-image', second.id);
  assert.equal(next.status, 'ok', 'removal frees both the image count and byte budget');
  assert.equal(engine.getSnapshot().bytesStored, png.length);
  const checked = await validateReviewDraft(engine.exportDraft(), { origin: scope.origin });
  const restored = createReviewEngine();
  assert.equal((await restored.restoreDraft(checked)).status, 'ok');
  assert.deepEqual(restored.readArtifact(next.data.id), png);
  assert.equal(restored.readArtifact(old.data.id), null);
  assert.equal(restored.getSnapshot().artifacts.length, 1);
});

test('a hashing image for a removed step fails instead of reviving a dangling artifact', async () => {
  const engine = fixture(), first = step(engine, 'Captura pendiente');
  const pending = image(engine, 'hashing-image', first.id);
  engine.removeStep({ requestId: 'remove-hashing', stepId: first.id });
  const result = await pending;
  assert.equal(result.error.code, 'REFERENCE_NOT_FOUND');
  assert.equal(engine.getSnapshot().artifacts.length, 0);
  assert.equal(engine.getSnapshot().bytesStored, 0);
  assert.equal(engine.exportDraft().files.length, 0);
});

test('removing an unrelated step preserves another image awaiting its hash and its live step association', async () => {
  const engine = fixture(), first = step(engine, 'Paso para quitar'), second = step(engine, 'Paso para conservar');
  const pending = image(engine, 'preserved-image', second.id);
  engine.removeStep({ requestId: 'remove-unrelated', stepId: first.id });
  const result = await pending;
  assert.equal(result.status, 'ok');
  assert.deepEqual(engine.getSnapshot().steps[0].artifactIds, [result.data.id]);
  await validateReviewDraft(engine.exportDraft(), { origin: scope.origin });
});

test('removal validates identifiers, revision and session before mutation and remains idempotent', () => {
  const engine = fixture(), first = step(engine, 'Paso único');
  const before = engine.getSnapshot();
  assert.equal(engine.removeStep({ requestId: 'bad-id', stepId: '/not-an-id' }).error.code, 'INVALID_INPUT');
  assert.equal(engine.removeStep({ requestId: 'wrong-session', sessionId: 'session-other', stepId: first.id }).error.code, 'SESSION_NOT_FOUND');
  assert.equal(engine.removeStep({ requestId: 'stale', expectedRevision: before.revision - 1, stepId: first.id }).error.code, 'REVISION_CONFLICT');
  assert.deepEqual(engine.getSnapshot(), before);
  const input = { requestId: 'remove-once', expectedRevision: before.revision, stepId: first.id };
  const result = engine.removeStep(input);
  assert.equal(result.status, 'ok');
  const after = engine.getSnapshot();
  assert.deepEqual(engine.removeStep(input), result);
  assert.deepEqual(engine.getSnapshot(), after);
  assert.equal(engine.removeStep({ requestId: 'remove-missing', stepId: first.id }).error.code, 'REFERENCE_NOT_FOUND');
});
