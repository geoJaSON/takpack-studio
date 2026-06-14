import sharp from "sharp";
import type { NoteIconType } from "../types.js";

/**
 * Server-side note-icon glyphs, rasterized to PNGs for the bundled ATAK
 * iconset (so note-icon markers show the glyph on the native CoT marker).
 * Drawn white-on-dark-outline so they read on any basemap.
 */

const GLYPHS: Record<NoteIconType, string> = {
  pin: '<path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7z"/><circle cx="12" cy="9" r="2.5"/>',
  flag: '<path d="M6 21V4"/><path d="M6 4h11l-2 4 2 4H6"/>',
  star: '<path d="m12 3 2.7 5.4 6 .9-4.3 4.2 1 5.9L12 16.6 6.6 19.4l1-5.9-4.3-4.2 6-.9z"/>',
  alert: '<path d="M12 3 22 20H2z"/><path d="M12 9v5"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  camera: '<path d="M4 8h4l1.4-2h5.2L16 8h4v10H4z"/><circle cx="12" cy="13" r="3"/>',
  vehicle: '<path d="M4 14V9l2-3h10l2 3v5"/><path d="M3 14h18"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>',
  medical: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="M7 12h10"/>',
};

function noteIconSvg(icon: NoteIconType): string {
  // White fill + dark outline so the glyph is legible on light or dark maps.
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24">',
    '<g fill="#ffffff" stroke="#15171a" stroke-width="2"',
    ' stroke-linecap="round" stroke-linejoin="round">',
    GLYPHS[icon],
    "</g></svg>",
  ].join("");
}

/** Rasterize a note glyph to a 64px PNG for the bundled iconset. */
export async function renderNoteIconPng(icon: NoteIconType): Promise<Buffer> {
  return sharp(Buffer.from(noteIconSvg(icon))).png().toBuffer();
}
