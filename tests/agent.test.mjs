import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createAgentContext, AGENT_STARTER, createTranslator } from '@e6tz/toolkit/core';
import { installAgentBridge } from '@e6tz/toolkit/browser';

function snapshot() {
  const content = '# Guía pública\n```html\n<script>datoNoConfiable()</script>\n```\n';
  return {
    schemaVersion: '1.0', capturedAt: '2026-10-14T12:00:00.000Z',
    page: { url: 'https://preview.example.test/page?token=agent-secret#private', pathname: '/page', title: 'Vista para qa@example.test', viewport: { width: 1280, height: 800 } },
    build: { environment: 'preview' }, target: null, rules: [], privacy: { redactions: [] },
    knowledge: { schemaVersion: '1.0', documents: [{ id: 'guide', label: 'Guía', content, checksum: createHash('sha256').update(content).digest('hex') }] },
  };
}

test('public context Markdown round-trips as one JSON block while preserving literal published documents', () => {
  const input = snapshot();
  const payload = createAgentContext(input);
  assert.ok(payload.markdown.startsWith('# Toolkit · contexto de esta pestaña'));
  assert.equal(payload.schemaVersion, '1.0');
  assert.equal(payload.context.page.url, 'https://preview.example.test/page');
  assert.doesNotMatch(payload.markdown, /agent-secret|qa@example.test/);
  assert.equal(payload.markdown.match(/^```/gm).length, 2, 'untrusted document fences cannot open a new Markdown block');
  const structured = payload.markdown.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(structured);
  assert.deepEqual(JSON.parse(structured[1]), payload.context);
  assert.equal(payload.context.knowledge.documents[0].content, input.knowledge.documents[0].content);
});

test('Toolkit wording preserves the bridge contract and bidirectional locale behavior', () => {
  assert.match(AGENT_STARTER, /Toolkit/);
  assert.ok(AGENT_STARTER.includes("window.__AI_CONTEXT_TOOLBAR__.getContext({version:'2.0'})"));
  const en = createTranslator('en');
  const es = createTranslator('es');
  for (const [spanish, english] of [
    ['Iniciar sesión en Toolkit', 'Sign in to Toolkit'],
    ['Compartida en Toolkit. Los cambios locales requieren actualizar.', 'Shared in Toolkit. Local changes must be updated.'],
    ['La grabación cambió en Toolkit. Abrila de nuevo antes de actualizar; tu copia local se conserva.', 'The recording changed in Toolkit. Open it again before updating; your local copy is kept.'],
    ['Ya hay otro Toolkit en esta página.', 'Another Toolkit toolbar is already on this page.'],
  ]) {
    assert.equal(en(spanish), english);
    assert.equal(es(english), spanish);
  }
  assert.equal(en('Creada por {name}', { name: 'Author' }), 'Created by Author');
  assert.equal(es('Created by {name}', { name: 'Author' }), 'Creada por Author');
});

test('public bridge protects its namespace and refuses pending or future reads after disposal', async () => {
  const target = { document: {} };
  let finish;
  let reads = 0;
  const pendingResult = new Promise(resolve => { finish = resolve; });
  const handle = installAgentBridge({ window: target, getContext: () => { reads += 1; return pendingResult; } });
  assert.equal(handle.api.apiVersion, '1.0');
  assert.equal(Object.isFrozen(handle.api), true);
  assert.equal(Object.keys(target).includes('__AI_CONTEXT_TOOLBAR__'), false);
  assert.throws(() => installAgentBridge({ window: target, getContext: async () => createAgentContext(snapshot()) }), /Ya existe/);
  assert.equal(target.__AI_CONTEXT_TOOLBAR__, handle.api);
  const pending = handle.api.getContext();
  handle.dispose();
  finish(createAgentContext(snapshot()));
  await assert.rejects(pending, /ya no está disponible/);
  await assert.rejects(handle.api.getContext(), /ya no está disponible/);
  assert.equal(reads, 1);
  assert.equal('__AI_CONTEXT_TOOLBAR__' in target, false);
  handle.dispose();
});

test('denied native capability and throwing status observers preserve the local fallback and cleanup', async () => {
  const document = {};
  Object.defineProperty(document, 'modelContext', { get() { throw new Error('capability denied'); } });
  const target = { document };
  const handle = installAgentBridge({
    window: target, getContext: async () => createAgentContext(snapshot()),
    onSiteToolsStatus() { throw new Error('observer failed'); },
  });
  assert.equal((await handle.api.getContext()).context.page.pathname, '/page');
  handle.dispose();
  assert.equal('__AI_CONTEXT_TOOLBAR__' in target, false);
});

test('native bridge accepts an empty read and rejects arbitrary input without invoking the reader', async () => {
  let registered;
  let registrationSignal;
  let reads = 0;
  const target = { document: { modelContext: {
    registerTool(tool, { signal }) { registered = tool; registrationSignal = signal; },
  } } };
  const handle = installAgentBridge({ window: target, getContext: async () => { reads += 1; return createAgentContext(snapshot()); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registered.name, 'ai_context_get_context');
  assert.deepEqual(registered.annotations, { readOnlyHint: true, untrustedContentHint: true });
  assert.deepEqual(registered.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  assert.equal((await registered.execute()).schemaVersion, '1.0');
  assert.equal((await registered.execute({})).schemaVersion, '1.0');
  for (const input of [null, [], 'code', { action: 'start-recording' }, { javascript: 'untrusted()' }]) {
    await assert.rejects(registered.execute(input), /no acepta parámetros/);
  }
  assert.equal(reads, 2);
  handle.dispose();
  assert.equal(registrationSignal.aborted, true);
  await assert.rejects(registered.execute(), /ya no está disponible/);
});

test('bridge v2 is explicit and preserves the exact legacy response and namespace version', async () => {
  let legacyReads = 0; let modernReads = 0;
  const legacy = createAgentContext(snapshot());
  const v2 = { schemaVersion: '2.0', revision: 4, session: null, capabilities: {} };
  const target = { document: {} };
  const handle = installAgentBridge({ window: target,
    getContext: async () => { legacyReads += 1; return legacy; },
    getContextV2: async () => { modernReads += 1; return v2; },
  });
  assert.equal(handle.api.apiVersion, '1.0');
  assert.deepEqual(await handle.api.getContext(), legacy);
  assert.deepEqual(await handle.api.getContext({ version: '2.0' }), v2);
  assert.equal(legacyReads, 1); assert.equal(modernReads, 1);
  for (const input of [{ version: '3.0' }, { version: '2.0', action: 'start' }, null, []]) await assert.rejects(handle.api.getContext(input), /no acepta parámetros/);
  assert.equal(legacyReads, 1); assert.equal(modernReads, 1);
  handle.dispose();
});

test('recording-only site tool reads the complete recording by default without changing the compatible page API', async () => {
  let tool;
  const legacy = createAgentContext(snapshot());
  const recording = { schemaVersion: '2.0', revision: 9, review: { steps: Array.from({ length: 70 }, (_, i) => ({ id: `step-${i}` })) } };
  const target = { document: { modelContext: { registerTool(value) { tool = value; } } } };
  const handle = installAgentBridge({ window: target, recordingOnly: true, getContext: async () => legacy, getContextV2: async () => recording });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await tool.execute({}), recording);
  assert.equal((await tool.execute({})).review.steps.length, 70);
  assert.deepEqual(await handle.api.getContext(), legacy);
  handle.dispose();
});

test('native review operations register truthful mutation annotations and never run during a read', async () => {
  const registered = new Map();
  let starts = 0; let recordings = 0; let signals;
  const target = { document: { modelContext: { registerTool(tool, { signal }) { registered.set(tool.name, tool); signals = signal; } } } };
  const handle = installAgentBridge({ window: target, getContext: async () => createAgentContext(snapshot()),
    getContextV2: async () => ({ schemaVersion: '2.0', revision: 0, session: null }),
    operations: {
      startSession: input => { starts += 1; return { status: 'ok', revision: 1, data: input.requestId }; },
      startRecording: input => { recordings += 1; return { status: 'error', revision: 1, error: { code: 'RECORDING_NOT_AUTHORIZED', message: 'Authorization required' } }; },
      getArtifact: () => ({ status: 'error', revision: 1, error: { code: 'BINARY_TRANSPORT_UNAVAILABLE', message: 'No transport' } }),
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registered.get('ai_context_get_context').inputSchema.properties.version.enum[0], '2.0');
  assert.equal((await registered.get('ai_context_get_context').execute({ version: '2.0' })).schemaVersion, '2.0');
  assert.equal(starts, 0); assert.equal(recordings, 0);
  assert.equal(registered.get('ai_context_start_session').annotations.readOnlyHint, false);
  assert.equal(registered.get('ai_context_get_artifact').annotations.readOnlyHint, true);
  assert.equal((await registered.get('ai_context_start_session').execute({ requestId: 'start' })).status, 'ok');
  assert.equal(starts, 1); assert.equal(recordings, 0);
  await assert.rejects(registered.get('ai_context_start_session').execute([]), /objeto/);
  assert.equal(starts, 1);
  assert.equal((await handle.api.getArtifact({ artifactId: 'image-1' })).error.code, 'BINARY_TRANSPORT_UNAVAILABLE');
  handle.dispose();
  assert.equal(signals.aborted, true);
  await assert.rejects(handle.api.startSession({ requestId: 'late' }), /ya no está disponible/);
  assert.equal(starts, 1);
});

test('v2 bridge rejects malformed revision responses and reports failed native registration conservatively', async () => {
  const statuses = [];
  const target = { document: { modelContext: { registerTool(tool) { if (tool.name !== 'ai_context_get_context') throw new Error('denied'); } } } };
  const handle = installAgentBridge({ window: target, getContext: async () => createAgentContext(snapshot()),
    getContextV2: async () => ({ schemaVersion: '2.0', revision: -1 }),
    operations: { startSession: input => input }, onSiteToolsStatus: value => statuses.push(value),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(statuses, [false]);
  await assert.rejects(handle.api.getContext({ version: '2.0' }), /revisión válida/);
  assert.equal((await handle.api.getContext()).schemaVersion, '1.0');
  handle.dispose();
});
