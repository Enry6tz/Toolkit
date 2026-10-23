import type { ToolbarLocale } from '../core/locale.js';

export type BodyCoverage = 'captured' | 'truncated' | 'omitted' | 'empty' | 'unclassified';
export type BodyCoverageReason = 'disabled' | 'binary' | 'stream' | 'unavailable' | 'read_error' | 'recording_stopped' | 'network_limit' | 'framework_limit';
export interface BodyCoverageCounts { captured: number; truncated: number; omitted: number; empty: number; unclassified: number }
export interface RecordingQuality {
  requests: number;
  affectedRequests: number;
  frameworkRequests: number;
  requestBodies: BodyCoverageCounts;
  responseBodies: BodyCoverageCounts;
  reasons: Partial<Record<BodyCoverageReason, number>>;
  eventCoverage: 'no-reported-loss' | 'partial' | 'unknown';
  droppedEvents: number | null;
  networkCoverage: 'limited' | 'unclassified' | 'recorded' | 'none';
}
const reasons = new Set<BodyCoverageReason>(['disabled', 'binary', 'stream', 'unavailable', 'read_error', 'recording_stopped', 'network_limit', 'framework_limit']);
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function counts(): BodyCoverageCounts { return { captured: 0, truncated: 0, omitted: 0, empty: 0, unclassified: 0 }; }
function body(value: unknown): { coverage: BodyCoverage; reason?: BodyCoverageReason; framework: boolean } {
  const entry = object(value);
  if (!entry) return { coverage: 'unclassified', framework: false };
  const framework = entry.contentType === 'text/x-component';
  const reason = typeof entry.reason === 'string' && reasons.has(entry.reason as BodyCoverageReason) ? entry.reason as BodyCoverageReason : undefined;
  if (entry.status === 'omitted' && entry.reason === 'empty') return { coverage: 'empty', framework };
  if (entry.status === 'omitted') return { coverage: 'omitted', ...(reason ? { reason } : {}), framework };
  if ((entry.status === 'captured' || entry.status === 'truncated') && typeof entry.text === 'string') return { coverage: entry.status, ...(entry.status === 'truncated' && reason ? { reason } : {}), framework };
  return { coverage: 'unclassified', framework };
}
/** Derived presentation only. Never rewrites partial, metadata, evidence bodies or aliases. */
export function recordingQuality(input: unknown): RecordingQuality | null {
  const source = object(input);
  if (!source || !Array.isArray(source.events) || source.events.length > 5000) return null;
  const partial = object(source.partial);
  const droppedEvents = typeof partial?.droppedEvents === 'number' && Number.isSafeInteger(partial.droppedEvents) && partial.droppedEvents >= 0 ? partial.droppedEvents : null;
  const quality: RecordingQuality = {
    requests: 0, affectedRequests: 0, frameworkRequests: 0, requestBodies: counts(), responseBodies: counts(), reasons: {}, droppedEvents,
    eventCoverage: partial?.isPartial === true || (droppedEvents !== null && droppedEvents > 0) ? 'partial' : partial?.isPartial === false && droppedEvents === 0 ? 'no-reported-loss' : 'unknown',
    networkCoverage: 'none',
  };
  for (const value of source.events) {
    const event = object(value);
    if (event?.kind !== 'fetch') continue;
    quality.requests++;
    const request = body(event.requestBody), response = body(event.responseBody);
    quality.requestBodies[request.coverage]++;
    quality.responseBodies[response.coverage]++;
    if (response.framework) quality.frameworkRequests++;
    const affected = [request, response].some((side) => side.coverage === 'truncated' || side.coverage === 'omitted');
    if (affected) quality.affectedRequests++;
    for (const side of [request, response]) if (side.reason) quality.reasons[side.reason] = (quality.reasons[side.reason] ?? 0) + 1;
  }
  quality.networkCoverage = quality.affectedRequests ? 'limited' : quality.requestBodies.unclassified + quality.responseBodies.unclassified ? 'unclassified' : quality.requests ? 'recorded' : 'none';
  return quality;
}
const text = {
  es: {
    event: { 'no-reported-loss': 'Eventos sin pérdidas registradas', partial: 'Registro parcial de eventos o capturas', unknown: 'Cobertura de eventos no verificable' },
    network: { limited: 'detalles de red limitados', unclassified: 'detalles de red sin clasificar', recorded: 'cuerpos de red clasificados', none: 'sin solicitudes registradas' },
    requests: ['solicitud', 'solicitudes'], affected: 'con detalles recortados u omitidos', request: 'Cuerpos de petición', response: 'Cuerpos de respuesta', captured: 'capturados', truncated: 'recortados', omitted: 'omitidos', empty: 'vacíos', unclassified: 'sin clasificar',
    reasonsTitle: 'Motivos por cuerpo', dropped: 'Eventos descartados',
    reasons: { disabled: 'captura desactivada', binary: 'formato binario', stream: 'streaming', unavailable: 'cuerpo no disponible', read_error: 'error al leer cuerpo', recording_stopped: 'lectura pendiente al detener', network_limit: 'presupuesto total', framework_limit: 'límite de vistas previas RSC' },
    explanation: 'El indicador parcial original describe eventos o capturas; no garantiza cuerpos completos. Las clasificaciones de petición y respuesta no son solicitudes adicionales. Estado HTTP, motivos y fuente JSON se conservan.',
  },
  en: {
    event: { 'no-reported-loss': 'No event loss reported', partial: 'Partial event or capture record', unknown: 'Event coverage not verifiable' },
    network: { limited: 'limited network details', unclassified: 'unclassified network details', recorded: 'classified network bodies', none: 'no requests recorded' },
    requests: ['request', 'requests'], affected: 'with truncated or omitted details', request: 'Request bodies', response: 'Response bodies', captured: 'captured', truncated: 'truncated', omitted: 'omitted', empty: 'empty', unclassified: 'unclassified',
    reasonsTitle: 'Reasons per body', dropped: 'Dropped events',
    reasons: { disabled: 'body capture disabled', binary: 'binary format', stream: 'streaming', unavailable: 'body unavailable', read_error: 'body read error', recording_stopped: 'read pending when stopped', network_limit: 'total body budget', framework_limit: 'RSC preview limit' },
    explanation: 'The original partial flag describes events or captures; it does not guarantee complete bodies. Request and response classifications are not additional HTTP requests. HTTP status, reasons and source JSON are preserved.',
  },
} as const;
export function recordingQualityText(quality: RecordingQuality, locale: ToolbarLocale = 'en'): { summary: string; label: string; detail: string; limited: boolean } {
  const t = text[locale];
  const parts = (side: BodyCoverageCounts) => (['captured', 'truncated', 'omitted', 'empty', 'unclassified'] as const).map((key) => `${side[key]} ${t[key]}`).join(', ');
  const label = `${t.event[quality.eventCoverage]} · ${t.network[quality.networkCoverage]}`;
  const reasonText = (Object.keys(t.reasons) as BodyCoverageReason[]).filter((key) => quality.reasons[key]).map((key) => `${t.reasons[key]}: ${quality.reasons[key]}`).join(' · ');
  const detail = [`${quality.requests} ${t.requests[quality.requests === 1 ? 0 : 1]}; ${quality.affectedRequests} ${t.affected}.`, `${t.request}: ${parts(quality.requestBodies)}.`, `${t.response}: ${parts(quality.responseBodies)}.`, reasonText ? `${t.reasonsTitle}: ${reasonText}.` : '', quality.droppedEvents ? `${t.dropped}: ${quality.droppedEvents}.` : '', t.explanation].filter(Boolean).join('\n');
  const summary = quality.eventCoverage === 'partial' ? t.event.partial : quality.networkCoverage === 'limited' || quality.networkCoverage === 'unclassified' ? t.network[quality.networkCoverage] : t.event[quality.eventCoverage];
  return { summary, label, detail, limited: quality.eventCoverage !== 'no-reported-loss' || quality.networkCoverage === 'limited' || quality.networkCoverage === 'unclassified' };
}
