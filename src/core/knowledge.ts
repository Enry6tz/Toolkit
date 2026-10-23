import type { BundledDocument, KnowledgeBundle, ToolbarMode } from './types.js';

export const MAX_DOCUMENT_BYTES = 64 * 1_024;
export const MAX_KNOWLEDGE_BYTES = 256 * 1_024;
export const MAX_DOCUMENTS = 30;

export function validateDocumentRoutes(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > 30 || value.some(route => typeof route !== 'string'
    || route.length > 500 || !route.startsWith('/') || route.startsWith('//') || /[\\?#\s%]/.test(route)
    || route.split('/').some(segment => segment === '.' || segment === '..') || (route.includes('*') && !(route.endsWith('/**') && !route.slice(0, -3).includes('*'))))
    || new Set(value).size !== value.length) throw new Error('Document routes must be exact application paths or end with /**.');
  return [...value];
}

export function documentMatchesRoute(document: Pick<BundledDocument, 'routes'> & { excludedRoutes?: readonly string[] }, pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  if (document.excludedRoutes?.includes(path)) return false;
  return !document.routes || document.routes.some(route => route.endsWith('/**')
    ? path === route.slice(0, -3) || path.startsWith(route.slice(0, -2))
    : path === (route.length > 1 ? route.replace(/\/$/, '') : route));
}

/** Optional mode metadata has one meaning in Node configuration and client bundles. */
export function validateDocumentModes(value: unknown): readonly ToolbarMode[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 3
    || value.some(mode => !['test', 'design', 'report'].includes(mode)) || new Set(value).size !== value.length)
    throw new Error('Los modos de un documento deben ser test, design o report, sin duplicados y con al menos uno.');
  return [...value] as ToolbarMode[];
}

/** Validates the public schema and sizes; checksums are generated at build time. */
export function validateKnowledgeBundle(bundle: KnowledgeBundle): KnowledgeBundle {
  if (!bundle || bundle.schemaVersion !== '1.0' || !Array.isArray(bundle.documents) || bundle.documents.length > MAX_DOCUMENTS) {
    throw new Error('El paquete de documentación no es válido.');
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  const documents: BundledDocument[] = [];
  let bytes = 0;
  for (const document of bundle.documents) {
    if (!document || typeof document.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(document.id)
      || typeof document.label !== 'string' || !document.label.trim() || document.label.length > 100
      || /[\r\n\u0000-\u001F]/.test(document.label)
      || typeof document.content !== 'string' || document.content.includes('\0')
      || typeof document.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(document.checksum)) {
      throw new Error('Un documento del paquete no es válido.');
    }
    const label = document.label.trim();
    const modes = validateDocumentModes(document.modes);
    const routes = validateDocumentRoutes(document.routes);
    const labelKey = label.normalize('NFKC').toLowerCase();
    if (ids.has(document.id) || labels.has(labelKey)) throw new Error('Los identificadores y las etiquetas de documentos deben ser únicos.');
    ids.add(document.id);
    labels.add(labelKey);
    const size = new TextEncoder().encode(document.content).byteLength;
    bytes += size;
    if (size > MAX_DOCUMENT_BYTES || bytes > MAX_KNOWLEDGE_BYTES) {
      throw new Error('La documentación supera el tamaño permitido.');
    }
    documents.push({ id: document.id, label, content: document.content, checksum: document.checksum,
      ...(modes ? { modes } : {}), ...(routes ? { routes } : {}) });
  }
  return { schemaVersion: '1.0', documents };
}
