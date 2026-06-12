import { beforeAll, describe, expect, it } from "vitest";

/**
 * Regression tests for the reactive API-key slice: setStoredKey must write
 * BOTH localStorage and the store's `keys` record so MapCanvas / ExportDialog
 * / ImageryPanel re-render when a key is entered, edited, or cleared.
 *
 * The store hydrates `keys` from localStorage at creation, so a shim is
 * installed before the module is imported (dynamic import below).
 */

class LocalStorageShim {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}

const shim = new LocalStorageShim();
let store: typeof import("../src/store/use-app-store");

beforeAll(async () => {
  shim.setItem("takpack_key_maptiler", "seeded-key");
  shim.setItem("unrelated_entry", "ignore-me");
  (globalThis as Record<string, unknown>).localStorage = shim;
  store = await import("../src/store/use-app-store");
});

describe("API key store slice", () => {
  it("hydrates keys from takpack_key_* localStorage entries at store creation", () => {
    expect(store.useAppStore.getState().keys).toEqual({
      maptiler: "seeded-key",
    });
    expect(store.getStoredKey("maptiler")).toBe("seeded-key");
  });

  it("setStoredKey updates both the store slice and localStorage", () => {
    store.useAppStore.getState().setStoredKey("maptiler", "rotated-key");
    expect(store.useAppStore.getState().keys.maptiler).toBe("rotated-key");
    expect(shim.getItem("takpack_key_maptiler")).toBe("rotated-key");
    expect(store.getStoredKey("maptiler")).toBe("rotated-key");
  });

  it("notifies subscribers when a key changes (reactive preview/dialog reads)", () => {
    let observed: Record<string, string> | null = null;
    const unsub = store.useAppStore.subscribe((s) => {
      observed = s.keys;
    });
    store.useAppStore.getState().setStoredKey("sentinelhub", "sh-key");
    unsub();
    expect(observed).not.toBeNull();
    expect(observed!).toMatchObject({ sentinelhub: "sh-key" });
  });

  it("setStoredKey with an empty value removes the key from both stores", () => {
    store.useAppStore.getState().setStoredKey("maptiler", "");
    expect(store.useAppStore.getState().keys).not.toHaveProperty("maptiler");
    expect(shim.getItem("takpack_key_maptiler")).toBeNull();
    expect(store.getStoredKey("maptiler")).toBe("");
  });
});
