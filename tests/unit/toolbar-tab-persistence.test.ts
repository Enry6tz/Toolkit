import { afterEach, describe, expect, it } from "vitest";
import { createTabPersistence } from "../../src/browser/tab-persistence";

class MemoryStorage implements Storage {
  private readonly values: Map<string, string>;
  constructor(entries?: Iterable<readonly [string, string]>) {
    this.values = new Map(entries);
  }
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  clone() {
    return new MemoryStorage(this.values);
  }
}

/** Models the browser lock service, rather than the SDK's ownership decisions. */
class LockService {
  readonly held = new Set<string>();
  readonly adapter = {
    request: async (
      name: string,
      _options: { ifAvailable: boolean },
      callback: (
        lock: { name: string; mode: "exclusive" } | null,
      ) => void | Promise<void>,
    ) => {
      if (this.held.has(name)) return callback(null);
      this.held.add(name);
      try {
        return await callback({ name, mode: "exclusive" });
      } finally {
        this.held.delete(name);
      }
    },
  };
}

function testWindow(
  storage: Storage,
  locks?: LockService,
  channel: typeof BroadcastChannel | null = globalThis.BroadcastChannel,
): Window {
  // Window is the external boundary; this double provides only APIs used by
  // the helper, without adding a DOM emulator or touching a real browser.
  return {
    crypto: globalThis.crypto,
    sessionStorage: storage,
    navigator: locks ? { locks: locks.adapter } : {},
    BroadcastChannel: channel ?? undefined,
    setTimeout: (callback: () => void, delay: number) =>
      Number(setTimeout(callback, delay)),
    clearTimeout: (timer: number) => clearTimeout(timer),
  } as unknown as Window;
}

const leases: Awaited<ReturnType<typeof createTabPersistence>>[] = [];
async function claim(view: Window, namespace: string, signal?: AbortSignal) {
  const lease = await createTabPersistence(view, namespace, signal);
  leases.push(lease);
  return lease;
}
afterEach(() => {
  for (const lease of leases.splice(0)) lease.dispose();
});

describe("toolbar tab ownership and reload recovery", () => {
  it("assigns five independent slots to five tabs in one namespace", async () => {
    const locks = new LockService();
    const namespace = `qa-five-${crypto.randomUUID()}`;
    const tabs = await Promise.all(
      Array.from({ length: 5 }, () =>
        claim(testWindow(new MemoryStorage(), locks), namespace),
      ),
    );
    expect(new Set(tabs.map((tab) => tab.key)).size).toBe(5);
    expect(tabs.every((tab) => !tab.duplicated)).toBe(true);
    expect(locks.held.size).toBe(5);
  });

  it("restores the same tab slot after disposal and reload", async () => {
    const storage = new MemoryStorage(),
      locks = new LockService();
    const namespace = `qa-reload-${crypto.randomUUID()}`;
    const original = await claim(testWindow(storage, locks), namespace);
    original.dispose();
    await Promise.resolve();
    const reloaded = await claim(testWindow(storage, locks), namespace);
    expect(reloaded.key).toBe(original.key);
    expect(reloaded.duplicated).toBe(false);
  });

  it("isolates a duplicated tab without changing the original tab's saved identity", async () => {
    const storage = new MemoryStorage(),
      locks = new LockService();
    const namespace = `qa-duplicate-${crypto.randomUUID()}`;
    const original = await claim(testWindow(storage, locks), namespace);
    const copiedStorage = storage.clone();
    const duplicate = await claim(testWindow(copiedStorage, locks), namespace);
    expect(duplicate.duplicated).toBe(true);
    expect(duplicate.key).not.toBe(original.key);
    original.dispose();
    await Promise.resolve();
    const originalReload = await claim(testWindow(storage, locks), namespace);
    expect(originalReload.key).toBe(original.key);
    expect(copiedStorage.getItem(copiedStorage.key(0)!)).not.toBe(
      storage.getItem(storage.key(0)!),
    );
  });

  it("releases a live lock on controller abort so a remount can reuse its slot", async () => {
    const storage = new MemoryStorage(),
      locks = new LockService();
    const namespace = `qa-abort-${crypto.randomUUID()}`,
      abort = new AbortController();
    const original = await claim(
      testWindow(storage, locks),
      namespace,
      abort.signal,
    );
    abort.abort();
    await Promise.resolve();
    const mounted = await claim(testWindow(storage, locks), namespace);
    expect(mounted.key).toBe(original.key);
    expect(mounted.duplicated).toBe(false);
  });

  it("keeps two app namespaces separate in the same session storage", async () => {
    const storage = new MemoryStorage(),
      locks = new LockService();
    const first = await claim(
      testWindow(storage, locks),
      `qa-a-${crypto.randomUUID()}`,
    );
    const second = await claim(
      testWindow(storage, locks),
      `qa-b-${crypto.randomUUID()}`,
    );
    expect(second.key).not.toBe(first.key);
    expect(storage.length).toBe(2);
  });

  it("bounds the stored slot key even with a long configured namespace", async () => {
    const result = await claim(
      testWindow(new MemoryStorage(), new LockService()),
      "long-namespace".repeat(100),
    );
    expect(result.key.length).toBeLessThanOrEqual(200);
  });

  it("replaces malformed stored tab identifiers", async () => {
    const storage = new MemoryStorage(),
      namespace = `qa-malformed-${crypto.randomUUID()}`;
    const first = await claim(
      testWindow(storage, new LockService()),
      namespace,
    );
    first.dispose();
    storage.setItem(storage.key(0)!, "../../not-a-tab");
    const restored = await claim(
      testWindow(storage, new LockService()),
      namespace,
    );
    expect(restored.key).not.toBe(first.key);
    expect(restored.key).not.toContain("../");
  });

  it("continues with distinct in-memory slots when session storage is blocked", async () => {
    const storage = new MemoryStorage();
    storage.getItem = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    storage.setItem = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    const namespace = `qa-blocked-${crypto.randomUUID()}`,
      locks = new LockService();
    const first = await claim(testWindow(storage, locks), namespace);
    const second = await claim(testWindow(storage, locks), namespace);
    expect(first.key).not.toBe(second.key);
  });

  it("does not create a slot or acquire a lock after an already aborted mount", async () => {
    const storage = new MemoryStorage(),
      locks = new LockService(),
      abort = new AbortController();
    abort.abort();
    await expect(
      createTabPersistence(
        testWindow(storage, locks),
        "qa-never-mounted",
        abort.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(storage.length).toBe(0);
    expect(locks.held.size).toBe(0);
  });

  it("aborts a mount while the namespace digest is pending without storing a slot", async () => {
    const storage = new MemoryStorage(),
      locks = new LockService(),
      abort = new AbortController();
    const pending = createTabPersistence(
      testWindow(storage, locks),
      "qa-pending-mount",
      abort.signal,
    );
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(storage.length).toBe(0);
    expect(locks.held.size).toBe(0);
  });

  it("detects a copied live slot through real BroadcastChannel when Web Locks are unavailable", async () => {
    const storage = new MemoryStorage(),
      namespace = `qa-channel-${crypto.randomUUID()}`;
    const original = await claim(testWindow(storage), namespace);
    const duplicate = await claim(testWindow(storage.clone()), namespace);
    expect(duplicate.duplicated).toBe(true);
    expect(duplicate.key).not.toBe(original.key);
  });

  it("retains reload identity when both ownership APIs are unavailable", async () => {
    const storage = new MemoryStorage(),
      namespace = `qa-no-channels-${crypto.randomUUID()}`;
    const original = await claim(
      testWindow(storage, undefined, null),
      namespace,
    );
    original.dispose();
    const reloaded = await claim(
      testWindow(storage, undefined, null),
      namespace,
    );
    expect(reloaded.key).toBe(original.key);
    expect(reloaded.duplicated).toBe(false);
  });
});
