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
  aoiTo3857,
  countTiles,
  tileBounds3857,
  tileBoundsLonLat,
  tileRangeForAoi,
} from "../export/tile-math.js";
import { fetchBinary, fetchJson } from "./fetch-util.js";

const STAC_SEARCH_URL = "https://planetarycomputer.microsoft.com/api/stac/v1/search";
const CROP_URL_BASE = "https://planetarycomputer.microsoft.com/api/data/v1/item/crop";
const COLLECTION = "sentinel-2-l2a";
const MASTER_MAX_PX = 4096;
const CROP_TIMEOUT_MS = 120_000;
const TILE_SIZE = 256;
const JPEG_QUALITY = 80;

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
          // master crop is downscaled (capped at 2500/4096 px).
          const scaleX = TILE_SIZE / (fRight - fLeft);
          const scaleY = TILE_SIZE / (fBottom - fTop);
          // Destination offset within the tile (>0 only for edge tiles whose
          // window starts before the master, i.e. fLeft<0 / fTop<0).
          const dLeft = Math.max(0, Math.round((cLeft - fLeft) * scaleX));
          const dTop = Math.max(0, Math.round((cTop - fTop) * scaleY));
          // Resized extract dimensions at the tile's scale.
          const rw = Math.max(1, Math.round((cRight - cLeft) * scaleX));
          const rh = Math.max(1, Math.round((cBottom - cTop) * scaleY));
          // Sub-window of the resized piece that lies inside the tile.
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

interface StacSearchResponse {
  features?: Array<{ id?: string }>;
}

/**
 * Planetary Computer Sentinel-2 L2A adapter: STAC search for the lowest-cloud
 * scene in the last 12 months, then titiler bbox crops of its `visual` asset.
 * Native resolution is ~10 m (~z14) — any higher zooms are interpolated.
 */
export class StacSentinel2Adapter implements ImageryAdapter {
  private async searchLowestCloudItem(
    aoi: Aoi,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const end = new Date();
    const start = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
    const body = JSON.stringify({
      collections: [COLLECTION],
      bbox: [aoi.west, aoi.south, aoi.east, aoi.north],
      datetime: `${start.toISOString()}/${end.toISOString()}`,
      query: { "eo:cloud_cover": { lt: 30 } },
      sortby: [{ field: "properties.eo:cloud_cover", direction: "asc" }],
      limit: 1,
    });
    const res = await fetchJson<StacSearchResponse>(STAC_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      timeoutMs: 30_000,
      signal,
    });
    const id = res?.features?.[0]?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }

  private cropUrl(
    itemId: string,
    bbox: Aoi,
    width: number,
    height: number,
    dstCrs?: string,
  ): string {
    const coords = `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
    let url =
      `${CROP_URL_BASE}/${coords}/${width}x${height}.jpg` +
      `?collection=${COLLECTION}&item=${encodeURIComponent(itemId)}&assets=visual`;
    if (dstCrs) url += `&dst_crs=${encodeURIComponent(dstCrs)}`;
    return url;
  }

  async fetchPyramid(
    source: ImagerySourceDef,
    aoi: Aoi,
    minZoom: number,
    maxZoom: number,
    format: "jpeg" | "png",
    opts: FetchPyramidOptions,
  ): Promise<PyramidResult> {
    const itemId = await this.searchLowestCloudItem(aoi, opts.signal);
    if (!itemId) {
      return emptyPyramidFailure(
        aoi,
        minZoom,
        maxZoom,
        "Sentinel-2 (Planetary Computer): no low-cloud scene found for the AOI in the last 12 months.",
      );
    }

    // One master crop aligned to the maxZoom tile range, sliced per zoom.
    const r = tileRangeForAoi(aoi, maxZoom);
    const nwLL = tileBoundsLonLat(maxZoom, r.minX, r.minY);
    const seLL = tileBoundsLonLat(maxZoom, r.maxX, r.maxY);
    const cropBbox: Aoi = {
      west: nwLL.west,
      north: nwLL.north,
      east: seLL.east,
      south: seLL.south,
    };
    const fullW = (r.maxX - r.minX + 1) * TILE_SIZE;
    const fullH = (r.maxY - r.minY + 1) * TILE_SIZE;
    const scale = Math.min(1, MASTER_MAX_PX / Math.max(fullW, fullH));
    const width = Math.max(1, Math.round(fullW * scale));
    const height = Math.max(1, Math.round(fullH * scale));

    // dst_crs=EPSG:3857 keeps master pixel rows aligned with the mercator
    // tile grid so slicing introduces no latitude distortion.
    const master = await fetchBinary(
      this.cropUrl(itemId, cropBbox, width, height, "EPSG:3857"),
      { timeoutMs: CROP_TIMEOUT_MS, signal: opts.signal },
    );
    if (!master) {
      return emptyPyramidFailure(
        aoi,
        minZoom,
        maxZoom,
        "Sentinel-2 (Planetary Computer): titiler crop request failed.",
      );
    }

    const nwTb = tileBounds3857(maxZoom, r.minX, r.minY);
    const seTb = tileBounds3857(maxZoom, r.maxX, r.maxY);
    const masterBounds: MercBounds = {
      minX: nwTb.minX,
      maxY: nwTb.maxY,
      maxX: seTb.maxX,
      minY: seTb.minY,
    };
    const warnings: string[] = [];
    if (scale < 1) {
      warnings.push(
        `Sentinel-2 master crop capped at ${MASTER_MAX_PX}px — highest zoom tiles are interpolated upsamples.`,
      );
    }
    return sliceMasterToTiles(
      master,
      masterBounds,
      aoi,
      minZoom,
      maxZoom,
      format,
      opts.onProgress,
      warnings,
    );
  }

  async fetchSingleImage(
    source: ImagerySourceDef,
    aoi: Aoi,
    maxPx: number,
    opts: FetchPyramidOptions,
  ): Promise<SingleImageResult | null> {
    const itemId = await this.searchLowestCloudItem(aoi, opts.signal);
    if (!itemId) return null;

    // Aspect from mercator extents so pixels are visually square.
    const m = aoiTo3857(aoi);
    const wMeters = m.maxX - m.minX;
    const hMeters = m.maxY - m.minY;
    if (wMeters <= 0 || hMeters <= 0) return null;
    const longPx = Math.min(maxPx, MASTER_MAX_PX);
    let width: number;
    let height: number;
    if (wMeters >= hMeters) {
      width = longPx;
      height = Math.max(1, Math.round((longPx * hMeters) / wMeters));
    } else {
      height = longPx;
      width = Math.max(1, Math.round((longPx * wMeters) / hMeters));
    }

    const data = await fetchBinary(this.cropUrl(itemId, aoi, width, height), {
      timeoutMs: CROP_TIMEOUT_MS,
      signal: opts.signal,
    });
    if (!data) return null;
    try {
      const meta = await sharp(data).metadata();
      return {
        data,
        width: meta.width ?? width,
        height: meta.height ?? height,
        bounds: { ...aoi },
      };
    } catch {
      return null;
    }
  }
}
