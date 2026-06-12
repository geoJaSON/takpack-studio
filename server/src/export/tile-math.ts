import type { Aoi } from "../types.js";

/**
 * Slippy-map (EPSG:3857, GoogleMapsCompatible, 256px, top-origin XYZ) tile math.
 * Shared by adapters, the GeoPackage writer, and export validation.
 */

export const WEB_MERCATOR_EXTENT = 20037508.342789244;
/** Meters per pixel at zoom 0 (256px tile spanning the full extent). */
export const INITIAL_RESOLUTION = (2 * WEB_MERCATOR_EXTENT) / 256;
/** Web Mercator latitude clamp. */
export const MAX_MERC_LAT = 85.05112877980659;

export function clampLat(lat: number): number {
  return Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, lat));
}

/** Fractional tile coordinates of a lon/lat at zoom z. */
export function lonLatToTileFloat(
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

/** Integer tile containing a lon/lat at zoom z (clamped to the grid). */
export function lonLatToTile(
  lon: number,
  lat: number,
  z: number,
): { x: number; y: number } {
  const n = 2 ** z;
  const f = lonLatToTileFloat(lon, lat, z);
  return {
    x: Math.max(0, Math.min(n - 1, Math.floor(f.x))),
    y: Math.max(0, Math.min(n - 1, Math.floor(f.y))),
  };
}

export interface TileRange {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  count: number;
}

/** Inclusive XYZ tile range covering an AOI at zoom z. */
export function tileRangeForAoi(aoi: Aoi, z: number): TileRange {
  const nw = lonLatToTile(aoi.west, aoi.north, z);
  const se = lonLatToTile(aoi.east, aoi.south, z);
  const minX = Math.min(nw.x, se.x);
  const maxX = Math.max(nw.x, se.x);
  const minY = Math.min(nw.y, se.y);
  const maxY = Math.max(nw.y, se.y);
  return {
    minX,
    minY,
    maxX,
    maxY,
    count: (maxX - minX + 1) * (maxY - minY + 1),
  };
}

/** Total tiles covering an AOI across an inclusive zoom range. */
export function countTiles(aoi: Aoi, minZoom: number, maxZoom: number): number {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) total += tileRangeForAoi(aoi, z).count;
  return total;
}

/** Project lon/lat (degrees) to EPSG:3857 meters. */
export function lonLatTo3857(
  lon: number,
  lat: number,
): { x: number; y: number } {
  const x = (lon / 180) * WEB_MERCATOR_EXTENT;
  const latRad = (clampLat(lat) * Math.PI) / 180;
  const y =
    (Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) *
    WEB_MERCATOR_EXTENT;
  return { x, y };
}

export function aoiTo3857(aoi: Aoi): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const sw = lonLatTo3857(aoi.west, aoi.south);
  const ne = lonLatTo3857(aoi.east, aoi.north);
  return { minX: sw.x, minY: sw.y, maxX: ne.x, maxY: ne.y };
}

/** EPSG:3857 bounds of tile (z, x, y) — top-origin XYZ. */
export function tileBounds3857(
  z: number,
  x: number,
  y: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const t = (2 * WEB_MERCATOR_EXTENT) / 2 ** z;
  return {
    minX: -WEB_MERCATOR_EXTENT + x * t,
    maxX: -WEB_MERCATOR_EXTENT + (x + 1) * t,
    maxY: WEB_MERCATOR_EXTENT - y * t,
    minY: WEB_MERCATOR_EXTENT - (y + 1) * t,
  };
}

/** WGS84 bounds of tile (z, x, y). */
export function tileBoundsLonLat(z: number, x: number, y: number): Aoi {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const latFromY = (yy: number) => {
    const t = Math.PI * (1 - (2 * yy) / n);
    return (Math.atan(Math.sinh(t)) * 180) / Math.PI;
  };
  return { north: latFromY(y), south: latFromY(y + 1), west, east };
}

/** Ground resolution in meters/pixel at a latitude and zoom (256px tiles). */
export function metersPerPixel(lat: number, z: number): number {
  return (
    (INITIAL_RESOLUTION * Math.cos((clampLat(lat) * Math.PI) / 180)) / 2 ** z
  );
}

/** gpkg_tile_matrix pixel size for zoom z (full-extent GoogleMapsCompatible). */
export function pixelSizeForZoom(z: number): number {
  return INITIAL_RESOLUTION / 2 ** z;
}
