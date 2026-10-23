const toolbarFontFamily = 'AI Context Cascadia Code';
const fontLoads = new WeakMap<Document, Promise<boolean>>();

/** Register the bundled font once for this document, including shadow-root UI. */
export function ensureToolbarFont(document: Document): Promise<boolean> {
  const pending = fontLoads.get(document);
  if (pending) return pending;

  const loading = (async (): Promise<boolean> => {
    const FontFaceConstructor = document.defaultView?.FontFace;
    if (!FontFaceConstructor || !document.fonts) return false;

    try {
      // Keep the literal URL so Next.js and other bundlers emit the local asset.
      const url = new URL('./assets/cascadia-code-latin.woff2', import.meta.url);
      const face = new FontFaceConstructor(toolbarFontFamily, `url("${url.href}") format("woff2")`, {
        style: 'normal',
        weight: '200 700',
        display: 'swap',
      });
      await face.load();
      document.fonts.add(face);
      return true;
    } catch {
      // Restricted font policies and unsupported browsers keep the CSS fallback.
      return false;
    }
  })();

  fontLoads.set(document, loading);
  return loading;
}
