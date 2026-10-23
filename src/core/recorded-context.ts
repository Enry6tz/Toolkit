import { normalizePublicQueryParams, sanitizeText, sanitizeUrl } from './privacy.js';
import type { RecordedContext } from './types.js';

/** Small, immutable public observation. Documents and editable values never travel here. */
export function sanitizeRecordedContext(input: unknown): RecordedContext | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>, build = value.build as Record<string, unknown> | undefined;
  const viewport = value.viewport as Record<string, unknown> | undefined;
  if (!build || !['development', 'preview', 'production'].includes(String(build.environment))
    || !viewport || ![viewport.width, viewport.height].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 100000)
    || typeof value.url !== 'string' || typeof value.capturedAt !== 'string' || !Number.isFinite(Date.parse(value.capturedAt))) return undefined;
  const publicQueryParams = normalizePublicQueryParams(value.publicQueryParams as string[] | undefined);
  const url = sanitizeUrl(value.url, publicQueryParams);
  if (!/^https?:\/\//.test(url)) return undefined;
  const result: RecordedContext = { capturedAt: new Date(value.capturedAt).toISOString(), url,
    build: { environment: build.environment as RecordedContext['build']['environment'] },
    viewport: { width: Math.round(Number(viewport.width)), height: Math.round(Number(viewport.height)) },
    ...(publicQueryParams.length ? { publicQueryParams } : {}) };
  for (const key of ['branch', 'buildId'] as const) if (typeof build[key] === 'string') result.build[key] = sanitizeText(build[key], 100);
  if (typeof value.appName === 'string') result.appName = sanitizeText(value.appName, 100);
  return result;
}

export function recordedRoute(context: RecordedContext | undefined, fallback: string): string {
  const safe = sanitizeRecordedContext(context);
  if (!safe) return fallback;
  const url = new URL(safe.url); return url.pathname + url.search;
}
