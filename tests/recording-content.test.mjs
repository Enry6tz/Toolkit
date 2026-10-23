import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewEngine } from '../dist/review/session.js';
import { hasRecordingContent, isEmptyStoppedRecording } from '../dist/review/recording-content.js';

function fixture() {
  const engine = createReviewEngine();
  engine.startSession({ requestId: 'session', objective: 'Grabación', scope: { origin: 'https://preview.example.test', pathname: '/' } });
  engine.startRecording({ requestId: 'start', authorized: true });
  engine.checkpoint({ requestId: 'begin', label: 'Inicio de la grabación', pathname: '/', recordingBoundary: 'start' });
  return engine;
}

test('only explicit lifecycle boundaries are empty, and active recoverable drafts are not discarded', () => {
  const engine = fixture();
  assert.equal(hasRecordingContent(engine.getSnapshot()), false);
  assert.equal(isEmptyStoppedRecording(engine.getSnapshot()), false);
  engine.stopRecording({ requestId: 'stop' });
  engine.checkpoint({ requestId: 'end', label: 'Fin de la grabación', pathname: '/', recordingBoundary: 'stop' });
  assert.equal(isEmptyStoppedRecording(engine.getSnapshot()), true);
  engine.checkpoint({ requestId: 'user-label', label: 'Fin de la grabación', pathname: '/' });
  assert.equal(isEmptyStoppedRecording(engine.getSnapshot()), false);
});

test('orphan network events preserve a recording after its last user step is removed', () => {
  const engine = fixture();
  const point = engine.checkpoint({ requestId: 'point', label: 'Revisar tabla', pathname: '/' }).data;
  engine.recordEvent({ requestId: 'orphan', kind: 'fetch', resource: 'Vuelos', method: 'GET', outcome: 'pending' });
  engine.stopRecording({ requestId: 'stop' });
  engine.removeStep({ requestId: 'remove', stepId: point.id });
  assert.equal(hasRecordingContent(engine.getSnapshot()), true);
  assert.equal(isEmptyStoppedRecording(engine.getSnapshot()), false);
});
