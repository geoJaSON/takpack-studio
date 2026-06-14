import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Aoi } from "../types.js";
import { fetchBinary } from "../adapters/fetch-util.js";

/**
 * Elevation for ATAK as DTED. ATAK reads DTED natively (cursor elevation,
 * viewshed, LOS, route profiles); a `.zip` of DTED cells dropped in the package
 * is unpacked into the device's DTED/ folder and auto-loaded.
 *
 * Source: USGS 3DEP (1/3 arc-second, CONUS + territories) via the 3DEP
 * ImageServer. One 1°×1° cell per file; DTED level set by post count
 * (DTED1 = 1201, DTED2 = 3601). Requires `gdal_translate` on PATH.
 */

export type DtedLevel = 1 | 2;

const THREEDEP =
  "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage";
const NODATA = -32767;

interface Cell {
  lon: number; // SW corner, integer degrees
  lat: number;
}

/** Integer 1°×1° cells intersecting the AOI. */
export function cellsForAoi(aoi: Aoi): Cell[] {
  const cells: Cell[] = [];
  for (let lat = Math.floor(aoi.south); lat < Math.ceil(aoi.north); lat++) {
    for (let lon = Math.floor(aoi.west); lon < Math.ceil(aoi.east); lon++) {
      cells.push({ lon, lat });
    }
  }
  return cells;
}

/** DTED on-device path, e.g. {lon:-112,lat:40} → "w112/n40". */
function cellStem(c: Cell): string {
  const lonDir =
    (c.lon < 0 ? "w" : "e") + String(Math.abs(c.lon)).padStart(3, "0");
  const latFile =
    (c.lat < 0 ? "s" : "n") + String(Math.abs(c.lat)).padStart(2, "0");
  return `${lonDir}/${latFile}`;
}

// Windows CreateProcess needs the executable extension to resolve on PATH;
// TAKPACK_GDAL_TRANSLATE can point at a full path when GDAL isn't on PATH.
const GDAL_TRANSLATE =
  process.env.TAKPACK_GDAL_TRANSLATE ||
  (process.platform === "win32" ? "gdal_translate.exe" : "gdal_translate");

function runGdal(args: string[]): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(GDAL_TRANSLATE, args, { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => resolve({ ok: false, err: e.message }));
    p.on("close", (code) => resolve({ ok: code === 0, err }));
  });
}

export interface DtedResult {
  /** Cell files keyed by zip path inside the DTED tree, e.g. "w112/n40.dt2". */
  files: { path: string; content: Buffer }[];
  warnings: string[];
}

/** Approx package bytes for an AOI at a level (one cell ≈ 2.9MB dt1 / 25.9MB dt2). */
export function estimateDtedBytes(aoi: Aoi, level: DtedLevel): number {
  const posts = level === 2 ? 3601 : 1201;
  return cellsForAoi(aoi).length * posts * posts * 2;
}

/**
 * Build DTED cells for the AOI. Returns the cell files (caller zips them into
 * the package). On any cell with no 3DEP coverage (outside CONUS/territories)
 * a warning is recorded and the cell skipped; if gdal_translate is unavailable
 * the whole result is empty with a warning.
 */
export async function buildDtedCells(
  aoi: Aoi,
  level: DtedLevel,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<DtedResult> {
  const cells = cellsForAoi(aoi);
  const posts = level === 2 ? 3601 : 1201;
  const halfPx = 0.5 / (posts - 1); // half a post in degrees (1° / (posts-1))
  const files: DtedResult["files"] = [];
  const warnings: string[] = [];
  const tmp = await mkdtemp(path.join(os.tmpdir(), "takpack-dted-"));
  let gdalMissing = false;
  let done = 0;
  try {
    for (const c of cells) {
      if (signal?.aborted) break;
      // Expand the bbox by half a post so the `posts` pixel CENTERS land on the
      // integer-aligned DTED posts (the cell corners are exact integer degrees).
      const w = (c.lon - halfPx).toFixed(9);
      const s = (c.lat - halfPx).toFixed(9);
      const e = (c.lon + 1 + halfPx).toFixed(9);
      const n = (c.lat + 1 + halfPx).toFixed(9);
      const url =
        `${THREEDEP}?bbox=${w},${s},${e},${n}&bboxSR=4326&imageSR=4326` +
        `&size=${posts},${posts}&format=tiff&pixelType=F32&noData=${NODATA}` +
        `&interpolation=RSP_BilinearInterpolation&f=image`;
      const tif = await fetchBinary(url, { timeoutMs: 180_000, signal });
      done++;
      onProgress?.(done, cells.length);
      if (!tif || tif.length < 2048) {
        warnings.push(
          `Elevation: no 3DEP coverage for cell ${cellStem(c)} (3DEP is US-only).`,
        );
        continue;
      }
      const tifPath = path.join(tmp, "cell.tif");
      const dtPath = path.join(tmp, "cell.dt");
      await writeFile(tifPath, tif);
      // Input is already EPSG:4326 — no reprojection, so PROJ isn't required.
      const res = await runGdal([
        "-q", "-of", "DTED", "-ot", "Int16", "-a_nodata", String(NODATA),
        tifPath, dtPath,
      ]);
      if (!res.ok) {
        if (res.err.includes("ENOENT")) {
          gdalMissing = true;
          break;
        }
        warnings.push(`Elevation: DTED conversion failed for ${cellStem(c)}.`);
        continue;
      }
      files.push({ path: `${cellStem(c)}.dt${level}`, content: await readFile(dtPath) });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  if (gdalMissing) {
    return {
      files: [],
      warnings: [
        "Elevation skipped: gdal_translate is not on PATH (install GDAL to bundle DTED).",
      ],
    };
  }
  return { files, warnings };
}
