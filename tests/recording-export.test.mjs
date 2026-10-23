import assert from 'node:assert/strict';
import test from 'node:test';
import { recordingMarkdown as recordingMarkdownWithLocale, exportRecording as exportRecordingWithLocale } from '../dist/review/recording.js';
const recordingMarkdown = (input, options = {}) => recordingMarkdownWithLocale(input, { ...options, locale: 'es' });
const exportRecording = (input, options = {}) => exportRecordingWithLocale(input, { ...options, locale: 'es' });
import { createReviewEngine } from '../dist/review/session.js';
import { annotationsMarkdown } from '../dist/core/annotations.js';

const exportedAt = '2026-10-15T15:00:00.000Z';
const currentViewport = { width: 1920, height: 1080 };

function fixture(viewports = []) {
  const engine = createReviewEngine();
  engine.startSession({ requestId: 'start', objective: 'Recorrido', scope: { origin: 'https://preview.example.test', pathname: '/animals' } });
  engine.startRecording({ requestId: 'record', authorized: true });
  const annotations = viewports.map((viewport, index) => ({
    id: `mark-${index + 1}`, caseId: engine.getSnapshot().session.id, kind: 'element', pathname: `/screen-${index + 1}`,
    createdAt: exportedAt, updatedAt: exportedAt, label: `Marca ${index + 1}`, note: `Observación ${index + 1}`,
    bounds: { x: 20, y: 30, width: 100, height: 50 }, viewport,
    element: null, relatedElements: [],
  }));
  for (const mark of annotations) {
    engine.updateLocation({ origin: 'https://preview.example.test', pathname: mark.pathname, targetId: mark.id });
    assert.equal(engine.checkpoint({ requestId: `step-${mark.id}`, label: mark.label, pathname: mark.pathname, targetId: mark.id }).status, 'ok');
  }
  engine.stopRecording({ requestId: 'stop' });
  return { schemaVersion: '2.0', status: 'ok', preparedAt: exportedAt, review: engine.getSnapshot(),
    context: { schemaVersion: '1.0', capturedAt: exportedAt,
      page: { url: 'https://preview.example.test/now', pathname: '/now', title: 'Pantalla actual', viewport: currentViewport },
      build: { environment: 'preview' }, target: null, rules: [], privacy: { redactions: [] }, annotations },
  };
}

// The exporter writes STORE entries; inspect the resulting file payloads, not its implementation data.
function entries(bytes) {
  const buffer = Buffer.from(bytes), result = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset + 8), 0);
    const nameLength = buffer.readUInt16LE(offset + 26), extraLength = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength, size = buffer.readUInt32LE(offset + 18);
    result.set(buffer.toString('utf8', offset + 30, offset + 30 + nameLength), buffer.toString('utf8', start, start + size));
    offset = start + size;
  }
  return result;
}

test('a common viewport describes the historical marks, never the current export window', () => {
  const packet = fixture([{ width: 1440, height: 1000 }, { width: 1440, height: 1000 }]);
  const markdown = recordingMarkdown(packet);
  assert.match(markdown, /\*\*Viewport de las marcas:\*\* 1440×1000 CSS px/);
  assert.equal(markdown.match(/1440×1000/g)?.length, 1, 'shared geometry appears once to keep the handoff compact');
  assert.doesNotMatch(markdown, /1920×1080|Viewport al exportar/);
});

test('mixed historical viewports stay associated with their mark route and checkpoint', () => {
  const packet = fixture([{ width: 1440, height: 1000 }, { width: 390, height: 844 }]);
  const markdown = recordingMarkdown(packet);
  assert.match(markdown, /`\/screen-1` · viewport 1440×1000 CSS px/);
  assert.match(markdown, /`\/screen-2` · viewport 390×844 CSS px/);
  assert.equal(markdown.match(/1440×1000/g)?.length, 1, 'geometry remains on the single timeline entry for its mark');
  assert.equal(markdown.match(/390×844/g)?.length, 1);
  assert.doesNotMatch(markdown, /Viewport de las marcas:|1920×1080/);
});

test('missing historical geometry is explicit and is not replaced with the current viewport', () => {
  const markdown = recordingMarkdown(fixture([undefined, { width: 390, height: 844 }]));
  assert.match(markdown, /`\/screen-1` · viewport no registrado/);
  assert.match(markdown, /`\/screen-2` · viewport 390×844 CSS px/);
  assert.doesNotMatch(markdown, /1920×1080|0×0/);
});

test('a recording without marks labels current geometry as measured at export', () => {
  const markdown = recordingMarkdown(fixture());
  assert.match(markdown, /\*\*Viewport al exportar:\*\* 1920×1080 CSS px/);
  assert.doesNotMatch(markdown, /Viewport de las marcas/);
});

test('document geometry identifies freehand marks using their original bounds', () => {
  const packet = fixture([{ width: 1440, height: 1000 }]);
  const mark = packet.context.annotations[0];
  mark.kind = 'area'; mark.bounds = { x: 95, y: 1420, width: 420, height: 180 };
  const markdown = recordingMarkdown(packet);
  assert.match(markdown, /Zona en documento: esquina superior izquierda \(x=95, y=1420\), 420×180 CSS px\./);
  assert.match(markdown, /Viewport de las marcas:\*\* 1440×1000 CSS px/);
  packet.context.page.viewport = { width: 375, height: 812 };
  assert.equal(recordingMarkdown(packet), markdown, 'resizing the export window cannot rewrite selection-time geometry');
  const legacy = annotationsMarkdown(packet.context.annotations);
  assert.match(legacy, /Viewport al marcar: 1440×1000 CSS px\./);
  assert.match(legacy, /Zona en documento: esquina superior izquierda \(x=95, y=1420\), 420×180 CSS px\./);
});

test('a linked mark appears once in the timeline with its note, selector and historical geometry', () => {
  const packet = fixture([{ width: 1440, height: 1000 }]);
  const mark = packet.context.annotations[0]; mark.label = 'Agregar animal';
  mark.element = { tag: 'button', selector: '[data-ai-id="add-animal"]', text: 'Agregar animal' };
  const markdown = recordingMarkdown(packet);
  assert.match(markdown, /Marca 1 · Agregar animal · `\/screen-1`/);
  assert.equal(markdown.match(/Observación 1/g)?.length, 1);
  assert.equal(markdown.match(/Zona en documento:/g)?.length, 1);
  assert.equal(markdown.match(/Selector:/g)?.length, 1);
  assert.doesNotMatch(markdown, /## Marcas/);
  assert.match(markdown, /data-ai-id="add-animal"/);
});

test('legacy marks without a checkpoint keep their note and geometry without duplication', () => {
  const packet = fixture([{ width: 1440, height: 1000 }]); packet.review.steps = [];
  const markdown = recordingMarkdown(packet);
  assert.match(markdown, /## Marcas sin paso asociado/);
  assert.equal(markdown.match(/Observación 1/g)?.length, 1);
  assert.match(markdown, /esquina superior izquierda \(x=20, y=30\), 100×50 CSS px/);
});

test('pending marks and marks from a different recording do not change the viewport summary', () => {
  const packet = fixture([{ width: 1440, height: 1000 }]);
  const first = packet.context.annotations[0];
  packet.context.annotations.push({ ...first, id: 'pending', pending: true, viewport: { width: 500, height: 500 } },
    { ...first, id: 'other-recording', caseId: 'other-session', viewport: { width: 600, height: 600 } });
  const markdown = recordingMarkdown(packet);
  assert.match(markdown, /\*\*Viewport de las marcas:\*\* 1440×1000 CSS px/);
  assert.doesNotMatch(markdown, /500×500|600×600/);
});

test('the two-file recording archive preserves every historical mark viewport in JSON', () => {
  const viewports = [{ width: 1440, height: 1000 }, { width: 390, height: 844 }];
  const packet = fixture(viewports), before = JSON.stringify(packet);
  packet.context.rules.push('PRIVATE_DOCUMENT_SENTINEL');
  const bundle = exportRecording(packet), files = entries(bundle.bytes);
  assert.deepEqual([...files.keys()].sort(), ['grabacion.json', 'grabacion.md']);
  assert.deepEqual(JSON.parse(files.get('grabacion.json')).annotations.map(mark => mark.viewport), viewports);
  assert.equal(files.get('grabacion.md'), bundle.markdown);
  assert.doesNotMatch([...files.values()].join('\n'), /PRIVATE_DOCUMENT_SENTINEL|screenshots\//);
  packet.context.rules.pop();
  assert.equal(JSON.stringify(packet), before, 'export does not rewrite historical marks');
});

test('compact Markdown hides lifecycle metadata and clocks while preserving the useful route, geometry and query duration', () => {
  const packet = fixture([{ width: 1440, height: 1000 }]);
  packet.review.session.objective = 'Grabación · 15/10/2026, 12:00:00';
  packet.review.session.startedAt = exportedAt;
  const markStep = packet.review.steps.find(step => step.targetId === 'mark-1');
  const automaticStart = { ...markStep, id: 'automatic-start', label: 'Inicio de la grabación', recordingBoundary: 'start', targetId: undefined, at: exportedAt };
  const automaticEnd = { ...markStep, id: 'automatic-end', label: 'Fin de la grabación', recordingBoundary: 'stop', targetId: undefined, at: '2026-10-15T15:00:08.000Z' };
  // Identical text supplied by a user is a real step, not a lifecycle marker.
  const userStep = { ...markStep, id: 'user-step', label: 'Inicio de la grabación', targetId: undefined, notes: 'Texto escrito por la persona.', at: '2026-10-15T15:00:03.000Z' };
  packet.review.steps = [automaticStart, userStep, markStep, automaticEnd];
  packet.review.events = [{ id: 'query-1', sessionId: packet.review.session.id, kind: 'fetch', at: '2026-10-15T15:00:04.000Z', actor: 'unknown', attribution: 'unknown', simulated: false,
    resource: 'Animales', method: 'GET', status: 500, outcome: 'http_error', durationMs: 1234, stepId: automaticStart.id,
    responseBody: { status: 'captured', text: '{"error":"tabla pendiente"}', contentType: 'application/json', charLimit: 8000 } }];
  const before = JSON.stringify(packet), full = recordingMarkdown(packet), compact = recordingMarkdown(packet, { compact: true });
  assert.match(full, /# Grabación · 15\/10\/2026, 12:00:00/);
  assert.match(full, /Fin de la grabación/);
  assert.match(compact, /^# Grabación\n/);
  assert.doesNotMatch(compact, /15\/10\/2026|2026-10-15|\*\*Inicio:\*\*|\d\d:\d\d|Fin de la grabación/);
  assert.equal(compact.match(/Inicio de la grabación/g)?.length, 1, 'the explicitly user-authored label survives');
  assert.match(compact, /1\. Inicio de la grabación/);
  assert.match(compact, /Texto escrito por la persona\./);
  assert.match(compact, /`\/screen-1`/);
  assert.match(compact, /Viewport de las marcas:\*\* 1440×1000 CSS px/);
  assert.match(compact, /esquina superior izquierda \(x=20, y=30\), 100×50 CSS px/);
  assert.match(compact, /GET Animales → HTTP 500 · 1234 ms/);
  assert.match(compact, /tabla pendiente/);
  assert.equal(JSON.stringify(packet), before, 'compact presentation never deletes source metadata');
  const bundle = exportRecording(packet, { compact: true }), files = entries(bundle.bytes), structured = JSON.parse(files.get('grabacion.json'));
  assert.equal(files.get('grabacion.md'), compact);
  assert.equal(bundle.markdown, compact);
  assert.equal(structured.session.startedAt, exportedAt);
  assert.equal(structured.session.objective, packet.review.session.objective);
  assert.equal(structured.steps[0].recordingBoundary, 'start');
  assert.equal(structured.steps.at(-1).recordingBoundary, 'stop');
  assert.deepEqual(structured.annotations[0].viewport, { width: 1440, height: 1000 });
  assert.deepEqual(structured.annotations[0].bounds, packet.context.annotations[0].bounds);
});
