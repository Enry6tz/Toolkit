import { sanitizeAnnotations } from '../core/annotations.js';
import type { AnnotationContext } from '../core/types.js';
import { validateReviewDraft } from './persistence.js';
import { isEmptyStoppedRecording } from './recording-content.js';
import { createTranslator, dateLocale, IMPORTED_RECORDING_NOTICE, importNoticeIn } from '../core/locale.js';
import type { ToolbarLocale } from '../core/locale.js';
import type { ReviewDraft, ReviewLimits, ReviewSession, ReviewStep, ReviewEvent } from './types.js';

export const RECORDING_JSON_MAX_CHARACTERS = 8 * 1024 * 1024;
export const RECORDING_IMPORT_NOTICE = IMPORTED_RECORDING_NOTICE;
const fail = (message = 'El JSON no tiene un formato de grabación válido. Copialo desde «Copiar JSON».'): never => { throw new Error(message); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const identifier = (value: unknown): string => typeof value === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(value) ? value : fail();
const route = (value: unknown): string => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && value.length <= 2000 && !/[\\\u0000-\u001f]/.test(value) ? value : fail('Una ruta del JSON no es válida.');

/** Untrusted clipboard data becomes a new stopped recording, never an executed replay. */
export async function importRecordingJson(text: string, options: {
  origin: string; pathname: string; id: () => string; now?: Date; limits: ReviewLimits; locale?: ToolbarLocale;
}): Promise<{ draft: ReviewDraft; annotations: AnnotationContext[] }> {
  const locale = options.locale ?? 'en', t = createTranslator(locale);
  if (typeof text !== 'string' || text.length > RECORDING_JSON_MAX_CHARACTERS) fail('El JSON supera el límite de 8 millones de caracteres.');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { fail('No se pudo leer el JSON. Pegá la grabación completa desde «Copiar JSON».'); }
  const source = object(parsed);
  if (source.schemaVersion !== '1.0' && source.schemaVersion !== '1.1') fail('Versión de grabación no compatible. Usá un JSON con schemaVersion «1.0» o «1.1».');
  if (Object.keys(source).some(key => !['schemaVersion', 'session', 'steps', 'events', 'annotations', 'partial'].includes(key))) fail();
  if (!Array.isArray(source.steps) || !Array.isArray(source.events) || !Array.isArray(source.annotations)
    || source.steps.length + source.events.length > options.limits.maxEvents || source.annotations.length > 1000) fail('La grabación supera el límite de pasos, consultas o 1000 marcas.');
  const rawMarks = source.annotations as unknown[], rawSteps = source.steps as unknown[], rawEvents = source.events as unknown[];
  const session = object(source.session), scope = object(session.scope);
  if (Object.keys(scope).some(key => !['origin', 'pathname', 'targetId'].includes(key))) fail();
  try { const url = new URL(String(scope.origin)); if (!['http:', 'https:'].includes(url.protocol) || url.origin !== scope.origin) fail(); } catch { fail(); }
  route(scope.pathname);
  const at = (options.now ?? new Date()).toISOString(), sessionId = `session-${options.id()}`;
  const replacements = new Map<string, string>();
  function register(value: unknown, prefix: string): string {
    const old = identifier(value);
    if (replacements.has(old)) fail('El JSON tiene identificadores duplicados.');
    const id = `${prefix}-${options.id()}`; replacements.set(old, id); return id;
  }
  register(session.id, 'source');
  const annotations = rawMarks.map(raw => {
    const mark = object(raw), bounds = object(mark.bounds), viewport = object(mark.viewport);
    if (mark.pending === true || (mark.caseId !== undefined && mark.caseId !== session.id)
      || !['element', 'section', 'area', 'group'].includes(String(mark.kind)) || typeof mark.label !== 'string' || typeof mark.note !== 'string'
      || ![bounds.x, bounds.y, bounds.width, bounds.height, viewport.width, viewport.height].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100000)
      || Number(bounds.width) <= 0 || Number(bounds.height) <= 0 || Number(viewport.width) <= 0 || Number(viewport.height) <= 0) fail('Una marca no tiene una zona, un viewport o una descripción válidos.');
    route(mark.pathname);
    if (mark.kind === 'group' && (!Array.isArray(mark.relatedElements) || mark.relatedElements.length < 1 || !Number.isSafeInteger(mark.elementCount) || Number(mark.elementCount) < mark.relatedElements.length)) fail('Una marca no es válida.');
    const safe = sanitizeAnnotations([{ ...mark, id: register(mark.id, 'mark'), caseId: sessionId, createdAt: at, updatedAt: at }]);
    if (safe.length !== 1) fail('Una marca no es válida.');
    return safe[0]!;
  });
  // Register all IDs first so references can be resolved without relying on array order.
  for (const raw of rawSteps) register(object(raw).id, 'step');
  for (const raw of rawEvents) register(object(raw).id, 'event');
  const stepIds = new Set(rawSteps.map(raw => identifier(object(raw).id)));
  const target = (value: unknown) => replacements.get(identifier(value)) ?? register(value, 'target');
  const steps = rawSteps.map(raw => {
    const step = object(raw);
    if (step.sessionId !== session.id || !Array.isArray(step.artifactIds) || step.artifactIds.length) fail('El JSON debe contener una grabación sin archivos de imágenes.');
    return { ...step, id: replacements.get(identifier(step.id))!, sessionId, at,
      ...(step.targetId !== undefined ? { targetId: target(step.targetId) } : {}) } as unknown as ReviewStep;
  }).filter(step => step.recordingBoundary !== 'start' && step.recordingBoundary !== 'stop');
  const keptSteps = new Set(steps.map(step => step.id));
  const events = rawEvents.map(raw => {
    const event = object(raw);
    if (event.sessionId !== session.id || (event.stepId !== undefined && !stepIds.has(identifier(event.stepId)))) fail('Una consulta apunta a un paso que no existe.');
    const next = { ...event, id: replacements.get(identifier(event.id))!, sessionId, at } as unknown as ReviewEvent;
    if (event.stepId !== undefined) {
      const id = replacements.get(String(event.stepId))!;
      if (keptSteps.has(id)) next.stepId = id;
      else { delete next.stepId; delete next.correlation; }
    }
    return next;
  });
  const boundary = (kind: 'start' | 'stop'): ReviewStep => ({ id: `step-${options.id()}`, sessionId, at,
    label: t(kind === 'start' ? 'Inicio de la grabación' : 'Fin de la grabación'), pathname: route(options.pathname),
    actor: 'user', attribution: 'declared', simulated: false, artifactIds: [], notes: '', recordingBoundary: kind });
  for (const mark of annotations) if (!steps.some(step => step.targetId === mark.id)) {
    const step = boundary('start'); delete step.recordingBoundary;
    steps.push({ ...step, label: `${t('Marca')}: ${mark.label}`.slice(0, 200), pathname: mark.pathname, targetId: mark.id, notes: mark.note });
  }
  const notice = t(RECORDING_IMPORT_NOTICE);
  const rawNotes = typeof session.notes === 'string' ? session.notes : session.notes === undefined ? '' : fail();
  const notes = rawNotes.replace(importNoticeIn(rawNotes) ?? notice, '').trim();
  if (notes.length > 1800) fail('Las notas de la grabación son demasiado largas para importarlas.');
  const imported: ReviewSession = { ...session, id: sessionId, scope: { origin: options.origin, pathname: route(scope.pathname) },
    status: 'active', recording: 'stopped', startedAt: at, lastActivityAt: at, revision: 1,
    ...(typeof session.objective === 'string' && /^(Grabación|Recording) · /.test(session.objective) ? { objective: `${t('Grabación')} · ${new Date(at).toLocaleString(dateLocale(locale), { hour12: false })}` } : {}),
    notes: `${notes ? `${notes} ` : ''}${notice}` } as ReviewSession;
  delete imported.endedAt;
  const draft = await validateReviewDraft({ snapshot: { schemaVersion: '2.0', revision: 1, session: imported,
    steps: [boundary('start'), ...steps, boundary('stop')], events, findings: [], artifacts: [],
    privacy: { reviewedRevision: null }, partial: source.partial, limits: options.limits, bytesStored: 0 }, files: [] },
  { origin: options.origin, limits: options.limits, now: Date.parse(at) });
  for (const document of draft.snapshot.session?.documents?.documents ?? []) {
    const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(document.content));
    if (Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('') !== document.checksum) fail('El contenido de un documento no coincide con su checksum.');
  }
  if (isEmptyStoppedRecording(draft.snapshot)) fail('La grabación está vacía. Necesita al menos una marca, un paso o una consulta.');
  return { draft, annotations };
}
