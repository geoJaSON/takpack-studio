import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import Database from "better-sqlite3";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPackage } from "../src/export/package-builder.js";
import {
  countTiles,
  tileBoundsLonLat,
  tileRangeForAoi,
} from "../src/export/tile-math.js";
import type {
  Aoi,
  BuildPackageOutput,
  ExportRequest,
  ImageryAdapter,
  ImagerySourceDef,
  Limits,
  MapFeature,
  PyramidTile,
} from "../src/types.js";

/**
 * Full integration: ExportRequest with all feature kinds + gpkg imagery via a
 * mock adapter + one streaming map-source XML → buildPackage → unzip + assert.
 */

const AOI: Aoi = (() => {
  const nw = tileBoundsLonLat(14, 3138, 6190);
  const se = tileBoundsLonLat(14, 3139, 6191);
  return { north: nw.north, west: nw.west, south: se.south, east: se.east };
})();

const CATALOG: ImagerySourceDef[] = [
  {
    id: "test-imagery",
    name: "Test Imagery",
    description: "Mock offline-capable source",
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
  {
    id: "free-stream",
    name: "Free Streaming Tiles",
    description: "Mock stream-only source",
    category: "free",
    attribution: "Free Stream Provider",
    license: "Streaming only (ToS)",
    streamOnly: true,
    strategy: "xyz",
    tileUrlTemplate: "https://tiles.example.com/{z}/{x}/{y}.png",
    minZoom: 0,
    maxZoom: 18,
    defaultTileFormat: "png",
  },
];

const LIMITS: Limits = {
  maxTilesPerExport: 10_000,
  recommendedMaxPackageBytes: 300 * 1024 * 1024,
  maxGrgPixels: 8192,
};

const style = {
  stroke: "#ff0000",
  strokeOpacity: 1,
  strokeWidth: 3,
  fill: "#00ff00",
  fillOpacity: 0.4,
};

function makeFeatures(): { features: MapFeature[]; lineId: string } {
  const lineId = randomUUID();
  const features: MapFeature[] = [
    {
      id: randomUUID(),
      kind: "marker",
      name: "Alpha",
      sidc: "SFGPUCI----K---",
      affiliation: "friendly",
      geometry: { type: "Point", coordinates: [-111.04, 40.22] },
      style,
    },
    {
      id: randomUUID(),
      kind: "marker",
      name: "Bravo",
      sidc: "SHGPUCI----K---",
      affiliation: "hostile",
      geometry: { type: "Point", coordinates: [-111.03, 40.21] },
      style,
    },
    {
      id: randomUUID(),
      kind: "polygon",
      name: "Objective Area",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-111.05, 40.2],
            [-111.02, 40.2],
            [-111.02, 40.23],
            [-111.05, 40.23],
            [-111.05, 40.2],
          ],
        ],
      },
      style,
    },
    {
      id: randomUUID(),
      kind: "route",
      name: "Infil Route",
      geometry: {
        type: "LineString",
        coordinates: [
          [-111.05, 40.2],
          [-111.04, 40.21],
          [-111.03, 40.22],
        ],
      },
      style,
    },
    {
      id: randomUUID(),
      kind: "circle",
      name: "Danger Close",
      geometry: { type: "Point", coordinates: [-111.035, 40.215] },
      radiusM: 500,
      style,
    },
    {
      id: lineId,
      kind: "line",
      name: "Phase Line Gold",
      geometry: {
        type: "LineString",
        coordinates: [
          [-111.06, 40.2],
          [-111.01, 40.2],
        ],
      },
      style,
    },
  ];
  return { features, lineId };
}

describe("buildPackage integration", () => {
  let outDir: string;
  let output: BuildPackageOutput;
  let zip: AdmZip;
  let zipNames: string[];
  let lineId: string;

  beforeAll(async () => {
    outDir = mkdtempSync(path.join(os.tmpdir(), "pkg-test-"));

    const tileData = await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 3,
        background: { r: 30, g: 60, b: 90 },
      },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    const mockAdapter: ImageryAdapter = {
      async fetchPyramid(_source, aoi, minZoom, maxZoom, _format, opts) {
        const tiles: PyramidTile[] = [];
        for (let z = minZoom; z <= maxZoom; z++) {
          const r = tileRangeForAoi(aoi, z);
          for (let x = r.minX; x <= r.maxX; x++) {
            for (let y = r.minY; y <= r.maxY; y++) {
              tiles.push({ z, x, y, data: tileData });
            }
          }
        }
        opts.onProgress?.(tiles.length, tiles.length);
        return {
          tiles,
          fetched: tiles.length,
          failed: 0,
          total: tiles.length,
          warnings: [],
        };
      },
    };

    const made = makeFeatures();
    lineId = made.lineId;
    const request: ExportRequest = {
      packageName: "Op Anvil",
      aoi: AOI,
      features: made.features,
      imagery: {
        sourceId: "test-imagery",
        mode: "gpkg",
        minZoom: 13,
        maxZoom: 14,
        tileFormat: "jpeg",
      },
      mapSourceXmlIds: ["free-stream"],
      includeKmlOverlay: true,
    };

    output = await buildPackage({
      request,
      jobId: "job-test-1",
      outDir,
      catalog: CATALOG,
      adapters: { xyz: mockAdapter },
      limits: LIMITS,
      onProgress: () => {},
    });

    zip = new AdmZip(output.zipPath);
    zipNames = zip.getEntries().map((e) => e.entryName);
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("writes the zip to outDir/<jobId>.zip with forward-slash entries", () => {
    expect(output.zipPath).toBe(path.join(outDir, "job-test-1.zip"));
    expect(existsSync(output.zipPath)).toBe(true);
    expect(output.sizeBytes).toBeGreaterThan(0);
    for (const name of zipNames) expect(name).not.toContain("\\");
  });

  it("contains MANIFEST/manifest.xml that parses at the regex level", () => {
    expect(zipNames).toContain("MANIFEST/manifest.xml");
    const xml = zip.readAsText("MANIFEST/manifest.xml");
    expect(xml).toMatch(/<MissionPackageManifest version="2">/);
    expect(xml).toMatch(/<Parameter name="uid" value="[^"]+"\s*\/>/);
    expect(xml).toMatch(/<Parameter name="name" value="[^"]+"\s*\/>/);
    expect(xml).toMatch(/<Content ignore="false" zipEntry="[^"]+"/);
  });

  it("every manifest zipEntry and every returned entry exists in the zip", () => {
    const xml = zip.readAsText("MANIFEST/manifest.xml");
    const refs = [...xml.matchAll(/zipEntry="([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(zipNames).toContain(ref);
    for (const entry of output.entries) expect(zipNames).toContain(entry);
  });

  it("emits exactly 5 .cot events (line excluded) at <uid>/<uid>.cot", () => {
    const cots = zipNames.filter((n) => n.endsWith(".cot"));
    expect(cots.length).toBe(5);
    for (const c of cots) {
      const m = /^([^/]+)\/([^/]+)\.cot$/.exec(c);
      expect(m).not.toBeNull();
      expect(m![1]).toBe(m![2]);
      expect(m![1]).not.toBe(lineId);
    }
  });

  it("includes the styled KML overlay", () => {
    expect(zipNames.some((n) => n.endsWith("/overlays.kml"))).toBe(true);
  });

  it("includes a .gpkg that opens as a valid GeoPackage", () => {
    const gpkgEntry = zipNames.find((n) => n.endsWith(".gpkg"));
    expect(gpkgEntry).toBeDefined();
    const extracted = path.join(outDir, "extracted.gpkg");
    writeFileSync(extracted, zip.readFile(gpkgEntry!)!);
    const db = new Database(extracted, { readonly: true });
    try {
      expect(db.pragma("application_id", { simple: true })).toBe(0x47504b47);
      const contents = db
        .prepare("SELECT table_name, data_type FROM gpkg_contents")
        .get() as { table_name: string; data_type: string };
      expect(contents.data_type).toBe("tiles");
      const tileCount = db
        .prepare(`SELECT COUNT(*) AS n FROM "${contents.table_name}"`)
        .get() as { n: number };
      // AOI edges sit exactly on tile boundaries, so the range includes the
      // adjacent row/column — assert against the shared tile math.
      expect(tileCount.n).toBe(countTiles(AOI, 13, 14));
      expect(tileCount.n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("includes the map-source XML for the streaming source", () => {
    const entry = zipNames.find((n) => n.endsWith("mapsource-free-stream.xml"));
    expect(entry).toBeDefined();
    const xml = zip.readAsText(entry!);
    expect(xml).toMatch(/<customMapSource>/);
  });

  it("includes attribution.txt with attribution and license lines", () => {
    const entry = zipNames.find((n) => n.endsWith("/attribution.txt"));
    expect(entry).toBeDefined();
    const text = zip.readAsText(entry!);
    expect(text).toContain("Test Imagery Provider");
    expect(text).toContain("Public domain");
  });
});
