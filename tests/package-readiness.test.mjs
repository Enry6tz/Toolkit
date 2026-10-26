import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const json = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));

test('package metadata enables the approved public identity without changing compatibility ranges', async () => {
  const pkg = await json('package.json');
  const lock = await json('package-lock.json');
  assert.equal(pkg.name, '@e6tz/toolkit');
  assert.notEqual(pkg.private, true);
  assert.equal(pkg.publishConfig?.access, 'public');
  assert.equal(pkg.version, '0.9.4');
  assert.equal(pkg.license, 'MIT');
  assert.equal(lock.packages[''].license, 'MIT');
  const license = await readFile(new URL('LICENSE', root), 'utf8');
  assert.match(license, /^MIT License\r?$/m);
  assert.match(license, /Copyright \(c\) 2026 Enry6tz/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
  assert.doesNotMatch(await readFile(new URL('README.md', root), 'utf8'), /UNLICENSED/);
  assert.equal(pkg.engines.node, '>=20.9');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.deepEqual(Object.keys(pkg.exports), ['.', './react', './core', './browser', './review', './config', './next']);
});

test('product branding is absent while semantic HTML remains intact', async () => {
  async function scan(directory) {
    for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
      const path = `${directory}${entry.name}`;
      if (entry.isDirectory()) await scan(`${path}/`);
      else if (/\.(?:tsx?|md|json|mjs)$/.test(entry.name)) {
        const lines = (await readFile(new URL(path, root), 'utf8')).split('\n');
        lines.forEach((line, index) => {
          if (!/a[s]ide/i.test(line)) return;
          const semantic = path === 'src/browser/context.ts' && line.includes("aside: 'complementary'")
            || path === 'src/browser/selection.ts' && line.includes('nav, aside, main');
          assert.ok(semantic, `Unexpected product branding at ${path}:${index + 1}`);
        });
      }
    }
  }
  await scan('src/');
  for (const path of ['package.json', 'README.md', 'docs/architecture.md']) {
    assert.doesNotMatch(await readFile(new URL(path, root), 'utf8'), /a[s]ide/i);
  }
  assert.match(await readFile(new URL('src/browser/context.ts', root), 'utf8'), /aside: 'complementary'/);
  assert.match(await readFile(new URL('src/browser/selection.ts', root), 'utf8'), /nav, aside, main/);
});

test('CI runs the full browser-backed suite, types and packed consumer without publishing', async () => {
  const workflow = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
  for (const step of ['push:', 'pull_request:', 'contents: read', 'npm ci', 'npm run typecheck', 'npm test', 'npm run check:package', 'playwright install --with-deps chromium']) {
    assert.ok(workflow.includes(step), step);
  }
  assert.match(workflow, /node: \[22, 24\]/);
  assert.doesNotMatch(workflow, /npm publish|NODE_AUTH_TOKEN|id-token: write|contents: write/);
});
