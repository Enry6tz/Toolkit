import { normalizeActivityMethod, sanitizeActivityLabel, sanitizeActivityBody } from '../core/activity.js';
import { sanitizePathname } from '../core/privacy.js';
import { sanitizeRecordedContext } from '../core/recorded-context.js';
import { validateKnowledgeBundle } from '../core/knowledge.js';
import type { ReviewDraft, ReviewDraftOperationOptions, ReviewLimits } from './types.js';
import { recordingSteps } from './recording-view.js';
import { isEmptyStoppedRecording } from './recording-content.js';

export const REVIEW_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REVIEW_DRAFT_MAX_BYTES = 50 * 1024 * 1024;
const DATABASE = 'ai-context-toolbar-review-drafts';
const STORE = 'reviews';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const FAILURE_NOTICE = 'Hay capturas fallidas o ausentes.';
type PersistenceCode = 'PERSISTENCE_UNAVAILABLE' | 'PERSISTENCE_ABORTED' | 'PERSISTENCE_QUOTA'
  | 'INVALID_DRAFT' | 'EXPIRED_DRAFT' | 'DRAFT_LIMIT_REACHED' | 'DRAFT_DELETED';
export class ReviewPersistenceError extends Error {
  constructor(readonly code: PersistenceCode, message: string) { super(message); this.name = 'ReviewPersistenceError'; }
}
function invalid(message = 'El borrador local no tiene una estructura de revisión válida.'): never {
  throw new ReviewPersistenceError('INVALID_DRAFT', message);
}
function current(options: ReviewDraftOperationOptions): void {
  if (options.signal?.aborted || options.isCurrent?.() === false)
    throw new ReviewPersistenceError('PERSISTENCE_ABORTED', 'La recuperación o el guardado local fue cancelado.');
}
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
}
function identifier(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function text(value: unknown, max = 4000): value is string {
  return typeof value === 'string' && value.length <= max && sanitizeActivityLabel(value, max) === value
    && !/\b[a-z]:[\\/]|(?:^|\s)(?:\\\\|\/(?:Users|home|tmp|var|mnt)\/)/i.test(value);
}
function path(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2000 && value.startsWith('/') && !value.startsWith('//')
    && !/[\\\u0000-\u001f]/.test(value) && sanitizePathname(value) === value;
}
function date(value: unknown): number {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\dT/.test(value)) invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) invalid();
  return parsed;
}
function strings(value: unknown, max: number, validate: (value: unknown) => boolean): unknown[] {
  if (!Array.isArray(value) || value.length > max || !value.every(validate)) invalid();
  return value;
}
function ids(value: unknown, max: number, existing: Set<string>): string[] {
  const list = strings(value, max, item => identifier(item) && existing.has(item)) as string[];
  if (new Set(list).size !== list.length) invalid();
  return list;
}
function who(value: Record<string, unknown>): void {
  if (!['user', 'agent', 'unknown'].includes(String(value.actor))
    || !['declared', 'verified', 'unknown'].includes(String(value.attribution))) invalid();
  // Durable data is not proof of caller identity.
  value.attribution = value.actor === 'unknown' ? 'unknown' : 'declared';
}
function signature(bytes: Uint8Array, mime: string): boolean {
  if (mime === 'image/png') return bytes.length >= 33 && [137,80,78,71,13,10,26,10].every((n, i) => bytes[i] === n)
    && String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR';
  if (mime === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  return mime === 'image/webp' && bytes.length >= 16 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
}
function checkBinaryBudget(input: unknown): void {
  const source = object(input, ['snapshot', 'files', 'excludedStatuses']);
  const snapshot = source.snapshot as { events?: Array<{ requestBody?: { text?: unknown }; responseBody?: { text?: unknown } }> } | undefined;
  if (Array.isArray(snapshot?.events)) {
    if (snapshot.events.length > 10000) invalid();
    let characters = 0;
    for (const event of snapshot.events) for (const value of [event?.requestBody?.text, event?.responseBody?.text]) {
      if (typeof value === 'string') characters += value.length;
      if (characters > 2_000_000) throw new ReviewPersistenceError('DRAFT_LIMIT_REACHED', 'Las consultas superan el límite de dos millones de caracteres por grabación.');
    }
  }
  if (!Array.isArray(source.files) || source.files.length > 1000) invalid();
  let bytes = 0;
  for (const item of source.files) {
    if (!item || typeof item !== 'object') invalid();
    const file = item as { bytes?: unknown };
    if (!(file.bytes instanceof Uint8Array)) invalid();
    bytes += file.bytes.byteLength;
    if (bytes > REVIEW_DRAFT_MAX_BYTES) throw new ReviewPersistenceError('DRAFT_LIMIT_REACHED', 'El borrador supera el límite de 50 MiB.');
  }
}
export interface ValidateReviewDraftOptions extends ReviewDraftOperationOptions {
  limits?: ReviewLimits;
  now?: number;
  origin?: string;
}
/** Copies and validates every persisted field and actual binary before it can enter an engine. */
export async function validateReviewDraft(input: unknown, options: ValidateReviewDraftOptions = {}): Promise<ReviewDraft> {
  current(options);
  // Reject oversized inputs before structuredClone can duplicate their binary allocation.
  checkBinaryBudget(input);
  let draft: ReviewDraft;
  try { draft = structuredClone(input) as ReviewDraft; } catch { invalid(); }
  object(draft, ['snapshot', 'files', 'excludedStatuses']);
  const snapshot = object(draft.snapshot, ['schemaVersion', 'revision', 'session', 'case', 'steps', 'events', 'findings', 'artifacts', 'privacy', 'partial', 'limits', 'bytesStored']);
  if (snapshot.schemaVersion !== '2.0' || !integer(snapshot.revision, Number.MAX_SAFE_INTEGER - 1) || !integer(snapshot.bytesStored)) invalid();
  const storedLimits = object(snapshot.limits, ['maxEvents', 'maxImages', 'maxBytes']);
  if (!integer(storedLimits.maxEvents, 10000) || !integer(storedLimits.maxImages, 1000)
    || !integer(storedLimits.maxBytes, 1024 * 1024 * 1024) || !storedLimits.maxEvents || !storedLimits.maxImages || !storedLimits.maxBytes) invalid();
  const limits = {
    maxEvents: Math.min(options.limits?.maxEvents ?? 10000, Number(storedLimits.maxEvents)),
    maxImages: Math.min(options.limits?.maxImages ?? 1000, Number(storedLimits.maxImages)),
    maxBytes: Math.min(options.limits?.maxBytes ?? REVIEW_DRAFT_MAX_BYTES, Number(storedLimits.maxBytes), REVIEW_DRAFT_MAX_BYTES),
  };
  const session = object(snapshot.session, ['id', 'objective', 'notes', 'networkRecording', 'scope', 'actor', 'attribution', 'status', 'recording', 'startedAt', 'lastActivityAt', 'endedAt', 'revision', 'context', 'documents']);
  if (session.documents !== undefined) { try { session.documents = validateKnowledgeBundle(session.documents as import('../core/types.js').KnowledgeBundle); } catch { invalid('La documentación de la grabación no es válida.'); } }
  const observation = (value: { context?: unknown }) => { if (value.context === undefined) return; const context = sanitizeRecordedContext(value.context); if (!context) invalid('El contexto de origen no es válido.'); value.context = context; };
  observation(session);
  const scope = object(session.scope, ['origin', 'pathname', 'targetId']);
  let origin: string;
  try { const url = new URL(String(scope.origin)); origin = url.origin; if (!['http:', 'https:'].includes(url.protocol) || origin !== scope.origin) invalid(); }
  catch { invalid(); }
  if (options.origin !== undefined && origin !== options.origin) invalid('El borrador pertenece a otro origen.');
  if (!identifier(session.id) || !text(session.objective, 1000) || !session.objective || !path(scope.pathname)
    || (scope.targetId !== undefined && !identifier(scope.targetId)) || session.revision !== snapshot.revision
    || !['active', 'ended'].includes(String(session.status)) || !['off', 'active', 'stopped'].includes(String(session.recording))) invalid();
  if (session.notes !== undefined && !text(session.notes, 4000)) invalid();
  if (session.networkRecording !== undefined && typeof session.networkRecording !== 'boolean') invalid();
  who(session);
  const now = options.now ?? Date.now(), started = date(session.startedAt), last = date(session.lastActivityAt);
  if (started > last || last > now + 5000) invalid();
  if (now - last > REVIEW_DRAFT_TTL_MS) throw new ReviewPersistenceError('EXPIRED_DRAFT', 'El borrador local venció después de siete días sin cambios.');
  if (session.endedAt !== undefined && (date(session.endedAt) < started || date(session.endedAt) > now + 5000)) invalid();
  if (draft.snapshot.case !== undefined) {
    const reviewCase = draft.snapshot.case;
    object(reviewCase, ['id', 'mode', 'status', 'original', 'preparedRevision', 'proposal', 'approvedProposalId']);
    if (reviewCase.id !== session.id || !['test', 'design', 'report'].includes(reviewCase.mode)
      || !['draft', 'prepared', 'proposed', 'approved'].includes(reviewCase.status)) invalid();
    const original = reviewCase.original;
    object(original, ['title', 'detail', 'steps', 'expected', 'additionalContext']);
    if (!text(original.title, 200) || !original.title || !text(original.detail) || !text(original.expected) || !text(original.additionalContext)) invalid();
    strings(original.steps, 50, item => text(item, 1000) && Boolean(item));
    if (reviewCase.preparedRevision !== undefined && (!integer(reviewCase.preparedRevision) || reviewCase.preparedRevision > Number(snapshot.revision))) invalid();
    if (reviewCase.status !== 'draft' && reviewCase.preparedRevision === undefined) invalid();
    if (reviewCase.proposal !== undefined) {
      const proposal = reviewCase.proposal;
      object(proposal, ['id', 'basedOnRevision', 'title', 'steps', 'expected', 'summary', 'details', 'sourceDocIds', 'createdAt']);
      if (!identifier(proposal.id) || !integer(proposal.basedOnRevision) || proposal.basedOnRevision > Number(snapshot.revision)
        || !text(proposal.title, 200) || !proposal.title || !text(proposal.expected) || !text(proposal.summary) || !text(proposal.details)) invalid();
      strings(proposal.steps, 50, item => text(item, 1000) && Boolean(item));
      const sourceDocIds = strings(proposal.sourceDocIds, 30, identifier);
      if (new Set(sourceDocIds).size !== sourceDocIds.length) invalid();
      const proposedAt = date(proposal.createdAt); if (proposedAt < started || proposedAt > now + 5000) invalid();
      if (['proposed', 'approved'].includes(reviewCase.status) && proposal.basedOnRevision !== reviewCase.preparedRevision) invalid();
    }
    if (['proposed', 'approved'].includes(reviewCase.status) && !reviewCase.proposal) invalid();
    if (reviewCase.status === 'approved') {
      if (!reviewCase.proposal || reviewCase.approvedProposalId !== reviewCase.proposal.id) invalid();
    } else if (reviewCase.approvedProposalId !== undefined) invalid();
  }
  const privacy = object(snapshot.privacy, ['reviewedRevision']);
  if (privacy.reviewedRevision !== null && (!integer(privacy.reviewedRevision) || privacy.reviewedRevision > Number(snapshot.revision))) invalid();
  const partial = object(snapshot.partial, ['isPartial', 'reasons', 'droppedEvents']);
  if (typeof partial.isPartial !== 'boolean' || !integer(partial.droppedEvents)) invalid();
  strings(partial.reasons, 100, item => text(item, 500));
  if (partial.isPartial !== (Number((partial.reasons as unknown[]).length) > 0)) invalid();
  const arrays = ['steps', 'events', 'findings', 'artifacts'] as const;
  for (const name of arrays) if (!Array.isArray(snapshot[name])) invalid();
  const { steps, events, findings, artifacts } = draft.snapshot;
  if (steps.length + events.length > limits.maxEvents || findings.length > limits.maxEvents
    || artifacts.length > limits.maxImages || Number(snapshot.bytesStored) > limits.maxBytes)
    throw new ReviewPersistenceError('DRAFT_LIMIT_REACHED', 'El borrador supera los límites de eventos, capturas o 50 MiB.');
  const allIds = new Set<string>([String(session.id)]);
  const collect = (values: Array<{ id: string; sessionId: string }>): Set<string> => {
    const set = new Set<string>();
    for (const item of values) {
      if (!item || !identifier(item.id) || item.sessionId !== session.id || allIds.has(item.id)) invalid();
      allIds.add(item.id); set.add(item.id);
    }
    return set;
  };
  const stepIds = collect(steps), artifactIds = collect(artifacts);
  collect(events); collect(findings);
  const inTime = (value: unknown) => { const at = date(value); if (at < started || at > now + 5000) invalid(); };
  for (const step of steps) {
    const row = object(step, ['id', 'sessionId', 'label', 'at', 'pathname', 'targetId', 'actor', 'attribution', 'simulated', 'artifactIds', 'notes', 'recordingBoundary', 'context']);
    observation(step);
    if (!text(step.label, 200) || !step.label || !path(step.pathname) || !text(step.notes, 2000)
      || typeof step.simulated !== 'boolean' || (step.targetId !== undefined && !identifier(step.targetId))
      || (step.recordingBoundary !== undefined && step.recordingBoundary !== 'start' && step.recordingBoundary !== 'stop')) invalid();
    who(row); inTime(step.at); ids(step.artifactIds, limits.maxImages, artifactIds);
  }
  for (const event of events) {
    const row = object(event, ['id', 'sessionId', 'at', 'kind', 'actor', 'attribution', 'simulated', 'label', 'resource', 'method', 'status', 'outcome', 'durationMs', 'stepId', 'correlation', 'requestBody', 'responseBody', 'simulation', 'context']);
    observation(event);
    who(row); inTime(event.at);
    if (typeof event.simulated !== 'boolean' || (event.stepId !== undefined && !stepIds.has(event.stepId))
      || (event.correlation !== undefined && !['temporal', 'explicit'].includes(event.correlation))) invalid();
    if (event.kind === 'interaction') { if (!text(event.label, 2000) || !event.label) invalid(); }
    else if (event.kind === 'fetch') {
      for (const field of ['requestBody', 'responseBody'] as const) {
        if (event[field] === undefined) continue;
        const checked = sanitizeActivityBody(event[field]);
        if (!checked || JSON.stringify(checked) !== JSON.stringify(event[field])) invalid('El cuerpo de una consulta no es válido o excede su límite.');
      }
      if (event.simulation !== undefined && (!['slow', 'offline'].includes(event.simulation) || event.simulated !== true)) invalid();
      if (!text(event.resource, 100) || !event.resource || normalizeActivityMethod(event.method) !== event.method
        || !['pending', 'success', 'http_error', 'network_error', 'aborted', 'incomplete'].includes(String(event.outcome))
        || (event.status !== null && event.status !== undefined && (!integer(event.status, 599) || event.status < 100))
        || (event.durationMs !== undefined && event.durationMs !== null && (!Number.isFinite(event.durationMs) || event.durationMs < 0))) invalid();
    } else invalid();
  }
  for (const finding of findings) {
    object(finding, ['id', 'sessionId', 'title', 'type', 'expected', 'observed', 'stepIds', 'artifactIds', 'simulated', 'reproducibility', 'hypothesis', 'missingInformation']);
    if (!text(finding.title, 200) || !finding.title || !text(finding.observed, 4000) || !finding.observed
      || !['bug', 'feature', 'observation'].includes(finding.type) || typeof finding.simulated !== 'boolean'
      || !['notChecked', 'reproduced', 'notReproduced'].includes(finding.reproducibility)
      || (finding.hypothesis !== undefined && !text(finding.hypothesis, 2000))) invalid();
    ids(finding.stepIds, limits.maxEvents, stepIds); ids(finding.artifactIds, limits.maxImages, artifactIds);
    strings(finding.missingInformation, 50, item => text(item, 500));
    if (finding.expected !== undefined) {
      object(finding.expected, ['text', 'provenance', 'sourceId']);
      if (!text(finding.expected.text, 2000) || !finding.expected.text || !['observed', 'declared', 'inferred'].includes(finding.expected.provenance)
        || (finding.expected.sourceId !== undefined && !identifier(finding.expected.sourceId))) invalid();
    }
  }
  if (!Array.isArray(draft.files) || draft.files.length > limits.maxImages) invalid();
  const files = new Map<string, ReviewDraft['files'][number]>();
  let bytes = 0;
  for (const file of draft.files) {
    object(file, ['id', 'bytes', 'mimeType', 'filename']);
    if (!identifier(file.id) || !artifactIds.has(file.id) || files.has(file.id) || !(file.bytes instanceof Uint8Array)
      || !file.bytes.length || typeof file.filename !== 'string' || file.filename.length > 200
      || !file.filename || /[\\/\u0000-\u001f\u007f]/.test(file.filename) || !signature(file.bytes, file.mimeType)) invalid();
    bytes += file.bytes.length;
    if (bytes > limits.maxBytes) throw new ReviewPersistenceError('DRAFT_LIMIT_REACHED', 'El borrador supera el límite de 50 MiB.');
    files.set(file.id, file);
  }
  if (bytes !== snapshot.bytesStored) invalid('Los bytes del borrador no coinciden con su índice.');
  const exclusions = new Map<string, string>();
  if (draft.excludedStatuses !== undefined) {
    if (!Array.isArray(draft.excludedStatuses) || draft.excludedStatuses.length > limits.maxImages) invalid();
    for (const item of draft.excludedStatuses) {
      object(item, ['id', 'status']);
      if (!identifier(item.id) || exclusions.has(item.id) || !['available', 'failed', 'missing'].includes(item.status)) invalid();
      exclusions.set(item.id, item.status);
    }
  }
  for (const artifact of artifacts) {
    object(artifact, ['id', 'sessionId', 'stepId', 'capturedAt', 'pathname', 'mimeType', 'status', 'byteLength', 'sha256', 'capture', 'redactionStatus', 'retrieval', 'simulated', 'notes', 'failureReason']);
    inTime(artifact.capturedAt);
    if (!path(artifact.pathname) || !['image/png', 'image/jpeg', 'image/webp'].includes(artifact.mimeType)
      || !['available', 'failed', 'missing', 'excluded'].includes(artifact.status)
      || !['applied', 'notRequired', 'disabled', 'failed'].includes(artifact.redactionStatus)
      || typeof artifact.simulated !== 'boolean' || !text(artifact.notes, 2000)
      || (artifact.failureReason !== undefined && !text(artifact.failureReason, 300))) invalid();
    const step = artifact.stepId === undefined ? undefined : steps.find(item => item.id === artifact.stepId);
    if (artifact.stepId !== undefined && (!step || step.pathname !== artifact.pathname || !step.artifactIds.includes(artifact.id)
      || date(artifact.capturedAt) < date(step.at))) invalid();
    for (const linked of steps.filter(item => item.artifactIds.includes(artifact.id))) if (linked.id !== artifact.stepId) invalid();
    const file = files.get(artifact.id), original = artifact.status === 'excluded' ? exclusions.get(artifact.id) ?? (file ? 'available' : 'missing') : artifact.status;
    if (artifact.status !== 'excluded' && exclusions.has(artifact.id)) invalid();
    if (artifact.status === 'excluded' && !exclusions.has(artifact.id)) exclusions.set(artifact.id, original);
    if (original === 'available') {
      if (!file || file.mimeType !== artifact.mimeType || file.bytes.length !== artifact.byteLength
        || !HASH.test(artifact.sha256 ?? '') || artifact.redactionStatus === 'failed' || !artifact.capture) invalid();
      if (!globalThis.crypto?.subtle) throw new ReviewPersistenceError('PERSISTENCE_UNAVAILABLE', 'No hay SHA-256 para verificar el borrador local.');
      const hash = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(file.bytes));
      current(options);
      if (Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('') !== artifact.sha256) invalid('La integridad de una imagen del borrador no coincide con su SHA-256.');
    } else if (file || artifact.byteLength !== undefined || artifact.sha256 !== undefined || artifact.retrieval !== undefined) invalid();
    if (artifact.capture !== undefined) {
      const info = object(artifact.capture, ['kind', 'provider', 'viewport', 'toolbarHidden']);
      const viewport = object(info.viewport, ['width', 'height', 'dpr']);
      if (!['viewport', 'region', 'fullPage'].includes(String(info.kind)) || !text(info.provider, 100) || !info.provider
        || ![viewport.width, viewport.height, viewport.dpr].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0)
        || Number(viewport.width) > 100000 || Number(viewport.height) > 100000 || Number(viewport.dpr) > 16
        || (info.toolbarHidden !== undefined && typeof info.toolbarHidden !== 'boolean')) invalid();
    }
    if (artifact.retrieval !== undefined) {
      object(artifact.retrieval, ['method', 'reference']);
      if (!['tool', 'download'].includes(artifact.retrieval.method) || artifact.retrieval.reference !== artifact.id) invalid();
    }
  }
  if ([...exclusions.keys()].some(id => !artifacts.some(item => item.id === id && item.status === 'excluded'))) invalid();
  draft.excludedStatuses = [...exclusions].map(([id, status]) => ({ id, status: status as 'available' | 'failed' | 'missing' }));
  // This warning is derived from current artifacts rather than durable limit gaps.
  draft.snapshot.partial.reasons = draft.snapshot.partial.reasons.filter(item => item !== FAILURE_NOTICE);
  if (artifacts.some(item => item.status === 'failed' || item.status === 'missing')) draft.snapshot.partial.reasons.push(FAILURE_NOTICE);
  draft.snapshot.partial.isPartial = draft.snapshot.partial.reasons.length > 0;
  const metadata = JSON.stringify({ ...draft, files: draft.files.map(({ bytes: _bytes, ...file }) => file) });
  if (bytes + new TextEncoder().encode(metadata).byteLength > REVIEW_DRAFT_MAX_BYTES)
    throw new ReviewPersistenceError('DRAFT_LIMIT_REACHED', 'Las imágenes y el contexto del borrador superan el límite de 50 MiB.');
  current(options);
  return draft;
}

function storageError(error?: unknown): ReviewPersistenceError {
  if (error instanceof ReviewPersistenceError) return error;
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  return name === 'QuotaExceededError'
    ? new ReviewPersistenceError('PERSISTENCE_QUOTA', 'No hay espacio para guardar el borrador local. La revisión sigue en memoria.')
    : name === 'AbortError'
      ? new ReviewPersistenceError('PERSISTENCE_ABORTED', 'El guardado local fue cancelado. La revisión sigue en memoria.')
      : new ReviewPersistenceError('PERSISTENCE_UNAVAILABLE', 'El navegador no pudo acceder al borrador local. La revisión sigue en memoria.');
}
function storageKey(view: Window, key: string): string {
  if (typeof key !== 'string' || !key || key.length > 200 || /[\u0000-\u001f]/.test(key)) invalid('La clave del borrador local no es válida.');
  return `${view.location.origin}\u0000${key}`;
}
function openDatabase(view: Window, options: ReviewDraftOperationOptions): Promise<IDBDatabase> {
  current(options);
  return new Promise((resolve, reject) => {
    let settled = false, request: IDBOpenDBRequest;
    const finish = (error?: unknown, database?: IDBDatabase) => {
      if (settled) { database?.close(); return; }
      settled = true; view.clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (error) reject(storageError(error)); else resolve(database!);
    };
    const abort = () => finish(new ReviewPersistenceError('PERSISTENCE_ABORTED', 'El acceso al borrador fue cancelado.'));
    const timer = view.setTimeout(() => finish(new Error('blocked')), 3000);
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (!view.indexedDB) { finish(new Error('unavailable')); return; }
      request = view.indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
      request.onerror = () => finish(request.error);
      request.onblocked = () => finish(new Error('blocked'));
      request.onsuccess = () => { try { current(options); finish(undefined, request.result); } catch (error) { request.result.close(); finish(error); } };
    } catch (error) { finish(error); }
  });
}
async function transaction<T>(view: Window, mode: IDBTransactionMode, options: ReviewDraftOperationOptions,
  work: (store: IDBObjectStore, setResult: (result: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  const db = await openDatabase(view, options);
  try {
    current(options);
    return await new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction, result: T, cause: unknown;
      const abort = () => { cause = new ReviewPersistenceError('PERSISTENCE_ABORTED', 'El guardado local fue cancelado.'); try { tx.abort(); } catch { /* Already committed. */ } };
      try {
        tx = db.transaction(STORE, mode);
        tx.oncomplete = () => { options.signal?.removeEventListener('abort', abort); resolve(result); };
        tx.onabort = () => { options.signal?.removeEventListener('abort', abort); reject(storageError(cause ?? tx.error)); };
        tx.onerror = () => { cause ??= tx.error; };
        options.signal?.addEventListener('abort', abort, { once: true });
        work(tx.objectStore(STORE), value => { result = value; }, error => { cause = error; tx.abort(); });
      } catch (error) {
        options.signal?.removeEventListener('abort', abort); reject(storageError(error));
        try { tx!.abort(); } catch { /* Opening the transaction itself may fail. */ }
      }
    });
  } finally { db.close(); }
}
interface StoredDraft { version: 1; origin: string; savedAt: number; expiresAt: number; draft: ReviewDraft }
interface DeletedSession { version: 1; sessionId: string; expiresAt: number }
function deletedKey(view: Window, sessionId: string): string { return storageKey(view, `review:deleted:${sessionId}`); }
function isDeleted(value: unknown, sessionId: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<DeletedSession>;
  return entry.version === 1 && entry.sessionId === sessionId && typeof entry.expiresAt === 'number' && entry.expiresAt > Date.now();
}
export function isReviewSessionDeleted(view: Window, sessionId: string, options: ReviewDraftOperationOptions = {}): Promise<boolean> {
  if (!identifier(sessionId)) return Promise.resolve(false);
  return transaction<boolean>(view, 'readonly', options, (store, done) => {
    const read = store.get(deletedKey(view, sessionId));
    read.onsuccess = () => done(isDeleted(read.result, sessionId));
  });
}
const queues = new WeakMap<Window, Map<string, Promise<unknown>>>();
function enqueue<T>(view: Window, key: string, work: () => Promise<T>): Promise<T> {
  let map = queues.get(view); if (!map) { map = new Map(); queues.set(view, map); }
  const previous = map.get(key) ?? Promise.resolve(), run = previous.catch(() => undefined).then(work);
  map.set(key, run);
  void run.finally(() => { if (map!.get(key) === run) map!.delete(key); }).catch(() => undefined);
  return run;
}
/** One origin-scoped IndexedDB entry; binary Uint8Arrays are structured-cloned, never base64 localStorage. */
export function saveReviewDraft(view: Window, key: string, draft: ReviewDraft, options: ReviewDraftOperationOptions = {}): Promise<void> {
  const id = storageKey(view, key);
  let copy: ReviewDraft;
  try { checkBinaryBudget(draft); copy = structuredClone(draft); }
  catch (error) { return Promise.reject(error instanceof ReviewPersistenceError ? error : new ReviewPersistenceError('INVALID_DRAFT', 'El borrador no se puede copiar para guardarlo.')); }
  return enqueue(view, id, async () => {
    const checked = await validateReviewDraft(copy, { ...options, origin: view.location.origin });
    current(options);
    const savedAt = Date.now(), entry: StoredDraft = { version: 1, origin: view.location.origin, savedAt, expiresAt: savedAt + REVIEW_DRAFT_TTL_MS, draft: checked };
    await transaction<void>(view, 'readwrite', options, (store, _done, fail) => {
      const sessionId = checked.snapshot.session!.id;
      const deleted = store.get(deletedKey(view, sessionId));
      deleted.onsuccess = () => {
        if (isDeleted(deleted.result, sessionId)) { fail(new ReviewPersistenceError('DRAFT_DELETED', 'Esta grabación se eliminó en otra pestaña. Tus cambios siguen en memoria y podés copiarlos antes de comenzar otra.')); return; }
        const read = store.get(id);
        read.onsuccess = () => {
          try {
            current(options);
            const stored = read.result as StoredDraft | undefined;
            if (stored && stored.draft?.snapshot?.session?.id === checked.snapshot.session?.id
              && stored.draft.snapshot.revision > checked.snapshot.revision) return;
            if (isEmptyStoppedRecording(checked.snapshot)) {
              // A stale empty save must never delete a different current recording.
              if (stored?.draft?.snapshot?.session?.id === checked.snapshot.session?.id) store.delete(id);
              return;
            }
            store.put(entry, id);
          } catch (error) { fail(error); }
        };
      };
    });
  });
}
export async function loadReviewDraft(view: Window, key: string, options: ReviewDraftOperationOptions = {}): Promise<ReviewDraft | null> {
  const id = storageKey(view, key);
  const entry = await transaction<StoredDraft | null>(view, 'readwrite', options, (store, done) => {
    const read = store.get(id); read.onsuccess = () => {
      const stored = read.result as StoredDraft | undefined;
      // Expiry cleanup shares the read transaction, so a newer save cannot be deleted by an older load.
      if (stored?.version === 1 && stored.origin === view.location.origin && integer(stored.expiresAt) && stored.expiresAt <= Date.now()) store.delete(id);
      const sessionId = stored?.draft?.snapshot?.session?.id;
      if (!identifier(sessionId)) { done(stored ?? null); return; }
      const deleted = store.get(deletedKey(view, sessionId));
      deleted.onsuccess = () => { done(isDeleted(deleted.result, sessionId) ? null : stored ?? null); };
    };
  });
  current(options);
  if (!entry) return null;
  object(entry, ['version', 'origin', 'savedAt', 'expiresAt', 'draft']);
  if (entry.version !== 1 || entry.origin !== view.location.origin || !integer(entry.savedAt) || !integer(entry.expiresAt)
    || entry.expiresAt !== entry.savedAt + REVIEW_DRAFT_TTL_MS || entry.savedAt > Date.now() + 5000) invalid();
  if (entry.expiresAt <= Date.now()) throw new ReviewPersistenceError('EXPIRED_DRAFT', 'El borrador local venció después de siete días.');
  return validateReviewDraft(entry.draft, { ...options, origin: view.location.origin });
}
export interface DeleteReviewDraftOptions extends ReviewDraftOperationOptions { expectedSessionId?: string; expectedRevision?: number; markSessionDeleted?: boolean }
export function deleteReviewDraft(view: Window, key: string, options: DeleteReviewDraftOptions = {}): Promise<void> {
  const id = storageKey(view, key);
  const sessionId = options.expectedSessionId;
  if (sessionId !== undefined && !identifier(sessionId)) invalid('La sesión del borrador local no es válida.');
  return enqueue(view, id, () => transaction<void>(view, 'readwrite', options, (store, _done, fail) => {
    current(options);
    if (!sessionId) { store.delete(id); return; }
    const read = store.get(id);
    read.onsuccess = () => {
      try {
        current(options);
        const stored = read.result as StoredDraft | undefined;
        if (stored?.draft?.snapshot?.session?.id === sessionId && (options.expectedRevision === undefined || stored.draft.snapshot.revision === options.expectedRevision)) store.delete(id);
        if (options.markSessionDeleted) store.put({ version: 1, sessionId, expiresAt: Date.now() + REVIEW_DRAFT_TTL_MS } satisfies DeletedSession, deletedKey(view, sessionId));
      } catch (error) { fail(error); }
    };
  }));
}

/** Internal storage references stay inside the controller; the UI receives opaque IDs. */
export interface StoredCaseSummary {
  key: string;
  sessionId: string;
  title: string;
  mode: 'test' | 'design' | 'report';
  updatedAt: string;
  startedAt: string;
  stepCount: number;
  contentStepCount: number;
}
/** Lists only this integration's active key and its archives, without copying image bytes. */
export async function listReviewCases(view: Window, key: string, archivePrefixes: readonly string[], options: ReviewDraftOperationOptions = {}, additionalKeys: readonly string[] = []): Promise<StoredCaseSummary[]> {
  const activeIds = new Set([key, ...additionalKeys].map(item => storageKey(view, item))), originPrefix = `${view.location.origin}\u0000`;
  const prefixes = archivePrefixes.map(prefix => storageKey(view, prefix));
  return transaction<StoredCaseSummary[]>(view, 'readonly', options, (store, done) => {
    const rows: StoredCaseSummary[] = [];
    const deleted = new Set<string>();
    const read = store.openCursor();
    read.onsuccess = () => {
      const cursor = read.result;
      if (!cursor) { done(rows.filter(row => !deleted.has(row.sessionId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100)); return; }
      current(options);
      const id = typeof cursor.key === 'string' ? cursor.key : '';
      if (id.startsWith(`${originPrefix}review:deleted:`)) {
        const sessionId = id.slice(`${originPrefix}review:deleted:`.length);
        if (isDeleted(cursor.value, sessionId)) deleted.add(sessionId);
      }
      const archive = prefixes.find(prefix => id.startsWith(prefix) && identifier(id.slice(prefix.length)));
      if (activeIds.has(id) || archive) {
        try {
          const entry = object(cursor.value, ['version', 'origin', 'savedAt', 'expiresAt', 'draft']);
          if (entry.version !== 1 || entry.origin !== view.location.origin || !integer(entry.savedAt)
            || !integer(entry.expiresAt) || entry.expiresAt !== entry.savedAt + REVIEW_DRAFT_TTL_MS
            || entry.expiresAt <= Date.now() || entry.savedAt > Date.now() + 5000) throw new Error('Invalid or expired entry');
          const draft = entry.draft as ReviewDraft, session = draft?.snapshot?.session, reviewCase = draft?.snapshot?.case;
          if (!session || !identifier(session.id) || (reviewCase && reviewCase.id !== session.id)
            || session.scope?.origin !== view.location.origin || !text(session.objective, 1000) || !session.objective
            || (reviewCase && (!text(reviewCase.original?.title, 200) || !reviewCase.original.title || !['test', 'design', 'report'].includes(reviewCase.mode)))
            || (archive && id.slice(archive.length) !== session.id)) throw new Error('Invalid case summary');
          const activityAt = date(session.lastActivityAt);
          if (activityAt > Date.now() + 5000 || Date.now() - activityAt > REVIEW_DRAFT_TTL_MS) throw new Error('Invalid or expired activity');
          const updatedAt = new Date(activityAt).toISOString();
          if (session.recording === 'active' || isEmptyStoppedRecording(draft.snapshot)) { cursor.continue(); return; }
          rows.push({ key: id.slice(originPrefix.length), sessionId: session.id,
            title: session.objective, mode: reviewCase?.mode ?? 'test', updatedAt, startedAt: new Date(date(session.startedAt)).toISOString(),
            stepCount: draft.snapshot.steps.length,
            contentStepCount: recordingSteps(draft.snapshot.steps, draft.snapshot.events, true).length });
        } catch { /* Invalid summaries are omitted. Full image integrity is checked on restore. */ }
      }
      cursor.continue();
    };
  });
}
