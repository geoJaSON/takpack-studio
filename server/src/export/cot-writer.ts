import { randomUUID } from "node:crypto";
import type {
  Affiliation,
  CotFile,
  MapFeature,
  Medevac9Line,
  Position,
  WriterDeterminism,
} from "../types.js";
import { argbColor, esc, fmtCoord } from "./xml.js";
import { medevacLines } from "./comms-docs.js";
import { noteUsericonPath } from "./iconset.js";

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

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/** Great-circle distance in meters between two [lon,lat] points (haversine). */
function haversineMeters(a: Position, b: Position): number {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial true bearing a→b in degrees, normalized to [0,360). */
function initialBearingDeg(a: Position, b: Position): number {
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLon = toRad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Signed 32-bit ARGB int (ATAK <color value="…"> form) from "#rrggbb". */
function argbInt(hex: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  const rgb = m ? parseInt(m[1], 16) : 0xffffff;
  return (0xff000000 | rgb) | 0; // | 0 → signed (e.g. white → -1)
}

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

function markerColorLine(f: MapFeature): string {
  const color = argbColor(f.style.stroke, f.style.strokeOpacity);
  return `    <color argb="${color}" value="${color}"/>`;
}

function eventXml(
  f: MapFeature,
  type: string,
  point: Position,
  time: string,
  stale: string,
  detailLines: string[],
  how = "h-g-i-g-o",
): string {
  const [lon, lat] = point;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<event version="2.0" uid="${esc(f.id)}" type="${esc(type)}" how="${esc(how)}" time="${time}" start="${time}" stale="${stale}">`,
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
        const detail = [markerColorLine(f)];
        // Note-icon markers reference the bundled iconset so the chosen glyph
        // shows on the native (editable) marker instead of a generic icon.
        if (f.noteIcon) {
          detail.push(
            `    <usericon iconsetpath="${esc(noteUsericonPath(f.noteIcon))}"/>`,
          );
        }
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
        const detail = [markerColorLine(f)];
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
        // Range & Bearing: a 2-point line flagged rangeBearing exports as a
        // native u-rb-a arrow. Endpoints aren't separate markers, so (matching
        // ATAK's own serializer) anchorUID/rangeUID are omitted and ATAK rebuilds
        // the endpoints from point + range + bearing on import.
        const line = requireLine(f);
        if (f.rangeBearing && line.length === 2) {
          const [anchor, end] = line;
          const range = haversineMeters(anchor, end);
          const bearing = initialBearingDeg(anchor, end);
          const detail = [
            `    <range value="${range.toFixed(4)}"/>`,
            `    <bearing value="${bearing.toFixed(4)}"/>`,
            '    <inclination value="0.0"/>',
            '    <rangeUnits value="1"/>',
            '    <bearingUnits value="0"/>',
            '    <northRef value="0"/>',
            `    <color value="${argbInt(f.style.stroke)}"/>`,
            ...(f.showLabel === false ? [] : [labelsLine(f)]),
          ];
          out.push({
            uid: f.id,
            xml: eventXml(f, "u-rb-a", anchor, time, stale, detail, "h-e"),
          });
          break;
        }
        // OPEN u-d-f polyline: distinct vertices (first != last), no fill.
        const verts = openRing(line);
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

/** Formatted 9-line text for the CASEVAC marker remarks / medline_remarks. */
function medevacRemarks(m: Medevac9Line): string {
  return medevacLines(m)
    .filter((l) => l.value.trim())
    .map((l) => `${l.label}: ${l.value}`)
    .join("\n");
}

/**
 * Build a CASEVAC 9-line CoT marker (type b-r-f-h-c) carrying a `<_medevac_>`
 * detail so ATAK recognizes it as a CASEVAC. freq + callsign + location
 * pre-fill; the full 9 lines also travel in remarks/medline_remarks so they
 * are readable even if a field name differs across ATAK versions.
 */
export function buildCasevacEvent(
  medevac: Medevac9Line,
  fallbackCenter: { lat: number; lon: number },
  determinism?: WriterDeterminism,
): CotFile {
  const now = determinism?.now ? determinism.now() : new Date();
  const uid = (determinism?.uuid ?? randomUUID)();
  const time = now.toISOString();
  const stale = isoPlusOneYear(now);
  const lat = typeof medevac.lat === "number" ? medevac.lat : fallbackCenter.lat;
  const lon = typeof medevac.lon === "number" ? medevac.lon : fallbackCenter.lon;
  const callsign = medevac.callsign?.trim() || "CASEVAC";
  const remarks = medevacRemarks(medevac);
  const medAttrs = [
    'casevac="true"',
    `title="${esc(callsign)}"`,
    ...(medevac.freq?.trim() ? [`freq="${esc(medevac.freq.trim())}"`] : []),
    ...(remarks ? [`medline_remarks="${esc(remarks)}"`] : []),
  ].join(" ");
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<event version="2.0" uid="${esc(uid)}" type="b-r-f-h-c" how="h-g-i-g-o" time="${time}" start="${time}" stale="${stale}">`,
    `  <point lat="${fmtCoord(lat)}" lon="${fmtCoord(lon)}" hae="9999999.0" ce="9999999.0" le="9999999.0"/>`,
    "  <detail>",
    `    <contact callsign="${esc(callsign)}"/>`,
    `    <remarks>${esc(remarks)}</remarks>`,
    "    <archive/>",
    `    <_medevac_ ${medAttrs}/>`,
    "  </detail>",
    "</event>",
    "",
  ].join("\n");
  return { uid, xml };
}
