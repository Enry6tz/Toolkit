export interface ScreenBounds { x: number; y: number; width: number; height: number }

/** Overlay geometry uses the same viewport as pointer events, including nested scrollers. */
export function visibleElementBounds(element: Element): ScreenBounds | null {
  const view = element.ownerDocument.defaultView;
  if (!view || !element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
  let right = Math.min(view.innerWidth, rect.right), bottom = Math.min(view.innerHeight, rect.bottom);
  const parent = (node: Element): Element | null => node.parentElement ?? ((node.getRootNode() as ShadowRoot).host || null);
  for (let node = parent(element); node; node = parent(node)) {
    const style = view.getComputedStyle(node);
    const clipX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
    const clipY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
    if (!clipX && !clipY) continue;
    const box = node.getBoundingClientRect();
    if (clipX) { left = Math.max(left, box.left + node.clientLeft); right = Math.min(right, box.left + node.clientLeft + node.clientWidth); }
    if (clipY) { top = Math.max(top, box.top + node.clientTop); bottom = Math.min(bottom, box.top + node.clientTop + node.clientHeight); }
  }
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

export function enclosingBounds(regions: ScreenBounds[]): ScreenBounds | undefined {
  if (!regions.length) return undefined;
  const x = Math.min(...regions.map(box => box.x)), y = Math.min(...regions.map(box => box.y));
  return { x, y, width: Math.max(...regions.map(box => box.x + box.width)) - x, height: Math.max(...regions.map(box => box.y + box.height)) - y };
}
