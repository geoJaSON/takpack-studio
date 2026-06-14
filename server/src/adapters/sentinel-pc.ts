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
import {
  countTiles,
  lonLatToTileFloat,
  tileBounds3857,
  tileRangeForAoi,
} from "../export/tile-math.js";
import { runBounded, sniffImageFormat } from "./fetch-util.js";
import { fetchSentinelTile } from "./preview-tiles.js";

const TILE_SIZE = 256;
const JPEG_QUALITY = 80;
/** PC mosaic tiler is shared/anonymous — keep concurrency gentle. */
const CONCURRENCY = 6;
/** DESIGN.md: >60% tile failure ⇒ job failure (mirrors package-builder). */
const TILE_FAIL_ABORT_RATIO = 0.6;

export interface MercBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** PyramidResult for a total fetch failure — every tile counted failed. */
export function emptyPyramidFailure(
  aoi: Aoi,
  minZoom: number,
  maxZoom: number,
  warning: string,
): PyramidResult {
  const total = countTiles(aoi, minZoom, maxZoom);
  return { tiles: [], fetched: 0, failed: total, total, warnings: [warning] };
}

/**
 * Slice one master crop (with known EPSG:3857 bounds) into 256 px XYZ tiles
 * for every zoom in [minZoom..maxZoom]. Each tile is resampled from the
 * master at its own scale — zooms whose native resolution exceeds the master
 * are interpolated upsamples. Edge tiles only partially covered by the master
 * are padded (black for jpeg, transparent for png); tiles entirely outside
 * the master are counted failed, never fabricated.
 *
 * Still used by the Sentinel Hub adapter (Processing-API master renders).
 */
export async function sliceMasterToTiles(
  master: Buffer,
  masterBounds: MercBounds,
  aoi: Aoi,
  minZoom: number,
  maxZoom: number,
  format: "jpeg" | "png",
  onProgress?: (done: number, total: number) => void,
  baseWarnings: string[] = [],
): Promise<PyramidResult> {
  const { data: raw, info } = await sharp(master)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pxPerMeterX = info.width / (masterBounds.maxX - masterBounds.minX);
  const pxPerMeterY = info.height / (masterBounds.maxY - masterBounds.minY);

  const total = countTiles(aoi, minZoom, maxZoom);
  const tiles: PyramidTile[] = [];
  const warnings = [...baseWarnings];
  let done = 0;
  let failed = 0;

  for (let z = minZoom; z <= maxZoom; z++) {
    const r = tileRangeForAoi(aoi, z);
    for (let y = r.minY; y <= r.maxY; y++) {
      for (let x = r.minX; x <= r.maxX; x++) {
        const tb = tileBounds3857(z, x, y);
        // Tile rect in master pixel coordinates (fractional).
        const fLeft = (tb.minX - masterBounds.minX) * pxPerMeterX;
        const fTop = (masterBounds.maxY - tb.maxY) * pxPerMeterY;
        const fRight = (tb.maxX - masterBounds.minX) * pxPerMeterX;
        const fBottom = (masterBounds.maxY - tb.minY) * pxPerMeterY;
        const cLeft = Math.max(0, Math.floor(fLeft));
        const cTop = Math.max(0, Math.floor(fTop));
        const cRight = Math.min(info.width, Math.ceil(fRight));
        const cBottom = Math.min(info.height, Math.ceil(fBottom));
        if (cRight - cLeft < 1 || cBottom - cTop < 1) {
          failed++;
          done++;
          onProgress?.(done, total);
          continue;
        }
        try {
          // Map the exact fractional window [fLeft,fRight]×[fTop,fBottom]
          // onto the 256 px tile: resize the integer-aligned extract at the
          // tile's true scale, then crop the fractional sub-window from the
          // resized piece. Clamping the enlarged extract straight onto the
          // tile would shift/stretch content by up to 1/scale px whenever the
          // master crop is downscaled.
          const scaleX = TILE_SIZE / (fRight - fLeft);
          const scaleY = TILE_SIZE / (fBottom - fTop);
          const dLeft = Math.max(0, Math.round((cLeft - fLeft) * scaleX));
          const dTop = Math.max(0, Math.round((cTop - fTop) * scaleY));
          const rw = Math.max(1, Math.round((cRight - cLeft) * scaleX));
          const rh = Math.max(1, Math.round((cBottom - cTop) * scaleY));
          const ox = Math.min(rw - 1, Math.max(0, Math.round((fLeft - cLeft) * scaleX)));
          const oy = Math.min(rh - 1, Math.max(0, Math.round((fTop - cTop) * scaleY)));
          const dW = Math.max(1, Math.min(TILE_SIZE - dLeft, rw - ox));
          const dH = Math.max(1, Math.min(TILE_SIZE - dTop, rh - oy));
          const piece = await sharp(raw, {
            raw: { width: info.width, height: info.height, channels: info.channels },
          })
            .extract({
              left: cLeft,
              top: cTop,
              width: cRight - cLeft,
              height: cBottom - cTop,
            })
            .resize(rw, rh, { fit: "fill" })
            .extract({ left: ox, top: oy, width: dW, height: dH })
            .png()
            .toBuffer();
          const canvas = sharp({
            create: {
              width: TILE_SIZE,
              height: TILE_SIZE,
              channels: format === "png" ? 4 : 3,
              background:
                format === "png"
                  ? { r: 0, g: 0, b: 0, alpha: 0 }
                  : { r: 0, g: 0, b: 0 },
            },
          }).composite([{ input: piece, left: dLeft, top: dTop }]);
          const data =
            format === "jpeg"
              ? await canvas.jpeg({ quality: JPEG_QUALITY }).toBuffer()
              : await canvas.png().toBuffer();
          tiles.push({ z, x, y, data });
        } catch {
          failed++;
        }
        done++;
        onProgress?.(done, total);
      }
    }
  }

  if (failed > 0) {
    warnings.push(`${failed}/${total} tiles could not be sliced from the master crop.`);
  }
  return { tiles, fetched: tiles.length, failed, total, warnings };
}

interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/**
 * Planetary Computer Sentinel-2 L2A adapter, backed by the PC **mosaic tiler**
 * (a low-cloud sentinel-2-l2a `visual` mosaic) rather than a single scene's
 * crop. This gives full AOI coverage (the previous single-item titiler crop
 * only covered one ~100 km scene footprint and could not be re-cropped per
 * tile). Native resolution ~10 m (~z14); higher zooms upscale.
 */
export class StacSentinel2Adapter implements ImageryAdapter {
  async fetchPyramid(
    source: ImagerySourceDef,
    aoi: Aoi,
    minZoom: number,
    maxZoom: number,
    format: "jpeg" | "png",
    opts: FetchPyramidOptions,
  ): Promise<PyramidResult> {
    const coords: TileCoord[] = [];
    for (let z = minZoom; z <= maxZoom; z++) {
      const r = tileRangeForAoi(aoi, z);
      for (let y = r.minY; y <= r.maxY; y++) {
        for (let x = r.minX; x <= r.maxX; x++) coords.push({ z, x, y });
      }
    }
    const total = coords.length;
    const tiles: PyramidTile[] = [];
    let done = 0;
    let failed = 0;

    await runBounded(
      coords.map((c) => async () => {
        let data = await fetchSentinelTile(c.z, c.x, c.y, opts.signal);
        if (data) {
          const sniffed = sniffImageFormat(data);
          if (!sniffed) {
            data = null; // non-image body — never package raw bytes
          } else if (sniffed !== format) {
            try {
              data =
                format === "jpeg"
                  ? await sharp(data).jpeg({ quality: JPEG_QUALITY }).toBuffer()
                  : await sharp(data).png().toBuffer();
            } catch {
              data = null;
            }
          }
        }
        if (data) tiles.push({ z: c.z, x: c.x, y: c.y, data });
        else failed++;
        done++;
        opts.onProgress?.(done, total);
      }),
      CONCURRENCY,
      opts.signal,
    );

    const warnings: string[] = [];
    if (failed > 0) {
      warnings.push(
        `${failed}/${total} Sentinel-2 mosaic tiles failed to fetch from the Planetary Computer.`,
      );
    }
    return { tiles, fetched: tiles.length, failed, total, warnings };
  }

  /** Stitch one zoom of the mosaic, cropped to the exact AOI (GRG / preview). */
  async fetchSingleImage(
    source: ImagerySourceDef,
    aoi: Aoi,
    maxPx: number,
    opts: FetchPyramidOptions,
  ): Promise<SingleImageResult | null> {
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
        buf: await fetchSentinelTile(c.z, c.x, c.y, opts.signal),
      })),
      CONCURRENCY,
      opts.signal,
    );
    const ok = fetched.filter(
      (r): r is { c: TileCoord; buf: Buffer } =>
        r?.buf != null && sniffImageFormat(r.buf) !== null,
    );
    const failed = coords.length - ok.length;
    if (failed / coords.length > TILE_FAIL_ABORT_RATIO) {
      throw new Error(
        `Imagery fetch failed: ${failed}/${coords.length} Sentinel-2 tiles failed`,
      );
    }
    if (ok.length === 0) return null;
    const warnings =
      failed > 0
        ? [`${failed}/${coords.length} Sentinel-2 tiles failed; image has black gaps.`]
        : [];

    const { data: raw, info } = await sharp({
      create: { width: gridW, height: gridH, channels: 3, background: { r: 0, g: 0, b: 0 } },
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

    const left = Math.max(0, Math.min(Math.round((nwF.x - minX) * TILE_SIZE), gridW - 1));
    const top = Math.max(0, Math.min(Math.round((nwF.y - minY) * TILE_SIZE), gridH - 1));
    const width = Math.min(Math.max(1, Math.round((seF.x - nwF.x) * TILE_SIZE)), gridW - left);
    const height = Math.min(Math.max(1, Math.round((seF.y - nwF.y) * TILE_SIZE)), gridH - top);

    const data = await sharp(raw, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    })
      .extract({ left, top, width, height })
      .jpeg({ quality: 85 })
      .toBuffer();

    const result: SingleImageResult = { data, width, height, bounds: { ...aoi } };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
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
