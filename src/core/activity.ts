import { sanitizeText } from './privacy.js';

export type ActivityMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface ActivityResource {
  /** An abstract, public label. Request URLs are never included in the trace. */
  name: string;
  /** Exact same-origin pathname, optionally containing single-segment :parameters. */
  path: string;
  method?: ActivityMethod;
}

export interface ActivityConfig {
  resources: readonly ActivityResource[];
  /** Clamped to 1–50. Defaults to 50. */
  maxEntries?: number;
  /** Observe every fetch initiated while recording, including background requests. Defaults to true. */
  recordNetwork?: boolean;
  /** Request and response previews are captured only while recording. Defaults to true. */
  captureBodies?: boolean;
  /** Maximum characters per body. Clamped to 1–64000; defaults to 8000. */
  maxBodyChars?: number;
  /** Maximum retained body characters for this recording. Defaults to 128000. */
  maxNetworkChars?: number;
}

export type ActivityNetworkSimulation = 'normal' | 'slow' | 'offline';
export type NetworkSimulation = ActivityNetworkSimulation;
export interface ActivityBody {
  status: 'captured' | 'truncated' | 'omitted';
  text?: string;
  contentType?: string;
  charLimit: number;
  redacted?: true;
  reason?: 'disabled' | 'empty' | 'binary' | 'stream' | 'unavailable' | 'read_error' | 'recording_stopped' | 'network_limit' | 'framework_limit';
}

export interface ActivityInteractionEntry {
  id: string;
  kind: 'interaction';
  at: string;
  label: string;
  /** Present only when the app explicitly marks an action as simulated. */
  simulated?: boolean;
}

export interface ActivityFetchEntry {
  id: string;
  kind: 'fetch';
  /** Request initiation time, including while a request is still pending. */
  at: string;
  resource: string;
  method: ActivityMethod | 'OTHER';
  status: number | null;
  outcome: 'pending' | 'success' | 'http_error' | 'network_error' | 'aborted' | 'incomplete';
  durationMs: number | null;
  interactionId: string | null;
  /** A time association, never a claim of causation. */
  correlation: 'temporal' | null;
  /** Inherited only from the explicitly marked temporally associated action. */
  simulated?: boolean;
  simulation?: Exclude<ActivityNetworkSimulation, 'normal'>;
  requestBody?: ActivityBody;
  responseBody?: ActivityBody;
}

export type ActivityEntry = ActivityInteractionEntry | ActivityFetchEntry;

export const UNKNOWN_ACTIVITY_RESOURCE = 'Recurso no identificado';
/** Bounded static aliases. This does not increase event or body capture budgets. */
export const ACTIVITY_RESOURCE_LIMIT = 100;
const METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const OUTCOMES: readonly string[] = ['pending', 'success', 'http_error', 'network_error', 'aborted', 'incomplete'];
const ENTRY_ID = /^activity-\d{1,10}-\d{1,10}$/;

export function activityEntryLimit(value?: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(50, Math.floor(value))) : 50;
}

export function activityBodyLimit(value?: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(64_000, Math.floor(value))) : 8000;
}
export function activityNetworkLimit(value?: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(2_000_000, Math.floor(value))) : 128_000;
}
const BODY_REASONS: readonly string[] = ['disabled', 'empty', 'binary', 'stream', 'unavailable', 'read_error', 'recording_stopped', 'network_limit', 'framework_limit'];
const SENSITIVE_KEY = /^(?:authorization|proxyauthorization|cookie|setcookie|password|passwd|pwd|secret|clientsecret|accesstoken|refreshtoken|idtoken|apikey|apiaccesskey|privatekey|serverkey|sessionid|sessiontoken|token|(?:bootstrap|runtime|binding)(?:token|secret|credential)|(?:presence|collaboration|execution)?ticket|csrftoken|xsrftoken)$/i;
export function sensitiveActivityKey(value: string): boolean { return SENSITIVE_KEY.test(value.replace(/[-_.\s]/g, '')); }

/** Bounded previews retain useful application data while masking credential fields. */
export function sanitizeActivityBody(value: unknown, limit?: number): ActivityBody | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (!['captured', 'truncated', 'omitted'].includes(String(input.status))) return undefined;
  const charLimit = activityBodyLimit(limit ?? (typeof input.charLimit === 'number' ? input.charLimit : undefined));
  const contentType = typeof input.contentType === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(input.contentType.slice(0, 100))
    ? input.contentType.slice(0, 100).toLowerCase() : undefined;
  const common = { charLimit, ...(contentType ? { contentType } : {}) };
  if (input.status === 'omitted') return { ...common, status: 'omitted', reason: BODY_REASONS.includes(String(input.reason)) ? input.reason as ActivityBody['reason'] & string : 'unavailable' };
  if (typeof input.text !== 'string') return undefined;
  let text = input.text.slice(0, charLimit + 1).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  let redacted = input.redacted === true;
  const clipped = input.text.length > charLimit;
  const protectText = (text: string) => text.replace(/((?:"|')?(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|password|passwd|pwd|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|private[-_]?key|server[-_.\s]*key|session[-_]?(?:id|token)|(?:bootstrap|runtime|binding)[-_.\s]*(?:token|secret|credential)|token|(?:(?:presence|collaboration|execution)[-_.\s]*)?ticket|csrf[-_]?token|xsrf[-_]?token)(?:"|')?\s*[:=]\s*)("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|\[oculto\]|[^,\r\n&}\]]*)/gi,
    (_all, prefix: string) => { redacted = true; return `${prefix}"[oculto]"`; })
    .replace(/\bBearer\s+[a-z0-9._~+\/-]+=*/gi, () => { redacted = true; return 'Bearer [oculto]'; })
    .replace(/\bRuntime\s+[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}\b/gi, () => { redacted = true; return 'Runtime [oculto]'; })
    .replace(/\basp_(?:server|session)_[a-z0-9_-]+/gi, () => { redacted = true; return '[oculto]'; });
  const protect = (candidate: unknown, depth: number): unknown => {
    if (depth > 32) return '[profundidad omitida]';
    if (Array.isArray(candidate)) return candidate.map(item => protect(item, depth + 1));
    if (candidate && typeof candidate === 'object') return Object.fromEntries(Object.entries(candidate).map(([key, item]) => {
      if (sensitiveActivityKey(key)) { redacted = true; return [key, '[oculto]']; }
      return [key, protect(item, depth + 1)];
    }));
    return typeof candidate === 'string' ? protectText(candidate) : candidate;
  };
  try { text = JSON.stringify(protect(JSON.parse(text), 0)); }
  // Plain text and incomplete JSON are protected without parsing an unbounded original.
  catch { text = protectText(text); }
  return { ...common, status: input.status === 'truncated' || clipped || text.length > charLimit ? 'truncated' : 'captured', text: text.slice(0, charLimit), ...(redacted ? { redacted: true } : {}), ...(input.reason === 'network_limit' || input.reason === 'framework_limit' ? { reason: input.reason } : {}) };
}

/** Additional URL removal applies to labels as well as the explicit field whitelist. */
export function sanitizeActivityLabel(value: string, limit = 120): string {
  return sanitizeText(value
    .slice(0, 2_000)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/gi, '[URL omitida]')
    .replace(/(?:^|\s)\/\/[^\s<>]+/g, ' [URL omitida]')
    .replace(/\s+/g, ' '), limit);
}

export function normalizeActivityMethod(value: unknown): ActivityMethod | 'OTHER' {
  if (typeof value !== 'string') return 'OTHER';
  const method = value.slice(0, 20).toUpperCase();
  return METHODS.includes(method) ? method as ActivityMethod : 'OTHER';
}

function validResourcePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 500 && value.startsWith('/')
    && !/[?#\\]/.test(value) && value.split('/').every(part =>
      part.startsWith(':') ? /^:[a-z][a-z0-9_]*$/i.test(part) : /^[a-z0-9._~-]*$/i.test(part));
}

/** Copies only supported configuration fields; invalid aliases simply never match. */
export function normalizeActivityConfig(value: unknown): ActivityConfig {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const resources: ActivityResource[] = [];
  for (const candidate of Array.isArray(input.resources) ? input.resources.slice(0, ACTIVITY_RESOURCE_LIMIT) : []) {
    if (!candidate || typeof candidate !== 'object') continue;
    const resource = candidate as Record<string, unknown>;
    if (!validResourcePath(resource.path) || typeof resource.name !== 'string') continue;
    if (resource.method !== undefined && !METHODS.includes(resource.method as string)) continue;
    const name = sanitizeActivityLabel(resource.name, 80);
    if (!name) continue;
    resources.push({ name, path: resource.path, ...(resource.method !== undefined ? { method: resource.method as ActivityMethod } : {}) });
  }
  return { resources, maxEntries: activityEntryLimit(typeof input.maxEntries === 'number' ? input.maxEntries : undefined),
    recordNetwork: input.recordNetwork !== false,
    captureBodies: input.captureBodies !== false,
    maxBodyChars: activityBodyLimit(typeof input.maxBodyChars === 'number' ? input.maxBodyChars : undefined),
    maxNetworkChars: activityNetworkLimit(typeof input.maxNetworkChars === 'number' ? input.maxNetworkChars : undefined) };
}

/** Only a configured alias leaves this function; the pathname is never returned. */
export function resolveActivityResource(config: ActivityConfig, method: unknown, pathname: string): string {
  if (typeof pathname !== 'string' || pathname.length > 2_000 || /[?#\\]/.test(pathname)) return UNKNOWN_ACTIVITY_RESOURCE;
  const verb = normalizeActivityMethod(method);
  const resources = Array.isArray(config?.resources) ? config.resources.slice(0, ACTIVITY_RESOURCE_LIMIT) : [];
  for (const resource of resources) {
    if (!resource || typeof resource.path !== 'string' || typeof resource.name !== 'string') continue;
    if (resource.method !== undefined && resource.method !== verb) continue;
    const pattern = resource.path;
    if (!validResourcePath(pattern)) continue;
    const expected = pattern.split('/');
    const actual = pathname.split('/');
    if (expected.length !== actual.length) continue;
    const matches = expected.every((part, index) => {
      if (part.startsWith(':')) return /^:[a-z][a-z0-9_]*$/i.test(part) && Boolean(actual[index]);
      return /^[a-z0-9._~-]*$/i.test(part) && part === actual[index];
    });
    if (!matches) continue;
    const label = sanitizeActivityLabel(resource.name, 80);
    if (label) return label;
  }
  return UNKNOWN_ACTIVITY_RESOURCE;
}

function entryId(value: unknown): string | null {
  return typeof value === 'string' && ENTRY_ID.test(value) ? value : null;
}

function entryDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function duration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(value))) : null;
}

/** Whitelists every serialized field; imported objects cannot smuggle request details. */
export function sanitizeActivityEntries(value: unknown, maxEntries?: number): readonly ActivityEntry[] {
  if (!Array.isArray(value)) return [];
  const limit = activityEntryLimit(maxEntries);
  const entries: ActivityEntry[] = [];
  const identifiers = new Set<string>();
  // Bound work even for hostile imported arrays. Preserve the newest valid entries.
  for (let index = value.length - 1; index >= Math.max(0, value.length - 200) && entries.length < limit; index -= 1) {
    const candidate = value[index] as Record<string, unknown> | null;
    if (!candidate || typeof candidate !== 'object') continue;
    const id = entryId(candidate.id);
    const at = entryDate(candidate.at);
    if (!id || !at || identifiers.has(id)) continue;
    if (candidate.kind === 'interaction') {
      const label = typeof candidate.label === 'string' ? sanitizeActivityLabel(candidate.label) : '';
      if (!label) continue;
      entries.push({ id, kind: 'interaction', at, label, ...(candidate.simulated === true ? { simulated: true } : {}) });
    } else if (candidate.kind === 'fetch') {
      if (typeof candidate.outcome !== 'string' || !OUTCOMES.includes(candidate.outcome)) continue;
      const outcome = candidate.outcome as ActivityFetchEntry['outcome'];
      const status = typeof candidate.status === 'number' && Number.isInteger(candidate.status)
        && (candidate.status === 0 || (candidate.status >= 100 && candidate.status <= 599)) ? candidate.status : null;
      const interactionId = entryId(candidate.interactionId);
      const resource = typeof candidate.resource === 'string' ? sanitizeActivityLabel(candidate.resource, 80) : '';
      const requestBody = sanitizeActivityBody(candidate.requestBody), responseBody = sanitizeActivityBody(candidate.responseBody);
      entries.push({
        id, kind: 'fetch', at, resource: resource || UNKNOWN_ACTIVITY_RESOURCE,
        method: normalizeActivityMethod(candidate.method),
        status: outcome === 'success' || outcome === 'http_error' ? status : null,
        outcome, durationMs: outcome === 'pending' ? null : duration(candidate.durationMs),
        interactionId: candidate.correlation === 'temporal' ? interactionId : null,
        correlation: candidate.correlation === 'temporal' && interactionId ? 'temporal' : null,
        ...(candidate.simulated === true ? { simulated: true } : {}),
        ...(candidate.simulation === 'slow' || candidate.simulation === 'offline' ? { simulated: true, simulation: candidate.simulation } : {}),
        ...(requestBody ? { requestBody } : {}),
        ...(responseBody ? { responseBody } : {}),
      });
    } else continue;
    identifiers.add(id);
  }
  entries.reverse();
  const interactions = new Set(entries.filter(entry => entry.kind === 'interaction').map(entry => entry.id));
  return entries.map(entry => entry.kind === 'fetch' && entry.interactionId && !interactions.has(entry.interactionId)
    ? { ...entry, interactionId: null, correlation: null } : entry);
}
