import { sanitizePathname } from '../core/privacy.js';
import { sanitizeAnnotations } from '../core/annotations.js';
import type { AnnotationContext } from '../core/types.js';
import { inspectElement, isPrivateElement, isInspectableElement, publicElementName, publicContainer, queryPublicElements } from './context.js';
import { createTranslator } from '../core/locale.js';
import type { ToolbarLocale } from '../core/locale.js';
import { visibleElementBounds } from './selection-geometry.js';

export type SelectionMode = Exclude<AnnotationContext['kind'], 'group'>;
export interface SelectionBounds { x: number; y: number; width: number; height: number }
export interface SelectionResult { annotation: AnnotationContext; element: Element | null }
export const ANNOTATIONS_STORAGE_KEY = 'ai-context:annotations:1';
const lifetime = 7 * 24 * 60 * 60 * 1000;
const maxDraftCharacters = 4 * 1024 * 1024;

/** Each integrator can publish component/section boundaries without React internals. */
export function selectionElement(element: Element, mode: SelectionMode): Element | null {
  if (!isInspectableElement(element)) return null;
  const selector = mode === 'section'
    ? '[data-ai-section], section, article, table, form, [role="region"], [role="dialog"], nav, aside, main'
    : 'button, input, select, textarea, a[href], [role="button"], h1, h2, h3, h4, h5, h6, p, th, td, img, li, [data-ai-id], [data-ai-component]';
  const result = element.closest(selector) ?? element;
  return ['HTML', 'BODY'].includes(result.tagName) || !isInspectableElement(result) ? null : result;
}

export function createSelection(doc: Document, kind: SelectionMode, element: Element | null, area?: SelectionBounds, locale: ToolbarLocale = 'en'): SelectionResult | null {
  const view = doc.defaultView;
  if (!view) return null;
  const selected = element && kind !== 'area' ? element : null;
  const context = selected ? inspectElement(selected) : null;
  if (kind !== 'area' && !context) return null;
  const region = area ?? context?.bounds;
  if (!region || region.width < 2 || region.height < 2) return null;
  const related = kind === 'area' ? Array.from(doc.querySelectorAll('button, a[href], h1, h2, h3, th, [data-ai-id], [data-ai-component]'))
    .slice(0, 2000).filter(node => {
      if (isPrivateElement(node)) return false;
      const r = node.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.left < region.x + region.width && r.right > region.x
        && r.top < region.y + region.height && r.bottom > region.y;
    }).slice(0, 8).map(inspectElement).filter((entry): entry is NonNullable<typeof entry> => entry !== null) : [];
  const at = new Date().toISOString();
  const annotation: AnnotationContext = { id: view.crypto.randomUUID(), kind,
    pathname: sanitizePathname(view.location.pathname), createdAt: at, updatedAt: at,
    label: kind === 'area' ? `${createTranslator(locale)('Área libre')} · ${Math.round(region.width)} × ${Math.round(region.height)}`
      : kind === 'section' ? (selected?.getAttribute('aria-label') || selected?.querySelector('h1,h2,h3')?.textContent?.trim() || context!.accessibleName || context!.tag).slice(0, 200)
      : context!.accessibleName || context!.tag,
    note: '', bounds: { x: Math.round(region.x + view.scrollX), y: Math.round(region.y + view.scrollY), width: Math.round(region.width), height: Math.round(region.height) },
    viewport: { width: view.innerWidth, height: view.innerHeight }, element: context, relatedElements: related };
  return { annotation, element: selected };
}

/** A rectangle gathers actual public elements; empty space is never an annotation. */
export function createGroupSelection(doc: Document, area: SelectionBounds, locale: ToolbarLocale = 'en'): SelectionResult | null {
  const view = doc.defaultView;
  if (!view) return null;
  const elements = groupElements(doc, area);
  if (!elements.length) return null;
  const related = elements.slice(0, 200).map(inspectElement).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .map(element => ({ ...element, bounds: { ...element.bounds, x: Math.round(element.bounds.x + view.scrollX), y: Math.round(element.bounds.y + view.scrollY) } }));
  if (!related.length) return null;
  const left = Math.min(...related.map(item => item.bounds.x)), top = Math.min(...related.map(item => item.bounds.y));
  const right = Math.max(...related.map(item => item.bounds.x + item.bounds.width)), bottom = Math.max(...related.map(item => item.bounds.y + item.bounds.height));
  const t = createTranslator(locale), labels = related.slice(0, 3).map(item => item.accessibleName || item.text || item.tag).join(', ');
  const at = new Date().toISOString();
  return { element: null, annotation: { id: view.crypto.randomUUID(), kind: 'group', elementCount: elements.length,
    label: t('{count} elementos: {labels}', { count: elements.length, labels }).slice(0, 200), pathname: sanitizePathname(view.location.pathname),
    createdAt: at, updatedAt: at, note: '', bounds: { x: left, y: top, width: right - left, height: bottom - top },
    viewport: { width: view.innerWidth, height: view.innerHeight }, element: null, relatedElements: related } };
}

function groupElements(doc: Document, area: SelectionBounds): Element[] {
  const candidates = queryPublicElements(doc, 'button,input,select,textarea,a[href],[role="button"],h1,h2,h3,h4,h5,h6,p,label,li,th,td,img,[data-ai-id],[data-testid],[data-ai-component]').filter(node => {
    if (!isInspectableElement(node) || node.closest('[data-ai-toolbar-host]')) return false;
    const box = visibleElementBounds(node);
    return box && box.width > 1 && box.height > 1 && box.x >= area.x - 1 && box.y >= area.y - 1 && box.x + box.width <= area.x + area.width + 1 && box.y + box.height <= area.y + area.height + 1;
  });
  // Avoid annotating a container and its children twice.
  const ancestors = new Set<Element>();
  const parentOf = (node: Element): Element | null => node.parentElement ?? ((node.getRootNode() as ShadowRoot).host || null);
  for (const node of candidates) for (let parent = parentOf(node); parent; parent = parentOf(parent)) ancestors.add(parent);
  return candidates.filter(node => !ancestors.has(node));
}

/** Local drafts only. No collection until a person explicitly marks a region. */
function annotationKey(caseId?: string): string {
  if (!caseId) return ANNOTATIONS_STORAGE_KEY;
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(caseId)) throw new Error('Identificador de caso no válido.');
  return `${ANNOTATIONS_STORAGE_KEY}:${encodeURIComponent(caseId)}`;
}
export function loadAnnotations(view: Window, caseId?: string, onWarning?: (message: string) => void): AnnotationContext[] {
  try {
    const raw = view.localStorage.getItem(annotationKey(caseId)) ?? (caseId ? view.localStorage.getItem(ANNOTATIONS_STORAGE_KEY) : null);
    if (!raw) return [];
    if (raw.length > maxDraftCharacters) throw new Error('El borrador de marcas supera el tamaño que este navegador puede recuperar.');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('El borrador de marcas no se pudo leer.');
    const scoped = caseId && Array.isArray(parsed) ? parsed.filter(item => item?.caseId === caseId) : parsed;
    return sanitizeAnnotations(scoped).filter(item => Date.now() - Date.parse(item.updatedAt) < lifetime && Date.parse(item.updatedAt) <= Date.now() + 60_000);
  } catch (cause) { onWarning?.(cause instanceof Error ? cause.message : 'No se pudieron recuperar las marcas guardadas.'); return []; }
}
export function saveAnnotations(view: Window, input: readonly AnnotationContext[], caseId?: string): boolean {
  try {
    const groups = new Map<string | undefined, AnnotationContext[]>();
    if (caseId) groups.set(caseId, input.filter(item => item.caseId === caseId));
    else {
      for (const item of input) {
        const group = groups.get(item.caseId) ?? []; group.push(item); groups.set(item.caseId, group);
      }
      if (!groups.has(undefined)) groups.set(undefined, []);
    }
    const writes = [...groups].sort(([left], [right]) => left ? right ? 0 : -1 : right ? 1 : 0).map(([id, items]) => {
      const value = JSON.stringify(sanitizeAnnotations(items));
      if (value.length > maxDraftCharacters) throw new Error('Las marcas de esta grabación exceden el almacenamiento disponible.');
      return { key: annotationKey(id), value, remove: !id && !items.length };
    });
    for (const write of writes) {
      if (write.remove) view.localStorage.removeItem(write.key);
      else view.localStorage.setItem(write.key, write.value);
    }
    return true;
  } catch { return false; }
}

/** Reattach only a unique published locator; unresolved marks retain their honest observed geometry. */
export function annotationPosition(doc: Document, item: AnnotationContext): { status: 'matched' | 'ambiguous' | 'historical'; element: Element | null } {
  const selector = item.element?.selector;
  const element = item.element;
  if (!element) return { status: 'historical', element: null };
  let candidates: Element[] = [];
  if (selector && /^\[(?:data-ai-id|data-testid|data-qa|data-cy|data-test|id)="[a-z][a-z0-9_-]{0,59}"\]$/i.test(selector)) candidates = queryPublicElements(doc, selector);
  else if (/^[a-z][a-z0-9-]{0,40}$/i.test(element.tag) && element.accessibleName) candidates = queryPublicElements(doc, element.tag);
  if (candidates.length > 2000) return { status: 'ambiguous', element: null };
  candidates = candidates.filter(node => isInspectableElement(node) && node.localName === element.tag && publicElementName(node) === element.accessibleName);
  if (element.container) candidates = candidates.filter(node => {
    const c = publicContainer(node); return c?.tag === element.container!.tag && c.name === element.container!.name;
  });
  return { status: candidates.length === 1 ? 'matched' : candidates.length > 1 ? 'ambiguous' : 'historical', element: candidates.length === 1 ? candidates[0]! : null };
}
export function resolveAnnotation(doc: Document, item: AnnotationContext): Element | null {
  return annotationPosition(doc, item).element;
}

export function installSelection(options: {
  document: Document; host: Element; mode: SelectionMode | 'auto'; locale?: ToolbarLocale;
  onPreview(bounds: (SelectionBounds & { tag: string; members?: SelectionBounds[] }) | null): void;
  onSelect(result: SelectionResult): void; onCancel(): void; onMessage(message: string): void;
}): () => void {
  const doc = options.document, view = doc.defaultView!;
  const t = createTranslator(options.locale ?? 'en');
  let hovered: Element | null = null, chosen: Element | null = null, frame = 0, dragged = false;
  let start: { x: number; y: number; pointerId: number } | null = null;
  let pointer: { x: number; y: number } | null = null, section = false;
  const own = (event: Event) => event.composedPath().includes(options.host);
  const target = (event: Event) => event.composedPath().find(node => (node as Node).nodeType === 1) as Element | undefined;
  const suppress = (event: Event) => { if (!own(event)) { event.preventDefault(); event.stopImmediatePropagation(); } };
  const blockFollowingClick = () => {
    const stop = (event: Event) => { if (!own(event)) suppress(event); doc.removeEventListener('click', stop, true); };
    doc.addEventListener('click', stop, true); view.setTimeout(() => doc.removeEventListener('click', stop, true), 500);
  };
  const draw = (node: Element | null) => {
    chosen = node && selectionElement(node, options.mode === 'auto' ? section ? 'section' : 'element' : options.mode);
    const r = chosen && visibleElementBounds(chosen);
    options.onPreview(r ? { x: r.x, y: r.y, width: r.width, height: r.height, tag: chosen!.localName } : null);
  };
  const area = (x: number, y: number) => ({ x: Math.max(0, Math.min(start!.x, x)), y: Math.max(0, Math.min(start!.y, y)),
    width: Math.abs(Math.max(0, Math.min(view.innerWidth, x)) - start!.x), height: Math.abs(Math.max(0, Math.min(view.innerHeight, y)) - start!.y) });
  const move = (event: PointerEvent) => {
    pointer = own(event) ? null : { x: event.clientX, y: event.clientY }; section = event.shiftKey;
    if (options.mode === 'area' || (options.mode === 'auto' && start && Math.abs(event.clientX - start.x) >= 8 && Math.abs(event.clientY - start.y) >= 8)) {
      if (start && event.pointerId === start.pointerId) {
        if (frame) view.cancelAnimationFrame(frame);
        frame = view.requestAnimationFrame(() => { frame = 0; if (!start) return;
          const bounds = area(event.clientX, event.clientY);
          options.onPreview({ ...bounds, tag: t(options.mode === 'auto' ? 'Selección múltiple' : 'Área libre'),
            ...(options.mode === 'auto' ? { members: groupElements(doc, bounds).slice(0, 200).flatMap(node => { const box = visibleElementBounds(node); return box ? [box] : []; }) } : {}) });
        });
      }
      return;
    }
    hovered = !own(event) ? target(event) ?? null : null;
    if (!frame) frame = view.requestAnimationFrame(() => { frame = 0; draw(hovered); });
  };
  const down = (event: PointerEvent) => {
    if (own(event)) return;
    dragged = false;
    suppress(event);
    if ((options.mode === 'area' || options.mode === 'auto') && event.button === 0 && event.isPrimary) start = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  };
  const up = (event: PointerEvent) => {
    if (own(event) && !start) return;
    suppress(event);
    if ((options.mode !== 'area' && options.mode !== 'auto') || !start || event.pointerId !== start.pointerId) return;
    const bounds = area(event.clientX, event.clientY);
    start = null;
    if (bounds.width < 8 || bounds.height < 8) {
      if (options.mode === 'area') { options.onPreview(null); options.onMessage(t('Arrastrá para marcar un área de al menos 8 × 8 px.')); }
      else { const node = target(event); if (node?.matches('input,select,textarea')) {
        const result = createSelection(doc, 'element', node, undefined, options.locale);
        if (result) { dragged = true; blockFollowingClick(); options.onSelect(result); }
      } }
      return;
    }
    const result = options.mode === 'auto' ? createGroupSelection(doc, bounds, options.locale) : createSelection(doc, 'area', null, bounds, options.locale);
    if (!result && options.mode === 'auto') { dragged = true; options.onPreview(null); options.onMessage(t('No hay elementos dentro de esa selección. Arrastrá sobre contenido visible.')); }
    if (result) {
      dragged = true;
      // The browser emits click after pointerup. Block that final app action even
      // if React has already unmounted the selector after committing the area.
      blockFollowingClick();
      options.onSelect(result);
    }
  };
  const finish = (event: Event) => {
    if (own(event)) return;
    suppress(event);
    if (dragged) { dragged = false; return; }
    if (options.mode === 'area') return;
    const candidate = target(event);
    // A click commits its own event target. A pending pointermove frame or the
    // initial keyboard focus must never redirect it to yesterday's hover.
    const mode = options.mode === 'auto' ? (event as MouseEvent).shiftKey ? 'section' : 'element' : options.mode;
    const result = createSelection(doc, mode, event.type === 'keydown' && chosen
      ? chosen : candidate ? selectionElement(candidate, mode) : null, undefined, options.locale);
    if (result) options.onSelect(result);
    else options.onMessage(t('Elegí contenido público fuera de los campos editables.'));
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Shift') { section = true; draw(hovered); }
    if (event.key === 'Escape') { suppress(event); options.onCancel(); }
    else if (!own(event) && event.key === 'Enter') finish(event);
    else if (!own(event) && options.mode !== 'area' && chosen && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      suppress(event);
      const next = event.key === 'ArrowUp' ? chosen.parentElement : Array.from(chosen.children).find(node => !isPrivateElement(node));
      if (next && !['HTML', 'BODY'].includes(next.tagName) && !isPrivateElement(next)) {
        chosen = next;
        const r = next.getBoundingClientRect();
        options.onPreview({ x: r.x, y: r.y, width: r.width, height: r.height, tag: next.localName });
      }
    }
  };
  const focus = (event: FocusEvent) => { if (!own(event) && options.mode !== 'area') draw(target(event) ?? null); };
  const clear = () => { start = null; chosen = null; options.onPreview(null); };
  const hit = (root: Document | ShadowRoot, x: number, y: number): Element | null => {
    const node = root.elementFromPoint(x, y);
    return node?.shadowRoot && !node.hasAttribute('data-ai-toolbar-host') ? hit(node.shadowRoot, x, y) ?? node : node;
  };
  const scrolled = () => {
    // A drag cannot retain viewport coordinates across scroll. Cancel it without committing a click.
    if (start) { start = null; dragged = true; blockFollowingClick(); }
    if (frame) view.cancelAnimationFrame(frame);
    frame = view.requestAnimationFrame(() => { frame = 0;
      hovered = pointer ? hit(doc, pointer.x, pointer.y) : hovered;
      draw(hovered);
    });
  };
  const keyUp = (event: KeyboardEvent) => { if (event.key === 'Shift') { section = false; draw(hovered); } };
  doc.addEventListener('pointermove', move, true); doc.addEventListener('pointerdown', down, true); doc.addEventListener('pointerup', up, true);
  doc.addEventListener('click', finish, true); doc.addEventListener('keydown', key, true); doc.addEventListener('focusin', focus, true);
  doc.addEventListener('mousedown', suppress, true); doc.addEventListener('mouseup', suppress, true); doc.addEventListener('pointercancel', clear, true);
  doc.addEventListener('keyup', keyUp, true);
  view.addEventListener('scroll', scrolled, true); view.addEventListener('resize', scrolled); view.addEventListener('blur', clear);
  if (options.mode !== 'area' && doc.activeElement && !options.host.contains(doc.activeElement) && doc.activeElement !== options.host) draw(doc.activeElement);
  return () => {
    view.cancelAnimationFrame(frame);
    doc.removeEventListener('pointermove', move, true); doc.removeEventListener('pointerdown', down, true); doc.removeEventListener('pointerup', up, true);
    doc.removeEventListener('click', finish, true); doc.removeEventListener('keydown', key, true); doc.removeEventListener('focusin', focus, true);
    doc.removeEventListener('mousedown', suppress, true); doc.removeEventListener('mouseup', suppress, true); doc.removeEventListener('pointercancel', clear, true);
    doc.removeEventListener('keyup', keyUp, true);
    view.removeEventListener('scroll', scrolled, true); view.removeEventListener('resize', scrolled); view.removeEventListener('blur', clear);
  };
}
