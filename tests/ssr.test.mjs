import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

test('all package entry points import in Node without browser globals', async () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof document, 'undefined');

  for (const entry of [
    'ai-context-toolbar',
    'ai-context-toolbar/react',
    'ai-context-toolbar/core',
    'ai-context-toolbar/next',
    'ai-context-toolbar/config',
    'ai-context-toolbar/review',
  ]) {
    const exported = await import(entry);
    assert.ok(Object.keys(exported).length > 0, `${entry} exposes its public API`);
  }
});

test('React toolbar renders no DOM on the server, including defaultOpen', async () => {
  const { AIToolbar } = await import('ai-context-toolbar/react');
  for (const props of [
    { environment: 'development', defaultOpen: true },
    { environment: 'preview', branch: 'sprint-1', branches: ['sprint-1'] },
    { environment: 'production', enabled: true },
    { environment: 'production', enabled: true, allowProduction: true },
  ]) {
    assert.equal(renderToString(createElement(AIToolbar, props)), '');
  }
});

test('Next server adapter can render safely without a browser', async () => {
  const { AIToolbar } = await import('ai-context-toolbar/next');
  assert.equal(renderToString(createElement(AIToolbar, { defaultOpen: true })), '');
  assert.equal(renderToString(createElement(AIToolbar, {
    environment: 'production', enabled: true, allowProduction: false,
  })), '');
});

test('Next adapter applies server config flags while explicit props take precedence', async () => {
  const { AIToolbar } = await import('ai-context-toolbar/next');
  const { isToolbarEnabled } = await import('ai-context-toolbar/core');
  const hidden = AIToolbar({ environment: 'production', config: { enabled: { production: false } } });
  assert.equal(hidden.props.environment, 'production');
  assert.equal(hidden.props.enabled, false);
  assert.equal(hidden.props.allowProduction, false);
  assert.equal(isToolbarEnabled(hidden.props), false);
  assert.equal('config' in hidden.props, false, 'server config does not cross the client boundary');

  const optedIn = AIToolbar({ environment: 'production', config: { enabled: { production: true } } });
  assert.equal(optedIn.props.enabled, true);
  assert.equal(optedIn.props.allowProduction, true);
  assert.equal(isToolbarEnabled(optedIn.props), true);

  const explicit = AIToolbar({
    environment: 'production', config: { enabled: { production: true } }, allowProduction: false,
  });
  assert.equal(isToolbarEnabled(explicit.props), false);
  const preview = AIToolbar({ environment: 'preview', config: { enabled: { preview: false } }, enabled: true });
  assert.equal(isToolbarEnabled(preview.props), true);
});

test('published React entry preserves the Next.js client boundary', async () => {
  const source = await readFile(new URL('../dist/react/index.js', import.meta.url), 'utf8');
  assert.match(source.trimStart(), /^['"]use client['"];?/);
});

test('Next adapter forwards only the configured document route and respects its explicit override', async () => {
  const { AIToolbar } = await import('ai-context-toolbar/next');
  const configured = AIToolbar({ config: { documentsPath: '/project/docs' } });
  assert.equal(configured.props.documentsPath, '/project/docs');
  assert.equal('config' in configured.props, false);
  assert.equal(AIToolbar({ config: { documentsPath: '/project/docs' }, documentsPath: '/help/docs' }).props.documentsPath, '/help/docs');
});
