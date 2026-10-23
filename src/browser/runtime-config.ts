import { validateRuntimeConfig } from '../core/runtime-config.js';
import type { ToolbarLiveConfig, ToolbarRuntimeConfig } from '../core/runtime-config.js';
import { fetchOutsideRecording } from './activity.js';

/** Keep the last valid configuration on outages; never overlap or record sync requests. */
export function watchRuntimeConfig(view: Window, source: ToolbarLiveConfig, receive: (value: ToolbarRuntimeConfig) => void): () => void {
  const url = new URL(source.url, view.location.href);
  if (url.origin !== view.location.origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error('Live configuration must use a same-origin HTTP(S) endpoint.');
  const interval = Number.isFinite(source.intervalMs) ? Math.max(2000, Math.min(60000, source.intervalMs!)) : 5000;
  let active = true, timer = 0, pending: AbortController | null = null, failures = 0, fingerprint = '';
  function schedule() {
    view.clearTimeout(timer);
    if (active && view.document.visibilityState !== 'hidden') timer = view.setTimeout(() => { void refresh(); }, Math.min(60000, interval * 2 ** Math.min(failures, 4)));
  }
  async function refresh() {
    if (!active || pending || view.document.visibilityState === 'hidden') return;
    const abort = new AbortController(); pending = abort;
    const timeout = view.setTimeout(() => abort.abort(), 8000);
    try {
      const response = await fetchOutsideRecording(view, url.href, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: abort.signal, headers: { Accept: 'application/json' } });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json') || !response.body) throw new Error('Configuration unavailable.');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let content = '', bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 131072) throw new Error('Configuration exceeds 128 KiB.');
          content += decoder.decode(part.value, { stream: true });
        }
        content += decoder.decode();
      } finally { void reader.cancel().catch(() => undefined); }
      const value = validateRuntimeConfig(JSON.parse(content)), next = JSON.stringify(value);
      if (active && !abort.signal.aborted && next !== fingerprint) { fingerprint = next; receive(value); }
      failures = 0;
    } catch { failures++; }
    finally { view.clearTimeout(timeout); pending = null; schedule(); }
  }
  const wake = () => { view.clearTimeout(timer); void refresh(); };
  view.document.addEventListener('visibilitychange', wake);
  view.addEventListener('focus', wake); view.addEventListener('online', wake);
  view.addEventListener('ai-context-toolbar:config-changed', wake);
  void refresh();
  return () => {
    active = false; view.clearTimeout(timer); pending?.abort();
    view.document.removeEventListener('visibilitychange', wake);
    view.removeEventListener('focus', wake); view.removeEventListener('online', wake);
    view.removeEventListener('ai-context-toolbar:config-changed', wake);
  };
}
