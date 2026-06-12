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
import { aoiTo3857, tileBounds3857, tileRangeForAoi } from "../export/tile-math.js";
import { fetchBinary, runBounded } from "./fetch-util.js";

const TILE_SIZE = 256;
/**
 * 15×15 tiles = 3840 px per side — keeps 256 px tile alignment while staying
 * within the USGS NAIP ImageServer's maxImageWidth/maxImageHeight of 4000
 * (4096 px requests return an HTTP-200 JSON error body, not an image).
 */
const BLOCK_TILES = 15;
/** Verified inclusive per-request pixel cap (server maxImageWidth/Height). */
const MAX_REQ_PX = 4000;
const BLOCK_CONCURRENCY = 4;
const EXPORT_TIMEOUT_MS = 90_000;
const JPEG_QUALITY = 80;

interface MercBbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** ImageServer exportImage request, EPSG:3857 in and out, raw image body. */
function exportImageUrl(
  base: string,
  bbox: MercBbox,
  width: number,
  height: number,
): string {
  return (
    `${base}/exportImage?bbox=${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}` +
    `&bboxSR=3857&imageSR=3857&size=${width},${height}&format=jpg&f=image`
  );
}

interface Block {
  z: number;
  x0: number;
  y0: number;
  xCount: number;
  yCount: number;
}

/**
 * ArcGIS servers return JSON error payloads with HTTP 200 AND a lying
 * image/jpeg content-type (verified live against imagery.nationalmap.gov),
 * so detection must sniff the body: a leading '{' is never a JPEG/PNG.
 * Returns the parsed error message, or null when the buffer is not JSON.
 */
export function arcgisErrorMessage(buf: Buffer): string | null {
  let i = 0;
  while (
    i < buf.length &&
    (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)
  ) {
    i++;
  }
  if (i >= buf.length || buf[i] !== 0x7b /* '{' */) return null;
  try {
    const parsed = JSON.parse(buf.toString("utf8")) as {
      error?: { message?: string };
    };
    return parsed.error?.message ?? "server returned a JSON error";
  } catch {
    return "server returned a non-image response";
  }
}

export class ArcgisExportAdapter implements ImageryAdapter {
  async fetchPyramid(
    source: ImagerySourceDef,
    aoi: Aoi,
    minZoom: number,
    maxZoom: number,
    format: "jpeg" | "png",
    opts: FetchPyramidOptions,
  ): Promise<PyramidResult> {
    const base = source.exportUrlBase;
    if (!base) {
      throw new Error(`Source '${source.id}' has no exportUrlBase.`);
    }

    // Partition each zoom's tile range into ≤15×15-tile blocks so every
    // exportImage request stays within the server's 4000 px budget.
    const blocks: Block[] = [];
    let total = 0;
    for (let z = minZoom; z <= maxZoom; z++) {
      const r = tileRangeForAoi(aoi, z);
      total += r.count;
      for (let y0 = r.minY; y0 <= r.maxY; y0 += BLOCK_TILES) {
        for (let x0 = r.minX; x0 <= r.maxX; x0 += BLOCK_TILES) {
          blocks.push({
            z,
            x0,
            y0,
            xCount: Math.min(BLOCK_TILES, r.maxX - x0 + 1),
            yCount: Math.min(BLOCK_TILES, r.maxY - y0 + 1),
          });
        }
      }
    }

    const tiles: PyramidTile[] = [];
    const serverErrors = new Set<string>();
    let done = 0;
    let failed = 0;
    const step = () => {
      done++;
      opts.onProgress?.(done, total);
    };

    await runBounded(
      blocks.map((b) => async () => {
        const nw = tileBounds3857(b.z, b.x0, b.y0);
        const se = tileBounds3857(b.z, b.x0 + b.xCount - 1, b.y0 + b.yCount - 1);
        const bbox: MercBbox = {
          minX: nw.minX,
          maxY: nw.maxY,
          maxX: se.maxX,
          minY: se.minY,
        };
        const width = b.xCount * TILE_SIZE;
        const height = b.yCount * TILE_SIZE;
        const buf = await fetchBinary(exportImageUrl(base, bbox, width, height), {
          timeoutMs: EXPORT_TIMEOUT_MS,
          signal: opts.signal,
        });
        const serverError = buf ? arcgisErrorMessage(buf) : null;
        if (!buf || serverError) {
          // Whole block failed — every tile in it is a failure, never black.
          if (serverError) serverErrors.add(serverError);
          for (let i = 0; i < b.xCount * b.yCount; i++) {
            failed++;
            step();
          }
          return;
        }
        let raw: Buffer;
        let info: sharp.OutputInfo;
        try {
          const decoded = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
          raw = decoded.data;
          info = decoded.info;
        } catch {
          for (let i = 0; i < b.xCount * b.yCount; i++) {
            failed++;
            step();
          }
          return;
        }
        for (let j = 0; j < b.yCount; j++) {
          for (let i = 0; i < b.xCount; i++) {
            const left = i * TILE_SIZE;
            const top = j * TILE_SIZE;
            if (left + TILE_SIZE > info.width || top + TILE_SIZE > info.height) {
              failed++; // server returned a short image — don't fabricate
              step();
              continue;
            }
            try {
              const slice = sharp(raw, {
                raw: { width: info.width, height: info.height, channels: info.channels },
              }).extract({ left, top, width: TILE_SIZE, height: TILE_SIZE });
              const data =
                format === "jpeg"
                  ? await slice.jpeg({ quality: JPEG_QUALITY }).toBuffer()
                  : await slice.png().toBuffer();
              tiles.push({ z: b.z, x: b.x0 + i, y: b.y0 + j, data });
            } catch {
              failed++;
            }
            step();
          }
        }
      }),
      BLOCK_CONCURRENCY,
      opts.signal,
    );

    const warnings: string[] = [];
    for (const msg of serverErrors) {
      warnings.push(`ArcGIS exportImage error from '${source.id}': ${msg}`);
    }
    if (failed > 0) {
      warnings.push(
        `${failed}/${total} tiles failed to download from '${source.id}'.`,
      );
    }
    return { tiles, fetched: tiles.length, failed, total, warnings };
  }

  /** One exportImage covering the AOI; long side maxPx (capped at 4000). */
  async fetchSingleImage(
    source: ImagerySourceDef,
    aoi: Aoi,
    maxPx: number,
    opts: FetchPyramidOptions,
  ): Promise<SingleImageResult | null> {
    const base = source.exportUrlBase;
    if (!base) return null;

    const m = aoiTo3857(aoi);
    const wMeters = m.maxX - m.minX;
    const hMeters = m.maxY - m.minY;
    if (wMeters <= 0 || hMeters <= 0) return null;
    const longPx = Math.min(maxPx, MAX_REQ_PX);
    let width: number;
    let height: number;
    if (wMeters >= hMeters) {
      width = longPx;
      height = Math.max(1, Math.round((longPx * hMeters) / wMeters));
    } else {
      height = longPx;
      width = Math.max(1, Math.round((longPx * wMeters) / hMeters));
    }

    const buf = await fetchBinary(exportImageUrl(base, m, width, height), {
      timeoutMs: EXPORT_TIMEOUT_MS,
      signal: opts.signal,
    });
    if (!buf) return null;
    const serverError = arcgisErrorMessage(buf);
    if (serverError) {
      throw new Error(`ArcGIS exportImage error from '${source.id}': ${serverError}`);
    }

    try {
      const meta = await sharp(buf).metadata();
      return {
        data: buf,
        width: meta.width ?? width,
        height: meta.height ?? height,
        bounds: { ...aoi },
      };
    } catch {
      return null; // non-image response (e.g. JSON error payload)
    }
  }
}
