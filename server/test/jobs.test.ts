import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExportQueue } from "../src/jobs/queue.js";
import { JobStore } from "../src/jobs/store.js";
import type { ExportRequest, ImagerySourceDef, Limits } from "../src/types.js";

const LIMITS: Limits = {
  maxTilesPerExport: 1000,
  recommendedMaxPackageBytes: 300 * 1024 * 1024,
  maxGrgPixels: 8192 * 8192,
};

const TINY_CATALOG: ImagerySourceDef[] = [
  {
    id: "test-source",
    name: "Test Source",
    description: "fixture",
    category: "free",
    attribution: "test",
    license: "public domain",
    streamOnly: false,
    strategy: "xyz",
    tileUrlTemplate: "https://example.invalid/{z}/{x}/{y}.png",
    minZoom: 0,
    maxZoom: 19,
    defaultTileFormat: "jpeg",
  },
];

function makeRequest(overrides: Partial<ExportRequest> = {}): ExportRequest {
  return {
    packageName: "Test Package",
    aoi: { north: 1, south: 0, east: 1, west: 0 },
    features: [],
    mapSourceXmlIds: [],
    ...overrides,
  };
}

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 5000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const cleanups: Array<() => void> = [];

function makeStore(): { store: JobStore; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "takpack-jobs-"));
  const store = new JobStore(dir);
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir };
}

afterEach(() => {
  while (cleanups.length > 0) {
    try {
      cleanups.pop()?.();
    } catch {
      // best-effort temp cleanup (Windows can hold WAL handles briefly)
    }
  }
});

describe("JobStore", () => {
  it("creates queued jobs and reads them back", () => {
    const { store } = makeStore();
    const job = store.create();
    expect(job.status).toBe("queued");
    expect(job.progress).toEqual({ phase: "queued", percent: 0 });
    expect(job.warnings).toEqual([]);
    expect(job.createdAt).toBe(job.updatedAt);

    const fetched = store.get(job.id);
    expect(fetched).toEqual(job);
    expect(store.get("missing-id")).toBeUndefined();
  });

  it("merges patches and maintains updatedAt", async () => {
    const { store } = makeStore();
    const job = store.create();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = store.update(job.id, {
      status: "running",
      progress: { phase: "fetching tiles", percent: 40, message: "z12" },
      warnings: ["3 tiles failed"],
    });
    expect(updated).toBeDefined();
    expect(updated?.status).toBe("running");
    expect(updated?.progress.percent).toBe(40);
    expect(updated?.warnings).toEqual(["3 tiles failed"]);
    expect(updated?.createdAt).toBe(job.createdAt);
    expect(updated!.updatedAt > job.updatedAt).toBe(true);

    // Round-trips through SQLite, not just the returned object.
    const fetched = store.get(job.id);
    expect(fetched).toEqual(updated);

    // Unrelated fields survive subsequent patches.
    const completed = store.update(job.id, {
      status: "completed",
      artifactPath: "C:/tmp/out.zip",
      artifactName: "out.zip",
      sizeBytes: 1234,
    });
    expect(completed?.warnings).toEqual(["3 tiles failed"]);
    expect(completed?.artifactName).toBe("out.zip");
    expect(completed?.sizeBytes).toBe(1234);

    expect(store.update("missing-id", { status: "failed" })).toBeUndefined();
  });

  it("lists all jobs", () => {
    const { store } = makeStore();
    const a = store.create();
    const b = store.create();
    const ids = store.list().map((j) => j.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it("reconcileOrphans fails queued/running jobs and leaves the rest", () => {
    const { store } = makeStore();
    const queued = store.create();
    const running = store.create();
    store.update(running.id, { status: "running" });
    const completed = store.create();
    store.update(completed.id, { status: "completed" });
    const failed = store.create();
    store.update(failed.id, { status: "failed", error: "boom" });

    expect(store.reconcileOrphans()).toBe(2);

    expect(store.get(queued.id)?.status).toBe("failed");
    expect(store.get(queued.id)?.error).toBe("server restarted");
    expect(store.get(running.id)?.status).toBe("failed");
    expect(store.get(running.id)?.error).toBe("server restarted");
    expect(store.get(completed.id)?.status).toBe("completed");
    expect(store.get(failed.id)?.error).toBe("boom");

    // Idempotent once everything is settled.
    expect(store.reconcileOrphans()).toBe(0);
  });
});

describe("ExportQueue", () => {
  it("fails a job whose imagery source is not in the catalog, redacting the api key", async () => {
    const { store, dir } = makeStore();
    const queue = new ExportQueue(store, {
      catalog: TINY_CATALOG,
      adapters: {},
      limits: LIMITS,
      outDir: path.join(dir, "artifacts"),
    });

    // sourceId doubles as the secret so the failure message would contain it
    // verbatim if redaction were broken.
    const secret = "SECRET-KEY-12345";
    const job = queue.enqueue(
      makeRequest({
        imagery: {
          sourceId: secret,
          mode: "gpkg",
          minZoom: 1,
          maxZoom: 2,
          tileFormat: "jpeg",
          apiKey: secret,
        },
      }),
    );
    // enqueue returns the freshly created record; the runner may have already
    // started by the time we poll the store, so only the snapshot is asserted.
    expect(job.status).toBe("queued");

    const failed = await waitFor(() => {
      const j = store.get(job.id);
      return j?.status === "failed" ? j : undefined;
    });
    expect(failed.error).toBeDefined();
    expect(failed.error).toContain("unknown imagery source");
    expect(failed.error).toContain("[redacted]");
    expect(failed.error).not.toContain(secret);
    // >= not >: on Windows the create + fail can land in the same millisecond,
    // so equal timestamps are valid (updatedAt is never earlier than createdAt).
    expect(failed.updatedAt >= failed.createdAt).toBe(true);
  });
});
