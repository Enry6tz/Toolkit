import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { createReviewEngine } from '../dist/review/session.js';
import { loadReviewDraft, saveReviewDraft, validateReviewDraft, REVIEW_DRAFT_TTL_MS } from '../dist/review/persistence.js';

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4x8AAAAASUVORK5CYII=';
const png = new Uint8Array(Buffer.from(pngBase64, 'base64'));
const at = new Date().toISOString();
const scope = { origin: 'https://preview.example.test', pathname: '/animals' };
const capture = { kind: 'viewport', provider: 'real-browser-fixture', viewport: { width: 1, height: 1, dpr: 1 }, toolbarHidden: true };
const make = options => createReviewEngine({ now: () => new Date(at), ...options });
async function recordedDraft() {
  const engine = make();
  engine.startSession({ requestId: 'start', objective: 'Revisar animales', scope, actor: 'user' });
  const point = engine.checkpoint({ requestId: 'point', label: 'Lista visible', pathname: scope.pathname }).data;
  const image = await engine.addArtifact({ requestId: 'image', stepId: point.id, bytes: png, mimeType: 'image/png', capturedAt: at,
    pathname: scope.pathname, capture, redactionStatus: 'disabled' });
  engine.startRecording({ requestId: 'record', authorized: true });
  engine.recordEvent({ requestId: 'fetch', kind: 'fetch', at, resource: 'Animales', method: 'GET', outcome: 'pending', status: null, stepId: point.id });
  engine.addFinding({ requestId: 'finding', expectedRevision: engine.getSnapshot().revision, title: 'Carga pendiente', type: 'observation',
    observed: 'La lista sigue cargando', stepIds: [point.id], artifactIds: [image.data.id] });
  engine.reviewPrivacy({ requestId: 'privacy', expectedRevision: engine.getSnapshot().revision, confirmed: true });
  return { engine, image: image.data, point, draft: engine.exportDraft() };
}

test('draft roundtrip keeps immutable real PNG bytes and references, restores stopped and invalidates privacy', async () => {
  const { engine, draft, image, point } = await recordedDraft();
  assert.equal(draft.snapshot.session.recording, 'active');
  assert.equal(draft.snapshot.privacy.reviewedRevision, draft.snapshot.revision);
  const restored = make();
  const result = await restored.restoreDraft(draft);
  assert.equal(result.status, 'ok', JSON.stringify(result.error));
  assert.equal(result.data.session.status, 'active');
  assert.equal(result.data.session.recording, 'stopped');
  assert.equal(result.data.privacy.reviewedRevision, null);
  assert.equal(result.data.revision, draft.snapshot.revision + 1);
  assert.equal(result.data.session.revision, result.data.revision);
  assert.equal(result.data.events[0].outcome, 'incomplete');
  assert.deepEqual(result.data.steps[0].artifactIds, [image.id]);
  assert.deepEqual(result.data.findings[0].stepIds, [point.id]);
  assert.deepEqual(restored.readArtifact(image.id), png);
  draft.files[0].bytes.fill(0);
  assert.deepEqual(restored.readArtifact(image.id), png);
  assert.deepEqual(engine.readArtifact(image.id), png);
  const next = restored.checkpoint({ requestId: 'point', label: 'Nueva observación', pathname: scope.pathname });
  assert.equal(next.status, 'ok', 'old request IDs are not restored as live retries');
  assert.notEqual(next.data.id, point.id, 'restored IDs cannot collide with newly generated IDs');
  assert.equal(restored.recordEvent({ requestId: 'unexpected-record', kind: 'interaction', label: 'Guardar' }).error.code, 'RECORDING_NOT_AUTHORIZED');
});

test('drafts reject corrupt hashes, invalid references, injected transport data and incompatible schemas atomically', async () => {
  const { draft } = await recordedDraft();
  for (const change of [
    value => { value.files[0].bytes[40] ^= 1; },
    value => { value.snapshot.findings[0].artifactIds = ['unknown-artifact']; },
    value => { value.nonce = 'transport-must-not-persist'; },
    value => { value.snapshot.schemaVersion = '1.0'; },
    value => { value.snapshot.events[0].body = 'must-not-persist'; },
  ]) {
    const changed = structuredClone(draft); change(changed);
    let notifications = 0;
    const restored = make({ onChange: () => notifications++ });
    const result = await restored.restoreDraft(changed);
    assert.equal(result.status, 'error');
    assert.equal(restored.getSnapshot().session, null);
    assert.equal(restored.getSnapshot().bytesStored, 0);
    assert.equal(notifications, 0);
  }
});

test('old and over-limit drafts are rejected without replacing current review work', async () => {
  const { draft } = await recordedDraft();
  const expired = structuredClone(draft);
  expired.snapshot.session.startedAt = expired.snapshot.session.lastActivityAt = new Date(Date.parse(at) - REVIEW_DRAFT_TTL_MS - 1000).toISOString();
  await assert.rejects(validateReviewDraft(expired, { now: Date.parse(at) }), error => error.code === 'EXPIRED_DRAFT');
  const small = make({ limits: { maxBytes: png.length - 1 } });
  assert.equal((await small.restoreDraft(draft)).error.code, 'LIMIT_REACHED');
  assert.equal(small.getSnapshot().session, null);
  const existing = make();
  existing.startSession({ requestId: 'existing', objective: 'Trabajo nuevo', scope });
  const before = existing.getSnapshot();
  assert.equal((await existing.restoreDraft(draft)).error.code, 'SESSION_ALREADY_ACTIVE');
  assert.deepEqual(existing.getSnapshot(), before);
});

test('async restore cannot publish after disposal, abortion or a concurrent edit', async () => {
  const { draft } = await recordedDraft();
  let active = true, notifications = 0;
  const restored = make({ onChange: () => notifications++ });
  const restoring = restored.restoreDraft(draft, { isCurrent: () => active });
  active = false;
  assert.equal((await restoring).status, 'error');
  assert.equal(restored.getSnapshot().session, null);
  assert.equal(notifications, 0);
  const abort = new AbortController();
  const aborted = make();
  const pending = aborted.restoreDraft(draft, { signal: abort.signal }); abort.abort();
  assert.equal((await pending).status, 'error');
  assert.equal(aborted.getSnapshot().session, null);
  const edited = make();
  const racing = edited.restoreDraft(draft);
  edited.startSession({ requestId: 'new-work', objective: 'Conservar el trabajo nuevo', scope });
  assert.equal((await racing).error.code, 'REVISION_CONFLICT');
  assert.equal(edited.getSnapshot().session.objective, 'Conservar el trabajo nuevo');
});

test('excluded real files and excluded failed attempts retain reversible states after recovery', async () => {
  const { engine, image } = await recordedDraft();
  const failed = await engine.addArtifact({ requestId: 'failed-image', mimeType: 'image/png', capturedAt: at, pathname: scope.pathname,
    status: 'failed', redactionStatus: 'failed', failureReason: 'Captura cancelada' });
  engine.setEvidenceExcluded({ requestId: 'exclude-image', artifactId: image.id, excluded: true });
  engine.setEvidenceExcluded({ requestId: 'exclude-failure', artifactId: failed.data.id, excluded: true });
  const restored = make();
  assert.equal((await restored.restoreDraft(engine.exportDraft())).status, 'ok');
  assert.deepEqual(restored.readArtifact(image.id), png);
  assert.equal(restored.setEvidenceExcluded({ requestId: 'include-image', artifactId: image.id, excluded: false }).data.status, 'available');
  assert.equal(restored.setEvidenceExcluded({ requestId: 'include-failed', artifactId: failed.data.id, excluded: false }).data.status, 'failed');
  assert.equal(restored.getSnapshot().partial.isPartial, true);
});

test('unavailable storage and quota failures return explicit errors and leave memory unchanged', async () => {
  const { engine, draft } = await recordedDraft();
  const view = { location: { origin: scope.origin }, setTimeout, clearTimeout,
    indexedDB: { open() { throw new DOMException('quota', 'QuotaExceededError'); } } };
  const before = engine.getSnapshot();
  await assert.rejects(saveReviewDraft(view, 'review', draft), error => error.code === 'PERSISTENCE_QUOTA');
  await assert.rejects(loadReviewDraft({ ...view, indexedDB: undefined }, 'review'), error => error.code === 'PERSISTENCE_UNAVAILABLE');
  assert.deepEqual(engine.getSnapshot(), before);
});

let server, browser, base;
before(async () => {
  server = createServer(async (req, res) => {
    if (req.url === '/api/animals') { res.setHeader('content-type', 'application/json'); res.end('{"items":[]}'); return; }
    if (req.url === '/' || req.url === '/reloaded') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Local draft test</title><main><button data-ai-id="refresh">Actualizar animales</button></main>'); return; }
    const path = (req.url ?? '').split('?')[0];
    if (!/^\/dist\/[a-z0-9/_-]+\.js$/i.test(path)) { res.writeHead(404).end(); return; }
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(fileURLToPath(new URL(`..${path}`, import.meta.url)))); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

test('real IndexedDB survives page reload with PNG bytes and rejects stale, expired or aborted writes', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(base);
    const initial = await page.evaluate(async pngBase64 => {
      const { createReviewEngine } = await import('/dist/review/session.js');
      const persistence = await import('/dist/review/persistence.js');
      const engine = createReviewEngine();
      const now = new Date().toISOString();
      engine.startSession({ requestId: 'start', objective: 'Revisión local', scope: { origin: location.origin, pathname: '/' } });
      const step = engine.checkpoint({ requestId: 'point', label: 'Estado original', pathname: '/' }).data;
      const bytes = Uint8Array.from(atob(pngBase64), value => value.charCodeAt(0));
      const image = await engine.addArtifact({ requestId: 'image', stepId: step.id, bytes, mimeType: 'image/png', capturedAt: new Date().toISOString(),
        pathname: '/', capture: { kind: 'viewport', provider: 'real-PNG-fixture', viewport: { width: 1, height: 1, dpr: 1 } }, redactionStatus: 'disabled' });
      engine.startRecording({ requestId: 'record', authorized: true });
      const first = engine.exportDraft();
      await persistence.saveReviewDraft(window, 'roundtrip', first);
      engine.checkpoint({ requestId: 'point-later', label: 'Cambio posterior', pathname: '/' });
      const latest = engine.exportDraft();
      await persistence.saveReviewDraft(window, 'roundtrip', latest);
      await persistence.saveReviewDraft(window, 'roundtrip', first);
      const abort = new AbortController();
      engine.checkpoint({ requestId: 'point-aborted', label: 'No debe guardarse', pathname: '/' });
      const writing = persistence.saveReviewDraft(window, 'roundtrip', engine.exportDraft(), { signal: abort.signal });
      abort.abort();
      let abortCode; try { await writing; } catch (error) { abortCode = error.code; }
      return { imageId: image.data.id, hash: image.data.sha256, revision: latest.snapshot.revision, abortCode, at: now };
    }, pngBase64);
    assert.equal(initial.abortCode, 'PERSISTENCE_ABORTED');
    await page.goto(`${base}/reloaded`);
    const recovered = await page.evaluate(async () => {
      const { createReviewEngine } = await import('/dist/review/session.js');
      const { loadReviewDraft } = await import('/dist/review/persistence.js');
      const draft = await loadReviewDraft(window, 'roundtrip');
      const restored = createReviewEngine();
      const result = await restored.restoreDraft(draft);
      return { result, bytes: Array.from(restored.readArtifact(draft.files[0].id)), binary: draft.files[0].bytes instanceof Uint8Array,
        localStorageKeys: Object.keys(localStorage), draftRevision: draft.snapshot.revision };
    });
    assert.equal(recovered.result.status, 'ok', JSON.stringify(recovered.result.error));
    assert.equal(recovered.binary, true);
    assert.deepEqual(recovered.bytes, Array.from(png));
    assert.equal(recovered.result.data.artifacts[0].sha256, initial.hash);
    assert.equal(recovered.draftRevision, initial.revision, 'an older save never overwrites the latest revision');
    assert.equal(recovered.result.data.session.recording, 'stopped');
    assert.equal(recovered.result.data.privacy.reviewedRevision, null);
    assert.equal(recovered.result.data.steps.length, 2);
    assert.deepEqual(recovered.localStorageKeys, [], 'binary evidence is not encoded into localStorage');
    const expired = await page.evaluate(async () => {
      const { loadReviewDraft, deleteReviewDraft, REVIEW_DRAFT_TTL_MS } = await import('/dist/review/persistence.js');
      await new Promise((resolve, reject) => {
        const open = indexedDB.open('ai-context-toolbar-review-drafts', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result, tx = db.transaction('reviews', 'readwrite'), store = tx.objectStore('reviews');
          const id = `${location.origin}\u0000roundtrip`, request = store.get(id);
          request.onsuccess = () => { const entry = request.result; entry.savedAt = Date.now() - REVIEW_DRAFT_TTL_MS - 1000;
            entry.expiresAt = entry.savedAt + REVIEW_DRAFT_TTL_MS; store.put(entry, id); };
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
        };
      });
      let code; try { await loadReviewDraft(window, 'roundtrip'); } catch (error) { code = error.code; }
      await deleteReviewDraft(window, 'roundtrip');
      return { code, afterDelete: await loadReviewDraft(window, 'roundtrip') };
    });
    assert.equal(expired.code, 'EXPIRED_DRAFT');
    assert.equal(expired.afterDelete, null);
  } finally { await page.close(); }
});

async function createControllerFixture(page, key) {
  return page.evaluate(async key => {
    const { createReviewController } = await import('/dist/review/controller.js');
    const { captureContext } = await import('/dist/browser/context.js');
    const { createAgentContext } = await import('/dist/core/agent.js');
    const target = () => document.querySelector('[data-ai-id="refresh"]');
    window.reviewController = createReviewController({ locale: 'es', window, getTarget: target,
      getLegacyContext: async () => createAgentContext(captureContext({
        build: { environment: 'preview', buildId: 'persistence-fixture' }, target: target(),
      })),
      activity: { resources: [{ name: 'Animales', path: '/api/animals' }] },
      review: { persistence: { key } },
    });
    const context = await window.reviewController.getContext();
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    const hash = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
    const tab = sessionStorage.getItem(`ai-context-toolbar:tab:${hash}`);
    window.reviewPersistenceKey = `review-tab:${hash}:${tab}`;
    return context;
  }, key);
}

test('JSON import storage failures preserve the live and durable recording and remove uncommitted marks', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(base); await createControllerFixture(page, 'json-import-failure');
    const proof = await page.evaluate(async () => {
      const { recordingJson } = await import('/dist/review/recording.js');
      const { loadReviewDraft } = await import('/dist/review/persistence.js');
      const controller = window.reviewController;
      await controller.operations.beginRecording({ requestId: 'begin-import-failure', authorized: true });
      await controller.operations.checkpoint({ requestId: 'content-import-failure', label: 'Trabajo previo' });
      await controller.operations.stopRecording({ requestId: 'stop-import-failure' });
      const before = controller.snapshot(), record = JSON.parse(recordingJson(await controller.getContext()));
      record.annotations = [{ id: 'shared-mark', caseId: record.session.id, kind: 'area', pathname: '/', createdAt: record.session.startedAt, updatedAt: record.session.startedAt,
        label: 'Marca compartida', note: 'Revisar esta zona', bounds: { x: 10, y: 20, width: 100, height: 80 }, viewport: { width: 960, height: 640 }, element: null, relatedElements: [] }];
      const json = JSON.stringify(record), originalSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('ai-context:annotations:1:')) throw new DOMException('Test mark quota', 'QuotaExceededError');
        return originalSet.call(this, key, value);
      };
      let markError;
      try { await controller.importRecording(json); } catch (error) { markError = error.message; }
      finally { Storage.prototype.setItem = originalSet; }
      const afterMarks = controller.snapshot(), originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, key) {
        if (key === `${location.origin}\u0000${window.reviewPersistenceKey}`) throw new DOMException('Test replacement quota', 'QuotaExceededError');
        return originalPut.call(this, value, key);
      };
      let draftError;
      try { await controller.importRecording(json); } catch (error) { draftError = error.message; }
      finally { IDBObjectStore.prototype.put = originalPut; }
      const afterDraft = controller.snapshot(), durable = await loadReviewDraft(window, window.reviewPersistenceKey);
      const markKeys = Object.keys(localStorage).filter(key => key.startsWith('ai-context:annotations:1:'));
      const marks = await controller.importRecording(json), imported = controller.snapshot();
      const summaries = await controller.listSavedCases();
      controller.dispose();
      return { before, markError, afterMarks, draftError, afterDraft, durable: durable.snapshot.session.id, markKeys, marks, imported, summaries };
    });
    assert.match(proof.markError, /guardar las marcas/); assert.deepEqual(proof.afterMarks, proof.before);
    assert.match(proof.draftError, /guardado local|espacio|borrador local/); assert.deepEqual(proof.afterDraft, proof.before);
    assert.equal(proof.durable, proof.before.session.id); assert.deepEqual(proof.markKeys, []);
    assert.equal(proof.marks.length, 1); assert.equal(proof.imported.session.recording, 'stopped');
    assert.equal(proof.imported.steps.length, proof.before.steps.length + 1);
    assert(proof.summaries.some(item => item.sessionId === proof.before.session.id));
    assert(proof.summaries.some(item => item.sessionId === proof.imported.session.id));
    assert.equal(proof.summaries.find(item => item.sessionId === proof.imported.session.id).stepCount, proof.imported.steps.length);
  } finally { await page.close(); }
});

test('real controller restores a browser screenshot and recording after reload without restoring capture permission', async () => {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 });
  try {
    await page.goto(base);
    await createControllerFixture(page, 'controller-roundtrip');
    const begun = await page.evaluate(async () => {
      const controller = window.reviewController;
      await controller.operations.startSession({ requestId: 'session', objective: 'Reproducir carga de animales', actor: 'user' });
      return controller.operations.checkpoint({ requestId: 'image', label: 'Lista antes de consultar',
        capture: { phase: 'begin', kind: 'region', privacy: 'visible' } });
    });
    assert.equal(begun.status, 'ok', JSON.stringify(begun.error));
    const screenshot = await page.screenshot({ type: 'png' }), capturedAt = new Date().toISOString();
    const original = await page.evaluate(async ({ token, base64, capturedAt }) => {
      const controller = window.reviewController;
      const image = await controller.operations.checkpoint({ requestId: 'image', capture: { phase: 'complete', token, base64,
        capturedAt, pixelWidth: 960, pixelHeight: 640, provider: 'playwright-real-browser-screenshot' } });
      if (image.status === 'error') return { failure: image };
      // Abstract-only recording is an explicit existing SDK path. Its unavailable
      // native start image stays failed; the separate browser-tool PNG above is real.
      const recorded = await controller.operations.startRecording({ requestId: 'record', authorized: true });
      await fetch('/api/animals');
      await controller.operations.updateNotes({ requestId: 'notes', stepId: begunStep(), notes: 'La consulta fue observada desde el navegador.' });
      const privacy = await controller.operations.reviewPrivacy({ requestId: 'privacy', expectedRevision: controller.snapshot().revision, confirmed: true });
      const file = await controller.operations.getArtifact({ artifactId: image.data.id, transport: 'base64' });
      const context = await controller.getContext();
      controller.dispose();
      return { context, file, image: image.data, recorded, privacy };
      function begunStep() { return controller.snapshot().steps[0].id; }
    }, { token: begun.data.capture.token, base64: screenshot.toString('base64'), capturedAt });
    assert.equal(original.failure, undefined, JSON.stringify(original.failure));
    assert.equal(original.recorded.status, 'ok');
    assert.equal(original.privacy.status, 'ok');
    assert.equal(original.context.review.session.recording, 'active');
    assert.equal(original.context.review.privacy.reviewedRevision, original.context.revision);
    const actualImage = Buffer.from(original.file.data.base64, 'base64');
    assert.equal(createHash('sha256').update(actualImage).digest('hex'), original.image.sha256);
    assert.deepEqual(actualImage.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(original.context.review.events.some(event => event.kind === 'fetch' && event.resource === 'Animales' && event.status === 200), true);
    await page.reload();
    const restored = await createControllerFixture(page, 'controller-roundtrip');
    const file = await page.evaluate(artifactId => window.reviewController.operations.getArtifact({ artifactId, transport: 'base64' }), original.image.id);
    assert.equal(restored.storage.restored, true);
    assert.equal(restored.review.session.id, original.context.review.session.id);
    assert.equal(restored.review.session.recording, 'stopped');
    assert.equal(restored.review.session.status, 'active');
    assert.equal(restored.review.privacy.reviewedRevision, null);
    assert.ok(restored.revision > original.context.revision);
    assert.equal(restored.context.target.accessibleName, 'Actualizar animales');
    assert.deepEqual(restored.review.steps.map(step => step.id), original.context.review.steps.map(step => step.id));
    assert.deepEqual(restored.review.events.map(event => event.id), original.context.review.events.map(event => event.id));
    assert.deepEqual(Buffer.from(file.data.base64, 'base64'), actualImage);
    assert.equal(restored.review.artifacts.find(artifact => artifact.id === original.image.id).sha256, original.image.sha256);
    assert.equal(await page.evaluate(() => window.reviewController.isCaptureConnected()), false);
    assert.equal(restored.capabilities.captureViewport.status, 'unavailable', 'restored bytes do not recreate a screenshot provider or its grant');
    await page.evaluate(() => window.reviewController.dispose());
  } finally { await page.close(); }
});

test('forgetSavedDraft stays deleted across reads and failed starts; a successful new session enables saving again', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(base);
    await createControllerFixture(page, 'controller-forget');
    const proof = await page.evaluate(async () => {
      const { loadReviewDraft } = await import('/dist/review/persistence.js');
      const controller = window.reviewController, key = window.reviewPersistenceKey;
      const started = await controller.operations.startSession({ requestId: 'first-session', objective: 'Primera revisión' });
      await controller.operations.checkpoint({ requestId: 'point', label: 'Antes de olvidar' });
      const storedBefore = await loadReviewDraft(window, key);
      await controller.forgetSavedDraft();
      await controller.getContext();
      const failedStart = await controller.operations.startSession({ requestId: 'failed-start', objective: 'No puede reemplazar una sesión activa' });
      await controller.operations.checkpoint({ requestId: 'later', label: 'Observación que debe quedar solo en memoria' });
      await controller.getContext();
      await new Promise(resolve => setTimeout(resolve, 450));
      const storedAfterReads = await loadReviewDraft(window, key);
      await controller.operations.endSession({ requestId: 'end' });
      const newSession = await controller.operations.startSession({ requestId: 'new-session', objective: 'Nueva revisión autorizada' });
      const storedAfterNewSession = await loadReviewDraft(window, key);
      controller.dispose();
      return { firstId: started.data.id, beforeId: storedBefore.snapshot.session.id, failedStart,
        storedAfterReads, newId: newSession.data.id, savedNewId: storedAfterNewSession?.snapshot.session.id };
    });
    assert.equal(proof.beforeId, proof.firstId);
    assert.equal(proof.failedStart.error.code, 'SESSION_ALREADY_ACTIVE');
    assert.equal(proof.storedAfterReads, null, 'reading and a rejected start must not silently restore a deleted draft');
    assert.notEqual(proof.newId, proof.firstId);
    assert.equal(proof.savedNewId, proof.newId);
  } finally { await page.close(); }
});

test('case history stays app-scoped and restores actual PNGs and original instructions while archiving the case being left', async () => {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 });
  try {
    await page.goto(base);
    await createControllerFixture(page, 'history-app');
    const begun = await page.evaluate(async () => {
      window.historyMediaCalls = 0;
      if (navigator.mediaDevices) navigator.mediaDevices.getDisplayMedia = async () => { window.historyMediaCalls++; throw new Error('No capture grant in this test'); };
      const controller = window.reviewController;
      await controller.operations.startCase({ requestId: 'history-a', mode: 'report', title: 'Primer caso con imagen',
        detail: 'Conservar la pantalla y su recorrido.', steps: ['Abrir Animales', 'Revisar el listado'], expected: 'Conservar la evidencia original.' });
      return controller.operations.checkpoint({ requestId: 'history-image-begin', label: 'Estado original', capture: { phase: 'begin', kind: 'viewport', privacy: 'visible' } });
    });
    assert.equal(begun.status, 'ok', JSON.stringify(begun.error));
    const screenshot = await page.screenshot({ type: 'png' });
    const proof = await page.evaluate(async ({ token, base64 }) => {
      const controller = window.reviewController;
      const image = await controller.operations.checkpoint({ requestId: 'history-image-complete', capture: { phase: 'complete', token, base64,
        capturedAt: new Date().toISOString(), pixelWidth: 960, pixelHeight: 640, provider: 'playwright-history-real-PNG' } });
      if (image.status !== 'ok') throw new Error(JSON.stringify(image.error));
      const first = controller.snapshot();
      await controller.operations.startCase({ requestId: 'history-b', mode: 'design', title: 'Segundo caso', detail: 'No debe desaparecer al abrir el primero.',
        steps: ['Comprobar el formulario'], expected: 'Conservar ambos casos.' });
      const second = controller.snapshot();
      const { createReviewEngine } = await import('/dist/review/session.js');
      const { saveReviewDraft } = await import('/dist/review/persistence.js');
      const other = createReviewEngine();
      other.startCase({ requestId: 'other', mode: 'test', title: 'Caso de otra aplicación', scope: { origin: location.origin, pathname: '/' } });
      await saveReviewDraft(window, 'different-app', other.exportDraft());
      const history = await controller.listSavedCases();
      let invalidIdError; try { await controller.restoreSavedCase('history-app:archive:invented-id'); } catch (error) { invalidIdError = error.message; }
      await controller.operations.startRecording({ requestId: 'history-record', authorized: true, captureRequired: false });
      let recordingError; try { await controller.restoreSavedCase(history[0].id); } catch (error) { recordingError = error.message; }
      const recordingStillActive = controller.snapshot().session.recording;
      await controller.operations.stopRecording({ requestId: 'history-stop' });
      await controller.restoreSavedCase(history[0].id);
      const restoredFirst = controller.snapshot();
      const restoredPng = controller.readFile(image.data.id);
      const secondHistory = await controller.listSavedCases();
      await controller.restoreSavedCase(secondHistory[0].id);
      const restoredSecond = controller.snapshot();
      const firstHistory = await controller.listSavedCases();
      await controller.restoreSavedCase(firstHistory[0].id);
      const firstAgain = controller.snapshot();
      const mediaCalls = window.historyMediaCalls;
      const connected = controller.isCaptureConnected();
      controller.dispose();
      return { first, second, history, invalidIdError, recordingError, recordingStillActive, restoredFirst,
        restoredPng: Array.from(restoredPng.bytes), secondHistory, restoredSecond, firstAgain, mediaCalls, connected };
    }, { token: begun.data.capture.token, base64: screenshot.toString('base64') });
    assert.deepEqual(proof.history.map(item => item.title), ['Primer caso con imagen']);
    assert.equal(Object.keys(proof.history[0]).sort().join(','), 'contentStepCount,id,mode,sessionId,startedAt,stepCount,title,updatedAt');
    assert.match(proof.history[0].id, /^[a-f0-9]{64}$/);
    assert.match(proof.invalidIdError, /historial actual/);
    assert.match(proof.recordingError, /Detené la grabación/);
    assert.equal(proof.recordingStillActive, 'active');
    assert.deepEqual(proof.restoredFirst.case.original, proof.first.case.original);
    assert.equal(proof.restoredFirst.case.id, proof.first.case.id);
    assert.equal(proof.restoredFirst.session.recording, 'stopped');
    assert.equal(proof.restoredFirst.privacy.reviewedRevision, null);
    assert.deepEqual(Buffer.from(proof.restoredPng), screenshot);
    assert.deepEqual(proof.secondHistory.map(item => item.title), ['Segundo caso']);
    assert.deepEqual(proof.restoredSecond.case.original, proof.second.case.original);
    assert.equal(proof.restoredSecond.session.recording, 'stopped');
    assert.equal(proof.firstAgain.artifacts[0].sha256, createHash('sha256').update(screenshot).digest('hex'));
    assert.equal(proof.firstAgain.case.id, proof.first.case.id);
    assert.equal(proof.mediaCalls, 0);
    assert.equal(proof.connected, false);
  } finally { await page.close(); }
});

test('corrupt history bytes and archive quota failures never replace or clear the open case', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(base);
    await createControllerFixture(page, 'history-failure');
    const proof = await page.evaluate(async pngBase64 => {
      const { createReviewEngine } = await import('/dist/review/session.js');
      const { saveReviewDraft, loadReviewDraft } = await import('/dist/review/persistence.js');
      const first = createReviewEngine({ id: kind => `${kind}-history-integrity` });
      first.startCase({ requestId: 'first', mode: 'report', title: 'Caso archivado', scope: { origin: location.origin, pathname: '/' } });
      const bytes = Uint8Array.from(atob(pngBase64), char => char.charCodeAt(0));
      await first.addArtifact({ requestId: 'first-image', bytes, mimeType: 'image/png', capturedAt: new Date().toISOString(), pathname: '/',
        capture: { kind: 'viewport', provider: 'real-PNG-fixture', viewport: { width: 1, height: 1, dpr: 1 } }, redactionStatus: 'disabled' });
      const archiveKey = `history-failure:archive:${first.getSnapshot().session.id}`;
      await saveReviewDraft(window, archiveKey, first.exportDraft());
      const controller = window.reviewController;
      await controller.operations.startCase({ requestId: 'current', mode: 'test', title: 'Trabajo actual que no debe perderse', steps: ['Paso original del actual'] });
      const before = controller.snapshot();
      const [archived] = await controller.listSavedCases();
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('ai-context-toolbar-review-drafts', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction('reviews', 'readwrite'), store = tx.objectStore('reviews');
          const id = `${location.origin}\u0000${archiveKey}`, read = store.get(id);
          read.onsuccess = () => { const entry = read.result; entry.draft.files[0].bytes[36] ^= 1; store.put(entry, id); };
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
        };
      });
      let integrityError; try { await controller.restoreSavedCase(archived.id); } catch (error) { integrityError = error.message; }
      const afterIntegrity = controller.snapshot();
      await saveReviewDraft(window, archiveKey, first.exportDraft());
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, key) {
        if (typeof key === 'string' && key.includes(`:archive:${before.session.id}`)) throw new DOMException('Test archive quota', 'QuotaExceededError');
        return originalPut.call(this, value, key);
      };
      let quotaError;
      try { await controller.restoreSavedCase(archived.id); } catch (error) { quotaError = error.message; }
      finally { IDBObjectStore.prototype.put = originalPut; }
      const afterQuota = controller.snapshot();
      const durable = await loadReviewDraft(window, window.reviewPersistenceKey);
      controller.dispose();
      return { before, integrityError, afterIntegrity, quotaError, afterQuota, durable: durable.snapshot.case };
    }, pngBase64);
    assert.match(proof.integrityError, /SHA-256/);
    assert.deepEqual(proof.afterIntegrity, proof.before);
    assert.match(proof.quotaError, /guardado local|espacio|borrador local/);
    assert.deepEqual(proof.afterQuota, proof.before);
    assert.equal(proof.durable.id, proof.before.case.id);
    assert.deepEqual(proof.durable.original.steps, ['Paso original del actual']);
  } finally { await page.close(); }
});

test('finished empty recordings are not persisted or listed while legacy user steps and other sessions remain intact', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(base);
    const proof = await page.evaluate(async () => {
      const { createReviewEngine } = await import('/dist/review/session.js');
      const { saveReviewDraft, loadReviewDraft, listReviewCases, REVIEW_DRAFT_TTL_MS } = await import('/dist/review/persistence.js');
      const key = 'empty-recordings', scope = { origin: location.origin, pathname: '/' };
      const empty = createReviewEngine();
      empty.startSession({ requestId: 'empty-session', objective: 'Vacía', scope });
      empty.startRecording({ requestId: 'empty-start', authorized: true });
      empty.checkpoint({ requestId: 'empty-begin', label: 'Inicio de la grabación', pathname: '/', recordingBoundary: 'start' });
      await saveReviewDraft(window, key, empty.exportDraft());
      const activeSaved = Boolean(await loadReviewDraft(window, key));
      const activeListed = await listReviewCases(window, key, []);
      empty.stopRecording({ requestId: 'empty-stop' });
      empty.checkpoint({ requestId: 'empty-end', label: 'Fin de la grabación', pathname: '/', recordingBoundary: 'stop' });
      const emptyDraft = empty.exportDraft();
      await saveReviewDraft(window, key, emptyDraft);
      const emptySaved = await loadReviewDraft(window, key);
      let legacySequence = 0;
      const legacy = createReviewEngine({ id: kind => `${kind}-legacy-${++legacySequence}` });
      legacy.startSession({ requestId: 'legacy-session', objective: 'Legacy con contenido', scope });
      legacy.startRecording({ requestId: 'legacy-start', authorized: true });
      legacy.checkpoint({ requestId: 'legacy-point', label: 'Inicio de la grabación', pathname: '/' });
      legacy.stopRecording({ requestId: 'legacy-stop' });
      await saveReviewDraft(window, key, legacy.exportDraft());
      await saveReviewDraft(window, key, emptyDraft);
      const surviving = await loadReviewDraft(window, key);
      // Simulate a saved empty archive from a previous client, bypassing today's save guard.
      const archiveKey = `${key}:archive:${emptyDraft.snapshot.session.id}`;
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('ai-context-toolbar-review-drafts', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, transaction = db.transaction('reviews', 'readwrite'), savedAt = Date.now();
          transaction.objectStore('reviews').put({ version: 1, origin: location.origin, savedAt, expiresAt: savedAt + REVIEW_DRAFT_TTL_MS, draft: emptyDraft }, `${location.origin}\u0000${archiveKey}`);
          transaction.oncomplete = () => { db.close(); resolve(); };
          transaction.onerror = () => { db.close(); reject(transaction.error); };
        };
      });
      const listed = await listReviewCases(window, key, [`${key}:archive:`]);
      return { activeSaved, activeListed, emptySaved, survivingId: surviving.snapshot.session.id, legacyId: legacy.getSnapshot().session.id, listed };
    });
    assert.equal(proof.activeSaved, true, 'active boundary-only drafts remain recoverable across navigation');
    assert.deepEqual(proof.activeListed, [], 'an ongoing recording never appears as a finished one');
    assert.equal(proof.emptySaved, null);
    assert.equal(proof.survivingId, proof.legacyId, 'a stale empty write does not erase a different recording');
    assert.deepEqual(proof.listed.map(item => item.sessionId), [proof.legacyId]);
  } finally { await page.close(); }
});

test('the controller discards an empty stop and removes every saved copy after the last meaningful step is deleted', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(base);
    await createControllerFixture(page, 'empty-controller');
    const proof = await page.evaluate(async () => {
      const { loadReviewDraft, saveReviewDraft } = await import('/dist/review/persistence.js');
      const controller = window.reviewController, key = window.reviewPersistenceKey;
      await controller.operations.beginRecording({ requestId: 'empty-begin', authorized: true });
      const emptyStop = await controller.operations.stopRecording({ requestId: 'empty-stop' });
      const emptySnapshot = controller.snapshot(), emptyStored = await loadReviewDraft(window, key), emptyHistory = await controller.listSavedCases();
      await controller.operations.beginRecording({ requestId: 'mark-begin', authorized: true });
      const mark = await controller.operations.checkpoint({ requestId: 'mark', label: 'Revisar el listado', notes: 'Última marca del recorrido' });
      await controller.operations.stopRecording({ requestId: 'mark-stop' });
      const before = await loadReviewDraft(window, key), archiveKey = `empty-controller:archive:${before.snapshot.session.id}`;
      await saveReviewDraft(window, archiveKey, before);
      const removed = await controller.operations.removeStep({ requestId: 'mark-remove', stepId: mark.data.id });
      const after = controller.snapshot(), saved = await loadReviewDraft(window, key), archived = await loadReviewDraft(window, archiveKey), history = await controller.listSavedCases();
      controller.dispose();
      return { emptyStop, emptySnapshot, emptyStored, emptyHistory, removed, after, saved, archived, history };
    });
    assert.equal(proof.emptyStop.data.discarded, true);
    assert.equal(proof.emptySnapshot.session, null);
    assert.equal(proof.emptyStored, null);
    assert.deepEqual(proof.emptyHistory, []);
    assert.equal(proof.removed.data.discarded, true);
    assert.equal(proof.after.session, null);
    assert.equal(proof.saved, null);
    assert.equal(proof.archived, null);
    assert.deepEqual(proof.history, []);
    await page.reload();
    const restored = await createControllerFixture(page, 'empty-controller');
    assert.equal(restored.review.session, null, 'a deleted final mark does not return after reload');
    await page.evaluate(() => window.reviewController.dispose());
  } finally { await page.close(); }
});
