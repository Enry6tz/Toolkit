import type { ToolbarLocale } from './locale.js';
import type { ToolbarWiki } from './types.js';
import { validateWikiLinks } from './wiki.js';

export interface ToolbarRuntimeConfig {
  locale: ToolbarLocale;
  maxBodyChars: number;
  recordNetwork: boolean;
  wiki: ToolbarWiki | null;
}

export interface ToolbarLiveConfig {
  /** Same-origin server endpoint. Keep wiki credentials on that server. */
  url: string;
  /** Visible-tab polling interval, clamped to 2–60 seconds. Defaults to 5 seconds. */
  intervalMs?: number;
}

export function validateRuntimeConfig(value: unknown): ToolbarRuntimeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid toolbar configuration.');
  const input = value as Record<string, unknown>;
  if (!['en', 'es'].includes(input.locale as string) || !Number.isInteger(input.maxBodyChars)
    || (input.maxBodyChars as number) < 1 || (input.maxBodyChars as number) > 64000 || typeof input.recordNetwork !== 'boolean'
    || !Object.hasOwn(input, 'wiki') || input.wiki === undefined) throw new Error('Invalid toolbar configuration.');
  return { locale: input.locale as ToolbarLocale, maxBodyChars: input.maxBodyChars as number,
    recordNetwork: input.recordNetwork, wiki: input.wiki === null ? null : validateWikiLinks(input.wiki as ToolbarWiki)! };
}
