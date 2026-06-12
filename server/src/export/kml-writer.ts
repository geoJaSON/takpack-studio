import type { MapFeature, Position } from "../types.js";
import { esc, kmlColor } from "./xml.js";

/** Meters per degree of latitude (spherical approximation, per port source). */
const METERS_PER_DEG_LAT = 111320;

/**
 * Tessellate a circle (center lon/lat, radius meters) into a closed ring of
 * `segments` + 1 points — last point is an exact copy of the first.
 */
export function circleRing(
  center: Position,
  radiusM: number,
  segments = 64,
): Position[] {
  const [lon, lat] = center;
  const ring: Position[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = ((i * 360) / segments) * (Math.PI / 180);
    const dLat = (radiusM / METERS_PER_DEG_LAT) * Math.cos(angle);
    const dLon =
      (radiusM / (METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180))) *
      Math.sin(angle);
    ring.push([lon + dLon, lat + dLat]);
  }
  // Math.sin(2π) !== 0 exactly, so close by copying the first vertex.
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

function coordString(coords: Position[]): string {
  return coords.map(([lon, lat]) => `${String(lon)},${String(lat)},0`).join(" ");
}

/** KML LinearRings must be closed — append the first vertex if needed. */
function closedRing(ring: Position[]): Position[] {
  if (ring.length === 0) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, [first[0], first[1]]];
}

function requirePoint(f: MapFeature): Position {
  if (f.geometry.type !== "Point") {
    throw new Error(`feature ${f.id} (${f.kind}): expected Point geometry`);
  }
  return f.geometry.coordinates;
}

function requireLine(f: MapFeature): Position[] {
  if (f.geometry.type !== "LineString") {
    throw new Error(`feature ${f.id} (${f.kind}): expected LineString geometry`);
  }
  return f.geometry.coordinates;
}

function requirePolygon(f: MapFeature): Position[][] {
  if (f.geometry.type !== "Polygon" || f.geometry.coordinates.length === 0) {
    throw new Error(
      `feature ${f.id} (${f.kind}): expected non-empty Polygon geometry`,
    );
  }
  return f.geometry.coordinates;
}

function lineStyle(f: MapFeature): string {
  const c = kmlColor(f.style.stroke, f.style.strokeOpacity);
  return `        <LineStyle><color>${c}</color><width>${String(f.style.strokeWidth)}</width></LineStyle>`;
}

function polyStyle(f: MapFeature): string {
  // No fill specified ⇒ fully transparent fill of the stroke color.
  const c = kmlColor(f.style.fill ?? f.style.stroke, f.style.fillOpacity ?? 0);
  return `        <PolyStyle><color>${c}</color></PolyStyle>`;
}

function polygonLines(rings: Position[][]): string[] {
  const [exterior, ...holes] = rings;
  const lines = [
    "      <Polygon>",
    `        <outerBoundaryIs><LinearRing><coordinates>${coordString(closedRing(exterior))}</coordinates></LinearRing></outerBoundaryIs>`,
  ];
  for (const hole of holes) {
    lines.push(
      `        <innerBoundaryIs><LinearRing><coordinates>${coordString(closedRing(hole))}</coordinates></LinearRing></innerBoundaryIs>`,
    );
  }
  lines.push("      </Polygon>");
  return lines;
}

function featureParts(f: MapFeature): { style: string[]; geom: string[] } {
  switch (f.kind) {
    case "marker": {
      const c = kmlColor(f.style.stroke, f.style.strokeOpacity);
      return {
        style: [`        <IconStyle><color>${c}</color><scale>1.1</scale></IconStyle>`],
        geom: [
          `      <Point><coordinates>${coordString([requirePoint(f)])}</coordinates></Point>`,
        ],
      };
    }
    case "line":
    case "route":
      return {
        style: [lineStyle(f)],
        geom: [
          `      <LineString><tessellate>1</tessellate><coordinates>${coordString(requireLine(f))}</coordinates></LineString>`,
        ],
      };
    case "polygon":
    case "rectangle":
      return {
        style: [lineStyle(f), polyStyle(f)],
        geom: polygonLines(requirePolygon(f)),
      };
    case "circle": {
      if (f.radiusM === undefined) {
        throw new Error(`feature ${f.id} (circle): radiusM is required`);
      }
      return {
        style: [lineStyle(f), polyStyle(f)],
        geom: polygonLines([circleRing(requirePoint(f), f.radiusM)]),
      };
    }
  }
}

function placemarkLines(f: MapFeature): string[] {
  const { style, geom } = featureParts(f);
  const lines = ["    <Placemark>", `      <name>${esc(f.name)}</name>`];
  if (f.remarks) {
    lines.push(`      <description>${esc(f.remarks)}</description>`);
  }
  lines.push("      <Style>", ...style, "      </Style>", ...geom, "    </Placemark>");
  return lines;
}

/**
 * Styled KML overlay of ALL features (markers included). No NetworkLink, no
 * Region/LOD — ATAK ignores them. All user strings escaped. `description`
 * (attribution/license text per the licensing policy) is emitted as the
 * Document description when provided.
 */
export function buildKmlDocument(
  name: string,
  features: MapFeature[],
  description?: string,
): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    "  <Document>",
    `    <name>${esc(name)}</name>`,
  ];
  if (description !== undefined && description.length > 0) {
    lines.push(`    <description>${esc(description)}</description>`);
  }
  for (const f of features) lines.push(...placemarkLines(f));
  lines.push("  </Document>", "</kml>", "");
  return lines.join("\n");
}
