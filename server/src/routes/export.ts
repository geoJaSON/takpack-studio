import { Router, type IRouter } from "express";
import { z } from "zod";
import { countTiles } from "../export/tile-math.js";
import type { ExportQueue } from "../jobs/queue.js";
import type { ExportRequest, ImagerySourceDef, Limits } from "../types.js";

export interface ExportRouteDeps {
  catalog: ImagerySourceDef[];
  limits: Limits;
  queue: ExportQueue;
}

// Slightly looser than MAX_MERC_LAT so a UI-snapped 85.06 still validates.
const MAX_LAT = 85.06;
const MAX_FEATURES = 2000;

// [lon, lat] — bounded so out-of-range coordinates (e.g. from an imported
// GeoJSON file) are rejected at the boundary instead of failing the job later.
const positionSchema = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
]);

const geometrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Point"), coordinates: positionSchema }),
  z.object({
    type: z.literal("LineString"),
    coordinates: z.array(positionSchema).min(2),
  }),
  z.object({
    type: z.literal("Polygon"),
    coordinates: z.array(z.array(positionSchema).min(3)).min(1),
  }),
]);

const styleSchema = z.object({
  stroke: z.string(),
  strokeOpacity: z.number().min(0).max(1),
  strokeWidth: z.number().min(0),
  fill: z.string().optional(),
  fillOpacity: z.number().min(0).max(1).optional(),
});

/** Geometry type each feature kind requires (mirrors the writer invariants). */
const KIND_GEOMETRY = {
  marker: "Point",
  circle: "Point",
  line: "LineString",
  route: "LineString",
  polygon: "Polygon",
  rectangle: "Polygon",
} as const;

const featureSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(["marker", "line", "route", "polygon", "rectangle", "circle"]),
    name: z.string(),
    sidc: z.string().optional(),
    affiliation: z.enum(["friendly", "hostile", "neutral", "unknown"]).optional(),
    geometry: geometrySchema,
    radiusM: z.number().positive().optional(),
    style: styleSchema,
    remarks: z.string().optional(),
  })
  .superRefine((f, ctx) => {
    // Cross-field invariants the CoT/KML writers enforce with throws — reject
    // here with a 400 instead of failing the job after the imagery fetch.
    const expected = KIND_GEOMETRY[f.kind];
    if (f.geometry.type !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["geometry", "type"],
        message: `kind '${f.kind}' requires ${expected} geometry`,
      });
    }
    if (f.kind === "circle" && f.radiusM === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["radiusM"],
        message: "radiusM is required for circle features",
      });
    }
  });

const aoiSchema = z
  .object({
    north: z.number().min(-MAX_LAT).max(MAX_LAT),
    south: z.number().min(-MAX_LAT).max(MAX_LAT),
    east: z.number().min(-180).max(180),
    west: z.number().min(-180).max(180),
  })
  .superRefine((aoi, ctx) => {
    if (!(aoi.north > aoi.south)) {
      ctx.addIssue({
        code: "custom",
        message: "aoi.north must be greater than aoi.south",
      });
    }
    if (!(aoi.east > aoi.west)) {
      ctx.addIssue({
        code: "custom",
        message: "aoi.east must be greater than aoi.west",
      });
    }
  });

const imagerySchema = z
  .object({
    sourceId: z.string().min(1),
    mode: z.enum(["gpkg", "kmz-grg"]),
    minZoom: z.number().int().min(0).max(24),
    maxZoom: z.number().int().min(0).max(24),
    tileFormat: z.enum(["jpeg", "png"]),
    apiKey: z.string().optional(),
    planConfirmed: z.boolean().optional(),
  })
  .superRefine((img, ctx) => {
    if (img.minZoom > img.maxZoom) {
      ctx.addIssue({
        code: "custom",
        message: "imagery.minZoom must not exceed imagery.maxZoom",
      });
    }
  });

const exportRequestSchema = z.object({
  packageName: z.string().min(1).max(64),
  aoi: aoiSchema,
  features: z
    .array(featureSchema)
    .max(MAX_FEATURES)
    .superRefine((features, ctx) => {
      // Feature id becomes the CoT uid AND the zip entry path — duplicates
      // would silently overwrite one another on import.
      const seen = new Set<string>();
      for (const [i, f] of features.entries()) {
        if (seen.has(f.id)) {
          ctx.addIssue({
            code: "custom",
            path: [i, "id"],
            message: `duplicate feature id: ${f.id}`,
          });
        }
        seen.add(f.id);
      }
    }),
  imagery: imagerySchema.optional(),
  mapSourceXmlIds: z.array(z.string()).default([]),
  includeKeyInXml: z.boolean().optional(),
  includeKmlOverlay: z.boolean().optional(),
});

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
}

export function exportRouter(deps: ExportRouteDeps): IRouter {
  const router = Router();

  router.post("/export", (req, res) => {
    const parsed = exportRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatIssues(parsed.error) });
      return;
    }
    const request: ExportRequest = parsed.data;

    if (request.imagery) {
      const imagery = request.imagery;
      const source = deps.catalog.find((s) => s.id === imagery.sourceId);
      if (!source) {
        res
          .status(400)
          .json({ error: `unknown imagery source: ${imagery.sourceId}` });
        return;
      }
      if (source.streamOnly) {
        res
          .status(400)
          .json({ error: "stream-only source cannot be packaged offline" });
        return;
      }
      if (source.offlineRequiresPlanCheck && !imagery.planConfirmed) {
        res.status(400).json({
          error: `${source.name} requires confirmation that your plan permits offline use (planConfirmed)`,
        });
        return;
      }
      if (imagery.minZoom < source.minZoom || imagery.maxZoom > source.maxZoom) {
        res.status(400).json({
          error: `zoom range ${imagery.minZoom}-${imagery.maxZoom} is outside source bounds ${source.minZoom}-${source.maxZoom}`,
        });
        return;
      }
      const tiles = countTiles(request.aoi, imagery.minZoom, imagery.maxZoom);
      if (tiles > deps.limits.maxTilesPerExport) {
        res.status(400).json({
          error: `export requires ${tiles} tiles, exceeding the limit of ${deps.limits.maxTilesPerExport} — shrink the AOI or zoom range`,
        });
        return;
      }
    }

    const job = deps.queue.enqueue(request);
    res.status(202).json({ jobId: job.id });
  });

  return router;
}
