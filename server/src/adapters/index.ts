import type { FetchStrategy, ImageryAdapter } from "../types.js";
import { XyzAdapter } from "./xyz.js";
import { ArcgisExportAdapter } from "./arcgis-export.js";
import { StacSentinel2Adapter } from "./sentinel-pc.js";
import { SentinelHubAdapter } from "./sentinel-hub.js";

/**
 * Adapter registry by fetch strategy. 'planet' has no adapter on purpose:
 * Planet basemaps are stream-only (in-app preview via the OAuth proxy routes)
 * and must never be packaged offline.
 */
export const ADAPTERS: Partial<Record<FetchStrategy, ImageryAdapter>> = {
  xyz: new XyzAdapter(),
  "arcgis-export": new ArcgisExportAdapter(),
  "stac-sentinel2": new StacSentinel2Adapter(),
  "sentinel-hub": new SentinelHubAdapter(),
};
