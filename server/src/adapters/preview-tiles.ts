/**
 * Live-preview tile proxies for sources that have no direct XYZ template:
 *  - arcgis-export  → one ArcGIS `exportImage` request per 256px tile
 *  - stac-sentinel2 → Microsoft Planetary Computer mosaic tiler (XYZ)
 *
 * These back the `/api/preview/tile/...` route so the map can show NAIP and
 * Sentinel-2 as ordinary tile layers. Export still uses the real adapters.
 */
import { fetchBinary, fetchJson } from "./fetch-util.js";
import { tileBounds3857 } from "../export/tile-math.js";
import type { ImagerySourceDef } from "../types.js";

/** One ArcGIS ImageServer/MapServer tile via exportImage at the tile's bbox. */
export async function fetchArcgisTile(
  source: ImagerySourceDef,
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  if (!source.exportUrlBase) return null;
  const b = tileBounds3857(z, x, y);
  const endpoint = source.exportUrlBase.includes("ImageServer")
    ? "exportImage"
    : "export";
  const url =
    `${source.exportUrlBase}/${endpoint}?bbox=${b.minX},${b.minY},${b.maxX},${b.maxY}` +
    `&bboxSR=3857&imageSR=3857&size=256,256&format=jpgpng&transparent=true&f=image`;
  return fetchBinary(url, { timeoutMs: 15_000, signal });
}

// ── Sentinel-2 via Planetary Computer mosaic tiler ───────────────────────────

const PC_MOSAIC = "https://planetarycomputer.microsoft.com/api/data/v1/mosaic";
const PC_SEARCH_TTL_MS = 30 * 60 * 1000;
const PC_TILE_QUERY =
  "collection=sentinel-2-l2a&assets=visual&asset_bidx=visual%7C1%2C2%2C3";

let pcSearch: { id: string; at: number } | null = null;

/** Register (and cache) a low-cloud Sentinel-2 L2A mosaic; returns its hash. */
async function pcSearchId(signal?: AbortSignal): Promise<string | null> {
  if (pcSearch && Date.now() - pcSearch.at < PC_SEARCH_TTL_MS) return pcSearch.id;
  const body = JSON.stringify({
    collections: ["sentinel-2-l2a"],
    "filter-lang": "cql2-json",
    filter: { op: "<=", args: [{ property: "eo:cloud_cover" }, 10] },
    sortby: [{ field: "properties.eo:cloud_cover", direction: "asc" }],
  });
  const json = await fetchJson<{ searchid?: string }>(`${PC_MOSAIC}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    timeoutMs: 15_000,
    signal,
  });
  if (!json?.searchid) return null;
  pcSearch = { id: json.searchid, at: Date.now() };
  return json.searchid;
}

/** One Sentinel-2 mosaic tile; re-registers once if the cached search expired. */
export async function fetchSentinelTile(
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  const tileUrl = (id: string) =>
    `${PC_MOSAIC}/${id}/tiles/WebMercatorQuad/${z}/${x}/${y}?${PC_TILE_QUERY}`;
  const id = await pcSearchId(signal);
  if (!id) return null;
  let buf = await fetchBinary(tileUrl(id), { timeoutMs: 20_000, signal });
  if (!buf) {
    pcSearch = null; // search hash may have been evicted — register again
    const fresh = await pcSearchId(signal);
    if (fresh) buf = await fetchBinary(tileUrl(fresh), { timeoutMs: 20_000, signal });
  }
  return buf;
}
