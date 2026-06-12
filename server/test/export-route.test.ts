import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportRouter } from "../src/routes/export.js";
import type { ExportQueue } from "../src/jobs/queue.js";
import type {
  ExportRequest,
  ImagerySourceDef,
  JobRecord,
  Limits,
} from "../src/types.js";

/**
 * POST /api/export zod validation — cross-field feature invariants must be
 * rejected with a 400 BEFORE a job is enqueued (not as a late job failure
 * after the imagery fetch).
 */

const LIMITS: Limits = {
  maxTilesPerExport: 1000,
  recommendedMaxPackageBytes: 300 * 1024 * 1024,
  maxGrgPixels: 8192,
};

const CATALOG: ImagerySourceDef[] = [
  {
    id: "test-imagery",
    name: "Test Imagery",
    description: "fixture",
    category: "free",
    attribution: "Test Imagery Provider",
    license: "Public domain",
    streamOnly: false,
    strategy: "xyz",
    tileUrlTemplate: "https://imagery.example.com/{z}/{x}/{y}.jpg",
    minZoom: 0,
    maxZoom: 16,
    defaultTileFormat: "jpeg",
  },
];

const style = { stroke: "#ff0000", strokeOpacity: 1, strokeWidth: 2 };

function marker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    kind: "marker",
    name: "M",
    geometry: { type: "Point", coordinates: [10, 10] },
    style,
    ...overrides,
  };
}

function baseRequest(features: unknown[]): Record<string, unknown> {
  return {
    packageName: "Test",
    aoi: { north: 1, south: 0, east: 1, west: 0 },
    features,
    mapSourceXmlIds: [],
  };
}

interface ExportResponse {
  error?: string;
  jobId?: string;
}

describe("POST /api/export validation", () => {
  let server: Server;
  let baseUrl: string;
  const enqueued: ExportRequest[] = [];

  beforeAll(async () => {
    const stubQueue = {
      enqueue(request: ExportRequest): JobRecord {
        enqueued.push(request);
        const now = new Date().toISOString();
        return {
          id: "job-1",
          status: "queued",
          progress: { phase: "queued", percent: 0 },
          warnings: [],
          createdAt: now,
          updatedAt: now,
        };
      },
    } as unknown as ExportQueue;

    const app = express();
    app.use(express.json());
    app.use("/api", exportRouter({ catalog: CATALOG, limits: LIMITS, queue: stubQueue }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  async function postExport(
    body: unknown,
  ): Promise<{ status: number; json: ExportResponse }> {
    const res = await fetch(`${baseUrl}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as ExportResponse };
  }

  it("accepts a consistent request with 202 and enqueues it", async () => {
    const before = enqueued.length;
    const circle = marker({
      kind: "circle",
      name: "C",
      radiusM: 250,
    });
    const { status, json } = await postExport(baseRequest([marker(), circle]));
    expect(status).toBe(202);
    expect(json.jobId).toBe("job-1");
    expect(enqueued.length).toBe(before + 1);
  });

  it("rejects a circle without radiusM with a field-pathed 400", async () => {
    const before = enqueued.length;
    const { status, json } = await postExport(
      baseRequest([marker({ kind: "circle" })]),
    );
    expect(status).toBe(400);
    expect(json.error).toContain("radiusM is required");
    expect(json.error).toContain("features.0.radiusM");
    expect(enqueued.length).toBe(before);
  });

  it("rejects kind/geometry mismatches for every kind family", async () => {
    const cases: Array<{ feature: Record<string, unknown>; expected: string }> = [
      {
        feature: marker({
          kind: "route",
          geometry: { type: "Point", coordinates: [10, 10] },
        }),
        expected: "kind 'route' requires LineString geometry",
      },
      {
        feature: marker({
          geometry: {
            type: "LineString",
            coordinates: [
              [10, 10],
              [11, 11],
            ],
          },
        }),
        expected: "kind 'marker' requires Point geometry",
      },
      {
        feature: marker({
          kind: "polygon",
          geometry: { type: "Point", coordinates: [10, 10] },
        }),
        expected: "kind 'polygon' requires Polygon geometry",
      },
      {
        feature: marker({
          kind: "line",
          geometry: { type: "Point", coordinates: [10, 10] },
        }),
        expected: "kind 'line' requires LineString geometry",
      },
    ];
    for (const { feature, expected } of cases) {
      const before = enqueued.length;
      const { status, json } = await postExport(baseRequest([feature]));
      expect(status).toBe(400);
      expect(json.error).toContain(expected);
      expect(enqueued.length).toBe(before);
    }
  });

  it("rejects duplicate feature ids", async () => {
    const before = enqueued.length;
    const id = randomUUID();
    const { status, json } = await postExport(
      baseRequest([marker({ id }), marker({ id })]),
    );
    expect(status).toBe(400);
    expect(json.error).toContain(`duplicate feature id: ${id}`);
    expect(enqueued.length).toBe(before);
  });

  it("rejects out-of-range coordinates (lon ±180, lat ±90)", async () => {
    for (const coordinates of [
      [200, 10],
      [-181, 10],
      [10, 95],
      [10, -90.5],
    ]) {
      const before = enqueued.length;
      const { status } = await postExport(
        baseRequest([marker({ geometry: { type: "Point", coordinates } })]),
      );
      expect(status).toBe(400);
      expect(enqueued.length).toBe(before);
    }
  });
});
