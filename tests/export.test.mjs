import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportReviewBundle, ticketToHtml } from '../dist/review/export.js';
import { crc32, createStoreZip } from '../dist/review/zip.js';
import { createReviewEngine } from '../dist/review/session.js';

const image = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1kAAAAASUVORK5CYII=', 'base64'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const now = '2026-10-14T12:00:00.000Z';
function fixture() {
  const snapshot = {
    schemaVersion: '2.0', revision: 7,
    session: { id: 'session-1', objective: 'Revisar la consulta de animales', scope: { origin: 'http://localhost:3100', pathname: '/animals' }, actor: 'agent', attribution: 'declared', status: 'ended', recording: 'stopped', startedAt: now, lastActivityAt: now, endedAt: now, revision: 7 },
    steps: [{ id: 'step-1', sessionId: 'session-1', label: 'Consultar animales', at: now, pathname: '/animals', actor: 'unknown', attribution: 'unknown', simulated: false, artifactIds: ['image-1'], notes: 'Se conserva el estado de error.' }],
    events: [{ id: 'event-1', sessionId: 'session-1', at: now, kind: 'fetch', actor: 'unknown', attribution: 'unknown', simulated: false, resource: 'Animales', method: 'GET', status: 500, outcome: 'http_error', durationMs: 120, stepId: 'step-1', correlation: 'temporal' }],
    findings: [{ id: 'finding-1', sessionId: 'session-1', title: 'Error de consulta', type: 'bug', expected: { text: 'La consulta devuelve animales.', provenance: 'declared', sourceId: 'doc-1' }, observed: 'El estado visible informa un error.', stepIds: ['step-1'], artifactIds: ['image-1'], simulated: false, reproducibility: 'reproduced', missingInformation: [] }],
    artifacts: [{ id: 'image-1', sessionId: 'session-1', stepId: 'step-1', capturedAt: now, pathname: '/animals', mimeType: 'image/png', status: 'available', byteLength: image.length, sha256: sha256(image), capture: { kind: 'viewport', provider: 'fixture-real-png', viewport: { width: 1, height: 1, dpr: 1 } }, redactionStatus: 'applied', simulated: false, notes: '' }],
    privacy: { reviewedRevision: 7 }, partial: { isPartial: false, reasons: [], droppedEvents: 0 }, limits: { maxEvents: 200, maxImages: 20, maxBytes: 50 * 1024 * 1024 }, bytesStored: image.length,
  };
  const context = {
    legacyContext: { schemaVersion: '1.0', capturedAt: now, page: { url: 'http://localhost:3100/animals?token=private', pathname: '/animals', title: 'Animales', viewport: { width: 1024, height: 768 } }, build: { environment: 'preview', branch: 'sprint-2', buildId: 'build-123' }, target: null, rules: ['El error debe ser comprensible.'], privacy: { redactions: [] }, knowledge: { schemaVersion: '1.0', documents: [{ id: 'doc-1', label: 'Reglas de consulta', content: 'La consulta devuelve animales.', checksum: sha256('La consulta devuelve animales.') }] } },
    domain: { name: 'Herdspace', purpose: 'Gestionar animales', users: ['Productor'], fictional: true, source: 'published-demo', provenance: 'declared' },
    design: { declared: { source: 'published-theme', tokens: [{ name: 'surface', value: '#fff', category: 'color' }], components: [{ name: 'AnimalTable', description: 'Tabla de animales', states: ['error'] }], assets: [{ id: 'logo', description: 'Logotipo', url: 'https://example.test/logo.svg', availability: 'referenceOnly' }] }, observed: { source: 'getComputedStyle', provenance: 'observed', capturedAt: now, pathname: '/animals', tag: 'table', styles: { color: 'rgb(0, 0, 0)' }, states: ['observed'], bounds: { x: 0, y: 0, width: 100, height: 100 } } },
  };
  return { snapshot, context, frozen: { snapshot, readArtifact: id => id === 'image-1' ? image.slice() : null }, options: { profile: 'bug', context, preconditions: ['Abrir la demo con datos ficticios.'], impact: 'No se puede consultar la lista.', acceptanceCriteria: ['La consulta muestra un resultado comprensible.'], createdAt: now } };
}

// An independent ZIP reader verifies central-directory metadata and local payload placement.
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const result = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    assert.equal(view.getUint16(offset + 10, true), 0);
    assert.equal(view.getUint16(offset + 8, true) & 0x800, 0x800);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const path = Buffer.from(bytes.subarray(offset + 46, offset + 46 + nameLength)).toString('utf8');
    assert.equal(view.getUint32(local, true), 0x04034b50);
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const payload = bytes.slice(dataStart, dataStart + size);
    assert.equal(view.getUint32(local + 14, true), view.getUint32(offset + 16, true));
    assert.equal(result.has(path), false);
    result.set(path, payload);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

test('STORE ZIP uses known CRC32 vector, safe paths, and round-trips UTF8 filenames', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const bytes = createStoreZip([{ path: 'diseño/referencia.txt', bytes: image }], now);
  assert.deepEqual(readZip(bytes).get('diseño/referencia.txt'), image);
  for (const path of ['/abs', '../private', 'safe/../private', 'C:\\secret', 'a//b']) {
    assert.throws(() => createStoreZip([{ path, bytes: image }], now), /ZIP_PATH_INVALID/);
  }
  assert.throws(() => createStoreZip([{ path: 'same', bytes: image }, { path: 'same', bytes: image }], now), /ZIP_PATH_DUPLICATE/);
});

test('bug bundle contains actual PNG bytes, consistent hashes and references from one revision', async () => {
  const { frozen, options } = fixture();
  const bundle = await exportReviewBundle(frozen, options);
  assert.equal(bundle.status, 'ready');
  assert.equal(bundle.manifest.revision, 7);
  assert.deepEqual(bundle.missingInformation, []);
  const entries = readZip(bundle.bytes);
  assert.equal(entries.size, bundle.files.length);
  assert.deepEqual(entries.get('screenshots/evidence-001.png'), image);
  for (const file of bundle.files) {
    assert.deepEqual(entries.get(file.path), file.bytes);
    assert.equal(file.sha256, sha256(file.bytes));
  }
  for (const file of bundle.manifest.files) {
    assert.equal(file.byteLength, entries.get(file.path).length);
    assert.equal(file.sha256, sha256(entries.get(file.path)));
  }
  assert.equal(bundle.manifest.files.some(file => file.path === 'manifest.json'), false, 'manifest cannot hash itself');
  assert.match(bundle.manifest.integrity.note, /autorreferencia/);
  for (const ref of bundle.manifest.references) if (ref.status === 'included') assert.ok(entries.has(ref.path));
  assert.ok(entries.has('design/tokens.json'));
  assert.ok(entries.has('design/components.md'));
  assert.ok(entries.has('documents/document-001.md'));
  assert.equal(bundle.manifest.references.find(ref => ref.id === 'logo').status, 'remote');
  assert.equal(entries.has('design/assets/logo.svg'), false);
  assert.equal(bundle.manifest.omitted.some(item => item.path === 'feature-brief.md'), true);
  assert.equal(Buffer.from(entries.get('context.json')).toString().includes('token=private'), false);
  assert.match(bundle.ticketMarkdown, /no demuestra[n]? causalidad/);
  assert.match(bundle.ticketMarkdown, /no se publicó un ticket externo/i);
});

test('feature bundle preserves declared tokens and observed styles as distinct sources', async () => {
  const { frozen, options } = fixture();
  const bundle = await exportReviewBundle(frozen, { ...options, profile: 'feature', proposedFlow: 'Reintentar la consulta y conservar los filtros.' });
  const entries = readZip(bundle.bytes);
  assert.equal(bundle.status, 'ready');
  assert.ok(entries.has('feature-brief.md'));
  assert.equal(entries.has('ticket.md'), false);
  assert.equal(entries.has('ticket.html'), false);
  assert.match(bundle.featureBriefMarkdown, /Gestionar animales/);
  assert.match(bundle.featureBriefMarkdown, /getComputedStyle/);
  assert.match(bundle.featureBriefMarkdown, /declared/);
  assert.match(bundle.featureBriefMarkdown, /observed/);
  assert.match(bundle.featureBriefMarkdown, /evidence-001\.png/);
  assert.equal(bundle.manifest.omitted.some(item => item.path === 'design/assets/'), true);
});

test('privacy review mismatch and image bytes changed since freeze reject export', async () => {
  const { frozen, options } = fixture();
  frozen.snapshot.privacy.reviewedRevision = 6;
  await assert.rejects(exportReviewBundle(frozen, options), /PRIVACY_REVIEW_REQUIRED/);
  frozen.snapshot.privacy.reviewedRevision = 7;
  frozen.snapshot.session.revision = 6;
  await assert.rejects(exportReviewBundle(frozen, options), /REVISION_CONFLICT/);
  frozen.snapshot.session.revision = 7;
  frozen.readArtifact = () => new Uint8Array([...image, 0]);
  await assert.rejects(exportReviewBundle(frozen, options), /REVISION_CONFLICT/);
  frozen.readArtifact = () => new TextEncoder().encode('a filename is not an image');
  await assert.rejects(exportReviewBundle(frozen, options), /INVALID_INPUT/);
});

test('missing expected result, inferred expectation, absent steps, and unavailable evidence stay draft', async () => {
  const { frozen, options } = fixture();
  delete frozen.snapshot.findings[0].expected;
  const bundle = await exportReviewBundle(frozen, { ...options, preconditions: [] });
  assert.equal(bundle.status, 'draft');
  assert.ok(bundle.missingInformation.some(value => /precondiciones/.test(value)));
  assert.ok(bundle.missingInformation.some(value => /resultado esperado/.test(value)));
  assert.match(bundle.ticketMarkdown, /Resultado esperado: No declarado/);
  const second = fixture();
  second.frozen.snapshot.findings[0].expected.provenance = 'inferred';
  second.frozen.snapshot.steps = [];
  second.frozen.readArtifact = () => null;
  const draft = await exportReviewBundle(second.frozen, second.options);
  assert.equal(draft.status, 'draft');
  assert.ok(draft.missingInformation.some(value => /pasos/.test(value)));
  assert.ok(draft.missingInformation.some(value => /Falta evidencia/.test(value)));
  assert.equal(draft.manifest.references.find(ref => ref.id === 'step-1').status, 'missing');
  assert.equal(draft.manifest.references.find(ref => ref.id === 'image-1').status, 'missing');
});

test('exclusion affects export only, and partial evidence retains explicit missing references', async () => {
  const { frozen, options, snapshot } = fixture();
  snapshot.artifacts[0].status = 'excluded';
  snapshot.artifacts[0].notes = 'This excluded note must not leave the page';
  snapshot.findings[0].artifactIds.push('absent-image');
  snapshot.partial = { isPartial: true, reasons: ['Límite de capturas alcanzado.'], droppedEvents: 2 };
  const original = structuredClone(snapshot);
  const bundle = await exportReviewBundle(frozen, options);
  assert.equal(bundle.status, 'draft');
  assert.deepEqual(snapshot, original, 'export must not mutate the review record');
  assert.equal(bundle.files.some(file => file.path.startsWith('screenshots/')), false);
  assert.equal(bundle.manifest.references.find(ref => ref.id === 'image-1').status, 'excluded');
  assert.equal(bundle.manifest.references.find(ref => ref.id === 'absent-image').status, 'missing');
  for (const file of bundle.files.filter(file => !file.mimeType.startsWith('image/'))) {
    assert.equal(Buffer.from(file.bytes).toString().includes('This excluded note'), false, file.path);
  }
  assert.match(bundle.ticketMarkdown, /Evidencia parcial/);
  assert.match(bundle.ticketMarkdown, /Se descartaron 2 eventos/);
});

test('simulated HTTP 500 remains explicit in both profiles and never auto-confirms a bug', async () => {
  const { frozen, options } = fixture();
  frozen.snapshot.events[0].simulated = true;
  frozen.snapshot.steps[0].simulated = true;
  frozen.snapshot.findings = [];
  const bundle = await exportReviewBundle(frozen, options);
  assert.equal(bundle.status, 'draft');
  assert.equal(bundle.manifest.simulated, true);
  assert.match(bundle.ticketMarkdown, /SIMULACIÓN/);
  assert.match(bundle.ticketMarkdown, /no infiere un defecto de un estado HTTP/);
  assert.match(bundle.featureBriefMarkdown, /SIMULADAS/);
  const context = JSON.parse(Buffer.from(bundle.files.find(file => file.path === 'context.json').bytes).toString());
  assert.equal(context.review.events[0].simulated, true);
  assert.match(Buffer.from(bundle.files.find(file => file.path === 'README.md').bytes).toString(), /SIMULACIÓN/);
});

test('tickets and feature briefs include safe fetch history recorded by the real review engine', async () => {
  const engine = createReviewEngine({ now: () => new Date(now) });
  assert.equal(engine.startSession({ requestId: 'fetch-session', objective: 'Revisar animales', scope: { origin: 'http://localhost:3100', pathname: '/animals' } }).status, 'ok');
  assert.equal(engine.startRecording({ requestId: 'fetch-recording', authorized: true }).status, 'ok');
  const step = engine.checkpoint({ requestId: 'fetch-step', label: 'Consultar animales', pathname: '/animals' });
  assert.equal(step.status, 'ok');
  for (const [index, status] of [200, 500].entries()) {
    assert.equal(engine.recordEvent({ requestId: `fetch-event-${index}`, kind: 'fetch', resource: 'Animales', method: 'GET',
      status, outcome: status === 200 ? 'success' : 'http_error', durationMs: index ? 125 : 32,
      stepId: step.data.id, correlation: 'temporal', simulated: status === 500,
      url: 'https://private.example.test/animals?token=url-secret', headers: { authorization: 'Bearer header-secret' },
      requestBody: 'request-body-secret', responseBody: 'response-body-secret',
    }).status, 'ok');
  }
  engine.stopRecording({ requestId: 'fetch-stop' });
  engine.reviewPrivacy({ requestId: 'fetch-review', expectedRevision: engine.getSnapshot().revision, confirmed: true });
  const frozen = engine.freezeForExport({ expectedRevision: engine.getSnapshot().revision });
  assert.equal(frozen.status, 'ok');
  const { options } = fixture();
  for (const profile of ['bug', 'feature']) {
    const bundle = await exportReviewBundle(frozen.data, { ...options, profile, proposedFlow: 'Reintentar la consulta.' });
    const document = profile === 'bug' ? bundle.ticketMarkdown : bundle.featureBriefMarkdown;
    assert.match(document, /## Consultas observadas/);
    assert.match(document, /GET Animales → HTTP 200/);
    assert.match(document, /GET Animales → HTTP 500/);
    assert.match(document, /duración: 32 ms/);
    assert.match(document, /duración: 125 ms/);
    assert.match(document, /resultado: success/);
    assert.ok(document.includes('resultado: http\\_error'));
    assert.ok(document.includes(`paso: ${step.data.id}`));
    assert.match(document, /correlación temporal \(no demuestra causalidad\)/);
    assert.match(document, /HTTP 500[^\n]*SIMULACIÓN/);
    assert.doesNotMatch(document, /HTTP 200[^\n]*SIMULACIÓN/);
    for (const file of bundle.files.filter(file => !file.mimeType.startsWith('image/'))) {
      const content = Buffer.from(file.bytes).toString();
      assert.doesNotMatch(content, /private\.example\.test|url-secret|header-secret|request-body-secret|response-body-secret/, file.path);
    }
    const file = bundle.files.find(item => item.path === (profile === 'bug' ? 'ticket.md' : 'feature-brief.md'));
    assert.equal(Buffer.from(file.bytes).toString(), document);
  }
});

test('HTML output escapes injected tags and all untrusted attributes; local paths and credentials are absent', async () => {
  const { frozen, options } = fixture();
  frozen.snapshot.findings[0].title = '<script>alert(1)</script><img src=x onerror="run()">';
  frozen.snapshot.findings[0].observed = 'Error at C:\\Users\\private\\source.ts and /Users/private/file.js password=hunter2';
  options.context.domain.source = 'C:/Users/private/config.ts';
  options.context.domain.note = 'Bearer private-token';
  const bundle = await exportReviewBundle(frozen, options);
  assert.equal(bundle.ticketHtml.includes('<script>'), false);
  assert.equal(bundle.ticketHtml.includes('<img'), false);
  assert.ok(bundle.ticketHtml.includes('&lt;'));
  assert.equal(ticketToHtml('<div onload="x">\'&</div>').includes('<div'), false);
  for (const file of bundle.files.filter(file => !file.mimeType.startsWith('image/'))) {
    const content = Buffer.from(file.bytes).toString();
    for (const secret of ['C:\\Users\\private', 'C:/Users/private', '/Users/private', 'hunter2', 'private-token']) assert.equal(content.includes(secret), false, `${file.path}: ${secret}`);
  }
});

test('size target reports actual ZIP size and retains every selected image', async () => {
  const { frozen, options } = fixture();
  const bundle = await exportReviewBundle(frozen, { ...options, targetSizeBytes: 50 });
  assert.equal(bundle.exceedsTarget, true);
  assert.equal(bundle.totalBytes, bundle.bytes.byteLength);
  assert.equal(bundle.targetSizeBytes, 50);
  assert.ok(bundle.files.some(file => file.mimeType === 'image/png'));
  assert.match(bundle.ticketMarkdown, /No se publicó un ticket externo/);
});

test('published documents retain content beyond UI text limits while applying export redactions', async () => {
  const { frozen, options } = fixture();
  const content = `${'Regla pública de diseño.\n'.repeat(900)}\nMARCA_FINAL_DOC\npassword=secret-at-end`;
  options.context.legacyContext.knowledge.documents[0].content = content;
  options.context.legacyContext.knowledge.documents[0].checksum = sha256(content);
  const bundle = await exportReviewBundle(frozen, options);
  const document = bundle.files.find(file => file.path === 'documents/document-001.md');
  const output = Buffer.from(document.bytes).toString();
  assert.ok(output.length > 12_000);
  assert.match(output, /MARCA_FINAL_DOC/);
  assert.equal(output.includes('secret-at-end'), false);
  const context = bundle.files.find(file => file.path === 'context.json');
  assert.match(Buffer.from(context.bytes).toString(), /MARCA_FINAL_DOC/);
  const parsed = JSON.parse(Buffer.from(context.bytes).toString());
  assert.equal(parsed.legacyContext.knowledge.documents[0].checksum, sha256(parsed.legacyContext.knowledge.documents[0].content));
  assert.equal(parsed.documentSources[0].sourceChecksum, sha256(content));
  assert.equal(parsed.documentSources[0].redacted, true);
});

test('ZIP opens and CRC-checks with standard Python zipfile when Python is available', async t => {
  let command;
  for (const candidate of [process.env.AI_CONTEXT_TEST_PYTHON, 'python', 'python3'].filter(Boolean)) {
    try { execFileSync(candidate, ['-c', 'import zipfile'], { stdio: 'pipe', timeout: 10_000 }); command = candidate; break; } catch { /* Try the other standard executable. */ }
  }
  if (!command) return t.skip('Python is unavailable; independent ZIP structural checks still run.');
  const { frozen, options } = fixture();
  const bundle = await exportReviewBundle(frozen, options);
  const temporary = mkdtempSync(join(tmpdir(), 'ai-context-zip-'));
  try {
    const zipPath = join(temporary, 'session.zip');
    writeFileSync(zipPath, bundle.bytes);
    const result = execFileSync(command, ['-c', 'import zipfile,sys,json,hashlib; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; m=json.loads(z.read("manifest.json")); assert all(len(z.read(f["path"]))==f["byteLength"] and hashlib.sha256(z.read(f["path"])).hexdigest()==f["sha256"] for f in m["files"]); print("ZIP_CRC_HASHES_OK",len(z.namelist()))', zipPath], { encoding: 'utf8', timeout: 10_000 });
    assert.match(result, /ZIP_CRC_HASHES_OK/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
