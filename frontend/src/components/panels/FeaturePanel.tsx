import { useState } from "react";
import type { ChangeEvent } from "react";
import { useAppStore } from "../../store/use-app-store";
import {
  AFFILIATIONS,
  SYMBOL_CATEGORIES,
  applyAffiliation,
  getSymbolDataUrl,
  sameSymbol,
} from "../../lib/milsymbol-utils";
import {
  distanceMeters,
  initialBearingDeg,
  parseCoordinateBatch,
  parseCoordinateInput,
  destinationPoint,
  formatDms,
  formatUtm,
} from "../../lib/coordinates";
import { featuresFromFieldFile } from "../../lib/field-import";
import { formatMgrs } from "../../lib/mgrs-format";
import { NOTE_ICONS, NoteIconGlyph } from "../../lib/note-icons";
import { SUPPORT_DOCS } from "../../lib/support-docs";
import { ATAK_ROLES, ATAK_TEAMS } from "../../types";
import type {
  Aoi,
  Affiliation,
  CommsNet,
  FeatureKind,
  LineStyle,
  MapFeature,
  NoteIconType,
  Position,
  SupportDocId,
} from "../../types";

/**
 * Right sidebar: milsymbol palette, feature list, selected-feature editor,
 * GeoJSON import, and clear-all.
 */

function readFileBase64(
  file: File,
): Promise<{ name: string; contentType?: string; base64: string }> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.onload = () => {
      const v = String(r.result ?? "");
      resolve({
        name: file.name,
        contentType: file.type || undefined,
        base64: v.includes(",") ? v.split(",")[1] : v,
      });
    };
    r.readAsDataURL(file);
  });
}

const KIND_GLYPHS: Record<FeatureKind, string> = {
  marker: "◉",
  label: "T",
  line: "╱",
  route: "➔",
  polygon: "⬠",
  rectangle: "▭",
  circle: "◯",
};

const AREA_KINDS: FeatureKind[] = ["polygon", "rectangle", "circle"];
const STROKE_KINDS: FeatureKind[] = [
  "line",
  "route",
  "polygon",
  "rectangle",
  "circle",
];
const LINE_STYLE_OPTIONS: { value: LineStyle; label: string }[] = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
  { value: "outlined", label: "Outlined" },
];
const DEFAULT_FEATURE_LABEL_SIZE = 11;
const DEFAULT_TEXT_LABEL_SIZE = 13;
const COORDINATE_IMPORT_STROKE = "#ffaa00";
const GRG_STROKE = "#00e5ff";

type ToolboxId =
  | "symbols"
  | "notes"
  | "templates"
  | "coords"
  | "batch"
  | "grg"
  | "route"
  | "sector"
  | "rings"
  | "comms"
  | "import"
  | "manage";

const TOOLBOXES: { id: ToolboxId; label: string; short: string }[] = [
  { id: "symbols", label: "Symbol Palette", short: "SYM" },
  { id: "notes", label: "Note Icons", short: "NOTE" },
  { id: "templates", label: "Template Packs", short: "TPL" },
  { id: "coords", label: "Coordinate Tools", short: "COORD" },
  { id: "batch", label: "Batch Coordinates", short: "BATCH" },
  { id: "grg", label: "GRG Builder", short: "GRG" },
  { id: "route", label: "Route Card", short: "ROUTE" },
  { id: "sector", label: "Sector / Fan", short: "FAN" },
  { id: "rings", label: "Rings / Buffers", short: "RING" },
  { id: "comms", label: "Comms / Checklist Pack", short: "COMMS" },
  { id: "import", label: "Import GeoJSON", short: "IMP" },
  { id: "manage", label: "Manage", short: "MGR" },
];

function coordinateFeature(
  position: Position,
  name: string,
  lineNumber: number,
): MapFeature {
  const mgrs = formatMgrs(position[1], position[0]);
  return {
    id: crypto.randomUUID(),
    kind: "marker",
    name,
    noteIcon: "pin",
    geometry: { type: "Point", coordinates: position },
    style: {
      stroke: COORDINATE_IMPORT_STROKE,
      strokeOpacity: 1,
      strokeWidth: 2,
      labelSize: DEFAULT_FEATURE_LABEL_SIZE,
    },
    remarks: [
      mgrs !== "——" ? `MGRS: ${mgrs}` : null,
      `Lat/Lon: ${position[1].toFixed(6)}, ${position[0].toFixed(6)}`,
      `Imported from coordinate line ${lineNumber}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function BatchCoordinateImport() {
  const addFeature = useAppStore((s) => s.addFeature);
  const setSelectedFeatureId = useAppStore((s) => s.setSelectedFeatureId);
  const [text, setText] = useState("");
  const [lastResult, setLastResult] = useState<{
    imported: number;
    errors: string[];
  } | null>(null);

  const preview = parseCoordinateBatch(text);
  const canImport = preview.rows.length > 0;

  const importRows = () => {
    if (!canImport) {
      setLastResult({ imported: 0, errors: preview.errors });
      return;
    }
    let lastId: string | null = null;
    for (const row of preview.rows) {
      const feature = coordinateFeature(row.position, row.name, row.lineNumber);
      addFeature(feature);
      lastId = feature.id;
    }
    if (lastId) setSelectedFeatureId(lastId);
    setLastResult({ imported: preview.rows.length, errors: preview.errors });
    setText("");
  };

  return (
    <div className="panel-section batch-coordinate-import">
      <div className="label">BATCH COORDINATES</div>
      <textarea
        className="input"
        rows={5}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setLastResult(null);
        }}
        placeholder={"Paste MGRS or lat, lon rows\nOBJ 1, 12S VK 12345 67890\n34.5001, -117.2502, Checkpoint"}
      />
      <div className="batch-import-status">
        <span className="chip">{preview.rows.length} ready</span>
        {preview.errors.length > 0 && (
          <span className="chip batch-import-errors">
            {preview.errors.length} skipped
          </span>
        )}
      </div>
      {preview.errors.length > 0 && (
        <div className="batch-error-list">
          {preview.errors.slice(0, 3).map((error) => (
            <div key={error}>{error}</div>
          ))}
          {preview.errors.length > 3 && (
            <div>+{preview.errors.length - 3} more skipped rows</div>
          )}
        </div>
      )}
      <button
        type="button"
        className="btn btn-primary"
        disabled={!text.trim()}
        onClick={importRows}
      >
        IMPORT POINTS
      </button>
      {lastResult && (
        <div className="panel-row" style={{ opacity: 0.72 }}>
          Imported {lastResult.imported} point
          {lastResult.imported === 1 ? "" : "s"}
          {lastResult.errors.length ? ` · ${lastResult.errors.length} skipped` : ""}
        </div>
      )}
    </div>
  );
}

function cellName(row: number, col: number): string {
  const letter = String.fromCharCode("A".charCodeAt(0) + row);
  return `${letter}${col + 1}`;
}

function grgLineFeature(name: string, coordinates: Position[]): MapFeature {
  return {
    id: crypto.randomUUID(),
    kind: "line",
    name,
    geometry: { type: "LineString", coordinates },
    style: {
      stroke: GRG_STROKE,
      strokeOpacity: 0.82,
      strokeWidth: 2,
      lineStyle: "solid",
      labelSize: 10,
    },
    showLabel: false,
  };
}

function grgLabelFeature(name: string, position: Position): MapFeature {
  return {
    id: crypto.randomUUID(),
    kind: "label",
    name,
    geometry: { type: "Point", coordinates: position },
    style: {
      stroke: "#ffffff",
      strokeOpacity: 1,
      strokeWidth: 2,
      labelSize: 14,
    },
    remarks: "Generated GRG cell label",
  };
}

function buildGrgFeatures(aoi: Aoi, rows: number, cols: number, prefix: string): MapFeature[] {
  const features: MapFeature[] = [];
  const latStep = (aoi.north - aoi.south) / rows;
  const lonStep = (aoi.east - aoi.west) / cols;
  const namePrefix = prefix.trim();

  for (let col = 0; col <= cols; col++) {
    const lon = aoi.west + lonStep * col;
    features.push(
      grgLineFeature(`${namePrefix} V${col + 1}`.trim(), [
        [lon, aoi.south],
        [lon, aoi.north],
      ]),
    );
  }

  for (let row = 0; row <= rows; row++) {
    const lat = aoi.north - latStep * row;
    features.push(
      grgLineFeature(`${namePrefix} H${row + 1}`.trim(), [
        [aoi.west, lat],
        [aoi.east, lat],
      ]),
    );
  }

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const lon = aoi.west + lonStep * (col + 0.5);
      const lat = aoi.north - latStep * (row + 0.5);
      const name = `${namePrefix} ${cellName(row, col)}`.trim();
      features.push(grgLabelFeature(name, [lon, lat]));
    }
  }

  return features;
}

function GrgBuilder() {
  const aoi = useAppStore((s) => s.aoi);
  const addFeature = useAppStore((s) => s.addFeature);
  const setSelectedFeatureId = useAppStore((s) => s.setSelectedFeatureId);
  const [rows, setRows] = useState(4);
  const [cols, setCols] = useState(4);
  const [prefix, setPrefix] = useState("GRG");
  const [lastGenerated, setLastGenerated] = useState(0);

  const generate = () => {
    if (!aoi) return;
    const safeRows = Math.max(1, Math.min(20, rows));
    const safeCols = Math.max(1, Math.min(20, cols));
    const generated = buildGrgFeatures(aoi, safeRows, safeCols, prefix);
    let lastId: string | null = null;
    generated.forEach((feature) => {
      addFeature(feature);
      lastId = feature.id;
    });
    if (lastId) setSelectedFeatureId(lastId);
    setRows(safeRows);
    setCols(safeCols);
    setLastGenerated(generated.length);
  };

  return (
    <div className="panel-section grg-builder">
      <div className="label">GRG BUILDER</div>
      {!aoi && (
        <div className="panel-row" style={{ opacity: 0.65 }}>
          Draw an AOI first.
        </div>
      )}
      <div className="grg-controls">
        <label>
          <span>Rows</span>
          <input
            className="input"
            type="number"
            min={1}
            max={20}
            value={rows}
            onChange={(e) => setRows(Number(e.target.value) || 1)}
          />
        </label>
        <label>
          <span>Cols</span>
          <input
            className="input"
            type="number"
            min={1}
            max={20}
            value={cols}
            onChange={(e) => setCols(Number(e.target.value) || 1)}
          />
        </label>
        <label>
          <span>Prefix</span>
          <input
            className="input"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
          />
        </label>
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={!aoi}
        onClick={generate}
      >
        GENERATE GRG
      </button>
      {lastGenerated > 0 && (
        <div className="panel-row" style={{ opacity: 0.72 }}>
          Added {lastGenerated} GRG features.
        </div>
      )}
    </div>
  );
}

function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  return `${Math.round(meters)} m`;
}

function formatEta(distanceM: number, speedKph: number): string {
  if (speedKph <= 0) return "--";
  const minutes = (distanceM / 1000 / speedKph) * 60;
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return `${hours}h ${mins}m`;
}

function routeCheckpointFeature(
  routeName: string,
  index: number,
  position: Position,
): MapFeature {
  return {
    id: crypto.randomUUID(),
    kind: "label",
    name: `${routeName} CP${index + 1}`,
    geometry: { type: "Point", coordinates: position },
    style: {
      stroke: "#ffd24d",
      strokeOpacity: 1,
      strokeWidth: 2,
      labelSize: 12,
    },
    remarks: `Route checkpoint ${index + 1}`,
  };
}

function RouteCardPanel() {
  const features = useAppStore((s) => s.features);
  const addFeature = useAppStore((s) => s.addFeature);
  const setSelectedFeatureId = useAppStore((s) => s.setSelectedFeatureId);
  const routeFeatures = features.filter(
    (feature) =>
      (feature.kind === "route" || feature.kind === "line") &&
      feature.geometry.type === "LineString" &&
      feature.geometry.coordinates.length >= 2,
  );
  const [selectedRouteId, setSelectedRouteId] = useState("");
  const [speedKph, setSpeedKph] = useState(4);

  const selectedRoute =
    routeFeatures.find((feature) => feature.id === selectedRouteId) ??
    routeFeatures[0] ??
    null;
  const points =
    selectedRoute?.geometry.type === "LineString"
      ? selectedRoute.geometry.coordinates
      : [];
  const legs = points.slice(0, -1).map((point, index) => {
    const next = points[index + 1];
    const distanceM = distanceMeters(point, next);
    return {
      id: `${index}-${index + 1}`,
      from: `CP${index + 1}`,
      to: `CP${index + 2}`,
      distanceM,
      bearing: initialBearingDeg(point, next),
    };
  });
  const totalM = legs.reduce((sum, leg) => sum + leg.distanceM, 0);

  const addCheckpointLabels = () => {
    if (!selectedRoute) return;
    let lastId: string | null = null;
    points.forEach((point, index) => {
      const label = routeCheckpointFeature(selectedRoute.name, index, point);
      addFeature(label);
      lastId = label.id;
    });
    if (lastId) setSelectedFeatureId(lastId);
  };

  return (
    <div className="panel-section route-card-panel">
      <div className="label">ROUTE CARD</div>
      {routeFeatures.length === 0 ? (
        <div className="panel-row" style={{ opacity: 0.65 }}>
          Draw a line or route first.
        </div>
      ) : (
        <>
          <select
            className="select"
            value={selectedRoute?.id ?? ""}
            onChange={(e) => setSelectedRouteId(e.target.value)}
          >
            {routeFeatures.map((feature) => (
              <option key={feature.id} value={feature.id}>
                {feature.name}
              </option>
            ))}
          </select>
          <label className="route-speed-control">
            <span>Speed kph</span>
            <input
              className="input"
              type="number"
              min={1}
              max={120}
              step={0.5}
              value={speedKph}
              onChange={(e) => setSpeedKph(Number(e.target.value) || 1)}
            />
          </label>
          <div className="route-card-summary">
            <span>{legs.length} legs</span>
            <span>{formatDistance(totalM)}</span>
            <span>{formatEta(totalM, speedKph)}</span>
          </div>
          <div className="route-leg-list">
            {legs.map((leg) => (
              <div key={leg.id} className="route-leg-row">
                <strong>
                  {leg.from} to {leg.to}
                </strong>
                <span>{formatDistance(leg.distanceM)}</span>
                <span>{leg.bearing.toFixed(0).padStart(3, "0")} deg</span>
                <span>{formatEta(leg.distanceM, speedKph)}</span>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={addCheckpointLabels}
          >
            ADD CP LABELS
          </button>
        </>
      )}
    </div>
  );
}

function normalizeBearing(value: number): number {
  return ((value % 360) + 360) % 360;
}

function sectorSweep(startDeg: number, endDeg: number): number {
  const start = normalizeBearing(startDeg);
  const end = normalizeBearing(endDeg);
  const sweep = (end - start + 360) % 360;
  return sweep === 0 ? 360 : sweep;
}

function buildSectorFeature({
  center,
  radiusM,
  startDeg,
  endDeg,
  name,
}: {
  center: Position;
  radiusM: number;
  startDeg: number;
  endDeg: number;
  name: string;
}): MapFeature {
  const sweep = sectorSweep(startDeg, endDeg);
  const steps = Math.max(8, Math.ceil(sweep / 8));
  const ring: Position[] = [center];
  for (let i = 0; i <= steps; i++) {
    const bearing = normalizeBearing(startDeg + (sweep * i) / steps);
    ring.push(destinationPoint(center, radiusM, bearing));
  }
  ring.push(center);

  return {
    id: crypto.randomUUID(),
    kind: "polygon",
    name,
    geometry: { type: "Polygon", coordinates: [ring] },
    style: {
      stroke: "#ff5577",
      strokeOpacity: 1,
      strokeWidth: 2,
      lineStyle: "solid",
      fill: "#ff5577",
      fillOpacity: 0.18,
      labelSize: 12,
    },
    remarks: `Sector ${Math.round(radiusM)}m, ${normalizeBearing(startDeg).toFixed(0)}-${normalizeBearing(endDeg).toFixed(0)} deg`,
  };
}

function SectorFanBuilder() {
  const addFeature = useAppStore((s) => s.addFeature);
  const setSelectedFeatureId = useAppStore((s) => s.setSelectedFeatureId);
  const [centerText, setCenterText] = useState("");
  const [radiusM, setRadiusM] = useState(500);
  const [startDeg, setStartDeg] = useState(315);
  const [endDeg, setEndDeg] = useState(45);
  const [name, setName] = useState("Sector");
  const [error, setError] = useState("");

  const generate = () => {
    const center = parseCoordinateInput(centerText);
    if (!center) {
      setError("Enter a valid MGRS or lat, lon center.");
      return;
    }
    const safeRadius = Math.max(1, radiusM);
    const feature = buildSectorFeature({
      center,
      radiusM: safeRadius,
      startDeg,
      endDeg,
      name: name.trim() || "Sector",
    });
    addFeature(feature);
    setSelectedFeatureId(feature.id);
    setError("");
  };

  return (
    <div className="panel-section sector-builder">
      <div className="label">SECTOR / FAN</div>
      <input
        className="input"
        value={centerText}
        onChange={(e) => {
          setCenterText(e.target.value);
          setError("");
        }}
        placeholder="Center MGRS or lat, lon"
      />
      <div className="sector-controls">
        <label>
          <span>Radius m</span>
          <input
            className="input"
            type="number"
            min={1}
            value={radiusM}
            onChange={(e) => setRadiusM(Number(e.target.value) || 1)}
          />
        </label>
        <label>
          <span>Start</span>
          <input
            className="input"
            type="number"
            value={startDeg}
            onChange={(e) => setStartDeg(Number(e.target.value) || 0)}
          />
        </label>
        <label>
          <span>End</span>
          <input
            className="input"
            type="number"
            value={endDeg}
            onChange={(e) => setEndDeg(Number(e.target.value) || 0)}
          />
        </label>
        <label>
          <span>Name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      </div>
      {error && <div className="error-text">{error}</div>}
      <button type="button" className="btn btn-primary" onClick={generate}>
        ADD SECTOR
      </button>
    </div>
  );
}

type TemplateItem = {
  name: string;
  noteIcon: NoteIconType;
  bearing: number;
  distanceM: number;
};

const TEMPLATE_PACKS: {
  id: string;
  label: string;
  description: string;
  color: string;
  items: TemplateItem[];
  route?: boolean;
}[] = [
  {
    id: "patrol",
    label: "Patrol",
    description: "Start, checkpoints, rally, and observation notes.",
    color: "#ffaa00",
    route: true,
    items: [
      { name: "SP", noteIcon: "flag", bearing: 250, distanceM: 350 },
      { name: "CP1", noteIcon: "pin", bearing: 305, distanceM: 650 },
      { name: "OP", noteIcon: "info", bearing: 20, distanceM: 900 },
      { name: "Rally", noteIcon: "star", bearing: 105, distanceM: 520 },
    ],
  },
  {
    id: "sar",
    label: "SAR",
    description: "ICP, last-known point, search zones, and med pickup.",
    color: "#22c55e",
    items: [
      { name: "ICP", noteIcon: "flag", bearing: 240, distanceM: 300 },
      { name: "LKP", noteIcon: "pin", bearing: 0, distanceM: 520 },
      { name: "Search A", noteIcon: "info", bearing: 55, distanceM: 700 },
      { name: "Med Pickup", noteIcon: "medical", bearing: 145, distanceM: 620 },
    ],
  },
  {
    id: "fire-ems",
    label: "Fire/EMS",
    description: "Staging, hazard, hydrant/water, and casualty points.",
    color: "#ff5577",
    items: [
      { name: "Staging", noteIcon: "flag", bearing: 220, distanceM: 400 },
      { name: "Hazard", noteIcon: "alert", bearing: 10, distanceM: 450 },
      { name: "Water", noteIcon: "info", bearing: 100, distanceM: 500 },
      { name: "Casualty", noteIcon: "medical", bearing: 45, distanceM: 650 },
    ],
  },
  {
    id: "cas",
    label: "CAS",
    description: "Target, friendlies, IP, and egress reference points.",
    color: "#ef4444",
    items: [
      { name: "TGT", noteIcon: "alert", bearing: 0, distanceM: 650 },
      { name: "Friendlies", noteIcon: "flag", bearing: 180, distanceM: 520 },
      { name: "IP", noteIcon: "star", bearing: 270, distanceM: 950 },
      { name: "Egress", noteIcon: "pin", bearing: 90, distanceM: 950 },
    ],
  },
  {
    id: "land-nav",
    label: "Land Nav",
    description: "Start, controls, handrail, and finish points.",
    color: "#eab308",
    route: true,
    items: [
      { name: "Start", noteIcon: "flag", bearing: 210, distanceM: 300 },
      { name: "Control 1", noteIcon: "pin", bearing: 320, distanceM: 600 },
      { name: "Control 2", noteIcon: "pin", bearing: 35, distanceM: 750 },
      { name: "Finish", noteIcon: "star", bearing: 120, distanceM: 500 },
    ],
  },
];

function templatePointFeature(
  pack: (typeof TEMPLATE_PACKS)[number],
  item: TemplateItem,
  origin: Position,
): MapFeature {
  const position = destinationPoint(origin, item.distanceM, item.bearing);
  return {
    id: crypto.randomUUID(),
    kind: "marker",
    name: `${pack.label} ${item.name}`,
    noteIcon: item.noteIcon,
    geometry: { type: "Point", coordinates: position },
    style: {
      stroke: pack.color,
      strokeOpacity: 1,
      strokeWidth: 2,
      labelSize: DEFAULT_FEATURE_LABEL_SIZE,
    },
    remarks: `${pack.description}\nGenerated template point ${item.name}.`,
  };
}

function templateRouteFeature(
  pack: (typeof TEMPLATE_PACKS)[number],
  points: Position[],
): MapFeature {
  return {
    id: crypto.randomUUID(),
    kind: "route",
    name: `${pack.label} Route`,
    geometry: { type: "LineString", coordinates: points },
    style: {
      stroke: pack.color,
      strokeOpacity: 1,
      strokeWidth: 3,
      lineStyle: "dashed",
      labelSize: 11,
    },
  };
}

function TemplatePacksPanel() {
  const center = useAppStore((s) => s.center);
  const addFeature = useAppStore((s) => s.addFeature);
  const setSelectedFeatureId = useAppStore((s) => s.setSelectedFeatureId);
  const [lastPack, setLastPack] = useState("");

  const addPack = (pack: (typeof TEMPLATE_PACKS)[number]) => {
    const generated = pack.items.map((item) =>
      templatePointFeature(pack, item, center),
    );
    if (pack.route) {
      generated.push(
        templateRouteFeature(
          pack,
          generated
            .filter((feature) => feature.geometry.type === "Point")
            .map((feature) => feature.geometry.coordinates as Position),
        ),
      );
    }
    generated.forEach(addFeature);
    setSelectedFeatureId(generated[generated.length - 1]?.id ?? null);
    setLastPack(pack.label);
  };

  return (
    <div className="panel-section template-pack-panel">
      <div className="label">TEMPLATE PACKS</div>
      <div className="template-pack-grid">
        {TEMPLATE_PACKS.map((pack) => (
          <button
            key={pack.id}
            type="button"
            className="template-pack-card"
            style={{ "--pack-color": pack.color } as React.CSSProperties}
            onClick={() => addPack(pack)}
          >
            <strong>{pack.label}</strong>
            <span>{pack.description}</span>
          </button>
        ))}
      </div>
      {lastPack && (
        <div className="panel-row" style={{ opacity: 0.72 }}>
          Added {lastPack} template pack.
        </div>
      )}
    </div>
  );
}

function CoordinateToolsPanel() {
  const addFeature = useAppStore((s) => s.addFeature);
  const setSelectedFeatureId = useAppStore((s) => s.setSelectedFeatureId);
  const [coordA, setCoordA] = useState("");
  const [coordB, setCoordB] = useState("");
  const [projectDistance, setProjectDistance] = useState(500);
  const [projectBearing, setProjectBearing] = useState(0);

  const pointA = parseCoordinateInput(coordA);
  const pointB = parseCoordinateInput(coordB);
  const projected =
    pointA && projectDistance > 0
      ? destinationPoint(pointA, projectDistance, projectBearing)
      : null;

  const addPoint = (position: Position, name: string) => {
    const feature = coordinateFeature(position, name, 1);
    addFeature({
      ...feature,
      remarks: [
        `MGRS: ${formatMgrs(position[1], position[0])}`,
        `Lat/Lon: ${position[1].toFixed(6)}, ${position[0].toFixed(6)}`,
        "Generated from coordinate tools",
      ].join("\n"),
    });
    setSelectedFeatureId(feature.id);
  };

  return (
    <div className="panel-section coordinate-tools-panel">
      <div className="label">COORDINATE TOOLS</div>
      <input
        className="input"
        value={coordA}
        onChange={(e) => setCoordA(e.target.value)}
        placeholder="Point A MGRS or lat, lon"
      />
      {pointA && (
        <div className="coord-tool-readout">
          <div><strong>MGRS</strong><span>{formatMgrs(pointA[1], pointA[0])}</span></div>
          <div><strong>DEC</strong><span>{pointA[1].toFixed(6)}, {pointA[0].toFixed(6)}</span></div>
          <div><strong>DMS</strong><span>{formatDms(pointA)}</span></div>
          <div><strong>UTM</strong><span>{formatUtm(pointA)}</span></div>
        </div>
      )}
      <input
        className="input"
        value={coordB}
        onChange={(e) => setCoordB(e.target.value)}
        placeholder="Point B for distance/bearing"
      />
      {pointA && pointB && (
        <div className="route-card-summary">
          <span>{formatDistance(distanceMeters(pointA, pointB))}</span>
          <span>{initialBearingDeg(pointA, pointB).toFixed(1)} deg</span>
          <span>A to B</span>
        </div>
      )}
      <div className="coord-project-grid">
        <label>
          <span>Dist m</span>
          <input
            className="input"
            type="number"
            min={1}
            value={projectDistance}
            onChange={(e) => setProjectDistance(Number(e.target.value) || 1)}
          />
        </label>
        <label>
          <span>Bearing</span>
          <input
            className="input"
            type="number"
            value={projectBearing}
            onChange={(e) => setProjectBearing(Number(e.target.value) || 0)}
          />
        </label>
      </div>
      {projected && (
        <div className="coord-tool-readout">
          <div><strong>PROJECTED</strong><span>{formatMgrs(projected[1], projected[0])}</span></div>
        </div>
      )}
      <div className="coord-tool-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!pointA}
          onClick={() => pointA && addPoint(pointA, "Coordinate A")}
        >
          ADD A
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!projected}
          onClick={() => projected && addPoint(projected, "Projected Point")}
        >
          ADD PROJECTED
        </button>
      </div>
    </div>
  );
}

function ringFeature(center: Position, radiusM: number, name: string): MapFeature {
  return {
    id: crypto.randomUUID(),
    kind: "circle",
    name,
    geometry: { type: "Point", coordinates: center },
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
    remarks: `Range/search ring ${Math.round(radiusM)}m`,
  };
}

function corridorFeature(route: MapFeature, widthM: number): MapFeature | null {
  if (route.geometry.type !== "LineString") return null;
  return {
    id: crypto.randomUUID(),
    kind: "line",
    name: `${route.name} Corridor ${Math.round(widthM)}m`,
    geometry: route.geometry,
    style: {
      stroke: "#a855f7",
      strokeOpacity: 0.62,
      strokeWidth: 8,
      lineStyle: "solid",
      labelSize: 11,
    },
    remarks: `Visual corridor/standoff overlay for ${route.name}. Width requested: ${Math.round(widthM)}m.`,
  };
}

function RingBufferPanel() {
  const features = useAppStore((s) => s.features);
  const addFeature = useAppStore((s) => s.addFeature);
  const setSelectedFeatureId = useAppStore((s) => s.setSelectedFeatureId);
  const [centerText, setCenterText] = useState("");
  const [radiiText, setRadiiText] = useState("100, 250, 500");
  const [prefix, setPrefix] = useState("Ring");
  const [selectedRouteId, setSelectedRouteId] = useState("");
  const [corridorWidth, setCorridorWidth] = useState(100);
  const [message, setMessage] = useState("");

  const routeFeatures = features.filter(
    (feature) =>
      (feature.kind === "route" || feature.kind === "line") &&
      feature.geometry.type === "LineString",
  );
  const selectedRoute =
    routeFeatures.find((feature) => feature.id === selectedRouteId) ??
    routeFeatures[0] ??
    null;

  const addRings = () => {
    const center = parseCoordinateInput(centerText);
    if (!center) {
      setMessage("Enter a valid ring center.");
      return;
    }
    const radii = radiiText
      .split(/[,\s]+/)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (radii.length === 0) {
      setMessage("Enter at least one radius in meters.");
      return;
    }
    let lastId: string | null = null;
    radii.forEach((radius) => {
      const feature = ringFeature(center, radius, `${prefix || "Ring"} ${Math.round(radius)}m`);
      addFeature(feature);
      lastId = feature.id;
    });
    if (lastId) setSelectedFeatureId(lastId);
    setMessage(`Added ${radii.length} ring${radii.length === 1 ? "" : "s"}.`);
  };

  const addCorridor = () => {
    if (!selectedRoute) {
      setMessage("Draw/select a route or line first.");
      return;
    }
    const feature = corridorFeature(selectedRoute, corridorWidth);
    if (!feature) return;
    addFeature(feature);
    setSelectedFeatureId(feature.id);
    setMessage("Added visual route corridor.");
  };

  return (
    <div className="panel-section ring-buffer-panel">
      <div className="label">RINGS / BUFFERS</div>
      <input
        className="input"
        value={centerText}
        onChange={(e) => {
          setCenterText(e.target.value);
          setMessage("");
        }}
        placeholder="Ring center MGRS or lat, lon"
      />
      <input
        className="input"
        value={radiiText}
        onChange={(e) => setRadiiText(e.target.value)}
        placeholder="Radii meters: 100, 250, 500"
      />
      <input
        className="input"
        value={prefix}
        onChange={(e) => setPrefix(e.target.value)}
        placeholder="Ring name prefix"
      />
      <button type="button" className="btn btn-primary" onClick={addRings}>
        ADD RINGS
      </button>
      <div className="ring-divider" />
      <select
        className="select"
        value={selectedRoute?.id ?? ""}
        onChange={(e) => setSelectedRouteId(e.target.value)}
      >
        {routeFeatures.length === 0 ? (
          <option value="">No route/line features</option>
        ) : (
          routeFeatures.map((feature) => (
            <option key={feature.id} value={feature.id}>
              {feature.name}
            </option>
          ))
        )}
      </select>
      <label className="route-speed-control">
        <span>Corridor m</span>
        <input
          className="input"
          type="number"
          min={1}
          value={corridorWidth}
          onChange={(e) => setCorridorWidth(Number(e.target.value) || 1)}
        />
      </label>
      <button
        type="button"
        className="btn btn-primary"
        disabled={!selectedRoute}
        onClick={addCorridor}
      >
        ADD CORRIDOR
      </button>
      {message && <div className="panel-row" style={{ opacity: 0.72 }}>{message}</div>}
    </div>
  );
}

const COMMS_BLOCK: React.CSSProperties = {
  marginTop: 8,
  borderTop: "1px solid var(--line-0)",
  paddingTop: 8,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const ROW: React.CSSProperties = { display: "flex", gap: 6, alignItems: "center" };
const TOGGLE: React.CSSProperties = { ...ROW, cursor: "pointer" };
const FIELD_LABEL: React.CSSProperties = { margin: 0, minWidth: 92, flexShrink: 0 };

function CommsChecklistPanel() {
  const supportDocIds = useAppStore((s) => s.supportDocIds);
  const setSupportDocIds = useAppStore((s) => s.setSupportDocIds);
  const commsPlan = useAppStore((s) => s.commsPlan);
  const setCommsPlan = useAppStore((s) => s.setCommsPlan);
  const includePref = useAppStore((s) => s.includePref);
  const setIncludePref = useAppStore((s) => s.setIncludePref);
  const includeCasevacMarker = useAppStore((s) => s.includeCasevacMarker);
  const setIncludeCasevacMarker = useAppStore((s) => s.setIncludeCasevacMarker);

  const nets = commsPlan.nets ?? [];
  const pace =
    commsPlan.pace ?? { primary: "", alternate: "", contingency: "", emergency: "" };
  const identity = commsPlan.identity ?? {};
  const medevac = commsPlan.medevac ?? {};
  const has = (id: SupportDocId) => supportDocIds.includes(id);

  const toggleSupportDoc = (id: SupportDocId) =>
    setSupportDocIds(
      supportDocIds.includes(id)
        ? supportDocIds.filter((item) => item !== id)
        : [...supportDocIds, id],
    );
  const updateNet = (i: number, patch: Partial<CommsNet>) =>
    setCommsPlan({ nets: nets.map((n, idx) => (idx === i ? { ...n, ...patch } : n)) });
  const addNet = () =>
    setCommsPlan({ nets: [...nets, { name: "", frequency: "", callsign: "" }] });
  const removeNet = (i: number) =>
    setCommsPlan({ nets: nets.filter((_, idx) => idx !== i) });

  const paceFields: { label: string; value: string; set: (v: string) => void }[] = [
    { label: "Primary", value: pace.primary, set: (v) => setCommsPlan({ pace: { ...pace, primary: v } }) },
    { label: "Alternate", value: pace.alternate, set: (v) => setCommsPlan({ pace: { ...pace, alternate: v } }) },
    { label: "Contingency", value: pace.contingency, set: (v) => setCommsPlan({ pace: { ...pace, contingency: v } }) },
    { label: "Emergency", value: pace.emergency, set: (v) => setCommsPlan({ pace: { ...pace, emergency: v } }) },
  ];
  const medFields: { label: string; value: string; set: (v: string) => void }[] = [
    { label: "L1 Location", value: medevac.location ?? "", set: (v) => setCommsPlan({ medevac: { ...medevac, location: v } }) },
    { label: "L3 Precedence", value: medevac.precedence ?? "", set: (v) => setCommsPlan({ medevac: { ...medevac, precedence: v } }) },
    { label: "L4 Equipment", value: medevac.equipment ?? "", set: (v) => setCommsPlan({ medevac: { ...medevac, equipment: v } }) },
    { label: "L5 Patients", value: medevac.patientType ?? "", set: (v) => setCommsPlan({ medevac: { ...medevac, patientType: v } }) },
    { label: "L6 Security", value: medevac.security ?? "", set: (v) => setCommsPlan({ medevac: { ...medevac, security: v } }) },
    { label: "L7 Marking", value: medevac.marking ?? "", set: (v) => setCommsPlan({ medevac: { ...medevac, marking: v } }) },
    { label: "L8 Nationality", value: medevac.nationality ?? "", set: (v) => setCommsPlan({ medevac: { ...medevac, nationality: v } }) },
    { label: "L9 Terrain", value: medevac.terrain ?? "", set: (v) => setCommsPlan({ medevac: { ...medevac, terrain: v } }) },
  ];

  return (
    <div className="panel-section comms-checklist-panel">
      <div className="label">COMMS / SUPPORT PACK</div>
      <div className="support-doc-grid">
        {SUPPORT_DOCS.map((doc) => (
          <button
            key={doc.id}
            type="button"
            className={`support-doc-card${has(doc.id) ? " active" : ""}`}
            onClick={() => toggleSupportDoc(doc.id)}
          >
            <strong>{doc.label}</strong>
            <span>{doc.description}</span>
          </button>
        ))}
      </div>

      {has("comms") && (
        <div style={COMMS_BLOCK}>
          <div className="label">COMMS NETS</div>
          {nets.map((net, i) => (
            <div key={i} style={ROW}>
              <input className="input" placeholder="Net" value={net.name} onChange={(e) => updateNet(i, { name: e.target.value })} />
              <input className="input" placeholder="Freq" value={net.frequency} onChange={(e) => updateNet(i, { frequency: e.target.value })} />
              <input className="input" placeholder="Callsign" value={net.callsign} onChange={(e) => updateNet(i, { callsign: e.target.value })} />
              <button type="button" className="btn btn-danger" title="Remove net" onClick={() => removeNet(i)}>✕</button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost" onClick={addNet}>+ Add net</button>
        </div>
      )}

      {has("pace") && (
        <div style={COMMS_BLOCK}>
          <div className="label">PACE PLAN</div>
          {paceFields.map((f) => (
            <div key={f.label} style={ROW}>
              <label className="label" style={FIELD_LABEL}>{f.label}</label>
              <input className="input" value={f.value} onChange={(e) => f.set(e.target.value)} />
            </div>
          ))}
        </div>
      )}

      <div style={COMMS_BLOCK}>
        <label style={TOGGLE}>
          <input type="checkbox" checked={includePref} onChange={(e) => setIncludePref(e.target.checked)} />
          <span className="label" style={{ margin: 0 }}>ATAK config.pref — auto-sets on import</span>
        </label>
        {includePref && (
          <>
            <div style={ROW}>
              <label className="label" style={FIELD_LABEL}>Callsign</label>
              <input className="input" value={identity.callsign ?? ""} onChange={(e) => setCommsPlan({ identity: { ...identity, callsign: e.target.value } })} />
            </div>
            <div style={ROW}>
              <label className="label" style={FIELD_LABEL}>Team</label>
              <select className="select" value={identity.team ?? ""} onChange={(e) => setCommsPlan({ identity: { ...identity, team: e.target.value || undefined } })}>
                <option value="">—</option>
                {ATAK_TEAMS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div style={ROW}>
              <label className="label" style={FIELD_LABEL}>Role</label>
              <select className="select" value={identity.role ?? ""} onChange={(e) => setCommsPlan({ identity: { ...identity, role: e.target.value || undefined } })}>
                <option value="">—</option>
                {ATAK_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="label" style={{ marginTop: 4 }}>TAK SERVER (optional)</div>
            <div style={ROW}>
              <label className="label" style={FIELD_LABEL}>Host</label>
              <input className="input" placeholder="tak.example.com" value={identity.serverHost ?? ""} onChange={(e) => setCommsPlan({ identity: { ...identity, serverHost: e.target.value } })} />
            </div>
            <div style={ROW}>
              <input className="input" placeholder="Port (8089)" value={identity.serverPort ?? ""} onChange={(e) => setCommsPlan({ identity: { ...identity, serverPort: e.target.value } })} />
              <select className="select" value={identity.serverProto ?? "ssl"} onChange={(e) => setCommsPlan({ identity: { ...identity, serverProto: e.target.value === "tcp" ? "tcp" : "ssl" } })}>
                <option value="ssl">SSL</option>
                <option value="tcp">TCP</option>
              </select>
            </div>
          </>
        )}
      </div>

      {has("medevac") && (
        <div style={COMMS_BLOCK}>
          <div className="label">MEDEVAC 9-LINE</div>
          <div style={ROW}>
            <label className="label" style={FIELD_LABEL}>L2 Freq/CS</label>
            <input className="input" placeholder="Freq" value={medevac.freq ?? ""} onChange={(e) => setCommsPlan({ medevac: { ...medevac, freq: e.target.value } })} />
            <input className="input" placeholder="Callsign" value={medevac.callsign ?? ""} onChange={(e) => setCommsPlan({ medevac: { ...medevac, callsign: e.target.value } })} />
          </div>
          {medFields.map((f) => (
            <div key={f.label} style={ROW}>
              <label className="label" style={FIELD_LABEL}>{f.label}</label>
              <input className="input" value={f.value} onChange={(e) => f.set(e.target.value)} />
            </div>
          ))}
          <label style={TOGGLE}>
            <input type="checkbox" checked={includeCasevacMarker} onChange={(e) => setIncludeCasevacMarker(e.target.checked)} />
            <span className="label" style={{ margin: 0 }}>Add CASEVAC marker (opens 9-line in ATAK; verify on device)</span>
          </label>
        </div>
      )}

      <div style={COMMS_BLOCK}>
        <div className="label">SHARED NOTES</div>
        <textarea
          className="input"
          rows={3}
          value={commsPlan.notes ?? ""}
          onChange={(e) => setCommsPlan({ notes: e.target.value })}
          placeholder="Notes printed on the comms / PACE / MEDEVAC cards"
        />
      </div>

      <div className="panel-row" style={{ opacity: 0.72 }}>
        {supportDocIds.length} card{supportDocIds.length === 1 ? "" : "s"}
        {includePref ? " + config.pref" : ""}
        {includeCasevacMarker ? " + CASEVAC" : ""} on export.
      </div>
    </div>
  );
}

function FeatureRow({
  feature,
  selected,
  editing,
  onStartEdit,
  onEndEdit,
}: {
  feature: MapFeature;
  selected: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onEndEdit: () => void;
}) {
  const setSelectedFeatureId = useAppStore((s) => s.setSelectedFeatureId);
  const updateFeature = useAppStore((s) => s.updateFeature);
  const removeFeature = useAppStore((s) => s.removeFeature);

  const commitName = (value: string) => {
    const name = value.trim();
    if (name) updateFeature(feature.id, { name });
    onEndEdit();
  };

  return (
    <div
      className={`feature-row${selected ? " selected" : ""}`}
      onClick={() => setSelectedFeatureId(feature.id)}
      style={{ display: "flex", alignItems: "center", gap: 6 }}
    >
      <span
        className="feature-kind-glyph"
        title={feature.noteIcon ? `${feature.noteIcon} note icon` : feature.kind}
        aria-label={feature.noteIcon ? `${feature.noteIcon} note icon` : feature.kind}
      >
        {feature.noteIcon ? (
          <NoteIconGlyph iconId={feature.noteIcon} size={15} />
        ) : (
          KIND_GLYPHS[feature.kind]
        )}
      </span>
      {editing ? (
        <input
          className="input"
          autoFocus
          defaultValue={feature.name}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => commitName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitName(e.currentTarget.value);
            if (e.key === "Escape") onEndEdit();
          }}
          style={{ flex: 1, minWidth: 0 }}
        />
      ) : (
        <span
          style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onStartEdit();
          }}
          title={feature.name}
        >
          {feature.name}
        </span>
      )}
      <span
        title={feature.style.stroke}
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: feature.style.stroke,
          flexShrink: 0,
        }}
      />
      <button
        type="button"
        className="btn btn-ghost"
        title="Rename"
        onClick={(e) => {
          e.stopPropagation();
          onStartEdit();
        }}
      >
        ✎
      </button>
      <button
        type="button"
        className="btn btn-ghost"
        title="Zoom to feature"
        onClick={(e) => {
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent("takpack:zoom-to", { detail: { id: feature.id } }),
          );
        }}
      >
        ⌖
      </button>
      <button
        type="button"
        className="btn btn-danger"
        title="Delete feature"
        onClick={(e) => {
          e.stopPropagation();
          removeFeature(feature.id);
        }}
      >
        ✕
      </button>
    </div>
  );
}

function FeatureEditor({ feature }: { feature: MapFeature }) {
  const updateFeature = useAppStore((s) => s.updateFeature);

  const patchStyle = (patch: Partial<MapFeature["style"]>) =>
    updateFeature(feature.id, { style: { ...feature.style, ...patch } });

  const setAffiliation = (a: Affiliation) =>
    updateFeature(feature.id, {
      affiliation: a,
      ...(feature.sidc ? { sidc: applyAffiliation(feature.sidc, a) } : {}),
    });

  const isArea = AREA_KINDS.includes(feature.kind);
  const hasStroke = STROKE_KINDS.includes(feature.kind);
  const labelSize =
    feature.style.labelSize ??
    (feature.kind === "label" ? DEFAULT_TEXT_LABEL_SIZE : DEFAULT_FEATURE_LABEL_SIZE);
  const showLabelSize = feature.kind === "label" || feature.showLabel !== false;

  return (
    <div className="panel-section">
      <div className="label">SELECTED — {feature.kind.toUpperCase()}</div>

      <div className="panel-row">
        <label className="label" htmlFor="feat-name">
          NAME
        </label>
        <input
          id="feat-name"
          className="input"
          value={feature.name}
          onChange={(e) => updateFeature(feature.id, { name: e.target.value })}
        />
      </div>

      <div className="panel-row">
        <label className="label" htmlFor="feat-remarks">
          REMARKS
        </label>
        <textarea
          id="feat-remarks"
          className="input"
          rows={2}
          value={feature.remarks ?? ""}
          onChange={(e) =>
            updateFeature(feature.id, { remarks: e.target.value })
          }
        />
      </div>

      {feature.kind === "marker" && feature.noteIcon === undefined && (
        <div className="panel-row" style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span className="label">AFFILIATION</span>
          {AFFILIATIONS.map((a) => {
            const active = (feature.affiliation ?? "friendly") === a.id;
            return (
              <button
                key={a.id}
                type="button"
                className={`tool-btn${active ? " active" : ""}`}
                title={a.id}
                style={{
                  color: a.color,
                  ...(active ? { borderColor: a.color } : {}),
                }}
                onClick={() => setAffiliation(a.id)}
              >
                {a.label}
              </button>
            );
          })}
        </div>
      )}

      {feature.kind === "marker" && feature.noteIcon !== undefined && (
        <div className="panel-row" style={{ alignItems: "stretch", flexDirection: "column" }}>
          <span className="label">NOTE ICON</span>
          <div className="note-icon-grid">
            {NOTE_ICONS.map((iconDef) => (
              <button
                key={iconDef.id}
                type="button"
                className={`tool-btn${feature.noteIcon === iconDef.id ? " active" : ""}`}
                title={iconDef.label}
                onClick={() =>
                  updateFeature(feature.id, { noteIcon: iconDef.id as NoteIconType })
                }
              >
                <NoteIconGlyph iconId={iconDef.id} size={18} />
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="panel-row" style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <label className="label" htmlFor="feat-stroke">
          STROKE
        </label>
        <input
          id="feat-stroke"
          type="color"
          value={feature.style.stroke}
          onChange={(e) => patchStyle({ stroke: e.target.value })}
        />
        <label className="label" htmlFor="feat-width">
          WIDTH {feature.style.strokeWidth}
        </label>
        <input
          id="feat-width"
          type="range"
          min={1}
          max={8}
          step={1}
          value={feature.style.strokeWidth}
          onChange={(e) => patchStyle({ strokeWidth: Number(e.target.value) })}
          style={{ flex: 1 }}
        />
      </div>

      {hasStroke && (
        <div className="panel-row">
          <label className="label" htmlFor="feat-linestyle">
            LINE STYLE
          </label>
          <select
            id="feat-linestyle"
            className="select"
            value={feature.style.lineStyle ?? "solid"}
            onChange={(e) =>
              patchStyle({ lineStyle: e.target.value as LineStyle })
            }
          >
            {LINE_STYLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <label
        className="panel-row"
        style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
      >
        <input
          type="checkbox"
          checked={feature.showLabel !== false}
          onChange={(e) =>
            updateFeature(feature.id, { showLabel: e.target.checked })
          }
        />
        <span className="label" style={{ margin: 0 }}>
          {feature.kind === "label" ? "Show on map" : "Show name label"}
        </span>
      </label>

      {feature.kind === "line" &&
        feature.geometry.type === "LineString" &&
        feature.geometry.coordinates.length === 2 && (
          <label
            className="panel-row"
            style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
            title="Export as a native ATAK Range & Bearing arrow (live range + bearing readout)"
          >
            <input
              type="checkbox"
              checked={feature.rangeBearing === true}
              onChange={(e) =>
                updateFeature(feature.id, { rangeBearing: e.target.checked })
              }
            />
            <span className="label" style={{ margin: 0 }}>
              Range &amp; Bearing arrow
            </span>
          </label>
        )}

      {showLabelSize && (
        <div className="panel-row" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <label className="label" htmlFor="feat-label-size">
            LABEL SIZE {labelSize}px
          </label>
          <input
            id="feat-label-size"
            className="slider"
            type="range"
            min={8}
            max={32}
            step={1}
            value={labelSize}
            onChange={(e) => patchStyle({ labelSize: Number(e.target.value) })}
            style={{ flex: 1 }}
          />
        </div>
      )}

      {isArea && (
        <div className="panel-row" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <label className="label" htmlFor="feat-fill">
            FILL
          </label>
          <input
            id="feat-fill"
            type="color"
            value={feature.style.fill ?? feature.style.stroke}
            onChange={(e) => patchStyle({ fill: e.target.value })}
          />
          <label className="label" htmlFor="feat-fill-op">
            OPACITY {Math.round((feature.style.fillOpacity ?? 0.2) * 100)}%
          </label>
          <input
            id="feat-fill-op"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={feature.style.fillOpacity ?? 0.2}
            onChange={(e) => patchStyle({ fillOpacity: Number(e.target.value) })}
            style={{ flex: 1 }}
          />
        </div>
      )}

      <div
        className="panel-row"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}
      >
        <span className="label" style={{ margin: 0 }}>
          ATTACHMENTS (pinned to this marker in ATAK)
        </span>
        {(feature.attachments ?? []).map((a, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: "0.78rem",
              }}
            >
              {a.name}
            </span>
            <button
              type="button"
              className="btn btn-danger"
              title="Remove attachment"
              onClick={() =>
                updateFeature(feature.id, {
                  attachments: (feature.attachments ?? []).filter((_, idx) => idx !== i),
                })
              }
            >
              ✕
            </button>
          </div>
        ))}
        {(feature.attachments?.length ?? 0) < 4 && (
          <input
            type="file"
            className="input"
            accept="image/*,.pdf"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              if (file.size > 6_000_000) {
                alert("File too large (max ~6 MB).");
                return;
              }
              try {
                const att = await readFileBase64(file);
                updateFeature(feature.id, {
                  attachments: [...(feature.attachments ?? []), att],
                });
              } catch {
                alert("Could not read file.");
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

export default function FeaturePanel() {
  const features = useAppStore((s) => s.features);
  const addFeature = useAppStore((s) => s.addFeature);
  const clearFeatures = useAppStore((s) => s.clearFeatures);
  const selectedFeatureId = useAppStore((s) => s.selectedFeatureId);
  const tool = useAppStore((s) => s.tool);
  const activeSidc = useAppStore((s) => s.activeSidc);
  const setActiveSidc = useAppStore((s) => s.setActiveSidc);
  const activeAffiliation = useAppStore((s) => s.activeAffiliation);
  const activeNoteIcon = useAppStore((s) => s.activeNoteIcon);
  const setActiveNoteIcon = useAppStore((s) => s.setActiveNoteIcon);
  const setTool = useAppStore((s) => s.setTool);

  const [openCategories, setOpenCategories] = useState<Record<string, boolean>>(
    () => ({ [SYMBOL_CATEGORIES[0]?.name ?? ""]: true }),
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeToolbox, setActiveToolbox] = useState<ToolboxId | null>(null);

  const selected = features.find((f) => f.id === selectedFeatureId) ?? null;
  const activeToolboxDef =
    TOOLBOXES.find((toolbox) => toolbox.id === activeToolbox) ?? null;

  const pickSymbol = (sidc: string) => {
    setActiveSidc(applyAffiliation(sidc, activeAffiliation));
    setTool("marker");
  };

  const pickNoteIcon = (iconId: NoteIconType) => {
    setActiveNoteIcon(iconId);
    setTool("noteIcon");
  };

  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const imported = await featuresFromFieldFile(file, { sidc: activeSidc });
      imported.forEach(addFeature);
      alert(
        `Imported ${imported.length} feature${imported.length === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      alert(
        `Import failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      input.value = "";
    }
  };

  const renderToolboxContent = () => {
    switch (activeToolbox) {
      case "symbols":
        return (
          <div className="panel-section">
            <div className="label">SYMBOL PALETTE</div>
            {SYMBOL_CATEGORIES.map((catDef) => {
              const open = !!openCategories[catDef.name];
              return (
                <div key={catDef.name}>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ width: "100%", textAlign: "left" }}
                    onClick={() =>
                      setOpenCategories((prev) => ({
                        ...prev,
                        [catDef.name]: !open,
                      }))
                    }
                  >
                    {open ? "▾" : "▸"} {catDef.name}
                  </button>
                  {open && (
                    <div className="toolbox-symbol-grid">
                      {catDef.symbols.map((sym) => {
                        const display = applyAffiliation(
                          sym.sidc,
                          activeAffiliation,
                        );
                        const active = sameSymbol(sym.sidc, activeSidc);
                        return (
                          <button
                            key={sym.sidc}
                            type="button"
                            className={`tool-btn${active ? " active" : ""}`}
                            title={sym.name}
                            onClick={() => pickSymbol(sym.sidc)}
                          >
                            <img
                              src={getSymbolDataUrl(display, 36)}
                              alt={sym.name}
                              style={{ maxWidth: "100%" }}
                            />
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      case "notes":
        return (
          <div className="panel-section">
            <div className="label">NOTE ICONS</div>
            <div className="note-icon-grid">
              {NOTE_ICONS.map((iconDef) => {
                const active = tool === "noteIcon" && activeNoteIcon === iconDef.id;
                return (
                  <button
                    key={iconDef.id}
                    type="button"
                    className={`tool-btn${active ? " active" : ""}`}
                    title={`${iconDef.label} note`}
                    onClick={() => pickNoteIcon(iconDef.id)}
                  >
                    <NoteIconGlyph iconId={iconDef.id} size={18} />
                  </button>
                );
              })}
            </div>
          </div>
        );
      case "templates":
        return <TemplatePacksPanel />;
      case "coords":
        return <CoordinateToolsPanel />;
      case "batch":
        return <BatchCoordinateImport />;
      case "grg":
        return <GrgBuilder />;
      case "route":
        return <RouteCardPanel />;
      case "sector":
        return <SectorFanBuilder />;
      case "rings":
        return <RingBufferPanel />;
      case "comms":
        return <CommsChecklistPanel />;
      case "import":
        return (
          <div className="panel-section">
            <div className="label">IMPORT GEOJSON</div>
            <input
              className="input"
              type="file"
              accept=".json,.geojson,.gpx,.kml,.kmz,.csv,.txt,application/geo+json,application/json"
              onChange={(e) => void onImportFile(e)}
            />
          </div>
        );
      case "manage":
        return (
          <div className="panel-section">
            <div className="label">MANAGE FEATURES</div>
            <div className="panel-row" style={{ opacity: 0.72 }}>
              {features.length} feature{features.length === 1 ? "" : "s"} on map.
            </div>
            <button
              type="button"
              className="btn btn-danger"
              disabled={features.length === 0}
              onClick={() => {
                if (confirm(`Delete all ${features.length} features?`)) {
                  clearFeatures();
                }
              }}
            >
              CLEAR ALL
            </button>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="panel annotate-panel">
      <div className="panel-header">FEATURES</div>

      <div className="toolbox-shell">
        <div className="toolbox-toolbar" role="toolbar" aria-label="Annotation tools">
          {TOOLBOXES.map((toolbox) => (
            <button
              key={toolbox.id}
              type="button"
              className={`toolbox-tab${activeToolbox === toolbox.id ? " active" : ""}`}
              title={toolbox.label}
              onClick={() =>
                setActiveToolbox((current) =>
                  current === toolbox.id ? null : toolbox.id,
                )
              }
            >
              {toolbox.short}
            </button>
          ))}
        </div>
        {activeToolbox && activeToolboxDef && (
          <div className="toolbox-popover">
            <div className="toolbox-popover-header">
              <span>{activeToolboxDef.label}</span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setActiveToolbox(null)}
              >
                Close
              </button>
            </div>
            {renderToolboxContent()}
          </div>
        )}
      </div>

      <div className="panel-section">
        <div className="label">FEATURES ({features.length})</div>
        {features.length === 0 && (
          <div className="panel-row" style={{ opacity: 0.6 }}>
            Pick a tool and click the map to add features.
          </div>
        )}
        {features.map((f) => (
          <FeatureRow
            key={f.id}
            feature={f}
            selected={f.id === selectedFeatureId}
            editing={editingId === f.id}
            onStartEdit={() => setEditingId(f.id)}
            onEndEdit={() => setEditingId(null)}
          />
        ))}
      </div>

      {selected && <FeatureEditor feature={selected} />}
    </div>
  );
}
