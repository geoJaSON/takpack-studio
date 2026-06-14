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
// Keep MAX_ATTACHMENTS * MAX_ATTACHMENT_BASE64_CHARS under the JSON body limit
// (app.ts express.json) so a valid request can't be rejected by the body cap.
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BASE64_CHARS = 8_000_000;
const MAX_DTED_CELLS = 9;
const noteIconSchema = z.enum([
  "pin",
  "flag",
  "star",
  "alert",
  "info",
  "camera",
  "vehicle",
  "medical",
]);

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
  lineStyle: z.enum(["solid", "dashed", "dotted", "outlined"]).optional(),
  fill: z.string().optional(),
  fillOpacity: z.number().min(0).max(1).optional(),
  labelSize: z.number().min(8).max(48).optional(),
});

/** Geometry type each feature kind requires (mirrors the writer invariants). */
const KIND_GEOMETRY = {
  marker: "Point",
  label: "Point",
  circle: "Point",
  line: "LineString",
  route: "LineString",
  polygon: "Polygon",
  rectangle: "Polygon",
} as const;

const featureSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum([
      "marker",
      "label",
      "line",
      "route",
      "polygon",
      "rectangle",
      "circle",
    ]),
    name: z.string(),
    sidc: z.string().optional(),
    affiliation: z.enum(["friendly", "hostile", "neutral", "unknown"]).optional(),
    noteIcon: noteIconSchema.optional(),
    geometry: geometrySchema,
    radiusM: z.number().positive().optional(),
    style: styleSchema,
    remarks: z.string().optional(),
    showLabel: z.boolean().optional(),
    rangeBearing: z.boolean().optional(),
    attachments: z
      .array(
        z.object({
          name: z.string().min(1).max(160),
          contentType: z.string().max(120).optional(),
          base64: z.string().min(1).max(MAX_ATTACHMENT_BASE64_CHARS),
        }),
      )
      .max(4)
      .optional(),
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
    if (f.noteIcon !== undefined && f.kind !== "marker") {
      ctx.addIssue({
        code: "custom",
        path: ["noteIcon"],
        message: "noteIcon is only valid for marker features",
      });
    }
    if (f.rangeBearing) {
      // u-rb-a is a single anchor→endpoint arrow; only a 2-point line maps to it.
      const twoPointLine =
        f.kind === "line" &&
        f.geometry.type === "LineString" &&
        f.geometry.coordinates.length === 2;
      if (!twoPointLine) {
        ctx.addIssue({
          code: "custom",
          path: ["rangeBearing"],
          message: "rangeBearing requires a 2-point line feature",
        });
      }
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

const attachmentSchema = z.object({
  name: z.string().min(1).max(160),
  contentType: z.string().max(120).optional(),
  base64: z.string().min(1).max(MAX_ATTACHMENT_BASE64_CHARS),
});

// ── comms plan ──
const commsNetSchema = z.object({
  name: z.string().max(120).default(""),
  frequency: z.string().max(120).default(""),
  callsign: z.string().max(120).default(""),
  notes: z.string().max(400).optional(),
});
const pacePlanSchema = z.object({
  primary: z.string().max(400).default(""),
  alternate: z.string().max(400).default(""),
  contingency: z.string().max(400).default(""),
  emergency: z.string().max(400).default(""),
});
const commsIdentitySchema = z.object({
  callsign: z.string().max(60).optional(),
  team: z.string().max(40).optional(),
  role: z.string().max(40).optional(),
  serverHost: z.string().max(255).optional(),
  serverPort: z.string().max(10).optional(),
  serverProto: z.enum(["ssl", "tcp"]).optional(),
  serverName: z.string().max(120).optional(),
});
const medevacSchema = z.object({
  location: z.string().max(200).optional(),
  freq: z.string().max(120).optional(),
  callsign: z.string().max(120).optional(),
  precedence: z.string().max(200).optional(),
  equipment: z.string().max(200).optional(),
  patientType: z.string().max(200).optional(),
  security: z.string().max(200).optional(),
  marking: z.string().max(200).optional(),
  nationality: z.string().max(200).optional(),
  terrain: z.string().max(300).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
});
const commsPlanSchema = z.object({
  nets: z.array(commsNetSchema).max(20).optional(),
  pace: pacePlanSchema.optional(),
  identity: commsIdentitySchema.optional(),
  medevac: medevacSchema.optional(),
  notes: z.string().max(2000).optional(),
});
const supportDocIdSchema = z.enum(["comms", "pace", "medevac", "checklist"]);

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
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).optional(),
  includeMissionBrief: z.boolean().optional(),
  commsPlan: commsPlanSchema.optional(),
  supportDocIds: z.array(supportDocIdSchema).max(8).optional(),
  includePref: z.boolean().optional(),
  includeCasevacMarker: z.boolean().optional(),
  includeElevation: z.boolean().optional(),
  elevationLevel: z.union([z.literal(1), z.literal(2)]).optional(),
})
  .superRefine((req, ctx) => {
    if (!req.includeElevation) return;
    // One 1°×1° DTED cell per integer-degree square; cap so a package can't
    // balloon (DTED2 cell ≈ 26MB).
    let cells = 0;
    for (let lat = Math.floor(req.aoi.south); lat < Math.ceil(req.aoi.north); lat++) {
      for (let lon = Math.floor(req.aoi.west); lon < Math.ceil(req.aoi.east); lon++) {
        cells++;
      }
    }
    if (cells > MAX_DTED_CELLS) {
      ctx.addIssue({
        code: "custom",
        path: ["includeElevation"],
        message: `elevation AOI spans ${cells} DTED cells (max ${MAX_DTED_CELLS}) — shrink the AOI`,
      });
    }
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
