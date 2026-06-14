import type {
  Affiliation,
  CotFile,
  MapFeature,
  Position,
  WriterDeterminism,
} from "../types.js";
import { argbColor, esc, fmtCoord } from "./xml.js";

/** Area-fill alpha when a fill color is set but opacity was left undefined. */
const DEFAULT_FILL_OPACITY = 0.25;

/**
 * Map a MIL-STD-2525C 15-char SIDC to a CoT atom type:
 * `a-{affiliation}-{battleDimension}{-fn...}`.
 * Affiliation = SIDC[1] mapped {F,A,D,M,J,K→f; H,S→h; N,L→n; else→u};
 * battle dimension = SIDC[2] (Z→G fallback); function chars = SIDC[4..9]
 * stopping at the first '-', each emitted as '-X'.
 * Example: SFGPUCI----K--- → a-f-G-U-C-I.
 */
export function sidcToCotType(sidc: string): string {
  const s = sidc.toUpperCase();
  const affChar = s.charAt(1);
  let aff = "u";
  if (affChar !== "") {
    if ("FADMJK".includes(affChar)) aff = "f";
    else if ("HS".includes(affChar)) aff = "h";
    else if ("NL".includes(affChar)) aff = "n";
  }
  let bd = s.charAt(2) === "" ? "Z" : s.charAt(2);
  if (bd === "Z") bd = "G";
  let fn = "";
  for (let i = 4; i <= 9 && i < s.length; i++) {
    const c = s.charAt(i);
    if (c === "-") break;
    fn += `-${c}`;
  }
  return `a-${aff}-${bd}${fn}`;
}

/** Generic ground-unit fallback when a marker carries no SIDC. */
const AFFILIATION_TYPE: Record<Affiliation, string> = {
  friendly: "a-f-G",
  hostile: "a-h-G",
  neutral: "a-n-G",
  unknown: "a-u-G",
};

function isoPlusOneYear(d: Date): string {
  const stale = new Date(d.getTime());
  stale.setUTCFullYear(stale.getUTCFullYear() + 1);
  return stale.toISOString();
}

function requirePoint(f: MapFeature): Position {
  if (f.geometry.type !== "Point") {
    throw new Error(`feature ${f.id} (${f.kind}): expected Point geometry`);
  }
  return f.geometry.coordinates;
}

function requireLine(f: MapFeature): Position[] {
  if (f.geometry.type !== "LineString" || f.geometry.coordinates.length === 0) {
    throw new Error(
      `feature ${f.id} (${f.kind}): expected non-empty LineString geometry`,
    );
  }
  return f.geometry.coordinates;
}

function requireExteriorRing(f: MapFeature): Position[] {
  if (
    f.geometry.type !== "Polygon" ||
    f.geometry.coordinates.length === 0 ||
    f.geometry.coordinates[0].length === 0
  ) {
    throw new Error(
      `feature ${f.id} (${f.kind}): expected non-empty Polygon geometry`,
    );
  }
  return f.geometry.coordinates[0];
}

/**
 * Close a ring for CoT: ATAK (EditablePolyline.setPoints) marks a u-d-f shape
 * CLOSED only when there are >2 links and the first link point equals the last.
 * So a filled polygon MUST repeat its first vertex as the final link.
 */
function closedRing(ring: Position[]): Position[] {
  if (ring.length < 3) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

/** Open polyline: first link must NOT equal the last, or ATAK closes it. */
function openRing(ring: Position[]): Position[] {
  if (ring.length > 1) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  }
  return ring;
}

const DASH_STYLES = new Set(["dashed", "dotted", "outlined"]);
/** <strokeStyle> value — ATAK accepts solid|dashed|dotted|outlined (v4.5.1+). */
function strokeStyleValue(f: MapFeature): string {
  const ls = f.style.lineStyle ?? "solid";
  return DASH_STYLES.has(ls) ? ls : "solid";
}

/** strokeColor + strokeWeight + strokeStyle (shared by every shape and line). */
function strokeLines(f: MapFeature): string[] {
  return [
    `    <strokeColor value="${argbColor(f.style.stroke, f.style.strokeOpacity)}"/>`,
    `    <strokeWeight value="${String(f.style.strokeWidth)}"/>`,
    `    <strokeStyle value="${strokeStyleValue(f)}"/>`,
  ];
}

/** fillColor — only honored by ATAK on CLOSED shapes; omit for open lines. */
function fillLine(f: MapFeature): string {
  // A chosen fill color with no explicit opacity defaults to visible; only a
  // feature with no fill color at all is fully transparent.
  const fillOpacity =
    f.style.fill !== undefined
      ? f.style.fillOpacity ?? DEFAULT_FILL_OPACITY
      : f.style.fillOpacity ?? 0;
  return `    <fillColor value="${argbColor(f.style.fill ?? f.style.stroke, fillOpacity)}"/>`;
}

/** Show/hide the shape's name on the shape (ATAK default is hidden). */
function labelsLine(f: MapFeature): string {
  return `    <labels_on value="${f.showLabel === false ? "false" : "true"}"/>`;
}

function eventXml(
  f: MapFeature,
  type: string,
  point: Position,
  time: string,
  stale: string,
  detailLines: string[],
): string {
  const [lon, lat] = point;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<event version="2.0" uid="${esc(f.id)}" type="${esc(type)}" how="h-g-i-g-o" time="${time}" start="${time}" stale="${stale}">`,
    `  <point lat="${fmtCoord(lat)}" lon="${fmtCoord(lon)}" hae="9999999.0" ce="9999999.0" le="9999999.0"/>`,
    "  <detail>",
    `    <contact callsign="${esc(f.name)}"/>`,
    `    <remarks>${esc(f.remarks ?? "")}</remarks>`,
    "    <archive/>",
    ...detailLines,
    "  </detail>",
    "</event>",
    "",
  ].join("\n");
}

/**
 * One CoT event per exportable feature. Kind 'line' is an overlay graphic and
 * produces NO CoT (KML only). Feature.id is the event uid.
 */
export function buildCotEvents(
  features: MapFeature[],
  determinism?: WriterDeterminism,
): CotFile[] {
  const now = determinism?.now ? determinism.now() : new Date();
  const time = now.toISOString();
  const stale = isoPlusOneYear(now);
  const out: CotFile[] = [];

  for (const f of features) {
    switch (f.kind) {
      case "marker": {
        const point = requirePoint(f);
        const type = f.sidc
          ? sidcToCotType(f.sidc)
          : AFFILIATION_TYPE[f.affiliation ?? "unknown"];
        const detail = [
          `    <color argb="${argbColor(f.style.stroke, f.style.strokeOpacity)}"/>`,
        ];
        // Marker labels show by default; <hideLabel/> suppresses the callsign.
        if (f.showLabel === false) detail.push("    <hideLabel/>");
        out.push({ uid: f.id, xml: eventXml(f, type, point, time, stale, detail) });
        break;
      }

      case "label": {
        // Text-only label: a spot marker whose callsign is the text. ATAK shows
        // a marker's callsign as the on-map label by default (there is no
        // icon-less label CoT — the KML overlay carries the clean text version).
        const point = requirePoint(f);
        const detail = [
          `    <color argb="${argbColor(f.style.stroke, f.style.strokeOpacity)}"/>`,
        ];
        out.push({
          uid: f.id,
          xml: eventXml(f, "b-m-p-s-m", point, time, stale, detail),
        });
        break;
      }

      case "polygon":
      case "rectangle": {
        // CLOSED u-d-f: links repeat the first vertex so ATAK fills the shape.
        const ring = closedRing(requireExteriorRing(f));
        const detail = [
          ...ring.map(
            ([lon, lat]) =>
              `    <link point="${fmtCoord(lat)},${fmtCoord(lon)},0.0"/>`,
          ),
          ...strokeLines(f),
          fillLine(f),
          labelsLine(f),
        ];
        out.push({
          uid: f.id,
          xml: eventXml(f, "u-d-f", ring[0], time, stale, detail),
        });
        break;
      }

      case "line": {
        // OPEN u-d-f polyline: distinct vertices (first != last), no fill.
        const verts = openRing(requireLine(f));
        const detail = [
          ...verts.map(
            ([lon, lat]) =>
              `    <link point="${fmtCoord(lat)},${fmtCoord(lon)},0.0"/>`,
          ),
          ...strokeLines(f),
          labelsLine(f),
        ];
        out.push({
          uid: f.id,
          xml: eventXml(f, "u-d-f", verts[0], time, stale, detail),
        });
        break;
      }

      case "circle": {
        const center = requirePoint(f);
        if (f.radiusM === undefined) {
          throw new Error(`feature ${f.id} (circle): radiusM is required`);
        }
        const r = String(f.radiusM);
        const detail = [
          `    <shape><ellipse major="${r}" minor="${r}" angle="360"/></shape>`,
          ...strokeLines(f),
          fillLine(f),
          labelsLine(f),
        ];
        out.push({
          uid: f.id,
          xml: eventXml(f, "u-d-c", center, time, stale, detail),
        });
        break;
      }

      case "route": {
        const verts = requireLine(f);
        const color = argbColor(f.style.stroke, f.style.strokeOpacity);
        const detail = [
          ...verts.map(
            ([lon, lat], i) =>
              `    <link uid="${esc(f.id)}.${i}" callsign="" type="b-m-p-w" point="${fmtCoord(lat)},${fmtCoord(lon)},0.0" remarks="" relation="c"/>`,
          ),
          `    <link_attr planningmethod="Infil" color="${color}" method="Driving" prefix="CP" type="On Foot" stroke="${String(f.style.strokeWidth)}"/>`,
          `    <strokeStyle value="${strokeStyleValue(f)}"/>`,
          labelsLine(f),
        ];
        out.push({
          uid: f.id,
          xml: eventXml(f, "b-m-r", verts[0], time, stale, detail),
        });
        break;
      }
    }
  }
  return out;
}
