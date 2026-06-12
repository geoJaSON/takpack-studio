import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  sliceMasterToTiles,
  type MercBounds,
} from "../src/adapters/sentinel-pc.js";
import { tileBounds3857, tileBoundsLonLat } from "../src/export/tile-math.js";
import type { Aoi } from "../src/types.js";

const TILE_SIZE = 256;

/** Brightness centroid (red channel) across columns of a decoded tile. */
async function lineCentroid(tileData: Buffer): Promise<number> {
  const { data: raw, info } = await sharp(tileData)
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(info.width).toBe(TILE_SIZE);
  expect(info.height).toBe(TILE_SIZE);
  let sum = 0;
  let weighted = 0;
  for (const row of [64, 128, 192]) {
    for (let u = 0; u < info.width; u++) {
      const v = raw[(row * info.width + u) * info.channels];
      sum += v;
      weighted += v * u;
    }
  }
  expect(sum).toBeGreaterThan(0);
  return weighted / sum + 0.5; // pixel centers
}

describe("sliceMasterToTiles registration with a downscaled master", () => {
  it("keeps feature positions within ~1.5 tile px at a non-integral px/tile scale", async () => {
    const z = 10;
    const x0 = 100;
    const y0 = 200;
    const tilesWide = 5;
    // 5×1 tile row, nominal 1280×256 px — master capped to 192 px wide,
    // i.e. 38.4 master px per tile (scale 0.15, the Sentinel Hub regime).
    const masterW = 192;
    const masterH = 38;

    const nwTb = tileBounds3857(z, x0, y0);
    const seTb = tileBounds3857(z, x0 + tilesWide - 1, y0);
    const masterBounds: MercBounds = {
      minX: nwTb.minX,
      maxY: nwTb.maxY,
      maxX: seTb.maxX,
      minY: seTb.minY,
    };

    // AOI a hair inside the tile row so the range is exactly these 5 tiles.
    const nwLL = tileBoundsLonLat(z, x0, y0);
    const seLL = tileBoundsLonLat(z, x0 + tilesWide - 1, y0);
    const aoi: Aoi = {
      west: nwLL.west + 1e-7,
      north: nwLL.north - 1e-7,
      east: seLL.east - 1e-7,
      south: seLL.south + 1e-7,
    };

    // Black master with 1 px white vertical lines at known columns chosen to
    // land at different fractional offsets within their tiles.
    const lineCols = [27, 77, 150];
    const stripe = await sharp({
      create: {
        width: 1,
        height: masterH,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png()
      .toBuffer();
    const master = await sharp({
      create: {
        width: masterW,
        height: masterH,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .composite(lineCols.map((c) => ({ input: stripe, left: c, top: 0 })))
      .png()
      .toBuffer();

    const result = await sliceMasterToTiles(master, masterBounds, aoi, z, z, "png");
    expect(result.failed).toBe(0);
    expect(result.tiles).toHaveLength(tilesWide);

    for (const col of lineCols) {
      // Reference: the line's exact position on the zoom's full 256 px/tile
      // pixel grid (what slicing the un-downscaled master would produce).
      const globalPx = ((col + 0.5) / masterW) * tilesWide * TILE_SIZE;
      const tileIdx = Math.floor(globalPx / TILE_SIZE);
      const expectedU = globalPx - tileIdx * TILE_SIZE;
      const tile = result.tiles.find((t) => t.x === x0 + tileIdx && t.y === y0);
      expect(tile).toBeDefined();
      const centroid = await lineCentroid(tile!.data);
      expect(Math.abs(centroid - expectedU)).toBeLessThan(1.5);
    }
  });

  it("is a no-op at scale 1 (integral tile-aligned master)", async () => {
    const z = 10;
    const x0 = 60;
    const y0 = 70;
    const tilesWide = 2;
    const masterW = tilesWide * TILE_SIZE;
    const masterH = TILE_SIZE;

    const nwTb = tileBounds3857(z, x0, y0);
    const seTb = tileBounds3857(z, x0 + tilesWide - 1, y0);
    const masterBounds: MercBounds = {
      minX: nwTb.minX,
      maxY: nwTb.maxY,
      maxX: seTb.maxX,
      minY: seTb.minY,
    };
    const nwLL = tileBoundsLonLat(z, x0, y0);
    const seLL = tileBoundsLonLat(z, x0 + tilesWide - 1, y0);
    const aoi: Aoi = {
      west: nwLL.west + 1e-7,
      north: nwLL.north - 1e-7,
      east: seLL.east - 1e-7,
      south: seLL.south + 1e-7,
    };

    // Left tile solid red, right tile solid green.
    const half = await sharp({
      create: {
        width: TILE_SIZE,
        height: masterH,
        channels: 3,
        background: { r: 0, g: 255, b: 0 },
      },
    })
      .png()
      .toBuffer();
    const master = await sharp({
      create: {
        width: masterW,
        height: masterH,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .composite([{ input: half, left: TILE_SIZE, top: 0 }])
      .png()
      .toBuffer();

    const result = await sliceMasterToTiles(master, masterBounds, aoi, z, z, "png");
    expect(result.failed).toBe(0);
    expect(result.tiles).toHaveLength(2);

    const center = async (data: Buffer) => {
      const { data: raw, info } = await sharp(data)
        .raw()
        .toBuffer({ resolveWithObject: true });
      const i = (128 * info.width + 128) * info.channels;
      return { r: raw[i], g: raw[i + 1], b: raw[i + 2] };
    };
    const left = result.tiles.find((t) => t.x === x0)!;
    const right = result.tiles.find((t) => t.x === x0 + 1)!;
    expect(await center(left.data)).toEqual({ r: 255, g: 0, b: 0 });
    expect(await center(right.data)).toEqual({ r: 0, g: 255, b: 0 });
  });
});
