import { isPrivateElement } from '../browser/context.js';
import { sanitizePathname, sanitizeText, sanitizeUrl } from '../core/privacy.js';

/** Explicit project publication. None of these business rules are inferred from the UI. */
export interface DomainContext {
  name: string;
  purpose: string;
  users: string[];
  glossary: Array<{ term: string; definition: string }>;
  entities: Array<{ name: string; description: string }>;
  relationships: string[];
  flows: Array<{ name: string; steps: string[] }>;
  rules: string[];
  successCriteria: string[];
  fictional: boolean;
  source: string;
  provenance: 'declared';
}
export type DesignTokenCategory = 'color' | 'typography' | 'spacing' | 'radius' | 'shadow' | 'other';
export interface PublishedDesignContext {
  source: string;
  provenance: 'declared';
  tokens: Array<{ name: string; value: string; category?: DesignTokenCategory }>;
  components: Array<{ name: string; description: string; states: string[] }>;
  /** Approved public references, not included files. Query strings and credentials are removed. */
  assets: Array<{ id: string; description: string; url: string; mimeType?: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml'; availability: 'referenceOnly' }>;
}
export const OBSERVED_STYLE_PROPERTIES = [
  'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'text-align', 'text-transform',
  'display', 'position', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'gap', 'row-gap', 'column-gap',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'box-shadow', 'opacity', 'outline-color', 'outline-width', 'outline-style',
] as const;
export type ObservedStyleProperty = typeof OBSERVED_STYLE_PROPERTIES[number];
export interface ObservedDesignContext {
  source: 'getComputedStyle';
  provenance: 'observed';
  capturedAt: string;
  pathname: string;
  tag: string;
  styles: Partial<Record<ObservedStyleProperty, string>>;
  bounds: { x: number; y: number; width: number; height: number };
  /** Only states actually observed now. No inferred React component, breakpoint or source file. */
  states: Array<'focus' | 'focus-within' | 'hover' | 'disabled' | 'expanded' | 'busy'>;
}
export interface DesignContext { declared: PublishedDesignContext | null; observed: ObservedDesignContext | null }

function object(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
function text(value: unknown, limit = 500): string { return typeof value === 'string' ? sanitizeText(value, limit) : ''; }
function list(value: unknown, limit = 40, length = 500): string[] {
  return Array.isArray(value) ? value.slice(0, limit).map(item => text(item, length)).filter(Boolean) : [];
}
function records<T>(value: unknown, map: (entry: Record<string, unknown>) => T | null, limit = 60): T[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).flatMap(item => { const entry = object(item); const result = entry && map(entry); return result ? [result] : []; });
}
/** Whitelisting keeps arbitrary application objects, cookies or private extensions out. */
export function validateDomainContext(input: unknown): DomainContext | null {
  const value = object(input); if (!value) return null;
  const name = text(value.name, 120), purpose = text(value.purpose, 2000), source = text(value.source, 200);
  if (!name || !purpose || !source) return null;
  return {
    name, purpose, source, provenance: 'declared', fictional: value.fictional === true,
    users: list(value.users),
    glossary: records(value.glossary, item => { const term = text(item.term, 120), definition = text(item.definition, 1000); return term && definition ? { term, definition } : null; }),
    entities: records(value.entities, item => { const name = text(item.name, 120), description = text(item.description, 1000); return name && description ? { name, description } : null; }),
    relationships: list(value.relationships),
    flows: records(value.flows, item => { const name = text(item.name, 120), steps = list(item.steps); return name && steps.length ? { name, steps } : null; }),
    rules: list(value.rules, 60, 1000), successCriteria: list(value.successCriteria, 60, 1000),
  };
}
export function validatePublishedDesignContext(input: unknown): PublishedDesignContext | null {
  const value = object(input); if (!value) return null;
  const source = text(value.source, 200); if (!source) return null;
  return {
    source, provenance: 'declared',
    tokens: records(value.tokens, item => {
      const name = text(item.name, 120), tokenValue = text(item.value, 300);
      // Styles and tokens must never carry URLs, embedded payloads or CSS program text.
      if (!name || !tokenValue || /url\s*\(|data:|javascript:|expression\s*\(|[{};]/i.test(tokenValue)) return null;
      const result: PublishedDesignContext['tokens'][number] = { name, value: tokenValue };
      if (['color', 'typography', 'spacing', 'radius', 'shadow', 'other'].includes(String(item.category))) result.category = item.category as DesignTokenCategory;
      return result;
    }, 150),
    components: records(value.components, item => { const name = text(item.name, 120), description = text(item.description, 1000); return name && description ? { name, description, states: list(item.states, 20, 120) } : null; }),
    assets: records(value.assets, item => {
      const id = text(item.id, 100), description = text(item.description, 600);
      if (!id || !/^[a-z][a-z0-9_-]{0,99}$/i.test(id) || !description || typeof item.url !== 'string') return null;
      const url = sanitizeUrl(item.url); if (!/^https?:\/\//.test(url)) return null;
      const result: PublishedDesignContext['assets'][number] = { id, description, url, availability: 'referenceOnly' };
      if (['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(String(item.mimeType))) result.mimeType = item.mimeType as NonNullable<typeof result.mimeType>;
      return result;
    }),
  };
}
export function extractDesignContext(options: { published?: unknown; target?: Element | null; document?: Document } = {}): DesignContext {
  const declared = validatePublishedDesignContext(options.published), target = options.target;
  const empty: DesignContext = { declared, observed: null };
  if (!target || isPrivateElement(target)) return empty;
  const doc = options.document ?? target.ownerDocument, view = doc.defaultView;
  if (!view || target.ownerDocument !== doc || !target.isConnected) return empty;
  try {
    const computed = view.getComputedStyle(target), styles: ObservedDesignContext['styles'] = {};
    for (const key of OBSERVED_STYLE_PROPERTIES) {
      const value = computed.getPropertyValue(key);
      // Do not export custom properties, image URLs, generated content or variable names.
      if (value && !/url\s*\(|data:|javascript:|expression\s*\(/i.test(value)) styles[key] = sanitizeText(value, 300);
    }
    const r = target.getBoundingClientRect(), states: ObservedDesignContext['states'] = [];
    if (target === doc.activeElement) states.push('focus');
    if (doc.activeElement && target.contains(doc.activeElement)) states.push('focus-within');
    if (target.matches(':hover')) states.push('hover');
    if (target.matches(':disabled, [aria-disabled="true"]')) states.push('disabled');
    if (target.getAttribute('aria-expanded') === 'true') states.push('expanded');
    if (target.getAttribute('aria-busy') === 'true') states.push('busy');
    const coordinate = (value: number) => Number.isFinite(value) ? Math.round(Math.max(-100_000, Math.min(100_000, value)) * 100) / 100 : 0;
    return { declared, observed: {
      source: 'getComputedStyle', provenance: 'observed', capturedAt: new Date().toISOString(),
      pathname: sanitizePathname(view.location.pathname), tag: target.localName.slice(0, 40), styles,
      bounds: { x: coordinate(r.x), y: coordinate(r.y), width: coordinate(r.width), height: coordinate(r.height) }, states,
    } };
  } catch { return empty; }
}
