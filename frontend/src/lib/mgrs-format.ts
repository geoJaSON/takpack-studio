import * as mgrs from "mgrs";

/**
 * Format a WGS84 position as a readable 1 m MGRS string,
 * e.g. "12S VK 12345 67890". Returns an em-dash placeholder for positions
 * with no MGRS representation (polar regions, invalid input).
 */
export function formatMgrs(lat: number, lon: number): string {
  // mgrs.forward returns garbage rather than throwing on non-finite input
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "——";
  try {
    // accuracy 5 → five-digit easting/northing (1 m)
    const raw = mgrs.forward([lon, lat], 5);
    // GZD (1-2 digits + band letter) | 100 km square (2 letters) | 5+5 digits
    const m = /^(\d{1,2}[A-Z])([A-Z]{2})(\d{5})(\d{5})$/.exec(raw);
    if (!m) return raw;
    return `${m[1]} ${m[2]} ${m[3]} ${m[4]}`;
  } catch {
    return "——";
  }
}
