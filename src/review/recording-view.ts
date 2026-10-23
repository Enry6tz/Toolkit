import type { ReviewEvent, ReviewStep } from './types.js';
import { sanitizeActivityBody } from '../core/activity.js';
import type { Translate } from '../core/locale.js';

/** A MIME-backed presentation label, never a replacement for the stored resource. */
export function recordingResource(event: Pick<ReviewEvent, 'resource' | 'responseBody'>, t: Translate): string {
  if (event.resource && event.resource !== 'Recurso no identificado') return event.resource;
  return t(event.responseBody?.contentType === 'text/x-component' ? 'Navegación del framework' : 'Recurso no identificado');
}

/** Inspect complete Flight error rows only; quoted model text and length-delimited text are data. */
export function flightErrorDiagnostic(event: Pick<ReviewEvent, 'responseBody'>): boolean {
  const body = sanitizeActivityBody(event.responseBody);
  if (body?.contentType !== 'text/x-component' || !body.text) return false;
  const bytes = new TextEncoder().encode(body.text), decoder = new TextDecoder();
  let offset = 0;
  while (offset < bytes.length) {
    const colon = bytes.indexOf(58, offset);
    if (colon < 0 || colon - offset > 16 || !/^[0-9a-f]+$/i.test(decoder.decode(bytes.subarray(offset, colon)))) return false;
    const tag = bytes[colon + 1];
    if (tag === undefined) return false;
    const start = colon + 2;
    if ('TAOobUSsLlGgMmV'.includes(String.fromCharCode(tag))) {
      const comma = bytes.indexOf(44, start);
      if (comma < 0 || comma - start > 8) return false;
      const size = decoder.decode(bytes.subarray(start, comma));
      if (!/^[0-9a-f]+$/i.test(size)) return false;
      offset = comma + 1 + Number.parseInt(size, 16);
      if (offset > bytes.length) return false;
      continue;
    }
    const end = bytes.indexOf(10, start);
    if (end < 0) return false;
    if (tag === 69) {
      try {
        const value: unknown = JSON.parse(decoder.decode(bytes.subarray(start, end)));
        if (value && typeof value === 'object' && !Array.isArray(value)
          && 'digest' in value && typeof value.digest === 'string') return true;
      } catch { /* A partial or malformed row is not a confirmed Flight diagnostic. */ }
    }
    offset = end + 1;
  }
  return false;
}

/** Presentation only. Every request remains in the recording and its JSON. */
export function routineFrameworkQuery(event: ReviewEvent): boolean {
  return event.kind === 'fetch' && event.responseBody?.contentType === 'text/x-component'
    && event.outcome === 'success' && !event.simulated && event.status !== undefined && event.status !== null && event.status >= 200 && event.status < 300
    && !flightErrorDiagnostic(event);
}

export function recordingSteps(steps: readonly ReviewStep[], events: readonly ReviewEvent[], compact: boolean): ReviewStep[] {
  if (!compact) return [...steps];
  const byStep = new Map<string, ReviewEvent[]>();
  for (const event of events) if (event.kind === 'fetch' && event.stepId) {
    const list = byStep.get(event.stepId) ?? []; list.push(event); byStep.set(event.stepId, list);
  }
  return steps.filter(step => {
    if (step.recordingBoundary) return false;
    const queries = byStep.get(step.id);
    // Only an automatically named request step can recede. Real clicks, notes,
    // selections, errors, pending requests and simulations always remain visible.
    return !!step.targetId || !!step.notes || !queries?.length || !queries.every(event => routineFrameworkQuery(event)
      && step.label === `${event.method ?? 'OTHER'} ${event.resource ?? 'Recurso no identificado'}`);
  });
}
