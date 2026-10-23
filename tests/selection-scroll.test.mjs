import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';

test('selector and notes follow window and nested scrolling without leaking clipped or missing targets', async () => {
  const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {AIToolbar} from './src/react/index.ts'; createRoot(document.querySelector('#toolbar')).render(React.createElement(AIToolbar,{environment:'development',appName:'Scroll fixture',activity:{recordNetwork:false,resources:[]}}));`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'esm', jsx: 'automatic' });
  const server = createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle.outputFiles[0].contents); return; }
    res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><style>body{margin:0;font:16px system-ui;background:#faf9f5}main{padding:70px 80px;width:750px}section{padding:20px;background:white;border:1px solid #ddd;margin-bottom:30px}button{padding:12px}#scroller{height:200px;overflow:auto;border:2px solid #aaa}#scroller p{margin:0;height:70px;padding:10px}#bottom{height:1200px}.sticky{position:sticky;top:0}</style><main><h1>Selection and scrolling</h1><section aria-label="Delivery"><h2>Delivery details</h2><button data-ai-id="delivery">Check delivery</button></section><section aria-label="Queue"><h2>Queue</h2><div id="scroller"><p data-ai-id="row-one">First queued item</p><p data-ai-id="row-two">Second queued item</p><p data-ai-id="row-three">Third queued item</p><p>Fourth queued item</p><p>Fifth queued item</p></div></section><section class="sticky" aria-label="Pinned"><button data-ai-id="sticky">Pinned action</button></section><div id="bottom"></div></main><div id="toolbar"></div><script type="module" src="/app.js"></script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const region = page.locator('.annotation-region'), editor = page.locator('.selection-actions');
  async function sameBox(overlay, target) {
    await expect.poll(async () => { const a = await overlay.boundingBox(), b = await target.boundingBox(); return a && b ? Math.abs(a.y - b.y) + Math.abs(a.x - b.x) : 9999; }).toBeLessThan(2);
  }
  async function mark(target, note) {
    await page.getByRole('button', {name:'Select',exact:true}).click(); await target.click();
    await page.getByRole('textbox',{name:'Your feedback',exact:true}).fill(note);
  }
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByRole('button',{name:'Start recording',exact:true}).hover(); await page.getByRole('button',{name:'Pin tools',exact:true}).click();
    await page.getByRole('button',{name:'Start recording',exact:true}).click();
    const delivery = page.locator('[data-ai-id="delivery"]');
    await mark(delivery,'Keep this action with its section.');
    const before = await editor.boundingBox();
    await page.mouse.move(700,350); await page.mouse.wheel(0,100);
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(100);
    await sameBox(region, delivery);
    await expect.poll(async () => Math.abs((await editor.boundingBox()).y - (before.y - 100))).toBeLessThan(2);
    await expect(page.getByRole('textbox',{name:'Your feedback'})).toBeFocused();
    await page.getByRole('textbox',{name:'Your feedback'}).press('Enter');
    await page.getByRole('button',{name:'Exit selection',exact:true}).click();
    await page.evaluate(() => scrollTo(0,0));
    await mark(page.locator('[data-ai-id="row-one"]'),'This row can scroll out of view.');
    const rowEditor = await editor.boundingBox();
    await page.locator('#scroller').evaluate(node => node.scrollTop = 10);
    await expect.poll(async () => Math.abs((await editor.boundingBox()).y - (rowEditor.y - 10))).toBeLessThan(2);
    await expect(page.getByRole('textbox',{name:'Your feedback'})).toBeFocused();
    await page.getByRole('textbox',{name:'Your feedback'}).press('Enter');
    await page.getByRole('button',{name:'Exit selection',exact:true}).click();
    await page.locator('#scroller').evaluate(node => node.scrollTop = 35);
    const clipped = region.nth(1);
    await expect.poll(async () => (await clipped.boundingBox())?.height).toBe(55);
    await page.locator('#scroller').evaluate(node => node.scrollTop = 150);
    await expect(region).toHaveCount(1); // No ghost frame/pin/comment above the scroller.
    await expect(page.locator('.annotation-comment')).toHaveCount(1);
    await page.getByRole('button',{name:'Select',exact:true}).click();
    await delivery.hover(); await sameBox(page.locator('.highlight'), delivery);
    await page.keyboard.down('Shift'); await sameBox(page.locator('.highlight'), page.locator('section[aria-label="Delivery"]'));
    await page.keyboard.up('Shift'); await sameBox(page.locator('.highlight'), delivery);
    // A wheel moves content under a stationary pointer: the preview must re-hit-test.
    const box = await delivery.boundingBox(); await page.mouse.move(box.x+10,box.y+10); await page.mouse.wheel(0,120);
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(120);
    await expect.poll(async () => (await page.locator('.highlight').boundingBox())?.y).not.toBe(box.y);
    await page.getByRole('button',{name:'Exit selection',exact:true}).click();
    await page.evaluate(() => scrollTo(0,0));
    // Multi-select previews the actual members, not just an arbitrary rectangle.
    await page.getByRole('button',{name:'Select',exact:true}).click();
    const section = await page.locator('section[aria-label="Delivery"]').boundingBox();
    await page.mouse.move(section.x+4,section.y+4); await page.mouse.down(); await page.mouse.move(section.x+section.width-4,section.y+section.height-4,{steps:12});
    await expect(page.locator('.selection-member')).toHaveCount(2);
    await mkdir('artifacts/scroll-selection-proof',{recursive:true});
    await page.screenshot({path:'artifacts/scroll-selection-proof/group-preview.png'});
    await page.mouse.up(); await expect(editor).toBeVisible();
    await page.getByRole('textbox',{name:'Your feedback'}).fill('These elements belong together.'); await page.getByRole('textbox',{name:'Your feedback'}).press('Enter');
    await page.getByRole('button',{name:'Exit selection',exact:true}).click();
    await expect(page.locator('.annotation-region[data-group-member]')).toHaveCount(2);
    await page.locator('[data-ai-id="delivery"]').evaluate(node=>node.remove());
    await expect(page.locator('.annotation-region[data-group-member]')).toHaveCount(1);
    await expect(page.locator('.annotation-region[data-position="historical"]')).toHaveCount(0);
    await mark(page.locator('[data-ai-id="sticky"]'),'This follows the sticky action.');
    await page.getByRole('textbox',{name:'Your feedback'}).press('Enter');
    await page.getByRole('button',{name:'Exit selection',exact:true}).click();
    await page.evaluate(() => scrollTo(0,950));
    await sameBox(region.last(), page.locator('[data-ai-id="sticky"]'));
    await page.evaluate(() => scrollTo(0,0));
    await page.screenshot({path:'artifacts/scroll-selection-proof/desktop.png'});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:'artifacts/scroll-selection-proof/mobile.png'});
    assert.equal(await page.locator('[data-ai-toolbar-host]').evaluate(node=>node.getBoundingClientRect().width),0);
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
});

