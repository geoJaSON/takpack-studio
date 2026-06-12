import sharp from "sharp";
import type {
  Aoi,
  FetchPyramidOptions,
  ImageryAdapter,
  ImagerySourceDef,
  PyramidResult,
  PyramidTile,
  SingleImageResult,
} from "../types.js";
import { lonLatToTileFloat, tileRangeForAoi } from "../export/tile-math.js";
import { fetchBinary, runBounded } from "./fetch-util.js";

const TILE_SIZE = 256;
const CONCURRENCY = 12;
const JPEG_QUALITY = 80;

/**
 * Substitute {z}/{x}/{y} and optional {key} placeholders. ArcGIS tile
 * endpoints are /tile/{z}/{y}/{x} (y before x) — substitution is positional
 * by placeholder name, so the template's order is preserved.
 */
export function buildTileUrl(
  template: string,
  z: number,
  x: number,
  y: number,
  key?: string,
): string {
  let url = template;
  if (url.includes("{key}")) {
    if (!key) throw new Error("Tile URL template requires an API key.");
    url = url.replaceAll("{key}", encodeURIComponent(key));
  }
  return url
    .replaceAll("{z}", String(z))
    .replaceAll("{x}", String(x))
    .replaceAll("{y}", String(y));
}

interface TileCoord {
  z: number;
  x: number;
  y: number;
}

function enumerateTiles(aoi: Aoi, minZoom: number, maxZoom: number): TileCoord[] {
  const coords: TileCoord[] = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const r = tileRangeForAoi(aoi, z);
    for (let y = r.minY; y <= r.maxY; y++) {
      for (let x = r.minX; x <= r.maxX; x++) coords.push({ z, x, y });
    }
  }
  return coords;
}

export class XyzAdapter implements ImageryAdapter {
  async fetchPyramid(
    source: ImagerySourceDef,
    aoi: Aoi,
    minZoom: number,
    maxZoom: number,
    format: "jpeg" | "png",
    opts: FetchPyramidOptions,
  ): Promise<PyramidResult> {
    const template = source.tileUrlTemplate;
    if (!template) {
      throw new Error(`Source '${source.id}' has no tileUrlTemplate.`);
    }
    if (template.includes("{key}") && !opts.apiKey) {
      throw new Error(`Source '${source.id}' requires an API key.`);
    }

    const coords = enumerateTiles(aoi, minZoom, maxZoom);
    const total = coords.length;
    // Pass tile bytes through untouched when the requested format matches the
    // source's native format; re-encode with sharp only when it differs.
    const passThrough = format === source.defaultTileFormat;
    const tiles: PyramidTile[] = [];
    let done = 0;
    let failed = 0;

    await runBounded(
      coords.map((c) => async () => {
        const url = buildTileUrl(template, c.z, c.x, c.y, opts.apiKey);
        let data = await fetchBinary(url, { signal: opts.signal });
        if (data && !passThrough) {
          try {
            data =
              format === "jpeg"
                ? await sharp(data).jpeg({ quality: JPEG_QUALITY }).toBuffer()
                : await sharp(data).png().toBuffer();
          } catch {
            data = null; // corrupt tile — count as failed, never fabricate
          }
        }
        if (data) {
          tiles.push({ z: c.z, x: c.x, y: c.y, data });
        } else {
          failed++;
        }
        done++;
        opts.onProgress?.(done, total);
      }),
      CONCURRENCY,
    );

    const warnings: string[] = [];
    if (failed > 0) {
      warnings.push(
        `${failed}/${total} tiles failed to download from '${source.id}'.`,
      );
    }
    return { tiles, fetched: tiles.length, failed, total, warnings };
  }

  /**
   * Stitch one zoom level (chosen so the long side fits maxPx) into a single
   * image cropped to the exact AOI pixel bounds. Failed tiles leave black
   * gaps in the stitched preview (counted in logs by the pyramid path; for a
   * single preview/GRG image there is no per-tile output to omit).
   */
  async fetchSingleImage(
    source: ImagerySourceDef,
    aoi: Aoi,
    maxPx: number,
    opts: FetchPyramidOptions,
  ): Promise<SingleImageResult | null> {
    const template = source.tileUrlTemplate;
    if (!template) return null;
    if (template.includes("{key}") && !opts.apiKey) return null;

    const z = pickStitchZoom(source, aoi, maxPx);
    const nwF = lonLatToTileFloat(aoi.west, aoi.north, z);
    const seF = lonLatToTileFloat(aoi.east, aoi.south, z);
    const minX = Math.floor(nwF.x);
    const minY = Math.floor(nwF.y);
    const maxX = Math.floor(seF.x);
    const maxY = Math.floor(seF.y);
    const gridW = (maxX - minX + 1) * TILE_SIZE;
    const gridH = (maxY - minY + 1) * TILE_SIZE;

    const coords: TileCoord[] = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) coords.push({ z, x, y });
    }
    const fetched = await runBounded(
      coords.map((c) => async () => ({
        c,
        buf: await fetchBinary(buildTileUrl(template, c.z, c.x, c.y, opts.apiKey), {
          signal: opts.signal,
        }),
      })),
      CONCURRENCY,
    );
    const ok = fetched.filter(
      (r): r is { c: TileCoord; buf: Buffer } => r.buf !== null,
    );
    if (ok.length === 0) return null;

    const { data: raw, info } = await sharp({
      create: {
        width: gridW,
        height: gridH,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .composite(
        ok.map(({ c, buf }) => ({
          input: buf,
          left: (c.x - minX) * TILE_SIZE,
          top: (c.y - minY) * TILE_SIZE,
        })),
      )
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Crop to the exact AOI pixel bounds — returned bounds equal the request.
    const left = Math.max(0, Math.min(Math.round((nwF.x - minX) * TILE_SIZE), gridW - 1));
    const top = Math.max(0, Math.min(Math.round((nwF.y - minY) * TILE_SIZE), gridH - 1));
    const width = Math.min(
      Math.max(1, Math.round((seF.x - nwF.x) * TILE_SIZE)),
      gridW - left,
    );
    const height = Math.min(
      Math.max(1, Math.round((seF.y - nwF.y) * TILE_SIZE)),
      gridH - top,
    );

    const data = await sharp(raw, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    })
      .extract({ left, top, width, height })
      .jpeg({ quality: 85 })
      .toBuffer();

    return { data, width, height, bounds: { ...aoi } };
  }
}

/** Highest zoom (within source limits) whose stitched AOI long side ≤ maxPx. */
function pickStitchZoom(source: ImagerySourceDef, aoi: Aoi, maxPx: number): number {
  for (let z = source.maxZoom; z > source.minZoom; z--) {
    const nwF = lonLatToTileFloat(aoi.west, aoi.north, z);
    const seF = lonLatToTileFloat(aoi.east, aoi.south, z);
    const wPx = (seF.x - nwF.x) * TILE_SIZE;
    const hPx = (seF.y - nwF.y) * TILE_SIZE;
    if (Math.max(wPx, hPx) <= maxPx) return z;
  }
  return source.minZoom;
}
