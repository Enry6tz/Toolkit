import { sanitizePathname, sanitizeText, sanitizeUrl, validateKnowledgeBundle } from '../core/index.js';
import { normalizePublicQueryParams } from '../core/privacy.js';
import { sanitizeActivityEntries } from '../core/activity.js';
import type { ActivityEntry } from '../core/activity.js';
import { sanitizeAnnotations } from '../core/annotations.js';
import type { AnnotationContext, BuildInfo, ContextSnapshot, ElementContext, KnowledgeBundle } from '../core/index.js';

const PRIVATE_SELECTOR = [
  'input', 'textarea', 'select', 'option', 'script', 'style', 'noscript', 'template',
  'iframe', 'object', 'embed', 'canvas',
  '[data-ai-private]', '[data-sensitive]', '[hidden]', '[inert]', '[aria-hidden="true"]',
  '[contenteditable]:not([contenteditable="false"])',
  '[data-ai-toolbar-root]', '[data-ai-toolbar-version]', '[data-ai-toolbar-overlay]',
].join(',');
const MAX_NODES = 300;
const MAX_DEPTH = 24;

export interface CaptureContextOptions {
  build: BuildInfo;
  rules?: readonly string[];
  target?: Element | null;
  knowledge?: KnowledgeBundle;
  activity?: readonly ActivityEntry[];
  annotations?: readonly AnnotationContext[];
  activeAnnotationId?: string;
  /** Public functional route state only; private parameter names are always excluded. */
  publicQueryParams?: readonly string[];
}

function parentElement(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return 'host' in root ? (root as ShadowRoot).host : null;
}

function excludedHere(element: Element): boolean {
  if (element.matches(PRIVATE_SELECTOR)) return true;
  const view = element.ownerDocument.defaultView;
  if (!view) return true;
  try {
    const style = view.getComputedStyle(element);
    return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
  } catch { return true; }
}

/** Fails closed for hidden, editable, private, detached or excessively deep nodes. */
export function isPrivateElement(element: Element): boolean {
  if (!element?.isConnected) return true;
  let current: Element | null = element;
  for (let depth = 0; current && depth < 64; depth += 1) {
    if (excludedHere(current)) return true;
    current = parentElement(current);
  }
  return current !== null;
}

/** Controls may be annotated through public metadata; their values remain unread. */
export function isInspectableElement(element: Element): boolean {
  if (!element?.isConnected) return false;
  if (!element.matches('input,select,textarea')) return !isPrivateElement(element);
  if (element.matches('[data-ai-private],[data-sensitive],[hidden],[inert],[aria-hidden="true"],input[type="password"],input[type="hidden"],input[type="file"]')) return false;
  const parent = parentElement(element);
  if (parent && isPrivateElement(parent)) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return !!style && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
}

const rootCache = new WeakMap<Document, { roots: Array<Document | ShadowRoot>; at: number }>();
/** Open component roots only; closed roots and iframe documents are intentionally excluded. */
export function queryPublicElements(doc: Document, selector: string): Element[] {
  const now = Date.now(), cached = rootCache.get(doc);
  let roots = cached && now - cached.at < 40 ? cached.roots : undefined;
  if (!roots) {
    roots = [doc];
    for (let i = 0; i < roots.length; i++) for (const element of roots[i]!.querySelectorAll('*')) {
      if (element.shadowRoot && !element.hasAttribute('data-ai-toolbar-host') && !isPrivateElement(element)) roots.push(element.shadowRoot);
    }
    rootCache.set(doc, { roots, at: now });
  }
  return roots.flatMap(root => Array.from(root.querySelectorAll(selector)));
}

/** A bounded walk avoids cloning large app trees or reading form values. */
function visibleText(element: Element, limit = 600): string {
  if (isPrivateElement(element)) return '';
  const parts: string[] = [];
  let length = 0;
  let visited = 0;
  const stack: Array<{ node: Node; depth: number }> = [{ node: element, depth: 0 }];
  while (stack.length && visited < MAX_NODES && length < limit * 2) {
    const entry = stack.pop();
    if (!entry) break;
    visited += 1;
    const { node, depth } = entry;
    if (node.nodeType === 3) {
      const chunk = (node.nodeValue ?? '').slice(0, limit * 2 - length);
      parts.push(chunk);
      length += chunk.length;
    } else if (node.nodeType === 1 && depth < MAX_DEPTH) {
      if (excludedHere(node as Element)) continue;
      // Only inspect as many children as the remaining node budget can visit.
      const children = node.childNodes;
      const count = Math.min(children.length, MAX_NODES - visited - stack.length);
      for (let index = count - 1; index >= 0; index -= 1) {
        const child = children.item(index);
        if (child) stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return sanitizeText(parts.join(' ').replace(/\s+/g, ' '), limit);
}

export function publicElementName(element: Element, fallbackText = visibleText(element)): string {
  const direct = element.getAttribute('aria-label');
  if (direct) return sanitizeText(direct.replace(/\s+/g, ' '), 200);
  const references = element.getAttribute('aria-labelledby')?.trim().split(/\s+/).slice(0, 6) ?? [];
  const names: string[] = [];
  for (const id of references) {
    if (id.length > 100) continue;
    const root = element.getRootNode() as Document | ShadowRoot;
    const label = root.getElementById?.(id);
    if (label && !isPrivateElement(label)) names.push(visibleText(label, 150));
  }
  if (names.some(Boolean)) return sanitizeText(names.join(' '), 200);
  if (element.matches('input,select,textarea')) {
    const labels = (element as HTMLInputElement).labels;
    const name = labels ? Array.from(labels).filter(label => !isPrivateElement(label)).map(label => visibleText(label, 150)).join(' ') : '';
    return name || element.tagName.toLowerCase();
  }
  if (element.tagName.toLowerCase() === 'img') {
    return sanitizeText(element.getAttribute('alt') ?? '', 200);
  }
  if (element.tagName.toLowerCase() === 'table') {
    const caption = element.querySelector('caption');
    if (caption && !isPrivateElement(caption)) return visibleText(caption, 200);
  }
  return sanitizeText(fallbackText, 200);
}

export function publicContainer(element: Element): ElementContext['container'] {
  const container = element.parentElement?.closest('section,article,form,nav,[role="region"],[role="dialog"],[data-ai-section]');
  if (!container || isPrivateElement(container)) return undefined;
  const heading = container.querySelector('h1,h2,h3');
  const name = container.getAttribute('aria-label') || (heading && !isPrivateElement(heading) ? visibleText(heading, 200) : '');
  return name ? { tag: container.localName, name: sanitizeText(name, 200) } : undefined;
}

function safeIdentifier(value: string | null): string | null {
  if (!value || !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/i.test(value) || value.length > 60) return null;
  if (/\d{4,}|password|token|secret|email|ssn|credential|authorization/i.test(value)) return null;
  if (sanitizeText(value) !== value) return null;
  return value;
}

function roleFor(element: Element): string | null {
  const explicit = element.getAttribute('role')?.split(/\s+/)[0];
  if (explicit && /^[a-z]{2,30}$/.test(explicit)) return explicit;
  const tag = element.tagName.toLowerCase();
  const roles: Record<string, string> = {
    button: 'button', img: 'img', ul: 'list', ol: 'list', li: 'listitem',
    table: 'table', tr: 'row', th: 'columnheader', td: 'cell',
    nav: 'navigation', main: 'main', aside: 'complementary', dialog: 'dialog',
  };
  if (tag === 'a' && element.hasAttribute('href')) return 'link';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  if (tag === 'input') return ['checkbox', 'radio', 'range'].includes(element.getAttribute('type') ?? '') ? element.getAttribute('type') === 'range' ? 'slider' : element.getAttribute('type') : 'textbox';
  return roles[tag] ?? null;
}

function coordinate(value: number): number {
  return Number.isFinite(value) ? Math.max(-100_000, Math.min(100_000, Math.round(value))) : 0;
}

export function inspectElement(element: Element): ElementContext | null {
  if (!element || !isInspectableElement(element)) return null;
  rootCache.delete(element.ownerDocument);
  const text = visibleText(element);
  const identifier = safeIdentifier(element.getAttribute('data-ai-id'));
  const rect = element.getBoundingClientRect();
  const result: ElementContext = {
    tag: element.tagName.toLowerCase().slice(0, 40),
    role: roleFor(element),
    accessibleName: publicElementName(element, text),
    selector: identifier ? `[data-ai-id="${identifier}"]` : null,
    text,
    bounds: {
      x: coordinate(rect.x), y: coordinate(rect.y),
      width: Math.max(0, coordinate(rect.width)), height: Math.max(0, coordinate(rect.height)),
    },
  };
  if (element.matches('input,select,textarea')) result.control = { type: element.getAttribute('type')?.toLowerCase().replace(/[^a-z-]/g, '').slice(0, 30) || element.localName,
    disabled: element.matches(':disabled'), readOnly: element.hasAttribute('readonly'), required: element.hasAttribute('required'), invalid: element.getAttribute('aria-invalid') === 'true' };
  const source = element.getAttribute('data-ai-source');
  if (source && /^(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+\.(?:[cm]?[jt]sx?|vue|svelte):[1-9]\d{0,6}(?::[1-9]\d{0,5})?$/i.test(source) && !source.includes('..')) result.source = source.slice(0, 240);
  try {
    const computed = element.ownerDocument.defaultView?.getComputedStyle(element), styles: Record<string, string> = {};
    for (const key of ['color', 'background-color', 'font-size', 'font-weight', 'line-height', 'display', 'position', 'padding', 'gap', 'border-radius']) {
      const value = computed?.getPropertyValue(key); if (value && value.length <= 150 && !/url\s*\(|data:|expression|[{};]/i.test(value)) styles[key] = value;
    }
    if (Object.keys(styles).length) result.styles = styles;
  } catch { /* Metadata is optional; selection remains usable. */ }
  const container = publicContainer(element); if (container) result.container = container;
  const component = element.getAttribute('data-ai-component');
  if (component && /^[A-Z][A-Za-z0-9_.-]{0,79}$/.test(component) && sanitizeText(component) === component) {
    result.component = component;
  }
  const root = element.getRootNode() as Document | ShadowRoot;
  for (const [attribute, strategy] of [['data-ai-id', 'published'], ['data-testid', 'testId'], ['data-qa', 'attribute'], ['data-cy', 'attribute'], ['data-test', 'attribute'], ['id', 'id']] as const) {
    const value = safeIdentifier(element.getAttribute(attribute));
    if (!value || !('querySelectorAll' in root)) continue;
    const selector = `[${attribute}="${value}"]`;
    const matches = Array.from(root.querySelectorAll(selector)).filter(isInspectableElement).length;
    if (matches === 1) {
      result.selector = selector;
      result.locator = { strategy, value: selector, matches, confidence: 'unique' };
      break;
    }
  }
  if (!result.locator) {
    const matches = (typeof root.querySelectorAll === 'function' ? Array.from(root.querySelectorAll(result.tag)).slice(0, 2000) : []).filter(node => isInspectableElement(node)
      && publicElementName(node) === result.accessibleName && (!result.container || (() => {
        const c = publicContainer(node); return c?.tag === result.container.tag && c.name === result.container.name;
      })())).length;
    result.selector = null;
    result.locator = { strategy: 'semantic', value: `${result.role ?? result.tag}: ${result.accessibleName}`, matches,
      confidence: matches === 1 ? 'unique' : matches > 1 ? 'ambiguous' : 'unavailable' };
  }
  return result;
}

/** Capture is explicit and browser-only; importing this module is safe during SSR. */
export function captureContext(options: CaptureContextOptions): ContextSnapshot {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('El contexto se captura desde el navegador.');
  }
  if (!['development', 'preview', 'production'].includes(options.build.environment)) {
    throw new Error('Indicá un entorno válido para capturar el contexto.');
  }
  const build: BuildInfo = { environment: options.build.environment };
  if (options.build.branch) build.branch = sanitizeText(options.build.branch, 100);
  if (options.build.buildId) build.buildId = sanitizeText(options.build.buildId, 100);
  const publicQueryParams = normalizePublicQueryParams(options.publicQueryParams);
  const context: ContextSnapshot = {
    schemaVersion: '1.0',
    capturedAt: new Date().toISOString(),
    page: {
      url: sanitizeUrl(window.location.href, publicQueryParams),
      pathname: sanitizePathname(window.location.pathname),
      ...(publicQueryParams.length ? { publicQueryParams } : {}),
      title: sanitizeText(document.title, 200),
      viewport: { width: Math.max(0, coordinate(window.innerWidth)), height: Math.max(0, coordinate(window.innerHeight)) },
    },
    build,
    target: options.target ? inspectElement(options.target) : null,
    rules: (options.rules ?? []).slice(0, 30).map(rule => sanitizeText(rule, 500)),
    privacy: { redactions: [
      'Campos editables, contenido privado, oculto y toolbar excluidos.',
      publicQueryParams.length
        ? 'Solo parámetros de URL declarados públicos; fragmentos, credenciales y parámetros privados excluidos.'
        : 'Parámetros de URL, fragmentos y credenciales de URL excluidos.',
      'Patrones comunes de credenciales y datos personales ocultos; revisá el resultado.',
      'Texto limitado a 600 caracteres por selección y 300 nodos recorridos.',
    ] },
  };
  if (options.knowledge) context.knowledge = validateKnowledgeBundle(options.knowledge);
  if (options.activity) context.activity = sanitizeActivityEntries(options.activity);
  if (options.annotations?.length) {
    context.annotations = sanitizeAnnotations(options.annotations);
    if (options.activeAnnotationId && context.annotations.some(item => item.id === options.activeAnnotationId)) context.activeAnnotationId = options.activeAnnotationId;
  }
  return context;
}
