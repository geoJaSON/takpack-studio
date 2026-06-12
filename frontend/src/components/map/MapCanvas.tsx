import { useEffect, useMemo, useRef, useState } from "react";
import {
  CircleMarker,
  MapContainer,
  Polygon,
  Polyline,
  Rectangle,
  TileLayer,
  Tooltip,
  ZoomControl,
  useMapEvents,
} from "react-leaflet";
import { getStoredKey, useAppStore } from "../../store/use-app-store";
import { BASEMAPS } from "../../types";
import type {
  Affiliation,
  FeatureKind,
  FeatureStyle,
  Geometry,
  MapFeature,
  Position,
} from "../../types";
import AnnotationLayer from "./AnnotationLayer";

// ───────────────────────── feature creation helpers ─────────────────────────

const KIND_LABEL: Record<FeatureKind, string> = {
  marker: "Marker",
  line: "Line",
  route: "Route",
  polygon: "Polygon",
  rectangle: "Rectangle",
  circle: "Circle",
};

function nextName(existing: MapFeature[], kind: FeatureKind): string {
  const n = existing.filter((f) => f.kind === kind).length + 1;
  return `${KIND_LABEL[kind]} ${n}`;
}

function defaultStyle(kind: FeatureKind): FeatureStyle {
  switch (kind) {
    case "line":
    case "route":
      return { stroke: "#00e5ff", strokeOpacity: 1, strokeWidth: 3 };
    case "polygon":
    case "rectangle":
      return {
        stroke: "#ffaa00",
        strokeOpacity: 1,
        strokeWidth: 2,
        fill: "#ffaa00",
        fillOpacity: 0.15,
      };
    case "circle":
      return {
        stroke: "#ff5577",
        strokeOpacity: 1,
        strokeWidth: 2,
        fill: "#ff5577",
        fillOpacity: 0.1,
      };
    case "marker":
      return { stroke: "#ffaa00", strokeOpacity: 1, strokeWidth: 2 };
  }
}

function buildFeature(
  kind: FeatureKind,
  geometry: Geometry,
  existing: MapFeature[],
  extra: Partial<MapFeature> = {},
): MapFeature {
  return {
    id: crypto.randomUUID(),
    kind,
    name: nextName(existing, kind),
    geometry,
    style: defaultStyle(kind),
    ...extra,
  };
}

const AFFILIATION_CHAR: Record<Affiliation, string> = {
  friendly: "F",
  hostile: "H",
  neutral: "N",
  unknown: "U",
};

/** Stamp the active affiliation into SIDC position 2 (standard identity). */
function applyAffiliation(sidc: string, affiliation: Affiliation): string {
  if (sidc.length < 2) return sidc;
  return sidc[0] + AFFILIATION_CHAR[affiliation] + sidc.slice(2);
}

const EARTH_RADIUS_M = 6371008.8;

function haversineM(a: Position, b: Position): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s));
}

/** Leaflet dblclick fires two clicks first, duplicating the last vertex. */
function dedupeConsecutive(points: Position[]): Position[] {
  return points.filter(
    (p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1],
  );
}

function toLatLng(p: Position): [number, number] {
  return [p[1], p[0]];
}

const DRAFT_TOOLS: ReadonlySet<string> = new Set(["line", "route", "polygon"]);

/** Finish an in-progress multi-point draft (dblclick / Enter). */
function finishActiveDraft(): void {
  const s = useAppStore.getState();
  const pts = dedupeConsecutive(s.draftPoints);
  if ((s.tool === "line" || s.tool === "route") && pts.length >= 2) {
    s.addFeature(
      buildFeature(s.tool, { type: "LineString", coordinates: pts }, s.features),
    );
    s.setTool("select");
  } else if (s.tool === "polygon" && pts.length >= 3) {
    s.addFeature(
      buildFeature(
        "polygon",
        { type: "Polygon", coordinates: [[...pts, pts[0]]] },
        s.features,
      ),
    );
    s.setTool("select");
  }
}

function isFormTarget(ev: KeyboardEvent): boolean {
  const t = ev.target;
  if (!(t instanceof HTMLElement)) return false;
  return (
    t.tagName === "INPUT" ||
    t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT" ||
    t.isContentEditable
  );
}

// ───────────────────────── tool state machine ─────────────────────────

/**
 * Single useMapEvents controller. Handlers read store state imperatively
 * (useAppStore.getState()) so they never close over stale slices.
 */
function MapController() {
  const tool = useAppStore((s) => s.tool);
  const aoiCornerRef = useRef<Position | null>(null);
  const lastMouseRef = useRef(0);

  const map = useMapEvents({
    click(e) {
      const s = useAppStore.getState();
      const p: Position = [e.latlng.lng, e.latlng.lat];

      switch (s.tool) {
        case "select":
          s.setSelectedFeatureId(null);
          break;

        case "marker":
          s.addFeature(
            buildFeature("marker", { type: "Point", coordinates: p }, s.features, {
              sidc: applyAffiliation(s.activeSidc, s.activeAffiliation),
              affiliation: s.activeAffiliation,
            }),
          );
          break;

        case "aoi":
          if (!aoiCornerRef.current) {
            aoiCornerRef.current = p;
            s.pushDraftPoint(p);
          } else {
            const a = aoiCornerRef.current;
            aoiCornerRef.current = null;
            s.setAoi({
              north: Math.max(a[1], p[1]),
              south: Math.min(a[1], p[1]),
              east: Math.max(a[0], p[0]),
              west: Math.min(a[0], p[0]),
            });
            s.setTool("select"); // also clears the draft corner
          }
          break;

        case "line":
        case "route":
        case "polygon":
          s.pushDraftPoint(p);
          break;

        case "rectangle":
          if (s.draftPoints.length === 0) {
            s.pushDraftPoint(p);
          } else {
            const a = s.draftPoints[0];
            const west = Math.min(a[0], p[0]);
            const east = Math.max(a[0], p[0]);
            const south = Math.min(a[1], p[1]);
            const north = Math.max(a[1], p[1]);
            // CCW exterior ring SW → SE → NE → NW, closed per GeoJSON
            s.addFeature(
              buildFeature(
                "rectangle",
                {
                  type: "Polygon",
                  coordinates: [
                    [
                      [west, south],
                      [east, south],
                      [east, north],
                      [west, north],
                      [west, south],
                    ],
                  ],
                },
                s.features,
              ),
            );
            s.setTool("select");
          }
          break;

        case "circle":
          if (s.draftPoints.length === 0) {
            s.pushDraftPoint(p);
          } else {
            const center = s.draftPoints[0];
            const radiusM = Math.round(haversineM(center, p));
            if (radiusM < 1) return;
            s.addFeature(
              buildFeature(
                "circle",
                { type: "Point", coordinates: center },
                s.features,
                { radiusM },
              ),
            );
            s.setTool("select");
          }
          break;
      }
    },

    dblclick() {
      finishActiveDraft();
    },

    mousemove(e) {
      const now = Date.now();
      if (now - lastMouseRef.current < 100) return; // ~10 updates/s
      lastMouseRef.current = now;
      useAppStore.getState().setMousePos({ lat: e.latlng.lat, lon: e.latlng.lng });
    },

    mouseout() {
      useAppStore.getState().setMousePos(null);
    },

    moveend() {
      // read-only sync — never calls map.setView, so no feedback loop
      const c = map.getCenter();
      useAppStore.getState().setView([c.lng, c.lat], map.getZoom());
    },
  });

  // Tool changes reset the AOI anchor and toggle double-click zoom so
  // dblclick can finish drafts instead of zooming.
  useEffect(() => {
    aoiCornerRef.current = null;
    if (tool === "select") map.doubleClickZoom.enable();
    else map.doubleClickZoom.disable();
    return () => {
      map.doubleClickZoom.enable();
    };
  }, [tool, map]);

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      const s = useAppStore.getState();
      if (ev.key === "Escape") {
        if (s.tool !== "select") {
          aoiCornerRef.current = null;
          s.clearDraft();
          s.setTool("select");
        }
      } else if (ev.key === "Enter") {
        if (DRAFT_TOOLS.has(s.tool) && !isFormTarget(ev)) finishActiveDraft();
      } else if (ev.key === "Backspace") {
        if (s.draftPoints.length > 0 && !isFormTarget(ev)) {
          ev.preventDefault();
          if (s.tool === "aoi") aoiCornerRef.current = null;
          s.popDraftPoint();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return null;
}

// ───────────────────────── map canvas ─────────────────────────

export default function MapCanvas() {
  const tool = useAppStore((s) => s.tool);
  const aoi = useAppStore((s) => s.aoi);
  const draftPoints = useAppStore((s) => s.draftPoints);
  const basemapId = useAppStore((s) => s.basemapId);
  const previewSourceId = useAppStore((s) => s.previewSourceId);
  const previewOpacity = useAppStore((s) => s.previewOpacity);
  const config = useAppStore((s) => s.config);

  // MapContainer center/zoom are initial-only; snapshot once so the moveend
  // store sync never feeds back into the map.
  const [initialView] = useState(() => {
    const s = useAppStore.getState();
    return { center: toLatLng(s.center), zoom: s.zoom };
  });

  const basemap = BASEMAPS.find((b) => b.id === basemapId) ?? BASEMAPS[0];

  const preview = useMemo(() => {
    if (!previewSourceId || !config) return null;
    const source = config.sources.find((s) => s.id === previewSourceId);
    if (!source || source.strategy !== "xyz" || !source.tileUrlTemplate) {
      return null;
    }
    const key = source.keyId ? getStoredKey(source.keyId) : "";
    if (source.tileUrlTemplate.includes("{key}") && !key) return null;
    return {
      url: source.tileUrlTemplate.replace("{key}", key),
      maxZoom: source.maxZoom,
      attribution: source.attribution,
      layerKey: `${source.id}:${key}`,
    };
  }, [previewSourceId, config]);

  const draftLatLngs = draftPoints.map(toLatLng);

  return (
    <div className={tool === "select" ? "map-canvas" : "map-canvas crosshair"}>
      <MapContainer
        center={initialView.center}
        zoom={initialView.zoom}
        zoomControl={false}
      >
        <ZoomControl position="bottomright" />
        <TileLayer
          key={basemap.id}
          url={basemap.url}
          attribution={basemap.attribution}
          maxZoom={basemap.maxZoom}
        />
        {preview && (
          <TileLayer
            key={preview.layerKey}
            url={preview.url}
            opacity={previewOpacity}
            zIndex={5}
            maxZoom={preview.maxZoom}
            attribution={preview.attribution}
          />
        )}

        <MapController />

        {aoi && (
          <Rectangle
            bounds={[
              [aoi.south, aoi.west],
              [aoi.north, aoi.east],
            ]}
            pathOptions={{
              color: "#ffaa00",
              weight: 2,
              dashArray: "8 6",
              fillColor: "#ffaa00",
              fillOpacity: 0.05,
            }}
          >
            <Tooltip permanent direction="center" className="aoi-tooltip">
              AOI
            </Tooltip>
          </Rectangle>
        )}

        {DRAFT_TOOLS.has(tool) && draftPoints.length > 0 && (
          <Polyline
            positions={draftLatLngs}
            pathOptions={{
              color: "#00e5ff",
              weight: 2,
              dashArray: "6 6",
              opacity: 0.9,
            }}
          />
        )}
        {tool === "polygon" && draftPoints.length >= 3 && (
          <Polygon
            positions={draftLatLngs}
            pathOptions={{ stroke: false, fillColor: "#00e5ff", fillOpacity: 0.08 }}
          />
        )}
        {draftPoints.map((p, i) => (
          <CircleMarker
            key={`draft-${i}`}
            center={toLatLng(p)}
            radius={4}
            pathOptions={{
              color: "#00e5ff",
              weight: 2,
              fillColor: "#0a0c0a",
              fillOpacity: 1,
            }}
          />
        ))}

        <AnnotationLayer />
      </MapContainer>
    </div>
  );
}
