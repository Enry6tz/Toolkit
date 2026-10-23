import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslator, resolveLocale, localizeSystemNote, IMPORTED_RECORDING_NOTICE } from '../dist/core/locale.js';
import { defineConfig } from '../dist/config/index.js';
import { AIToolbar } from '../dist/next/index.js';
import { createReviewEngine } from '../dist/review/session.js';

test('automatic navigation labels follow the current configured language without restarting a recording', () => {
  let locale = 'en';
  const engine = createReviewEngine({ locale: () => locale });
  const scope = { origin: 'https://example.test', pathname: '/' };
  engine.updateLocation(scope);
  engine.startSession({ requestId: 'session', objective: 'Recording', scope });
  engine.startRecording({ requestId: 'start', authorized: true });
  const id = engine.getSnapshot().session.id;
  engine.updateLocation({ ...scope, pathname: '/orders' });
  assert.equal(engine.getSnapshot().steps.at(-1).label, 'Navigated to /orders');
  locale = 'es';
  engine.updateLocation({ ...scope, pathname: '/orders/42' });
  assert.equal(engine.getSnapshot().steps.at(-1).label, 'Navegó a /orders/42');
  assert.equal(engine.getSnapshot().session.id, id);
});

test('English is the default; configuration supports only English and Spanish, with explicit props taking precedence', () => {
  assert.equal(resolveLocale(undefined), 'en'); assert.equal(resolveLocale('es'), 'es');
  assert.equal(createTranslator()('Comenzar grabación'), 'Start recording');
  assert.equal(createTranslator('es')('Comenzar grabación'), 'Comenzar grabación');
  assert.deepEqual(defineConfig({ locale: 'es' }), { locale: 'es' });
  assert.throws(() => defineConfig({ locale: 'fr' }), /locale/);
  assert.equal(AIToolbar({}).props.locale, 'en');
  assert.equal(AIToolbar({ config: { locale: 'es' } }).props.locale, 'es');
  assert.equal(AIToolbar({ config: { locale: 'es' }, locale: 'en' }).props.locale, 'en');
});

test('localized product copy interpolates counts and preserves caller-provided labels and notes', () => {
  const en = createTranslator(), es = createTranslator('es');
  assert.equal(en('{count} marcas', { count: 1 }), '1 mark');
  assert.equal(es('{count} marcas', { count: 2 }), '2 marcas');
  assert.equal(en('Copiar {label}', { label: 'Reglas del rodeo' }), 'Copy Reglas del rodeo');
  assert.equal(en('Esta tabla debería mostrar las vacas en observación.'), 'Esta tabla debería mostrar las vacas en observación.');
  const englishNotice = localizeSystemNote(IMPORTED_RECORDING_NOTICE, 'en');
  assert.match(englishNotice, /Imported from JSON/);
  assert.equal(localizeSystemNote(englishNotice, 'es'), IMPORTED_RECORDING_NOTICE);
  assert.equal(localizeSystemNote('Una nota escrita por la persona.', 'en'), 'Una nota escrita por la persona.');
});
