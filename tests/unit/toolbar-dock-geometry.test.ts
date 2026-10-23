import { describe, expect, it } from "vitest";
import {
  dockMenuHeightLimit,
  planDockPlacement,
} from "../../src/react/dock-geometry";

const base = {
  viewport: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 12, right: 12, bottom: 12, left: 12 },
  preferred: "bottom-right" as const,
  expanded: true,
  accessoryHeight: 160,
  menuHeight: 0,
  modal: null,
  obstacles: [],
};

describe("toolbar dock geometry (synthetic geometry, no browser acceptance)", () => {
  it("limits a position menu to the space between fullscreen header and footer actions", () => {
    const viewport = { x: 0, y: 0, width: 390, height: 400 };
    const limit = dockMenuHeightLimit(viewport, base.insets, [
      { kind: "action", rect: { x: 0, y: 0, width: 390, height: 80 } },
      { kind: "action", rect: { x: 0, y: 300, width: 390, height: 100 } },
    ]);
    expect(limit).toBe(155);
    expect(limit + 57).toBeLessThan(220);
  });
  it("keeps the position menu scrollable when a viewport has no complete menu-sized gap", () => {
    const limit = dockMenuHeightLimit(
      { x: 0, y: 0, width: 390, height: 200 },
      base.insets,
      [{ kind: "action", rect: { x: 0, y: 0, width: 390, height: 200 } }],
    );
    expect(limit).toBe(50);
  });
  it("keeps the preferred position and full controls without a modal", () => {
    expect(planDockPlacement(base)).toEqual({
      corner: "bottom-right",
      x: 174,
      y: 784,
      width: 204,
      compressed: false,
    });
  });
  it("keeps the preferred bottom notch outside the actual mobile section while compressing accessories", () => {
    const plan = planDockPlacement({
      ...base,
      modal: { x: 16, y: 63, width: 358, height: 718 },
    });
    expect(plan).toEqual({
      corner: "bottom-right",
      x: 174,
      y: 784,
      width: 204,
      compressed: true,
    });
    expect(plan.y).toBeGreaterThanOrEqual(781);
  });
  it("uses the top gap when the modal extends through the bottom edge", () => {
    const plan = planDockPlacement({
      ...base,
      modal: { x: 16, y: 63, width: 358, height: 781 },
    });
    expect(plan.corner).toBe("top-right");
    expect(plan.compressed).toBe(true);
    expect(plan.y + 48).toBeLessThanOrEqual(63);
  });
  it("can move full accessories sideways on desktop instead of compressing them", () => {
    const plan = planDockPlacement({
      ...base,
      viewport: { x: 0, y: 0, width: 1280, height: 900 },
      modal: { x: 900, y: 100, width: 380, height: 800 },
    });
    expect(plan.corner).toBe("bottom-left");
    expect(plan.compressed).toBe(false);
  });
  it("does not rewrite the preferred corner when a modal closes", () => {
    const input = { ...base, modal: { x: 16, y: 63, width: 358, height: 718 } };
    planDockPlacement(input);
    expect(input.preferred).toBe("bottom-right");
    expect(planDockPlacement({ ...input, modal: null }).corner).toBe(
      "bottom-right",
    );
  });
  it("accounts for visual viewport offsets and asymmetric safe area insets", () => {
    const plan = planDockPlacement({
      ...base,
      expanded: false,
      viewport: { x: 20, y: 150, width: 390, height: 360 },
      insets: { top: 30, right: 24, bottom: 34, left: 18 },
    });
    expect(plan.x).toBe(182);
    expect(plan.y).toBe(428);
  });
  it("avoids fullscreen close/footer actions even when no exterior gap exists", () => {
    const plan = planDockPlacement({
      ...base,
      modal: base.viewport,
      obstacles: [
        { kind: "action", rect: { x: 0, y: 0, width: 390, height: 80 } },
        { kind: "action", rect: { x: 0, y: 720, width: 390, height: 124 } },
        { kind: "field", rect: { x: 20, y: 110, width: 350, height: 100 } },
      ],
    });
    expect(plan.compressed).toBe(true);
    expect(plan.y).toBeGreaterThanOrEqual(210);
    expect(plan.y + 48).toBeLessThanOrEqual(720);
  });
  it("includes the explicitly opened position menu in collision geometry", () => {
    const plan = planDockPlacement({
      ...base,
      menuHeight: 200,
      modal: { x: 16, y: 63, width: 358, height: 718 },
      obstacles: [
        { kind: "action", rect: { x: 300, y: 70, width: 50, height: 36 } },
        { kind: "action", rect: { x: 170, y: 725, width: 190, height: 40 } },
      ],
    });
    const top = plan.corner.startsWith("top") ? plan.y : plan.y - 209;
    expect(top).toBeGreaterThanOrEqual(12);
    expect(top + 257).toBeLessThanOrEqual(832);
    for (const action of [
      { x: 300, y: 70, width: 50, height: 36 },
      { x: 170, y: 725, width: 190, height: 40 },
    ]) {
      expect(
        top + 257 <= action.y ||
          top >= action.y + action.height ||
          plan.x + plan.width <= action.x ||
          plan.x >= action.x + action.width,
      ).toBe(true);
    }
  });
  it("prioritizes close/footer actions when a focused editor fills all remaining space", () => {
    const plan = planDockPlacement({
      ...base,
      modal: base.viewport,
      obstacles: [
        { kind: "action", rect: { x: 0, y: 0, width: 390, height: 80 } },
        { kind: "action", rect: { x: 0, y: 720, width: 390, height: 124 } },
        { kind: "focus", rect: { x: 0, y: 80, width: 390, height: 640 } },
      ],
    });
    expect(plan.y).toBeGreaterThanOrEqual(80);
    expect(plan.y + 48).toBeLessThanOrEqual(720);
  });
  it("produces a stable plan for unchanged input without layout feedback", () => {
    const input = {
      ...base,
      modal: base.viewport,
      obstacles: [
        {
          kind: "action" as const,
          rect: { x: 100, y: 700, width: 260, height: 60 },
        },
      ],
    };
    expect(planDockPlacement(input)).toEqual(planDockPlacement(input));
  });
});
