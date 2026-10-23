import { normalizeActivityMethod, sanitizeActivityLabel, sanitizeActivityBody } from '../core/activity.js';
import { sanitizePathname } from '../core/privacy.js';
import { createTranslator } from '../core/locale.js';
import { sanitizeRecordedContext } from '../core/recorded-context.js';
import { validateKnowledgeBundle } from '../core/knowledge.js';
import { validateReviewDraft, ReviewPersistenceError } from './persistence.js';
import type {
  AddArtifactInput, AddFindingInput, CheckpointInput, EvidenceArtifact, EvidenceCapture,
  Finding, FrozenReview, RecordEventInput, ReviewActor, ReviewAttribution, ReviewEngine,
  ReviewEngineOptions, ReviewErrorCode, ReviewEvent, ReviewLimits, ReviewMutation, ReviewResult,
  ReviewScope, ReviewSession, ReviewSnapshot, ReviewStep, ReviewDraft, ReviewDraftOperationOptions,
  ReviewCase, ReviewCaseOriginal, CaseMutation, RemoveStepInput, RemovedStep,
} from './types.js';

const IDENTIFIER = /^[a-z0-9][a-z0-9_.:-]{0,127}$/i;
const MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const OUTCOMES = ['pending', 'success', 'http_error', 'network_error', 'aborted', 'incomplete'];
const DEFAULT_LIMITS: ReviewLimits = { maxEvents: 10_000, maxImages: 20, maxBytes: 50 * 1024 * 1024 };

/** Public notes and labels receive the same secret and URL filtering as activity labels. */
export function sanitizeReviewText(value: unknown, limit = 2_000): string {
  if (typeof value !== 'string') return '';
  return sanitizeActivityLabel(value
    .replace(/\b[a-z]:[\\/][^\s<>"']+/gi, '[ruta local omitida]')
    .replace(/(?:^|\s)(?:\\\\|\/(?:Users|home|tmp|var|mnt)\/)[^\s<>"']+/gi, ' [ruta local omitida]'), limit);
}

function clone<T>(value: T): T { return structuredClone(value); }
function finiteLimit(value: unknown, fallback: number, ceiling: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(ceiling, Math.floor(value))) : fallback;
}
function validId(value: unknown): value is string { return typeof value === 'string' && IDENTIFIER.test(value); }
function pathname(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.length > 2_000 || /[\\\u0000-\u001f]/.test(value)) return null;
  return sanitizePathname(value);
}
function scope(value: unknown): ReviewScope | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const path = pathname(input.pathname);
  if (!path || typeof input.origin !== 'string') return null;
  try {
    const url = new URL(input.origin);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (input.targetId !== undefined && !validId(input.targetId)) return null;
    return { origin: url.origin, pathname: path, ...(input.targetId !== undefined ? { targetId: input.targetId } : {}) };
  } catch { return null; }
}
function date(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function actor(value: unknown, attribution: unknown): { actor: ReviewActor; attribution: ReviewAttribution } | null {
  if (value !== undefined && !['user', 'agent', 'unknown'].includes(value as string)) return null;
  if (attribution !== undefined && !['declared', 'verified', 'unknown'].includes(attribution as string)) return null;
  // A public SDK call alone cannot verify a user's or agent's identity.
  if (value === 'agent') return { actor: 'agent', attribution: 'declared' };
  if (value === 'user') return { actor: 'user', attribution: 'declared' };
  return { actor: 'unknown', attribution: 'unknown' };
}
function imageSignature(bytes: Uint8Array, mime: string): boolean {
  if (mime === 'image/png') return bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
    && String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR';
  if (mime === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  if (mime === 'image/webp') return bytes.length >= 16 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  return false;
}
function capture(value: unknown): EvidenceCapture | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as EvidenceCapture;
  if (!['viewport', 'fullPage', 'region'].includes(input.kind)) return null;
  const provider = sanitizeReviewText(input.provider, 100);
  if (!provider || !input.viewport || ![input.viewport.width, input.viewport.height, input.viewport.dpr]
    .every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)) return null;
  if (input.viewport.width > 100_000 || input.viewport.height > 100_000 || input.viewport.dpr > 16) return null;
  if (input.toolbarHidden !== undefined && typeof input.toolbarHidden !== 'boolean') return null;
  return { kind: input.kind, provider, viewport: { width: input.viewport.width, height: input.viewport.height, dpr: input.viewport.dpr }, ...(input.toolbarHidden !== undefined ? { toolbarHidden: input.toolbarHidden } : {}) };
}

/** In-memory evidence management. Reads never initiate collection or a review session. */
export function createReviewEngine(options: ReviewEngineOptions = {}): ReviewEngine {
  const observation = () => {
    const published = options.getDocuments?.();
    if (published && session) {
      const docs = new Map((session.documents?.documents ?? []).map(document => [document.id, document]));
      for (const document of validateKnowledgeBundle(published).documents) if (!docs.has(document.id)) docs.set(document.id, document);
      session.documents = validateKnowledgeBundle({ schemaVersion: '1.0', documents: [...docs.values()] });
    }
    const context = sanitizeRecordedContext(options.observe?.()); return context ? { context } : {};
  };
  const limits = {
    maxEvents: finiteLimit(options.limits?.maxEvents, DEFAULT_LIMITS.maxEvents, 10_000),
    maxImages: finiteLimit(options.limits?.maxImages, DEFAULT_LIMITS.maxImages, 1_000),
    maxBytes: finiteLimit(options.limits?.maxBytes, DEFAULT_LIMITS.maxBytes, 1024 * 1024 * 1024),
  };
  let revision = 0;
  let sequence = 0;
  let session: ReviewSession | null = null;
  let reviewCase: ReviewCase | undefined;
  let currentLocation: ReviewScope | null = null;
  let steps: ReviewStep[] = [];
  let events: ReviewEvent[] = [];
  let findings: Finding[] = [];
  let artifacts: EvidenceArtifact[] = [];
  let privacyRevision: number | null = null;
  let bytesStored = 0;
  let droppedEvents = 0;
  let partialReasons: string[] = [];
  const binaries = new Map<string, Uint8Array>();
  const originalStatuses = new Map<string, EvidenceArtifact['status']>();
  const requests = new Map<string, { operation: string; result: ReviewResult<unknown> }>();
  const pending = new Map<string, Promise<ReviewResult<EvidenceArtifact>>>();
  const identifiers = new Set<string>();
  const now = () => (options.now?.() ?? new Date()).toISOString();

  function id(kind: Parameters<NonNullable<ReviewEngineOptions['id']>>[0]): string {
    const supplied = options.id?.(kind);
    let candidate = supplied && validId(supplied) ? supplied : `${kind}-${++sequence}`;
    while (identifiers.has(candidate)) candidate = `${kind}-${++sequence}`;
    identifiers.add(candidate);
    return candidate;
  }
  function getSnapshot(): ReviewSnapshot {
    const reasons = artifacts.some(artifact => artifact.status === 'failed' || artifact.status === 'missing')
      ? [...partialReasons, 'Hay capturas fallidas o ausentes.'] : [...partialReasons];
    return clone({ schemaVersion: '2.0', revision, session, ...(reviewCase ? { case: reviewCase } : {}), steps, events, findings, artifacts,
      privacy: { reviewedRevision: privacyRevision }, partial: { isPartial: reasons.length > 0, reasons, droppedEvents },
      limits, bytesStored });
  }
  function notify(): void {
    try { options.onChange?.(getSnapshot()); } catch { /* Observers cannot interrupt the application or a committed mutation. */ }
  }
  function changed(invalidateCase = true): void {
    revision += 1;
    privacyRevision = null;
    if (reviewCase && invalidateCase) {
      reviewCase.status = 'draft';
      delete reviewCase.preparedRevision;
      delete reviewCase.approvedProposalId;
    }
    if (session) { session.revision = revision; session.lastActivityAt = now(); }
  }
  function error<T>(code: ReviewErrorCode, message: string): ReviewResult<T> {
    return { status: 'error', ...(session ? { sessionId: session.id } : {}), revision, error: { code, message } };
  }
  function ok<T>(data: T): ReviewResult<T> {
    return { status: 'ok', ...(session ? { sessionId: session.id } : {}), revision, data: clone(data) };
  }
  function preflight<T>(operation: string, input: ReviewMutation, active = true): ReviewResult<T> | null {
    if (!input || typeof input !== 'object' || !validId(input.requestId)) return error('INVALID_INPUT', 'requestId debe ser un identificador opaco válido.');
    const previous = requests.get(input.requestId);
    if (previous) return previous.operation === operation ? clone(previous.result) as ReviewResult<T>
      : error('INVALID_INPUT', 'requestId ya fue utilizado para otra operación.');
    if (input.expectedRevision !== undefined && (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== revision)) {
      return error('REVISION_CONFLICT', 'La revisión cambió. Leé el contexto actual antes de volver a editar.');
    }
    if (input.sessionId !== undefined && (!validId(input.sessionId) || input.sessionId !== session?.id)) return error('SESSION_NOT_FOUND', 'La sesión indicada no está disponible.');
    if (active && session?.status !== 'active') return error('SESSION_NOT_ACTIVE', 'Iniciá una sesión de revisión explícita.');
    return null;
  }
  function remember<T>(operation: string, input: ReviewMutation, result: ReviewResult<T>): ReviewResult<T> {
    requests.set(input.requestId, { operation, result: clone(result) });
    return result;
  }
  function commit<T>(operation: string, input: ReviewMutation, data: T, preserveCase = false): ReviewResult<T> {
    changed(!preserveCase);
    const result = remember(operation, input, ok(data));
    notify();
    return result;
  }
  function partial<T>(operation: string, input: ReviewMutation, reason: string, dropped = false): ReviewResult<T> {
    if (!partialReasons.includes(reason)) partialReasons.push(reason);
    if (dropped) { droppedEvents += 1; if (session?.recording === 'active') session.recording = 'stopped'; }
    changed();
    const result = remember(operation, input, error<T>('LIMIT_REACHED', reason));
    notify();
    return result;
  }
  function samePage(path: string, targetId?: string): boolean {
    const location = currentLocation ?? session?.scope;
    if (!location || path !== location.pathname || (session && location.origin !== session.scope.origin)) return false;
    if (targetId !== undefined && (!validId(targetId) || targetId !== location.targetId)) return false;
    return true;
  }
  function referenceIds(value: unknown, existing: readonly { id: string }[]): string[] | null {
    if (!Array.isArray(value) || value.length > limits.maxEvents) return null;
    if (!value.every(candidate => validId(candidate) && existing.some(item => item.id === candidate))) return null;
    return [...new Set(value as string[])];
  }
  function casePreflight(operation: string, input: CaseMutation): ReviewResult<ReviewCase> | null {
    const previous = preflight<ReviewCase>(operation, input);
    if (previous) return previous;
    if (!reviewCase || input.caseId !== reviewCase.id) return error('REFERENCE_NOT_FOUND', 'El caso indicado ya no está activo.');
    if (!Number.isInteger(input.expectedRevision)) return error('INVALID_INPUT', 'La edición del caso necesita expectedRevision.');
    return null;
  }
  function originalFields(input: Partial<ReviewCaseOriginal>, previous?: ReviewCaseOriginal): ReviewCaseOriginal | null {
    const fields = ['title', 'detail', 'expected', 'additionalContext'] as const;
    if (fields.some(field => input[field] !== undefined && typeof input[field] !== 'string')) return null;
    if (input.steps !== undefined && (!Array.isArray(input.steps) || input.steps.length > 50 || !input.steps.every(step => typeof step === 'string'))) return null;
    const result: ReviewCaseOriginal = {
      title: sanitizeReviewText(input.title ?? previous?.title, 200),
      detail: sanitizeReviewText(input.detail ?? previous?.detail, 4_000),
      steps: (input.steps ?? previous?.steps ?? []).map(step => sanitizeReviewText(step, 1_000)).filter(Boolean),
      expected: sanitizeReviewText(input.expected ?? previous?.expected, 4_000),
      additionalContext: sanitizeReviewText(input.additionalContext ?? previous?.additionalContext, 4_000),
    };
    return result.title ? result : null;
  }
  function checkpoint(input: CheckpointInput): ReviewResult<ReviewStep> {
    const previous = preflight<ReviewStep>('checkpoint', input); if (previous) return previous;
    const path = pathname(input.pathname);
    const label = sanitizeReviewText(input.label, 200);
    const who = actor(input.actor, input.attribution);
    if (!path || !label || !who || (input.targetId !== undefined && !validId(input.targetId))
      || (input.recordingBoundary !== undefined && input.recordingBoundary !== 'start' && input.recordingBoundary !== 'stop')) return error('INVALID_INPUT', 'El punto de control necesita nombre, ruta y autoría válidos.');
    if (!samePage(path, input.targetId)) return error('STALE_TARGET', 'La selección o la ruta cambió. Actualizá el punto de control.');
    if (events.length + steps.length >= limits.maxEvents) return partial('checkpoint', input, 'Se alcanzó el límite de eventos y puntos de control.', true);
    const step: ReviewStep = { id: id('step'), sessionId: session!.id, label, pathname: path, at: now(), ...who, ...observation(),
      ...(input.recordingBoundary !== undefined ? { recordingBoundary: input.recordingBoundary } : {}),
      ...(input.targetId !== undefined ? { targetId: input.targetId } : {}), simulated: input.simulated === true, artifactIds: [], notes: sanitizeReviewText(input.notes) };
    steps.push(step);
    return commit('checkpoint', input, step);
  }
  function recordEvent(input: RecordEventInput): ReviewResult<ReviewEvent> {
    const previous = preflight<ReviewEvent>('recordEvent', input); if (previous) return previous;
    if (session!.recording !== 'active') return error('RECORDING_NOT_AUTHORIZED', 'La grabación autorizada no está activa.');
    if (!['interaction', 'fetch'].includes(input.kind)) return error('INVALID_INPUT', 'El tipo de evento no está permitido.');
    const eventAt = input.at === undefined ? now() : date(input.at);
    const who = actor(input.actor, input.attribution);
    if (!eventAt || !who || Date.parse(eventAt) < Date.parse(session!.startedAt) || Date.parse(eventAt) > Date.parse(now()) + 5_000) return error('INVALID_INPUT', 'La fecha o autoría del evento no es válida.');
    if (input.stepId !== undefined && !steps.some(item => item.id === input.stepId)) return error('REFERENCE_NOT_FOUND', 'El paso indicado no existe en esta sesión.');
    if (events.length + steps.length >= limits.maxEvents) return partial('recordEvent', input, 'Se alcanzó el límite de eventos y puntos de control.', true);
    const event: ReviewEvent = { id: id('event'), sessionId: session!.id, at: eventAt, kind: input.kind, ...who, ...observation(), simulated: input.simulated === true,
      ...(input.stepId ? { stepId: input.stepId, correlation: input.correlation === 'explicit' ? 'explicit' as const : 'temporal' as const } : {}) };
    if (input.kind === 'interaction') {
      const label = sanitizeReviewText(input.label, 200);
      if (!label) return error('INVALID_INPUT', 'La acción necesita un nombre público.');
      event.label = label;
    } else {
      if (!OUTCOMES.includes(input.outcome ?? '')) return error('INVALID_INPUT', 'La solicitud necesita un resultado válido.');
      const resource = sanitizeReviewText(input.resource, 100);
      if (!resource) return error('INVALID_INPUT', 'La solicitud necesita un recurso público.');
      if (input.status !== undefined && input.status !== null && (!Number.isInteger(input.status) || input.status < 100 || input.status > 599)) return error('INVALID_INPUT', 'El estado HTTP no es válido.');
      if (input.durationMs !== undefined && input.durationMs !== null && (typeof input.durationMs !== 'number' || !Number.isFinite(input.durationMs) || input.durationMs < 0)) return error('INVALID_INPUT', 'La duración no es válida.');
      event.resource = resource;
      event.method = normalizeActivityMethod(input.method);
      event.status = ['success', 'http_error'].includes(input.outcome!) ? input.status ?? null : null;
      event.outcome = input.outcome!;
      event.durationMs = input.outcome === 'pending' ? null : input.durationMs === undefined || input.durationMs === null ? null : Math.round(input.durationMs);
      const requestBody = sanitizeActivityBody(input.requestBody), responseBody = sanitizeActivityBody(input.responseBody);
      if (requestBody) event.requestBody = requestBody;
      if (responseBody) event.responseBody = responseBody;
      if (input.simulation === 'slow' || input.simulation === 'offline') { event.simulation = input.simulation; event.simulated = true; }
    }
    events.push(event);
    return commit('recordEvent', input, event);
  }

  function removeStep(input: RemoveStepInput): ReviewResult<RemovedStep> {
    const previous = preflight<RemovedStep>('removeStep', input, false); if (previous) return previous;
    if (!session) return error('SESSION_NOT_ACTIVE', 'No hay una grabación para quitar pasos.');
    if (!validId(input.stepId)) return error('INVALID_INPUT', 'Elegí un paso válido de esta grabación.');
    const step = steps.find(item => item.id === input.stepId);
    if (!step) return error('REFERENCE_NOT_FOUND', 'El paso ya no está en esta grabación.');
    const eventIds = new Set(events.filter(item => item.stepId === step.id).map(item => item.id));
    const artifactIds = new Set([...step.artifactIds, ...artifacts.filter(item => item.stepId === step.id).map(item => item.id)]);
    steps = steps.filter(item => item !== step);
    for (const remaining of steps) remaining.artifactIds = remaining.artifactIds.filter(id => !artifactIds.has(id));
    events = events.filter(item => !eventIds.has(item.id));
    artifacts = artifacts.filter(item => !artifactIds.has(item.id));
    for (const artifactId of artifactIds) {
      const bytes = binaries.get(artifactId);
      if (bytes) bytesStored -= bytes.byteLength;
      binaries.delete(artifactId); originalStatuses.delete(artifactId);
    }
    findings = findings.map(item => ({ ...item, stepIds: item.stepIds.filter(id => id !== step.id), artifactIds: item.artifactIds.filter(id => !artifactIds.has(id)) }));
    changed();
    // Old idempotent responses must not retain deleted payloads or allow a
    // repeated application request to return the removed evidence again.
    for (const [requestId, cached] of requests) {
      if (cached.result.status !== 'ok') continue;
      const data = cached.result.data as { id?: unknown; stepIds?: unknown; artifactIds?: unknown } | null;
      const referencesDeleted = data && typeof data === 'object' && (
        data.id === step.id || (typeof data.id === 'string' && (eventIds.has(data.id) || artifactIds.has(data.id)))
        || (Array.isArray(data.stepIds) && data.stepIds.includes(step.id))
        || (Array.isArray(data.artifactIds) && data.artifactIds.some(id => artifactIds.has(id))));
      if (referencesDeleted || cached.operation === 'reviewPrivacy') requests.set(requestId, { operation: cached.operation,
        result: error('REFERENCE_NOT_FOUND', 'El dato de esta operación fue borrado de la grabación.') });
    }
    const result = remember('removeStep', input, ok({ stepId: step.id, eventIds: [...eventIds], artifactIds: [...artifactIds] }));
    notify();
    return result;
  }

  async function addArtifact(input: AddArtifactInput): Promise<ReviewResult<EvidenceArtifact>> {
    const previous = preflight<EvidenceArtifact>('addArtifact', input); if (previous) return previous;
    input = { ...input };
    const inFlight = pending.get(input.requestId); if (inFlight) return clone(await inFlight);
    // Copy bytes synchronously before any asynchronous work so callers cannot mutate stored evidence.
    const bytes = input.bytes instanceof Uint8Array ? new Uint8Array(input.bytes) : null;
    const run = (async (): Promise<ReviewResult<EvidenceArtifact>> => {
      const path = pathname(input.pathname);
      const capturedAt = date(input.capturedAt);
      const captureInfo = input.capture === undefined ? null : capture(input.capture);
      const status = input.status ?? 'available';
      const capturedSession = session!.id;
      const step = input.stepId === undefined ? null : steps.find(item => item.id === input.stepId);
      if (!path || !capturedAt || !MIMES.includes(input.mimeType) || !['available', 'failed', 'missing'].includes(status)
        || !['applied', 'notRequired', 'disabled', 'failed'].includes(input.redactionStatus) || (input.capture !== undefined && !captureInfo)) return error('INVALID_INPUT', 'Los metadatos de la captura no son válidos.');
      if (input.stepId !== undefined && !step) return error('REFERENCE_NOT_FOUND', 'El paso de la captura no existe.');
      if ((status === 'available' && !samePage(path)) || (step && step.pathname !== path) || Date.parse(capturedAt) < Date.parse(step?.at ?? session!.startedAt)
        || Date.parse(capturedAt) > Date.parse(now()) + 5_000) return error('STALE_CAPTURE', 'La captura ya no corresponde a la ruta o al punto de control actual.');
      if (status === 'available' && (!bytes || !captureInfo || input.redactionStatus === 'failed' || !imageSignature(bytes, input.mimeType))) return error('INVALID_INPUT', 'La evidencia disponible necesita una imagen real y un proveedor identificado.');
      if (status !== 'available' && bytes) return error('INVALID_INPUT', 'Una captura fallida o ausente no puede conservar bytes de imagen.');
      if (artifacts.length >= limits.maxImages) return partial('addArtifact', input, 'Se alcanzó el límite de capturas.');
      if (bytes && bytesStored + bytes.byteLength > limits.maxBytes) return partial('addArtifact', input, 'Se alcanzó el límite de bytes de evidencia.');
      let sha256: string | undefined;
      if (bytes) {
        if (!globalThis.crypto?.subtle) return error('CAPABILITY_UNAVAILABLE', 'No hay un proveedor de SHA-256 disponible.');
        let digest: ArrayBuffer;
        try { digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.buffer); }
        catch { return error('CAPABILITY_UNAVAILABLE', 'No se pudo verificar la integridad de la captura.'); }
        sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      }
      // Hashing yields: a navigation, ended session, review edit, or another capture may have intervened.
      if (session?.id !== capturedSession || session.status !== 'active') return error('SESSION_NOT_ACTIVE', 'La sesión terminó mientras se preparaba la captura.');
      if (step && !steps.some(item => item.id === step.id)) return error('REFERENCE_NOT_FOUND', 'El paso fue borrado mientras se preparaba la captura.');
      if (status === 'available' && !samePage(path)) return error('STALE_CAPTURE', 'La página cambió mientras se preparaba la captura.');
      if (input.expectedRevision !== undefined && input.expectedRevision !== revision) return error('REVISION_CONFLICT', 'La revisión cambió mientras se preparaba la captura.');
      if (artifacts.length >= limits.maxImages) return partial('addArtifact', input, 'Se alcanzó el límite de capturas.');
      if (bytes && bytesStored + bytes.byteLength > limits.maxBytes) return partial('addArtifact', input, 'Se alcanzó el límite de bytes de evidencia.');
      const artifact: EvidenceArtifact = { id: id('artifact'), sessionId: session.id, capturedAt, pathname: path, mimeType: input.mimeType,
        status, redactionStatus: input.redactionStatus, simulated: input.simulated === true || step?.simulated === true, notes: '',
        ...(step ? { stepId: step.id } : {}), ...(captureInfo ? { capture: captureInfo } : {}),
        ...(bytes && sha256 ? { byteLength: bytes.byteLength, sha256 } : {}),
        ...(status !== 'available' ? { failureReason: sanitizeReviewText(input.failureReason, 300) || 'Captura no disponible.' } : {}) };
      if (bytes) { binaries.set(artifact.id, bytes); bytesStored += bytes.byteLength; artifact.retrieval = { method: 'download', reference: artifact.id }; }
      artifacts.push(artifact);
      step?.artifactIds.push(artifact.id);
      return commit('addArtifact', input, artifact);
    })();
    pending.set(input.requestId, run);
    try { return await run; } finally { pending.delete(input.requestId); }
  }

  function addFinding(input: AddFindingInput): ReviewResult<Finding> {
    const previous = preflight<Finding>('addFinding', input, false); if (previous) return previous;
    if (!session) return error('SESSION_NOT_ACTIVE', 'Iniciá una sesión de revisión explícita.');
    if (!Number.isInteger(input.expectedRevision)) return error('INVALID_INPUT', 'expectedRevision es obligatorio al editar hallazgos.');
    const title = sanitizeReviewText(input.title, 200);
    const observed = sanitizeReviewText(input.observed, 4_000);
    const stepIds = referenceIds(input.stepIds, steps);
    const artifactIds = referenceIds(input.artifactIds, artifacts);
    if (!title || !observed || !['bug', 'feature', 'observation'].includes(input.type)) return error('INVALID_INPUT', 'El hallazgo necesita título, tipo y resultado observado.');
    if (!stepIds || !artifactIds) return error('REFERENCE_NOT_FOUND', 'Una referencia del hallazgo no existe en esta sesión.');
    const existing = input.id === undefined ? null : findings.find(item => item.id === input.id);
    if (input.id !== undefined && !existing) return error('REFERENCE_NOT_FOUND', 'El hallazgo que querés actualizar no existe.');
    if (input.reproducibility !== undefined && !['notChecked', 'reproduced', 'notReproduced'].includes(input.reproducibility)) return error('INVALID_INPUT', 'La reproducibilidad no es válida.');
    if (input.expected !== undefined && (!input.expected || !['observed', 'declared', 'inferred'].includes(input.expected.provenance)
      || !sanitizeReviewText(input.expected.text) || (input.expected.sourceId !== undefined && !validId(input.expected.sourceId)))) return error('INVALID_INPUT', 'La expectativa necesita texto, fuente y procedencia válidos.');
    if (input.missingInformation !== undefined && (!Array.isArray(input.missingInformation) || input.missingInformation.length > 50 || !input.missingInformation.every(item => typeof item === 'string'))) return error('INVALID_INPUT', 'Los datos faltantes deben ser una lista de texto.');
    if (!existing && findings.length >= limits.maxEvents) return partial('addFinding', input, 'Se alcanzó el límite de hallazgos.');
    const finding: Finding = { id: existing?.id ?? id('finding'), sessionId: session.id, title, type: input.type, observed, stepIds, artifactIds,
      simulated: input.simulated === true || stepIds.some(ref => steps.find(item => item.id === ref)?.simulated)
        || artifactIds.some(ref => artifacts.find(item => item.id === ref)?.simulated),
      reproducibility: input.reproducibility ?? 'notChecked',
      missingInformation: (input.missingInformation ?? []).map(item => sanitizeReviewText(item, 500)).filter(Boolean),
      ...(input.expected ? { expected: { text: sanitizeReviewText(input.expected.text), provenance: input.expected.provenance,
        ...(input.expected.sourceId ? { sourceId: input.expected.sourceId } : {}) } } : {}),
      ...(input.hypothesis ? { hypothesis: sanitizeReviewText(input.hypothesis, 2_000) } : {}) };
    if (existing) findings[findings.indexOf(existing)] = finding; else findings.push(finding);
    return commit('addFinding', input, finding);
  }

  return {
    getSnapshot,
    exportDraft(): ReviewDraft {
      return {
        snapshot: getSnapshot(),
        files: artifacts.flatMap(artifact => {
          const bytes = binaries.get(artifact.id);
          return bytes ? [{ id: artifact.id, bytes: new Uint8Array(bytes), mimeType: artifact.mimeType,
            filename: `${artifact.id}.${artifact.mimeType === 'image/jpeg' ? 'jpg' : artifact.mimeType === 'image/webp' ? 'webp' : 'png'}` }] : [];
        }),
        excludedStatuses: [...originalStatuses].map(([artifactId, status]) => ({ id: artifactId,
          status: status === 'available' || status === 'failed' ? status : 'missing' })),
      };
    },
    async restoreDraft(input: ReviewDraft, restoreOptions: ReviewDraftOperationOptions = {}): Promise<ReviewResult<ReviewSnapshot>> {
      if (session || pending.size) return error('SESSION_ALREADY_ACTIVE', 'La revisión actual ya contiene trabajo; no se reemplazó por un borrador.');
      const initialRevision = revision;
      let draft: ReviewDraft;
      try { draft = await validateReviewDraft(input, { ...restoreOptions, limits, now: Date.parse(now()) }); }
      catch (failure) {
        return error(failure instanceof ReviewPersistenceError && failure.code === 'DRAFT_LIMIT_REACHED' ? 'LIMIT_REACHED'
          : failure instanceof ReviewPersistenceError && ['PERSISTENCE_UNAVAILABLE', 'PERSISTENCE_ABORTED'].includes(failure.code) ? 'CAPABILITY_UNAVAILABLE' : 'INVALID_INPUT',
        failure instanceof ReviewPersistenceError ? failure.message : 'El borrador local no se pudo verificar.');
      }
      // Hash verification yields. A live edit, disposal or another restore must win over this draft.
      if (restoreOptions.signal?.aborted || restoreOptions.isCurrent?.() === false)
        return error('CAPABILITY_UNAVAILABLE', 'La recuperación del borrador fue cancelada.');
      if (session || pending.size || revision !== initialRevision)
        return error('REVISION_CONFLICT', 'La revisión cambió mientras se recuperaba el borrador. No se reemplazó el trabajo actual.');
      const restored = draft.snapshot;
      revision = Math.max(revision, restored.revision) + 1;
      session = { ...restored.session!, status: 'active', recording: 'stopped', revision, lastActivityAt: now() };
      delete session.endedAt;
      steps = restored.steps; events = restored.events.map(event => event.kind === 'fetch' && event.outcome === 'pending'
        ? { ...event, outcome: 'incomplete' as const } : event);
      findings = restored.findings; artifacts = restored.artifacts;
      reviewCase = restored.case;
      // Restoring does not grant approval to a different live revision.
      if (reviewCase) { reviewCase.status = 'draft'; delete reviewCase.preparedRevision; delete reviewCase.approvedProposalId; }
      privacyRevision = null; bytesStored = restored.bytesStored;
      droppedEvents = restored.partial.droppedEvents;
      partialReasons = restored.partial.reasons.filter(reason => reason !== 'Hay capturas fallidas o ausentes.');
      currentLocation = clone(session.scope);
      binaries.clear(); originalStatuses.clear(); requests.clear(); pending.clear(); identifiers.clear();
      for (const file of draft.files) binaries.set(file.id, new Uint8Array(file.bytes));
      for (const item of draft.excludedStatuses ?? []) originalStatuses.set(item.id, item.status);
      for (const item of [session, ...steps, ...events, ...findings, ...artifacts]) identifiers.add(item.id);
      notify();
      return ok(getSnapshot());
    },
    startSession(input) {
      const previous = preflight<ReviewSession>('startSession', input, false); if (previous) return previous;
      if (session?.status === 'active') return error('SESSION_ALREADY_ACTIVE', 'Ya hay una sesión de revisión activa.');
      const reviewScope = scope(input.scope);
      const objective = sanitizeReviewText(input.objective, 1_000);
      const who = actor(input.actor, input.attribution);
      if (!reviewScope || !objective || !who) return error('INVALID_INPUT', 'La sesión necesita objetivo, alcance y autoría válidos.');
      reviewCase = undefined;
      steps = []; events = []; findings = []; artifacts = []; bytesStored = 0; droppedEvents = 0; partialReasons = []; binaries.clear(); originalStatuses.clear();
      currentLocation = clone(reviewScope);
      session = { id: id('session'), objective, scope: reviewScope, ...who, ...observation(), status: 'active', recording: 'off', startedAt: now(), lastActivityAt: now(), revision };
      return commit('startSession', input, session);
    },
    updateRecording(input) {
      const previous = preflight<ReviewSession>('updateRecording', input, false); if (previous) return previous;
      if (!session) return error('SESSION_NOT_FOUND', 'Elegí una grabación para editar.');
      if ((input.title !== undefined && typeof input.title !== 'string') || (input.notes !== undefined && typeof input.notes !== 'string'))
        return error('INVALID_INPUT', 'El nombre y las notas deben ser texto.');
      if (input.networkRecording !== undefined && typeof input.networkRecording !== 'boolean') return error('INVALID_INPUT', 'El registro de red necesita un valor booleano.');
      const title = input.title === undefined ? session.objective : sanitizeReviewText(input.title, 200);
      if (!title) return error('INVALID_INPUT', 'La grabación necesita un nombre.');
      session.objective = title;
      if (input.notes !== undefined) session.notes = sanitizeReviewText(input.notes, 4000);
      if (input.networkRecording !== undefined) session.networkRecording = input.networkRecording;
      return commit('updateRecording', input, session, true);
    },
    updateNetworkEvent(input) {
      const previous = preflight<ReviewEvent>('updateNetworkEvent', input, false); if (previous) return previous;
      const event = events.find(item => item.id === input.eventId && item.kind === 'fetch');
      if (!event) return error('REFERENCE_NOT_FOUND', 'La consulta no pertenece a esta grabación.');
      if (input.outcome !== undefined && !OUTCOMES.includes(input.outcome)) return error('INVALID_INPUT', 'El resultado no es válido.');
      if (input.status !== undefined && input.status !== null && (!Number.isInteger(input.status) || input.status < 100 || input.status > 599))
        return error('INVALID_INPUT', 'El estado HTTP no es válido.');
      if (input.durationMs !== undefined && input.durationMs !== null && (!Number.isFinite(input.durationMs) || input.durationMs < 0))
        return error('INVALID_INPUT', 'La duración no es válida.');
      if (input.outcome !== undefined) event.outcome = input.outcome;
      if (input.status !== undefined) event.status = ['success', 'http_error'].includes(event.outcome ?? '') ? input.status : null;
      if (input.durationMs !== undefined) event.durationMs = input.durationMs === null ? null : Math.round(input.durationMs);
      const requestBody = sanitizeActivityBody(input.requestBody), responseBody = sanitizeActivityBody(input.responseBody);
      if (requestBody) event.requestBody = requestBody;
      if (responseBody) event.responseBody = responseBody;
      return commit('updateNetworkEvent', input, event, true);
    },
    startCase(input) {
      const previous = preflight<ReviewCase>('startCase', input, false); if (previous) return previous;
      if (session?.recording === 'active') return error('RECORDING_NOT_AUTHORIZED', 'Detené la grabación antes de comenzar otro caso.');
      if (pending.size) return error('CAPABILITY_UNAVAILABLE', 'Esperá a que termine la captura antes de comenzar otro caso.');
      const reviewScope = scope(input.scope), original = originalFields(input);
      if (!reviewScope || !original || !['test', 'design', 'report'].includes(input.mode)) return error('INVALID_INPUT', 'Elegí una intención y escribí un título para comenzar.');
      steps = []; events = []; findings = []; artifacts = []; bytesStored = 0; droppedEvents = 0; partialReasons = []; binaries.clear(); originalStatuses.clear();
      currentLocation = clone(reviewScope);
      session = { id: id('session'), objective: original.title, scope: reviewScope, ...observation(), actor: 'user', attribution: 'declared', status: 'active', recording: 'off', startedAt: now(), lastActivityAt: now(), revision };
      reviewCase = { id: session.id, mode: input.mode, status: 'draft', original };
      return commit('startCase', input, reviewCase, true);
    },
    updateCase(input) {
      const previous = casePreflight('updateCase', input); if (previous) return previous;
      const original = originalFields(input, reviewCase!.original);
      if (!original) return error('INVALID_INPUT', 'El caso necesita un título y campos de texto válidos.');
      reviewCase!.original = original; reviewCase!.status = 'draft';
      // Keep the last proposal as review history. Its wording is not current
      // or approved until it is explicitly resubmitted against a prepared case.
      delete reviewCase!.preparedRevision; delete reviewCase!.approvedProposalId;
      session!.objective = original.title;
      return commit('updateCase', input, reviewCase!, true);
    },
    prepareCase(input) {
      const previous = casePreflight('prepareCase', input); if (previous) return previous;
      if (session!.recording === 'active') return error('RECORDING_NOT_AUTHORIZED', 'Detené la grabación antes de enviar el caso al chat.');
      if (pending.size) return error('CAPABILITY_UNAVAILABLE', 'Esperá a que termine la captura antes de preparar el caso.');
      reviewCase!.status = 'prepared'; reviewCase!.preparedRevision = revision + 1;
      delete reviewCase!.approvedProposalId;
      return commit('prepareCase', input, reviewCase!, true);
    },
    submitRefinement(input) {
      const previous = casePreflight('submitRefinement', input); if (previous) return previous;
      if (reviewCase!.status !== 'prepared' && reviewCase!.status !== 'proposed') return error('REVISION_CONFLICT', 'Prepará el caso actual antes de recibir una propuesta del chat.');
      const proposal = input.proposal;
      if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return error('INVALID_INPUT', 'La propuesta necesita título, pasos y comportamiento esperado.');
      const original = originalFields({ title: proposal.title, steps: proposal.steps, expected: proposal.expected });
      if (!original || typeof proposal.expected !== 'string' || !Array.isArray(proposal.steps)
        || (proposal.summary !== undefined && typeof proposal.summary !== 'string') || (proposal.details !== undefined && typeof proposal.details !== 'string')
        || (proposal.sourceDocIds !== undefined && (!Array.isArray(proposal.sourceDocIds) || proposal.sourceDocIds.length > 30 || !proposal.sourceDocIds.every(validId))))
        return error('INVALID_INPUT', 'La propuesta contiene campos o referencias inválidas.');
      reviewCase!.proposal = { id: `proposal-${revision + 1}`, basedOnRevision: reviewCase!.preparedRevision!,
        title: original.title, steps: original.steps, expected: original.expected,
        summary: sanitizeReviewText(proposal.summary, 4_000), details: sanitizeReviewText(proposal.details, 4_000),
        sourceDocIds: [...new Set(proposal.sourceDocIds ?? [])], createdAt: now() };
      reviewCase!.status = 'proposed'; delete reviewCase!.approvedProposalId;
      return commit('submitRefinement', input, reviewCase!, true);
    },
    approveRefinement(input) {
      const previous = casePreflight('approveRefinement', input); if (previous) return previous;
      if (reviewCase!.status !== 'proposed' || !reviewCase!.proposal || input.proposalId !== reviewCase!.proposal.id)
        return error('REVISION_CONFLICT', 'La propuesta cambió. Revisá la versión actual antes de aprobar.');
      reviewCase!.status = 'approved'; reviewCase!.approvedProposalId = reviewCase!.proposal.id;
      return commit('approveRefinement', input, reviewCase!, true);
    },
    startRecording(input) {
      const previous = preflight<ReviewSession>('startRecording', input); if (previous) return previous;
      if (input.authorized !== true) return error('RECORDING_NOT_AUTHORIZED', 'La grabación requiere autorización explícita.');
      if (input.scope !== undefined) {
        const requestedScope = scope(input.scope);
        if (!requestedScope || requestedScope.origin !== session!.scope.origin || requestedScope.pathname !== session!.scope.pathname
          || requestedScope.targetId !== session!.scope.targetId) return error('RECORDING_NOT_AUTHORIZED', 'El alcance de grabación no coincide con la sesión autorizada.');
      }
      if (session!.recording === 'active') return remember('startRecording', input, ok(session!));
      session!.recording = 'active';
      return commit('startRecording', input, session!);
    },
    stopRecording(input) {
      const previous = preflight<ReviewSession>('stopRecording', input); if (previous) return previous;
      if (session!.recording !== 'active') return remember('stopRecording', input, ok(session!));
      session!.recording = 'stopped';
      for (const event of events) if (event.kind === 'fetch' && event.outcome === 'pending') event.outcome = 'incomplete';
      return commit('stopRecording', input, session!);
    },
    endSession(input) {
      const previous = preflight<ReviewSession>('endSession', input); if (previous) return previous;
      session!.status = 'ended'; session!.endedAt = now();
      if (session!.recording === 'active') session!.recording = 'stopped';
      for (const event of events) if (event.kind === 'fetch' && event.outcome === 'pending') event.outcome = 'incomplete';
      return commit('endSession', input, session!);
    },
    checkpoint, removeStep, recordEvent, addArtifact, addFinding,
    setEvidenceExcluded(input) {
      const previous = preflight<EvidenceArtifact>('setEvidenceExcluded', input, false); if (previous) return previous;
      const artifact = artifacts.find(item => item.id === input.artifactId);
      if (!artifact) return error('ARTIFACT_NOT_FOUND', 'La evidencia indicada no existe.');
      if (typeof input.excluded !== 'boolean') return error('INVALID_INPUT', 'excluded debe ser un valor booleano.');
      if (input.excluded && artifact.status !== 'excluded') { originalStatuses.set(artifact.id, artifact.status); artifact.status = 'excluded'; }
      else if (!input.excluded && artifact.status === 'excluded') { artifact.status = originalStatuses.get(artifact.id) ?? 'missing'; originalStatuses.delete(artifact.id); }
      return commit('setEvidenceExcluded', input, artifact);
    },
    updateNotes(input) {
      const previous = preflight<EvidenceArtifact | ReviewStep>('updateNotes', input, false); if (previous) return previous;
      if (typeof input.notes !== 'string' || Boolean(input.artifactId) === Boolean(input.stepId)) return error('INVALID_INPUT', 'Elegí un único paso o archivo para editar sus notas.');
      const item = input.artifactId ? artifacts.find(value => value.id === input.artifactId) : steps.find(value => value.id === input.stepId);
      if (!item) return error('REFERENCE_NOT_FOUND', 'No se encontró el paso o archivo indicado.');
      item.notes = sanitizeReviewText(input.notes, 4_000);
      return commit('updateNotes', input, item);
    },
    reviewPrivacy(input) {
      const previous = preflight<ReviewSnapshot>('reviewPrivacy', input, false); if (previous) return previous;
      if (!session) return error('SESSION_NOT_ACTIVE', 'No hay una sesión para revisar.');
      if (typeof input.confirmed !== 'boolean') return error('INVALID_INPUT', 'La confirmación de privacidad debe ser un valor booleano.');
      if (!Number.isInteger(input.expectedRevision)) return error('INVALID_INPUT', 'La revisión de privacidad necesita expectedRevision.');
      changed(false); privacyRevision = input.confirmed ? revision : null;
      const result = remember('reviewPrivacy', input, ok(getSnapshot()));
      notify(); return result;
    },
    readArtifact(artifactId) { return validId(artifactId) && binaries.has(artifactId) ? new Uint8Array(binaries.get(artifactId)!) : null; },
    freezeForExport(input): ReviewResult<FrozenReview> {
      if (!input || !Number.isInteger(input.expectedRevision) || input.expectedRevision !== revision) return error('REVISION_CONFLICT', 'La revisión cambió antes de preparar el paquete.');
      if (!session) return error('SESSION_NOT_ACTIVE', 'No hay una sesión para exportar.');
      if (privacyRevision !== revision) return error('PRIVACY_REVIEW_REQUIRED', 'Revisá la privacidad de esta revisión antes de exportar.');
      const frozenSnapshot = getSnapshot();
      const frozenBinaries = new Map(artifacts.filter(item => item.status === 'available' && binaries.has(item.id)).map(item => [item.id, new Uint8Array(binaries.get(item.id)!)]));
      return { status: 'ok', sessionId: session.id, revision, data: { snapshot: frozenSnapshot,
        readArtifact: artifactId => validId(artifactId) && frozenBinaries.has(artifactId) ? new Uint8Array(frozenBinaries.get(artifactId)!) : null } };
    },
    updateLocation(value) {
      const location = scope(value);
      if (!location) return;
      const changedLocation = currentLocation && (currentLocation.origin !== location.origin || currentLocation.pathname !== location.pathname || currentLocation.targetId !== location.targetId);
      currentLocation = location;
      // Sessions follow same-origin application routes. Images still bind to the
      // exact path observed when capture began, and other origins stay forbidden.
      if (changedLocation && session) {
        const routeChanged = session.scope.origin === location.origin && session.scope.pathname !== location.pathname;
        if (routeChanged) {
          session.scope.pathname = location.pathname;
          delete session.scope.targetId;
          if (session.status === 'active' && session.recording === 'active' && events.length + steps.length < limits.maxEvents)
            steps.push({ id: id('step'), sessionId: session.id, ...observation(), label: sanitizeReviewText(createTranslator(typeof options.locale === 'function' ? options.locale() : options.locale ?? 'en')('Navegó a {path}', { path: location.pathname }), 200), at: now(), pathname: location.pathname,
              actor: 'unknown', attribution: 'unknown', simulated: false, artifactIds: [], notes: '' });
        }
        changed(); notify();
      }
    },
    invalidateContext() { if (session) { changed(); notify(); } },
  };
}
