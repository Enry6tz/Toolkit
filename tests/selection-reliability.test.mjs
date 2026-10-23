import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('public control metadata, semantic containers, shadow roots and source styles remain useful without reading field values', async () => {
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><style>body{font-family:sans-serif}section{padding:20px}input,button{height:32px}</style>
      <section aria-label="Order"><h2>Order details</h2><label for="serial">Serial number</label><input id="serial" value="private-value-never-read" disabled required><button data-ai-source="src/Order.tsx:12:3">Save</button></section>
      <section aria-label="Profile"><button>Save</button></section><div data-ai-private><input id="private" value="secret"></div><input id="password" type="password" value="secret"><div id="custom"></div>`); return; }
    if (!/^\/dist\/[a-z0-9/_-]+\.js$/i.test(req.url ?? '')) { res.writeHead(404).end(); return; }
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(fileURLToPath(new URL(`..${req.url}`, import.meta.url)))); } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const proof = await page.evaluate(async () => {
      const { inspectElement } = await import('/dist/browser/context.js');
      const { createSelection, createGroupSelection, annotationPosition, resolveAnnotation } = await import('/dist/browser/selection.js');
      Object.defineProperty(HTMLInputElement.prototype, 'value', { configurable: true, get() { throw new Error('Field value was read'); } });
      const input = inspectElement(document.querySelector('#serial'));
      const button = document.querySelector('section button'), mark = createSelection(document, 'element', button).annotation;
      const originalY = mark.bounds.y; document.querySelector('h2').style.marginBottom = '100px';
      const live = resolveAnnotation(document, mark);
      const changed = live.getBoundingClientRect().y !== originalY;
      button.after(button.cloneNode(true)); const ambiguous = annotationPosition(document, mark).status;
      document.querySelector('section').replaceChildren(); const removed = annotationPosition(document, mark).status;
      const shadow = document.querySelector('#custom').attachShadow({ mode: 'open' }); shadow.innerHTML = '<button data-qa="shadow-save">Save preference</button>';
      const shadowMark = createSelection(document, 'element', shadow.querySelector('button')).annotation;
      const shadowResolved = resolveAnnotation(document, shadowMark) === shadow.querySelector('button');
      const rect = shadow.querySelector('button').getBoundingClientRect();
      const group = createGroupSelection(document, { x: rect.x - 2, y: rect.y - 2, width: rect.width + 4, height: rect.height + 4 });
      return { input, source: mark.element.source, styles: mark.element.styles, changed, ambiguous, removed,
        privateInput: inspectElement(document.querySelector('#private')), password: inspectElement(document.querySelector('#password')), shadowResolved,
        shadowGroup: group.annotation.relatedElements.some(element => element.accessibleName === 'Save preference') };
    });
    assert.equal(proof.input.accessibleName, 'Serial number'); assert.equal(proof.input.control.disabled, true); assert.equal(proof.input.control.required, true);
    assert(!JSON.stringify(proof).includes('private-value-never-read'));
    assert.equal(proof.source, 'src/Order.tsx:12:3'); assert(proof.styles['font-size']);
    assert.equal(proof.changed, true); assert.equal(proof.ambiguous, 'ambiguous'); assert.equal(proof.removed, 'historical');
    assert.equal(proof.privateInput, null); assert.equal(proof.password, null); assert.equal(proof.shadowResolved, true); assert.equal(proof.shadowGroup, true);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
