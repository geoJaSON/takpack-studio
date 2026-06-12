import type { Aoi, Position } from "../types";

/**
 * Client-side export size estimation. Mirrors the server's slippy-map tile
 * math (server/src/export/tile-math.ts) — keep the two in sync.
 */

const MAX_MERC_LAT = 85.05112877980659;

function clampLat(lat: number): number {
  return Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, lat));
}

/** Fractional XYZ (top-origin) tile coordinates of a lon/lat at zoom z. */
function lonLatToTileFloat(
  lon: number,
  lat: number,
  z: number,
): { x: number; y: number } {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latRad = (clampLat(lat) * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

/**
 * Inclusive XYZ tile range covering `aoi` at zoom z. The SE corner is
 * half-open — ceil(seFloat) - 1 — so an AOI edge sitting exactly on a tile
 * boundary does not pull in an extra row/column of tiles the AOI only
 * touches with measure zero. Mirrors server tileRangeForAoi.
 */
function tileRangeForAoi(
  aoi: Aoi,
  z: number,
): { minX: number; minY: number; maxX: number; maxY: number; count: number } {
  const n = 2 ** z;
  const clamp = (v: number) => Math.max(0, Math.min(n - 1, v));
  const nwF = lonLatToTileFloat(aoi.west, aoi.north, z);
  const seF = lonLatToTileFloat(aoi.east, aoi.south, z);
  const nwX = clamp(Math.floor(nwF.x));
  const nwY = clamp(Math.floor(nwF.y));
  const seX = clamp(Math.ceil(seF.x) - 1);
  const seY = clamp(Math.ceil(seF.y) - 1);
  const minX = Math.min(nwX, seX);
  const maxX = Math.max(nwX, seX);
  const minY = Math.min(nwY, seY);
  const maxY = Math.max(nwY, seY);
  return {
    minX,
    minY,
    maxX,
    maxY,
    count: (maxX - minX + 1) * (maxY - minY + 1),
  };
}

/** Total XYZ tiles covering `aoi` across the inclusive zoom range. */
export function countTilesForAoi(aoi: Aoi, minZ: number, maxZ: number): number {
  let total = 0;
  for (let z = minZ; z <= maxZ; z++) total += tileRangeForAoi(aoi, z).count;
  return total;
}

/**
 * AOI box from two corner clicks ([lon, lat], already wrapped to ±180).
 * Returns null when the corners straddle the antimeridian — min/maxing such
 * corners would silently produce a near-world-spanning box.
 */
export function aoiFromCorners(a: Position, b: Position): Aoi | null {
  if (Math.abs(a[0] - b[0]) > 180) return null;
  return {
    north: Math.max(a[1], b[1]),
    south: Math.min(a[1], b[1]),
    east: Math.max(a[0], b[0]),
    west: Math.min(a[0], b[0]),
  };
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
