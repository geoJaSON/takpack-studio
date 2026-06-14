import * as mgrs from "mgrs";
import type { Position } from "../types";

export type ParsedCoordinateRow = {
  lineNumber: number;
  position: Position;
  name: string;
  remarks?: string;
};

export type CoordinateBatchParseResult = {
  rows: ParsedCoordinateRow[];
  errors: string[];
};

export function parseCoordinateInput(raw: string): Position | null {
  const value = raw.trim();
  if (!value) return null;

  const decimal = parseDecimalPair(value);
  if (decimal) return decimal;

  try {
    const [lon, lat] = mgrs.toPoint(value.toUpperCase().replace(/\s+/g, ""));
    return validPosition(lon, lat) ? [lon, lat] : null;
  } catch {
    return null;
  }
}

export function parseCoordinateBatch(text: string): CoordinateBatchParseResult {
  const rows: ParsedCoordinateRow[] = [];
  const errors: string[] = [];

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    if (looksLikeHeader(line)) return;

    const parsed = parseCoordinateLine(line, rows.length + 1);
    if (parsed) {
      rows.push({ lineNumber, ...parsed });
    } else {
      errors.push(`Line ${lineNumber}: could not find MGRS or decimal coordinates`);
    }
  });

  return { rows, errors };
}

export function destinationPoint(
  start: Position,
  distanceM: number,
  bearingDeg: number,
): Position {
  const radiusM = 6371008.8;
  const [lon1, lat1] = start.map(toRad) as Position;
  const bearing = toRad(bearingDeg);
  const angularDistance = distanceM / radiusM;

  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinDistance = Math.sin(angularDistance);
  const cosDistance = Math.cos(angularDistance);

  const lat2 = Math.asin(
    sinLat1 * cosDistance + cosLat1 * sinDistance * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * sinDistance * cosLat1,
      cosDistance - sinLat1 * Math.sin(lat2),
    );

  return [normalizeLon(toDeg(lon2)), toDeg(lat2)];
}

export function distanceMeters(a: Position, b: Position): number {
  const radiusM = 6371008.8;
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radiusM * Math.asin(Math.sqrt(h));
}

export function initialBearingDeg(a: Position, b: Position): number {
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLon = toRad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function formatDms(position: Position): string {
  const [lon, lat] = position;
  const fmt = (value: number, positive: string, negative: string) => {
    const dir = value >= 0 ? positive : negative;
    const abs = Math.abs(value);
    const deg = Math.floor(abs);
    const minFloat = (abs - deg) * 60;
    const min = Math.floor(minFloat);
    const sec = (minFloat - min) * 60;
    return `${deg}°${String(min).padStart(2, "0")}'${sec.toFixed(2)}"${dir}`;
  };
  return `${fmt(lat, "N", "S")} ${fmt(lon, "E", "W")}`;
}

export function formatUtm(position: Position): string {
  const [lon, lat] = position;
  if (!validPosition(lon, lat) || lat < -80 || lat > 84) return "Outside UTM";

  let zone = Math.floor((lon + 180) / 6) + 1;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
  if (lat >= 72 && lat < 84) {
    if (lon >= 0 && lon < 9) zone = 31;
    else if (lon >= 9 && lon < 21) zone = 33;
    else if (lon >= 21 && lon < 33) zone = 35;
    else if (lon >= 33 && lon < 42) zone = 37;
  }

  const bandLetters = "CDEFGHJKLMNPQRSTUVWX";
  const band = bandLetters[Math.min(Math.max(Math.floor((lat + 80) / 8), 0), 19)];
  const a = 6378137;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = 2 * f - f * f;
  const ep2 = e2 / (1 - e2);
  const latR = toRad(lat);
  const lonR = toRad(lon);
  const lonOrigin = toRad((zone - 1) * 6 - 180 + 3);
  const n = a / Math.sqrt(1 - e2 * Math.sin(latR) ** 2);
  const t = Math.tan(latR) ** 2;
  const c = ep2 * Math.cos(latR) ** 2;
  const aa = Math.cos(latR) * (lonR - lonOrigin);
  const m =
    a *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * latR -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) *
        Math.sin(2 * latR) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * latR) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * latR));

  const easting =
    k0 *
      n *
      (aa +
        ((1 - t + c) * aa ** 3) / 6 +
        ((5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * aa ** 5) / 120) +
    500000;
  let northing =
    k0 *
    (m +
      n *
        Math.tan(latR) *
        (aa ** 2 / 2 +
          ((5 - t + 9 * c + 4 * c ** 2) * aa ** 4) / 24 +
          ((61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * aa ** 6) / 720));
  if (lat < 0) northing += 10000000;

  return `${zone}${band} ${Math.round(easting)}E ${Math.round(northing)}N`;
}

function parseDecimalPair(value: string): Position | null {
  const match = value.match(
    /^\s*([+-]?\d+(?:\.\d+)?)\s*(?:,|\s+)\s*([+-]?\d+(?:\.\d+)?)\s*$/,
  );
  if (!match) return null;

  const a = Number(match[1]);
  const b = Number(match[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  // Prefer common "lat, lon" entry. If the first value cannot be latitude,
  // treat it as "lon, lat" for pasted GeoJSON-style coordinates.
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return [b, a];
  if (Math.abs(a) <= 180 && Math.abs(b) <= 90) return [a, b];
  return null;
}

function parseCoordinateLine(
  line: string,
  rowNumber: number,
): Omit<ParsedCoordinateRow, "lineNumber"> | null {
  const whole = parseCoordinateInput(line);
  if (whole) {
    return { position: whole, name: `Coordinate ${rowNumber}` };
  }

  const mgrsMatch = line.match(
    /\b\d{1,2}[C-HJ-NP-X]\s*[A-HJ-NP-Z]{2}\s*\d{1,5}\s*\d{1,5}\b/i,
  );
  if (mgrsMatch) {
    const position = parseCoordinateInput(mgrsMatch[0]);
    if (position) {
      const name = cleanName(line.replace(mgrsMatch[0], "")) || `Coordinate ${rowNumber}`;
      return { position, name };
    }
  }

  const parts = splitRow(line);
  for (let i = 0; i < parts.length - 1; i++) {
    const position = parseCoordinateInput(`${parts[i]}, ${parts[i + 1]}`);
    if (!position) continue;

    const nameParts = parts.filter((_, idx) => idx !== i && idx !== i + 1);
    const name = cleanName(nameParts.join(" ")) || `Coordinate ${rowNumber}`;
    return { position, name };
  }

  for (let i = 0; i < parts.length; i++) {
    const position = parseCoordinateInput(parts[i]);
    if (!position) continue;
    const name = cleanName(parts.filter((_, idx) => idx !== i).join(" ")) || `Coordinate ${rowNumber}`;
    return { position, name };
  }

  return null;
}

function splitRow(line: string): string[] {
  return line
    .split(/[\t,;|]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function cleanName(value: string): string {
  return value
    .replace(/^[\s,;|\-:]+|[\s,;|\-:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeHeader(line: string): boolean {
  const normalized = line.toLowerCase();
  return (
    normalized.includes("mgrs") ||
    (normalized.includes("lat") && normalized.includes("lon")) ||
    normalized === "name,coordinate" ||
    normalized === "coordinate,name"
  );
}

function validPosition(lon: number, lat: number): boolean {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    Math.abs(lon) <= 180 &&
    Math.abs(lat) <= 90
  );
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

function normalizeLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}
