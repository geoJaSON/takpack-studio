import sharp from "sharp";
import type {
  Aoi,
  FetchPyramidOptions,
  ImageryAdapter,
  ImagerySourceDef,
  PyramidResult,
  SingleImageResult,
} from "../types.js";
import {
  aoiTo3857,
  tileBounds3857,
  tileRangeForAoi,
} from "../export/tile-math.js";
import { fetchBinary, fetchJson } from "./fetch-util.js";
import {
  emptyPyramidFailure,
  sliceMasterToTiles,
  type MercBounds,
} from "./sentinel-pc.js";

const TOKEN_URL =
  "https://services.sentinel-hub.com/auth/realms/main/protocol/openid-connect/token";
const PROCESS_URL = "https://services.sentinel-hub.com/api/v1/process";
/** Processing API hard limit per output dimension. */
const MASTER_MAX_PX = 2500;
const PROCESS_TIMEOUT_MS = 120_000;
const TILE_SIZE = 256;

const TRUE_COLOR_EVALSCRIPT = `//VERSION=3
function setup() {
  return { input: ["B02", "B03", "B04"], output: { bands: 3 } };
}
function evaluatePixel(s) {
  return [2.5 * s.B04, 2.5 * s.B03, 2.5 * s.B02];
}`;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

// Module-level OAuth token cache keyed by the raw 'clientId:clientSecret'
// credential — reused until 60 s before expiry.
const tokenCache = new Map<string, CachedToken>();

/** Test hook: drop cached tokens. */
export function clearTokenCache(): void {
  tokenCache.clear();
}

async function getAccessToken(apiKey: string, signal?: AbortSignal): Promise<string> {
  const cached = tokenCache.get(apiKey);
  const now = Date.now();
  if (cached && cached.expiresAtMs - 60_000 > now) return cached.token;

  const sep = apiKey.indexOf(":");
  if (sep <= 0 || sep === apiKey.length - 1) {
    throw new Error("Sentinel Hub key must be 'clientId:clientSecret'.");
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: apiKey.slice(0, sep),
    client_secret: apiKey.slice(sep + 1),
  }).toString();

  const payload = await fetchJson<{ access_token?: string; expires_in?: number }>(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body,
      timeoutMs: 30_000,
      signal,
    },
  );
  if (!payload?.access_token) {
    throw new Error("Sentinel Hub token request failed — check client id/secret.");
  }
  tokenCache.set(apiKey, {
    token: payload.access_token,
    expiresAtMs: now + (payload.expires_in ?? 3600) * 1000,
  });
  return payload.access_token;
}

/** Processing API true-color S2L2A render of a 3857 bbox, leastCC mosaic. */
async function fetchProcessImage(
  token: string,
  bbox: MercBounds,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  const to = new Date();
  const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
  const body = JSON.stringify({
    input: {
      bounds: {
        properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/3857" },
        bbox: [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY],
      },
      data: [
        {
          type: "sentinel-2-l2a",
          dataFilter: {
            timeRange: { from: from.toISOString(), to: to.toISOString() },
            mosaickingOrder: "leastCC",
            maxCloudCoverage: 40,
          },
        },
      ],
    },
    output: {
      width,
      height,
      responses: [{ identifier: "default", format: { type: "image/jpeg" } }],
    },
    evalscript: TRUE_COLOR_EVALSCRIPT,
  });
  return fetchBinary(PROCESS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "image/jpeg",
    },
    body,
    timeoutMs: PROCESS_TIMEOUT_MS,
    signal,
  });
}

/**
 * Sentinel Hub adapter. Same master-crop → tile-slice approach as the
 * Planetary Computer adapter, but the master is rendered by the Processing
 * API (one request, ≤2500 px per side — zooms finer than the master are
 * interpolated upsamples).
 */
export class SentinelHubAdapter implements ImageryAdapter {
  async fetchPyramid(
    source: ImagerySourceDef,
    aoi: Aoi,
    minZoom: number,
    maxZoom: number,
    format: "jpeg" | "png",
    opts: FetchPyramidOptions,
  ): Promise<PyramidResult> {
    if (!opts.apiKey) {
      throw new Error(`Source '${source.id}' requires an API key ('clientId:clientSecret').`);
    }
    const token = await getAccessToken(opts.apiKey, opts.signal);

    const r = tileRangeForAoi(aoi, maxZoom);
    const nwTb = tileBounds3857(maxZoom, r.minX, r.minY);
    const seTb = tileBounds3857(maxZoom, r.maxX, r.maxY);
    const masterBounds: MercBounds = {
      minX: nwTb.minX,
      maxY: nwTb.maxY,
      maxX: seTb.maxX,
      minY: seTb.minY,
    };
    const fullW = (r.maxX - r.minX + 1) * TILE_SIZE;
    const fullH = (r.maxY - r.minY + 1) * TILE_SIZE;
    const scale = Math.min(1, MASTER_MAX_PX / Math.max(fullW, fullH));
    const width = Math.max(1, Math.round(fullW * scale));
    const height = Math.max(1, Math.round(fullH * scale));

    const master = await fetchProcessImage(token, masterBounds, width, height, opts.signal);
    if (!master) {
      return emptyPyramidFailure(
        aoi,
        minZoom,
        maxZoom,
        "Sentinel Hub: Processing API request failed.",
      );
    }

    const warnings: string[] = [];
    if (scale < 1) {
      warnings.push(
        `Sentinel Hub master render capped at ${MASTER_MAX_PX}px — highest zoom tiles are interpolated upsamples.`,
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
    if (!opts.apiKey) return null;
    const token = await getAccessToken(opts.apiKey, opts.signal);

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

    const data = await fetchProcessImage(token, m, width, height, opts.signal);
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
