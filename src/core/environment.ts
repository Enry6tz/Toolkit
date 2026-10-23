import type { ToolbarEnvironmentOptions } from './types.js';

/** Production needs an explicit opt-in even when `enabled` is true. */
export function isToolbarEnabled(options: ToolbarEnvironmentOptions): boolean {
  if (options.enabled === false) return false;
  if (!['development', 'preview', 'production'].includes(options.environment)) return false;
  if (options.environment === 'production' && options.allowProduction !== true) return false;
  if (options.branches && (!options.branch || !options.branches.includes(options.branch))) return false;
  return true;
}
