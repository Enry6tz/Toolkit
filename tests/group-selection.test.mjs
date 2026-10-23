import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('drag selection gathers concrete contained elements, excludes partial/private nodes, rejects empty space and survives JSON sharing', async () => {
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><style>button{position:absolute;width:80px;height:32px;top:30px}#left{left:20px}#right{left:120px}#partial{left:280px}#private{left:20px;top:90px}</style><div data-ai-component="Actions"><button id="left" data-ai-id="left">Abrir orden</button><button id="right" data-ai-id="right">Entregar orden</button></div><button id="partial">Parcial</button><button id="private" data-ai-private>Private content</button>'); return; }
    if (!/^\/dist\/[a-z0-9/_-]+\.js$/i.test(req.url ?? '')) { res.writeHead(404).end(); return; }
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(fileURLToPath(new URL(`..${req.url}`, import.meta.url)))); } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async () => {
      const { createGroupSelection, selectionElement } = await import('/dist/browser/selection.js');
      const { sanitizeAnnotations } = await import('/dist/core/annotations.js');
      const { createReviewEngine } = await import('/dist/review/session.js');
      const { importRecordingJson } = await import('/dist/review/recording-import.js');
      const selected = createGroupSelection(document, { x: 0, y: 0, width: 300, height: 150 });
      const mark = selected.annotation, engine = createReviewEngine();
      engine.startSession({ requestId: 'start', objective: 'Recording', scope: { origin: location.origin, pathname: '/' } });
      engine.startRecording({ requestId: 'record', authorized: true });
      mark.caseId = engine.getSnapshot().session.id; mark.note = 'Estos dos controles necesitan más separación.';
      engine.updateLocation({ origin: location.origin, pathname: '/', targetId: mark.id });
      engine.checkpoint({ requestId: 'mark', label: 'Group', pathname: '/', targetId: mark.id });
      engine.stopRecording({ requestId: 'stop' });
      const snapshot = engine.getSnapshot(), source = { schemaVersion: '1.0', session: snapshot.session, steps: snapshot.steps, events: snapshot.events, annotations: sanitizeAnnotations([mark]), partial: snapshot.partial };
      const imported = await importRecordingJson(JSON.stringify(source), { origin: location.origin, pathname: '/', id: () => crypto.randomUUID(), limits: snapshot.limits });
      return { mark, pageRoot: selectionElement(document.body, 'element'), empty: createGroupSelection(document, { x: 450, y: 300, width: 80, height: 80 }), imported: imported.annotations[0] };
    });
    assert.equal(result.mark.kind, 'group'); assert.equal(result.mark.elementCount, 2);
    assert.deepEqual(result.mark.relatedElements.map(element => element.accessibleName), ['Abrir orden', 'Entregar orden']);
    assert.deepEqual(result.mark.bounds, { x: 20, y: 30, width: 180, height: 32 });
    assert.equal(result.empty, null);
    assert.equal(result.pageRoot, null, 'empty page space is not a whole-page mark');
    assert.notEqual(result.mark.id, result.imported.id);
    for (const field of ['note', 'elementCount', 'relatedElements', 'bounds', 'viewport']) assert.deepEqual(result.imported[field], result.mark[field]);
    const many = await page.evaluate(async () => {
      const { createGroupSelection } = await import('/dist/browser/selection.js');
      document.body.replaceChildren();
      for (let i = 0; i < 205; i++) { const b = document.createElement('button'); b.textContent = `Item ${i}`; b.style.cssText = `position:absolute;left:${(i % 20) * 20}px;top:${Math.floor(i / 20) * 20}px;width:18px;height:18px;padding:0;border:0`; document.body.append(b); }
      return createGroupSelection(document, { x: 0, y: 0, width: 420, height: 240 }).annotation;
    });
    assert.equal(many.elementCount, 205); assert.equal(many.relatedElements.length, 200, 'the bounded sample retains its real total');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
