import type { NoteIconType } from "../types.js";

/**
 * ATAK user iconset for note-icon markers. Bundling the iconset (iconset.xml +
 * PNGs) in the package and referencing each icon from a CoT marker via
 * <usericon iconsetpath="<uid>/<group>/<file>"/> makes the note glyph show on
 * the native editable marker (vs. only in a KML overlay). Pure module (no
 * sharp) so cot-writer can import the path helper.
 */

/** Stable across exports so the CoT usericon reference always resolves. */
export const NOTE_ICONSET_UID = "takpack-notes-iconset-0001";
export const NOTE_ICONSET_GROUP = "Notes";

export function noteIconFile(icon: NoteIconType): string {
  return `note-${icon}.png`;
}

/** iconsetpath for a CoT <usericon>: "<uid>/<group>/<filename>". */
export function noteUsericonPath(icon: NoteIconType): string {
  return `${NOTE_ICONSET_UID}/${NOTE_ICONSET_GROUP}/${noteIconFile(icon)}`;
}

/** iconset.xml listing the given note icons (zip places PNGs in the group dir). */
export function buildIconsetXml(icons: NoteIconType[]): string {
  const entries = icons
    .map((i) => `  <icon name="${noteIconFile(i)}"/>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<iconset name="TAKPack Notes" uid="${NOTE_ICONSET_UID}" version="1" defaultGroup="${NOTE_ICONSET_GROUP}" skipResize="false">`,
    entries,
    "</iconset>",
    "",
  ].join("\n");
}
