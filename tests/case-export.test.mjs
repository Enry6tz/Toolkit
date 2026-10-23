import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { exportReviewBundle } from '../dist/review/export.js';

const at = '2026-10-14T12:00:00.000Z';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const image = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1kAAAAASUVORK5CYII=', 'base64'));
function fixture() {
  const snapshot = {
    schemaVersion: '2.0', revision: 12,
    session: { id: 'session-1', objective: 'Probar el buscador', scope: { origin: 'http://localhost:3002', pathname: '/pasajero/buscar-vuelos' }, actor: 'user', attribution: 'declared', status: 'active', recording: 'off', startedAt: at, lastActivityAt: at, revision: 12 },
    case: { id: 'session-1', mode: 'test', status: 'approved', preparedRevision: 9,
      original: { title: 'El buscador', detail: 'Quiero comprobar la validación.', steps: ['Cambiar el destino.', 'Buscar.'], expected: 'No aceptar el mismo aeropuerto.', additionalContext: 'Usar datos de prueba.' },
      proposal: { id: 'proposal-1', basedOnRevision: 9, title: 'Validar origen y destino iguales', details: 'Comprobar que el buscador impide una ruta con el mismo aeropuerto.', steps: ['Abrir el buscador con origen EZE.', 'Elegir EZE como destino.', 'Pulsar Buscar vuelos.'], expected: 'Mostrar la validación y conservar el formulario sin consultar vuelos.', summary: 'Se aclararon la condición y los pasos; no se ejecutó la prueba.', sourceDocIds: ['doc-reglas'], createdAt: at },
      approvedProposalId: 'proposal-1' },
    steps: [], events: [], findings: [], artifacts: [],
    privacy: { reviewedRevision: 12 }, partial: { isPartial: false, reasons: [], droppedEvents: 0 }, limits: { maxEvents: 200, maxImages: 20, maxBytes: 50_000_000 }, bytesStored: 0,
  };
  const content = 'El origen y el destino deben ser distintos.';
  const context = { legacyContext: { schemaVersion: '1.0', capturedAt: at,
    page: { url: 'http://localhost:3002/pasajero/buscar-vuelos', pathname: '/pasajero/buscar-vuelos', title: 'Buscar vuelos', viewport: { width: 1920, height: 889 } },
    build: { environment: 'production', buildId: 'sigv-local-context-s3-mock' }, target: null,
    rules: ['Los pagos son simulados.'], privacy: { redactions: [] },
    knowledge: { schemaVersion: '1.0', documents: [{ id: 'doc-reglas', label: 'Reglas de SIGV', content, checksum: sha256(content) }] } },
    domain: { name: 'SIGV', purpose: 'Gestionar vuelos', fictional: true, source: 'public-domain', provenance: 'declared' } };
  return { snapshot, frozen: { snapshot, readArtifact: id => id === 'capture-1' ? image.slice() : null }, options: { profile: 'bug', context, createdAt: at } };
}
function payload(bundle, path) {
  const file = bundle.files.find(file => file.path === path);
  assert.ok(file, path);
  return Buffer.from(file.bytes).toString();
}
function addStep(snapshot, id, label) {
  snapshot.steps.push({ id, sessionId: 'session-1', label, at, pathname: '/pasajero/buscar-vuelos', actor: 'unknown', attribution: 'unknown', simulated: false, artifactIds: [], notes: '' });
}

test('approved case produces one concise human document, without legacy profile requirements or fabricated execution', async () => {
  const { frozen, options } = fixture();
  for (const profile of ['bug', 'feature']) {
    const bundle = await exportReviewBundle(frozen, { ...options, profile });
    assert.equal(bundle.status, 'ready');
    assert.deepEqual(bundle.missingInformation, []);
    assert.equal(bundle.ticketMarkdown, bundle.featureBriefMarkdown);
    assert.match(bundle.ticketMarkdown, /^# Validar origen y destino iguales/);
    assert.match(bundle.ticketMarkdown, /Refinamiento aprobado/);
    assert.match(bundle.ticketMarkdown, /Reproducción no confirmada/);
    assert.match(bundle.ticketMarkdown, /1\. Abrir el buscador con origen EZE/);
    assert.match(bundle.ticketMarkdown, /2\. Elegir EZE como destino/);
    assert.match(bundle.ticketMarkdown, /3\. Pulsar Buscar vuelos/);
    assert.match(bundle.ticketMarkdown, /Datos: ficticios \(declarados por el proyecto\)/);
    assert.match(bundle.ticketMarkdown, /\[Reglas de SIGV\]\(documents\/document-001\.md\)/);
    assert.doesNotMatch(bundle.ticketMarkdown, /Momento:|Actor:|session-1|proposal-1|2026-10|Criterios de aceptación|Flujo propuesto|Información faltante|No se registraron consultas/);
    assert.ok(bundle.ticketMarkdown.length < 1_700, 'normal text-only case fits a short document');
    assert.equal(payload(bundle, profile === 'bug' ? 'ticket.md' : 'feature-brief.md'), bundle.ticketMarkdown);
    const technical = JSON.parse(payload(bundle, 'context.json'));
    assert.equal(technical.review.case.original.title, 'El buscador');
    assert.equal(technical.review.case.proposal.title, 'Validar origen y destino iguales');
    assert.equal(technical.review.case.proposal.summary, 'Se aclararon la condición y los pasos; no se ejecutó la prueba.');
    assert.equal(payload(bundle, 'documents/document-001.md'), 'El origen y el destino deben ser distintos.');
  }
});

test('unapproved or mismatched proposal never replaces the original in the human document', async () => {
  for (const [state, approval] of [['proposed', undefined], ['approved', 'different-proposal'], ['prepared', undefined]]) {
    const { frozen, options } = fixture();
    frozen.snapshot.case.status = state;
    frozen.snapshot.case.approvedProposalId = approval;
    const bundle = await exportReviewBundle(frozen, options);
    assert.equal(bundle.status, 'draft');
    assert.match(bundle.ticketMarkdown, /^# El buscador/);
    assert.match(bundle.ticketMarkdown, /1\. Cambiar el destino/);
    assert.doesNotMatch(bundle.ticketMarkdown, /Validar origen y destino iguales|Pulsar Buscar vuelos/);
    assert.ok(bundle.missingInformation.some(item => item.includes('aprobar')));
    assert.equal(JSON.parse(payload(bundle, 'context.json')).review.case.proposal.title, 'Validar origen y destino iguales');
  }
});

test('capture failures are precise, actual files stay intact and recording start/end are explicit', async () => {
  const { snapshot, frozen, options } = fixture();
  addStep(snapshot, 'record-start', 'Inicio de la grabación');
  addStep(snapshot, 'destination', 'Cambió Destino');
  addStep(snapshot, 'search', 'Buscar vuelos');
  addStep(snapshot, 'record-stop', 'Fin de la grabación');
  snapshot.artifacts.push({ id: 'capture-1', sessionId: 'session-1', stepId: 'record-stop', capturedAt: at, pathname: '/pasajero/buscar-vuelos', mimeType: 'image/png', status: 'available', byteLength: image.length, sha256: sha256(image), redactionStatus: 'disabled', simulated: false, notes: '' },
    { id: 'capture-2', sessionId: 'session-1', capturedAt: at, pathname: '/pasajero/buscar-vuelos', mimeType: 'image/png', status: 'failed', redactionStatus: 'notRequired', simulated: false, failureReason: 'El permiso de la pestaña se cerró.', notes: '' });
  const bundle = await exportReviewBundle(frozen, options);
  assert.equal(bundle.status, 'draft');
  assert.match(bundle.ticketMarkdown, /1\. Inicio → Cambió Destino → Buscar vuelos → Fin\./);
  assert.match(bundle.ticketMarkdown, /\[Captura 1 · Fin de la grabación\]\(screenshots\/evidence-001\.png\)/);
  assert.match(bundle.ticketMarkdown, /Captura 2: El permiso de la pestaña se cerró/);
  assert.match(bundle.ticketMarkdown, /1 captura no disponible/);
  assert.doesNotMatch(bundle.ticketMarkdown, /capture-2|ausente o excluida|proveedor no publicado|Actor:|Momento:/);
  assert.deepEqual(bundle.files.find(file => file.path === 'screenshots/evidence-001.png').bytes, image);
  assert.equal(bundle.manifest.references.find(ref => ref.id === 'capture-2').reason, 'El permiso de la pestaña se cerró.');
  assert.match(payload(bundle, 'journey/steps.md'), /Momento:.*2026-10-14/);
  for (const file of bundle.manifest.files) {
    const bytes = bundle.files.find(entry => entry.path === file.path).bytes;
    assert.equal(file.sha256, sha256(bytes));
  }
});

test('design case can omit reproduction steps and captures; missing cited document stays draft', async () => {
  const { frozen, options } = fixture();
  frozen.snapshot.case.mode = 'design';
  frozen.snapshot.case.proposal.steps = [];
  let bundle = await exportReviewBundle(frozen, { ...options, profile: 'feature' });
  assert.equal(bundle.status, 'ready');
  assert.match(bundle.featureBriefMarkdown, /Mejora de diseño/);
  assert.doesNotMatch(bundle.featureBriefMarkdown, /## Pasos|## Evidencia/);
  frozen.snapshot.case.proposal.sourceDocIds.push('doc-unavailable');
  bundle = await exportReviewBundle(frozen, { ...options, profile: 'feature' });
  assert.equal(bundle.status, 'draft');
  assert.match(bundle.featureBriefMarkdown, /referencias documentales que faltan/);
  assert.ok(bundle.missingInformation.some(item => item.includes('doc-unavailable')));
});

test('case export retains abstract network events and does not infer a defect from HTTP status', async () => {
  const { snapshot, frozen, options } = fixture();
  snapshot.events.push({ id: 'fetch-1', sessionId: 'session-1', kind: 'fetch', at, actor: 'unknown', attribution: 'unknown', simulated: true, resource: 'Vuelos', method: 'GET', status: 500, outcome: 'http_error', durationMs: 120 });
  const bundle = await exportReviewBundle(frozen, options);
  assert.match(bundle.ticketMarkdown, /GET Vuelos → HTTP 500 · SIMULADO/);
  assert.match(bundle.ticketMarkdown, /no demuestra causalidad/);
  assert.match(bundle.ticketMarkdown, /Reproducción no confirmada/);
  assert.doesNotMatch(bundle.ticketMarkdown, /fetch-1|duración:|Causa raíz|Error confirmado/);
  const events = JSON.parse(payload(bundle, 'journey/events.json')).events;
  assert.equal(events[0].id, 'fetch-1');
  assert.equal(events[0].durationMs, 120);
});

test('case approval cannot bypass privacy revision review or image integrity checks', async () => {
  const { frozen, options } = fixture();
  frozen.snapshot.privacy.reviewedRevision = 11;
  await assert.rejects(exportReviewBundle(frozen, options), /PRIVACY_REVIEW_REQUIRED/);
  frozen.snapshot.privacy.reviewedRevision = 12;
  frozen.snapshot.artifacts.push({ id: 'capture-1', sessionId: 'session-1', capturedAt: at, pathname: '/pasajero/buscar-vuelos', mimeType: 'image/png', status: 'available', byteLength: image.length, sha256: 'wrong-hash', redactionStatus: 'disabled', simulated: false, notes: '' });
  await assert.rejects(exportReviewBundle(frozen, options), /REVISION_CONFLICT/);
});
