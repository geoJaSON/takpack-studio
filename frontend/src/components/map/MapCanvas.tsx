import { useEffect, useMemo, useRef, useState } from "react";
import { latLng, latLngBounds } from "leaflet";
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
import { useAppStore } from "../../store/use-app-store";
import { destinationPoint } from "../../lib/coordinates";
import { aoiFromCorners } from "../../lib/estimate";
import { formatMgrs } from "../../lib/mgrs-format";
import { noteIconLabel } from "../../lib/note-icons";
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

/** Allow zooming past any single source's native zoom (tiles upscale). */
const MAP_MAX_ZOOM = 22;
const GO_TO_ZOOM = 16;

type ContextMenuState = {
  position: Position;
  x: number;
  y: number;
};

// ───────────────────────── feature creation helpers ─────────────────────────

const KIND_LABEL: Record<FeatureKind, string> = {
  marker: "Marker",
  label: "Label",
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
      return { stroke: "#00e5ff", strokeOpacity: 1, strokeWidth: 3, lineStyle: "solid" };
    case "route":
      // Routes read as routes when dashed by default.
      return { stroke: "#00e5ff", strokeOpacity: 1, strokeWidth: 3, lineStyle: "dashed" };
    case "polygon":
    case "rectangle":
      return {
        stroke: "#ffaa00",
        strokeOpacity: 1,
        strokeWidth: 2,
        lineStyle: "solid",
        fill: "#ffaa00",
        fillOpacity: 0.15,
      };
    case "circle":
      return {
        stroke: "#ff5577",
        strokeOpacity: 1,
        strokeWidth: 2,
        lineStyle: "solid",
        fill: "#ff5577",
        fillOpacity: 0.1,
      };
    case "label":
      return { stroke: "#ffd24d", strokeOpacity: 1, strokeWidth: 2 };
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

function coordinatePointFeature(position: Position, existing: MapFeature[]): MapFeature {
  const mgrs = formatMgrs(position[1], position[0]);
  return buildFeature("marker", { type: "Point", coordinates: position }, existing, {
    name: mgrs === "——" ? "Coordinate point" : mgrs,
    noteIcon: "pin",
    remarks: `Lat ${position[1].toFixed(6)}, Lon ${position[0].toFixed(6)}`,
  });
}

function normalizeBearing(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function sectorSweep(startDeg: number, endDeg: number): number {
  const start = normalizeBearing(startDeg);
  const end = normalizeBearing(endDeg);
  const sweep = (end - start + 360) % 360;
  return sweep === 0 ? 360 : sweep;
}

function quickFanFeature(center: Position, existing: MapFeature[]): MapFeature {
  const radiusM = 500;
  const startDeg = 315;
  const endDeg = 45;
  const sweep = sectorSweep(startDeg, endDeg);
  const steps = Math.max(8, Math.ceil(sweep / 8));
  const ring: Position[] = [center];
  for (let i = 0; i <= steps; i++) {
    const bearing = normalizeBearing(startDeg + (sweep * i) / steps);
    ring.push(destinationPoint(center, radiusM, bearing));
  }
  ring.push(center);

  return buildFeature(
    "polygon",
    { type: "Polygon", coordinates: [ring] },
    existing,
    {
      name: `Fan ${existing.filter((f) => /^Fan\b|^Sector\b/.test(f.name)).length + 1}`,
      style: {
        stroke: "#ff5577",
        strokeOpacity: 1,
        strokeWidth: 2,
        lineStyle: "solid",
        fill: "#ff5577",
        fillOpacity: 0.18,
        labelSize: 12,
      },
      remarks: `Sector ${radiusM}m, ${startDeg}-${endDeg} deg`,
    },
  );
}

function quickRingFeature(center: Position, existing: MapFeature[]): MapFeature {
  const radiusM = 250;
  return buildFeature(
    "circle",
    { type: "Point", coordinates: center },
    existing,
    {
      name: `Ring ${radiusM}m`,
      radiusM,
      style: {
        stroke: "#00e5ff",
        strokeOpacity: 1,
        strokeWidth: 2,
        lineStyle: "dotted",
        fill: "#00e5ff",
        fillOpacity: 0.04,
        labelSize: 11,
      },
      remarks: `Range/search ring ${radiusM}m`,
    },
  );
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

function addCoordinatePoint(position: Position): void {
  const s = useAppStore.getState();
  const feature = coordinatePointFeature(position, s.features);
  s.addFeature(feature);
  s.setSelectedFeatureId(feature.id);
}

function applyMapPoint(p: Position): void {
  const s = useAppStore.getState();

  switch (s.tool) {
    case "select":
      s.setSelectedFeatureId(null);
      break;

    case "marker":
      {
        const feature = buildFeature(
          "marker",
          { type: "Point", coordinates: p },
          s.features,
          {
            sidc: applyAffiliation(s.activeSidc, s.activeAffiliation),
            affiliation: s.activeAffiliation,
          },
        );
        s.addFeature(feature);
        s.setSelectedFeatureId(feature.id);
      }
      break;

    case "noteIcon": {
      const noteCount = s.features.filter((f) => f.noteIcon).length + 1;
      const feature = buildFeature(
        "marker",
        { type: "Point", coordinates: p },
        s.features,
        {
          name: `${noteIconLabel(s.activeNoteIcon)} ${noteCount}`,
          noteIcon: s.activeNoteIcon,
        },
      );
      s.addFeature(feature);
      s.setSelectedFeatureId(feature.id);
      break;
    }

    case "label": {
      // Text label: name is the text; user edits it in the feature panel.
      const feature = buildFeature(
        "label",
        { type: "Point", coordinates: p },
        s.features,
      );
      s.addFeature(feature);
      s.setSelectedFeatureId(feature.id);
      break;
    }

    case "aoi":
      if (s.draftPoints.length === 0) {
        s.pushDraftPoint(p);
      } else {
        const a = s.draftPoints[0];
        const box = aoiFromCorners(a, p);
        if (!box) {
          alert("AOI cannot cross the antimeridian");
          return;
        }
        s.setAoi(box);
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
        const box = aoiFromCorners(a, p);
        if (!box) {
          alert("Rectangle cannot cross the antimeridian");
          return;
        }
        const { north, south, east, west } = box;
        // CCW exterior ring SW -> SE -> NE -> NW, closed per GeoJSON
        const feature = buildFeature(
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
        );
        s.addFeature(feature);
        s.setSelectedFeatureId(feature.id);
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
        const feature = buildFeature(
          "circle",
          { type: "Point", coordinates: center },
          s.features,
          { radiusM },
        );
        s.addFeature(feature);
        s.setSelectedFeatureId(feature.id);
        s.setTool("select");
      }
      break;
  }
}

function addMeasuredDraft(distanceM: number, bearingDeg: number): void {
  const s = useAppStore.getState();
  if (!Number.isFinite(distanceM) || distanceM <= 0) return;

  if ((s.tool === "line" || s.tool === "route" || s.tool === "polygon") && s.draftPoints.length > 0) {
    const last = s.draftPoints[s.draftPoints.length - 1];
    s.pushDraftPoint(destinationPoint(last, distanceM, bearingDeg));
  } else if (s.tool === "circle" && s.draftPoints.length === 1) {
    const feature = buildFeature(
      "circle",
      { type: "Point", coordinates: s.draftPoints[0] },
      s.features,
      { radiusM: Math.round(distanceM) },
    );
    s.addFeature(feature);
    s.setSelectedFeatureId(feature.id);
    s.setTool("select");
  }
}

/** Finish an in-progress multi-point draft (dblclick / Enter). */
function finishActiveDraft(): void {
  const s = useAppStore.getState();
  const pts = dedupeConsecutive(s.draftPoints);
  if ((s.tool === "line" || s.tool === "route") && pts.length >= 2) {
    const feature = buildFeature(
      s.tool,
      { type: "LineString", coordinates: pts },
      s.features,
    );
    s.addFeature(feature);
    s.setSelectedFeatureId(feature.id);
    s.setTool("select");
  } else if (s.tool === "polygon" && pts.length >= 3) {
    const feature = buildFeature(
      "polygon",
      { type: "Polygon", coordinates: [[...pts, pts[0]]] },
      s.features,
    );
    s.addFeature(feature);
    s.setSelectedFeatureId(feature.id);
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
function MapController({
  onContextMenu,
  onCloseContextMenu,
}: {
  onContextMenu: (menu: ContextMenuState) => void;
  onCloseContextMenu: () => void;
}) {
  const tool = useAppStore((s) => s.tool);
  const lastMouseRef = useRef(0);

  const map = useMapEvents({
    click(e) {
      onCloseContextMenu();
      // Wrap so panning onto a world copy never yields lon outside ±180.
      const ll = e.latlng.wrap();
      const p: Position = [ll.lng, ll.lat];
      applyMapPoint(p);
    },

    contextmenu(e) {
      const ll = e.latlng.wrap();
      onContextMenu({
        position: [ll.lng, ll.lat],
        x: e.containerPoint.x,
        y: e.containerPoint.y,
      });
    },

    dblclick() {
      finishActiveDraft();
    },

    mousemove(e) {
      const now = Date.now();
      if (now - lastMouseRef.current < 100) return; // ~10 updates/s
      lastMouseRef.current = now;
      const ll = e.latlng.wrap();
      useAppStore.getState().setMousePos({ lat: ll.lat, lon: ll.lng });
    },

    mouseout() {
      useAppStore.getState().setMousePos(null);
    },

    moveend() {
      onCloseContextMenu();
      // read-only sync — never calls map.setView, so no feedback loop
      const c = map.getCenter();
      useAppStore.getState().setView([c.lng, c.lat], map.getZoom());
    },
  });

  // Tool changes toggle double-click zoom so dblclick can finish drafts
  // instead of zooming.
  useEffect(() => {
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
          s.clearDraft();
          s.setTool("select");
        }
      } else if (ev.key === "Enter") {
        if (DRAFT_TOOLS.has(s.tool) && !isFormTarget(ev)) finishActiveDraft();
      } else if (ev.key === "Backspace") {
        if (s.draftPoints.length > 0 && !isFormTarget(ev)) {
          ev.preventDefault();
          s.popDraftPoint();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // CustomEvent wiring: the toolbar's Finish button and the feature panel's
  // "zoom to" button delegate here so map logic lives in one place.
  useEffect(() => {
    const onFinish = () => finishActiveDraft();

    const onGoToCoordinate = (ev: Event) => {
      const position = (ev as CustomEvent<{ position?: Position }>).detail?.position;
      if (!position) return;
      map.setView(latLng(toLatLng(position)), Math.max(map.getZoom(), GO_TO_ZOOM));
      useAppStore.getState().setView(position, map.getZoom());
    };

    // Loading a project recenters the map to the saved view (center + zoom).
    const onSetView = (ev: Event) => {
      const detail = (ev as CustomEvent<{ center?: Position; zoom?: number }>)
        .detail;
      if (!detail?.center) return;
      const zoom = typeof detail.zoom === "number" ? detail.zoom : map.getZoom();
      map.setView(latLng(toLatLng(detail.center)), zoom);
      useAppStore.getState().setView(detail.center, zoom);
    };

    const onAddCoordinatePoint = (ev: Event) => {
      const position = (ev as CustomEvent<{ position?: Position }>).detail?.position;
      if (!position) return;
      addCoordinatePoint(position);
      map.setView(latLng(toLatLng(position)), Math.max(map.getZoom(), GO_TO_ZOOM));
    };

    const onAddMeasuredDraft = (ev: Event) => {
      const detail = (ev as CustomEvent<{
        distanceM?: number;
        bearingDeg?: number;
      }>).detail;
      addMeasuredDraft(detail?.distanceM ?? 0, detail?.bearingDeg ?? 0);
    };

    const onZoomTo = (ev: Event) => {
      const id = (ev as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      const s = useAppStore.getState();
      const feature = s.features.find((f) => f.id === id);
      if (!feature) return;
      s.setSelectedFeatureId(id);
      const g = feature.geometry;
      const fit = { padding: [40, 40] as [number, number], maxZoom: 17 };
      if (g.type === "Point") {
        const center = latLng(toLatLng(g.coordinates));
        if (feature.kind === "circle" && typeof feature.radiusM === "number") {
          map.fitBounds(center.toBounds(feature.radiusM * 2), fit);
        } else {
          map.setView(center, Math.max(map.getZoom(), 15));
        }
      } else if (g.type === "LineString") {
        map.fitBounds(latLngBounds(g.coordinates.map(toLatLng)), fit);
      } else {
        // Polygon — fit the exterior ring
        map.fitBounds(latLngBounds(g.coordinates[0].map(toLatLng)), fit);
      }
    };

    window.addEventListener("takpack:finish-draft", onFinish);
    window.addEventListener("takpack:go-to-coordinate", onGoToCoordinate);
    window.addEventListener("takpack:set-view", onSetView);
    window.addEventListener("takpack:add-coordinate-point", onAddCoordinatePoint);
    window.addEventListener("takpack:add-measured-draft", onAddMeasuredDraft);
    window.addEventListener("takpack:zoom-to", onZoomTo);
    return () => {
      window.removeEventListener("takpack:finish-draft", onFinish);
      window.removeEventListener("takpack:go-to-coordinate", onGoToCoordinate);
      window.removeEventListener("takpack:set-view", onSetView);
      window.removeEventListener("takpack:add-coordinate-point", onAddCoordinatePoint);
      window.removeEventListener("takpack:add-measured-draft", onAddMeasuredDraft);
      window.removeEventListener("takpack:zoom-to", onZoomTo);
    };
  }, [map]);

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
  const keys = useAppStore((s) => s.keys);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

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
    if (!source) return null;
    // Direct XYZ tile template (most sources).
    if (source.strategy === "xyz" && source.tileUrlTemplate) {
      const key = source.keyId ? keys[source.keyId] ?? "" : "";
      if (source.tileUrlTemplate.includes("{key}") && !key) return null;
      return {
        url: source.tileUrlTemplate.replace("{key}", key),
        maxNativeZoom: source.maxZoom,
        attribution: source.attribution,
        layerKey: `${source.id}:${key}`,
      };
    }
    // No tile template (NAIP exportImage, Sentinel-2 STAC) — go through the
    // server tile proxy so they still render as a normal tile layer.
    if (source.strategy === "arcgis-export" || source.strategy === "stac-sentinel2") {
      return {
        url: `/api/preview/tile/${source.id}/{z}/{x}/{y}`,
        maxNativeZoom: source.maxZoom,
        attribution: source.attribution,
        layerKey: source.id,
      };
    }
    return null;
  }, [previewSourceId, config, keys]);

  const draftLatLngs = draftPoints.map(toLatLng);
  const contextMgrs = contextMenu
    ? formatMgrs(contextMenu.position[1], contextMenu.position[0])
    : "";

  const closeContextMenu = () => setContextMenu(null);

  const contextAction = (
    action:
      | "center"
      | "addPoint"
      | "addLabel"
      | "createFan"
      | "createRing"
      | "applyTool"
      | "copy",
  ) => {
    if (!contextMenu) return;
    const { position } = contextMenu;
    if (action === "center") {
      window.dispatchEvent(
        new CustomEvent("takpack:go-to-coordinate", { detail: { position } }),
      );
    } else if (action === "addPoint") {
      addCoordinatePoint(position);
    } else if (action === "addLabel") {
      const s = useAppStore.getState();
      const feature = buildFeature(
        "label",
        { type: "Point", coordinates: position },
        s.features,
        { name: "Label" },
      );
      s.addFeature(feature);
      s.setSelectedFeatureId(feature.id);
    } else if (action === "createFan") {
      const s = useAppStore.getState();
      const feature = quickFanFeature(position, s.features);
      s.addFeature(feature);
      s.setSelectedFeatureId(feature.id);
    } else if (action === "createRing") {
      const s = useAppStore.getState();
      const feature = quickRingFeature(position, s.features);
      s.addFeature(feature);
      s.setSelectedFeatureId(feature.id);
    } else if (action === "applyTool") {
      applyMapPoint(position);
    } else {
      void navigator.clipboard?.writeText(
        contextMgrs === "——"
          ? `${position[1].toFixed(6)}, ${position[0].toFixed(6)}`
          : contextMgrs,
      );
    }
    closeContextMenu();
  };

  return (
    <div className={tool === "select" ? "map-canvas" : "map-canvas crosshair"}>
      <MapContainer
        center={initialView.center}
        zoom={initialView.zoom}
        zoomControl={false}
        maxZoom={MAP_MAX_ZOOM}
      >
        {/* top-left keeps the zoom control clear of the bottom-center
            drawing toolbar (which widens with draft sub-controls). */}
        <ZoomControl position="topleft" />
        {/* maxNativeZoom keeps tiles upscaling (pixelated) past a source's
            native zoom instead of vanishing. */}
        <TileLayer
          key={basemap.id}
          url={basemap.url}
          attribution={basemap.attribution}
          maxNativeZoom={basemap.maxZoom}
          maxZoom={MAP_MAX_ZOOM}
        />
        {preview && (
          <TileLayer
            key={preview.layerKey}
            url={preview.url}
            opacity={previewOpacity}
            zIndex={5}
            maxNativeZoom={preview.maxNativeZoom}
            maxZoom={MAP_MAX_ZOOM}
            attribution={preview.attribution}
          />
        )}

        <MapController
          onContextMenu={setContextMenu}
          onCloseContextMenu={closeContextMenu}
        />

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

      {contextMenu && (
        <div
          className="map-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="map-context-title">{contextMgrs}</div>
          <button type="button" onClick={() => contextAction("center")}>
            Center here
          </button>
          <button type="button" onClick={() => contextAction("addPoint")}>
            Add coordinate point
          </button>
          <button type="button" onClick={() => contextAction("addLabel")}>
            Place label here
          </button>
          <button type="button" onClick={() => contextAction("createFan")}>
            Create fan here
          </button>
          <button type="button" onClick={() => contextAction("createRing")}>
            Create ring here
          </button>
          {tool !== "select" && (
            <button type="button" onClick={() => contextAction("applyTool")}>
              Apply {tool} here
            </button>
          )}
          <button type="button" onClick={() => contextAction("copy")}>
            Copy MGRS
          </button>
        </div>
      )}
    </div>
  );
}
