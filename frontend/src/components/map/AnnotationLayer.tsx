import L from "leaflet";
import type { LeafletMouseEvent, PathOptions } from "leaflet";
import { Fragment } from "react";
import { Circle, Marker, Polygon, Polyline, Tooltip, useMap } from "react-leaflet";
import {
  destinationPoint,
  distanceMeters,
  initialBearingDeg,
} from "../../lib/coordinates";
import { makeSymbolDivIcon } from "../../lib/milsymbol-utils";
import { noteIconSvg } from "../../lib/note-icons";
import { useAppStore } from "../../store/use-app-store";
import type { FeatureStyle, MapFeature, NoteIconType, Position } from "../../types";

const FALLBACK_SIDC = "SFGPU----------";
const DEFAULT_FEATURE_LABEL_SIZE = 11;
const DEFAULT_TEXT_LABEL_SIZE = 13;
const MIN_CIRCLE_RADIUS_M = 1;

function toLatLng(p: Position): [number, number] {
  return [p[1], p[0]];
}

function fromMarkerEvent(e: L.LeafletEvent): Position {
  const ll = (e.target as L.Marker).getLatLng().wrap();
  return [ll.lng, ll.lat];
}

function fromLeafletMouseEvent(e: LeafletMouseEvent): Position {
  const ll = e.latlng.wrap();
  return [ll.lng, ll.lat];
}

function useMapDrag() {
  const map = useMap();

  return (e: LeafletMouseEvent, onMove: (position: Position) => void) => {
    L.DomEvent.stop(e.originalEvent);
    map.dragging.disable();

    const onMouseMove = (moveEvent: LeafletMouseEvent) => {
      onMove(fromLeafletMouseEvent(moveEvent));
    };
    const onMouseUp = () => {
      map.off("mousemove", onMouseMove);
      map.dragging.enable();
      window.removeEventListener("mouseup", onMouseUp);
    };

    map.on("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };
}

function samePosition(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function isClosedRing(ring: Position[]): boolean {
  return ring.length > 2 && samePosition(ring[0], ring[ring.length - 1]);
}

function editableRingVertices(ring: Position[]): Position[] {
  return isClosedRing(ring) ? ring.slice(0, -1) : ring;
}

function centroid(points: Position[]): Position {
  if (points.length === 0) return [0, 0];
  const sum = points.reduce(
    (acc, p) => [acc[0] + p[0], acc[1] + p[1]] as Position,
    [0, 0],
  );
  return [sum[0] / points.length, sum[1] / points.length];
}

function movePosition(p: Position, delta: Position): Position {
  return [p[0] + delta[0], p[1] + delta[1]];
}

function rotatePosition(p: Position, anchor: Position, deltaDeg: number): Position {
  if (samePosition(p, anchor)) return p;
  const distanceM = distanceMeters(anchor, p);
  if (distanceM <= 0) return p;
  return destinationPoint(anchor, distanceM, initialBearingDeg(anchor, p) + deltaDeg);
}

function polygonEditAnchor(f: MapFeature): { anchor: Position; keepAnchor: boolean } | null {
  if (f.geometry.type !== "Polygon" || f.geometry.coordinates.length === 0) return null;
  const ring = editableRingVertices(f.geometry.coordinates[0]);
  if (ring.length === 0) return null;
  const isSector = /^Sector\b/i.test(f.remarks ?? "");
  return {
    anchor: isSector ? ring[0] : centroid(ring),
    keepAnchor: isSector,
  };
}

function rotationHandlePosition(f: MapFeature): Position | null {
  if (f.geometry.type !== "Polygon") return null;
  const anchorInfo = polygonEditAnchor(f);
  if (!anchorInfo) return null;
  const ring = editableRingVertices(f.geometry.coordinates[0]);
  let farthest: Position | null = null;
  let maxDistance = 0;
  for (const p of ring) {
    const d = distanceMeters(anchorInfo.anchor, p);
    if (d > maxDistance) {
      maxDistance = d;
      farthest = p;
    }
  }
  if (!farthest || maxDistance <= 0) return null;
  const bearing = initialBearingDeg(anchorInfo.anchor, farthest);
  return destinationPoint(
    anchorInfo.anchor,
    maxDistance + Math.max(35, maxDistance * 0.18),
    bearing,
  );
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
  const fontSize = labelSize(f, DEFAULT_FEATURE_LABEL_SIZE);
  return (
    <Tooltip permanent direction={direction} className="feature-label">
      <span style={{ fontSize }}>{f.name}</span>
    </Tooltip>
  );
}

/** A standalone text label: a DivIcon with the text, no marker bitmap. */
function makeLabelIcon(
  text: string,
  color: string,
  selected: boolean,
  fontSize: number,
): L.DivIcon {
  const safe = text.replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
  );
  return L.divIcon({
    className: "map-text-label" + (selected ? " selected" : ""),
    html: `<span style="color:${color};font-size:${fontSize}px">${safe || "Label"}</span>`,
    iconSize: undefined as unknown as L.PointExpression,
  });
}

function makeNoteIcon(f: MapFeature, selected: boolean): L.DivIcon {
  const iconId = (f.noteIcon ?? "pin") as NoteIconType;
  return L.divIcon({
    className: "map-note-icon" + (selected ? " selected" : ""),
    html: noteIconSvg(iconId, f.style.stroke, selected),
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function labelSize(f: MapFeature, fallback: number): number {
  const size = f.style.labelSize ?? fallback;
  return Math.max(8, Math.min(48, Number.isFinite(size) ? size : fallback));
}

function editHandleIcon(kind: "vertex" | "move" | "resize" | "rotate"): L.DivIcon {
  const label = kind === "rotate" ? "R" : "";
  return L.divIcon({
    className: `feature-edit-handle ${kind}`,
    html: `<span>${label}</span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function EditHandles({ feature }: { feature: MapFeature }) {
  const updateFeature = useAppStore((s) => s.updateFeature);
  const setSelectedFeatureId = useAppStore((s) => s.setSelectedFeatureId);
  const startMapDrag = useMapDrag();

  const stopHandlers = {
    click: (e: LeafletMouseEvent) => L.DomEvent.stopPropagation(e),
  };

  if (
    (feature.kind === "line" || feature.kind === "route") &&
    feature.geometry.type === "LineString"
  ) {
    const coordinates: Position[] = feature.geometry.coordinates;
    const center = centroid(coordinates);
    return (
      <>
        <Marker
          position={toLatLng(center)}
          icon={editHandleIcon("move")}
          zIndexOffset={1800}
          eventHandlers={{
            ...stopHandlers,
            mousedown: (e) => {
              setSelectedFeatureId(feature.id);
              const start = fromLeafletMouseEvent(e);
              startMapDrag(e, (position) => {
                const delta: Position = [
                  position[0] - start[0],
                  position[1] - start[1],
                ];
                updateFeature(feature.id, {
                  geometry: {
                    type: "LineString",
                    coordinates: coordinates.map((p) => movePosition(p, delta)),
                  },
                });
              });
            },
          }}
        />
        {coordinates.map((point, index) => (
          <Marker
            key={`${feature.id}-v-${index}`}
            position={toLatLng(point)}
            icon={editHandleIcon("vertex")}
            zIndexOffset={1900}
            eventHandlers={{
              ...stopHandlers,
              mousedown: (e) => {
                setSelectedFeatureId(feature.id);
                startMapDrag(e, (position) => {
                  const next = [...coordinates];
                  next[index] = position;
                  updateFeature(feature.id, {
                    geometry: { type: "LineString", coordinates: next },
                  });
                });
              },
            }}
          />
        ))}
      </>
    );
  }

  if (
    (feature.kind === "polygon" || feature.kind === "rectangle") &&
    feature.geometry.type === "Polygon"
  ) {
    const rings = feature.geometry.coordinates;
    const outerRing = editableRingVertices(rings[0] ?? []);
    const moveCenter = centroid(outerRing);
    const rotateHandle = rotationHandlePosition(feature);
    const anchorInfo = polygonEditAnchor(feature);
    return (
      <>
        {outerRing.length > 0 && (
          <Marker
            position={toLatLng(moveCenter)}
            icon={editHandleIcon("move")}
            zIndexOffset={1800}
            eventHandlers={{
              ...stopHandlers,
              mousedown: (e) => {
                setSelectedFeatureId(feature.id);
                const start = fromLeafletMouseEvent(e);
                startMapDrag(e, (position) => {
                  const delta: Position = [
                    position[0] - start[0],
                    position[1] - start[1],
                  ];
                  updateFeature(feature.id, {
                    geometry: {
                      type: "Polygon",
                      coordinates: rings.map((ring) =>
                        ring.map((p) => movePosition(p, delta)),
                      ),
                    },
                  });
                });
              },
            }}
          />
        )}

        {rotateHandle && anchorInfo && (
          <Marker
            position={toLatLng(rotateHandle)}
            icon={editHandleIcon("rotate")}
            zIndexOffset={1850}
            eventHandlers={{
              ...stopHandlers,
              mousedown: (e) => {
                setSelectedFeatureId(feature.id);
                const startBearing = initialBearingDeg(
                  anchorInfo.anchor,
                  fromLeafletMouseEvent(e),
                );
                startMapDrag(e, (position) => {
                  const delta =
                    initialBearingDeg(anchorInfo.anchor, position) - startBearing;
                  updateFeature(feature.id, {
                    geometry: {
                      type: "Polygon",
                      coordinates: rings.map((ring) =>
                        ring.map((p) =>
                          anchorInfo.keepAnchor &&
                          samePosition(p, anchorInfo.anchor)
                            ? p
                            : rotatePosition(p, anchorInfo.anchor, delta),
                        ),
                      ),
                    },
                  });
                });
              },
            }}
          />
        )}

        {rings.map((ring, ringIndex) =>
          editableRingVertices(ring).map((point, vertexIndex) => (
            <Marker
              key={`${feature.id}-r-${ringIndex}-v-${vertexIndex}`}
              position={toLatLng(point)}
              icon={editHandleIcon("vertex")}
              zIndexOffset={1900}
              eventHandlers={{
                ...stopHandlers,
                mousedown: (e) => {
                  setSelectedFeatureId(feature.id);
                  startMapDrag(e, (position) => {
                    const nextRings = rings.map((r) => [...r]);
                    const closed = isClosedRing(nextRings[ringIndex]);
                    nextRings[ringIndex][vertexIndex] = position;
                    if (closed && vertexIndex === 0) {
                      nextRings[ringIndex][nextRings[ringIndex].length - 1] =
                        position;
                    }
                    updateFeature(feature.id, {
                      geometry: { type: "Polygon", coordinates: nextRings },
                    });
                  });
                },
              }}
            />
          )),
        )}
      </>
    );
  }

  if (feature.kind === "circle" && feature.geometry.type === "Point") {
    const center = feature.geometry.coordinates;
    const radiusM = Math.max(MIN_CIRCLE_RADIUS_M, feature.radiusM ?? 100);
    const resizePoint = destinationPoint(center, radiusM, 90);
    return (
      <>
        <Marker
          position={toLatLng(center)}
          icon={editHandleIcon("move")}
          zIndexOffset={1800}
          eventHandlers={{
            ...stopHandlers,
            mousedown: (e) => {
              setSelectedFeatureId(feature.id);
              startMapDrag(e, (position) =>
                updateFeature(feature.id, {
                  geometry: { type: "Point", coordinates: position },
                }),
              );
            },
          }}
        />
        <Marker
          position={toLatLng(resizePoint)}
          icon={editHandleIcon("resize")}
          zIndexOffset={1900}
          eventHandlers={{
            ...stopHandlers,
            mousedown: (e) => {
              setSelectedFeatureId(feature.id);
              startMapDrag(e, (position) => {
                updateFeature(feature.id, {
                  radiusM: Math.max(
                    MIN_CIRCLE_RADIUS_M,
                    Math.round(distanceMeters(center, position)),
                  ),
                });
              });
            },
          }}
        />
      </>
    );
  }

  return null;
}

/** Renders every store feature; click selects (and stops the map click). */
export default function AnnotationLayer() {
  const features = useAppStore((s) => s.features);
  const selectedFeatureId = useAppStore((s) => s.selectedFeatureId);
  const setSelectedFeatureId = useAppStore((s) => s.setSelectedFeatureId);
  const updateFeature = useAppStore((s) => s.updateFeature);
  const startMapDrag = useMapDrag();

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
              icon={
                f.noteIcon
                  ? makeNoteIcon(f, selected)
                  : makeSymbolDivIcon(f.sidc ?? FALLBACK_SIDC, selected)
              }
              zIndexOffset={selected ? 1000 : 0}
              eventHandlers={{
                ...selectHandlers(f.id),
                mousedown: (e) => {
                  setSelectedFeatureId(f.id);
                  startMapDrag(e, (position) =>
                    updateFeature(f.id, {
                      geometry: { type: "Point", coordinates: position },
                    }),
                  );
                },
              }}
            >
              {nameLabel(f, "top")}
            </Marker>
          );
        }

        if (f.kind === "label" && f.geometry.type === "Point") {
          if (f.showLabel === false) return null;
          return (
            <Marker
              key={f.id}
              position={toLatLng(f.geometry.coordinates)}
              icon={makeLabelIcon(
                f.name,
                f.style.stroke,
                selected,
                labelSize(f, DEFAULT_TEXT_LABEL_SIZE),
              )}
              zIndexOffset={selected ? 1000 : 0}
              eventHandlers={{
                ...selectHandlers(f.id),
                mousedown: (e) => {
                  setSelectedFeatureId(f.id);
                  startMapDrag(e, (position) =>
                    updateFeature(f.id, {
                      geometry: { type: "Point", coordinates: position },
                    }),
                  );
                },
              }}
            />
          );
        }

        if (
          (f.kind === "line" || f.kind === "route") &&
          f.geometry.type === "LineString"
        ) {
          return (
            <Fragment key={f.id}>
              <Polyline
                positions={f.geometry.coordinates.map(toLatLng)}
                pathOptions={pathOptions(f, selected)}
                eventHandlers={selectHandlers(f.id)}
              >
                {nameLabel(f, "center")}
              </Polyline>
              {selected && <EditHandles feature={f} />}
            </Fragment>
          );
        }

        if (
          (f.kind === "polygon" || f.kind === "rectangle") &&
          f.geometry.type === "Polygon"
        ) {
          return (
            <Fragment key={f.id}>
              <Polygon
                positions={f.geometry.coordinates.map((ring) => ring.map(toLatLng))}
                pathOptions={pathOptions(f, selected)}
                eventHandlers={selectHandlers(f.id)}
              >
                {nameLabel(f, "center")}
              </Polygon>
              {selected && <EditHandles feature={f} />}
            </Fragment>
          );
        }

        if (f.kind === "circle" && f.geometry.type === "Point") {
          return (
            <Fragment key={f.id}>
              <Circle
                center={toLatLng(f.geometry.coordinates)}
                radius={f.radiusM ?? 100}
                pathOptions={pathOptions(f, selected)}
                eventHandlers={selectHandlers(f.id)}
              >
                {nameLabel(f, "center")}
              </Circle>
              {selected && <EditHandles feature={f} />}
            </Fragment>
          );
        }

        return null;
      })}
    </>
  );
}
