import type { FeatureStyle, MapFeature, Position } from "../types";

/**
 * Convert GeoJSON text into MapFeatures. Accepts a FeatureCollection, a
 * single Feature, or a bare Geometry. Points → markers (default SIDC),
 * LineStrings → lines, Polygons → polygons; Multi* geometries are flattened
 * into one feature per part. Throws Error with a useful message on invalid
 * input.
 */
export function featuresFromGeoJson(
  text: string,
  defaults: { sidc: string },
): MapFeature[] {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `GeoJSON import: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!isRecord(root) || typeof root.type !== "string") {
    throw new Error(
      'GeoJSON import: expected an object with a string "type" property',
    );
  }

  const out: MapFeature[] = [];
  if (root.type === "FeatureCollection") {
    if (!Array.isArray(root.features)) {
      throw new Error(
        'GeoJSON import: FeatureCollection is missing its "features" array',
      );
    }
    root.features.forEach((f, i) => importFeature(f, `features[${i}]`, out, defaults));
  } else if (root.type === "Feature") {
    importFeature(root, "feature", out, defaults);
  } else {
    importGeometry(root, undefined, "geometry", out, defaults);
  }

  if (out.length === 0) {
    throw new Error(
      "GeoJSON import: no importable Point/LineString/Polygon geometries found",
    );
  }
  return out;
}

// ───────────────────────────── internals ─────────────────────────────

const IMPORT_STROKE = "#ffaa00";

function importedStyle(kind: "marker" | "line" | "polygon"): FeatureStyle {
  const base: FeatureStyle = {
    stroke: IMPORT_STROKE,
    strokeOpacity: 1,
    strokeWidth: 3,
  };
  if (kind === "polygon") {
    return { ...base, fill: IMPORT_STROKE, fillOpacity: 0.2 };
  }
  return base;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function nameFrom(
  properties: Record<string, unknown> | undefined,
  fallback: string,
): string {
  const n = properties?.name;
  return typeof n === "string" && n.trim() !== "" ? n : fallback;
}

function asPosition(v: unknown, ctx: string): Position {
  if (
    Array.isArray(v) &&
    v.length >= 2 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number" &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1])
  ) {
    return [v[0], v[1]];
  }
  throw new Error(`GeoJSON import: invalid coordinate pair in ${ctx}`);
}

function asLine(v: unknown, ctx: string): Position[] {
  if (!Array.isArray(v) || v.length < 2) {
    throw new Error(
      `GeoJSON import: ${ctx} needs an array of at least 2 positions`,
    );
  }
  return v.map((p) => asPosition(p, ctx));
}

function asRings(v: unknown, ctx: string): Position[][] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(`GeoJSON import: ${ctx} needs at least one ring`);
  }
  return v.map((ring, i) => {
    if (!Array.isArray(ring) || ring.length < 4) {
      throw new Error(
        `GeoJSON import: ${ctx} ring ${i} needs at least 4 positions (closed ring)`,
      );
    }
    return ring.map((p) => asPosition(p, `${ctx} ring ${i}`));
  });
}

function importFeature(
  raw: unknown,
  ctx: string,
  out: MapFeature[],
  defaults: { sidc: string },
): void {
  if (!isRecord(raw) || raw.type !== "Feature") {
    throw new Error(`GeoJSON import: ${ctx} is not a Feature object`);
  }
  if (raw.geometry === null || raw.geometry === undefined) return; // null-geometry features are legal; skip
  const properties = isRecord(raw.properties) ? raw.properties : undefined;
  importGeometry(raw.geometry, properties, `${ctx}.geometry`, out, defaults);
}

function importGeometry(
  raw: unknown,
  properties: Record<string, unknown> | undefined,
  ctx: string,
  out: MapFeature[],
  defaults: { sidc: string },
): void {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    throw new Error(`GeoJSON import: ${ctx} is not a geometry object`);
  }

  switch (raw.type) {
    case "Point":
      out.push({
        id: crypto.randomUUID(),
        kind: "marker",
        name: nameFrom(properties, "Imported point"),
        sidc: defaults.sidc,
        geometry: { type: "Point", coordinates: asPosition(raw.coordinates, ctx) },
        style: importedStyle("marker"),
      });
      break;

    case "MultiPoint": {
      if (!Array.isArray(raw.coordinates)) {
        throw new Error(`GeoJSON import: ${ctx} has no coordinates array`);
      }
      raw.coordinates.forEach((c, i) =>
        importGeometry(
          { type: "Point", coordinates: c },
          properties,
          `${ctx}[${i}]`,
          out,
          defaults,
        ),
      );
      break;
    }

    case "LineString":
      out.push({
        id: crypto.randomUUID(),
        kind: "line",
        name: nameFrom(properties, "Imported line"),
        geometry: { type: "LineString", coordinates: asLine(raw.coordinates, ctx) },
        style: importedStyle("line"),
      });
      break;

    case "MultiLineString": {
      if (!Array.isArray(raw.coordinates)) {
        throw new Error(`GeoJSON import: ${ctx} has no coordinates array`);
      }
      raw.coordinates.forEach((c, i) =>
        importGeometry(
          { type: "LineString", coordinates: c },
          properties,
          `${ctx}[${i}]`,
          out,
          defaults,
        ),
      );
      break;
    }

    case "Polygon":
      out.push({
        id: crypto.randomUUID(),
        kind: "polygon",
        name: nameFrom(properties, "Imported polygon"),
        geometry: { type: "Polygon", coordinates: asRings(raw.coordinates, ctx) },
        style: importedStyle("polygon"),
      });
      break;

    case "MultiPolygon": {
      if (!Array.isArray(raw.coordinates)) {
        throw new Error(`GeoJSON import: ${ctx} has no coordinates array`);
      }
      raw.coordinates.forEach((c, i) =>
        importGeometry(
          { type: "Polygon", coordinates: c },
          properties,
          `${ctx}[${i}]`,
          out,
          defaults,
        ),
      );
      break;
    }

    case "GeometryCollection": {
      if (!Array.isArray(raw.geometries)) {
        throw new Error(`GeoJSON import: ${ctx} has no geometries array`);
      }
      raw.geometries.forEach((g, i) =>
        importGeometry(g, properties, `${ctx}.geometries[${i}]`, out, defaults),
      );
      break;
    }

    default:
      // Unsupported geometry type — skip rather than fail the whole import.
      break;
  }
}
