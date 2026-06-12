import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { CATALOG, getSource, LIMITS } from "../src/catalog/imagery-sources.js";
import { runBounded, setFetchImpl } from "../src/adapters/fetch-util.js";
import { buildTileUrl, XyzAdapter } from "../src/adapters/xyz.js";
import { ArcgisExportAdapter } from "../src/adapters/arcgis-export.js";
import { ADAPTERS } from "../src/adapters/index.js";
import {
  countTiles,
  tileBounds3857,
  tileBoundsLonLat,
  tileRangeForAoi,
} from "../src/export/tile-math.js";
import type { Aoi, ImagerySourceDef } from "../src/types.js";

afterEach(() => setFetchImpl(null));

/** Install a mock fetch; returns the list of requested URLs. */
function mockFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): string[] {
  const calls: string[] = [];
  setFetchImpl(async (url, init) => {
    calls.push(url);
    return handler(url, init);
  });
  return calls;
}

/** AOI strictly inside the given inclusive tile rectangle at zoom z. */
function aoiInsideTiles(
  z: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): Aoi {
  const nw = tileBoundsLonLat(z, minX, minY);
  const se = tileBoundsLonLat(z, maxX, maxY);
  const padLon = (se.east - nw.west) * 0.05;
  const padLat = (nw.north - se.south) * 0.05;
  return {
    west: nw.west + padLon,
    north: nw.north - padLat,
    east: se.east - padLon,
    south: se.south + padLat,
  };
}

function expectedKeys(aoi: Aoi, minZoom: number, maxZoom: number): Set<string> {
  const keys = new Set<string>();
  for (let z = minZoom; z <= maxZoom; z++) {
    const r = tileRangeForAoi(aoi, z);
    for (let y = r.minY; y <= r.maxY; y++) {
      for (let x = r.minX; x <= r.maxX; x++) keys.add(`${z}/${x}/${y}`);
    }
  }
  return keys;
}

async function solidPng(
  width: number,
  height: number,
  rgb: { r: number; g: number; b: number },
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: rgb } })
    .png()
    .toBuffer();
}

function source(id: string): ImagerySourceDef {
  const s = getSource(id);
  if (!s) throw new Error(`catalog missing '${id}'`);
  return s;
}

describe("buildTileUrl", () => {
  it("substitutes {z}/{x}/{y} preserving template order (ArcGIS y-before-x)", () => {
    expect(buildTileUrl("https://e/tile/{z}/{y}/{x}", 3, 1, 2)).toBe(
      "https://e/tile/3/2/1",
    );
    expect(buildTileUrl("https://e/{z}/{x}/{y}.png", 3, 1, 2)).toBe(
      "https://e/3/1/2.png",
    );
  });

  it("substitutes {key} and throws when the key is missing", () => {
    expect(buildTileUrl("https://e/{z}/{x}/{y}?key={key}", 1, 0, 0, "k1")).toBe(
      "https://e/1/0/0?key=k1",
    );
    expect(() => buildTileUrl("https://e/{z}/{x}/{y}?key={key}", 1, 0, 0)).toThrow(
      /API key/,
    );
  });
});

describe("XyzAdapter.fetchPyramid", () => {
  const adapter = new XyzAdapter();
  const z = 12;
  const aoi = aoiInsideTiles(z, 851, 1552, 852, 1553);

  it("returns every tile with correct keys for a small AOI", async () => {
    const tilePng = await solidPng(256, 256, { r: 10, g: 20, b: 30 });
    mockFetch(() => new Response(tilePng, { status: 200 }));

    const progress: Array<[number, number]> = [];
    const result = await adapter.fetchPyramid(
      source("osm-standard"),
      aoi,
      z - 1,
      z,
      "png",
      { onProgress: (done, total) => progress.push([done, total]) },
    );

    const total = countTiles(aoi, z - 1, z);
    expect(result.total).toBe(total);
    expect(result.fetched).toBe(total);
    expect(result.failed).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.tiles).toHaveLength(total);

    const keys = new Set(result.tiles.map((t) => `${t.z}/${t.x}/${t.y}`));
    expect(keys).toEqual(expectedKeys(aoi, z - 1, z));

    // png requested === source default png ⇒ bytes pass through untouched
    expect(result.tiles[0].data.equals(tilePng)).toBe(true);

    expect(progress).toHaveLength(total);
    expect(progress[progress.length - 1]).toEqual([total, total]);
  });

  it("counts failed tiles and never emits substitutes for them", async () => {
    const tilePng = await solidPng(256, 256, { r: 10, g: 20, b: 30 });
    mockFetch((url) => {
      const m = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url);
      const x = Number(m?.[2]);
      return x % 2 === 1
        ? new Response("nope", { status: 404 })
        : new Response(tilePng, { status: 200 });
    });

    const result = await adapter.fetchPyramid(
      source("osm-standard"),
      aoi,
      z - 1,
      z,
      "png",
      {},
    );

    let expectedFailed = 0;
    for (const key of expectedKeys(aoi, z - 1, z)) {
      if (Number(key.split("/")[1]) % 2 === 1) expectedFailed++;
    }
    expect(expectedFailed).toBeGreaterThan(0);
    expect(result.failed).toBe(expectedFailed);
    expect(result.fetched).toBe(result.total - expectedFailed);
    expect(result.tiles).toHaveLength(result.total - expectedFailed);
    // no black/fabricated tiles: every emitted tile is a successful fetch
    for (const t of result.tiles) {
      expect(t.x % 2).toBe(0);
      expect(t.data.equals(tilePng)).toBe(true);
    }
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("builds ArcGIS-style /tile/{z}/{y}/{x} URLs from the catalog template", async () => {
    const tilePng = await solidPng(256, 256, { r: 1, g: 2, b: 3 });
    const calls = mockFetch(() => new Response(tilePng, { status: 200 }));

    const oneTileAoi = aoiInsideTiles(12, 851, 1552, 851, 1552);
    await adapter.fetchPyramid(source("usgs-imagery"), oneTileAoi, 12, 12, "jpeg", {});

    expect(calls).toEqual([
      "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/12/1552/851",
    ]);
  });

  it("substitutes {key} into keyed templates", async () => {
    const tilePng = await solidPng(256, 256, { r: 1, g: 2, b: 3 });
    const calls = mockFetch(() => new Response(tilePng, { status: 200 }));

    const oneTileAoi = aoiInsideTiles(10, 212, 388, 212, 388);
    await adapter.fetchPyramid(
      source("maptiler-satellite"),
      oneTileAoi,
      10,
      10,
      "jpeg",
      { apiKey: "test-key-123" },
    );

    expect(calls).toEqual([
      "https://api.maptiler.com/tiles/satellite-v2/10/212/388.jpg?key=test-key-123",
    ]);
  });

  it("rejects keyed sources when no key is provided", async () => {
    mockFetch(() => new Response("x", { status: 200 }));
    const oneTileAoi = aoiInsideTiles(10, 212, 388, 212, 388);
    await expect(
      adapter.fetchPyramid(source("maptiler-satellite"), oneTileAoi, 10, 10, "jpeg", {}),
    ).rejects.toThrow(/API key/);
  });
});

describe("ArcgisExportAdapter.fetchPyramid", () => {
  it("slices one 512x512 exportImage block into 4 tiles with correct keys", async () => {
    const adapter = new ArcgisExportAdapter();
    const z = 12;
    const x0 = 851;
    const y0 = 1552;
    const aoi = aoiInsideTiles(z, x0, y0, x0 + 1, y0 + 1);

    const colors = {
      tl: { r: 255, g: 0, b: 0 },
      tr: { r: 0, g: 255, b: 0 },
      bl: { r: 0, g: 0, b: 255 },
      br: { r: 255, g: 255, b: 0 },
    };
    const block = await sharp({
      create: { width: 512, height: 512, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite([
        { input: await solidPng(256, 256, colors.tl), left: 0, top: 0 },
        { input: await solidPng(256, 256, colors.tr), left: 256, top: 0 },
        { input: await solidPng(256, 256, colors.bl), left: 0, top: 256 },
        { input: await solidPng(256, 256, colors.br), left: 256, top: 256 },
      ])
      .png()
      .toBuffer();

    const calls = mockFetch(() => new Response(block, { status: 200 }));

    const progress: Array<[number, number]> = [];
    const result = await adapter.fetchPyramid(source("naip"), aoi, z, z, "png", {
      onProgress: (done, total) => progress.push([done, total]),
    });

    expect(calls).toHaveLength(1);
    const url = calls[0];
    expect(url).toContain(
      "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?",
    );
    expect(url).toContain("bboxSR=3857");
    expect(url).toContain("imageSR=3857");
    expect(url).toContain("size=512,512");
    expect(url).toContain("format=jpg");
    expect(url).toContain("f=image");

    // bbox must be the 3857 bounds of the 2x2 tile block
    const bboxMatch = /bbox=([^&]+)/.exec(url);
    const [bMinX, bMinY, bMaxX, bMaxY] = bboxMatch![1].split(",").map(Number);
    const nwTb = tileBounds3857(z, x0, y0);
    const seTb = tileBounds3857(z, x0 + 1, y0 + 1);
    expect(bMinX).toBeCloseTo(nwTb.minX, 6);
    expect(bMaxY).toBeCloseTo(nwTb.maxY, 6);
    expect(bMaxX).toBeCloseTo(seTb.maxX, 6);
    expect(bMinY).toBeCloseTo(seTb.minY, 6);

    expect(result.total).toBe(4);
    expect(result.fetched).toBe(4);
    expect(result.failed).toBe(0);
    expect(progress[progress.length - 1]).toEqual([4, 4]);

    const byKey = new Map(result.tiles.map((t) => [`${t.z}/${t.x}/${t.y}`, t]));
    expect(new Set(byKey.keys())).toEqual(
      new Set([
        `${z}/${x0}/${y0}`,
        `${z}/${x0 + 1}/${y0}`,
        `${z}/${x0}/${y0 + 1}`,
        `${z}/${x0 + 1}/${y0 + 1}`,
      ]),
    );

    // each sliced tile is 256px and carries its quadrant's color
    const centerColor = async (data: Buffer) => {
      const { data: raw, info } = await sharp(data)
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(info.width).toBe(256);
      expect(info.height).toBe(256);
      const i = (128 * info.width + 128) * info.channels;
      return { r: raw[i], g: raw[i + 1], b: raw[i + 2] };
    };
    expect(await centerColor(byKey.get(`${z}/${x0}/${y0}`)!.data)).toEqual(colors.tl);
    expect(await centerColor(byKey.get(`${z}/${x0 + 1}/${y0}`)!.data)).toEqual(colors.tr);
    expect(await centerColor(byKey.get(`${z}/${x0}/${y0 + 1}`)!.data)).toEqual(colors.bl);
    expect(await centerColor(byKey.get(`${z}/${x0 + 1}/${y0 + 1}`)!.data)).toEqual(
      colors.br,
    );
  });

  it("counts every tile of a failed block as failed", async () => {
    const adapter = new ArcgisExportAdapter();
    const z = 12;
    const aoi = aoiInsideTiles(z, 851, 1552, 852, 1553);
    mockFetch(() => new Response("err", { status: 500 }));

    const result = await adapter.fetchPyramid(source("naip"), aoi, z, z, "jpeg", {});
    expect(result.total).toBe(4);
    expect(result.fetched).toBe(0);
    expect(result.failed).toBe(4);
    expect(result.tiles).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("catalog", () => {
  it("has exactly the contracted source ids, unique", () => {
    const ids = CATALOG.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(
      new Set([
        "usgs-imagery",
        "usgs-topo",
        "usgs-imagery-topo",
        "naip",
        "sentinel2-pc",
        "sentinel-hub",
        "maptiler-satellite",
        "esri-world-imagery",
        "esri-world-topo",
        "osm-standard",
        "opentopomap",
        "eox-s2cloudless",
        "planet-basemaps",
      ]),
    );
  });

  it("flags exactly the stream-only sources", () => {
    const streamOnly = CATALOG.filter((s) => s.streamOnly).map((s) => s.id);
    expect(new Set(streamOnly)).toEqual(
      new Set([
        "esri-world-imagery",
        "esri-world-topo",
        "osm-standard",
        "opentopomap",
        "eox-s2cloudless",
        "planet-basemaps",
      ]),
    );
  });

  it("keyed (api) sources declare keyId", () => {
    for (const s of CATALOG.filter((x) => x.category === "api")) {
      expect(s.keyId, s.id).toBeTruthy();
    }
  });

  it("xyz sources have a tile template; arcgis-export sources have exportUrlBase", () => {
    for (const s of CATALOG) {
      if (s.strategy === "xyz") {
        expect(s.tileUrlTemplate, s.id).toMatch(/\{z\}/);
        expect(s.tileUrlTemplate, s.id).toMatch(/\{x\}/);
        expect(s.tileUrlTemplate, s.id).toMatch(/\{y\}/);
      }
      if (s.strategy === "arcgis-export") {
        expect(s.exportUrlBase, s.id).toBeTruthy();
      }
      expect(s.minZoom, s.id).toBe(0);
      expect(s.maxZoom, s.id).toBeGreaterThan(0);
      expect(s.attribution, s.id).toBeTruthy();
      expect(s.license, s.id).toBeTruthy();
    }
  });

  it("getSource and LIMITS behave per contract", () => {
    expect(getSource("usgs-imagery")?.id).toBe("usgs-imagery");
    expect(getSource("does-not-exist")).toBeUndefined();
    expect(LIMITS).toEqual({
      maxTilesPerExport: 10000,
      recommendedMaxPackageBytes: 300 * 1024 * 1024,
      maxGrgPixels: 8192,
    });
  });

  it("wires adapters for every offline strategy but not planet", () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual(
      ["arcgis-export", "sentinel-hub", "stac-sentinel2", "xyz"].sort(),
    );
    expect(ADAPTERS.planet).toBeUndefined();
    for (const s of CATALOG.filter((x) => !x.streamOnly)) {
      expect(ADAPTERS[s.strategy], s.id).toBeDefined();
    }
  });
});

describe("runBounded", () => {
  it("preserves order and respects the concurrency bound", async () => {
    let inFlight = 0;
    let peak = 0;
    const jobs = Array.from({ length: 10 }, (_, i) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i;
    });
    const results = await runBounded(jobs, 3);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});
