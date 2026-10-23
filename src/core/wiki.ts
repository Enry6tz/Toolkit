import type { ToolbarWiki } from './types.js';
import { validateDocumentRoutes } from './knowledge.js';

function wikiUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\u0000-\u0020]/.test(value)) throw new Error('Wiki links must be absolute HTTP(S) URLs without credentials.');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Wiki links must be absolute HTTP(S) URLs without credentials.');
  return url;
}

export function validateWikiLinks(value: ToolbarWiki | undefined): ToolbarWiki | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid wiki configuration.');
  const general = wikiUrl(value.url);
  if (value.documents !== undefined && (!Array.isArray(value.documents) || value.documents.length > 100)) throw new Error('Configure up to 100 wiki links.');
  const seen = new Set<string>();
  const documents = (value.documents ?? []).map(document => {
    if (!document || typeof document.label !== 'string' || !document.label.trim() || document.label.length > 100 || /[\u0000-\u001F]/.test(document.label)) throw new Error('Each wiki link needs a title up to 100 characters.');
    const url = wikiUrl(document.url);
    if (url.origin !== general.origin) throw new Error('Document links must belong to the configured wiki origin.');
    if (seen.has(url.href)) throw new Error('Wiki document links must be unique.');
    seen.add(url.href);
    const routes = validateDocumentRoutes(document.routes);
    const excludedRoutes = validateDocumentRoutes(document.excludedRoutes);
    return { label: document.label.trim(), url: url.href, ...(routes ? { routes } : {}), ...(excludedRoutes ? { excludedRoutes } : {}) };
  });
  const manageUrl = value.manageUrl === undefined ? undefined : wikiUrl(value.manageUrl);
  if (manageUrl && manageUrl.origin !== general.origin) throw new Error('Wiki controls must belong to the wiki origin.');
  return { url: general.href, ...(documents.length ? { documents } : {}), ...(manageUrl ? { manageUrl: manageUrl.href } : {}) };
}
