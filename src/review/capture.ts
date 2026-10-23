import { sanitizePathname, sanitizeText } from '../core/privacy.js';

export type ImageCaptureKind = 'viewport' | 'region';
export type CapturePrivacy = 'visible' | 'redact';
export interface CaptureViewport { width: number; height: number; dpr: number }
export interface CaptureBounds { x: number; y: number; width: number; height: number }
export interface CaptureRedaction { kind: 'editable' | 'private' | 'embedded'; bounds: CaptureBounds }
export class CaptureError extends Error {
  constructor(readonly code: 'CAPABILITY_UNAVAILABLE' | 'STALE_CAPTURE' | 'STALE_TARGET' | 'PRIVACY_REVIEW_REQUIRED' | 'BINARY_TRANSPORT_UNAVAILABLE' | 'LIMIT_REACHED', message: string) {
    super(message); this.name = 'CaptureError';
  }
}
export interface RealCaptureFrame {
  /** PNG/JPEG bytes from a browser screenshot or decoded display stream. Never DOM reconstruction. */
  bytes: Uint8Array;
  capturedAt: string;
  pixelWidth: number;
  pixelHeight: number;
  provider: string;
}
export interface BrowserCaptureRequest {
  document: Document;
  viewport: CaptureViewport;
  pathname: string;
  revision: number;
  /** Masks have reached a painted frame. Native providers must request permission before awaiting this. */
  ready: Promise<void>;
  readonly redactions: readonly CaptureRedaction[];
  assertCurrent(): void;
}
export interface BrowserCaptureProvider {
  readonly name: string;
  readonly kind: 'real-browser';
  /** Providers must implement actual screenshot transport. A filename or blob URL is insufficient. */
  captureViewport(request: BrowserCaptureRequest): Promise<RealCaptureFrame>;
  /** Optional explicit browser permission. Call from the user's click, before preparing masks. */
  connect?(): Promise<void>;
  disconnect?(): void;
  isConnected?(): boolean;
}
export type CaptureProvider = BrowserCaptureProvider;
export interface CaptureOptions {
  document?: Document;
  kind?: ImageCaptureKind;
  target?: Element | null;
  /** A user-selected rectangle in viewport CSS pixels, read again before retaining the real image. */
  getRegionBounds?: () => CaptureBounds | null;
  privateSelectors?: readonly string[];
  revision?: number;
  /** Capture the visible screen by default. Redaction is an explicit integrator choice. */
  privacy?: CapturePrivacy;
  /** Keep true unless a DOM-only adapter needs its page-local form to remain reachable. */
  hideToolbar?: boolean;
}
export interface CapturedImage extends RealCaptureFrame {
  mimeType: 'image/png';
  kind: ImageCaptureKind;
  pathname: string;
  viewport: CaptureViewport;
  revision: number;
  redactionStatus: 'applied' | 'notRequired' | 'disabled';
  redactions: CaptureRedaction[];
  toolbarHidden: boolean;
}

const TOOLBAR = '[data-ai-toolbar-root], [data-ai-toolbar-host], [data-ai-toolbar-overlay], [data-ai-toolbar-version]';
const PRIVATE = '[data-ai-private], [data-sensitive], [hidden], [inert], [aria-hidden="true"]';
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
const EMBEDDED = 'iframe, object, embed, canvas, video';
const MAX_BYTES = 50 * 1024 * 1024;
const active = new WeakSet<Document>();

function captureDocument(options: CaptureOptions): Document {
  const doc = options.document ?? (typeof document === 'undefined' ? undefined : document);
  if (!doc?.defaultView || !doc.documentElement) throw new CaptureError('CAPABILITY_UNAVAILABLE', 'La captura necesita un documento visible del navegador.');
  return doc;
}
function rect(element: Element): CaptureBounds {
  const r = element.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}
function equalBounds(a: CaptureBounds, b: CaptureBounds): boolean {
  return ['x', 'y', 'width', 'height'].every(key => Math.abs(a[key as keyof CaptureBounds] - b[key as keyof CaptureBounds]) < 0.25);
}
function visibleBounds(bounds: CaptureBounds, viewport: CaptureViewport): boolean {
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    && bounds.width > 0 && bounds.height > 0 && bounds.x >= 0 && bounds.y >= 0
    && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height;
}
function prepareRegion(options: CaptureOptions, doc: Document, viewport: CaptureViewport) {
  const explicit = options.kind === 'region' ? options.getRegionBounds?.() ?? null : null;
  // Clone values: the selector may reuse and mutate its rectangle while a provider awaits a frame.
  const region = options.kind !== 'region' ? null : explicit
    ? { x: explicit.x, y: explicit.y, width: explicit.width, height: explicit.height }
    : options.target ? rect(options.target) : null;
  if (!explicit && options.target && (!options.target.isConnected || options.target.ownerDocument !== doc))
    throw new CaptureError('STALE_TARGET', 'La selección ya no pertenece a esta pantalla.');
  if (options.kind === 'region' && (!region || !visibleBounds(region, viewport)))
    throw new CaptureError('STALE_TARGET', 'La región debe tener dimensiones finitas y estar completamente visible en el viewport actual.');
  return { region, assertCurrent() {
    if (!region) return;
    const currentExplicit = options.getRegionBounds?.() ?? null;
    if (explicit
      ? !currentExplicit || !visibleBounds(currentExplicit, viewport) || !equalBounds(currentExplicit, region)
      : currentExplicit || !options.target?.isConnected || options.target.ownerDocument !== doc || !equalBounds(rect(options.target), region))
      throw new CaptureError('STALE_CAPTURE', 'La región seleccionada cambió mientras se capturaba. Volvé a preparar la imagen.');
  } };
}
function paint(view: Window): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = view.setTimeout(() => reject(new CaptureError('CAPABILITY_UNAVAILABLE', 'La pestaña no pudo preparar un frame visible.')), 3000);
    view.requestAnimationFrame(() => view.requestAnimationFrame(() => { view.clearTimeout(timeout); resolve(); }));
  });
}
function rgbaOpaque(value: string): boolean { return value === 'rgb(24, 24, 27)' || value === 'rgba(24, 24, 27, 1)'; }

/** Normal browser pixels: no popover, private-region inspection or opaque overlays. */
function prepareVisibleCapture(options: CaptureOptions) {
  const doc = captureDocument(options), view = doc.defaultView!;
  if (active.has(doc)) throw new CaptureError('CAPABILITY_UNAVAILABLE', 'Ya hay una captura pendiente en esta pestaña.');
  const viewport = { width: view.innerWidth, height: view.innerHeight, dpr: view.devicePixelRatio };
  if (![viewport.width, viewport.height, viewport.dpr].every(n => Number.isFinite(n) && n > 0)) throw new CaptureError('CAPABILITY_UNAVAILABLE', 'El viewport no tiene dimensiones verificables.');
  const selection = prepareRegion(options, doc, viewport), { region } = selection;
  const href = view.location.href, pathname = sanitizePathname(view.location.pathname), scrollX = view.scrollX, scrollY = view.scrollY;
  const focused = doc.activeElement, preparedAt = new Date().toISOString();
  const hidden: Array<{ element: HTMLElement | SVGElement; value: string; priority: string }> = [];
  const freeze = doc.createElement('style'); freeze.setAttribute('data-ai-capture-freeze', '');
  freeze.textContent = '*{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}';
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true; freeze.remove();
    for (const { element, value, priority } of hidden) {
      if (value) element.style.setProperty('visibility', value, priority);
      else element.style.removeProperty('visibility');
    }
    active.delete(doc);
    if (view.location.href === href && focused?.isConnected && doc.activeElement !== focused && 'focus' in focused) (focused as HTMLElement).focus({ preventScroll: true });
  };
  const assertCurrent = () => {
    if (restored || view.location.href !== href || view.innerWidth !== viewport.width || view.innerHeight !== viewport.height || view.devicePixelRatio !== viewport.dpr || view.scrollX !== scrollX || view.scrollY !== scrollY) throw new CaptureError('STALE_CAPTURE', 'La ruta, la selección o el viewport cambió mientras se capturaba.');
    selection.assertCurrent();
  };
  active.add(doc);
  try {
    doc.documentElement.append(freeze);
    for (const node of options.hideToolbar === false ? [] : doc.querySelectorAll(TOOLBAR)) {
      if (!('style' in node)) continue;
      const element = node as HTMLElement;
      hidden.push({ element, value: element.style.getPropertyValue('visibility'), priority: element.style.getPropertyPriority('visibility') });
      element.style.setProperty('visibility', 'hidden', 'important');
    }
    const ready = paint(view).then(assertCurrent); void ready.catch(() => undefined);
    return { document: doc, viewport, pathname, revision: options.revision ?? 0, privacy: 'visible' as const, toolbarHidden: options.hideToolbar !== false, ready, assertCurrent, restore, redactions: [] as CaptureRedaction[], region, preparedAt };
  } catch (error) { restore(); throw error; }
}

/** A short lived top-layer shield; it never reads field values or private text. */
function prepareCapture(options: CaptureOptions) {
  if (options.privacy !== undefined && options.privacy !== 'visible' && options.privacy !== 'redact') throw new CaptureError('CAPABILITY_UNAVAILABLE', 'Elegí una captura visible o con redacción explícita.');
  if (options.hideToolbar !== undefined && typeof options.hideToolbar !== 'boolean') throw new CaptureError('CAPABILITY_UNAVAILABLE', 'La visibilidad de la toolbar debe indicarse como true o false.');
  if (options.privacy !== 'redact') return prepareVisibleCapture(options);
  const doc = captureDocument(options), view = doc.defaultView!;
  if (active.has(doc)) throw new CaptureError('CAPABILITY_UNAVAILABLE', 'Ya hay una captura pendiente en esta pestaña.');
  if (view.visualViewport && (view.visualViewport.scale !== 1 || view.visualViewport.offsetLeft !== 0 || view.visualViewport.offsetTop !== 0)) {
    throw new CaptureError('CAPABILITY_UNAVAILABLE', 'Restablecé el zoom táctil para verificar la geometría de la captura.');
  }
  const viewport = { width: view.innerWidth, height: view.innerHeight, dpr: view.devicePixelRatio };
  const layoutWidth=view.innerWidth,layoutHeight=view.innerHeight;
  if (![viewport.width, viewport.height, viewport.dpr].every(n => Number.isFinite(n) && n > 0)) throw new CaptureError('CAPABILITY_UNAVAILABLE', 'El viewport no tiene dimensiones verificables.');
  if (doc.fonts?.status === 'loading') throw new CaptureError('STALE_CAPTURE', 'Las fuentes todavía están cambiando; volvé a capturar cuando terminen de cargar.');
  const selection = prepareRegion(options, doc, viewport), { region } = selection;
  const href = view.location.href, pathname = sanitizePathname(view.location.pathname), scrollX = view.scrollX, scrollY = view.scrollY;
  const focused = doc.activeElement;
  const shield = doc.createElement('div');
  if (typeof shield.showPopover !== 'function') throw new CaptureError('CAPABILITY_UNAVAILABLE', 'El navegador no permite proteger la captura con una capa superior verificable.');
  shield.setAttribute('popover', 'manual');
  shield.setAttribute('data-ai-capture-shield', '');
  shield.setAttribute('aria-hidden', 'true');
  shield.style.cssText = 'position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:hidden!important;pointer-events:none!important;opacity:1!important;visibility:visible!important;transform:none!important;filter:none!important;isolation:isolate!important;';
  const freeze = doc.createElement('style');
  freeze.setAttribute('data-ai-capture-freeze', '');
  freeze.textContent = '*{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}';
  const hidden: Array<{ element: HTMLElement | SVGElement; value: string; priority: string }> = [];
  const redactions: CaptureRedaction[] = [];
  const masks: HTMLElement[] = [];
  const maskRects: CaptureBounds[] = [];
  const privateGeometry: Array<{element:Element;bounds:CaptureBounds[]}> = [];
  const custom = (options.privateSelectors ?? []).slice(0, 50);
  for (const selector of custom) { try { doc.querySelector(selector); } catch { throw new CaptureError('PRIVACY_REVIEW_REQUIRED', 'Un selector privado no es válido.'); } }
  let observer: MutationObserver | null = null, dirty = false, restored = false;
  const restore = () => {
    if (restored) return;
    restored = true; observer?.disconnect();
    doc.removeEventListener('beforetoggle', stateChanged, true);
    doc.removeEventListener('fullscreenchange', stateChanged, true);
    try { shield.hidePopover(); } catch { /* It may already have been removed by the app. */ }
    shield.remove(); freeze.remove();
    for (const entry of hidden) {
      if (entry.value) entry.element.style.setProperty('visibility', entry.value, entry.priority);
      else entry.element.style.removeProperty('visibility');
    }
    active.delete(doc);
    if (view.location.href === href) {
      if (view.scrollX !== scrollX || view.scrollY !== scrollY) view.scrollTo(scrollX, scrollY);
      if (focused?.isConnected && doc.activeElement !== focused && 'focus' in focused) (focused as HTMLElement).focus({ preventScroll: true });
    }
  };
  const stateChanged = (event:Event) => { if (event.target !== shield) dirty = true; };
  active.add(doc);
  try {
    doc.documentElement.append(freeze);
    for (const node of options.hideToolbar === false ? [] : doc.querySelectorAll(TOOLBAR)) {
      if (!('style' in node)) continue;
      const element = node as HTMLElement;
      hidden.push({ element, value: element.style.getPropertyValue('visibility'), priority: element.style.getPropertyPriority('visibility') });
      element.style.setProperty('visibility', 'hidden', 'important');
    }
    doc.documentElement.append(shield); shield.showPopover();
    const actualViewport=rect(shield);
    // Browser zoom rounds innerWidth/Height to integers while vw/vh retain fractional CSS pixels.
    // Accept only a top-layer shield that covers that rounded viewport, with <1 CSS px rounding.
    if(Math.abs(actualViewport.x)>0.05||Math.abs(actualViewport.y)>0.05||actualViewport.width<layoutWidth-0.05||actualViewport.width>layoutWidth+1.05||actualViewport.height<layoutHeight-0.05||actualViewport.height>layoutHeight+1.05) {
      throw new CaptureError('PRIVACY_REVIEW_REQUIRED',`No se pudo verificar la geometría protegida (viewport ${layoutWidth}×${layoutHeight}; capa ${actualViewport.x},${actualViewport.y},${actualViewport.width},${actualViewport.height}).`);
    }
    viewport.width=actualViewport.width;viewport.height=actualViewport.height;
    const nodes = doc.querySelectorAll('*');
    if (nodes.length > 30_000) throw new CaptureError('LIMIT_REACHED', 'La página supera el límite de inspección segura de captura.');
    for (const node of nodes) {
      if (node === freeze || node === shield || node.closest(TOOLBAR)) continue;
      // Closed custom-element roots cannot be inspected; mask their entire host. Open roots are also masked.
      const kind = node.matches(EDITABLE) ? 'editable' : node.matches(PRIVATE) || custom.some(selector => node.matches(selector)) ? 'private' : node.matches(EMBEDDED) || node.shadowRoot || node.localName.includes('-') ? 'embedded' : null;
      if (!kind) continue;
      privateGeometry.push({element:node,bounds:Array.from(node.getClientRects()).map(r=>({x:r.x,y:r.y,width:r.width,height:r.height}))});
      for (const r of Array.from(node.getClientRects())) {
        const bounds = { x: Math.max(0, r.x - 2), y: Math.max(0, r.y - 2), width: Math.min(viewport.width, r.right + 2) - Math.max(0, r.x - 2), height: Math.min(viewport.height, r.bottom + 2) - Math.max(0, r.y - 2) };
        if (bounds.width <= 0 || bounds.height <= 0) continue;
        const mask = doc.createElement('div');
        mask.style.cssText = `position:fixed!important;left:${bounds.x}px!important;top:${bounds.y}px!important;width:${bounds.width}px!important;height:${bounds.height}px!important;background:rgb(24,24,27)!important;opacity:1!important;visibility:visible!important;mix-blend-mode:normal!important;filter:none!important;backdrop-filter:none!important;transform:none!important;clip-path:none!important;border:0!important;border-radius:0!important;box-shadow:none!important;`;
        shield.append(mask); masks.push(mask); maskRects.push(bounds); redactions.push({ kind, bounds });
      }
    }
    // Popovers are above transformed roots, dialogs and shadow content. Reject a broken shield.
    const shieldStyle = view.getComputedStyle(shield);
    if (!shield.matches(':popover-open') || shieldStyle.opacity !== '1' || shieldStyle.visibility !== 'visible' || !equalBounds(rect(shield), { x: 0, y: 0, width: viewport.width, height: viewport.height })) {
      const actual=rect(shield);
      throw new CaptureError('PRIVACY_REVIEW_REQUIRED', `No se pudo verificar la capa que oculta las regiones privadas (viewport ${viewport.width}×${viewport.height}; capa ${actual.x},${actual.y},${actual.width},${actual.height}; opacidad ${shieldStyle.opacity}; visible ${shieldStyle.visibility}; abierta ${shield.matches(':popover-open')}).`);
    }
    for (let i = 0; i < masks.length; i++) {
      const mask = masks[i]!, style = view.getComputedStyle(mask);
      if (!rgbaOpaque(style.backgroundColor) || style.opacity !== '1' || !equalBounds(rect(mask), maskRects[i]!)) throw new CaptureError('PRIVACY_REVIEW_REQUIRED', 'No se pudo verificar una máscara opaca.');
    }
    observer = new view.MutationObserver(records => {
      if (records.some(record => {
        const element = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement;
        return !element?.closest(`${TOOLBAR}, [data-ai-capture-shield], [data-ai-capture-freeze]`);
      })) dirty = true;
    });
    observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    doc.addEventListener('beforetoggle', stateChanged, true);
    doc.addEventListener('fullscreenchange', stateChanged, true);
    const assertCurrent = () => {
      if (restored || dirty || !shield.isConnected || !shield.matches(':popover-open') || view.location.href !== href || view.innerWidth !== layoutWidth || view.innerHeight !== layoutHeight || !equalBounds(rect(shield),actualViewport) || view.devicePixelRatio !== viewport.dpr || view.scrollX !== scrollX || view.scrollY !== scrollY) {
        throw new CaptureError('STALE_CAPTURE', 'La pantalla cambió mientras se capturaba. La imagen no se guardó.');
      }
      selection.assertCurrent();
      if (view.visualViewport && (view.visualViewport.scale !== 1 || view.visualViewport.offsetLeft !== 0 || view.visualViewport.offsetTop !== 0)) throw new CaptureError('STALE_CAPTURE','La escala visual cambió durante la captura.');
      for (const entry of privateGeometry) {
        const current=Array.from(entry.element.getClientRects());
        if (!entry.element.isConnected || current.length!==entry.bounds.length || current.some((bounds,i)=>!equalBounds(bounds,entry.bounds[i]!))) throw new CaptureError('STALE_CAPTURE','Una región privada cambió de lugar durante la captura.');
      }
      for(let i=0;i<masks.length;i++){
        const mask=masks[i]!,style=view.getComputedStyle(mask);
        if(!mask.isConnected||style.visibility!=='visible'||style.opacity!=='1'||!rgbaOpaque(style.backgroundColor)||!equalBounds(rect(mask),maskRects[i]!)) throw new CaptureError('PRIVACY_REVIEW_REQUIRED','Una máscara de privacidad dejó de ser verificable.');
      }
    };
    const ready = paint(view).then(() => { assertCurrent(); });
    // A native permission denial can happen before ready is awaited.
    void ready.catch(() => undefined);
    return { document: doc, viewport, pathname, revision: options.revision ?? 0, privacy: 'redact' as const, toolbarHidden: options.hideToolbar !== false, ready, assertCurrent, restore, redactions, region, preparedAt: new Date().toISOString() };
  } catch (error) { restore(); throw error; }
}

/** Checks the actual PNG header rather than trusting an adapter's claimed dimensions. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 33 || bytes.byteLength > MAX_BYTES || ![137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v) || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') throw new CaptureError('BINARY_TRANSPORT_UNAVAILABLE', 'El proveedor no entregó un archivo PNG válido dentro del límite.');
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), width = data.getUint32(16), height = data.getUint32(20);
  if (width < 1 || height < 1 || width > 32_768 || height > 32_768 || width * height > 100_000_000) throw new CaptureError('LIMIT_REACHED', 'La imagen supera el límite de resolución.');
  return { width, height };
}
async function encode(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new CaptureError('BINARY_TRANSPORT_UNAVAILABLE', 'El navegador no pudo producir los bytes de la imagen.');
  return new Uint8Array(await blob.arrayBuffer());
}
async function finishCapture(prepared: ReturnType<typeof prepareCapture>, frame: RealCaptureFrame, kind: ImageCaptureKind): Promise<CapturedImage> {
  await prepared.ready; prepared.assertCurrent();
  if (!(frame.bytes instanceof Uint8Array) || frame.bytes.byteLength > MAX_BYTES) throw new CaptureError('BINARY_TRANSPORT_UNAVAILABLE', 'El adaptador debe entregar bytes reales dentro del límite.');
  const isPng = frame.bytes[0] === 137 && frame.bytes[1] === 80;
  const isJpeg = frame.bytes[0] === 255 && frame.bytes[1] === 216 && frame.bytes[2] === 255;
  if (!isPng && !isJpeg) throw new CaptureError('BINARY_TRANSPORT_UNAVAILABLE', 'Solo se admiten capturas reales PNG o JPEG.');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(new Blob([new Uint8Array(frame.bytes)], { type: isPng ? 'image/png' : 'image/jpeg' })); }
  catch { throw new CaptureError('BINARY_TRANSPORT_UNAVAILABLE', 'El navegador no pudo decodificar los píxeles de la imagen entregada.'); }
  const dimensions = { width: bitmap.width, height: bitmap.height }, at = Date.parse(frame.capturedAt);
  if (isPng) pngDimensions(frame.bytes);
  if (dimensions.width * dimensions.height > 100_000_000 || dimensions.width > 32_768 || dimensions.height > 32_768) { bitmap.close(); throw new CaptureError('LIMIT_REACHED', 'La captura supera el límite de resolución.'); }
  if (!Number.isFinite(at) || at < Date.parse(prepared.preparedAt) || at > Date.now() + 1000 || dimensions.width !== frame.pixelWidth || dimensions.height !== frame.pixelHeight) { bitmap.close(); throw new CaptureError('STALE_CAPTURE', 'El momento o la resolución de la imagen no coincide con esta captura.'); }
  const sx = dimensions.width / prepared.viewport.width, sy = dimensions.height / prepared.viewport.height;
  if (sx < 0.5 || sx > 5 || Math.abs(sx - sy) > 2 / Math.min(prepared.viewport.width, prepared.viewport.height)) { bitmap.close(); throw new CaptureError('STALE_CAPTURE', 'La imagen no corresponde a la geometría del viewport preparado.'); }
  const result: CapturedImage = { ...frame, bytes: new Uint8Array(frame.bytes), mimeType: 'image/png', kind, pathname: prepared.pathname, viewport: prepared.viewport, revision: prepared.revision, provider: sanitizeText(frame.provider, 100), redactionStatus: prepared.privacy === 'visible' ? 'disabled' : prepared.redactions.length ? 'applied' : 'notRequired', redactions: prepared.redactions, toolbarHidden: prepared.toolbarHidden };
  if (!result.provider) { bitmap.close(); throw new CaptureError('CAPABILITY_UNAVAILABLE', 'El proveedor debe identificar el origen real de la captura.'); }
  if (!isPng || (kind === 'region' && prepared.region)) {
    const r = kind === 'region' && prepared.region ? prepared.region : { x: 0, y: 0, width: prepared.viewport.width, height: prepared.viewport.height };
    const x = Math.floor(r.x * sx), y = Math.floor(r.y * sy), width = Math.ceil((r.x + r.width) * sx) - x, height = Math.ceil((r.y + r.height) * sy) - y;
    const canvas = prepared.document.createElement('canvas'); canvas.width = width; canvas.height = height;
    try {
      const ctx = canvas.getContext('2d'); if (!ctx) throw new CaptureError('CAPABILITY_UNAVAILABLE', 'El navegador no permite recortar la imagen real.');
      ctx.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
      result.bytes = await encode(canvas); result.pixelWidth = width; result.pixelHeight = height;
    } finally { bitmap.close(); canvas.width = 0; canvas.height = 0; }
  } else bitmap.close();
  prepared.assertCurrent();
  return result;
}

/** No image or unmasked original is retained on failure. UI restoration is unconditional. */
export async function capturePage(provider: BrowserCaptureProvider, options: CaptureOptions = {}): Promise<CapturedImage> {
  if (provider?.kind !== 'real-browser' || typeof provider.captureViewport !== 'function') throw new CaptureError('CAPABILITY_UNAVAILABLE', 'No hay un proveedor de capturas reales conectado.');
  // Permission UI can resize the tab; acquire it before freezing viewport/selection geometry.
  // connect() invokes its picker synchronously, so a direct user click keeps activation.
  await provider.connect?.();
  const prepared = prepareCapture(options);
  try { return await finishCapture(prepared, await provider.captureViewport(prepared), options.kind ?? 'viewport'); }
  finally { prepared.restore(); }
}

interface CaptureHandleTrack extends MediaStreamTrack { getCaptureHandle?(): { origin?: string; handle: string } | null }
interface CaptureHandleDevices extends MediaDevices { setCaptureHandleConfig?(config: { handle: string; exposeOrigin: boolean; permittedOrigins: string[] }): void }
interface TrackFrameGrabber { grabFrame(): Promise<ImageBitmap> }
interface TrackFrameCaptureWindow extends Window { ImageCapture?: new (track: MediaStreamTrack) => TrackFrameGrabber }
export interface DisplayMediaCaptureProvider extends BrowserCaptureProvider {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
}

/** A one-shot snapshot of the real track; does not depend on a video element repainting. */
function grabTrackFrame(view: Window, grabber: TrackFrameGrabber, timeoutMs: number): Promise<ImageBitmap> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = view.setTimeout(() => { settled = true; reject(new CaptureError('CAPABILITY_UNAVAILABLE', 'El stream no entregó una imagen de la pestaña.')); }, timeoutMs);
    let requested: Promise<ImageBitmap>;
    try { requested = grabber.grabFrame(); }
    catch (error) { requested = Promise.reject(error); }
    void requested.then(bitmap => {
      if (settled) { bitmap.close(); return; }
      settled = true; view.clearTimeout(timeout); resolve(bitmap);
    }, error => {
      if (settled) return;
      settled = true; view.clearTimeout(timeout); reject(error);
    });
  });
}

/** Check real frame pixels too: a video callback can still refer to a buffered pre-mask frame. */
function frameHasMasks(ctx: CanvasRenderingContext2D, width: number, height: number, request: BrowserCaptureRequest): boolean {
  const sx = width / request.viewport.width, sy = height / request.viewport.height;
  if (sx < 0.5 || sx > 5 || Math.abs(sx - sy) > 2 / Math.min(request.viewport.width, request.viewport.height)) return false;
  for (const { bounds } of request.redactions) {
    // Stay one physical pixel inside the opaque region to avoid compositor edge antialiasing.
    const left = Math.max(0, Math.ceil(bounds.x * sx) + 1), top = Math.max(0, Math.ceil(bounds.y * sy) + 1);
    const right = Math.min(width, Math.floor((bounds.x + bounds.width) * sx) - 1), bottom = Math.min(height, Math.floor((bounds.y + bounds.height) * sy) - 1);
    if (right <= left || bottom <= top) continue;
    const pixels = ctx.getImageData(left, top, right - left, bottom - top).data;
    for (let i = 0; i < pixels.length; i += 4) {
      // Tab video can pass through YUV conversion; this bounded tolerance still rejects text.
      if (Math.abs(pixels[i]! - 24) > 3 || Math.abs(pixels[i + 1]! - 24) > 3 || Math.abs(pixels[i + 2]! - 27) > 3 || pixels[i + 3] !== 255) return false;
    }
  }
  return true;
}

/** One explicit current-tab grant per visit; checkpoints can then be requested from the chat. */
export function createDisplayMediaCaptureProvider(doc?: Document): DisplayMediaCaptureProvider {
  let document = doc, stream: MediaStream | null = null, video: HTMLVideoElement | null = null;
  let handle = '', connecting: Promise<void> | null = null, generation = 0;
  const currentDocument = () => {
    document ??= typeof globalThis.document === 'undefined' ? undefined : globalThis.document;
    if (!document?.defaultView) throw new CaptureError('CAPABILITY_UNAVAILABLE', 'La captura necesita una pestaña visible.');
    return document;
  };
  const verify = () => {
    const view = currentDocument().defaultView!, track = stream?.getVideoTracks()[0] as CaptureHandleTrack | undefined;
    const captured = track?.getCaptureHandle?.();
    if (!track || track.readyState !== 'live' || track.getSettings().displaySurface !== 'browser' || captured?.origin !== view.location.origin || captured.handle !== handle) {
      throw new CaptureError('PRIVACY_REVIEW_REQUIRED', 'Elegí únicamente esta pestaña. No se guardó ninguna imagen de la superficie seleccionada.');
    }
  };
  const disconnected = () => {
    generation++;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    if (video) { video.pause(); video.srcObject = null; video = null; }
    if (document?.defaultView) {
      document.defaultView.removeEventListener('pagehide', disconnected);
      try { (document.defaultView.navigator.mediaDevices as CaptureHandleDevices | undefined)?.setCaptureHandleConfig?.({ handle: '', exposeOrigin: false, permittedOrigins: [] }); } catch { /* The document may already be gone. */ }
    }
    handle = '';
  };
  const settlePermissionViewport = (view: Window): Promise<void> => new Promise((resolve, reject) => {
    let frame = 0, stableFrames = 0, lastChange = view.performance.now(), previous = '';
    const geometry = () => [view.innerWidth, view.innerHeight, view.devicePixelRatio, view.scrollX, view.scrollY, view.visualViewport?.width, view.visualViewport?.height, view.visualViewport?.offsetLeft, view.visualViewport?.offsetTop].join(':');
    const timeout = view.setTimeout(() => { view.cancelAnimationFrame(frame); reject(new CaptureError('CAPABILITY_UNAVAILABLE', 'La pestaña no estabilizó su tamaño después de habilitar imágenes. Volvé a intentarlo.')); }, 1500);
    const check = () => {
      try {
        verify();
        const current = geometry(), now = view.performance.now();
        if (current !== previous) { previous = current; lastChange = now; stableFrames = 0; }
        else stableFrames++;
        if (stableFrames >= 3 && now - lastChange >= 150) { view.clearTimeout(timeout); resolve(); }
        else frame = view.requestAnimationFrame(check);
      } catch (error) { view.clearTimeout(timeout); reject(error); }
    };
    frame = view.requestAnimationFrame(check);
  });
  const provider: DisplayMediaCaptureProvider = {
    name: 'browser-display-media', kind: 'real-browser',
    isConnected() { try { verify(); return true; } catch { return false; } },
    disconnect: disconnected,
    connect() {
      if (provider.isConnected()) return Promise.resolve();
      if (connecting) return connecting;
      const document = currentDocument(), view = document.defaultView!, devices = view.navigator.mediaDevices as CaptureHandleDevices | undefined;
      if (!devices?.getDisplayMedia || !devices.setCaptureHandleConfig || !view.MediaStreamTrack || !('getCaptureHandle' in view.MediaStreamTrack.prototype)) return Promise.reject(new CaptureError('CAPABILITY_UNAVAILABLE', 'Este navegador no puede verificar una captura de la pestaña actual. Usá un adaptador de navegador.'));
      if (!view.navigator.userActivation?.isActive) return Promise.reject(new CaptureError('CAPABILITY_UNAVAILABLE', 'Habilitá las imágenes con un clic y elegí esta pestaña una vez. Después el chat podrá capturar la selección y la grabación.'));
      disconnected();
      const ownGeneration = generation;
      handle = view.crypto.randomUUID();
      devices.setCaptureHandleConfig({ handle, exposeOrigin: true, permittedOrigins: [view.location.origin] });
      // Invoke the native picker synchronously inside the user's click, before any await.
      let permission: Promise<MediaStream>;
      try { permission = devices.getDisplayMedia({ video: { displaySurface: 'browser', frameRate: { ideal: 30 } }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude', systemAudio: 'exclude' } as DisplayMediaStreamOptions); }
      catch (error) { permission = Promise.reject(error); }
      connecting = permission.then(async selected => {
        if (generation !== ownGeneration) { for (const track of selected.getTracks()) track.stop(); throw new CaptureError('CAPABILITY_UNAVAILABLE', 'La conexión de capturas ya fue cerrada.'); }
        stream = selected; verify();
        const track = stream.getVideoTracks()[0]!;
        track.addEventListener('ended', disconnected, { once: true });
        track.addEventListener('capturehandlechange', () => { try { verify(); } catch { disconnected(); } });
        view.addEventListener('pagehide', disconnected, { once: true });
        video = document.createElement('video'); video.muted = true; video.playsInline = true; video.srcObject = stream;
        await video.play(); verify();
        // Chrome's sharing indicator can resize the tab after the picker closes.
        // Settle that one-time permission transition before freezing any capture geometry.
        await settlePermissionViewport(view); verify();
      }).catch(error => {
        disconnected();
        if (error instanceof CaptureError) throw error;
        throw new CaptureError('CAPABILITY_UNAVAILABLE', 'La captura nativa fue cancelada, denegada o no está disponible.');
      }).finally(() => { connecting = null; });
      return connecting;
    },
    async captureViewport(request) {
      document ??= request.document;
      if (request.document !== currentDocument()) throw new CaptureError('STALE_CAPTURE', 'El proveedor pertenece a otra pestaña.');
      // Never open a permission picker while privacy masks and viewport geometry are frozen.
      if (!provider.isConnected()) throw new CaptureError('CAPABILITY_UNAVAILABLE', 'Habilitá las imágenes primero y elegí esta pestaña.');
      await request.ready; verify(); request.assertCurrent();
      const view = document!.defaultView!, canvas = document!.createElement('canvas');
      const deadline = view.performance.now() + 5000;
      let grabber: TrackFrameGrabber | null = null;
      const NativeImageCapture = (view as unknown as TrackFrameCaptureWindow).ImageCapture;
      if (typeof NativeImageCapture === 'function') {
        try { grabber = new NativeImageCapture(stream!.getVideoTracks()[0]!); }
        catch { /* Unsupported track types retain the real-video fallback. */ }
      }
      try {
        if (grabber) {
          // The first track snapshot can still be buffered before the toolbar was
          // hidden. Discard it, then let the compositor publish the current page.
          // Do not wait for multiple video callbacks: a static tab may not emit them.
          try {
            const buffered = await grabTrackFrame(view, grabber, Math.max(1, Math.min(1500, deadline - view.performance.now())));
            buffered.close(); verify(); request.assertCurrent();
            await new Promise<void>(resolve => view.setTimeout(resolve, 125));
            verify(); request.assertCurrent();
          } catch (error) {
            verify(); request.assertCurrent();
            if (error instanceof CaptureError && error.code !== 'CAPABILITY_UNAVAILABLE') throw error;
            grabber = null;
          }
        }
        while (view.performance.now() < deadline) {
          const currentVideo = video;
          if (!currentVideo) throw new CaptureError('CAPABILITY_UNAVAILABLE', 'La conexión de imágenes fue detenida. Volvé a habilitarla.');
          let bitmap: ImageBitmap | null = null;
          try {
            // grabFrame consumes the verified real track directly. Static or background
            // tabs need not present another <video> frame for an explicit screenshot.
            if (grabber) {
              try { bitmap = await grabTrackFrame(view, grabber, Math.max(1, Math.min(1500, deadline - view.performance.now()))); }
              catch { grabber = null; }
              verify(); request.assertCurrent();
            }
            if (!bitmap) {
              // Older/partial ImageCapture implementations retain an actual-video path.
              await new Promise<void>((resolve, reject) => {
                const timeout = view.setTimeout(() => { currentVideo.cancelVideoFrameCallback(callback); reject(new CaptureError('CAPABILITY_UNAVAILABLE', 'La pestaña no entregó un frame de video.')); }, Math.max(1, deadline - view.performance.now()));
                const callback = currentVideo.requestVideoFrameCallback(() => { view.clearTimeout(timeout); resolve(); });
              });
            }
            const capturedAt = new Date().toISOString();
            verify(); request.assertCurrent();
            canvas.width = bitmap?.width ?? currentVideo.videoWidth; canvas.height = bitmap?.height ?? currentVideo.videoHeight;
            if (!canvas.width || !canvas.height) continue;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) throw new CaptureError('CAPABILITY_UNAVAILABLE', 'El navegador no puede codificar la captura.');
            ctx.drawImage(bitmap ?? currentVideo, 0, 0);
            if (request.redactions.length && !frameHasMasks(ctx, canvas.width, canvas.height, request)) { ctx.clearRect(0, 0, canvas.width, canvas.height); continue; }
            // Reinforce optional compositor masks on the real captured frame.
            const sx = canvas.width / request.viewport.width, sy = canvas.height / request.viewport.height;
            ctx.fillStyle = 'rgb(24,24,27)';
            for (const { bounds } of request.redactions) {
              const x = Math.floor(bounds.x * sx), y = Math.floor(bounds.y * sy);
              ctx.fillRect(x, y, Math.ceil((bounds.x + bounds.width) * sx) - x, Math.ceil((bounds.y + bounds.height) * sy) - y);
            }
            const bytes = await encode(canvas); verify(); request.assertCurrent();
            return { bytes, capturedAt, pixelWidth: canvas.width, pixelHeight: canvas.height, provider: 'browser-display-media' };
          } finally { bitmap?.close(); }
        }
        throw new CaptureError('PRIVACY_REVIEW_REQUIRED', 'No llegó un frame con todas las regiones privadas protegidas.');
      } finally { canvas.width = 0; canvas.height = 0; }
    },
  };
  return provider;
}

export interface ExternalCapturePreparation {
  token: string; viewport: CaptureViewport; pathname: string; revision: number; preparedAt: string; expiresAt: string; toolbarHidden: boolean;
}
const pending = new Map<string, { prepared: ReturnType<typeof prepareCapture>; kind: ImageCaptureKind; timer: number }>();
/** Host/agent handshake: capture a real browser image only AFTER this promise resolves. */
export async function beginExternalCapture(options: CaptureOptions = {}): Promise<ExternalCapturePreparation> {
  const prepared = prepareCapture(options), token = prepared.document.defaultView!.crypto.randomUUID();
  try {
    await prepared.ready;
    const timer = prepared.document.defaultView!.setTimeout(() => cancelExternalCapture(token), 60_000);
    pending.set(token, { prepared, kind: options.kind ?? 'viewport', timer });
    return { token, viewport: prepared.viewport, pathname: prepared.pathname, revision: prepared.revision, preparedAt: prepared.preparedAt, expiresAt: new Date(Date.now() + 60_000).toISOString(), toolbarHidden: prepared.toolbarHidden };
  } catch (error) { prepared.restore(); throw error; }
}
/** The adapter must send an actual PNG file, not a URL or proposed filename. */
export async function completeExternalCapture(token: string, frame: RealCaptureFrame): Promise<CapturedImage> {
  const entry = pending.get(token);
  if (!entry) throw new CaptureError('STALE_CAPTURE', 'La preparación de captura venció o ya fue utilizada.');
  pending.delete(token); entry.prepared.document.defaultView!.clearTimeout(entry.timer);
  try { return await finishCapture(entry.prepared, frame, entry.kind); }
  finally { entry.prepared.restore(); }
}
export function cancelExternalCapture(token: string): void {
  const entry = pending.get(token); if (!entry) return;
  pending.delete(token); entry.prepared.document.defaultView!.clearTimeout(entry.timer); entry.prepared.restore();
}
