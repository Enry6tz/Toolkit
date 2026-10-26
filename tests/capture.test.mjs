import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { pngDimensions } from '../dist/review/capture.js';
import { validateDomainContext, validatePublishedDesignContext } from '../dist/review/design.js';

let server, browser, base;
const fixture = `<!doctype html><html><head><title>Real capture test</title><style>
body{margin:0;background:rgb(255,255,255);font-family:Arial}button,input,section,iframe,canvas,secret-box{position:absolute;width:160px;height:40px;left:20px;box-sizing:border-box}
#selected{top:20px;background:rgb(0,128,0);color:white;border-radius:8px;padding:8px;font-size:16px}input{top:100px}#private{top:160px;background:red}secret-box{top:220px;background:red}iframe{top:280px;background:red}canvas{top:340px;background:red}#toolbar{top:410px;background:rgb(255,0,255)}
</style></head><body><button id="selected">Acción pública</button><input value="secret-form-123" aria-label="Nombre"><section id="private" data-ai-private>secret-private</section><secret-box></secret-box><iframe srcdoc="secret-iframe"></iframe><canvas></canvas><button id="toolbar" data-ai-toolbar-root style="visibility:visible">Toolbar</button><script>document.querySelector('secret-box').attachShadow({mode:'closed'}).innerHTML='<input value="secret-shadow">';</script></body></html>`;
before(async () => {
  server = createServer(async (req, res) => {
    if (req.url === '/' || req.url?.startsWith('/changed')) { res.setHeader('content-type', 'text/html'); res.end(fixture); return; }
    const path = (req.url ?? '').split('?')[0];
    if (!/^\/dist\/[a-z0-9/_-]+\.js$/i.test(path)) { res.writeHead(404).end(); return; }
    try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(fileURLToPath(new URL(`..${path}`, import.meta.url)))); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });
async function pageFixture() {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 });
  await page.goto(base); await page.evaluate(async () => { window.captureModule = await import('/dist/review/capture.js'); window.designModule = await import('/dist/review/design.js'); });
  return page;
}
async function complete(page, token, image, at = new Date().toISOString(), dims = { width: 1000, height: 700 }) {
  return page.evaluate(async ({ token, base64, at, dims }) => {
    try {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const result = await window.captureModule.completeExternalCapture(token, { bytes, capturedAt: at, pixelWidth: dims.width, pixelHeight: dims.height, provider: 'playwright-chromium-screenshot' });
      window.lastImage = result;
      const bitmap = await createImageBitmap(new Blob([result.bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
      const pixels = [[30,30],[30,110],[30,170],[30,230],[30,290],[30,350],[30,420],[170,190],[170,120]].map(([x,y]) => Array.from(ctx.getImageData(x,y,1,1).data)); bitmap.close();
      return { status: 'ok', kind: result.kind, redactions: result.redactions, redactionStatus: result.redactionStatus, toolbarHidden:result.toolbarHidden, size: result.bytes.length, signature: Array.from(result.bytes.slice(0,8)), width:result.pixelWidth,height:result.pixelHeight, pixels, at:result.capturedAt };
    } catch (error) { return { status: 'error', code: error.code, message:error.message }; }
  }, { token, base64: image.toString('base64'), at, dims });
}

test('real Chromium viewport screenshot transport excludes fields, private regions, shadow hosts, embeds and toolbar', async () => {
  const page = await pageFixture();
  try {
    await page.locator('input').focus();
    const prepared = await page.evaluate(() => window.captureModule.beginExternalCapture({ revision: 7, privacy: 'redact' }));
    const image = await page.screenshot({ type:'png', caret:'initial' }), capturedAt = new Date().toISOString();
    const result = await complete(page, prepared.token, image, capturedAt);
    assert.equal(result.status, 'ok', result.message); assert.ok(result.size > 1000); assert.equal(result.redactionStatus, 'applied'); assert.equal(result.at, capturedAt);
    assert.deepEqual(result.pixels[0], [0,128,0,255]);
    for (const index of [1,2,3,4,5]) assert.deepEqual(result.pixels[index], [24,24,27,255]);
    assert.deepEqual(result.pixels[6], [255,255,255,255], 'toolbar is absent from real pixels');
    assert.equal(await page.locator('[data-ai-capture-shield]').count(), 0);
    assert.equal(await page.locator('#toolbar').evaluate(el => el.style.visibility), 'visible');
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('input')), true);
    const repeated = await complete(page, prepared.token, image); assert.equal(repeated.code, 'STALE_CAPTURE');
  } finally { await page.close(); }
});

test('default capture keeps visible page data without black overlays or stale errors for unrelated DOM updates', async () => {
  const page = await pageFixture();
  try {
    const prepared = await page.evaluate(() => window.captureModule.beginExternalCapture());
    assert.equal(await page.locator('[data-ai-capture-shield]').count(),0);
    await page.evaluate(() => { const hint=document.createElement('span'); hint.textContent='Current UI state'; document.body.append(hint); });
    const image = await page.screenshot({type:'png',caret:'initial'});
    const result = await complete(page,prepared.token,image);
    assert.equal(result.status,'ok',result.message); assert.equal(result.redactionStatus,'disabled'); assert.deepEqual(result.redactions,[]); assert.equal(result.toolbarHidden,true);
    assert.deepEqual(result.pixels[7],[255,0,0,255], 'private region remains visible in the actual PNG');
    assert.deepEqual(result.pixels[8],[255,255,255,255], 'editable remains visible in the actual PNG');
    assert.deepEqual(result.pixels[6],[255,255,255,255], 'toolbar alone is absent');
    assert.equal(await page.locator('#toolbar').evaluate(el=>el.style.visibility),'visible');
  } finally { await page.close(); }
});

test('DOM-only adapter can keep its toolbar form reachable and records the actual visibility policy', async () => {
  const page = await pageFixture();
  try {
    for (const privacy of ['visible','redact']) {
      const prepared = await page.evaluate(privacy => window.captureModule.beginExternalCapture({privacy,hideToolbar:false}),privacy);
      assert.equal(prepared.toolbarHidden,false);
      assert.equal(await page.locator('#toolbar').isVisible(),true);
      const result = await complete(page,prepared.token,await page.screenshot({type:'png',caret:'initial'}));
      assert.equal(result.status,'ok',result.message); assert.equal(result.toolbarHidden,false);
      assert.deepEqual(result.pixels[6],[255,0,255,255],'the toolbar remains in the actual captured pixels');
      assert.equal(await page.locator('#toolbar').isVisible(),true);
    }
  } finally { await page.close(); }
});

test('external JPEG screenshot is decoded and delivered as a real PNG; region uses verified pixel scale', async () => {
  const page = await pageFixture();
  try {
    const prepared = await page.evaluate(() => window.captureModule.beginExternalCapture({kind:'region',target:document.querySelector('#selected'),privacy:'redact'}));
    const image = await page.screenshot({ type:'jpeg', quality:95, caret:'initial' });
    const result = await complete(page, prepared.token, image);
    assert.equal(result.status,'ok',result.message); assert.equal(result.kind,'region'); assert.equal(result.width,160); assert.equal(result.height,40);
    assert.deepEqual(result.signature,[137,80,78,71,13,10,26,10]);
  } finally { await page.close(); }
});

test('free rectangle crops genuine browser pixels without a DOM target and takes priority over another target', async () => {
  const page = await pageFixture();
  try {
    for (const privacy of ['visible', 'redact']) {
      const prepared = await page.evaluate(privacy => {
        window.freeRegion = { x: 140, y: 30, width: 30, height: 15 };
        return window.captureModule.beginExternalCapture({ kind: 'region', privacy,
          ...(privacy === 'redact' ? { target: document.querySelector('#selected') } : {}),
          getRegionBounds: () => window.freeRegion });
      }, privacy);
      const sourceImage = await page.screenshot({ type: 'png', caret: 'initial' });
      const result = await complete(page, prepared.token, sourceImage);
      assert.equal(result.status, 'ok', JSON.stringify(result));
      assert.equal(result.kind, 'region');
      assert.equal(result.width, 30); assert.equal(result.height, 15);
      const pixels = await page.evaluate(async base64 => {
        const bitmap = await createImageBitmap(new Blob([window.lastImage.bytes], { type: 'image/png' }));
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
        const cropped = Array.from(context.getImageData(0, 0, 30, 15).data); bitmap.close();
        const source = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], { type: 'image/png' }));
        canvas.width = source.width; canvas.height = source.height; context.drawImage(source, 0, 0);
        const expected = Array.from(context.getImageData(140, 30, 30, 15).data); source.close();
        return { cropped, expected };
      }, sourceImage.toString('base64'));
      assert.deepEqual(pixels.cropped, pixels.expected, 'every cropped pixel matches the selected rectangle in the genuine screenshot');
      assert.equal(result.redactionStatus, privacy === 'visible' ? 'disabled' : 'applied');
    }
  } finally { await page.close(); }
});

test('free rectangle is snapshotted and changing or removing it invalidates a pending real image', async () => {
  const page = await pageFixture();
  try {
    for (const privacy of ['visible', 'redact']) for (const change of ['mutate', 'replace', 'remove']) {
      const prepared = await page.evaluate(privacy => {
        window.freeRegion = { x: 140, y: 30, width: 30, height: 15 };
        return window.captureModule.beginExternalCapture({ kind: 'region', privacy,
          target: document.querySelector('#selected'), getRegionBounds: () => window.freeRegion });
      }, privacy);
      const image = await page.screenshot({ type: 'png', caret: 'initial' });
      await page.evaluate(change => {
        if (change === 'mutate') window.freeRegion.x += 1;
        if (change === 'replace') window.freeRegion = { ...window.freeRegion, width: 25 };
        if (change === 'remove') window.freeRegion = null;
      }, change);
      const result = await complete(page, prepared.token, image);
      assert.equal(result.code, 'STALE_CAPTURE', `${privacy}/${change}: ${JSON.stringify(result)}`);
      assert.equal(await page.locator('[data-ai-capture-shield]').count(), 0);
      assert.equal(await page.locator('#toolbar').evaluate(element => element.style.visibility), 'visible');
    }
  } finally { await page.close(); }
});

test('free rectangle rejects nonfinite, empty and partly offscreen bounds before hiding the toolbar', async () => {
  const page = await pageFixture();
  try {
    const result = await page.evaluate(async () => {
      const invalid = [
        { x: NaN, y: 0, width: 20, height: 20 }, { x: 0, y: Infinity, width: 20, height: 20 },
        { x: 0, y: 0, width: Infinity, height: 20 }, { x: 0, y: 0, width: 0, height: 20 },
        { x: -1, y: 0, width: 20, height: 20 }, { x: 990, y: 0, width: 20, height: 20 },
        { x: 0, y: 690, width: 20, height: 20 },
      ];
      const codes = [];
      for (const privacy of ['visible', 'redact']) for (const region of invalid) {
        try { await window.captureModule.beginExternalCapture({ kind: 'region', privacy, getRegionBounds: () => region }); }
        catch (error) { codes.push(error.code); }
      }
      return codes;
    });
    assert.equal(result.length, 14);
    assert.ok(result.every(code => code === 'STALE_TARGET'));
    assert.equal(await page.locator('[data-ai-capture-shield]').count(), 0);
    assert.equal(await page.locator('#toolbar').evaluate(element => element.style.visibility), 'visible');
  } finally { await page.close(); }
});

test('changed route, changed DOM, mismatched viewport and late timestamps reject instead of misattributing evidence', async () => {
  const page = await pageFixture();
  try {
    for (const change of ['route','dom','geometry','dimensions','time']) {
      await page.goto(base); await page.evaluate(async () => { window.captureModule = await import('/dist/review/capture.js'); });
      const prepared = await page.evaluate(() => window.captureModule.beginExternalCapture({privacy:'redact'}));
      const image = await page.screenshot({type:'png',caret:'initial'});
      if (change === 'route') await page.evaluate(() => history.pushState({},'', '/changed'));
      if (change === 'dom') await page.evaluate(() => document.querySelector('#selected').textContent='Changed');
      if (change === 'geometry') await page.evaluate(() => document.styleSheets[0].insertRule('input{top:180px!important}',0));
      const result = await complete(page,prepared.token,image,change==='time'?'2020-01-01T00:00:00.000Z':new Date().toISOString(),change==='dimensions'?{width:2000,height:1400}:{width:1000,height:700});
      assert.equal(result.code,'STALE_CAPTURE',`${change}: ${result.message}`);
      assert.equal(await page.locator('[data-ai-capture-shield]').count(),0);
      assert.equal(await page.locator('#toolbar').evaluate(el=>el.style.visibility),'visible');
    }
  } finally { await page.close(); }
});

test('provider failures and explicit cancellation restore the UI and never produce artifacts', async () => {
  const page = await pageFixture();
  try {
    const failed = await page.evaluate(async () => {
      try { await window.captureModule.capturePage({name:'broken',kind:'real-browser',captureViewport:async request=>{await request.ready;throw new Error('provider failed');}}); }
      catch(error) { return error.message; }
    });
    assert.equal(failed,'provider failed'); assert.equal(await page.locator('[data-ai-capture-shield]').count(),0);
    const prepared = await page.evaluate(() => window.captureModule.beginExternalCapture());
    await page.evaluate(token=>window.captureModule.cancelExternalCapture(token),prepared.token);
    assert.equal(await page.locator('[data-ai-capture-shield]').count(),0);
    assert.equal(await page.locator('#toolbar').evaluate(el=>el.style.visibility),'visible');
    const unavailable = await page.evaluate(async()=>{try{await window.captureModule.capturePage(window.captureModule.createDisplayMediaCaptureProvider());}catch(error){return error.code;}});
    assert.equal(unavailable,'CAPABILITY_UNAVAILABLE'); assert.equal(await page.locator('[data-ai-capture-shield]').count(),0);
  } finally { await page.close(); }
});

test('native current-tab video produces visible and opt-in redacted real pixels with one grant for chat captures', { timeout: 30_000 }, async () => {
  // Test-only picker automation selects an actual rendered tab; no fake media or mock frames.
  // Pin the GL driver: the software compositor can shift native-video colours before capture reaches the SDK.
  const nativeBrowser = await chromium.launch({ channel: 'chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--auto-select-tab-capture-source-by-title=Real capture test', '--allow-http-screen-capture'] });
  const page = await nativeBrowser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 });
  try {
    await page.goto(base);
    await page.evaluate(async () => {
      window.captureModule = await import('/dist/review/capture.js');
      const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      window.nativePermissionCount = 0;
      window.nativeGrabFrameCount = 0;
      window.nativeImageCaptureAvailable = typeof window.ImageCapture === 'function';
      if (window.nativeImageCaptureAvailable) {
        const ActualImageCapture = window.ImageCapture;
        window.ImageCapture = class extends ActualImageCapture {
          async grabFrame() { const frame = await super.grabFrame(); window.nativeGrabFrameCount++; return frame; }
        };
      }
      navigator.mediaDevices.getDisplayMedia = (...args) => { window.nativePermissionCount++; return original(...args).then(stream => { window.nativeStream = stream; return stream; }); };
      window.nativeProvider = window.captureModule.createDisplayMediaCaptureProvider(document);
      document.querySelector('#selected').addEventListener('click', () => { window.nativeConnection = window.nativeProvider.connect(); });
    });
    await page.locator('#selected').click();
    await page.evaluate(() => window.nativeConnection);
    assert.equal(await page.evaluate(() => window.nativeProvider.isConnected()), true);
    // The agent requests images after the original click's transient activation has expired.
    await page.waitForFunction(() => !navigator.userActivation.isActive);
    const capture = (privacy = 'redact') => page.evaluate(async privacy => {
      try {
        const image = await window.captureModule.capturePage(window.nativeProvider, { privacy });
        const bitmap = await createImageBitmap(new Blob([image.bytes], { type: image.mimeType }));
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
        const sx = bitmap.width / image.viewport.width, sy = bitmap.height / image.viewport.height;
        const pixels = [[30,30],[30,110],[30,170],[30,230],[30,290],[30,350],[30,420],[170,190],[170,120]].map(([x,y]) => Array.from(ctx.getImageData(Math.round(x*sx),Math.round(y*sy),1,1).data));
        bitmap.close();
        return { status:'ok', size:image.bytes.length, signature:Array.from(image.bytes.slice(0,8)), provider:image.provider, pixelWidth:image.pixelWidth,pixelHeight:image.pixelHeight,redactions:image.redactions.length,redactionStatus:image.redactionStatus,pixels };
      } catch (error) { return { status:'error', code:error.code, message:error.message }; }
    }, privacy);
    for (let index = 0; index < 3; index++) {
      if (index) await page.evaluate(index => { document.querySelector('#selected').textContent = `Checkpoint ${index}`; }, index);
      const result = await capture();
      assert.equal(result.status,'ok',JSON.stringify(result)); assert.ok(result.size > 1000);
      assert.equal(result.provider,'browser-display-media'); assert.deepEqual(result.signature,[137,80,78,71,13,10,26,10]);
      assert.ok(result.redactions >= 5);
      for (const i of [1,2,3,4,5]) assert.ok(result.pixels[i].slice(0,3).every((n,c)=>Math.abs(n-[24,24,27][c])<=3),`Private pixels ${result.pixels[i]}`);
      assert.ok(result.pixels[0][1] >= 125 && result.pixels[0][0] <= 3, 'public green is captured from browser video');
      assert.ok(result.pixels[6].slice(0,3).every(n=>n>=252), 'toolbar is absent from real native video');
      assert.equal(await page.locator('[data-ai-capture-shield]').count(),0);
    }
    const visible = await capture('visible');
    assert.equal(visible.status,'ok',JSON.stringify(visible)); assert.equal(visible.redactionStatus,'disabled'); assert.equal(visible.redactions,0);
    assert.ok(visible.pixels[8].slice(0,3).every(n=>n>=240), 'editable remains visible without a black mask');
    assert.ok(visible.pixels[7][0]>=250 && visible.pixels[7][1]<=3 && visible.pixels[7][2]<=3, `private region remains visibly red when redaction is disabled: ${JSON.stringify(visible.pixels)}`);
    assert.ok(visible.pixels[6].slice(0,3).every(n=>n>=252), 'only toolbar is absent from visible native capture');
    // With the toolbar already hidden, these requests make no visual page change.
    // A static tab must still yield real pixels instead of waiting for a video repaint.
    await page.locator('#toolbar').evaluate(el => { el.style.visibility = 'hidden'; });
    for (let repeat = 0; repeat < 2; repeat++) {
      const staticImage = await capture('visible');
      assert.equal(staticImage.status,'ok',JSON.stringify(staticImage)); assert.equal(staticImage.redactionStatus,'disabled');
      assert.ok(staticImage.pixels[7][0]>=250 && staticImage.pixels[7][1]<=3, 'static visible tab still yields its real red pixels');
    }
    if (await page.evaluate(() => window.nativeImageCaptureAvailable)) assert.ok(await page.evaluate(() => window.nativeGrabFrameCount >= 12), 'each real ImageCapture delivery follows a discarded buffered frame');
    assert.equal(await page.evaluate(() => window.nativePermissionCount),1, 'start/checkpoint/stop reuse one explicit grant');
    await page.evaluate(() => window.nativeProvider.disconnect());
    assert.equal(await page.evaluate(() => window.nativeProvider.isConnected()),false);
    assert.equal(await page.evaluate(() => window.nativeStream.getVideoTracks()[0].readyState),'ended');
  } finally { await nativeBrowser.close(); }
});

test('native stream rejects a different real tab and releases its tracks', { timeout: 20_000 }, async () => {
  const nativeBrowser = await chromium.launch({ channel: 'chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--auto-select-tab-capture-source-by-title=Wrong capture surface', '--allow-http-screen-capture'] });
  try {
    const other = await nativeBrowser.newPage(); await other.goto(base); await other.evaluate(() => { document.title='Wrong capture surface'; });
    const page = await nativeBrowser.newPage(); await page.goto(base);
    await page.evaluate(async () => {
      const capture = await import('/dist/review/capture.js');
      window.nativeProvider = capture.createDisplayMediaCaptureProvider(document);
      const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      // A picker can choose a different tab despite preferences; test that actual surface.
      navigator.mediaDevices.getDisplayMedia = (...args) => { args[0] = { ...args[0], preferCurrentTab: false }; return original(...args).then(stream => { window.nativeStream = stream; return stream; }); };
      document.querySelector('#selected').addEventListener('click', () => { window.nativeConnection = window.nativeProvider.connect().then(()=>({status:'ok'}),error=>({status:'error',code:error.code})); });
    });
    await page.locator('#selected').click();
    const result = await page.evaluate(() => window.nativeConnection);
    assert.equal(result.status,'error'); assert.equal(result.code,'PRIVACY_REVIEW_REQUIRED');
    assert.equal(await page.evaluate(()=>window.nativeProvider.isConnected()),false);
    assert.equal(await page.evaluate(()=>window.nativeStream.getVideoTracks()[0].readyState),'ended');
  } finally { await nativeBrowser.close(); }
});

test('observed design exposes only public computed styles and explicitly observed states', async () => {
  const page = await pageFixture();
  try {
    await page.locator('#selected').focus();
    const result = await page.evaluate(()=>({
      public:window.designModule.extractDesignContext({target:document.querySelector('#selected')}),
      private:window.designModule.extractDesignContext({target:document.querySelector('#private')}),
      field:window.designModule.extractDesignContext({target:document.querySelector('input')}),
    }));
    assert.equal(result.public.observed.provenance,'observed'); assert.equal(result.public.observed.source,'getComputedStyle');
    assert.equal(result.public.observed.styles['background-color'],'rgb(0, 128, 0)'); assert.equal(result.public.observed.styles['border-top-left-radius'],'8px');
    assert.ok(result.public.observed.states.includes('focus')); assert.equal(result.private.observed,null); assert.equal(result.field.observed,null);
    assert.equal('component' in result.public.observed,false); assert.equal('breakpoints' in result.public,false);
  } finally { await page.close(); }
});

test('published domain and design whitelist public fields and never invent included asset files', () => {
  const domain = validateDomainContext({name:'Herdspace',purpose:'Demo',source:'docs/business.md',fictional:true,users:['Productor'],rules:['token=never-export'],password:'never-export',entities:[{name:'Animal',description:'Ficha pública'}]});
  assert.equal(domain.provenance,'declared'); assert.equal(domain.fictional,true); assert.equal('password' in domain,false); assert.doesNotMatch(JSON.stringify(domain),/never-export/);
  const design = validatePublishedDesignContext({source:'demo/tokens.css',tokens:[{name:'salvia',value:'#7f9678',category:'color'},{name:'secret',value:'url(https://example.test/private?token=secret)'}],components:[{name:'Button',description:'Acción principal',states:['focus']}],assets:[{id:'logo',description:'Marca pública',url:'https://user:pass@example.test/logo.svg?token=secret#fragment',mimeType:'image/svg+xml'},{id:'bad',description:'Privado',url:'file:///secret.png'}],cookies:'hidden'});
  assert.equal(design.tokens.length,1); assert.equal(design.provenance,'declared'); assert.equal(design.assets.length,1); assert.equal(design.assets[0].availability,'referenceOnly'); assert.equal(design.assets[0].url,'https://example.test/logo.svg'); assert.equal('cookies' in design,false);
  assert.equal(validateDomainContext({name:'Missing source',purpose:'No source'}),null);
  assert.throws(()=>pngDimensions(new Uint8Array([137,80,78,71])),error=>error.code==='BINARY_TRANSPORT_UNAVAILABLE');
});

