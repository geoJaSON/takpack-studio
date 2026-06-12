/** Minimal typings for the untyped 'mgrs' npm package (proj4js/mgrs). */
declare module "mgrs" {
  /** [lon, lat] → MGRS string. accuracy = digit pairs 0..5 (5 = 1 m). */
  export function forward(
    lonLat: [number, number],
    accuracy?: number,
  ): string;
  /** MGRS string → [west, south, east, north] bbox in degrees. */
  export function inverse(mgrs: string): [number, number, number, number];
  /** MGRS string → [lon, lat] of the square's center. */
  export function toPoint(mgrs: string): [number, number];
}
