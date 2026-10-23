import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createReviewEngine } from '../dist/review/session.js';

const at = '2026-10-14T12:00:00.000Z';
const scope = { origin: 'https://preview.example.test', pathname: '/animals' };
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4x8AAAAASUVORK5CYII=', 'base64'));
const capture = { kind: 'viewport', provider: 'Browser capture', viewport: { width: 1280, height: 800, dpr: 1 } };
function engine(limits) { return createReviewEngine({ now: () => new Date(at), ...(limits ? { limits } : {}) }); }
function start(review, options = {}) { return review.startSession({ requestId: 'start', objective: 'Revisar animales', scope, actor: 'agent', ...options }); }
function point(review, requestId = 'point', options = {}) { return review.checkpoint({ requestId, label: 'Listado visible', pathname: scope.pathname, ...options }); }
function image(review, requestId = 'image', options = {}) { return review.addArtifact({ requestId, mimeType: 'image/png', bytes: png, capturedAt: at, pathname: scope.pathname, capture, redactionStatus: 'applied', ...options }); }
function privacy(review, requestId = 'privacy') { return review.reviewPrivacy({ requestId, expectedRevision: review.getSnapshot().revision, confirmed: true }); }

test('session reads have no side effects and recording needs separate explicit authorization', () => {
  const review = engine();
  assert.equal(review.getSnapshot().session, null);
  assert.equal(review.getSnapshot().revision, 0);
  assert.equal(point(review).error.code, 'SESSION_NOT_ACTIVE');
  const result = start(review);
  assert.equal(result.status, 'ok');
  assert.equal(result.data.recording, 'off');
  assert.equal(result.data.actor, 'agent');
  assert.equal(result.data.attribution, 'declared');
  assert.equal(review.getSnapshot().session.recording, 'off');
  assert.equal(review.startRecording({ requestId: 'denied', authorized: false }).error.code, 'RECORDING_NOT_AUTHORIZED');
  assert.equal(review.recordEvent({ requestId: 'not-recording', kind: 'interaction', label: 'Guardar' }).error.code, 'RECORDING_NOT_AUTHORIZED');
  assert.equal(review.startRecording({ requestId: 'record', authorized: true }).data.recording, 'active');
  assert.equal(review.endSession({ requestId: 'end' }).data.recording, 'stopped');
  assert.equal(review.getSnapshot().session.status, 'ended');
});

test('public callers cannot assign verified user identity', () => {
  const review = engine();
  const result = start(review, { actor: 'user', attribution: 'verified' });
  assert.equal(result.data.actor, 'user');
  assert.equal(result.data.attribution, 'declared');
});

test('requestId mutations are idempotent and stale findings do not overwrite the latest revision', async () => {
  const review = engine();
  const first = start(review);
  assert.deepEqual(start(review), first);
  const step = point(review);
  assert.deepEqual(point(review), step);
  const [a, b] = await Promise.all([image(review, 'same-image', { stepId: step.data.id }), image(review, 'same-image', { stepId: step.data.id })]);
  assert.deepEqual(a, b);
  assert.equal(review.getSnapshot().artifacts.length, 1);
  assert.equal(review.getSnapshot().steps.length, 1);
  assert.equal(review.startRecording({ requestId: 'point', authorized: true }).error.code, 'INVALID_INPUT');
  const revision = review.getSnapshot().revision;
  const input = { requestId: 'finding', expectedRevision: revision, title: 'No actualiza', type: 'bug', observed: 'El listado quedó igual', stepIds: [step.data.id], artifactIds: [a.data.id] };
  const finding = review.addFinding(input);
  assert.equal(finding.status, 'ok');
  assert.deepEqual(review.addFinding(input), finding);
  assert.equal(review.addFinding({ ...input, requestId: 'stale', id: finding.data.id }).error.code, 'REVISION_CONFLICT');
  assert.equal(review.getSnapshot().findings.length, 1);
});

test('evidence keeps actual immutable bytes, hashes and valid references; imports whitelist metadata', async () => {
  const review = engine(); start(review);
  const step = point(review).data;
  const bytes = new Uint8Array(png);
  const promise = image(review, 'image', { bytes, stepId: step.id, redactionStatus:'disabled', capture:{...capture,toolbarHidden:false}, body: 'body-secret', headers: 'header-secret', response: 'response-secret' });
  bytes.fill(0);
  const result = await promise;
  assert.equal(result.status, 'ok');
  assert.equal(result.data.sha256, createHash('sha256').update(png).digest('hex'));
  assert.equal(result.data.byteLength, png.byteLength);
  assert.equal(result.data.redactionStatus,'disabled'); assert.equal(result.data.capture.toolbarHidden,false);
  assert.deepEqual(review.getSnapshot().steps[0].artifactIds, [result.data.id]);
  const read = review.readArtifact(result.data.id); read.fill(0);
  assert.deepEqual(review.readArtifact(result.data.id), png);
  assert.equal(review.readArtifact('/tmp/image.png'), null);
  result.data.notes = 'mutated';
  assert.equal(review.getSnapshot().artifacts[0].notes, '');
  assert.doesNotMatch(JSON.stringify(review.getSnapshot()), /body-secret|header-secret|response-secret/);
  assert.equal((await image(review, 'invalid', { bytes: new Uint8Array([1, 2, 3]) })).error.code, 'INVALID_INPUT');
  assert.equal((await image(review, 'unredacted', { redactionStatus: 'failed' })).error.code, 'INVALID_INPUT');
  assert.equal((await image(review, 'invalid-toolbar-policy', { capture:{...capture,toolbarHidden:'hidden'} })).error.code,'INVALID_INPUT');
  assert.equal(review.addFinding({ requestId: 'invalid-reference', expectedRevision: review.getSnapshot().revision, title: 'Error', type: 'bug', observed: 'Error visible', stepIds: ['missing'], artifactIds: [] }).error.code, 'REFERENCE_NOT_FOUND');
});

test('privacy confirmation belongs to a revision and export freezes copies with exclusions', async () => {
  const review = engine(); start(review); point(review);
  const first = await image(review, 'first');
  assert.equal(review.freezeForExport({ expectedRevision: review.getSnapshot().revision }).error.code, 'PRIVACY_REVIEW_REQUIRED');
  privacy(review);
  const frozen = review.freezeForExport({ expectedRevision: review.getSnapshot().revision });
  assert.equal(frozen.status, 'ok');
  const frozenRevision = frozen.data.snapshot.revision;
  const second = await image(review, 'second');
  assert.equal(review.getSnapshot().privacy.reviewedRevision, null);
  assert.equal(review.freezeForExport({ expectedRevision: review.getSnapshot().revision }).error.code, 'PRIVACY_REVIEW_REQUIRED');
  assert.equal(frozen.data.snapshot.revision, frozenRevision);
  assert.equal(frozen.data.snapshot.artifacts.length, 1);
  assert.equal(frozen.data.readArtifact(second.data.id), null);
  assert.deepEqual(frozen.data.readArtifact(first.data.id), png);
  const frozenBytes = frozen.data.readArtifact(first.data.id); frozenBytes.fill(0);
  assert.deepEqual(frozen.data.readArtifact(first.data.id), png);
  review.setEvidenceExcluded({ requestId: 'exclude', artifactId: first.data.id, excluded: true });
  assert.equal(review.getSnapshot().artifacts[0].status, 'excluded');
  assert.deepEqual(review.readArtifact(first.data.id), png, 'exclusion preserves the session original');
  privacy(review, 'privacy-again');
  assert.equal(review.freezeForExport({ expectedRevision: review.getSnapshot().revision }).data.readArtifact(first.data.id), null);
  assert.deepEqual(frozen.data.readArtifact(first.data.id), png, 'a previous frozen review is isolated from later exclusion');
});

test('privacy confirmation can be explicitly revoked without losing existing evidence', async () => {
  const review = engine(); start(review); const stored = await image(review);
  privacy(review);
  const result = review.reviewPrivacy({ requestId: 'revoke-privacy', expectedRevision: review.getSnapshot().revision, confirmed: false });
  assert.equal(result.status, 'ok');
  assert.equal(review.getSnapshot().privacy.reviewedRevision, null);
  assert.equal(review.freezeForExport({ expectedRevision: review.getSnapshot().revision }).error.code, 'PRIVACY_REVIEW_REQUIRED');
  assert.deepEqual(review.readArtifact(stored.data.id), png);
});

test('event and image limits preserve existing evidence, show partial collection and deduplicate rejected retries', async () => {
  const review = engine({ maxEvents: 2, maxImages: 1, maxBytes: 1024 }); start(review);
  point(review); review.startRecording({ requestId: 'record', authorized: true });
  review.recordEvent({ requestId: 'click', kind: 'interaction', label: 'Consultar animales' });
  const limited = review.recordEvent({ requestId: 'limit', kind: 'interaction', label: 'Guardar' });
  assert.equal(limited.error.code, 'LIMIT_REACHED');
  assert.deepEqual(review.recordEvent({ requestId: 'limit', kind: 'interaction', label: 'Guardar' }), limited);
  assert.equal(review.getSnapshot().partial.droppedEvents, 1);
  assert.equal(review.getSnapshot().events.length, 1);
  assert.equal(review.getSnapshot().partial.isPartial, true);
  const first = await image(review);
  assert.equal(first.status, 'ok');
  assert.equal((await image(review, 'image-over-limit')).error.code, 'LIMIT_REACHED');
  assert.deepEqual(review.readArtifact(first.data.id), png);
  const small = engine({ maxBytes: png.byteLength - 1 }); start(small);
  assert.equal((await image(small)).error.code, 'LIMIT_REACHED');
  assert.equal(small.getSnapshot().bytesStored, 0);
  assert.equal(small.getSnapshot().artifacts.length, 0);
});

test('stale selections and late captures fail explicitly after the current route changes', async () => {
  const review = engine(); start(review, { scope: { ...scope, targetId: 'target-1' } });
  assert.equal(point(review, 'wrong-target', { targetId: 'target-2' }).error.code, 'STALE_TARGET');
  const step = point(review, 'good-target', { targetId: 'target-1' }).data;
  const pending = image(review, 'late-image', { stepId: step.id });
  review.updateLocation({ ...scope, pathname: '/care' });
  assert.equal((await pending).error.code, 'STALE_CAPTURE');
  assert.equal(point(review, 'old-path').error.code, 'STALE_TARGET');
  assert.equal(point(review, 'new-path', { pathname: '/care' }).status, 'ok');
  assert.equal(review.getSnapshot().artifacts.length, 0);
});

test('failure metadata creates no fabricated bytes and exclusion can restore the original failure', async () => {
  const review = engine(); start(review);
  const result = await image(review, 'failure', { bytes: undefined, status: 'failed', redactionStatus: 'failed', failureReason: 'Proveedor denegado' });
  assert.equal(result.status, 'ok');
  assert.equal(result.data.status, 'failed');
  assert.equal(result.data.byteLength, undefined);
  assert.equal(result.data.retrieval, undefined);
  assert.equal(review.readArtifact(result.data.id), null);
  assert.equal(review.getSnapshot().partial.isPartial, true);
  review.setEvidenceExcluded({ requestId: 'exclude', artifactId: result.data.id, excluded: true });
  assert.equal(review.getSnapshot().partial.isPartial, false);
  assert.deepEqual(review.getSnapshot().partial.reasons, []);
  assert.equal(review.getSnapshot().artifacts[0].status, 'excluded');
  assert.equal(review.getSnapshot().artifacts[0].failureReason, 'Proveedor denegado');
  const restored = review.setEvidenceExcluded({ requestId: 'restore', artifactId: result.data.id, excluded: false });
  assert.equal(restored.data.status, 'failed');
  assert.equal(review.getSnapshot().partial.isPartial, true);
  assert.deepEqual(review.getSnapshot().partial.reasons, ['Hay capturas fallidas o ausentes.']);
});

test('excluding failed and missing attempts only removes their current warning, preserving irreversible event-limit gaps', async () => {
  const review = engine({ maxEvents: 1 }); start(review); point(review);
  const failed = await image(review, 'failed-attempt', { bytes: undefined, status: 'failed', redactionStatus: 'failed' });
  const missing = await image(review, 'missing-attempt', { bytes: undefined, status: 'missing', redactionStatus: 'failed' });
  assert.equal(point(review, 'over-limit').error.code, 'LIMIT_REACHED');
  review.setEvidenceExcluded({ requestId: 'exclude-failed', artifactId: failed.data.id, excluded: true });
  assert.ok(review.getSnapshot().partial.reasons.includes('Hay capturas fallidas o ausentes.'), 'another included missing attempt still needs review');
  review.setEvidenceExcluded({ requestId: 'exclude-missing', artifactId: missing.data.id, excluded: true });
  let snapshot = review.getSnapshot();
  assert.equal(snapshot.partial.isPartial, true);
  assert.equal(snapshot.partial.droppedEvents, 1);
  assert.deepEqual(snapshot.partial.reasons, ['Se alcanzó el límite de eventos y puntos de control.']);
  assert.equal(snapshot.artifacts.length, 2, 'excluded attempts remain in session history');
  review.setEvidenceExcluded({ requestId: 'restore-failed', artifactId: failed.data.id, excluded: false });
  snapshot = review.getSnapshot();
  assert.equal(snapshot.artifacts[0].status, 'failed');
  assert.equal(snapshot.partial.reasons.length, 2);
  assert.ok(snapshot.partial.reasons.includes('Hay capturas fallidas o ausentes.'));
  assert.equal(snapshot.partial.droppedEvents, 1);
});

test('abstract events retain only allowed network fields and observed actor stays unknown', () => {
  const review = engine(); start(review); review.startRecording({ requestId: 'record', authorized: true });
  const step = point(review, 'error-state', { simulated: true }).data;
  const result = review.recordEvent({ requestId: 'fetch', kind: 'fetch', resource: 'Animales https://private.example.test/raw?token=url-secret',
    method: 'GET', status: 500, outcome: 'http_error', durationMs: 12.4, stepId: step.id, correlation: 'temporal', simulated: true,
    body: 'body-secret', headers: 'header-secret', response: 'response-secret', url: 'https://private.example.test/url-secret' });
  assert.equal(result.data.actor, 'unknown');
  assert.equal(result.data.attribution, 'unknown');
  assert.equal(result.data.correlation, 'temporal');
  assert.equal(result.data.simulated, true);
  assert.equal(result.data.durationMs, 12);
  assert.doesNotMatch(JSON.stringify(review.getSnapshot()), /url-secret|body-secret|header-secret|response-secret|private.example/);
  const finding = review.addFinding({ requestId: 'finding', expectedRevision: review.getSnapshot().revision, title: 'Error simulado', type: 'observation', observed: '500 de demostración', stepIds: [step.id], artifactIds: [] });
  assert.equal(finding.data.simulated, true);
  assert.equal(finding.data.reproducibility, 'notChecked');
});

test('sanitized notes and session copies never preserve local paths, credentials or arbitrary object fields', () => {
  const review = engine();
  start(review, { objective: 'Revisar C:\\Users\\owner\\secret.txt token=hidden owner@example.test', scope: { origin: 'https://user:password@preview.example.test?token=hidden', pathname: '/animals?token=hidden' } });
  const step = point(review).data;
  review.updateNotes({ requestId: 'notes', stepId: step.id, notes: 'Ver /Users/owner/private/file token=hidden owner@example.test', localPath: 'path-secret' });
  const snapshot = review.getSnapshot(); snapshot.session.objective = 'Mutado'; snapshot.steps[0].notes = 'Mutado';
  assert.doesNotMatch(JSON.stringify(review.getSnapshot()), /hidden|owner@example|C:\\\\Users|\/Users\/owner|path-secret|password|Mutado/);
  assert.equal(review.getSnapshot().session.scope.origin, scope.origin);
  assert.equal(review.getSnapshot().session.scope.pathname, scope.pathname);
});
