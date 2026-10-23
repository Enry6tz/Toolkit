/** Coordinates use the layout viewport, including visualViewport offsets. */
export interface DockRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type DockCorner =
  | "bottom-right"
  | "bottom-left"
  | "top-right"
  | "top-left";
export interface DockInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
export interface DockObstacle {
  rect: DockRect;
  kind: "action" | "focus" | "field";
}
export interface DockPlacement {
  corner: DockCorner;
  x: number;
  /** Top of the notch, independent of accessories extending above/below it. */
  y: number;
  width: number;
  compressed: boolean;
}
interface Input {
  viewport: DockRect;
  insets: DockInsets;
  preferred: DockCorner;
  expanded: boolean;
  accessoryHeight: number;
  menuHeight: number;
  modal: DockRect | null;
  obstacles: readonly DockObstacle[];
}
const notchHeight = 48;
const regularWidth = 204;
const gap = 6;
const right = (r: DockRect) => r.x + r.width;
const bottom = (r: DockRect) => r.y + r.height;
function overlap(a: DockRect, b: DockRect) {
  return (
    Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y))
  );
}
function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(value, Math.max(low, high)));
}
function corners(preferred: DockCorner): DockCorner[] {
  const top = preferred.startsWith("top"),
    left = preferred.endsWith("left");
  return [
    preferred,
    `${top ? "top" : "bottom"}-${left ? "right" : "left"}`,
    `${top ? "bottom" : "top"}-${left ? "left" : "right"}`,
    `${top ? "bottom" : "top"}-${left ? "right" : "left"}`,
  ];
}

/** Limit a scrollable position menu to an actual gap between host actions. */
export function dockMenuHeightLimit(
  viewport: DockRect,
  insets: DockInsets,
  obstacles: readonly DockObstacle[],
): number {
  const top = viewport.y + insets.top,
    end = bottom(viewport) - insets.bottom;
  let longest = 0;
  for (const x of [
    viewport.x + insets.left,
    right(viewport) - insets.right - regularWidth,
  ]) {
    const intervals = obstacles
      .filter(
        (item) =>
          item.kind === "action" &&
          item.rect.x < x + regularWidth &&
          right(item.rect) > x,
      )
      .map(({ rect }) => ({
        start: Math.max(top, rect.y - 4),
        end: Math.min(end, bottom(rect) + 4),
      }))
      .filter((interval) => interval.end > interval.start)
      .sort((a, b) => a.start - b.start);
    let cursor = top;
    for (const interval of intervals) {
      longest = Math.max(longest, interval.start - cursor);
      cursor = Math.max(cursor, interval.end);
    }
    longest = Math.max(longest, end - cursor);
  }
  return Math.max(50, longest - notchHeight - 9);
}

/** A finite, deterministic plan. It never reads/writes persisted user preferences. */
export function planDockPlacement(input: Input): DockPlacement {
  const { viewport, insets, preferred, modal } = input;
  const area = {
    x: viewport.x + insets.left,
    y: viewport.y + insets.top,
    width: Math.max(0, viewport.width - insets.left - insets.right),
    height: Math.max(0, viewport.height - insets.top - insets.bottom),
  };
  const ordered = corners(preferred);
  function candidate(corner: DockCorner, compressed: boolean, atY?: number) {
    const width = regularWidth;
    const extra = Math.max(
      input.menuHeight ? input.menuHeight + 9 : 0,
      !compressed && input.expanded ? input.accessoryHeight + gap : 0,
    );
    const height = notchHeight + extra;
    const rect = {
      x: corner.endsWith("left")
        ? area.x
        : Math.max(area.x, right(area) - width),
      y:
        atY === undefined
          ? corner.startsWith("top")
            ? area.y
            : Math.max(area.y, bottom(area) - height)
          : clamp(atY, area.y, bottom(area) - height),
      width,
      height,
    };
    return {
      rect,
      placement: {
        corner,
        x: rect.x,
        y: rect.y + (corner.startsWith("top") ? 0 : extra),
        width,
        compressed,
      },
    };
  }
  function fits(rect: DockRect) {
    return (
      rect.width <= area.width &&
      rect.height <= area.height &&
      (!modal || overlap(rect, modal) === 0)
    );
  }
  for (const compressed of [false, true]) {
    for (const corner of ordered) {
      const option = candidate(corner, compressed);
      if (fits(option.rect)) return option.placement;
    }
  }
  // A fullscreen modal has no exterior gap. Keep its close/footer actions and
  // focused field usable, then minimize overlap with the remaining form fields.
  const options = ordered.flatMap((corner) => [
    candidate(corner, true),
    ...input.obstacles.flatMap(({ rect }) => [
      candidate(
        corner,
        true,
        rect.y -
          notchHeight -
          (input.menuHeight ? input.menuHeight + 9 : 0) -
          4,
      ),
      candidate(corner, true, bottom(rect) + 4),
    ]),
  ]);
  const score = (option: (typeof options)[number]) => {
    let actions = 0,
      focus = 0,
      fields = 0;
    for (const obstacle of input.obstacles) {
      const amount = overlap(option.rect, obstacle.rect);
      if (obstacle.kind === "action") actions += amount;
      else if (obstacle.kind === "focus") focus += amount;
      else fields += amount;
    }
    const preferredOption = candidate(preferred, true).rect;
    return [
      actions,
      focus,
      fields,
      modal ? overlap(option.rect, modal) : 0,
      Math.abs(option.rect.x - preferredOption.x) +
        Math.abs(option.rect.y - preferredOption.y),
      ordered.indexOf(option.placement.corner),
    ];
  };
  const ranked = options.map((option) => ({ option, score: score(option) }));
  ranked.sort((a, b) => {
    const first = a.score,
      second = b.score;
    for (let i = 0; i < first.length; i++) {
      const difference = (first[i] ?? 0) - (second[i] ?? 0);
      if (difference) return difference;
    }
    return 0;
  });
  return ranked[0]?.option.placement ?? candidate(preferred, true).placement;
}
