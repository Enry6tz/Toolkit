import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReviewEngine } from '../dist/review/session.js';
import { recordingJson, recordingMarkdown } from '../dist/review/recording.js';
import { importRecordingJson } from '../dist/review/recording-import.js';
import { validateKnowledgeBundle, documentMatchesRoute, validateDocumentRoutes } from '../dist/core/knowledge.js';
import { sanitizeRecordedContext } from '../dist/core/recorded-context.js';

const document = (id, routes) => { const content = `# ${id}\n\nA published user story.`; return { id, label: id, content, checksum: createHash('sha256').update(content).digest('hex'), ...(routes ? { routes } : {}) }; };
const limits = { maxEvents: 10000, maxImages: 20, maxBytes: 50 * 1024 * 1024 };

test('source context is frozen per action and survives a cross-origin JSON import, with public route state and visited documents', async () => {
  const docs = [document('general'), document('orders', ['/orders/**']), document('billing', ['/billing'])];
  let path = '/orders', url = 'https://source.test/orders?tab=open&token=private', viewport = { width: 1440, height: 900 };
  const observe = () => sanitizeRecordedContext({ appName: 'Workshop', capturedAt: new Date().toISOString(), url, publicQueryParams: ['tab', 'token'], viewport,
    build: { environment: 'preview', buildId: 'commit-123' } });
  const engine = createReviewEngine({ observe, getDocuments: () => ({ schemaVersion: '1.0', documents: docs.filter(doc => documentMatchesRoute(doc, path)) }) });
  const scope = () => ({ origin: 'https://source.test', pathname: path });
  engine.updateLocation(scope()); engine.startSession({ requestId: 'session', objective: 'Recording', scope: scope() });
  engine.startRecording({ requestId: 'start', authorized: true });
  engine.checkpoint({ requestId: 'first', label: 'Filter orders', pathname: path });
  url = 'https://source.test/orders/42?tab=history&token=private'; path = '/orders/42'; viewport = { width: 390, height: 844 }; engine.updateLocation(scope());
  engine.checkpoint({ requestId: 'last', label: 'Read order', pathname: path }); engine.stopRecording({ requestId: 'stop' });
  const review = engine.getSnapshot();
  assert.equal(review.steps[0].context.url, 'https://source.test/orders?tab=open');
  assert.deepEqual(review.steps[0].context.viewport, { width: 1440, height: 900 });
  assert.equal(review.steps.at(-1).context.url, 'https://source.test/orders/42?tab=history');
  assert.deepEqual(review.session.documents.documents.map(doc => doc.id), ['general', 'orders']);
  const context = { schemaVersion: '1.0', capturedAt: new Date().toISOString(), page: { url, pathname: path, viewport, title: '' }, build: { environment: 'preview' }, rules: [], target: null, annotations: [], privacy: { redactions: [] } };
  const json = recordingJson({ context, review }); assert.equal(JSON.parse(json).schemaVersion, '1.1'); assert(!json.includes('private'));
  const imported = await importRecordingJson(json, { origin: 'https://recipient.test', pathname: '/orders', limits, id: () => crypto.randomUUID() });
  assert.equal(imported.draft.snapshot.session.scope.origin, 'https://recipient.test');
  assert.deepEqual(imported.draft.snapshot.session.context, review.session.context);
  assert.deepEqual(imported.draft.snapshot.steps[1].context, review.steps[0].context);
  assert.deepEqual(imported.draft.snapshot.session.documents, review.session.documents);
  const markdown = recordingMarkdown({ context, review }, { compact: true });
  assert.match(markdown, /commit-123/); assert.match(markdown, /\/orders\?tab=open/); assert.match(markdown, /\/orders\/42\?tab=history/);
  assert.match(markdown, /# orders/); assert(!markdown.includes('# billing'));
  assert(!recordingMarkdown({ context, review }, { compact: true, includeDocuments: false }).includes('# orders'));
  const tampered = JSON.parse(json); tampered.session.documents.documents[0].content += 'Changed';
  await assert.rejects(importRecordingJson(JSON.stringify(tampered), { origin: 'https://recipient.test', pathname: '/orders', limits, id: () => crypto.randomUUID() }), /checksum/);
});

test('document routes validate once, preserve metadata in bundles, and match path boundaries', () => {
  assert.equal(documentMatchesRoute(document('all'), '/anything'), true);
  const scoped = document('orders', ['/orders/**']);
  for (const route of ['/orders', '/orders/', '/orders/42']) assert.equal(documentMatchesRoute(scoped, route), true);
  for (const route of ['/order', '/orders-other', '/billing']) assert.equal(documentMatchesRoute(scoped, route), false);
  assert.deepEqual(validateKnowledgeBundle({ schemaVersion: '1.0', documents: [scoped] }).documents[0].routes, scoped.routes);
  for (const routes of [[], ['https://example.test'], ['/a?token=b'], ['/a/*/b'], ['/../private'], ['/a', '/a']]) assert.throws(() => validateDocumentRoutes(routes));
});
