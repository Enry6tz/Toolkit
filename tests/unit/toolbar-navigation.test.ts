import { describe, expect, it, vi } from "vitest";
import { observeLocation } from "../../src/browser/navigation";

function browser() {
  const navigation = new EventTarget();
  const events = new EventTarget();
  const tasks: VoidFunction[] = [];
  const location = { href: "http://localhost:4000/personal" };
  const view = {
    location, navigation,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    queueMicrotask: (task: VoidFunction) => tasks.push(task),
  } as unknown as Window;
  return { view, location, navigation, events, flush: () => { while (tasks.length) tasks.shift()?.(); } };
}

describe("toolbar navigation during framework commits", () => {
  it("defers synchronous HistoryUpdater events until after the React commit", () => {
    const b = browser();
    const update = vi.fn();
    const dispose = observeLocation(b.view, update);
    b.location.href = "http://localhost:4000/account";
    b.navigation.dispatchEvent(new Event("currententrychange"));
    expect(update).not.toHaveBeenCalled();
    b.flush();
    expect(update).toHaveBeenCalledOnce();
    dispose();
  });

  it("coalesces duplicate signals and detects query, fragment and back/forward changes", () => {
    const b = browser();
    const visited: string[] = [];
    const dispose = observeLocation(b.view, () => visited.push(b.location.href));
    const urls = ["/account?tab=security", "/account?tab=interface", "/account?tab=interface#theme", "/account?tab=security", "/personal"];
    for (const url of urls) {
      b.location.href = `http://localhost:4000${url}`;
      b.navigation.dispatchEvent(new Event("currententrychange"));
      b.events.dispatchEvent(new Event("popstate"));
      b.events.dispatchEvent(new Event("hashchange"));
      b.flush();
    }
    expect(visited).toEqual(urls.map(url => `http://localhost:4000${url}`));
    b.navigation.dispatchEvent(new Event("currententrychange"));
    b.flush();
    expect(visited).toHaveLength(5);
    dispose();
  });

  it("drops queued notifications and listeners after disposal", () => {
    const b = browser();
    const update = vi.fn();
    const dispose = observeLocation(b.view, update);
    b.location.href = "http://localhost:4000/tools";
    b.navigation.dispatchEvent(new Event("currententrychange"));
    dispose();
    b.flush();
    b.location.href = "http://localhost:4000/account";
    b.events.dispatchEvent(new Event("popstate"));
    b.navigation.dispatchEvent(new Event("currententrychange"));
    b.flush();
    expect(update).not.toHaveBeenCalled();
  });

  it("uses DOM mutations only as a route signal when Navigation API is unavailable", () => {
    const b = browser();
    let notify = () => {};
    const disconnect = vi.fn();
    const view = {
      ...b.view, navigation: undefined, document: { documentElement: {} },
      MutationObserver: class {
        constructor(callback: MutationCallback) { notify = () => callback([], this as unknown as MutationObserver); }
        observe() {}
        disconnect = disconnect;
      },
    } as unknown as Window;
    const update = vi.fn();
    const dispose = observeLocation(view, update);
    notify(); b.flush();
    expect(update).not.toHaveBeenCalled();
    b.location.href = "http://localhost:4000/tools";
    notify(); notify();
    expect(update).not.toHaveBeenCalled();
    b.flush();
    expect(update).toHaveBeenCalledOnce();
    dispose();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
