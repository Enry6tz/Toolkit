import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createAgentDomRequestHandler } from '../dist/browser/agent-transport.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { createStoreZip } from '../dist/review/zip.js';

function fixture(options = {}) {
  let revision = 7, mutations = 0, reads = 0, enabled = false;
  const handler = createAgentDomRequestHandler({
    nonce: 'visit-nonce',
    getContext: async () => { reads += 1; return { schemaVersion: '2.0', revision, context: { page: { pathname: '/animals' } } }; },
    operations: { checkpoint: async input => { mutations += 1; revision += 1; return { status: 'ok', revision, data: input }; } },
    readFile: () => null,
    mutationsEnabled: () => enabled,
    ...options,
  });
  return {
    ...handler,
    request(operation, input = {}, extra = {}) {
      return { version: '1.0', nonce: 'visit-nonce', requestId: `${operation}-1`, operation, input, ...extra };
    },
    enable() { enabled = true; },
    counts() { return { revision, mutations, reads }; },
  };
}

test('DOM transport reads context without enabling mutation or starting collection, and rejects unrelated commands', async () => {
  const f = fixture();
  const context = await f.run(JSON.stringify(f.request('getContext')));
  assert.equal(context.status, 'ok');
  assert.equal(context.data.context.page.pathname, '/animals');
  assert.deepEqual(f.counts(), { revision: 7, mutations: 0, reads: 1 });
  assert.equal((await f.run(f.request('checkpoint', {}, { expectedRevision: 7 }))).error.code, 'COMMANDS_DISABLED');
  assert.equal((await f.run(f.request('evaluate', { javascript: 'untrusted()' }))).error.code, 'INVALID_INPUT');
  assert.equal((await f.run(f.request('getContext', {}, { nonce: 'old-visit' }))).error.code, 'STALE_TRANSPORT');
  assert.equal((await f.run('{broken')).error.code, 'INVALID_INPUT');
  assert.equal((await f.run(f.request('getContext', {}, { javascript: 'untrusted()' }))).error.code, 'INVALID_INPUT');
  assert.deepEqual(f.counts(), { revision: 7, mutations: 0, reads: 1 });
  f.dispose();
});

test('explicit DOM commands require the exact revision and preserve concurrent retry idempotence', async () => {
  const f = fixture(); f.enable();
  assert.equal((await f.run(f.request('checkpoint', {}, { expectedRevision: 6 }))).error.code, 'REVISION_CONFLICT');
  assert.equal(f.counts().mutations, 0);
  const request = f.request('checkpoint', { label: 'Observed state' }, { requestId: 'checkpoint-approved', expectedRevision: 7 });
  const [first, concurrent] = await Promise.all([f.run(request), f.run(JSON.stringify(request))]);
  assert.deepEqual(first, concurrent);
  assert.equal(first.status, 'ok');
  assert.equal(first.data.requestId, 'checkpoint-approved');
  assert.equal(first.data.expectedRevision, 7);
  assert.equal(f.counts().mutations, 1);
  assert.deepEqual(await f.run(request), first, 'retry remains stable even though the mutation advanced the revision');
  assert.equal((await f.run({ ...request, input: { label: 'Different operation' } })).error.code, 'REQUEST_ID_REUSED');
  assert.equal(f.counts().mutations, 1);
  f.dispose();
});

test('DOM artifact chunks deliver the actual bytes and can reassemble a complete image or ZIP', async () => {
  const original = Uint8Array.from({ length: 527891 }, (_, i) => (i * 19) % 256);
  const f = fixture({ readFile: id => id === 'evidence-1' ? { bytes: original, mimeType: 'application/zip', filename: '../real.zip' } : null });
  const chunks = [];
  let offset = 0;
  do {
    const response = await f.run(f.request('readArtifactChunk', { artifactId: 'evidence-1', offset }, { requestId: `chunk-${offset}` }));
    assert.equal(response.status, 'ok');
    assert.equal(response.data.offset, offset);
    assert.equal(response.data.totalByteLength, original.length);
    assert.equal(response.data.filename, '..-real.zip');
    const bytes = Buffer.from(response.data.base64, 'base64');
    assert.equal(bytes.length, response.data.byteLength);
    chunks.push(bytes);
    offset = response.data.nextOffset;
  } while (offset !== null);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(original));
  assert.equal(f.counts().mutations, 0);
  assert.equal((await f.run(f.request('readArtifactChunk', { artifactId: 'absent' }, { requestId: 'missing' }))).error.code, 'ARTIFACT_NOT_FOUND');
  assert.equal((await f.run(f.request('readArtifactChunk', { artifactId: 'evidence-1', offset: original.length + 1 }, { requestId: 'out-of-range' }))).error.code, 'INVALID_INPUT');
  f.dispose();
});

test('command envelope cannot replace the mutation request ID or bypass the expected revision', async () => {
  const f = fixture(); f.enable();
  assert.equal((await f.run(f.request('checkpoint', { requestId: 'another-id' }, { expectedRevision: 7 }))).error.code, 'INVALID_INPUT');
  assert.equal((await f.run(f.request('checkpoint', { expectedRevision: 1 }, { expectedRevision: 7, requestId: 'revision-mismatch' }))).error.code, 'INVALID_INPUT');
  assert.equal(f.counts().mutations, 0);
  f.dispose();
});

test('distinct concurrent commands cannot both mutate the same revision', async () => {
  const f = fixture(); f.enable();
  const results = await Promise.all([
    f.run(f.request('checkpoint', { label: 'First' }, { requestId: 'first', expectedRevision: 7 })),
    f.run(f.request('checkpoint', { label: 'Second' }, { requestId: 'second', expectedRevision: 7 })),
  ]);
  assert.equal(results[0].status, 'ok');
  assert.equal(results[1].error.code, 'REVISION_CONFLICT');
  assert.equal(f.counts().mutations, 1);
  f.dispose();
});

test('case return allows only one matching refinement proposal and never approval, capture or export', async () => {
  let revision = 12, permittedCase = null, proposals = 0;
  const handler = createAgentDomRequestHandler({ nonce: 'case-return',
    getContext: async () => ({ revision, review: { case: { id: 'case-1' } } }),
    refinementCaseId: () => permittedCase,
    readFile: () => null,
    operations: { submitRefinement: input => { proposals++; return { status: 'ok', revision: ++revision, data: input.proposal }; },
      approveRefinement: () => assert.fail('the narrow return gate must not approve'),
      checkpoint: () => assert.fail('the narrow return gate must not capture'),
      exportBundle: () => assert.fail('the narrow return gate must not export'),
      startCase: () => assert.fail('the narrow return gate must not start another case'),
    },
  });
  const request = (operation, input = {}, requestId = operation) => ({ version: '1.0', nonce: 'case-return',
    requestId, operation, expectedRevision: revision, input });
  const proposal = { title: 'Rechazar origen y destino iguales', steps: ['Elegir EZE como origen y destino', 'Buscar vuelos'], expected: 'Mostrar la validación y no consultar vuelos.', sourceDocIds: ['sigv-rules'] };
  assert.equal((await handler.run(request('submitRefinement', { caseId: 'case-1', proposal }))).error.code, 'COMMANDS_DISABLED');
  permittedCase = 'case-1';
  for (const operation of ['approveRefinement', 'checkpoint', 'exportBundle', 'startCase', 'startSession', 'startRecording', 'prepareCase', 'updateCase'])
    assert.equal((await handler.run(request(operation, { caseId: 'case-1' }))).error.code, 'COMMANDS_DISABLED', operation);
  assert.equal((await handler.run(request('submitRefinement', { caseId: 'case-2', proposal }, 'other-case'))).error.code, 'COMMANDS_DISABLED');
  const input = request('submitRefinement', { caseId: 'case-1', proposal }, 'proposal-1');
  const [first, retry] = await Promise.all([handler.run(input), handler.run(JSON.stringify(input))]);
  assert.deepEqual(first, retry); assert.equal(first.status, 'ok'); assert.deepEqual(first.data, proposal);
  assert.equal(proposals, 1); assert.equal(revision, 13);
  assert.deepEqual(await handler.run(input), first);
  assert.equal((await handler.run({ ...input, requestId: 'stale-new-request' })).error.code, 'REVISION_CONFLICT');
  permittedCase = null;
  assert.equal((await handler.run(input)).error.code, 'COMMANDS_DISABLED', 'revocation also blocks cached mutation retries');
  assert.equal(proposals, 1); handler.dispose();
});

test('case return rechecks case identity and a revoked gate after asynchronous context reads', async () => {
  let permittedCase = 'case-1', caseId = 'case-2', release, pending = false;
  const handler = createAgentDomRequestHandler({ nonce: 'case-return', refinementCaseId: () => permittedCase,
    getContext: async () => {
      if (pending) await new Promise(resolve => { release = resolve; });
      return { revision: 2, review: { case: { id: caseId } } };
    },
    operations: { submitRefinement: () => assert.fail('a stale or revoked case must not mutate') }, readFile: () => null,
  });
  const request = requestId => ({ version: '1.0', nonce: 'case-return', operation: 'submitRefinement',
    requestId, expectedRevision: 2, input: { caseId: 'case-1', proposal: {} } });
  assert.equal((await handler.run(request('different-current-case'))).error.code, 'STALE_TARGET');
  caseId = 'case-1'; pending = true;
  const inFlight = handler.run(request('revoked-during-read'));
  await new Promise(resolve => setImmediate(resolve));
  permittedCase = null; release();
  assert.equal((await inFlight).error.code, 'COMMANDS_DISABLED');
  handler.dispose();
});

test('disposing the page transport prevents in-flight context from escaping to a stale page', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture({ getContext: () => pending });
  const result = f.run(f.request('getContext'));
  f.dispose();
  finish({ revision: 10 });
  assert.equal((await result).error.code, 'STALE_TRANSPORT');
  assert.equal((await f.run(f.request('getContext', {}, { requestId: 'late' }))).error.code, 'STALE_TRANSPORT');
});

test('DOM external begin keeps its completion form visible while native requests retain their policy', async () => {
  const f = fixture(); f.enable();
  const external = await f.run(f.request('checkpoint', { label: 'Screenshot', capture: { phase: 'begin', hideToolbar: true } }, { expectedRevision: 7 }));
  assert.equal(external.status, 'ok');
  assert.equal(external.data.capture.hideToolbar, false, 'a DOM adapter must be able to submit complete after its screenshot');
  const native = await f.run(f.request('checkpoint', { label: 'Native image', capture: { mode: 'native', hideToolbar: true } }, { requestId: 'native', expectedRevision: 8 }));
  assert.equal(native.status, 'ok');
  assert.equal(native.data.capture.hideToolbar, true);
  f.dispose();
});

let domBrowser, domServer, domBase, domStartup;
after(async () => {
  await domBrowser?.close();
  if (domServer) await new Promise(resolve => domServer.close(resolve));
});
async function domPage() {
  domStartup ??= (async () => {
    domServer = createServer(async (req, res) => {
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><html><head><title>Prepared handoff</title><style>body{margin:0;background:white}button{position:absolute;left:20px;top:20px;width:180px;height:60px;background:rgb(0,128,0);color:white}.agent-handoff-files{display:none}</style></head><body><button>Acción pública observada</button><div id="transport-host"></div></body></html>');
      } else if (req.url === '/agent-transport.js') {
        res.setHeader('content-type', 'text/javascript');
        res.end(await readFile(new URL('../dist/browser/agent-transport.js', import.meta.url)));
      } else res.writeHead(404).end();
    });
    await new Promise(resolve => domServer.listen(0, '127.0.0.1', resolve));
    domBase = `http://127.0.0.1:${domServer.address().port}`;
    domBrowser = await chromium.launch();
  })();
  await domStartup;
  const page = await domBrowser.newPage({ viewport: { width: 640, height: 480 } });
  await page.goto(domBase);
  await page.evaluate(async () => {
    const module = await import('/agent-transport.js');
    window.transportMetrics = { reads: 0, mutations: 0, fileReads: 0, encodes: 0, captures: 0, clipboard: 0, revoked: [] };
    const originalBase64 = window.btoa;
    window.btoa = value => { window.transportMetrics.encodes++; return originalBase64(value); };
    if (navigator.mediaDevices) navigator.mediaDevices.getDisplayMedia = () => { window.transportMetrics.captures++; throw new Error('Reading existing files must not capture.'); };
    if (navigator.clipboard) navigator.clipboard.writeText = async () => { window.transportMetrics.clipboard++; };
    window.transportRoot = document.querySelector('#transport-host').attachShadow({ mode: 'open' });
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = url => { window.transportMetrics.revoked.push(url); originalRevoke(url); };
    window.transport = module.installAgentDomTransport({
      root: window.transportRoot, nonce: 'readonly-visit',
      getContext: async () => { window.transportMetrics.reads++; return { revision: 9 }; },
      operations: { checkpoint: () => { window.transportMetrics.mutations++; return { status: 'ok', revision: 10 }; } },
      readFile: () => { window.transportMetrics.fileReads++; return null; },
    });
  });
  return page;
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function preparedContext(imageSha, overrides = {}) {
  return {
    schemaVersion: '2.0', revision: 9, sessionId: 'existing-session', preparedAt: '2026-10-14T17:00:00.000Z',
    context: { page: { pathname: '/animals' }, build: { environment: 'preview', buildId: 'prepared-files' },
      annotations: [{ id: 'first-mark', note: 'Revisar el alta' }, { id: 'second-mark', note: 'Comparar la tabla' }],
      knowledge: { documents: [{ label: 'Reglas publicadas', content: '</script><script>window.executedUntrustedText=true</script>' }] },
    },
    review: { session: { id: 'existing-session', recording: 'stopped' }, steps: [{ id: 'step-1', label: 'Actualizar animales' }],
      events: [{ kind: 'fetch', resource: 'Animales', status: 200 }, { kind: 'fetch', resource: 'Animales', status: 500, simulated: true }],
      artifacts: [{ id: 'actual-image', status: 'available', sha256: imageSha }, { id: 'excluded-image', status: 'excluded' }, { id: 'failed-image', status: 'failed' }],
    }, ...overrides,
  };
}
async function publish(page, files, context) {
  await page.evaluate(({ files, context }) => {
    window.transport.refresh(context);
    window.transport.publishArtifacts(files.map(file => ({ ...file, bytes: Uint8Array.from(atob(file.base64), value => value.charCodeAt(0)) })));
  }, { context, files: files.map(({ bytes, ...file }) => ({ ...file, base64: Buffer.from(bytes).toString('base64') })) });
}
/** This is deliberately one DOM-only read: no globals, form, callback or fetch. */
async function readPacket(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#transport-host').shadowRoot;
    const packet = JSON.parse(root.querySelector('script[data-ai-context-handoff="1"]').textContent);
    return { packet, chunks: packet.artifacts.map(file => ({ id: file.id,
      chunks: Array.from(root.querySelectorAll(file.chunkSelector)).map(node => ({ offset: Number(node.getAttribute('data-offset')),
        byteLength: Number(node.getAttribute('data-byte-length')), base64: node.textContent, type: node.type })),
    })), commandsEnabled: JSON.parse(root.querySelector('[data-ai-context-agent-port-state]').textContent).commandsEnabled };
  });
}
function reassemble(file, payload) {
  const chunks = payload.chunks.find(item => item.id === file.id).chunks.sort((a, b) => a.offset - b.offset);
  assert.equal(chunks.length, file.chunkCount);
  let offset = 0;
  const bytes = chunks.map(chunk => {
    assert.equal(chunk.offset, offset);
    assert.ok(chunk.base64.length <= 192 * 1024, 'each encoded DOM node fits the declared read budget');
    assert.equal(chunk.type, 'application/octet-stream');
    const part = Buffer.from(chunk.base64, 'base64');
    assert.equal(part.length, chunk.byteLength); offset += part.length;
    return part;
  });
  assert.equal(offset, file.byteLength);
  return Buffer.concat(bytes);
}

test('one read-only DOM packet returns the entire prepared context and actual PNG/ZIP bytes with commands disabled', async () => {
  const page = await domPage();
  try {
    const pending = await readPacket(page);
    assert.equal(pending.packet.transportStatus, 'pending');
    assert.equal(pending.packet.context, null);
    // Real browser pixels, not a filename, synthetic PNG header or DOM reconstruction.
    const png = await page.screenshot({ type: 'png' });
    const zip = createStoreZip([{ path: 'screenshots/actual.png', bytes: png },
      { path: 'steps.txt', bytes: new TextEncoder().encode('Paso observado: Actualizar animales → Animales 500 [simulado].\n'.repeat(8000)) }]);
    const context = preparedContext(sha(png));
    await publish(page, [
      { id: 'actual-image', bytes: png, mimeType: 'image/png', filename: 'actual.png' },
      { id: 'existing-bundle', bytes: zip, mimeType: 'application/zip', filename: 'ticket.zip', sha256: sha(zip) },
      { id: 'excluded-image', bytes: png, mimeType: 'image/png', filename: 'excluded.png' },
      { id: 'failed-image', bytes: png, mimeType: 'image/png', filename: 'failed.png' },
    ], context);
    const payload = await readPacket(page);
    assert.equal(payload.commandsEnabled, false);
    assert.equal(payload.packet.handoffVersion, '1.0');
    assert.equal(payload.packet.transportStatus, 'ready');
    assert.equal(payload.packet.readOnly, true);
    assert.deepEqual(payload.packet.context, context, 'all marks, documents, recorded events and provenance survive the same atomic JSON value');
    assert.deepEqual(payload.packet.artifacts.map(file => file.id), ['actual-image', 'existing-bundle']);
    for (const file of payload.packet.artifacts) {
      const bytes = reassemble(file, payload);
      assert.equal(sha(bytes), file.sha256);
      assert.deepEqual(bytes, file.id === 'actual-image' ? png : Buffer.from(zip));
    }
    assert.ok(payload.packet.artifacts.find(file => file.id === 'existing-bundle').chunkCount > 1);
    assert.deepEqual(reassemble(payload.packet.artifacts[0], payload).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(await page.evaluate(() => window.executedUntrustedText), undefined, 'context JSON remains inert even with active-looking source text');
    const state = await page.evaluate(() => ({ ...window.transportMetrics,
      formHidden: window.transportRoot.querySelector('.agent-connector').hidden,
      formValue: window.transportRoot.querySelector('[data-ai-context-agent-request]').value,
      image: window.transportRoot.querySelector('[data-ai-context-image-id="actual-image"]').getAttribute('src'),
      download: window.transportRoot.querySelector('[data-ai-context-download-id="existing-bundle"]').download,
    }));
    for (const key of ['reads', 'mutations', 'fileReads', 'captures', 'clipboard']) assert.equal(state[key], 0, key);
    assert.equal(state.formHidden, true); assert.equal(state.formValue, '');
    assert.match(state.image, /^blob:/); assert.equal(state.download, 'ticket.zip');
  } finally { await page.close(); }
});

test('context refresh reuses encoded payload nodes, updates the atomic revision and withdraws excluded files', async () => {
  const page = await domPage();
  try {
    const png = await page.screenshot({ type: 'png' });
    const context = preparedContext(sha(png));
    await publish(page, [{ id: 'actual-image', bytes: png, mimeType: 'image/png', filename: 'actual.png' }], context);
    const initial = await page.evaluate(() => {
      window.initialPayloadNode = window.transportRoot.querySelector('[data-ai-context-file-chunk]');
      return { encodes: window.transportMetrics.encodes, href: window.transportRoot.querySelector('[data-ai-context-download-id]').href };
    });
    const next = { ...context, revision: 10, context: { ...context.context, activeAnnotationId: 'second-mark' } };
    await page.evaluate(value => { for (let i = 0; i < 20; i++) window.transport.refresh(value); }, next);
    const refreshed = await readPacket(page);
    assert.deepEqual(refreshed.packet.context, next);
    assert.equal(sha(reassemble(refreshed.packet.artifacts[0], refreshed)), sha(png));
    assert.equal(await page.evaluate(() => window.transportMetrics.encodes), initial.encodes, 'a clock, annotation or context refresh does not recode every image');
    assert.equal(await page.evaluate(() => window.initialPayloadNode === window.transportRoot.querySelector('[data-ai-context-file-chunk]')), true);
    await page.evaluate(value => window.transport.refresh(value), { ...next, revision: 11,
      review: { ...context.review, artifacts: [{ id: 'actual-image', status: 'excluded' }] } });
    const excluded = await readPacket(page);
    assert.equal(excluded.packet.context.revision, 11);
    assert.deepEqual(excluded.packet.artifacts, []);
    assert.equal(await page.locator('[data-ai-context-file-chunk]').count(), 0);
    assert.equal(await page.locator('[data-ai-context-download-id]').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.transportMetrics.revoked), [initial.href]);
    await page.evaluate(() => window.transport.dispose());
    assert.equal(await page.locator('[data-ai-context-handoff]').count(), 0);
    assert.equal(await page.locator('[data-ai-context-agent-port]').count(), 0);
  } finally { await page.close(); }
});

test('invalid publication keeps the last complete packet and disposal revokes its existing binary links', async () => {
  const page = await domPage();
  try {
    const png = await page.screenshot({ type: 'png' });
    await publish(page, [{ id: 'actual-image', bytes: png, mimeType: 'image/png', filename: '../actual.png' }], preparedContext(sha(png)));
    const before = await readPacket(page);
    const failures = await page.evaluate(() => {
      const file = { id: 'safe-file', bytes: new Uint8Array([1]), filename: 'file.png', mimeType: 'image/png' };
      return [[file, file], Array.from({ length: 129 }, (_, index) => ({ ...file, id: `file-${index}` })),
        [{ ...file, bytes: new Uint8Array() }], [{ ...file, id: 'bad"selector' }], [{ ...file, mimeType: 'text/javascript' }],
        [{ ...file, sha256: 'invented hash' }]].map(files => { try { window.transport.publishArtifacts(files); return false; } catch { return true; } });
    });
    assert.deepEqual(failures, [true, true, true, true, true, true]);
    const afterFailure = await readPacket(page);
    assert.deepEqual(afterFailure, before);
    assert.equal(afterFailure.packet.artifacts[0].filename, '..-actual.png');
    await page.evaluate(() => window.transport.dispose());
    assert.equal(await page.locator('[data-ai-context-file-chunk]').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.transportMetrics.revoked), [before.packet.artifacts[0].href]);
  } finally { await page.close(); }
});

test('explicit case preparation reveals a narrow real form and publishes a revision-bound return template', async () => {
  const page = await domPage();
  try {
    await page.evaluate(async () => {
      window.transport.dispose();
      const { installAgentDomTransport } = await import('/agent-transport.js');
      window.caseContext = { revision: 15, review: { case: { id: 'case-sigv' } } };
      window.transport = installAgentDomTransport({ root: window.transportRoot, nonce: 'narrow-return',
        getContext: async () => window.caseContext,
        readFile: () => null,
        operations: {
          submitRefinement: input => {
            window.transportMetrics.mutations++;
            window.transport.setRefinementEnabled(null);
            return { status: 'ok', revision: 16, data: input.proposal };
          },
          approveRefinement: () => { throw new Error('Human approval must stay in the toolbar'); },
          checkpoint: () => { throw new Error('This form cannot capture'); },
        },
      });
      window.transport.refresh(window.caseContext);
    });
    assert.equal(await page.locator('.agent-connector').isVisible(), false);
    await page.evaluate(() => window.transport.setRefinementEnabled({ caseId: 'case-sigv' }));
    const state = await page.evaluate(() => JSON.parse(window.transportRoot.querySelector('[data-ai-context-agent-port-state]').textContent));
    assert.equal(state.commandsEnabled, false); assert.equal(state.caseReturnEnabled, true);
    assert.deepEqual(state.operations, ['getContext', 'readArtifactChunk', 'submitRefinement']);
    assert.equal(state.caseReturn.caseId, 'case-sigv'); assert.equal(state.caseReturn.revision, 15);
    assert.equal(state.caseReturn.requestTemplate.nonce, 'narrow-return');
    const packet = await readPacket(page);
    assert.deepEqual(packet.packet.caseReturn, state.caseReturn);
    assert.equal(await page.getByRole('textbox', { name: 'Propuesta del chat' }).isVisible(), true);
    assert.equal(await page.locator('[data-refinement-only="true"]').count(), 1);
    const envelope = { ...state.caseReturn.requestTemplate, requestId: 'chat-proposal', input: { caseId: 'case-sigv',
      proposal: { title: 'Validar destino', steps: ['Seleccionar el mismo aeropuerto'], expected: 'Rechazar la búsqueda', sourceDocIds: [] } } };
    await page.getByRole('textbox', { name: 'Propuesta del chat' }).fill(JSON.stringify(envelope));
    await page.getByRole('button', { name: 'Recibir propuesta' }).click();
    await page.waitForFunction(() => window.transportRoot.querySelector('[data-ai-context-agent-result]').textContent.length > 0);
    const response = await page.evaluate(() => JSON.parse(window.transportRoot.querySelector('[data-ai-context-agent-result]').textContent));
    assert.equal(response.status, 'ok'); assert.equal(response.data.title, 'Validar destino');
    assert.equal(await page.locator('.agent-connector').isVisible(), false, 'the toolbar may close return permission before the acknowledgement is published');
    assert.equal(await page.evaluate(() => window.transportMetrics.mutations), 1);
    assert.equal(await page.evaluate(() => window.transportMetrics.captures), 0);
    await page.evaluate(() => window.transport.setRefinementEnabled(null));
    assert.equal(await page.locator('.agent-connector').isVisible(), false);
    assert.equal(await page.evaluate(() => JSON.parse(window.transportRoot.querySelector('[data-ai-context-agent-result]').textContent).status), 'ok');
    await page.evaluate(() => window.transport.setRefinementEnabled({ caseId: 'case-sigv' }));
    await page.evaluate(() => window.transport.refresh({ revision: 17, review: { case: { id: 'other-case' } } }));
    assert.equal(await page.locator('.agent-connector').isVisible(), false);
    assert.equal((await readPacket(page)).packet.caseReturn.enabled, false);
  } finally { await page.close(); }
});
