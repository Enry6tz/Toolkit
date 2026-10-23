import assert from 'node:assert/strict';
import test from 'node:test';
import { installAgentBridge } from '../dist/browser/bridge.js';

test('case operations are explicitly registered as mutations and a read never starts or refines a case', async () => {
  const registered = new Map(), calls = [];
  const target = { document: { modelContext: { registerTool(tool) { registered.set(tool.name, tool); } } } };
  const names = ['startCase', 'updateCase', 'prepareCase', 'submitRefinement', 'approveRefinement'];
  const handle = installAgentBridge({ window: target,
    getContext: async () => ({ schemaVersion: '1.0' }),
    getContextV2: async () => ({ schemaVersion: '2.0', revision: 4, review: { case: { id: 'case-1' } } }),
    operations: Object.fromEntries(names.map(name => [name, input => { calls.push({ name, input }); return { status: 'ok', revision: 5 }; }])),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await handle.api.getContext({ version: '2.0' })).review.case.id, 'case-1');
  assert.deepEqual(calls, []);
  for (const name of names) assert.equal(typeof handle.api[name], 'function', name);
  const tools = ['ai_context_start_case', 'ai_context_update_case', 'ai_context_prepare_case', 'ai_context_submit_refinement', 'ai_context_approve_refinement'];
  for (const name of tools) {
    assert.deepEqual(registered.get(name).annotations, { readOnlyHint: false, untrustedContentHint: true });
    assert.equal(registered.get(name).inputSchema.additionalProperties, false);
  }
  const submit = registered.get('ai_context_submit_refinement');
  assert.deepEqual(submit.inputSchema.required, ['requestId', 'expectedRevision', 'caseId', 'proposal']);
  assert.deepEqual(submit.inputSchema.properties.proposal.required, ['title', 'steps', 'expected']);
  assert.equal(submit.inputSchema.properties.proposal.additionalProperties, false);
  assert.match(submit.description, /proposal for human review/i);
  assert.match(registered.get('ai_context_approve_refinement').description, /human explicitly reviewed/i);
  const input = { requestId: 'proposal-1', caseId: 'case-1', expectedRevision: 4,
    proposal: { title: 'Validar destino', steps: ['Elegir origen y destino iguales'], expected: 'Rechazar la búsqueda' } };
  assert.equal((await submit.execute(input)).status, 'ok');
  assert.deepEqual(calls, [{ name: 'submitRefinement', input }]);
  handle.dispose();
  await assert.rejects(submit.execute(input), /ya no está disponible/);
  assert.equal(calls.length, 1);
});
