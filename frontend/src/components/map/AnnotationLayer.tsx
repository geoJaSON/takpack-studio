import L from "leaflet";
import type { LeafletMouseEvent, PathOptions } from "leaflet";
import { Circle, Marker, Polygon, Polyline, Tooltip } from "react-leaflet";
import { makeSymbolDivIcon } from "../../lib/milsymbol-utils";
import { useAppStore } from "../../store/use-app-store";
import type { FeatureStyle, MapFeature, Position } from "../../types";

const FALLBACK_SIDC = "SFGPU----------";

function toLatLng(p: Position): [number, number] {
  return [p[1], p[0]];
}

/** Mix a #rrggbb color toward white for the selected highlight. */
function brighten(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const r = mix((v >> 16) & 0xff);
  const g = mix((v >> 8) & 0xff);
  const b = mix(v & 0xff);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/** Leaflet dashArray for a stroke pattern (undefined = solid line). */
function dashArray(style: FeatureStyle): string | undefined {
  const w = Math.max(1, style.strokeWidth);
  switch (style.lineStyle) {
    case "dashed":
      return `${w * 4} ${w * 3}`;
    case "dotted":
      return `${w} ${w * 2}`;
    default:
      return undefined; // solid / outlined render as a solid preview line
  }
}

function pathOptions(f: MapFeature, selected: boolean): PathOptions {
  const fillBase = f.style.fill ?? f.style.stroke;
  return {
    color: selected ? brighten(f.style.stroke, 0.45) : f.style.stroke,
    weight: f.style.strokeWidth + (selected ? 2 : 0),
    opacity: f.style.strokeOpacity,
    fillColor: selected ? brighten(fillBase, 0.45) : fillBase,
    fillOpacity: f.style.fillOpacity ?? 0,
    dashArray: dashArray(f.style),
  };
}

/** Permanent name label for a feature, or null when its label is hidden. */
function nameLabel(
  f: MapFeature,
  direction: "top" | "center",
): React.ReactElement | null {
  if (f.showLabel === false || !f.name) return null;
  return (
    <Tooltip permanent direction={direction} className="feature-label">
      {f.name}
    </Tooltip>
  );
}

/** A standalone text label: a DivIcon with the text, no marker bitmap. */
function makeLabelIcon(text: string, color: string, selected: boolean): L.DivIcon {
  const safe = text.replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
  );
  return L.divIcon({
    className: "map-text-label" + (selected ? " selected" : ""),
    html: `<span style="color:${color}">${safe || "Label"}</span>`,
    iconSize: undefined as unknown as L.PointExpression,
  });
}

/** Renders every store feature; click selects (and stops the map click). */
export default function AnnotationLayer() {
  const features = useAppStore((s) => s.features);
  const selectedFeatureId = useAppStore((s) => s.selectedFeatureId);
  const setSelectedFeatureId = useAppStore((s) => s.setSelectedFeatureId);

  const selectHandlers = (id: string) => ({
    click: (e: LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e);
      setSelectedFeatureId(id);
    },
  });

  return (
    <>
      {features.map((f) => {
        const selected = f.id === selectedFeatureId;

        if (f.kind === "marker" && f.geometry.type === "Point") {
          return (
            <Marker
              key={f.id}
              position={toLatLng(f.geometry.coordinates)}
              icon={makeSymbolDivIcon(f.sidc ?? FALLBACK_SIDC, selected)}
              zIndexOffset={selected ? 1000 : 0}
              eventHandlers={selectHandlers(f.id)}
            >
              {nameLabel(f, "top")}
            </Marker>
          );
        }

        if (f.kind === "label" && f.geometry.type === "Point") {
          return (
            <Marker
              key={f.id}
              position={toLatLng(f.geometry.coordinates)}
              icon={makeLabelIcon(f.name, f.style.stroke, selected)}
              zIndexOffset={selected ? 1000 : 0}
              eventHandlers={selectHandlers(f.id)}
            />
          );
        }

        if (
          (f.kind === "line" || f.kind === "route") &&
          f.geometry.type === "LineString"
        ) {
          return (
            <Polyline
              key={f.id}
              positions={f.geometry.coordinates.map(toLatLng)}
              pathOptions={pathOptions(f, selected)}
              eventHandlers={selectHandlers(f.id)}
            >
              {nameLabel(f, "center")}
            </Polyline>
          );
        }

        if (
          (f.kind === "polygon" || f.kind === "rectangle") &&
          f.geometry.type === "Polygon"
        ) {
          return (
            <Polygon
              key={f.id}
              positions={f.geometry.coordinates.map((ring) => ring.map(toLatLng))}
              pathOptions={pathOptions(f, selected)}
              eventHandlers={selectHandlers(f.id)}
            >
              {nameLabel(f, "center")}
            </Polygon>
          );
        }

        if (f.kind === "circle" && f.geometry.type === "Point") {
          return (
            <Circle
              key={f.id}
              center={toLatLng(f.geometry.coordinates)}
              radius={f.radiusM ?? 100}
              pathOptions={pathOptions(f, selected)}
              eventHandlers={selectHandlers(f.id)}
            >
              {nameLabel(f, "center")}
            </Circle>
          );
        }

        return null;
      })}
    </>
  );
}
