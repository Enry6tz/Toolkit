"use client";
import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { dockMenuHeightLimit, planDockPlacement } from "./dock-geometry.js";
import type {
  DockCorner,
  DockObstacle,
  DockPlacement,
  DockRect,
} from "./dock-geometry.js";

const modalSelector =
  'dialog[open],[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"]';
const controlsSelector =
  'button,[role="button"],a[href],input,textarea,select,[contenteditable="true"]';
const rectOf = (node: Element): DockRect => {
  const rect = node.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
};
function clipped(rect: DockRect, area: DockRect): DockRect | null {
  const x = Math.max(rect.x, area.x),
    y = Math.max(rect.y, area.y);
  const right = Math.min(rect.x + rect.width, area.x + area.width);
  const bottom = Math.min(rect.y + rect.height, area.y + area.height);
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null;
}
function visible(node: Element) {
  const style = getComputedStyle(node);
  return (
    node.isConnected &&
    node.getAttribute("aria-hidden") !== "true" &&
    node.getClientRects().length > 0 &&
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    !node.closest("[inert]")
  );
}
function activeModal(document: Document, host: Element): Element | null {
  const candidates = Array.from(
    document.querySelectorAll(modalSelector),
  ).filter((node) => {
    if (host.contains(node) || !visible(node)) return false;
    if (node.tagName !== "DIALOG") return true;
    try {
      return node.matches(":modal");
    } catch {
      return node.hasAttribute("open");
    }
  });
  const focused = candidates.filter(
    (node) => document.activeElement && node.contains(document.activeElement),
  );
  return focused.at(-1) ?? candidates.at(-1) ?? null;
}

interface Layout extends DockPlacement {
  viewportHeight: number;
  menuMaxHeight: number;
}

/** Event-driven geometry only. It never changes recording, pin or saved preferences. */
export function useDockPlacement({
  root,
  dock,
  preferred,
  expanded,
  menuOpen,
}: {
  root: ShadowRoot | null;
  dock: RefObject<HTMLDivElement | null>;
  preferred: DockCorner;
  expanded: boolean;
  menuOpen: boolean;
}) {
  const [layout, setLayout] = useState<Layout | null>(null);
  useEffect(() => {
    const element = dock.current;
    if (!root || !element) return;
    const shadow: ShadowRoot = root;
    const document = shadow.ownerDocument;
    const ownerWindow = document.defaultView;
    if (!ownerWindow) return;
    const view: Window = ownerWindow;
    const probe = document.createElement("span");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
    shadow.append(probe);
    let frame: number | null = null;
    let observedModal: Element | null = null;
    let disposed = false;
    const schedule = () => {
      if (!disposed && frame === null)
        frame = view.requestAnimationFrame(update);
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    const reveal = element.querySelector<HTMLElement>(".recording-reveal");
    const menu = element.querySelector<HTMLElement>(".recording-position-menu");
    observer?.observe(element);
    if (reveal) observer?.observe(reveal);
    if (menu) observer?.observe(menu);
    function update() {
      frame = null;
      if (disposed || !element?.isConnected) return;
      const viewport = view.visualViewport;
      const area: DockRect = {
        x: viewport?.offsetLeft ?? 0,
        y: viewport?.offsetTop ?? 0,
        width: viewport?.width || view.innerWidth,
        height: viewport?.height || view.innerHeight,
      };
      const safe = view.getComputedStyle(probe);
      const mobile = view.matchMedia("(max-width:600px)").matches;
      const inset = (value: string, minimum: number) =>
        Math.max(minimum, Number.parseFloat(value) || 0);
      const modal = activeModal(document, shadow.host);
      if (modal !== observedModal) {
        if (observedModal) observer?.unobserve(observedModal);
        if (modal) observer?.observe(modal);
        observedModal = modal;
      }
      const modalRect = modal ? rectOf(modal) : null;
      const visibleModal = modalRect ? clipped(modalRect, area) : null;
      const obstacles: DockObstacle[] = [];
      if (modal && visibleModal) {
        for (const control of modal.querySelectorAll(controlsSelector)) {
          if (shadow.host.contains(control) || !visible(control)) continue;
          const rect = clipped(rectOf(control), visibleModal);
          if (!rect) continue;
          const action = control.matches('button,[role="button"],a[href]');
          const focused =
            control === document.activeElement ||
            control.contains(document.activeElement);
          obstacles.push({
            rect,
            kind: action ? "action" : focused ? "focus" : "field",
          });
        }
      }
      const insets = {
        top: inset(safe.paddingTop, mobile ? 12 : 18),
        bottom: inset(safe.paddingBottom, mobile ? 12 : 18),
        left: inset(safe.paddingLeft, mobile ? 12 : 20),
        right: inset(safe.paddingRight, mobile ? 12 : 20),
      };
      const menuMaxHeight = dockMenuHeightLimit(area, insets, obstacles);
      const plan = planDockPlacement({
        viewport: area,
        insets,
        preferred,
        expanded: !!modal || expanded,
        accessoryHeight: reveal
          ? Math.max(reveal.offsetHeight, reveal.scrollHeight)
          : 0,
        menuHeight: menuOpen
          ? Math.min(menu?.offsetHeight ?? 0, menuMaxHeight)
          : 0,
        modal: modalRect,
        obstacles,
      });
      const next = { ...plan, viewportHeight: area.height, menuMaxHeight };
      setLayout((previous) =>
        previous &&
        Object.keys(next).every(
          (key) => Reflect.get(previous, key) === Reflect.get(next, key),
        )
          ? previous
          : next,
      );
    }
    const mutations = new MutationObserver((records) => {
      if (
        records.some((record) => {
          if (
            shadow.host === record.target ||
            shadow.host.contains(record.target)
          )
            return false;
          if (
            record.type === "childList" &&
            [...record.addedNodes, ...record.removedNodes].every(
              (node) => node === shadow.host || shadow.host.contains(node),
            )
          )
            return false;
          return true;
        })
      )
        schedule();
    });
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "open",
        "aria-modal",
        "aria-hidden",
        "role",
        "hidden",
        "inert",
        "class",
        "style",
      ],
    });
    document.addEventListener("focusin", schedule, true);
    document.addEventListener("scroll", schedule, {
      capture: true,
      passive: true,
    });
    view.addEventListener("resize", schedule, { passive: true });
    view.visualViewport?.addEventListener("resize", schedule, {
      passive: true,
    });
    view.visualViewport?.addEventListener("scroll", schedule, {
      passive: true,
    });
    schedule();
    return () => {
      disposed = true;
      if (frame !== null) view.cancelAnimationFrame(frame);
      observer?.disconnect();
      mutations.disconnect();
      document.removeEventListener("focusin", schedule, true);
      document.removeEventListener("scroll", schedule, true);
      view.removeEventListener("resize", schedule);
      view.visualViewport?.removeEventListener("resize", schedule);
      view.visualViewport?.removeEventListener("scroll", schedule);
      probe.remove();
    };
  }, [root, dock, preferred, expanded, menuOpen]);
  return layout;
}
