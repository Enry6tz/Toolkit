import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWikiLinks, validateRuntimeConfig, documentMatchesRoute } from '../dist/core/index.js';
import { defineConfig } from '../dist/config/index.js';

test('wiki references are optional and can be general or scoped to application routes', () => {
  assert.equal(validateWikiLinks(undefined), undefined);
  const wiki = validateWikiLinks({ url: 'http://localhost:3500/link/1', documents: [
    { label: 'Domain', url: 'http://localhost:3500/link/2' },
    { label: 'Flights', url: 'http://localhost:3500/link/3', routes: ['/passenger/**'] },
  ] });
  assert.equal(wiki.documents.filter(link => documentMatchesRoute(link, '/passenger/flights')).length, 2);
  assert.equal(wiki.documents.filter(link => documentMatchesRoute(link, '/admin')).length, 1);
  assert.equal(defineConfig({ wiki }).wiki.url, wiki.url);
  assert.equal(defineConfig({ context: { documents: [] } }).wiki, undefined);
});

test('runtime settings accept only bounded data and cannot modify executable toolbar options', () => {
  const config = { locale: 'es', maxBodyChars: 12000, recordNetwork: false, wiki: null };
  assert.deepEqual(validateRuntimeConfig({ ...config, enabled: true, script: 'x' }), config);
  for (const override of [{ locale: 'fr' }, { maxBodyChars: 0 }, { maxBodyChars: 64001 }, { maxBodyChars: 1.5 }, { recordNetwork: 'true' }, { wiki: undefined }, { wiki: { url: 'javascript:alert(1)' } }])
    assert.throws(() => validateRuntimeConfig({ ...config, ...override }));
});

test('wiki references cannot execute scripts, embed credentials, leave the wiki origin or duplicate links', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', '//wiki.example.com', 'https://user:secret@wiki.example.com', 'https://wiki.example.com/\nsecret']) {
    assert.throws(() => validateWikiLinks({ url }));
  }
  assert.throws(() => defineConfig({ wiki: { url: 'https://wiki.example.com', documents: [{ label: 'Other', url: 'https://other.example.com/a' }] } }));
  assert.throws(() => validateWikiLinks({ url: 'https://wiki.example.com', documents: [{ label: 'A', url: 'https://wiki.example.com/a' }, { label: 'B', url: 'https://wiki.example.com/a' }] }));
  assert.throws(() => validateWikiLinks({ url: 'https://wiki.example.com', documents: [{ label: 'A', url: 'https://wiki.example.com/a', routes: ['/admin?secret=x'] }] }));
});
