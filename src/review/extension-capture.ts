import { CaptureError, pngDimensions } from './capture.js';
import type { BrowserCaptureProvider, CaptureViewport, RealCaptureFrame } from './capture.js';
import { sanitizeText } from '../core/privacy.js';

const MARKER = 'data-ai-context-capture-extension';
const PAGE_SOURCE = 'ai-context-toolbar';
const EXTENSION_SOURCE = 'ai-context-capture-extension';
const ENABLE_MESSAGE = 'Activá AI Context desde el ícono de la extensión de Chrome en esta pestaña.';
const MAX_BYTES = 50 * 1024 * 1024;
const PNG_PREFIX = 'data:image/png;base64,';

type Reply = Record<string, unknown>;
interface Pending {
  type: 'capture-status' | 'capture-result';
  href: string;
  timer: number;
  resolve(value: Reply): void;
  reject(error: CaptureError): void;
}
export interface ExtensionCaptureProviderOptions {
  /** Connection metadata only. This callback never starts a capture. */
  onConnectionChange?: () => void;
}

/**
 * Real visible-tab pixels supplied by the companion Chrome extension.
 * The public DOM bridge is transport, not an authentication boundary against
 * scripts running in the same page. The extension checks tab identity itself.
 */
export function createExtensionCaptureProvider(doc?: Document, options: ExtensionCaptureProviderOptions = {}): BrowserCaptureProvider {
  const document = doc ?? (typeof globalThis.document === 'undefined' ? undefined : globalThis.document);
  const view = document?.defaultView;
  let connected = false, listening = false, connecting: Promise<void> | null = null;
  let observer: MutationObserver | null = null;
  const pending = new Map<string, Pending>();
  const hasMarker = () => document?.documentElement?.getAttribute?.(MARKER) === '1';
  const setConnected = (value: boolean) => {
    if (connected === value) return;
    connected = value;
    options.onConnectionChange?.();
  };
  const unavailable = () => new CaptureError('CAPABILITY_UNAVAILABLE', ENABLE_MESSAGE);
  function currentHref(): string {
    if (!view || !document?.documentElement || view.document !== document || !/^https?:$/.test(view.location.protocol ?? new URL(view.location.href).protocol)) throw unavailable();
    return view.location.href;
  }
  function finish(id: string, error?: CaptureError, value?: Reply) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    view!.clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve(value!);
  }
  const receive = (event: MessageEvent) => {
    if (!view || event.source !== view || event.origin !== view.location.origin) return;
    const data = event.data as Reply | null;
    if (!data || typeof data !== 'object' || data.source !== EXTENSION_SOURCE || data.version !== 1 || typeof data.requestId !== 'string') return;
    const entry = pending.get(data.requestId);
    if (!entry || data.type !== entry.type) return;
    if (data.href !== entry.href || view.location.href !== entry.href) {
      finish(data.requestId, new CaptureError('STALE_CAPTURE', 'La pestaña cambió mientras respondía la extensión. Volvé a capturar.'));
      return;
    }
    finish(data.requestId, undefined, data);
  };
  const pageHide = () => provider.disconnect?.();
  function setup() {
    if (listening || !view || !document?.documentElement || typeof view.postMessage !== 'function') return;
    view.addEventListener('message', receive);
    view.addEventListener('pagehide', pageHide);
    listening = true;
    if (typeof view.MutationObserver === 'function') {
      observer = new view.MutationObserver(() => {
        if (!hasMarker()) {
          setConnected(false);
          for (const id of pending.keys()) finish(id, unavailable());
        } else void provider.connect?.().catch(() => undefined);
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: [MARKER] });
    }
  }
  function request(type: 'capture-status' | 'capture-request', timeout: number): Promise<Reply> {
    let href: string;
    try { href = currentHref(); setup(); }
    catch (error) { return Promise.reject(error); }
    if (!listening || !view) return Promise.reject(unavailable());
    const requestId = view.crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = view.setTimeout(() => {
        setConnected(false);
        finish(requestId, new CaptureError('CAPABILITY_UNAVAILABLE', type === 'capture-status' ? ENABLE_MESSAGE : 'La extensión no entregó la captura. Activala en esta pestaña y volvé a intentar.'));
      }, timeout);
      pending.set(requestId, { type: type === 'capture-status' ? 'capture-status' : 'capture-result', href, timer, resolve, reject });
      try { view.postMessage({ source: PAGE_SOURCE, version: 1, type, requestId, href }, view.location.origin); }
      catch { finish(requestId, unavailable()); }
    });
  }
  const provider: BrowserCaptureProvider = {
    name: 'chrome-extension-visible-tab', kind: 'real-browser',
    isConnected: () => connected && hasMarker() && Boolean(view && view.document === document),
    connect() {
      if (connecting) return connecting;
      connecting = request('capture-status', 2000).then(data => {
        if (data.connected !== true || !hasMarker()) throw unavailable();
        setConnected(true);
      }).catch(error => { setConnected(false); throw error; }).finally(() => { connecting = null; });
      return connecting;
    },
    disconnect() {
      observer?.disconnect(); observer = null;
      if (view && listening) {
        view.removeEventListener('message', receive);
        view.removeEventListener('pagehide', pageHide);
      }
      listening = false;
      for (const id of pending.keys()) finish(id, unavailable());
      setConnected(false);
    },
    async captureViewport(capture): Promise<RealCaptureFrame> {
      if (capture.document !== document || !provider.isConnected?.()) throw unavailable();
      await capture.ready;
      capture.assertCurrent();
      const data = await request('capture-request', 8000);
      capture.assertCurrent();
      if (data.ok !== true) {
        const reason = typeof data.error === 'string' ? sanitizeText(data.error, 300) : '';
        throw new CaptureError('CAPABILITY_UNAVAILABLE', reason || 'La extensión no pudo capturar esta pestaña.');
      }
      const geometry = data.viewport as CaptureViewport | null;
      if (!geometry || typeof geometry !== 'object' || !['width', 'height', 'dpr'].every(key => {
        const value = geometry[key as keyof CaptureViewport];
        return typeof value === 'number' && Number.isFinite(value) && value > 0 && value === capture.viewport[key as keyof CaptureViewport];
      })) throw new CaptureError('STALE_CAPTURE', 'La extensión capturó otro tamaño de pantalla. Volvé a intentar.');
      if (typeof data.dataUrl !== 'string' || !data.dataUrl.startsWith(PNG_PREFIX) || data.dataUrl.length > PNG_PREFIX.length + Math.ceil(MAX_BYTES / 3) * 4) throw new CaptureError('BINARY_TRANSPORT_UNAVAILABLE', 'La extensión no entregó un PNG válido dentro del límite.');
      const base64 = data.dataUrl.slice(PNG_PREFIX.length);
      if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new CaptureError('BINARY_TRANSPORT_UNAVAILABLE', 'La extensión entregó bytes de imagen inválidos.');
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(view!.atob(base64), character => character.charCodeAt(0)); }
      catch { throw new CaptureError('BINARY_TRANSPORT_UNAVAILABLE', 'La extensión entregó bytes de imagen inválidos.'); }
      const dimensions = pngDimensions(bytes);
      if (typeof data.capturedAt !== 'string' || !Number.isFinite(Date.parse(data.capturedAt))) throw new CaptureError('STALE_CAPTURE', 'La extensión no informó cuándo se capturó la imagen.');
      return { bytes, capturedAt: data.capturedAt, pixelWidth: dimensions.width, pixelHeight: dimensions.height, provider: provider.name };
    },
  };
  setup();
  if (hasMarker()) void Promise.resolve().then(() => provider.connect?.()).catch(() => undefined);
  return provider;
}
