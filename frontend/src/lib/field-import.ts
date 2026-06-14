import JSZip from "jszip";
import { parseCoordinateBatch, parseCoordinateInput } from "./coordinates";
import { featuresFromGeoJson } from "./geojson-import";
import type { FeatureStyle, MapFeature, Position } from "../types";

const IMPORT_STROKE = "#ffaa00";

export async function featuresFromFieldFile(
  file: File,
  defaults: { sidc: string },
): Promise<MapFeature[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".kmz")) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const entry = Object.values(zip.files).find(
      (candidate) => !candidate.dir && candidate.name.toLowerCase().endsWith(".kml"),
    );
    if (!entry) throw new Error("KMZ import: no KML document found");
    return featuresFromKml(await entry.async("text"));
  }

  const text = await file.text();
  if (lower.endsWith(".json") || lower.endsWith(".geojson")) {
    return featuresFromGeoJson(text, defaults);
  }
  if (lower.endsWith(".gpx")) return featuresFromGpx(text);
  if (lower.endsWith(".kml")) return featuresFromKml(text);
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) return featuresFromCsv(text);

  // Last-chance importer for Garmin/copied waypoint lists with no useful extension.
  return featuresFromCsv(text);
}

function importedStyle(kind: "marker" | "line" | "polygon"): FeatureStyle {
  const base: FeatureStyle = {
    stroke: IMPORT_STROKE,
    strokeOpacity: 1,
    strokeWidth: 3,
  };
  if (kind === "polygon") return { ...base, fill: IMPORT_STROKE, fillOpacity: 0.2 };
  return base;
}

function markerFeature(name: string, position: Position, remarks?: string): MapFeature {
  return {
    id: crypto.randomUUID(),
    kind: "marker",
    name,
    noteIcon: "pin",
    geometry: { type: "Point", coordinates: position },
    style: importedStyle("marker"),
    ...(remarks ? { remarks } : {}),
  };
}

function lineFeature(
  kind: "line" | "route",
  name: string,
  coordinates: Position[],
  remarks?: string,
): MapFeature | null {
  if (coordinates.length < 2) return null;
  return {
    id: crypto.randomUUID(),
    kind,
    name,
    geometry: { type: "LineString", coordinates },
    style: { ...importedStyle("line"), lineStyle: kind === "route" ? "dashed" : "solid" },
    ...(remarks ? { remarks } : {}),
  };
}

function polygonFeature(name: string, ring: Position[], remarks?: string): MapFeature | null {
  if (ring.length < 3) return null;
  const first = ring[0];
  const last = ring[ring.length - 1];
  const closed =
    first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
  return {
    id: crypto.randomUUID(),
    kind: "polygon",
    name,
    geometry: { type: "Polygon", coordinates: [closed] },
    style: importedStyle("polygon"),
    ...(remarks ? { remarks } : {}),
  };
}

function featuresFromGpx(text: string): MapFeature[] {
  const doc = parseXml(text, "GPX import");
  const out: MapFeature[] = [];

  for (const wpt of Array.from(doc.getElementsByTagName("wpt"))) {
    const position = pointFromLatLonAttrs(wpt);
    if (!position) continue;
    out.push(
      markerFeature(
        childText(wpt, "name") || "GPX waypoint",
        position,
        childText(wpt, "desc") || childText(wpt, "cmt") || undefined,
      ),
    );
  }

  for (const rte of Array.from(doc.getElementsByTagName("rte"))) {
    const pts = Array.from(rte.getElementsByTagName("rtept"))
      .map(pointFromLatLonAttrs)
      .filter((point): point is Position => point !== null);
    const feature = lineFeature("route", childText(rte, "name") || "GPX route", pts);
    if (feature) out.push(feature);
  }

  for (const trk of Array.from(doc.getElementsByTagName("trk"))) {
    const pts = Array.from(trk.getElementsByTagName("trkpt"))
      .map(pointFromLatLonAttrs)
      .filter((point): point is Position => point !== null);
    const feature = lineFeature("line", childText(trk, "name") || "GPX track", pts);
    if (feature) out.push(feature);
  }

  if (out.length === 0) throw new Error("GPX import: no waypoints, routes, or tracks found");
  return out;
}

function featuresFromKml(text: string): MapFeature[] {
  const doc = parseXml(text, "KML import");
  const out: MapFeature[] = [];

  for (const placemark of Array.from(doc.getElementsByTagName("Placemark"))) {
    const name = childText(placemark, "name") || "KML feature";
    const remarks = childText(placemark, "description") || undefined;

    const point = firstDescendant(placemark, "Point");
    const line = firstDescendant(placemark, "LineString");
    const polygon = firstDescendant(placemark, "Polygon");

    if (point) {
      const coords = parseKmlCoordinates(childText(point, "coordinates"));
      if (coords[0]) out.push(markerFeature(name, coords[0], remarks));
    } else if (line) {
      const feature = lineFeature(
        "line",
        name,
        parseKmlCoordinates(childText(line, "coordinates")),
        remarks,
      );
      if (feature) out.push(feature);
    } else if (polygon) {
      const feature = polygonFeature(
        name,
        parseKmlCoordinates(childText(polygon, "coordinates")),
        remarks,
      );
      if (feature) out.push(feature);
    }
  }

  if (out.length === 0) throw new Error("KML import: no Point, LineString, or Polygon placemarks found");
  return out;
}

function featuresFromCsv(text: string): MapFeature[] {
  const rows = parseCsv(text);
  const out: MapFeature[] = [];

  if (rows.length > 1) {
    const headers = rows[0].map((h) => h.trim().toLowerCase());
    const latIdx = findHeader(headers, ["lat", "latitude"]);
    const lonIdx = findHeader(headers, ["lon", "lng", "longitude"]);
    const coordIdx = findHeader(headers, ["coord", "coords", "coordinate", "coordinates", "position"]);
    const nameIdx = findHeader(headers, ["name", "label", "waypoint", "identifier"]);
    const notesIdx = findHeader(headers, ["desc", "description", "comment", "notes", "remarks"]);

    if ((latIdx >= 0 && lonIdx >= 0) || coordIdx >= 0) {
      rows.slice(1).forEach((row, index) => {
        const position =
          coordIdx >= 0
            ? parseCoordinateInput(row[coordIdx] ?? "")
            : parseCoordinateInput(`${row[latIdx]}, ${row[lonIdx]}`);
        if (!position) return;
        out.push(
          markerFeature(
            (nameIdx >= 0 ? row[nameIdx] : "") || `CSV waypoint ${index + 1}`,
            position,
            notesIdx >= 0 ? row[notesIdx] : undefined,
          ),
        );
      });
      if (out.length > 0) return out;
    }
  }

  const parsed = parseCoordinateBatch(text);
  for (const row of parsed.rows) {
    out.push(markerFeature(row.name, row.position, `Imported from line ${row.lineNumber}`));
  }
  if (out.length === 0) {
    throw new Error(parsed.errors[0] ?? "CSV import: no coordinate rows found");
  }
  return out;
}

function parseXml(text: string, context: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const parserError = doc.getElementsByTagName("parsererror")[0];
  if (parserError) throw new Error(`${context}: invalid XML`);
  return doc;
}

function pointFromLatLonAttrs(el: Element): Position | null {
  const lat = Number(el.getAttribute("lat"));
  const lon = Number(el.getAttribute("lon"));
  return validPosition(lon, lat) ? [lon, lat] : null;
}

function parseKmlCoordinates(raw: string): Position[] {
  return raw
    .trim()
    .split(/\s+/)
    .map((tuple) => {
      const [lonRaw, latRaw] = tuple.split(",");
      const lon = Number(lonRaw);
      const lat = Number(latRaw);
      return validPosition(lon, lat) ? ([lon, lat] as Position) : null;
    })
    .filter((point): point is Position => point !== null);
}

function childText(parent: Element, tag: string): string {
  return firstDescendant(parent, tag)?.textContent?.trim() ?? "";
}

function firstDescendant(parent: Element, tag: string): Element | null {
  return parent.getElementsByTagName(tag)[0] ?? null;
}

function validPosition(lon: number, lat: number): boolean {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    Math.abs(lon) <= 180 &&
    Math.abs(lat) <= 90
  );
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (char === "\n") {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  row.push(cell.trim());
  rows.push(row);
  return rows.filter((r) => r.some((c) => c.length > 0));
}

function findHeader(headers: string[], names: string[]): number {
  return headers.findIndex((header) => names.includes(header));
}
