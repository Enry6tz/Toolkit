import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { createReviewEngine } from '../dist/review/session.js';
import { validateReviewDraft } from '../dist/review/persistence.js';

const at = new Date().toISOString();
const scope = { origin: 'https://preview.example.test', pathname: '/passenger' };
const make = () => createReviewEngine({ locale: 'es', now: () => new Date(at) });
function start(engine, requestId = 'start') {
  return engine.startCase({ requestId, mode: 'test', title: 'probar el buscador', detail: 'No acepta el mismo destino',
    steps: ['Elegir el mismo origen y destino', 'Buscar'], expected: 'Explicar cómo corregirlo', additionalContext: '', scope });
}
function mutation(engine, requestId, extra = {}) {
  return { requestId, caseId: engine.getSnapshot().case.id, expectedRevision: engine.getSnapshot().revision, ...extra };
}
function propose(engine) {
  const prepared = engine.prepareCase(mutation(engine, 'prepare'));
  assert.equal(prepared.status, 'ok');
  return engine.submitRefinement(mutation(engine, 'proposal', { proposal: { title: 'Validar origen y destino diferentes',
    steps: ['En el buscador, seleccionar el mismo aeropuerto en Origen y Destino.', 'Pulsar Buscar vuelos.'],
    expected: 'Impedir la búsqueda y mostrar una explicación.', details: 'La validación impide continuar.', sourceDocIds: ['domain'] } }));
}

test('case refinement preserves original instructions, requires current review and approval, and never starts recording', () => {
  const engine = make();
  assert.equal(start(engine).status, 'ok');
  const original = structuredClone(engine.getSnapshot().case.original);
  assert.equal(engine.submitRefinement(mutation(engine, 'unprepared', { proposal: { title: 'x', steps: [], expected: '' } })).error.code, 'REVISION_CONFLICT');
  const proposal = propose(engine);
  assert.equal(proposal.status, 'ok');
  assert.deepEqual(engine.getSnapshot().case.original, original);
  assert.equal(engine.getSnapshot().case.status, 'proposed');
  assert.equal(engine.getSnapshot().case.approvedProposalId, undefined);
  const stale = mutation(engine, 'stale-approval', { expectedRevision: engine.getSnapshot().revision - 1, proposalId: proposal.data.proposal.id });
  assert.equal(engine.approveRefinement(stale).error.code, 'REVISION_CONFLICT');
  const approved = engine.approveRefinement(mutation(engine, 'approve', { proposalId: proposal.data.proposal.id }));
  assert.equal(approved.data.status, 'approved');
  const reviewed = engine.reviewPrivacy({ requestId: 'privacy', expectedRevision: engine.getSnapshot().revision, confirmed: true });
  assert.equal(reviewed.data.case.status, 'approved', 'privacy review keeps the explicitly approved wording');
  assert.equal(engine.freezeForExport({ expectedRevision: engine.getSnapshot().revision }).status, 'ok');
  assert.equal(engine.getSnapshot().session.recording, 'off');
  assert.deepEqual(engine.getSnapshot().steps, []);
  assert.deepEqual(engine.getSnapshot().artifacts, []);
  engine.checkpoint({ requestId: 'later-evidence', label: 'Otra pantalla', pathname: scope.pathname });
  assert.equal(engine.getSnapshot().case.status, 'draft');
  assert.equal(engine.getSnapshot().case.approvedProposalId, undefined);
  assert.equal(engine.approveRefinement(mutation(engine, 'approve-old-proposal', { proposalId: proposal.data.proposal.id })).error.code, 'REVISION_CONFLICT');
});

test('new cases isolate evidence and reject replacement of active recording; case edits use compare-and-swap', () => {
  const engine = make(); start(engine);
  engine.checkpoint({ requestId: 'old-point', label: 'Caso anterior', pathname: scope.pathname });
  engine.startRecording({ requestId: 'record', authorized: true });
  assert.equal(start(engine, 'blocked-start').error.code, 'RECORDING_NOT_AUTHORIZED');
  const previousId = engine.getSnapshot().case.id;
  engine.stopRecording({ requestId: 'stop' });
  assert.equal(start(engine, 'new-start').status, 'ok');
  assert.notEqual(engine.getSnapshot().case.id, previousId);
  assert.deepEqual(engine.getSnapshot().steps, []);
  assert.deepEqual(engine.getSnapshot().events, []);
  const stale = mutation(engine, 'old-edit');
  engine.updateCase(mutation(engine, 'new-edit', { title: 'Título actual' }));
  assert.equal(engine.updateCase({ ...stale, title: 'Título obsoleto' }).error.code, 'REVISION_CONFLICT');
  assert.equal(engine.getSnapshot().case.original.title, 'Título actual');
  const sanitized = engine.updateCase(mutation(engine, 'public-edit', { detail: 'token=secret C:\\Users\\owner\\private.txt' }));
  assert.doesNotMatch(sanitized.data.original.detail, /secret|Users/);
});

test('same-origin subpages continue both cases and legacy recordings, and cross-origin pages remain outside scope', () => {
  for (const legacy of [false, true]) {
    const engine = make();
    if (legacy) engine.startSession({ requestId: 'start', objective: 'Recorrer aplicación', scope }); else start(engine);
    engine.startRecording({ requestId: 'record', authorized: true });
    engine.updateLocation({ ...scope, pathname: '/passenger/search' });
    assert.equal(engine.getSnapshot().session.recording, 'active');
    assert.equal(engine.getSnapshot().session.scope.pathname, '/passenger/search');
    assert.equal(engine.getSnapshot().steps.at(-1).label, 'Navegó a /passenger/search');
    assert.equal(engine.checkpoint({ requestId: 'new-page', label: 'Resultados', pathname: '/passenger/search' }).status, 'ok');
    assert.equal(engine.checkpoint({ requestId: 'stale-path', label: 'Pantalla anterior', pathname: '/passenger' }).error.code, 'STALE_TARGET');
    engine.updateLocation({ origin: 'https://another.example.test', pathname: '/passenger/search' });
    assert.equal(engine.checkpoint({ requestId: 'other-origin', label: 'Ajeno', pathname: '/passenger/search' }).error.code, 'STALE_TARGET');
  }
});

test('durable cases restore original and proposal but require fresh approval and never restore recording', async () => {
  const engine = make(); start(engine); propose(engine);
  engine.approveRefinement(mutation(engine, 'approve', { proposalId: engine.getSnapshot().case.proposal.id }));
  const draft = engine.exportDraft(), restored = make();
  const result = await restored.restoreDraft(draft);
  assert.equal(result.status, 'ok', JSON.stringify(result.error));
  assert.deepEqual(result.data.case.original, draft.snapshot.case.original);
  assert.deepEqual(result.data.case.proposal, draft.snapshot.case.proposal);
  assert.equal(result.data.case.status, 'draft');
  assert.equal(result.data.case.approvedProposalId, undefined);
  assert.equal(result.data.session.recording, 'stopped');
  for (const corrupt of [
    value => { value.snapshot.case.id = 'another-case'; },
    value => { value.snapshot.case.proposal.sourceDocIds = ['domain', 'domain']; },
    value => { value.snapshot.case.proposal.execute = 'anything'; },
  ]) {
    const invalid = structuredClone(draft); corrupt(invalid);
    assert.equal((await make().restoreDraft(invalid)).error.code, 'INVALID_INPUT');
  }
});

test('editing, preparing and restoring retain historical wording without approving it until a fresh submission and review', async () => {
  const engine = make(); start(engine); propose(engine);
  const previous = structuredClone(engine.getSnapshot().case.proposal);
  engine.approveRefinement(mutation(engine, 'approve-first', { proposalId: previous.id }));
  const updated = engine.updateCase(mutation(engine, 'edit-original', { title: 'Comprobar otra condición del buscador' }));
  assert.equal(updated.data.status, 'draft');
  assert.deepEqual(updated.data.proposal, previous, 'editing preserves the previous suggestion as history');
  assert.equal(updated.data.approvedProposalId, undefined);
  assert.equal(engine.approveRefinement(mutation(engine, 'cannot-approve-history', { proposalId: previous.id })).error.code, 'REVISION_CONFLICT');
  const prepared = engine.prepareCase(mutation(engine, 'prepare-current'));
  assert.equal(prepared.data.status, 'prepared');
  assert.deepEqual(prepared.data.proposal, previous);
  assert.notEqual(prepared.data.preparedRevision, previous.basedOnRevision);
  assert.equal(engine.approveRefinement(mutation(engine, 'cannot-approve-before-resubmit', { proposalId: previous.id })).error.code, 'REVISION_CONFLICT');
  const persisted = await validateReviewDraft(engine.exportDraft());
  assert.deepEqual(persisted.snapshot.case.proposal, previous, 'a prepared case may retain an older suggestion');
  for (const status of ['proposed', 'approved']) {
    const corrupt = structuredClone(persisted); corrupt.snapshot.case.status = status;
    if (status === 'approved') corrupt.snapshot.case.approvedProposalId = previous.id;
    await assert.rejects(validateReviewDraft(corrupt), error => error.code === 'INVALID_DRAFT');
  }
  const restored = make();
  assert.equal((await restored.restoreDraft(persisted)).status, 'ok');
  assert.equal(restored.getSnapshot().case.status, 'draft');
  assert.deepEqual(restored.getSnapshot().case.proposal, previous);
  assert.equal(restored.approveRefinement(mutation(restored, 'restore-cannot-approve-history', { proposalId: previous.id })).error.code, 'REVISION_CONFLICT');
  restored.prepareCase(mutation(restored, 'restore-prepare'));
  const preparedRevision = restored.getSnapshot().case.preparedRevision;
  const resubmitted = restored.submitRefinement(mutation(restored, 'resubmit-history', { proposal: previous }));
  assert.equal(resubmitted.status, 'ok');
  assert.notEqual(resubmitted.data.proposal.id, previous.id);
  assert.equal(resubmitted.data.proposal.basedOnRevision, preparedRevision);
  assert.equal(resubmitted.data.status, 'proposed');
  assert.equal(resubmitted.data.approvedProposalId, undefined);
  const approved = restored.approveRefinement(mutation(restored, 'approve-current', { proposalId: resubmitted.data.proposal.id }));
  assert.equal(approved.status, 'ok');
  assert.equal(approved.data.status, 'approved');
  assert.equal(approved.data.approvedProposalId, resubmitted.data.proposal.id);
  assert.equal((await validateReviewDraft(restored.exportDraft())).snapshot.case.status, 'approved');
});

let server, browser, base;
before(async () => {
  server = createServer(async (req, res) => {
    const pathname = (req.url ?? '').split('?')[0];
    if (/^\/dist\/[a-z0-9/_-]+\.js$/i.test(pathname)) {
      try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(fileURLToPath(new URL(`..${pathname}`, import.meta.url)))); }
      catch { res.writeHead(404).end(); }
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Case integration fixture</title><main><h1>Buscador</h1><button>Buscar vuelos</button></main>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });
async function fixture(page, persistenceKey) {
  return page.evaluate(async persistenceKey => {
    const { createReviewController } = await import('/dist/review/controller.js');
    const { captureContext } = await import('/dist/browser/context.js');
    const { createAgentContext } = await import('/dist/core/agent.js');
    window.mediaCalls = 0;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia() { window.mediaCalls++; throw new Error('Unexpected browser sharing request'); } } });
    window.controller = createReviewController({ locale: 'es', window, getTarget: () => null,
      getLegacyContext: async () => createAgentContext(captureContext({ build: { environment: 'preview', buildId: 'case-fixture' },
        knowledge: { schemaVersion: '1.0', documents: [{ id: 'domain', label: 'Dominio', content: 'Origen y destino deben diferir.', checksum: 'f'.repeat(64) }] } })),
      activity: { resources: [] },
      ...(persistenceKey ? { review: { persistence: { key: persistenceKey } } } : {}),
    });
    return window.controller.getContext();
  }, persistenceKey);
}

test('controller records without screen sharing, follows subpages, validates document references and restores the case on its new path', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(base + '/passenger'); await fixture(page);
    const proof = await page.evaluate(async () => {
      const controller = window.controller;
      const started = await controller.operations.startCase({ requestId: 'start', mode: 'report', title: 'Mi recorrido' });
      const recorded = await controller.operations.startRecording({ requestId: 'record', authorized: true, captureRequired: false });
      history.pushState({}, '', '/passenger/search'); controller.updateLocation();
      document.querySelector('button').click();
      const point = await controller.operations.checkpoint({ requestId: 'point', label: 'En subpágina' });
      const stopped = await controller.operations.stopRecording({ requestId: 'stop' });
      let context = await controller.getContext();
      const prepared = await controller.operations.prepareCase({ requestId: 'prepare', caseId: started.data.id, expectedRevision: context.revision });
      context = await controller.getContext();
      const bad = await controller.operations.submitRefinement({ requestId: 'bad-source', caseId: started.data.id, expectedRevision: context.revision,
        proposal: { title: 'Mejorado', steps: ['Abrir buscador'], expected: 'Validar', sourceDocIds: ['not-published'] } });
      const proposal = await controller.operations.submitRefinement({ requestId: 'proposal', caseId: started.data.id, expectedRevision: context.revision,
        proposal: { title: 'Mejorado', steps: ['Abrir buscador'], expected: 'Validar', sourceDocIds: ['domain'] } });
      const result = { started, recorded, point, stopped, prepared, bad, proposal, mediaCalls: window.mediaCalls, snapshot: controller.snapshot() };
      controller.dispose(); return result;
    });
    for (const operation of ['started', 'recorded', 'point', 'stopped', 'prepared', 'proposal'])
      assert.equal(proof[operation].status, 'ok', `${operation}: ${JSON.stringify(proof[operation])}`);
    assert.equal(proof.mediaCalls, 0);
    assert.deepEqual(proof.snapshot.artifacts, [], 'events-only recording does not fabricate failed images');
    assert.equal(proof.snapshot.steps.some(step => step.label === 'Navegó a /passenger/search'), true);
    assert.equal(proof.bad.error.code, 'REFERENCE_NOT_FOUND');
    await page.reload();
    const restored = await fixture(page);
    assert.equal(restored.storage.restored, true);
    assert.equal(restored.review.case.id, proof.snapshot.case.id);
    assert.equal(restored.review.case.proposal.title, 'Mejorado');
    assert.equal(restored.review.session.recording, 'stopped');
    assert.equal(restored.review.session.scope.pathname, '/passenger/search');
    assert.equal(await page.evaluate(() => window.mediaCalls), 0);
    await page.evaluate(() => window.controller.dispose());
  } finally { await page.close(); }
});

test('starting another case archives original instructions and real PNG bytes first; archive failure preserves the current case', async () => {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 });
  try {
    await page.goto(base + '/passenger');
    const key = 'long'.repeat(50);
    await fixture(page, key);
    const initial = await page.evaluate(async () => {
      const started = await window.controller.operations.startCase({ requestId: 'first', mode: 'test', title: 'No perder este caso' });
      const image = await window.controller.operations.checkpoint({ requestId: 'capture', label: 'Buscador antes del cambio',
        capture: { phase: 'begin', kind: 'viewport', privacy: 'visible' } });
      return { started, image };
    });
    assert.equal(initial.image.status, 'ok', JSON.stringify(initial.image.error));
    const screenshot = await page.screenshot({ type: 'png' });
    const proof = await page.evaluate(async ({ token, base64, capturedAt }) => {
      const controller = window.controller;
      const image = await controller.operations.checkpoint({ requestId: 'capture', capture: { phase: 'complete', token, base64,
        capturedAt, pixelWidth: 960, pixelHeight: 640, provider: 'isolated-chromium-real-screenshot' } });
      const next = await controller.operations.startCase({ requestId: 'second', mode: 'report', title: 'Nuevo caso separado' });
      const { loadReviewDraft } = await import('/dist/review/persistence.js');
      const archive = next.archivedDraft ? await loadReviewDraft(window, next.archivedDraft.key) : null;
      const currentBeforeFailure = controller.snapshot();
      Object.defineProperty(window, 'indexedDB', { configurable: true, value: { open() { throw new DOMException('quota', 'QuotaExceededError'); } } });
      const failed = await controller.operations.startCase({ requestId: 'third', mode: 'design', title: 'No debe reemplazar el actual' });
      const currentAfterFailure = controller.snapshot();
      controller.dispose();
      return { image, next, archive, currentBeforeFailure, failed, currentAfterFailure };
    }, { token: initial.image.data.capture.token, base64: screenshot.toString('base64'), capturedAt: new Date().toISOString() });
    assert.equal(proof.image.status, 'ok', JSON.stringify(proof.image.error));
    assert.equal(proof.next.status, 'ok', JSON.stringify(proof.next.error));
    assert.ok(proof.next.archivedDraft.key.length <= 200);
    assert.equal(proof.archive.snapshot.case.id, initial.started.data.id);
    assert.equal(proof.archive.snapshot.case.original.title, 'No perder este caso');
    assert.equal(proof.archive.files.length, 1);
    assert.equal(createHash('sha256').update(new Uint8Array(Object.values(proof.archive.files[0].bytes))).digest('hex'), proof.image.data.sha256);
    assert.deepEqual(proof.currentBeforeFailure.artifacts, []);
    assert.equal(proof.failed.error.code, 'CAPABILITY_UNAVAILABLE');
    assert.match(proof.failed.error.message, /Sigue abierto/);
    assert.deepEqual(proof.currentAfterFailure, proof.currentBeforeFailure);
  } finally { await page.close(); }
});
