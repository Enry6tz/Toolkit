interface TabPersistence {
  key: string;
  /** A duplicated tab must not resume its opener's live recording. */
  duplicated: boolean;
  dispose(): void;
}

/** sessionStorage survives navigation/reload but is independent for newly opened tabs. */
export async function createTabPersistence(view: Window, namespace: string, signal?: AbortSignal): Promise<TabPersistence> {
  const bytes = await view.crypto.subtle.digest('SHA-256', new TextEncoder().encode(namespace));
  const hash = Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
  if (signal?.aborted) throw new DOMException('The tab persistence operation was aborted.', 'AbortError');
  const storageKey = `ai-context-toolbar:tab:${hash}`;
  let tabId: string | null = null;
  try { tabId = view.sessionStorage.getItem(storageKey); } catch { /* Durable recordings still remain in IndexedDB. */ }
  const existing = Boolean(tabId && /^[a-f0-9-]{36}$/i.test(tabId));
  if (!existing) tabId = view.crypto.randomUUID();
  let channel: BroadcastChannel | undefined, duplicated = false;
  let releaseLock: () => void = () => {};
  const locks = view.navigator?.locks;
  async function claimLock(): Promise<boolean | null> {
    if (!locks) return null;
    return new Promise(resolve => {
      void locks.request(`ai-context-toolbar:tab:${hash}:${tabId}`, { ifAvailable: true }, lock => {
        if (!lock) { resolve(false); return; }
        const held = new Promise<void>(release => { releaseLock = release; });
        resolve(true);
        return held;
      }).catch(() => resolve(null));
    });
  }
  let locked = await claimLock();
  if (locked === false) {
    duplicated = true;
    tabId = view.crypto.randomUUID();
    locked = await claimLock();
  }
  const claim = view.crypto.randomUUID();
  try {
    const Channel = (view as Window & { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    // Web Locks also detect an occupied tab while its page is suspended.
    // BroadcastChannel is the fallback for browsers without that capability.
    if (locked !== true && Channel && !signal?.aborted) {
      channel = new Channel(`ai-context-toolbar:tabs:${hash}`);
      const current = channel;
      current.onmessage = (event: MessageEvent<unknown>) => {
        const data = event.data as { kind?: unknown; tabId?: unknown; claim?: unknown } | null;
        if (!data || typeof data !== 'object' || data.tabId !== tabId || data.claim === claim) return;
        if (data.kind === 'probe') current.postMessage({ kind: 'occupied', tabId, claim: data.claim });
      };
      if (existing) {
        duplicated = await new Promise<boolean>(resolve => {
          let finished = false;
          const finish = (found: boolean) => { if (finished) return; finished = true; view.clearTimeout(timer); current.removeEventListener('message', occupied); signal?.removeEventListener('abort', aborted); resolve(found); };
          const occupied = (event: MessageEvent<unknown>) => {
            const data = event.data as { kind?: unknown; claim?: unknown } | null;
            if (data && typeof data === 'object' && data.kind === 'occupied' && data.claim === claim) finish(true);
          };
          const aborted = () => finish(false);
          const timer = view.setTimeout(() => finish(false), 100);
          current.addEventListener('message', occupied);
          signal?.addEventListener('abort', aborted, { once: true });
          current.postMessage({ kind: 'probe', tabId, claim });
        });
        if (duplicated) tabId = view.crypto.randomUUID();
      }
    }
  } catch { channel?.close(); channel = undefined; }
  if (signal?.aborted) { channel?.close(); releaseLock(); throw new DOMException('The tab persistence operation was aborted.', 'AbortError'); }
  try { view.sessionStorage.setItem(storageKey, tabId!); } catch { /* Reload recovery is unavailable without session storage. */ }
  const dispose = () => { channel?.close(); releaseLock(); };
  signal?.addEventListener('abort', dispose, { once: true });
  return { key: `review-tab:${hash}:${tabId}`, duplicated, dispose() { signal?.removeEventListener('abort', dispose); dispose(); } };
}
