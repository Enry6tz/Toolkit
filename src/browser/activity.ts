import {
  activityEntryLimit, activityBodyLimit, activityNetworkLimit, normalizeActivityConfig, normalizeActivityMethod, resolveActivityResource,
  sanitizeActivityEntries, sanitizeActivityBody, sanitizeActivityLabel, sensitiveActivityKey, UNKNOWN_ACTIVITY_RESOURCE,
} from '../core/activity.js';
import type { ActivityBody, ActivityConfig, ActivityEntry, ActivityFetchEntry, ActivityNetworkSimulation } from '../core/activity.js';
import { inspectElement, isPrivateElement } from './context.js';
import { createTranslator, type ToolbarLocale, type Translate } from '../core/locale.js';

export interface ActivityRecorderOptions {
  window: Window;
  config: ActivityConfig;
  locale?: ToolbarLocale | (() => ToolbarLocale);
  onChange?: () => void;
}

export interface ActivityRecorder {
  /** Explicit recording only: creating a recorder does not attach any instrumentation. */
  start(): void;
  stop(): void;
  isRecording(): boolean;
  getEntries(): readonly ActivityEntry[];
  getSummary(): { droppedEntries: number; maxEntries: number; bodyChars: number; maxNetworkChars: number };
  /** Restore the already-used budget before continuing a saved recording. Ignored while recording. */
  seedBodyBudget(chars: number, frameworkChars?: number): void;
  /** Applies to newly initiated fetches; observed pending requests still complete. */
  setNetworkRecording(enabled: boolean): void;
  /** Update the bound for subsequent body reads, preserving the current recording. */
  setBodyLimit(chars: number): void;
  getNetworkRecording(): boolean;
  setNetworkSimulation(mode: ActivityNetworkSimulation): void;
  getNetworkSimulation(): ActivityNetworkSimulation;
  /** Ends the current action's temporal association without changing in-flight requests. */
  resetInteraction(): void;
  clear(): void;
  dispose(): void;
}

type BrowserWindow = Window & typeof globalThis;
type StoredEntry = { sequence: number; entry: ActivityEntry; started: number; generation: number; cancelBodies?: Set<() => void> };
type Session = {
  config: ActivityConfig;
  limit: number;
  entries: StoredEntry[];
  generation: number;
  recording: boolean;
  disposed: boolean;
  latestInteraction: { id: string; time: number; type: string; simulated?: true } | null;
  droppedEntries: number;
  bodyChars: number;
  frameworkBodyChars: number;
  bodyReaders: Set<() => void>;
  simulation: ActivityNetworkSimulation;
  recordNetwork: boolean;
  translate: Translate;
  notify(): void;
};
type Hub = {
  window: BrowserWindow;
  number: number;
  sequence: number;
  sessions: Set<Session>;
  original: typeof fetch;
  wrapper: typeof fetch;
  interaction(event: Event): void;
};

const hubs = new WeakMap<Window, Hub>();
let nextHub = 0;

/** Toolkit configuration traffic belongs to the control plane, never to an application recording. */
export function fetchOutsideRecording(view: Window, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return (hubs.get(view)?.original ?? view.fetch).call(view, input, init);
}

function safely(action: () => void): void { try { action(); } catch { /* Observing must never interrupt the application. */ } }
function now(hub: Hub): number {
  try { return hub.window.performance.now(); } catch { return Date.now(); }
}
function identity(hub: Hub): { id: string; sequence: number } {
  const sequence = ++hub.sequence;
  return { id: `activity-${hub.number}-${sequence}`, sequence };
}
function append(session: Session, item: StoredEntry): void {
  // Flush an unfinished request while it is still readable by observers. Removing
  // it first would make its eventual response disappear from the durable trace.
  // Its result is unknown at this boundary; later completion must not rewrite it.
  while (session.entries.length >= session.limit) {
    const oldest = session.entries[0]!;
    for (const cancel of oldest.cancelBodies ?? []) cancel();
    if (oldest.entry.kind === 'fetch' && oldest.entry.outcome === 'pending') {
      oldest.entry = { ...oldest.entry, outcome: 'incomplete', durationMs: Math.max(0, Math.round(item.started - oldest.started)) };
      session.notify();
      // An observer can stop, clear, or dispose the recording while ingesting.
      if (!session.recording || session.disposed || session.generation !== item.generation) return;
    }
    // A reentrant observer may have already removed this item. Never shift a
    // different request before giving that request the same incomplete flush.
    if (session.entries[0] === oldest) { session.entries.shift(); session.droppedEntries++; }
  }
  session.entries.push(item);
  session.notify();
}

/** Public label text only. Editable descendants remain excluded by the normal inspector policy. */
function publicLabelText(element: Element): string {
  if (isPrivateElement(element)) return '';
  const parts: string[] = [];
  const stack: Array<{ node: Node; depth: number }> = [{ node: element, depth: 0 }];
  let visited = 0, length = 0;
  while (stack.length && visited < 120 && length < 400) {
    const { node, depth } = stack.pop()!;
    visited++;
    if (node.nodeType === 3) {
      const part = (node.nodeValue ?? '').slice(0, 400 - length);
      parts.push(part); length += part.length;
    } else if (node.nodeType === 1 && depth < 16) {
      if (isPrivateElement(node as Element)) continue;
      const children = node.childNodes;
      for (let index = Math.min(children.length, 120 - visited - stack.length) - 1; index >= 0; index--) {
        const child = children.item(index);
        if (child) stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return sanitizeActivityLabel(parts.join(' '), 100);
}

/** Observes a committed change, never the control's current/previous value or option text. */
function controlChangeLabel(hub: Hub, control: Element): string | null {
  if (!['input', 'select', 'textarea'].includes(control.tagName.toLowerCase()) || !control.isConnected
    || control.matches('[data-ai-private], [data-sensitive], [hidden], [inert], [aria-hidden="true"], [contenteditable]:not([contenteditable="false"]), :disabled, [readonly]')) return null;
  const type = control.getAttribute('type')?.toLowerCase();
  if (control.tagName.toLowerCase() === 'input' && ['password', 'hidden', 'file', 'submit', 'button', 'reset', 'image'].includes(type ?? '')) return null;
  const style = hub.window.getComputedStyle(control);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return null;
  const root = control.getRootNode();
  const parent = control.parentElement ?? ('host' in root ? (root as ShadowRoot).host : null);
  // Permit only the control's public metadata; its ancestors retain all existing privacy exclusions.
  if (!parent || isPrivateElement(parent)) return null;
  let label = sanitizeActivityLabel(control.getAttribute('aria-label') ?? '', 100);
  if (!label) {
    const names: string[] = [];
    for (const id of control.getAttribute('aria-labelledby')?.trim().split(/\s+/).slice(0, 6) ?? []) {
      if (id.length > 100) continue;
      const reference = 'getElementById' in root
        ? (root as Document | ShadowRoot).getElementById(id) : null;
      if (reference) names.push(publicLabelText(reference));
    }
    label = sanitizeActivityLabel(names.join(' '), 100);
  }
  if (!label) {
    const labels = (control as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).labels;
    label = sanitizeActivityLabel(Array.from(labels ?? []).slice(0, 6).map(publicLabelText).join(' '), 100);
  }
  return label || null;
}

type InteractionLabel = { kind: 'change' | 'action'; name: string } | { kind: 'submit' };

/** Reads only a public action's safe label, never its URL, input value or form data. */
function interactionLabel(hub: Hub, event: Event): InteractionLabel | null {
  if (hub.window.document.querySelector?.('[data-ai-toolbar-selecting]')) return null;
  const path = event.composedPath();
  if (path.some(node => node instanceof hub.window.Element
    && node.matches('[data-ai-toolbar-root], [data-ai-toolbar-host], [data-ai-toolbar-overlay]'))) return null;
  const target = path.find(node => node instanceof hub.window.Element) as Element | undefined;
  if (!target || target.ownerDocument !== hub.window.document) return null;
  if (event.type === 'change') {
    const name = controlChangeLabel(hub, target);
    return name ? { kind: 'change', name } : null;
  }
  if (isPrivateElement(target)) return null;
  let action = target.closest('button, a[href], [role="button"], [role="link"], input[type="submit"], input[type="button"]');
  if (event.type === 'submit') {
    const submitter = (event as SubmitEvent).submitter;
    action = submitter instanceof hub.window.Element ? submitter : null;
    if (!action) return { kind: 'submit' };
    // Submit inputs are excluded from DOM inspection so their value is never read.
    // Their public form can still contribute a generic submission action.
    if (action.tagName.toLowerCase() === 'input') {
      if (action.matches('[data-ai-private], [data-sensitive], [hidden], [inert], [aria-hidden="true"]')
        || (action.parentElement && isPrivateElement(action.parentElement))) return null;
      return { kind: 'submit' };
    }
  }
  if (!action || isPrivateElement(action)) return null;
  const context = inspectElement(action);
  if (!context) return null;
  const name = sanitizeActivityLabel(context.accessibleName || context.text || '');
  return name ? { kind: 'action', name } : event.type === 'submit' ? { kind: 'submit' } : null;
}

/** App-authored opt-in marker only; a 500 response does not imply simulation or a confirmed bug. */
function interactionSimulated(hub: Hub, event: Event): boolean {
  for (const node of event.composedPath()) {
    if (node instanceof hub.window.Element && node.getAttribute('data-ai-simulated') === 'true') return true;
  }
  const submitter = event.type === 'submit' ? (event as SubmitEvent).submitter : null;
  let element = submitter instanceof hub.window.Element ? submitter : null;
  for (let depth = 0; element && depth < 64; depth++) {
    if (element.getAttribute('data-ai-simulated') === 'true') return true;
    element = element.parentElement;
  }
  return false;
}

function requestInfo(hub: Hub, args: Parameters<typeof fetch>): { method: ActivityFetchEntry['method']; path: string | null } {
  let method: unknown = 'GET';
  let inputUrl: string | null = null;
  safely(() => {
    const [input, init] = args;
    if (typeof input === 'string') inputUrl = input;
    else if (input instanceof hub.window.URL) inputUrl = input.href;
    else if (input instanceof hub.window.Request) { inputUrl = input.url; method = input.method; }
    // Do not invoke application-owned accessors in addition to fetch's own read.
    if (init) {
      const property = Object.getOwnPropertyDescriptor(init, 'method');
      if (property && 'value' in property && typeof property.value === 'string') method = property.value;
      else if (property) method = 'OTHER';
    }
  });
  let path: string | null = null;
  safely(() => {
    if (inputUrl === null) return;
    const parsed = new hub.window.URL(inputUrl, hub.window.location.href);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === hub.window.location.origin) path = parsed.pathname;
  });
  return { method: normalizeActivityMethod(method), path };
}

function bodyCurrent(session: Session, item: StoredEntry): boolean {
  return session.recording && !session.disposed && session.generation === item.generation && session.entries.includes(item) && item.entry.kind === 'fetch';
}
function omitted(session: Session, reason: NonNullable<ActivityBody['reason']>, contentType?: string): ActivityBody {
  return { status: 'omitted', reason, charLimit: activityBodyLimit(session.config.maxBodyChars), ...(contentType ? { contentType } : {}) };
}
function frameworkBudget(session: Session): number {
  return Math.floor(activityNetworkLimit(session.config.maxNetworkChars) / 4);
}
function frameworkResponse(item: StoredEntry, contentType: string | undefined): boolean {
  return contentType === 'text/x-component' && item.entry.kind === 'fetch'
    && item.entry.outcome === 'success' && item.entry.status !== null
    && item.entry.status >= 200 && item.entry.status < 300;
}
function setBody(session: Session, item: StoredEntry, key: 'requestBody' | 'responseBody', body: ActivityBody) {
  if (!bodyCurrent(session, item) || item.entry.kind !== 'fetch') return;
  const previous = item.entry[key]?.text?.length ?? 0;
  const remaining = Math.max(0, activityNetworkLimit(session.config.maxNetworkChars) - session.bodyChars + previous);
  const framework = key === 'responseBody' && frameworkResponse(item, body.contentType);
  const previewLimit = Math.min(activityBodyLimit(session.config.maxBodyChars), framework ? 1024 : 64_000, body.charLimit);
  let safe = sanitizeActivityBody(body, previewLimit)!;
  const frameworkRemaining = Math.max(0, frameworkBudget(session) - session.frameworkBodyChars + previous);
  if (framework && safe.text && !frameworkRemaining) safe = { ...omitted(session, 'framework_limit', safe.contentType), charLimit: previewLimit };
  else if (framework && safe.text && safe.text.length > frameworkRemaining) safe = sanitizeActivityBody({ ...safe, status: 'truncated', reason: 'framework_limit' }, frameworkRemaining)!;
  if (safe.text && !remaining) safe = omitted(session, 'network_limit', safe.contentType);
  else if (safe.text && safe.text.length > remaining) safe = sanitizeActivityBody({ ...safe, status: 'truncated', charLimit: remaining, reason: 'network_limit' }, remaining)!;
  session.bodyChars += (safe.text?.length ?? 0) - previous;
  if (framework) session.frameworkBodyChars += (safe.text?.length ?? 0) - previous;
  item.entry = { ...item.entry, [key]: safe };
  session.notify();
}
function mime(value: string | null | undefined): string {
  const candidate = value?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(candidate) ? candidate.slice(0, 100) : '';
}
function textMime(value: string): boolean {
  return !value || /^text\//.test(value) || /^application\/(?:[a-z0-9.+-]*json|[a-z0-9.+-]*xml|x-www-form-urlencoded|graphql)$/.test(value);
}

/** Reads only a bounded clone branch; never awaits cancellation of the application's tee branch. */
async function readBody(session: Session, item: StoredEntry, key: 'requestBody' | 'responseBody', stream: ReadableStream<Uint8Array>, contentType: string, previewLimit?: number) {
  if (!bodyCurrent(session, item)) { void stream.cancel().catch(() => undefined); return; }
  const limit = previewLimit ?? activityBodyLimit(session.config.maxBodyChars);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = stream.getReader(); } catch { setBody(session, item, key, omitted(session, 'read_error', contentType)); return; }
  let cancelled = false, finished = false;
  const cancel = () => {
    if (finished || cancelled) return;
    cancelled = true;
    setBody(session, item, key, omitted(session, 'recording_stopped', contentType));
    void reader.cancel().catch(() => undefined);
  };
  session.bodyReaders.add(cancel);
  (item.cancelBodies ??= new Set()).add(cancel);
  const decoder = new TextDecoder();
  let text = '', bytesRead = 0, truncated = false;
  try {
    while (!cancelled && bodyCurrent(session, item)) {
      const part = await reader.read();
      if (cancelled || !bodyCurrent(session, item)) return;
      if (part.done) { text += decoder.decode(); break; }
      const remainingBytes = (limit + 1) * 4 - bytesRead;
      const bytes = part.value.subarray(0, Math.max(0, remainingBytes));
      bytesRead += bytes.length;
      text += decoder.decode(bytes, { stream: true });
      if (text.length > limit || part.value.length > bytes.length || bytesRead >= (limit + 1) * 4) {
        truncated = true;
        void reader.cancel().catch(() => undefined);
        break;
      }
    }
    if (!cancelled) setBody(session, item, key, text ? { status: truncated ? 'truncated' : 'captured', text, charLimit: limit,
      ...(truncated && previewLimit !== undefined ? { reason: 'framework_limit' as const } : {}),
      ...(contentType ? { contentType } : {}) } : omitted(session, 'empty', contentType));
  } catch { if (!cancelled) setBody(session, item, key, omitted(session, 'read_error', contentType)); }
  finally { finished = true; session.bodyReaders.delete(cancel); item.cancelBodies?.delete(cancel); }
}

function requestBody(hub: Hub, args: Parameters<typeof fetch>, session: Session, item: StoredEntry) {
  if (!bodyCurrent(session, item)) return;
  if (session.config.captureBodies === false) { setBody(session, item, 'requestBody', omitted(session, 'disabled')); return; }
  const [input, init] = args;
  const property = init && Object.getOwnPropertyDescriptor(init, 'body');
  if (property && !('value' in property)) { setBody(session, item, 'requestBody', omitted(session, 'unavailable')); return; }
  const body: unknown = property && 'value' in property ? property.value : undefined;
  const limit = activityBodyLimit(session.config.maxBodyChars);
  if (body === null || body === undefined) {
    // A Request body's stream may be unbounded. Do not tee it or consume any original bytes.
    setBody(session, item, 'requestBody', omitted(session, input instanceof hub.window.Request && input.body ? 'stream' : 'empty'));
  } else if (typeof body === 'string') {
    setBody(session, item, 'requestBody', { status: body.length > limit ? 'truncated' : 'captured', text: body.slice(0, limit + 1), charLimit: limit, contentType: /^\s*[\[{]/.test(body) ? 'application/json' : 'text/plain' });
  } else if (body instanceof URLSearchParams) {
    let text = '';
    for (const [key, value] of body as URLSearchParams) {
      const pair = `${encodeURIComponent(key.slice(0, limit + 1))}=${sensitiveActivityKey(key) ? '[oculto]' : encodeURIComponent(value.slice(0, limit + 1))}`;
      text += `${text ? '&' : ''}${pair}`;
      if (text.length > limit) break;
    }
    setBody(session, item, 'requestBody', { status: text.length > limit ? 'truncated' : 'captured', text: text.slice(0, limit + 1), charLimit: limit, contentType: 'application/x-www-form-urlencoded' });
  } else if (body instanceof Blob) {
    const blob = body as Blob, contentType = mime(blob.type);
    if (!contentType || !textMime(contentType)) setBody(session, item, 'requestBody', omitted(session, 'binary', contentType));
    else void readBody(session, item, 'requestBody', blob.stream(), contentType);
  } else {
    setBody(session, item, 'requestBody', omitted(session, body instanceof ReadableStream ? 'stream' : 'binary'));
  }
}
function responseBody(response: Response, session: Session, item: StoredEntry) {
  if (!bodyCurrent(session, item)) return;
  if (session.config.captureBodies === false) { setBody(session, item, 'responseBody', omitted(session, 'disabled')); return; }
  const contentType = mime(response.headers.get('content-type'));
  if (!textMime(contentType)) { setBody(session, item, 'responseBody', omitted(session, 'binary', contentType)); return; }
  if (!response.body) { setBody(session, item, 'responseBody', omitted(session, 'empty', contentType)); return; }
  if (session.bodyChars >= activityNetworkLimit(session.config.maxNetworkChars)) { setBody(session, item, 'responseBody', omitted(session, 'network_limit', contentType)); return; }
  const framework = frameworkResponse(item, contentType);
  const frameworkRemaining = Math.max(0, frameworkBudget(session) - session.frameworkBodyChars);
  if (framework && !frameworkRemaining) { setBody(session, item, 'responseBody', omitted(session, 'framework_limit', contentType)); return; }
  try {
    const clone = response.clone();
    if (clone.body) void readBody(session, item, 'responseBody', clone.body, contentType,
      framework ? Math.min(1024, activityBodyLimit(session.config.maxBodyChars), frameworkRemaining) : undefined);
  } catch { setBody(session, item, 'responseBody', omitted(session, 'unavailable', contentType)); }
}

function simulationFor(hub: Hub): ActivityNetworkSimulation {
  let mode: ActivityNetworkSimulation = 'normal';
  for (const session of hub.sessions) if (session.recording && !session.disposed) {
    if (session.simulation === 'offline') return 'offline';
    if (session.simulation === 'slow') mode = 'slow';
  }
  return mode;
}
function simulatedFetch(hub: Hub, receiver: unknown, args: Parameters<typeof fetch>, mode: ActivityNetworkSimulation): ReturnType<typeof fetch> {
  if (mode === 'normal') return Reflect.apply(hub.original, receiver, args) as ReturnType<typeof fetch>;
  if (mode === 'offline') return Promise.reject(new TypeError('Solicitud bloqueada por la simulación sin conexión.'));
  const property = args[1] && Object.getOwnPropertyDescriptor(args[1], 'signal');
  const signal = property && 'value' in property ? property.value as AbortSignal | null : args[0] instanceof hub.window.Request ? args[0].signal : null;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new DOMException('La solicitud fue cancelada.', 'AbortError'));
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      try { resolve(Reflect.apply(hub.original, receiver, args) as ReturnType<typeof fetch>); }
      catch (error) { reject(error); }
    }, 800);
  });
}

function createHub(view: BrowserWindow): Hub {
  const hub: Hub = {
    window: view, number: ++nextHub, sequence: 0, sessions: new Set(),
    original: view.fetch, wrapper: view.fetch, interaction: () => {},
  };
  hub.interaction = event => safely(() => {
    const label = interactionLabel(hub, event);
    if (!label) return;
    const time = now(hub);
    const simulated = interactionSimulated(hub, event);
    const { id, sequence } = identity(hub);
    const at = new Date().toISOString();
    for (const session of hub.sessions) safely(() => {
      if (!session.recording || session.disposed) return;
      // A native submit following its activating click is one observed action.
      if (event.type === 'submit' && session.latestInteraction && time - session.latestInteraction.time < 100
        && session.latestInteraction.type === 'click') return;
      session.latestInteraction = { id, time, type: event.type, ...(simulated ? { simulated: true } : {}) };
      const localizedLabel = label.kind === 'change'
        ? session.translate('Cambió {label}', { label: label.name })
        : label.kind === 'submit' ? session.translate('Enviar formulario') : label.name;
      append(session, { sequence, started: time, generation: session.generation,
        entry: { id, kind: 'interaction', at, label: localizedLabel, ...(simulated ? { simulated: true } : {}) } });
    });
  });
  hub.wrapper = function (this: unknown, ...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
    const started = now(hub);
    const simulation = simulationFor(hub);
    const pending: Array<{ session: Session; item: StoredEntry }> = [];
    safely(() => {
      if (![...hub.sessions].some(session => session.recording && !session.disposed && session.recordNetwork)) return;
      const info = requestInfo(hub, args);
      const { id, sequence } = identity(hub);
      const at = new Date().toISOString();
      for (const session of hub.sessions) safely(() => {
        if (!session.recording || session.disposed || !session.recordNetwork) return;
        const recent = session.latestInteraction;
        const interactionId = recent && started - recent.time >= 0 && started - recent.time <= 1_500 ? recent.id : null;
        const entry: ActivityFetchEntry = {
          id, kind: 'fetch', at,
          resource: info.path === null ? UNKNOWN_ACTIVITY_RESOURCE : resolveActivityResource(session.config, info.method, info.path),
          method: info.method, status: null, outcome: 'pending', durationMs: null,
          interactionId, correlation: interactionId ? 'temporal' : null,
          ...(interactionId && recent?.simulated ? { simulated: true } : {}),
          ...(simulation !== 'normal' ? { simulated: true, simulation } : {}),
        };
        const item: StoredEntry = { sequence, entry, started, generation: session.generation };
        pending.push({ session, item });
        append(session, item);
        requestBody(hub, args, session, item);
      });
    });
    const finish = (response: Response | null, error: unknown) => safely(() => {
      const durationMs = Math.max(0, Math.round(now(hub) - started));
      for (const { session, item } of pending) safely(() => {
        if (!session.recording || session.disposed || session.generation !== item.generation || !session.entries.includes(item)) return;
        const entry = item.entry;
        if (entry.kind !== 'fetch' || entry.outcome !== 'pending') return;
        let outcome: ActivityFetchEntry['outcome'] = 'network_error';
        let status: number | null = null;
        if (response) { outcome = response.ok ? 'success' : 'http_error'; status = response.status; }
        else if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') outcome = 'aborted';
        item.entry = { ...entry, status, outcome, durationMs };
        session.notify();
        if (response) responseBody(response, session, item);
        else setBody(session, item, 'responseBody', omitted(session, 'unavailable'));
      });
    });
    let result: ReturnType<typeof fetch>;
    try { result = simulatedFetch(hub, this, args, simulation); }
    catch (error) { finish(null, error); throw error; }
    // Observe a native Promise without replacing it, its Response, or its rejection reason.
    safely(() => { void Promise.prototype.then.call(result, (response: Response) => finish(response, null), (error: unknown) => finish(null, error)); });
    return result;
  };
  view.fetch = hub.wrapper;
  view.document.addEventListener('click', hub.interaction, true);
  view.document.addEventListener('submit', hub.interaction, true);
  view.document.addEventListener('change', hub.interaction, true);
  hubs.set(view, hub);
  return hub;
}

function releaseHub(hub: Hub): void {
  if (hub.sessions.size) return;
  hub.window.document.removeEventListener('click', hub.interaction, true);
  hub.window.document.removeEventListener('submit', hub.interaction, true);
  hub.window.document.removeEventListener('change', hub.interaction, true);
  // A later wrapper belongs to its owner. Never replace it during cleanup.
  if (hub.window.fetch === hub.wrapper) hub.window.fetch = hub.original;
  if (hubs.get(hub.window) === hub) hubs.delete(hub.window);
}

/** Opt-in, bounded in-memory trace. The original fetch remains authoritative. */
export function createActivityRecorder(options: ActivityRecorderOptions): ActivityRecorder {
  let hub: Hub | null = null;
  const session: Session = {
    config: normalizeActivityConfig(options.config),
    limit: activityEntryLimit(options.config?.maxEntries), entries: [], generation: 0,
    recording: false, disposed: false, latestInteraction: null,
    droppedEntries: 0, bodyChars: 0, frameworkBodyChars: 0, bodyReaders: new Set(), simulation: 'normal',
    recordNetwork: options.config?.recordNetwork !== false,
    translate: (message, values) => createTranslator(typeof options.locale === 'function' ? options.locale() : options.locale ?? 'en')(message, values),
    notify: () => { if (!session.disposed) safely(() => options.onChange?.()); },
  };
  function stop(): void {
    if (!session.recording) return;
    const stoppedAt = hub ? now(hub) : 0;
    for (const cancel of session.bodyReaders) cancel();
    session.recording = false;
    session.simulation = 'normal';
    session.generation += 1;
    session.latestInteraction = null;
    for (const item of session.entries) {
      if (item.entry.kind === 'fetch' && item.entry.outcome === 'pending') {
        item.entry = { ...item.entry, outcome: 'incomplete', durationMs: Math.max(0, Math.round(stoppedAt - item.started)) };
      }
    }
    if (hub) { hub.sessions.delete(session); releaseHub(hub); hub = null; }
    session.notify();
  }
  return {
    start() {
      if (session.disposed || session.recording) return;
      const view = options.window as BrowserWindow;
      if (!view?.document || typeof view.fetch !== 'function') return;
      try { hub = hubs.get(view) ?? createHub(view); }
      catch { hub = null; return; }
      session.generation += 1;
      session.recording = true;
      session.latestInteraction = null;
      hub.sessions.add(session);
      session.notify();
    },
    stop,
    isRecording: () => session.recording,
    getEntries: () => sanitizeActivityEntries(session.entries.map(item => item.entry), session.limit),
    getSummary: () => ({ droppedEntries: session.droppedEntries, maxEntries: session.limit, bodyChars: session.bodyChars, maxNetworkChars: activityNetworkLimit(session.config.maxNetworkChars) }),
    seedBodyBudget(chars, frameworkChars) {
      if (session.recording || session.disposed || !Number.isFinite(chars)) return;
      session.bodyChars = Math.max(session.bodyChars, 0, Math.min(activityNetworkLimit(session.config.maxNetworkChars), Math.floor(chars)));
      // Legacy callers cannot identify RSC usage; reserve conservatively rather than refunding it.
      const used = frameworkChars !== undefined && Number.isFinite(frameworkChars) ? frameworkChars : session.bodyChars;
      session.frameworkBodyChars = Math.max(session.frameworkBodyChars, 0, Math.min(frameworkBudget(session), session.bodyChars, Math.floor(used)));
    },
    setNetworkRecording(enabled) { if (!session.disposed && typeof enabled === 'boolean' && session.recordNetwork !== enabled) { session.recordNetwork = enabled; session.notify(); } },
    getNetworkRecording: () => session.recordNetwork,
    setBodyLimit(chars) { if (!session.disposed) session.config.maxBodyChars = activityBodyLimit(chars); },
    setNetworkSimulation(mode) { if (session.recording && ['normal', 'slow', 'offline'].includes(mode)) { session.simulation = mode; session.notify(); } },
    getNetworkSimulation: () => session.recording ? session.simulation : 'normal',
    resetInteraction() { session.latestInteraction = null; },
    clear() {
      if (session.disposed) return;
      for (const cancel of session.bodyReaders) cancel();
      session.generation += 1;
      session.latestInteraction = null;
      session.entries = [];
      session.bodyChars = 0;
      session.frameworkBodyChars = 0;
      session.droppedEntries = 0;
      session.notify();
    },
    dispose() {
      if (session.disposed) return;
      session.disposed = true;
      stop();
      session.entries = [];
    },
  };
}
