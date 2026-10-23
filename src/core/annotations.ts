import { sanitizePathname, sanitizeText } from './privacy.js';
import type { AnnotationContext, ElementContext } from './types.js';
import { sanitizeRecordedContext } from './recorded-context.js';

const finite = (value: unknown, positive = false) => typeof value === 'number' && Number.isFinite(value)
  ? Math.max(positive ? 0 : -100_000, Math.min(100_000, Math.round(value))) : 0;
const text = (value: unknown, max: number) => sanitizeText(typeof value === 'string' ? value : '', max);
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function sanitizeElementContext(input: unknown): ElementContext | null {
  if (!input || typeof input !== 'object') return null;
  const value = object(input), bounds = object(value.bounds);
  const result: ElementContext = {
    tag: typeof value.tag === 'string' && /^[a-z][a-z0-9-]{0,40}$/i.test(value.tag) ? value.tag.toLowerCase() : 'element',
    role: value.role ? text(value.role, 40) : null,
    accessibleName: text(value.accessibleName, 200), selector: value.selector ? text(value.selector, 240) : null,
    text: text(value.text, 600), bounds: { x: finite(bounds.x), y: finite(bounds.y), width: finite(bounds.width, true), height: finite(bounds.height, true) },
  };
  if (value.component) result.component = text(value.component, 120);
  const locator = object(value.locator);
  if (['published', 'testId', 'id', 'attribute', 'semantic'].includes(String(locator.strategy))) result.locator = {
    strategy: locator.strategy as NonNullable<ElementContext['locator']>['strategy'], value: text(locator.value, 240),
    matches: finite(locator.matches, true), confidence: ['unique', 'ambiguous', 'unavailable'].includes(String(locator.confidence))
      ? locator.confidence as 'unique' | 'ambiguous' | 'unavailable' : 'unavailable',
  };
  if (typeof value.source === 'string' && /^(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+\.(?:[cm]?[jt]sx?|vue|svelte):[1-9]\d{0,6}(?::[1-9]\d{0,5})?$/i.test(value.source) && !value.source.includes('..')) result.source = value.source.slice(0, 240);
  const styles = object(value.styles), safeStyles: Record<string, string> = {};
  for (const key of ['color', 'background-color', 'font-size', 'font-weight', 'line-height', 'display', 'position', 'padding', 'gap', 'border-radius']) {
    const v = styles[key]; if (typeof v === 'string' && v.length <= 150 && !/url\s*\(|data:|expression|[{};]/i.test(v)) safeStyles[key] = text(v, 150);
  }
  if (Object.keys(safeStyles).length) result.styles = safeStyles;
  const control = object(value.control);
  if (typeof control.type === 'string' && /^[a-z-]{1,30}$/.test(control.type)) result.control = { type: control.type,
    disabled: control.disabled === true, readOnly: control.readOnly === true, required: control.required === true, invalid: control.invalid === true };
  const container = object(value.container);
  if (typeof container.tag === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(container.tag) && typeof container.name === 'string') result.container = { tag: container.tag, name: text(container.name, 200) };
  return result;
}

/** Also validates restored browser storage. Never trusts persisted JSON as an instruction. */
export function sanitizeAnnotations(input: unknown): AnnotationContext[] {
  if (!Array.isArray(input)) return [];
  const result: AnnotationContext[] = [], seen = new Set<string>();
  for (const raw of input) {
    const value = object(raw), bounds = object(value.bounds), viewport = object(value.viewport);
    if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id) || seen.has(value.id)
      || !['element', 'section', 'area', 'group'].includes(String(value.kind)) || typeof value.pathname !== 'string'
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
      || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) continue;
    seen.add(value.id);
    const context = sanitizeRecordedContext(value.context);
    result.push({ id: value.id, kind: value.kind as AnnotationContext['kind'], pathname: sanitizePathname(value.pathname),
      ...(context ? { context } : {}),
      ...(typeof value.caseId === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value.caseId) ? { caseId: value.caseId } : {}),
      ...(value.pending === true ? { pending: true } : {}),
      ...(value.kind === 'group' && Number.isSafeInteger(value.elementCount) && Number(value.elementCount) > 0 ? { elementCount: Math.min(100000, Number(value.elementCount)) } : {}),
      ...(typeof value.color === 'string' && /^#[0-9a-f]{6}$/i.test(value.color) ? { color: value.color.toLowerCase() } : {}),
      createdAt: value.createdAt, updatedAt: value.updatedAt, label: text(value.label, 200), note: text(value.note, 2000),
      bounds: { x: finite(bounds.x), y: finite(bounds.y), width: finite(bounds.width, true), height: finite(bounds.height, true) },
      viewport: { width: finite(viewport.width, true), height: finite(viewport.height, true) },
      element: sanitizeElementContext(value.element),
      relatedElements: Array.isArray(value.relatedElements) ? value.relatedElements.slice(0, value.kind === 'group' ? 200 : 8).map(sanitizeElementContext).filter((entry): entry is ElementContext => entry !== null) : [],
    });
  }
  return result;
}

export function annotationsMarkdown(input: readonly AnnotationContext[]): string {
  const escape = (value: string) => value.replace(/[\\`*_{}\[\]<>!#|]/g, '\\$&');
  return sanitizeAnnotations(input).map((item, index) => [
    `### ${index + 1}. ${escape(item.label)}`,
    `ID: ${item.id} · ${item.kind} · Ruta: ${escape(item.pathname)}`,
    item.viewport.width > 0 && item.viewport.height > 0
      ? `Viewport al marcar: ${item.viewport.width}×${item.viewport.height} CSS px.` : 'Viewport al marcar: no registrado.',
    `Zona en documento: esquina superior izquierda (x=${item.bounds.x}, y=${item.bounds.y}), ${item.bounds.width}×${item.bounds.height} CSS px.`,
    item.element ? `Elemento: ${escape(item.element.accessibleName || item.element.tag)} · ${escape(item.element.selector ?? item.element.locator?.value ?? 'sin selector único')}` : item.kind === 'group' ? `Concrete element group: ${item.elementCount ?? item.relatedElements.length} elements.` : 'Área libre; no representa un único componente.',
    item.note ? `Observación del usuario (referencia):\n${item.note.split('\n').map(line => '> ' + escape(line)).join('\n')}` : 'Sin observación escrita.',
    ...(item.relatedElements.length ? [`Elementos públicos de referencia (muestra acotada): ${item.relatedElements.map(entry => escape(entry.accessibleName || entry.tag)).join(', ')}.`] : []),
  ].join('\n\n')).join('\n\n');
}
