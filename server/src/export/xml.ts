/** XML + color helpers shared by every export writer. */

/** Escape a string for use in XML text content or attribute values. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 255, g: 255, b: 255 };
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 1));
}

/**
 * KML color: aabbggrr hex (alpha, blue, green, red — NOT rgb order).
 * The #1 KML styling bug is emitting rrggbb order; don't.
 */
export function kmlColor(hex: string, opacity: number): string {
  const { r, g, b } = parseHex(hex);
  const a = Math.round(clamp01(opacity) * 255);
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `${h(a)}${h(b)}${h(g)}${h(r)}`;
}

/**
 * CoT color: signed 32-bit two's-complement int of 0xAARRGGBB
 * (e.g. opaque red #ff0000 @1.0 → -65536).
 */
export function argbColor(hex: string, opacity: number): number {
  const { r, g, b } = parseHex(hex);
  const a = Math.round(clamp01(opacity) * 255);
  // | 0 coerces to signed 32-bit
  return ((a << 24) | (r << 16) | (g << 8) | b) | 0;
}
