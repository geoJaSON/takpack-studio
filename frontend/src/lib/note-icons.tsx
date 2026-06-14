import type { ReactElement } from "react";
import type { NoteIconType } from "../types";

export const NOTE_ICONS: ReadonlyArray<{ id: NoteIconType; label: string }> = [
  { id: "pin", label: "Pin" },
  { id: "flag", label: "Flag" },
  { id: "star", label: "Star" },
  { id: "alert", label: "Alert" },
  { id: "info", label: "Info" },
  { id: "camera", label: "Camera" },
  { id: "vehicle", label: "Vehicle" },
  { id: "medical", label: "Medical" },
];

export function noteIconLabel(iconId: NoteIconType): string {
  return NOTE_ICONS.find((icon) => icon.id === iconId)?.label ?? "Note";
}

export function NoteIconGlyph({
  iconId,
  size = 18,
}: {
  iconId: NoteIconType;
  size?: number;
}): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {noteIconGlyph(iconId)}
    </svg>
  );
}

export function noteIconSvg(iconId: NoteIconType, color: string, selected: boolean): string {
  const safeColor = escapeAttr(color);
  const selectedRing = selected
    ? '<circle cx="12" cy="12" r="11" fill="none" stroke="#ffaa00" stroke-width="1.5" stroke-dasharray="3 2"/>'
    : "";
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24">',
    '<filter id="shadow" x="-40%" y="-40%" width="180%" height="180%">',
    '<feDropShadow dx="0" dy="1" stdDeviation="1.2" flood-color="#000" flood-opacity="0.85"/>',
    "</filter>",
    `<g filter="url(#shadow)" fill="${safeColor}22" stroke="${safeColor}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">`,
    noteIconSvgBody(iconId),
    "</g>",
    selectedRing,
    "</svg>",
  ].join("");
}

function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function noteIconGlyph(iconId: NoteIconType): ReactElement | ReactElement[] {
  switch (iconId) {
    case "flag":
      return [
        <path key="pole" d="M6 21V4" />,
        <path key="flag" d="M6 4h11l-2 4 2 4H6" />,
      ];
    case "star":
      return <path d="m12 3 2.7 5.4 6 .9-4.3 4.2 1 5.9L12 16.6 6.6 19.4l1-5.9-4.3-4.2 6-.9z" />;
    case "alert":
      return [
        <path key="tri" d="M12 3 22 20H2z" />,
        <path key="bang" d="M12 9v5" />,
        <path key="dot" d="M12 17h.01" />,
      ];
    case "info":
      return [
        <circle key="c" cx="12" cy="12" r="9" />,
        <path key="i" d="M12 11v5" />,
        <path key="dot" d="M12 8h.01" />,
      ];
    case "camera":
      return [
        <path key="body" d="M4 8h4l1.4-2h5.2L16 8h4v10H4z" />,
        <circle key="lens" cx="12" cy="13" r="3" />,
      ];
    case "vehicle":
      return [
        <path key="body" d="M4 14V9l2-3h10l2 3v5" />,
        <path key="base" d="M3 14h18" />,
        <circle key="w1" cx="7" cy="17" r="2" />,
        <circle key="w2" cx="17" cy="17" r="2" />,
      ];
    case "medical":
      return [
        <circle key="c" cx="12" cy="12" r="9" />,
        <path key="v" d="M12 7v10" />,
        <path key="h" d="M7 12h10" />,
      ];
    case "pin":
      return [
        <path key="pin" d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7z" />,
        <circle key="c" cx="12" cy="9" r="2.5" />,
      ];
  }
}

function noteIconSvgBody(iconId: NoteIconType): string {
  switch (iconId) {
    case "flag":
      return '<path d="M6 21V4"/><path d="M6 4h11l-2 4 2 4H6"/>';
    case "star":
      return '<path d="m12 3 2.7 5.4 6 .9-4.3 4.2 1 5.9L12 16.6 6.6 19.4l1-5.9-4.3-4.2 6-.9z"/>';
    case "alert":
      return '<path d="M12 3 22 20H2z"/><path d="M12 9v5"/><path d="M12 17h.01"/>';
    case "info":
      return '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>';
    case "camera":
      return '<path d="M4 8h4l1.4-2h5.2L16 8h4v10H4z"/><circle cx="12" cy="13" r="3"/>';
    case "vehicle":
      return '<path d="M4 14V9l2-3h10l2 3v5"/><path d="M3 14h18"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>';
    case "medical":
      return '<circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="M7 12h10"/>';
    case "pin":
      return '<path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7z"/><circle cx="12" cy="9" r="2.5"/>';
  }
}
