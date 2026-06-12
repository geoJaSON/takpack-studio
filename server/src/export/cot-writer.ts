import type {
  Affiliation,
  CotFile,
  MapFeature,
  Position,
  WriterDeterminism,
} from "../types.js";
import { argbColor, esc } from "./xml.js";

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

/** CoT shape links must NOT repeat the first vertex — drop a closing vertex. */
function unclosedRing(ring: Position[]): Position[] {
  if (ring.length > 1) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  }
  return ring;
}

function shapeStyleLines(f: MapFeature): string[] {
  const stroke = argbColor(f.style.stroke, f.style.strokeOpacity);
  // No fill specified ⇒ fully transparent fill of the stroke color.
  const fill = argbColor(f.style.fill ?? f.style.stroke, f.style.fillOpacity ?? 0);
  return [
    `    <strokeColor value="${stroke}"/>`,
    `    <strokeWeight value="${String(f.style.strokeWidth)}"/>`,
    `    <fillColor value="${fill}"/>`,
  ];
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
    `  <point lat="${String(lat)}" lon="${String(lon)}" hae="9999999.0" ce="9999999.0" le="9999999.0"/>`,
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
      case "line":
        continue; // lines are KML-only overlay graphics

      case "marker": {
        const point = requirePoint(f);
        const type = f.sidc
          ? sidcToCotType(f.sidc)
          : AFFILIATION_TYPE[f.affiliation ?? "unknown"];
        const detail = [
          `    <color argb="${argbColor(f.style.stroke, f.style.strokeOpacity)}"/>`,
        ];
        out.push({ uid: f.id, xml: eventXml(f, type, point, time, stale, detail) });
        break;
      }

      case "polygon":
      case "rectangle": {
        const ring = unclosedRing(requireExteriorRing(f));
        const detail = [
          ...ring.map(
            ([lon, lat]) =>
              `    <link point="${String(lat)},${String(lon)},0.0"/>`,
          ),
          ...shapeStyleLines(f),
          '    <labels_on value="true"/>',
        ];
        const type = f.kind === "rectangle" ? "u-d-r" : "u-d-f";
        out.push({
          uid: f.id,
          xml: eventXml(f, type, ring[0], time, stale, detail),
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
          ...shapeStyleLines(f),
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
              `    <link uid="${esc(f.id)}.${i}" callsign="" type="b-m-p-w" point="${String(lat)},${String(lon)},0.0" remarks="" relation="c"/>`,
          ),
          `    <link_attr planningmethod="Infil" color="${color}" method="Driving" prefix="CP" type="On Foot" stroke="${String(f.style.strokeWidth)}"/>`,
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
