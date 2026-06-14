import { Router, type IRouter } from "express";
import {
  fetchArcgisTile,
  fetchSentinelTile,
} from "../adapters/preview-tiles.js";
import type {
  Aoi,
  FetchStrategy,
  ImageryAdapter,
  ImagerySourceDef,
} from "../types.js";

export interface PreviewRouteDeps {
  catalog: ImagerySourceDef[];
  adapters: Partial<Record<FetchStrategy, ImageryAdapter>>;
}

const PREVIEW_MAX_PX = 1024;
const PREVIEWABLE_STRATEGIES: ReadonlySet<FetchStrategy> = new Set([
  "arcgis-export",
  "stac-sentinel2",
  "sentinel-hub",
]);

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function queryNumber(value: unknown): number | undefined {
  const s = queryString(value);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function previewRouter(deps: PreviewRouteDeps): IRouter {
  const router = Router();

  router.get("/preview/aoi-image", async (req, res) => {
    const sourceId = queryString(req.query.sourceId);
    const n = queryNumber(req.query.n);
    const s = queryNumber(req.query.s);
    const e = queryNumber(req.query.e);
    const w = queryNumber(req.query.w);
    const key = queryString(req.query.key);

    if (!sourceId || n === undefined || s === undefined || e === undefined || w === undefined) {
      res
        .status(400)
        .json({ error: "sourceId, n, s, e, w query parameters are required" });
      return;
    }
    if (!(n > s) || !(e > w) || Math.abs(n) > 85.06 || Math.abs(s) > 85.06 || w < -180 || e > 180) {
      res.status(400).json({ error: "invalid AOI bounds" });
      return;
    }

    const source = deps.catalog.find((src) => src.id === sourceId);
    if (!source) {
      res.status(400).json({ error: `unknown imagery source: ${sourceId}` });
      return;
    }
    if (!PREVIEWABLE_STRATEGIES.has(source.strategy)) {
      res.status(400).json({
        error: "AOI preview is only available for arcgis-export and Sentinel-2 sources",
      });
      return;
    }
    const adapter = deps.adapters[source.strategy];
    if (!adapter?.fetchSingleImage) {
      res
        .status(400)
        .json({ error: "preview not supported for this source" });
      return;
    }

    const aoi: Aoi = { north: n, south: s, east: e, west: w };
    try {
      const image = await adapter.fetchSingleImage(source, aoi, PREVIEW_MAX_PX, {
        apiKey: key,
      });
      if (!image) {
        res.status(502).json({ error: "no imagery available for this AOI" });
        return;
      }
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-store");
      res.send(image.data);
    } catch (err) {
      let message = err instanceof Error ? err.message : String(err);
      if (key) message = message.split(key).join("[redacted]");
      res.status(502).json({ error: `preview fetch failed: ${message}` });
    }
  });

  // Single 256px XYZ tile for sources with no direct tile template (NAIP,
  // Sentinel-2) so the map can preview them as an ordinary tile layer.
  router.get("/preview/tile/:sourceId/:z/:x/:y", async (req, res) => {
    const source = deps.catalog.find((s) => s.id === req.params.sourceId);
    if (!source) {
      res.status(404).end();
      return;
    }
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    const n = 2 ** z;
    if (
      !Number.isInteger(z) || z < 0 || z > 24 ||
      !Number.isInteger(x) || x < 0 || x >= n ||
      !Number.isInteger(y) || y < 0 || y >= n
    ) {
      res.status(400).end();
      return;
    }
    try {
      let buf: Buffer | null = null;
      if (source.strategy === "arcgis-export") {
        buf = await fetchArcgisTile(source, z, x, y);
      } else if (source.strategy === "stac-sentinel2") {
        buf = await fetchSentinelTile(z, x, y);
      } else {
        res.status(400).end();
        return;
      }
      if (!buf || buf.length === 0) {
        res.status(204).end(); // no imagery here — Leaflet shows nothing
        return;
      }
      res.setHeader("Content-Type", buf[0] === 0x89 ? "image/png" : "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(buf);
    } catch {
      res.status(502).end();
    }
  });

  return router;
}
