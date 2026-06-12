import type { Aoi } from "../types";

/**
 * Client-side export size estimation. Mirrors the server's slippy-map tile
 * math (server/src/export/tile-math.ts) — keep the two in sync.
 */

const MAX_MERC_LAT = 85.05112877980659;

function clampLat(lat: number): number {
  return Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, lat));
}

/** Integer XYZ (top-origin) tile containing a lon/lat at zoom z. */
function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latRad = (clampLat(lat) * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return {
    x: Math.max(0, Math.min(n - 1, Math.floor(x))),
    y: Math.max(0, Math.min(n - 1, Math.floor(y))),
  };
}

/** Total XYZ tiles covering `aoi` across the inclusive zoom range. */
export function countTilesForAoi(aoi: Aoi, minZ: number, maxZ: number): number {
  let total = 0;
  for (let z = minZ; z <= maxZ; z++) {
    const nw = lonLatToTile(aoi.west, aoi.north, z);
    const se = lonLatToTile(aoi.east, aoi.south, z);
    total +=
      (Math.abs(se.x - nw.x) + 1) * (Math.abs(se.y - nw.y) + 1);
  }
  return total;
}

/** Heuristic bytes per 256px tile (matches DESIGN.md: 35 KB jpeg, 70 KB png). */
const BYTES_PER_TILE: Record<"jpeg" | "png", number> = {
  jpeg: 35 * 1024,
  png: 70 * 1024,
};

export function estimatePackageBytes(
  tileCount: number,
  format: "jpeg" | "png",
): number {
  return tileCount * BYTES_PER_TILE[format];
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}
