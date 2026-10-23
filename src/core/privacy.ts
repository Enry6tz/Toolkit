const MAX_TEXT_LENGTH = 12_000;

/** Best-effort pattern redaction. A person must still review every export. */
export function sanitizeText(value: string, maxLength = 2_000): string {
  const limit = Number.isFinite(maxLength)
    ? Math.max(0, Math.min(MAX_TEXT_LENGTH, Math.floor(maxLength)))
    : 2_000;
  return String(value)
    .slice(0, MAX_TEXT_LENGTH)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\b(?:Bearer|Runtime)\s+[^\s,;]+/gi, '[credencial oculta]')
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, '[credencial oculta]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[credencial oculta]')
    .replace(/\b(?:password|passwd|contrase(?:ñ|n)a|(?:bootstrap|runtime|binding)[-_.\s]*(?:token|secret|credential)|secret|token|(?:(?:presence|collaboration|execution)[-_.\s]*)?ticket|api[_-]?key|authorization)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '[credencial oculta]')
    .replace(/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+\b/gi, '[email oculto]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[identificador oculto]')
    .replace(/(^|[^\w])\+?\d[\d ().-]{7,}\d(?!\w)/g, (match, prefix: string) => {
      const digits = match.replace(/\D/g, '').length;
      return digits >= 9 && digits <= 19 ? `${prefix}[número oculto]` : match;
    })
    .trim()
    .slice(0, limit);
}

export function sanitizePathname(value: string): string {
  let decoded = String(value).split(/[?#]/, 1)[0] ?? '/';
  try { decoded = decodeURIComponent(decoded); } catch { /* Preserve malformed text safely. */ }
  return sanitizeText(decoded, 1_000) || '/';
}

const privateQueryName = /token|ticket|password|passwd|secret|credential|authorization|authentication|(?:^|[_-])auth(?:$|[_-])|signature|session|cookie|(?:api|access|private)[_-]?key|(?:^|[_-])key(?:$|[_-])|jwt|csrf|xsrf|bearer|email|e[-_]?mail|phone|telephone|ssn|passport|contrase(?:ñ|n)a/i;

/** Only explicitly published, bounded functional parameter names are allowed. */
export function normalizePublicQueryParams(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const key of value.slice(0, 100)) {
    if (typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(key)
      || privateQueryName.test(key) || sanitizeText(key) !== key || keys.includes(key)) continue;
    keys.push(key);
    if (keys.length === 20) break;
  }
  return keys;
}

/** Fragments and credentials are removed; only declared public query keys survive. */
export function sanitizeUrl(value: string, publicQueryParams?: readonly string[]): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '[URL no disponible]';
    const permitted = new Set(normalizePublicQueryParams(publicQueryParams));
    const query = new URLSearchParams(), counts = new Map<string, number>();
    for (const [key, value] of url.searchParams) {
      if (!permitted.has(key) || (counts.get(key) ?? 0) >= 4 || value.length > 256
        || sanitizeText(value, 256) !== value || /https?:\/\/|^\/\//i.test(value)) continue;
      const previous = query.toString();
      query.append(key, value);
      if (query.toString().length > 3_072) {
        // The previous complete query is reproducible; truncated values are not.
        return `${url.origin}${sanitizePathname(url.pathname)}${previous ? `?${previous}` : ''}`;
      }
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const search = query.toString();
    return `${url.origin}${sanitizePathname(url.pathname)}${search ? `?${search}` : ''}`;
  } catch {
    return '[URL no disponible]';
  }
}
