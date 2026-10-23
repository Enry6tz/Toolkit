import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { caseMarkdown, exportCaseEvidence } from '../dist/review/index.js';
import { crc32 } from '../dist/review/zip.js';

const at = '2026-10-14T12:00:00.000Z';
function fixture() {
  const pathname = '/pasajero/buscar-vuelos';
  return {
    schemaVersion: '2.0', status: 'ok', revision: 12, preparedAt: at,
    context: { schemaVersion: '1.0', capturedAt: at,
      page: { url: `http://localhost:3002${pathname}?origin=EZE&destination=BRC&token=private-query#private-fragment`, pathname, publicQueryParams: ['origin', 'destination', 'token'], title: 'Buscar vuelos', viewport: { width: 1360, height: 1000 } },
      build: { environment: 'production', buildId: 'sigv-local-context-s3-mock' }, target: null,
      rules: ['Origen y destino deben ser distintos.'], privacy: { redactions: [] },
      knowledge: { schemaVersion: '1.0', documents: [
        { id: 'domain', label: 'Dominio', content: '# SIGV\nGestiona búsquedas y reservas simuladas.', checksum: 'a'.repeat(64) },
        { id: 'screens', label: 'Pantallas', content: '# Buscador\nLa página conserva los filtros enviados.', checksum: 'b'.repeat(64) },
        { id: 'rules', label: 'Reglas', content: '# Validación\nLos aeropuertos deben ser distintos.', checksum: 'c'.repeat(64) },
      ] } },
    capabilities: {}, design: { declared: null, observed: null }, instructions: 'RETIRED_RETURN_PROMPT_DO_NOT_COPY',
    domain: { name: 'SIGV', purpose: 'Buscar y reservar vuelos de prueba.', users: ['Pasajero'], glossary: [{ term: 'Ida', definition: 'Un tramo de la reserva.' }], entities: [{ name: 'Vuelo', description: 'Servicio entre dos aeropuertos.' }], relationships: [], flows: [{ name: 'Buscar', steps: ['Elegir filtros', 'Consultar vuelos'] }], rules: ['Origen y destino deben ser distintos.'], successCriteria: [], fictional: true, source: 'published-domain', provenance: 'declared' },
    review: { schemaVersion: '2.0', revision: 12,
      session: { id: 'case-1', objective: 'Título de sesión anterior', scope: { origin: 'http://localhost:3002', pathname }, actor: 'unknown', attribution: 'unknown', status: 'active', recording: 'off', startedAt: at, lastActivityAt: at, revision: 12 },
      case: { id: 'case-1', mode: 'test', status: 'draft', original: { title: 'Validar la ruta elegida', detail: 'Quiero comprobar qué pasa si coinciden los aeropuertos.', steps: ['Abrir el buscador.', 'Elegir EZE como origen y destino.', 'Buscar vuelos.'], expected: 'Mostrar la validación sin consultar vuelos.', additionalContext: 'Usar datos ficticios.' },
        proposal: { id: 'old-proposal', basedOnRevision: 9, title: 'PROPUESTA_ANTERIOR_NO_USAR', steps: ['PASO_ANTERIOR_NO_USAR'], expected: 'ESPERADO_ANTERIOR_NO_USAR', summary: 'RESUMEN_ANTERIOR_NO_USAR', details: 'DETALLE_ANTERIOR_NO_USAR', sourceDocIds: [], createdAt: at }, approvedProposalId: 'old-proposal' },
      steps: [], events: [], findings: [], artifacts: [], privacy: { reviewedRevision: null }, partial: { isPartial: false, reasons: [], droppedEvents: 0 }, limits: { maxEvents: 200, maxImages: 20, maxBytes: 50_000_000 }, bytesStored: 0 },
  };
}
function step(id, label, pathname = '/pasajero/buscar-vuelos', extra = {}) {
  return { id, sessionId: 'case-1', label, at, pathname, actor: 'unknown', attribution: 'unknown', simulated: false, artifactIds: [], notes: '', ...extra };
}
function artifact(id, status = 'available', extra = {}) {
  return { id, sessionId: 'case-1', capturedAt: at, pathname: '/pasajero/buscar-vuelos', mimeType: 'image/png', status, redactionStatus: 'disabled', simulated: false, notes: '', ...extra };
}

test('Markdown always uses original instructions without approval/privacy/export gates and preserves full project docs', () => {
  const input = fixture();
  for (const status of ['draft', 'prepared', 'proposed', 'approved']) {
    input.review.case.status = status;
    const markdown = caseMarkdown(input, { includeProjectContext: true });
    assert.match(markdown, /\*\*Caso:\*\* Validar la ruta elegida/);
    assert.match(markdown, /Probar: Quiero comprobar/);
    assert.match(markdown, /1\. Abrir el buscador\./);
    assert.match(markdown, /2\. Elegir EZE como origen y destino\./);
    assert.match(markdown, /3\. Buscar vuelos\./);
    assert.match(markdown, /## Comportamiento esperado\n\nMostrar la validación/);
    assert.match(markdown, /origin=EZE&destination=BRC/);
    assert.match(markdown, /Datos ficticios declarados/);
    for (const phrase of ['Gestiona búsquedas y reservas simuladas.', 'La página conserva los filtros enviados.', 'Los aeropuertos deben ser distintos.']) assert.ok(markdown.includes(phrase));
    assert.equal(markdown.match(/Origen y destino deben ser distintos\./g)?.length, 1, 'shared published rules appear once');
    assert.doesNotMatch(markdown, /ANTERIOR_NO_USAR|RETIRED_RETURN_PROMPT|private-query|private-fragment|DRAFT|aproba|PRIVACY_REVIEW|not_run|Criterios de aceptación pendientes/);
  }
});

test('formatter is read-only, deterministic and leaves absent optional sections absent', () => {
  const input = fixture();
  delete input.context.knowledge;
  input.context.rules = [];
  input.domain = null;
  input.review.case.original.steps = [];
  input.review.case.original.expected = '';
  input.review.case.original.additionalContext = '';
  const before = structuredClone(input);
  const markdown = caseMarkdown(input);
  assert.equal(markdown, caseMarkdown(input));
  assert.deepEqual(input, before);
  assert.doesNotMatch(markdown, /## (Pasos|Comportamiento esperado|Contexto adicional|Marcas|Recorrido|Documentos|Proyecto|Referencias de captura)|No declarado|Falta|Esperando|ZIP/);
  assert.ok(markdown.length < 500);
});

test('marks retain public note, locator, route and capture references without pretending clipboard contains images', () => {
  const input = fixture();
  const mark = { id: 'mark-1', caseId: 'case-1', kind: 'section', pathname: '/pasajero/buscar-vuelos', createdAt: at, updatedAt: at, label: 'Buscador', note: 'Revisar la validación.', bounds: { x: 10, y: 20, width: 600, height: 200 }, viewport: { width: 1360, height: 1000 }, element: { tag: 'section', role: 'region', accessibleName: 'Buscador de vuelos', selector: '[data-ai-id="flight-search"]', text: 'Texto público', bounds: { x: 10, y: 20, width: 600, height: 200 } }, relatedElements: [] };
  input.context.annotations = [mark, { ...mark, id: 'pending', pending: true, note: 'PENDING_MARK_NOT_TO_COPY' }, { ...mark, id: 'other-case', caseId: 'case-2', note: 'OTHER_CASE_NOT_TO_COPY' }];
  input.review.steps = [step('capture-step', 'Región de la marca', undefined, { targetId: 'mark-1', artifactIds: ['capture-1'] })];
  input.review.artifacts = [artifact('capture-1', 'available', { stepId: 'capture-step', byteLength: 123, sha256: 'a'.repeat(64), base64: 'BINARY_NOT_TO_COPY', retrieval: { method: 'download', reference: 'blob:http://localhost:3002/private-blob' } }), artifact('capture-excluded', 'excluded', { notes: 'EXCLUDED_NOT_TO_COPY' }), artifact('capture-failed', 'failed', { failureReason: 'El permiso de la pestaña se cerró.' })];
  const markdown = caseMarkdown(input);
  assert.match(markdown, /Buscador/);
  assert.match(markdown, /Revisar la validación/);
  assert.match(markdown, /flight-search/);
  assert.ok(markdown.includes('`[data-ai-id="flight-search"]`'), 'the published CSS locator stays directly usable');
  assert.match(markdown, /Captura: `capture-1`/);
  assert.match(markdown, /El permiso de la pestaña se cerró/);
  assert.equal(markdown.match(/Las imágenes se incluyen al descargar las evidencias/g)?.length, 1);
  assert.doesNotMatch(markdown, /handoff|chunks|SHA-256|Build:/);
  assert.match(markdown, /^## Feedback de página: \/pasajero\/buscar-vuelos/);
  assert.match(markdown, /\*\*Viewport:\*\* 1360×1000/);
  assert.match(markdown, /### 1\. Buscador/);
  assert.match(markdown, /\*\*Comentario:\*\* Revisar la validación/);
  assert.doesNotMatch(markdown, /PENDING_MARK|OTHER_CASE|EXCLUDED_NOT|capture-excluded|BINARY_NOT|blob:|!\[|screenshots\//);
});

test('recorded navigation, action-to-fetch association and separate unmatched requests remain honest and abstract', () => {
  const input = fixture();
  input.review.steps = [step('start', 'Inicio de la grabación'), step('choose', 'Cambió Destino'), step('search', 'Buscar vuelos'), step('route', 'Navegó a resultados', '/pasajero/resultados'), step('end', 'Fin de la grabación', '/pasajero/resultados')];
  input.review.events = [
    { id: 'click', sessionId: 'case-1', kind: 'interaction', at, actor: 'unknown', attribution: 'unknown', simulated: false, stepId: 'search', label: 'Buscar vuelos' },
    { id: 'fetch', sessionId: 'case-1', kind: 'fetch', at, actor: 'unknown', attribution: 'unknown', simulated: false, stepId: 'search', resource: 'Vuelos', method: 'GET', status: 200, outcome: 'success', correlation: 'temporal', url: 'https://private.test/api?token=REQUEST_SECRET', headers: { authorization: 'HEADER_SECRET' }, body: 'BODY_SECRET' },
    { id: 'unmatched', sessionId: 'case-1', kind: 'fetch', at, actor: 'unknown', attribution: 'unknown', simulated: true, resource: 'https://private.test/api?token=URL_AS_ALIAS', method: 'POST', status: 500, outcome: 'http_error' },
  ];
  const markdown = caseMarkdown(input);
  assert.match(markdown, /Inicio de la grabación/);
  assert.match(markdown, /Fin de la grabación/);
  assert.match(markdown, /Navegó a resultados · `\/pasajero\/resultados`/);
  assert.match(markdown, /GET Vuelos → HTTP 200/);
  assert.match(markdown, /POST Recurso no identificado → HTTP 500 · SIMULADO/);
  assert.match(markdown, /asociación.*temporal; no demuestra causalidad ni confirma un defecto/);
  assert.equal(markdown.match(/Buscar vuelos/g)?.length, 2, 'one authored step and one observed action; interaction event is not duplicated');
  assert.doesNotMatch(markdown, /private\.test|REQUEST_SECRET|HEADER_SECRET|BODY_SECRET|URL_AS_ALIAS|authorization|reproducido|causa raíz/);
});

test('a full navigation closes its recording before marks added after restoring the case', () => {
  const input = fixture();
  input.review.steps = [step('start', 'Inicio de la grabación'), step('click', 'Buscar vuelos'),
    step('leave', 'Fin de la grabación al salir de la página'),
    step('later', 'MARCA_POSTERIOR_A_RESTAURAR')];
  const markdown = caseMarkdown(input);
  assert.match(markdown, /1\. Inicio de la grabación/);
  assert.match(markdown, /2\. Buscar vuelos/);
  assert.match(markdown, /3\. Fin de la grabación al salir de la página/);
  assert.doesNotMatch(markdown, /MARCA_POSTERIOR_A_RESTAURAR/);
});

test('long documentation stays complete with redactions, deduplication and inert HTML/image content', () => {
  const input = fixture();
  const content = `${'Regla pública.\n'.repeat(1_100)}FIN_DOC_LARGO\npassword=late-secret\nContact: person@example.test\n<script>run()</script>\n![Asset](data:image/png;base64,QUJDREVGRw==)\nC:\\Users\\private\\notes.md`;
  input.context.knowledge.documents = [
    { id: 'full', label: 'Documento completo', content, checksum: 'a'.repeat(64) },
    { id: 'same', label: 'Misma referencia', content, checksum: 'b'.repeat(64) },
  ];
  const markdown = caseMarkdown(input, { includeProjectContext: true });
  assert.ok(markdown.length > 12_000);
  assert.equal(markdown.match(/FIN_DOC_LARGO/g)?.length, 1);
  assert.match(markdown, /`full`, `same`/);
  assert.doesNotMatch(markdown, /late-secret|person@example|<script>|data:image|QUJDREVGRw|C:\\Users\\private/);
  assert.match(markdown, /&lt;script&gt;/);
});

test('without a case the formatter uses current page context and does not infer an intention or test', () => {
  const input = fixture();
  delete input.review.case;
  input.review.session = null;
  const markdown = caseMarkdown(input, { includeProjectContext: true });
  assert.match(markdown, /\*\*Caso:\*\* Buscar vuelos/);
  assert.doesNotMatch(markdown, /Título de sesión anterior|Quiero comprobar|## Pasos indicados|Probar:|Reportar:|aprobación/);
  assert.match(markdown, /## Documentos del proyecto/);
});

test('simple is the default and opaque UUID references survive prose redaction', () => {
  const input = fixture();
  const id = 'a58b8c80-6aa5-4f94-82b6-6cf8e83ab903';
  input.review.artifacts.push(artifact(id));
  let markdown = caseMarkdown(input);
  assert.match(markdown, new RegExp(id));
  assert.doesNotMatch(markdown, /\[identificador oculto\]|## Proyecto|## Documentos|Buscar y reservar vuelos de prueba|Origen y destino deben ser distintos|Gestiona búsquedas y reservas simuladas/);
  assert.match(markdown, /\*\*Caso:\*\* Validar la ruta elegida/);
  markdown = caseMarkdown(input, { evidencePaths: { [id]: `evidence/${id}.png` } });
  assert.ok(markdown.includes(`![Captura 1](evidence/${id}.png)`));
  for (const path of ['../image.png', 'https://private.test/image.png', 'blob:secret', 'evidence/a%2Fprivate.png'])
    assert.throws(() => caseMarkdown(input, { evidencePaths: { [id]: path } }), /ZIP_PATH_INVALID/);
});

const image = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1kAAAAASUVORK5CYII=', 'base64'));
const hash = value => createHash('sha256').update(value).digest('hex');
function zipEntries(bytes) {
  const buffer = Buffer.from(bytes), eocd = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(0), 0x04034b50);
  assert.equal(buffer.readUInt32LE(eocd), 0x06054b50);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < buffer.readUInt16LE(eocd + 10); i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    assert.equal(buffer.readUInt16LE(offset + 10), 0);
    const length = buffer.readUInt16LE(offset + 28), extra = buffer.readUInt16LE(offset + 30), comment = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42), size = buffer.readUInt32LE(offset + 24);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + length);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const value = new Uint8Array(buffer.subarray(start, start + size));
    assert.equal(crc32(value), buffer.readUInt32LE(offset + 16));
    entries.set(name, value);
    offset += 46 + length + extra + comment;
  }
  return entries;
}

test('evidence ZIP keeps real image bytes, relative Markdown links and opt-in project files in both modes', async () => {
  const input = fixture();
  const id = 'a58b8c80-6aa5-4f94-82b6-6cf8e83ab903';
  input.review.artifacts = [artifact(id, 'available', { byteLength: image.length, sha256: hash(image) }),
    artifact('excluded', 'excluded'), artifact('failed', 'failed'), artifact('not-supplied')];
  input.design.declared = { source: 'Public theme', provenance: 'declared', tokens: [{ name: 'accent', value: '#6965db' }], components: [], assets: [] };
  const files = [id, 'excluded', 'failed', 'unknown'].map(id => ({ id, mimeType: 'image/png', bytes: image, filename: '../../ignored-filename.png' }));
  const before = structuredClone(input);
  for (const includeProjectContext of [false, true]) {
    const bundle = await exportCaseEvidence(input, files, { includeProjectContext });
    assert.equal(bundle.filename, 'ai-context-caso.zip');
    const entries = zipEntries(bundle.bytes);
    assert.equal(Buffer.from(entries.get('caso.md')).toString(), bundle.markdown);
    assert.deepEqual(entries.get(`evidence/${id}.png`), image);
    assert.equal(hash(entries.get(`evidence/${id}.png`)), input.review.artifacts[0].sha256);
    assert.ok(bundle.markdown.includes(`![Captura 1](evidence/${id}.png)`));
    assert.doesNotMatch(bundle.markdown, /!\[[^\]]*\]\([^)]*(?:not-supplied|excluded|failed)/);
    assert.equal([...entries.keys()].filter(path => path.startsWith('evidence/')).length, 1);
    if (includeProjectContext) {
      for (const path of ['project/domain.json', 'project/rules.md', 'project/documents/domain.md', 'project/documents/screens.md', 'project/documents/rules.md', 'project/design.json']) assert.ok(entries.has(path), path);
      assert.match(Buffer.from(entries.get('project/documents/domain.md')).toString(), /Gestiona búsquedas y reservas simuladas/);
    } else {
      assert.deepEqual([...entries.keys()], ['caso.md', `evidence/${id}.png`]);
      assert.doesNotMatch(bundle.markdown, /## Proyecto|## Documentos|Public theme/);
    }
  }
  assert.deepEqual(input, before);
});

test('evidence ZIP rejects altered hashes, invalid signatures, duplicate IDs and unsafe artifact paths', async () => {
  const input = fixture();
  input.review.artifacts = [artifact('capture', 'available', { byteLength: image.length, sha256: hash(image) })];
  const file = { id: 'capture', mimeType: 'image/png', bytes: image };
  const changed = new Uint8Array(image); changed[changed.length - 1] ^= 1;
  await assert.rejects(exportCaseEvidence(input, [{ ...file, bytes: changed }]), /REVISION_CONFLICT/);
  await assert.rejects(exportCaseEvidence(input, [{ ...file, bytes: new TextEncoder().encode('not an image') }]), /INVALID_INPUT/);
  await assert.rejects(exportCaseEvidence(input, [file, file]), /ZIP_PATH_DUPLICATE/);
  await assert.rejects(exportCaseEvidence(input, [{ ...file, mimeType: 'image/jpeg' }]), /INVALID_INPUT/);
  input.review.artifacts[0].id = '../private';
  await assert.rejects(exportCaseEvidence(input, [{ ...file, id: '../private' }]), /ZIP_PATH_INVALID/);
});
