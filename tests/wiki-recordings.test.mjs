import test from 'node:test';
import assert from 'node:assert/strict';
import { WikiRecordingError, listWikiRecordings, readWikiRecording } from '../dist/browser/wiki-recordings.js';

const manageUrl = 'https://aside.example/toolkit/toolbar/projects/project-b';
const id = '77eb0d6e-5971-4d0a-8c1e-da70e524fc7a';
const entry = { id, title: 'Recording-77eb0d6e', author: 'Test Author', updatedAt: '2026-10-19T12:00:00.123456Z' };
const signal = () => new AbortController().signal;
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const isCode = code => error => error instanceof WikiRecordingError && error.code === code;
function fake(response) {
  const calls = [];
  const view = { fetch(url, init) { assert.equal(this, view); calls.push({ url, init }); return Promise.resolve(typeof response === 'function' ? response(url, init) : response); } };
  return { view, calls };
}
function streamed(chunks, headers = {}) {
  let cancelled = false;
  return {
    response: new Response(new ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'application/json', ...headers } }),
    get cancelled() { return cancelled; },
  };
}

test('lists only the configured project with session cookies and abortable uncached JSON requests', async () => {
  const { view, calls } = fake(json({ recordings: [{ ...entry, url: 'https://evil.example/x', secret: 'ignored', canDelete: true }] }));
  const abort = signal();
  assert.deepEqual(await listWikiRecordings(view, `${manageUrl}/`, abort), [entry]);
  assert.deepEqual(calls, [{ url: `${manageUrl}/recordings`, init: {
    credentials: 'include', cache: 'no-store', redirect: 'error', signal: abort, headers: { Accept: 'application/json' },
  } }]);
});

test('accepts an empty list and nullable deleted authors', async () => {
  assert.deepEqual(await listWikiRecordings(fake(json({ recordings: [] })).view, manageUrl, signal()), []);
  assert.equal((await listWikiRecordings(fake(json({ recordings: [{ ...entry, author: null }] })).view, manageUrl, signal()))[0].author, null);
});

test('measures titles and author names by Unicode characters, matching the wiki limits', async () => {
  const unicode = { ...entry, title: '🎯'.repeat(300), author: '😀'.repeat(255) };
  assert.deepEqual(await listWikiRecordings(fake(json({ recordings: [unicode] })).view, manageUrl, signal()), [unicode]);
  for (const item of [{ ...unicode, title: '🎯'.repeat(301) }, { ...unicode, author: '😀'.repeat(256) }]) {
    await assert.rejects(listWikiRecordings(fake(json({ recordings: [item] })).view, manageUrl, signal()), isCode('invalid'));
  }
});

test('rejects unscoped or malformed management URLs before fetching', async () => {
  for (const url of [
    '/toolkit/toolbar/projects/project-b', '//aside.example/toolkit/toolbar/projects/project-b',
    'javascript:alert(1)', manageUrl + '?x=1', manageUrl + '?', manageUrl + '#', manageUrl + '#fragment',
    manageUrl + '/recordings', manageUrl.replace('/project-b', '/..%2fproject-b'), manageUrl.replace('/project-b', '/else/../project-b'),
    manageUrl.replace('https://', 'https:/'), manageUrl.replace('aside.example', 'user:password@aside.example'),
    manageUrl + '\\', manageUrl + ' ', manageUrl + '\n',
  ]) {
    const { view, calls } = fake(json({ recordings: [] }));
    await assert.rejects(listWikiRecordings(view, url, signal()), isCode('invalid'), url);
    assert.equal(calls.length, 0);
  }
});

test('maps session and project access errors without returning server error bodies', async () => {
  for (const [status, code] of [[401, 'auth'], [403, 'forbidden'], [404, 'unavailable'], [500, 'unavailable']]) {
    await assert.rejects(listWikiRecordings(fake(new Response('private server message', { status })).view, manageUrl, signal()), isCode(code));
    await assert.rejects(readWikiRecording(fake(new Response('private server message', { status })).view, manageUrl, id, signal()), isCode(code));
  }
  const { view } = fake(() => { throw new TypeError('network or redirect failed'); });
  await assert.rejects(listWikiRecordings(view, manageUrl, signal()), isCode('unavailable'));
});

test('validates every list field, calendar timestamps, unique IDs and the list count', async () => {
  const invalidEntries = [
    null, [], { ...entry, id: '../other-project' }, { ...entry, title: '' }, { ...entry, title: 'x'.repeat(301) },
    { ...entry, title: 'line\nbreak' }, { ...entry, author: undefined }, { ...entry, author: 'x'.repeat(256) },
    { ...entry, updatedAt: 'yesterday' }, { ...entry, updatedAt: '2026-02-30T12:00:00Z' }, { ...entry, updatedAt: '2026-10-19T24:00:00Z' },
  ];
  for (const item of invalidEntries) await assert.rejects(listWikiRecordings(fake(json({ recordings: [item] })).view, manageUrl, signal()), isCode('invalid'));
  for (const value of [null, [], {}, { recordings: {} }, { recordings: [entry, { ...entry, id: id.toUpperCase() }] }, { recordings: Array.from({ length: 201 }, () => entry) }]) {
    await assert.rejects(listWikiRecordings(fake(json(value)).view, manageUrl, signal()), isCode('invalid'));
  }
});

test('reads raw JSON only from the configured project and UUID, preserving the original content', async () => {
  const source = '{\n  "schemaVersion": "1.1", "steps": [], "annotations": []\n}';
  const { view, calls } = fake(new Response(source, { headers: { 'Content-Type': 'application/json' } }));
  assert.equal(await readWikiRecording(view, manageUrl, id, signal()), source);
  assert.equal(calls[0].url, `${manageUrl}/recordings/${id}`);
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].init.redirect, 'error');
  for (const badId of ['../x', '', `${id}?other=1`, `${id}/other`, 'not-a-uuid']) {
    const invalid = fake(json({}));
    await assert.rejects(readWikiRecording(invalid.view, manageUrl, badId, signal()), isCode('invalid'));
    assert.equal(invalid.calls.length, 0);
  }
});

test('rejects HTML login responses, empty streams, malformed JSON and nonobject recording roots', async () => {
  for (const make of [
    () => new Response('<html>Login</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response(null, { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('{"broken":', { headers: { 'Content-Type': 'application/json' } }),
    () => json(null), () => json([]), () => json('text'),
  ]) await assert.rejects(readWikiRecording(fake(make()).view, manageUrl, id, signal()), isCode('invalid'));
});

test('enforces byte limits from content length before reading and cancels the stream', async () => {
  for (const [limit, read] of [[512 * 1024, (view, abort) => listWikiRecordings(view, manageUrl, abort)], [2 * 1024 * 1024, (view, abort) => readWikiRecording(view, manageUrl, id, abort)]]) {
    const stream = streamed([], { 'Content-Length': String(limit + 1) });
    await assert.rejects(read(fake(stream.response).view, signal()), isCode('too-large'));
    assert.equal(stream.cancelled, true);
  }
});

test('counts streamed bytes even without content length and stops at the list and recording limits', async () => {
  for (const [limit, read] of [[512 * 1024, (view, abort) => listWikiRecordings(view, manageUrl, abort)], [2 * 1024 * 1024, (view, abort) => readWikiRecording(view, manageUrl, id, abort)]]) {
    const stream = streamed([new Uint8Array(limit), new Uint8Array([1])], { 'Content-Length': '1' });
    await assert.rejects(read(fake(stream.response).view, signal()), isCode('too-large'));
    assert.equal(stream.cancelled, true);
  }
});

test('decodes split multibyte UTF-8 chunks and rejects invalid UTF-8', async () => {
  const source = JSON.stringify({ recordings: [{ ...entry, title: 'Grabación á' }] });
  const bytes = new TextEncoder().encode(source);
  const split = bytes.indexOf(0xc3) + 1;
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close();
  } }), { headers: { 'Content-Type': 'application/json' } });
  assert.equal((await listWikiRecordings(fake(response).view, manageUrl, signal()))[0].title, 'Grabación á');
  const invalid = new Response(new Uint8Array([123, 34, 120, 34, 58, 34, 0xff, 34, 125]), { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(readWikiRecording(fake(invalid).view, manageUrl, id, signal()), isCode('invalid'));
});

test('allows a recording exactly at the byte limit', async () => {
  const source = `{"padding":"${'x'.repeat(2 * 1024 * 1024 - 14)}"}`;
  assert.equal(new TextEncoder().encode(source).length, 2 * 1024 * 1024);
  const response = new Response(source, { headers: { 'Content-Type': 'application/json' } });
  assert.equal((await readWikiRecording(fake(response).view, manageUrl, id, signal())).length, source.length);
});

test('preserves cancellation before fetch and while a response stream is pending', async () => {
  const before = new AbortController(); before.abort();
  const untouched = fake(json({ recordings: [] }));
  await assert.rejects(listWikiRecordings(untouched.view, manageUrl, before.signal), { name: 'AbortError' });
  assert.equal(untouched.calls.length, 0);
  const during = new AbortController();
  const stream = streamed([]);
  const pending = readWikiRecording(fake(stream.response).view, manageUrl, id, during.signal);
  await new Promise(resolve => setImmediate(resolve));
  during.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(stream.cancelled, true);
});
