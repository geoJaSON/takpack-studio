import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeGeoPackage } from "../src/export/gpkg-writer.js";
import { tileBoundsLonLat } from "../src/export/tile-math.js";
import type { Aoi, PyramidTile } from "../src/types.js";

/**
 * Diffs our writer's metadata tables against the GDAL-generated reference
 * (test/fixtures/ref.gpkg): same AOI (the 2x2 z14 block x3138-3139 y6190-6191),
 * zooms 13-14, table name 'ref_tiles'.
 */

const REF_PATH = fileURLToPath(new URL("./fixtures/ref.gpkg", import.meta.url));

const Z14_TILES = [
  { x: 3138, y: 6190 },
  { x: 3138, y: 6191 },
  { x: 3139, y: 6190 },
  { x: 3139, y: 6191 },
];
const Z13_TILE = { x: 1569, y: 3095 };

/** AOI = WGS84 bounds of the 2x2 z14 block (matches the GDAL source raster). */
function refAoi(): Aoi {
  const nw = tileBoundsLonLat(14, 3138, 6190);
  const se = tileBoundsLonLat(14, 3139, 6191);
  return { north: nw.north, west: nw.west, south: se.south, east: se.east };
}

function expectRelClose(actual: number, expected: number): void {
  const tol = 1e-6 * Math.max(1, Math.abs(actual), Math.abs(expected));
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

interface TileMatrixRow {
  zoom_level: number;
  matrix_width: number;
  matrix_height: number;
  tile_width: number;
  tile_height: number;
  pixel_x_size: number;
  pixel_y_size: number;
}
interface ExtentRow {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
}

describe("writeGeoPackage vs GDAL reference", () => {
  let tmpDir: string;
  let outPath: string;
  let ours: InstanceType<typeof Database>;
  let ref: InstanceType<typeof Database>;

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "gpkg-test-"));
    outPath = path.join(tmpDir, "out.gpkg");

    const tileData = await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 3,
        background: { r: 90, g: 120, b: 60 },
      },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    const tiles: PyramidTile[] = [
      ...Z14_TILES.map((t) => ({ z: 14, x: t.x, y: t.y, data: tileData })),
      { z: 13, x: Z13_TILE.x, y: Z13_TILE.y, data: tileData },
    ];

    const { tileCount } = writeGeoPackage({
      filePath: outPath,
      tableName: "ref_tiles",
      aoi: refAoi(),
      minZoom: 13,
      maxZoom: 14,
      tiles,
      tileFormat: "jpeg",
    });
    expect(tileCount).toBe(5);

    ours = new Database(outPath, { readonly: true });
    ref = new Database(REF_PATH, { readonly: true });
  });

  afterAll(() => {
    ours?.close();
    ref?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sets the GPKG application_id pragma", () => {
    expect(ours.pragma("application_id", { simple: true })).toBe(0x47504b47);
  });

  it("has srs_id set {-1, 0, 3857, 4326}", () => {
    const ids = ours
      .prepare("SELECT srs_id FROM gpkg_spatial_ref_sys ORDER BY srs_id")
      .all() as Array<{ srs_id: number }>;
    expect(ids.map((r) => r.srs_id)).toEqual([-1, 0, 3857, 4326]);
  });

  it("matches the reference gpkg_tile_matrix_set row", () => {
    const sql =
      "SELECT table_name, srs_id, min_x, min_y, max_x, max_y FROM gpkg_tile_matrix_set";
    type Row = { table_name: string; srs_id: number } & ExtentRow;
    const a = ours.prepare(sql).get() as Row;
    const b = ref.prepare(sql).get() as Row;
    expect(a.table_name).toBe(b.table_name);
    expect(a.srs_id).toBe(b.srs_id);
    expectRelClose(a.min_x, b.min_x);
    expectRelClose(a.min_y, b.min_y);
    expectRelClose(a.max_x, b.max_x);
    expectRelClose(a.max_y, b.max_y);
  });

  it("writes gpkg_tile_matrix rows for ALL zooms 0..14 matching the reference", () => {
    const sql =
      `SELECT zoom_level, matrix_width, matrix_height, tile_width, tile_height,
              pixel_x_size, pixel_y_size
       FROM gpkg_tile_matrix ORDER BY zoom_level`;
    const a = ours.prepare(sql).all() as TileMatrixRow[];
    const b = ref.prepare(sql).all() as TileMatrixRow[];
    expect(a.map((r) => r.zoom_level)).toEqual(
      Array.from({ length: 15 }, (_, z) => z),
    );
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].zoom_level).toBe(b[i].zoom_level);
      expect(a[i].matrix_width).toBe(b[i].matrix_width);
      expect(a[i].matrix_height).toBe(b[i].matrix_height);
      expect(a[i].matrix_width).toBe(2 ** a[i].zoom_level);
      expect(a[i].tile_width).toBe(256);
      expect(a[i].tile_height).toBe(256);
      expectRelClose(a[i].pixel_x_size, b[i].pixel_x_size);
      expectRelClose(a[i].pixel_y_size, b[i].pixel_y_size);
    }
  });

  it("stores the same tile_column/tile_row keys at z13 and z14 (global XYZ, no flip)", () => {
    const sql =
      "SELECT zoom_level, tile_column, tile_row FROM ref_tiles ORDER BY zoom_level, tile_column, tile_row";
    type Key = { zoom_level: number; tile_column: number; tile_row: number };
    const keyOf = (r: Key) => `${r.zoom_level}/${r.tile_column}/${r.tile_row}`;
    const a = (ours.prepare(sql).all() as Key[]).map(keyOf);
    const b = (ref.prepare(sql).all() as Key[]).map(keyOf);
    expect(a).toEqual(b);
  });

  it("matches the reference gpkg_contents srs/data_type and extent", () => {
    const sql =
      "SELECT data_type, srs_id, min_x, min_y, max_x, max_y FROM gpkg_contents";
    type Row = { data_type: string; srs_id: number } & ExtentRow;
    const a = ours.prepare(sql).get() as Row;
    const b = ref.prepare(sql).get() as Row;
    expect(a.data_type).toBe("tiles");
    expect(a.data_type).toBe(b.data_type);
    expect(a.srs_id).toBe(b.srs_id);
    expectRelClose(a.min_x, b.min_x);
    expectRelClose(a.min_y, b.min_y);
    expectRelClose(a.max_x, b.max_x);
    expectRelClose(a.max_y, b.max_y);
  });
});
