import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

async function makeTileData(): Promise<Buffer> {
  return sharp({
    create: {
      width: 256,
      height: 256,
      channels: 3,
      background: { r: 30, g: 60, b: 90 },
    },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

function makeMockAdapter(tileData: Buffer): ImageryAdapter {
  return {
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
    async fetchSingleImage(_source, aoi) {
      return { data: tileData, width: 256, height: 256, bounds: aoi };
    },
  };
}

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

    const mockAdapter = makeMockAdapter(await makeTileData());

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
      includeMissionBrief: true,
      attachments: [
        {
          name: "brief.txt",
          contentType: "text/plain",
          base64: Buffer.from("mission brief").toString("base64"),
        },
      ],
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

  it("emits one .cot per feature (incl. the open line) at <uid>/<uid>.cot", () => {
    const cots = zipNames.filter((n) => n.endsWith(".cot"));
    // 2 markers + polygon + route + circle + line = 6 editable CoT objects.
    expect(cots.length).toBe(6);
    for (const c of cots) {
      const m = /^([^/]+)\/([^/]+)\.cot$/.exec(c);
      expect(m).not.toBeNull();
      expect(m![1]).toBe(m![2]);
    }
    // the line now exports as a CoT object too (open u-d-f)
    expect(cots).toContain(`${lineId}/${lineId}.cot`);
  });

  it("includes the styled KML overlay", () => {
    expect(zipNames.some((n) => n.endsWith("/overlays.kml"))).toBe(true);
  });

  it("bakes source attribution into the overlays.kml description", () => {
    const entry = zipNames.find((n) => n.endsWith("/overlays.kml"));
    expect(entry).toBeDefined();
    const xml = zip.readAsText(entry!);
    expect(xml).toMatch(
      /<description>[^<]*Test Imagery Provider[^<]*<\/description>/,
    );
    expect(xml).toContain("License: Public domain");
  });

  it("keeps standard SIDC markers out of the KML overlay", () => {
    const entry = zipNames.find((n) => n.endsWith("/overlays.kml"));
    expect(entry).toBeDefined();
    const xml = zip.readAsText(entry!);
    expect(xml).not.toContain("<name>Alpha</name>");
    expect(xml).not.toContain("<name>Bravo</name>");
    expect(xml).toContain("<name>Objective Area</name>");
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

  it("includes user attachments in the zip and manifest", () => {
    const entry = zipNames.find((n) => n.endsWith("/attachments/brief.txt"));
    expect(entry).toBeDefined();
    expect(zip.readAsText(entry!)).toBe("mission brief");
    const manifest = zip.readAsText("MANIFEST/manifest.xml");
    expect(manifest).toContain("attachments/brief.txt");
    expect(manifest).toContain('contentType" value="text/plain"');
  });

  it("includes the generated mission brief", () => {
    const entry = zipNames.find((n) => n.endsWith("/mission-brief.html"));
    expect(entry).toBeDefined();
    const html = zip.readAsText(entry!);
    expect(html).toContain("Op Anvil Mission Brief");
    expect(html).toContain("Feature List");
    const manifest = zip.readAsText("MANIFEST/manifest.xml");
    expect(manifest).toContain("mission-brief.html");
    expect(manifest).toContain('contentType" value="text/html"');
  });
});

describe("buildPackage failure cleanup", () => {
  it("removes the temp gpkg and partial zip when a writer throws after imagery", async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), "pkg-fail-"));
    try {
      const mockAdapter = makeMockAdapter(await makeTileData());
      // Passes type-checking but throws inside buildCotEvents — AFTER the
      // temp GeoPackage has been written.
      const badCircle: MapFeature = {
        id: randomUUID(),
        kind: "circle",
        name: "No Radius",
        geometry: { type: "Point", coordinates: [-111.03, 40.21] },
        style,
      };
      await expect(
        buildPackage({
          request: {
            packageName: "Fail Pack",
            aoi: AOI,
            features: [badCircle],
            imagery: {
              sourceId: "test-imagery",
              mode: "gpkg",
              minZoom: 14,
              maxZoom: 14,
              tileFormat: "jpeg",
            },
            mapSourceXmlIds: [],
          },
          jobId: "job-fail-1",
          outDir,
          catalog: CATALOG,
          adapters: { xyz: mockAdapter },
          limits: LIMITS,
          onProgress: () => {},
        }),
      ).rejects.toThrow(/radiusM is required/);
      // No <jobId>-imagery.gpkg temp and no partial <jobId>.zip may remain.
      expect(
        readdirSync(outDir).filter((n) => n.startsWith("job-fail-1")),
      ).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("buildPackage keyed map-source XML credential guard", () => {
  const KEYED_CATALOG: ImagerySourceDef[] = [
    {
      id: "hub-imagery",
      name: "Hub Imagery",
      description: "Mock keyed imagery source",
      category: "api",
      keyId: "sentinelhub",
      attribution: "Hub Provider",
      license: "Plan terms",
      streamOnly: false,
      strategy: "xyz",
      tileUrlTemplate: "https://hub.example.com/{z}/{x}/{y}.jpg",
      minZoom: 0,
      maxZoom: 16,
      defaultTileFormat: "jpeg",
    },
    {
      id: "tiler-imagery",
      name: "Tiler Imagery",
      description: "Mock keyed imagery source sharing the streaming keyId",
      category: "api",
      keyId: "maptiler",
      attribution: "Tiler Provider",
      license: "Plan terms",
      streamOnly: false,
      strategy: "xyz",
      tileUrlTemplate: "https://tiler.example.com/{z}/{x}/{y}.jpg?key={key}",
      minZoom: 0,
      maxZoom: 16,
      defaultTileFormat: "jpeg",
    },
    {
      id: "tiler-stream",
      name: "Tiler Streaming",
      description: "Mock keyed streaming source",
      category: "api",
      keyId: "maptiler",
      attribution: "Tiler Provider",
      license: "Plan terms",
      streamOnly: true,
      strategy: "xyz",
      tileUrlTemplate: "https://tiler.example.com/{z}/{x}/{y}.jpg?key={key}",
      minZoom: 0,
      maxZoom: 18,
      defaultTileFormat: "jpeg",
    },
  ];

  async function build(
    jobId: string,
    imagerySourceId: string,
    apiKey: string,
    includeKeyInXml: boolean | undefined,
  ): Promise<{ outDir: string; output: BuildPackageOutput }> {
    const outDir = mkdtempSync(path.join(os.tmpdir(), "pkg-key-"));
    const mockAdapter = makeMockAdapter(await makeTileData());
    const output = await buildPackage({
      request: {
        packageName: "Key Guard",
        aoi: AOI,
        features: [],
        imagery: {
          sourceId: imagerySourceId,
          mode: "gpkg",
          minZoom: 14,
          maxZoom: 14,
          tileFormat: "jpeg",
          apiKey,
        },
        mapSourceXmlIds: ["tiler-stream"],
        includeKeyInXml,
      },
      jobId,
      outDir,
      catalog: KEYED_CATALOG,
      adapters: { xyz: mockAdapter },
      limits: LIMITS,
      onProgress: () => {},
    });
    return { outDir, output };
  }

  it("skips the XML and never embeds the key when the imagery keyId differs", async () => {
    const secret = "hub-client-id:hub-client-secret";
    const { outDir, output } = await build("job-key-1", "hub-imagery", secret, true);
    try {
      expect(
        output.entries.some((e) => e.endsWith("mapsource-tiler-stream.xml")),
      ).toBe(false);
      expect(
        output.warnings.some(
          (w) => w.includes("Tiler Streaming") && w.includes("different provider"),
        ),
      ).toBe(true);
      // The foreign credential must not appear anywhere in the package.
      const zip = new AdmZip(output.zipPath);
      for (const entry of zip.getEntries()) {
        expect(entry.getData().toString("utf8")).not.toContain(secret);
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("embeds the key when the XML source shares the imagery source's keyId", async () => {
    const { outDir, output } = await build(
      "job-key-2",
      "tiler-imagery",
      "tiler-key-123",
      true,
    );
    try {
      const entry = output.entries.find((e) =>
        e.endsWith("mapsource-tiler-stream.xml"),
      );
      expect(entry).toBeDefined();
      const zip = new AdmZip(output.zipPath);
      expect(zip.readAsText(entry!)).toContain("key=tiler-key-123");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("skips keyed XML without the includeKeyInXml opt-in even when keyIds match", async () => {
    const { outDir, output } = await build(
      "job-key-3",
      "tiler-imagery",
      "tiler-key-123",
      undefined,
    );
    try {
      expect(
        output.entries.some((e) => e.endsWith("mapsource-tiler-stream.xml")),
      ).toBe(false);
      expect(output.warnings.some((w) => w.includes("includeKeyInXml"))).toBe(true);
      const zip = new AdmZip(output.zipPath);
      for (const entry of zip.getEntries()) {
        expect(entry.getData().toString("utf8")).not.toContain("tiler-key-123");
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("buildPackage KML overlay opt-out", () => {
  it("emits no overlay when includeKmlOverlay=false but still exports the line as CoT", async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), "pkg-lines-"));
    try {
      const { features, lineId } = makeFeatures();
      const output = await buildPackage({
        request: {
          packageName: "Lines",
          aoi: AOI,
          features,
          mapSourceXmlIds: [],
          includeKmlOverlay: false,
        },
        jobId: "job-lines-1",
        outDir,
        catalog: CATALOG,
        adapters: {},
        limits: LIMITS,
        onProgress: () => {},
      });
      // No KML overlay at all — every feature (incl. the line) is now a CoT.
      expect(output.entries.some((e) => e.endsWith("/overlays.kml"))).toBe(false);
      expect(output.entries).toContain(`${lineId}/${lineId}.cot`);
      expect(
        output.warnings.some((w) => w.includes("includeKmlOverlay")),
      ).toBe(false);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("emits no overlay when overlay is opted out (no-feature baseline)", async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), "pkg-nolines-"));
    try {
      const marker: MapFeature = {
        id: randomUUID(),
        kind: "marker",
        name: "Alpha",
        geometry: { type: "Point", coordinates: [-111.04, 40.22] },
        style,
      };
      const output = await buildPackage({
        request: {
          packageName: "No Lines",
          aoi: AOI,
          features: [marker],
          mapSourceXmlIds: [],
          includeKmlOverlay: false,
        },
        jobId: "job-lines-2",
        outDir,
        catalog: CATALOG,
        adapters: {},
        limits: LIMITS,
        onProgress: () => {},
      });
      expect(output.entries.some((e) => e.endsWith("/overlays.kml"))).toBe(false);
      expect(output.warnings).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("buildPackage note iconset + marker attachments + range/bearing", () => {
  let outDir: string;
  let zip: AdmZip;
  let zipNames: string[];
  let noteMarkerId: string;
  let rbLineId: string;

  beforeAll(async () => {
    outDir = mkdtempSync(path.join(os.tmpdir(), "pkg-feat-"));
    noteMarkerId = randomUUID();
    rbLineId = randomUUID();
    const features: MapFeature[] = [
      {
        id: noteMarkerId,
        kind: "marker",
        name: "RP North",
        noteIcon: "flag",
        geometry: { type: "Point", coordinates: [-111.04, 40.22] },
        style,
        attachments: [
          {
            name: "photo one.jpg",
            contentType: "image/jpeg",
            base64: Buffer.from("fake-jpeg-bytes").toString("base64"),
          },
        ],
      },
      {
        id: rbLineId,
        kind: "line",
        name: "RB to OBJ",
        rangeBearing: true,
        geometry: {
          type: "LineString",
          coordinates: [
            [-111.05, 40.2],
            [-111.0, 40.2],
          ],
        },
        style,
      },
    ];
    const output = await buildPackage({
      request: {
        packageName: "Feat Pack",
        aoi: AOI,
        features,
        mapSourceXmlIds: [],
        includeKmlOverlay: true,
      },
      jobId: "job-feat-1",
      outDir,
      catalog: CATALOG,
      adapters: {},
      limits: LIMITS,
      onProgress: () => {},
    });
    zip = new AdmZip(output.zipPath);
    zipNames = zip.getEntries().map((e) => e.entryName);
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("bundles an iconset.zip containing iconset.xml + the used note PNG", () => {
    const entry = zipNames.find((n) => n.endsWith("/iconset.zip"));
    expect(entry).toBeDefined();
    const inner = new AdmZip(zip.readFile(entry!)!);
    const innerNames = inner.getEntries().map((e) => e.entryName);
    expect(innerNames).toContain("iconset.xml");
    expect(innerNames).toContain("Notes/note-flag.png");
    const xml = inner.readAsText("iconset.xml");
    expect(xml).toContain('uid="takpack-notes-iconset-0001"');
    expect(xml).toContain('<icon name="note-flag.png"/>');
    // the PNG decodes as a real image
    expect(inner.readFile("Notes/note-flag.png")!.length).toBeGreaterThan(50);
  });

  it("manifests the iconset with an iconset contentType", () => {
    const manifest = zip.readAsText("MANIFEST/manifest.xml");
    expect(manifest).toMatch(
      /<Parameter name="contentType" value="iconset"\s*\/>/,
    );
  });

  it("pins the marker photo under the marker uid with a Content uid parameter", () => {
    const att = zipNames.find((n) => n === `${noteMarkerId}/photo one.jpg`);
    expect(att).toBeDefined();
    const manifest = zip.readAsText("MANIFEST/manifest.xml");
    // The attachment Content carries the owning marker's uid.
    expect(manifest).toContain(
      `<Parameter name="uid" value="${noteMarkerId}"/>`,
    );
  });

  it("exports the note marker as a CoT with a usericon iconset reference", () => {
    const cot = zip.readAsText(`${noteMarkerId}/${noteMarkerId}.cot`);
    expect(cot).toContain(
      'iconsetpath="takpack-notes-iconset-0001/Notes/note-flag.png"',
    );
  });

  it("exports the R&B line as a native u-rb-a and omits it from the KML overlay", () => {
    const cot = zip.readAsText(`${rbLineId}/${rbLineId}.cot`);
    expect(cot).toContain('type="u-rb-a"');
    const overlay = zipNames.find((n) => n.endsWith("/overlays.kml"));
    // The only non-marker feature was the R&B line, which is CoT-only → no overlay.
    expect(overlay).toBeUndefined();
  });
});

describe("buildPackage kmz-grg attribution", () => {
  it("bakes source attribution into the GRG doc.kml description", async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), "pkg-grg-"));
    try {
      const mockAdapter = makeMockAdapter(await makeTileData());
      const output = await buildPackage({
        request: {
          packageName: "GRG Pack",
          aoi: AOI,
          features: [],
          imagery: {
            sourceId: "test-imagery",
            mode: "kmz-grg",
            minZoom: 14,
            maxZoom: 14,
            tileFormat: "jpeg",
          },
          mapSourceXmlIds: [],
        },
        jobId: "job-grg-1",
        outDir,
        catalog: CATALOG,
        adapters: { xyz: mockAdapter },
        limits: LIMITS,
        onProgress: () => {},
      });
      const zip = new AdmZip(output.zipPath);
      const kmzEntry = output.entries.find((e) => e.endsWith(".kmz"));
      expect(kmzEntry).toBeDefined();
      const kmz = new AdmZip(zip.readFile(kmzEntry!)!);
      const docKml = kmz.readAsText("doc.kml");
      expect(docKml).toContain("<description>");
      expect(docKml).toContain("Test Imagery Provider");
      expect(docKml).toContain("License: Public domain");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("buildPackage duplicate entry defense", () => {
  it("rejects duplicate feature ids before writing the zip", async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), "pkg-dup-"));
    try {
      const id = randomUUID();
      const dup = (name: string): MapFeature => ({
        id,
        kind: "marker",
        name,
        geometry: { type: "Point", coordinates: [-111.04, 40.22] },
        style,
      });
      await expect(
        buildPackage({
          request: {
            packageName: "Dup",
            aoi: AOI,
            features: [dup("A"), dup("B")],
            mapSourceXmlIds: [],
          },
          jobId: "job-dup-1",
          outDir,
          catalog: CATALOG,
          adapters: {},
          limits: LIMITS,
          onProgress: () => {},
        }),
      ).rejects.toThrow(/duplicate zip entry path/);
      expect(
        readdirSync(outDir).filter((n) => n.startsWith("job-dup-1")),
      ).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
