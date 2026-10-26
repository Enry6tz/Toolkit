import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const scratch = await mkdtemp(join(tmpdir(), 'toolkit-package-'));
console.log(`Package check scratch retained for inspection: ${scratch}`);
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this check with npm run check:package');

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const npm = (args, cwd) => run(process.execPath, [npmCli, ...args], cwd);
const packed = JSON.parse(npm(['pack', '--json', '--pack-destination', scratch]));
assert.equal(packed.length, 1);
const archive = packed[0];
assert.equal(archive.name, '@e6tz/toolkit');
assert.equal(archive.version, '0.9.4');
const files = new Set(archive.files.map(file => file.path));
for (const file of files) {
  assert.ok(file.startsWith('dist/') || ['package.json', 'README.md', 'LICENSE', 'docs/architecture.md'].includes(file), `Unexpected packed file: ${file}`);
  assert.doesNotMatch(file, /(?:^|\/)\.\.(?:\/|$)|(?:^|\/)\.env(?:\.|$)/);
}
for (const entry of Object.values(pkg.exports)) {
  assert.ok(files.has(entry.import.slice(2)), entry.import);
  assert.ok(files.has(entry.types.slice(2)), entry.types);
}
for (const file of ['cascadia-code-latin.woff2', 'Cascadia-Code-Microsoft-LICENSE.txt', 'Cascadia-Code-OFL.txt', 'Cascadia-Code-SOURCE.md']) {
  assert.ok(files.has(`dist/react/assets/${file}`), `Missing bundled font asset: ${file}`);
}

await writeFile(join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
const consumerDependencies = ['react', 'react-dom', '@types/react', '@types/react-dom', '@types/node']
  .map(name => `${name}@${lock.packages[`node_modules/${name}`].version}`);
npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(scratch, archive.filename), ...consumerDependencies], scratch);
const installed = join(scratch, 'node_modules/@e6tz/toolkit');
assert.equal(await realpath(installed), installed, 'Consumer package must be extracted, not a source symlink');
const installedPkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
assert.equal(installedPkg.license, 'MIT');
assert.equal(await readFile(join(installed, 'LICENSE'), 'utf8'), await readFile(join(root, 'LICENSE'), 'utf8'));
assert.notEqual(installedPkg.private, true);
assert.equal(installedPkg.publishConfig.access, 'public');

await writeFile(join(scratch, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { AIToolbar } from '@e6tz/toolkit/react';
import { AIToolbar as NextToolbar } from '@e6tz/toolkit/next';
import { isToolbarEnabled, createTranslator } from '@e6tz/toolkit/core';
import { createReviewEngine } from '@e6tz/toolkit/review';
assert.equal(typeof window, 'undefined');
for (const entry of ${JSON.stringify(Object.keys(pkg.exports).map(entry => entry === '.' ? pkg.name : pkg.name + entry.slice(1)))}) {
  assert.ok(Object.keys(await import(entry)).length, entry);
}
assert.equal(renderToString(createElement(AIToolbar, { environment: 'preview', defaultOpen: true })), '');
assert.equal(renderToString(createElement(NextToolbar, { defaultOpen: true })), '');
assert.equal(isToolbarEnabled({ environment: 'production', enabled: true }), false);
assert.equal(isToolbarEnabled({ environment: 'production', allowProduction: true }), true);
assert.equal(NextToolbar({ config: { enabled: { production: false } } }).props.allowProduction, false);
assert.equal(createTranslator('en')('Iniciar sesión en Toolkit'), 'Sign in to Toolkit');
const engine = createReviewEngine({ now: () => new Date('2026-10-14T12:00:00.000Z') });
assert.equal(engine.getSnapshot().session, null);
assert.equal(engine.startSession({ requestId: 'start', objective: 'Check package', actor: 'user', scope: { origin: 'https://example.test', pathname: '/' } }).status, 'ok');
assert.equal(engine.startRecording({ requestId: 'denied', authorized: false }).error.code, 'RECORDING_NOT_AUTHORIZED');
assert.equal(engine.startRecording({ requestId: 'record', authorized: true }).data.recording, 'active');
assert.equal(engine.checkpoint({ requestId: 'step', label: 'Visible page', pathname: '/' }).status, 'ok');
assert.equal(engine.endSession({ requestId: 'end' }).data.recording, 'stopped');
assert.equal(engine.getSnapshot().steps.length, 1);
console.log('All seven packed imports, SSR, Next, translations and recording lifecycle passed');
`);
process.stdout.write(run(process.execPath, ['consumer.mjs'], scratch));

await writeFile(join(scratch, 'consumer.ts'), `
import * as root from '@e6tz/toolkit';
import * as react from '@e6tz/toolkit/react';
import * as next from '@e6tz/toolkit/next';
import * as core from '@e6tz/toolkit/core';
import * as browser from '@e6tz/toolkit/browser';
import * as review from '@e6tz/toolkit/review';
import * as config from '@e6tz/toolkit/config';
const props = { environment: 'preview' } satisfies react.AIToolbarProps;
const enabled: boolean = core.isToolbarEnabled(props);
void [root.AIToolbar, react.AIToolbar, next.AIToolbar, browser.captureContext, review.createReviewEngine, config.defineConfig, enabled];
`);
await writeFile(join(scratch, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
  target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
  noEmit: true, skipLibCheck: false, lib: ['ES2022', 'DOM', 'DOM.Iterable'],
}, include: ['consumer.ts'] }));
run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(scratch, 'tsconfig.json')], scratch);

const bundle = await build({ stdin: { contents: `import * as sdk from '@e6tz/toolkit/browser'; window.toolkit = sdk;`, resolveDir: scratch }, bundle: true, write: false, format: 'iife', platform: 'browser' });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<main><aside data-ai-id="help" aria-label="Help">Public help</aside><input value="private value"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const observed = await page.evaluate(async () => {
    const sdk = window.toolkit;
    const target = sdk.inspectElement(document.querySelector('aside'));
    const context = sdk.captureContext({ build: { environment: 'preview' } });
    const handle = sdk.installAgentBridge({ window, getContext: async () => ({ schemaVersion: '1.0', context, markdown: 'reference' }) });
    const version = (await window.__AI_CONTEXT_TOOLBAR__.getContext()).schemaVersion;
    let duplicateError = '';
    try { sdk.installAgentBridge({ window, getContext: async () => ({ schemaVersion: '1.0', context, markdown: 'reference' }) }); }
    catch (error) { duplicateError = error.message; }
    handle.dispose();
    return { tag: target.tag, role: target.role, text: target.text, version, duplicateError, disposed: window.__AI_CONTEXT_TOOLBAR__ === undefined, context: JSON.stringify(context) };
  });
  assert.equal(observed.tag, 'aside');
  assert.equal(observed.role, 'complementary');
  assert.equal(observed.text, 'Public help');
  assert.equal(observed.version, '1.0');
  assert.match(observed.duplicateError, /Toolkit/);
  assert.equal(observed.disposed, true);
  assert.doesNotMatch(observed.context, /private value/);
} finally {
  await browser.close();
}
console.log(`Packed consumer passed: ${archive.files.length} files; declarations, browser isolation and font notices verified`);
