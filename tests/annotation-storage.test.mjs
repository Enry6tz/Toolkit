import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAnnotations, saveAnnotations } from '../dist/browser/selection.js';

const legacyKey = 'ai-context:annotations:1';
function storage() {
  const entries = new Map();
  const localStorage = {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: key => { entries.delete(key); },
  };
  return { view: { localStorage }, entries };
}
function mark(caseId, index = 0) {
  const at = new Date().toISOString();
  return { id: `${caseId}-${index}`, caseId, kind: 'element', pathname: '/flights',
    createdAt: at, updatedAt: at, label: 'Buscar vuelos', note: `Nota ${caseId} ${index}`,
    bounds: { x: 0, y: 0, width: 50, height: 30 }, viewport: { width: 1360, height: 1000 },
    element: null, relatedElements: [] };
}

test('each case retains its own thirty annotations across new cases and restores', () => {
  const { view } = storage();
  const cases = ['case-a', 'case-b', 'case-c'];
  const input = cases.flatMap(id => Array.from({ length: 30 }, (_, index) => mark(id, index)));
  assert.equal(saveAnnotations(view, input), true);
  for (const id of cases) assert.deepEqual(loadAnnotations(view, id), input.filter(item => item.caseId === id));
  assert.equal(saveAnnotations(view, [mark('case-d')], 'case-d'), true);
  assert.equal(loadAnnotations(view, 'case-d').length, 1);
  for (const id of cases) assert.equal(loadAnnotations(view, id).length, 30);
});

test('scoped empty annotations prevent deleted legacy marks from returning', () => {
  const { view, entries } = storage();
  entries.set(legacyKey, JSON.stringify([mark('old-case'), mark('other-case')]));
  assert.equal(loadAnnotations(view, 'old-case').length, 1);
  assert.equal(saveAnnotations(view, [], 'old-case'), true);
  assert.deepEqual(loadAnnotations(view, 'old-case'), []);
  assert.equal(loadAnnotations(view, 'other-case').length, 1);
  assert.equal(JSON.parse(entries.get(legacyKey)).length, 2);
});

test('failed annotation writes report failure and preserve the previous saved case', () => {
  const { view, entries } = storage();
  assert.equal(saveAnnotations(view, [mark('case-a')], 'case-a'), true);
  const before = new Map(entries);
  view.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(saveAnnotations(view, [{ ...mark('case-a'), note: 'Unsaved change' }], 'case-a'), false);
  assert.deepEqual(entries, before);
  assert.equal(loadAnnotations(view, 'case-a')[0].note, 'Nota case-a 0');
});

test('a recording retains over thirty marks from multiple routes without silently cutting them', () => {
  const { view } = storage();
  const marks = Array.from({ length: 130 }, (_, index) => ({ ...mark('recording', index),
    pathname: index % 2 ? '/flights' : '/passengers', note: 'Observación '.repeat(100).trim() }));
  assert.equal(saveAnnotations(view, marks, 'recording'), true);
  assert.deepEqual(loadAnnotations(view, 'recording'), marks);
});

test('an oversized draft reports a warning instead of claiming a successful restore', () => {
  const { view, entries } = storage();
  entries.set(`${legacyKey}:recording`, ' '.repeat(4 * 1024 * 1024 + 1));
  const warnings = [];
  assert.deepEqual(loadAnnotations(view, 'recording', message => warnings.push(message)), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /supera el tamaño/);
});
