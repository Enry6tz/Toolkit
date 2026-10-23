/** Observe committed URLs without changing the application's history methods. */
export function observeLocation(view: Window, onChange: () => void): () => void {
  let active = true;
  let queued = false;
  let href = view.location.href;
  const changed = () => {
    if (!active || queued || view.location.href === href) return;
    queued = true;
    // currententrychange can fire synchronously inside a framework's insertion
    // effect. Subscribers may update React; wait until that commit has finished.
    view.queueMicrotask(() => {
      queued = false;
      if (!active || view.location.href === href) return;
      href = view.location.href;
      onChange();
    });
  };
  const navigation = (view as Window & {
    navigation?: {
      addEventListener(type: string, listener: () => void): void;
      removeEventListener(type: string, listener: () => void): void;
    };
  }).navigation;
  let observer: MutationObserver | undefined;
  view.addEventListener('popstate', changed);
  view.addEventListener('hashchange', changed);
  if (navigation?.addEventListener) {
    navigation.addEventListener('currententrychange', changed);
  } else if (typeof (view as Window & typeof globalThis).MutationObserver === 'function') {
    observer = new (view as Window & typeof globalThis).MutationObserver(changed);
    observer.observe(view.document.documentElement, { childList: true, subtree: true });
  }
  return () => {
    active = false;
    observer?.disconnect();
    navigation?.removeEventListener('currententrychange', changed);
    view.removeEventListener('popstate', changed);
    view.removeEventListener('hashchange', changed);
  };
}
