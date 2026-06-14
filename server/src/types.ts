/**
 * Shared domain contracts for TAKPack Studio.
 * This file is the law — module implementations conform to these signatures.
 * See DESIGN.md for the ATAK format requirements behind them.
 */

// ───────────────────────────── Geo primitives ─────────────────────────────

/** Geographic bounding box in WGS84 degrees. */
export interface Aoi {
  north: number;
  south: number;
  east: number;
  west: number;
}

/** [lon, lat] like GeoJSON. */
export type Position = [number, number];

export interface PointGeometry {
  type: "Point";
  coordinates: Position;
}
export interface LineStringGeometry {
  type: "LineString";
  coordinates: Position[];
}
export interface PolygonGeometry {
  type: "Polygon";
  /** First ring = exterior; subsequent rings = holes. */
  coordinates: Position[][];
}
export type Geometry = PointGeometry | LineStringGeometry | PolygonGeometry;

// ───────────────────────────── Features ─────────────────────────────

export type Affiliation = "friendly" | "hostile" | "neutral" | "unknown";

export type NoteIconType =
  | "pin"
  | "flag"
  | "star"
  | "alert"
  | "info"
  | "camera"
  | "vehicle"
  | "medical";

/**
 * marker    — Point, milsymbol SIDC, exports as CoT a-* event
 * label     — Point, text-only label, exports as CoT b-m-p-s-m + KML label
 * line      — LineString, exports as CoT u-d-f OPEN polyline + KML
 * route     — LineString, exports as CoT b-m-r route
 * polygon   — Polygon, exports as CoT u-d-f CLOSED + KML
 * rectangle — Polygon (4 corners), exports as CoT u-d-r + KML
 * circle    — Point center + radiusM, exports as CoT u-d-c + tessellated KML
 */
export type FeatureKind =
  | "marker"
  | "label"
  | "line"
  | "route"
  | "polygon"
  | "rectangle"
  | "circle";

/** Stroke pattern. ATAK CoT supports these exact values via <strokeStyle>. */
export type LineStyle = "solid" | "dashed" | "dotted" | "outlined";

export interface FeatureStyle {
  /** '#rrggbb' */
  stroke: string;
  /** 0..1 */
  strokeOpacity: number;
  /** pixels / CoT strokeWeight */
  strokeWidth: number;
  /** Stroke pattern (default 'solid'). Lines/routes/shapes only. */
  lineStyle?: LineStyle;
  /** '#rrggbb' — polygons/rectangles/circles */
  fill?: string;
  /** 0..1 */
  fillOpacity?: number;
  /** Pixel size for rendered labels. */
  labelSize?: number;
}

export interface MapFeature {
  /** UUID v4 — becomes the CoT event uid. */
  id: string;
  kind: FeatureKind;
  /** Display name / callsign / label text. */
  name: string;
  /** MIL-STD-2525C 15-char SIDC (markers only). */
  sidc?: string;
  affiliation?: Affiliation;
  noteIcon?: NoteIconType;
  geometry: Geometry;
  /** Circle radius in meters (kind === 'circle' only). */
  radiusM?: number;
  style: FeatureStyle;
  remarks?: string;
  /** Show the feature's name as an on-map label (default true). */
  showLabel?: boolean;
  /** Export a 2-point line as a native ATAK Range & Bearing arrow (u-rb-a). */
  rangeBearing?: boolean;
  /** Files attached to THIS feature's marker (photos/PDFs) — ATAK shows them
   *  in the marker's attachments. */
  attachments?: PackageAttachment[];
}

// ───────────────────────────── Imagery catalog ─────────────────────────────

export type SourceCategory = "free" | "api";

/**
 * xyz           — direct {z}/{x}/{y} tile fetch (incl. ArcGIS /tile/{z}/{y}/{x})
 * arcgis-export — ArcGIS ImageServer/MapServer exportImage: fetch large blocks, slice to tiles
 * stac-sentinel2— Planetary Computer STAC search + titiler crop, slice to tiles
 * sentinel-hub  — Sentinel Hub Processing API (OAuth client credentials)
 * planet        — Planet basemap tiles via authenticated proxy
 */
export type FetchStrategy =
  | "xyz"
  | "arcgis-export"
  | "stac-sentinel2"
  | "sentinel-hub"
  | "planet";

export interface ImagerySourceDef {
  id: string;
  name: string;
  description: string;
  category: SourceCategory;
  /** localStorage key suffix shared by sources using the same credential. */
  keyId?: string;
  keyLabel?: string;
  keyPlaceholder?: string;
  attribution: string;
  /** Human-readable license/ToS note shown in UI and baked into packages. */
  license: string;
  /** true ⇒ offline packaging FORBIDDEN (server-enforced); streaming XML allowed. */
  streamOnly: boolean;
  /** true ⇒ offline allowed only after user confirms their plan permits it. */
  offlineRequiresPlanCheck?: boolean;
  strategy: FetchStrategy;
  /** {z}/{x}/{y} (+ optional {key}) — required for strategy 'xyz'. */
  tileUrlTemplate?: string;
  /** ArcGIS service base URL — required for strategy 'arcgis-export'. */
  exportUrlBase?: string;
  usOnly?: boolean;
  minZoom: number;
  maxZoom: number;
  /** jpeg default; png for maps needing transparency. */
  defaultTileFormat: "jpeg" | "png";
}

export interface Limits {
  maxTilesPerExport: number;
  recommendedMaxPackageBytes: number;
  maxGrgPixels: number;
}

export interface AppConfig {
  sources: ImagerySourceDef[];
  limits: Limits;
}

// ───────────────────────────── Export request ─────────────────────────────

export type ImageryExportMode = "gpkg" | "kmz-grg";

export interface ImageryExportSpec {
  sourceId: string;
  mode: ImageryExportMode;
  minZoom: number;
  maxZoom: number;
  tileFormat: "jpeg" | "png";
  /** Session-scoped; redacted from logs and job records; never persisted. */
  apiKey?: string;
  /** User confirmed their plan permits offline use (offlineRequiresPlanCheck sources). */
  planConfirmed?: boolean;
}

export interface PackageAttachment {
  name: string;
  contentType?: string;
  base64: string;
}

/** Generated reference cards that can be bundled in the package. */
export type SupportDocId = "comms" | "pace" | "medevac" | "checklist";

export interface CommsNet {
  name: string;
  frequency: string;
  callsign: string;
  notes?: string;
}

export interface PacePlan {
  primary: string;
  alternate: string;
  contingency: string;
  emergency: string;
}

/** Identity/server settings emitted as an ATAK config.pref (applied on import). */
export interface CommsIdentity {
  callsign?: string;
  /** ATAK team color, e.g. "Cyan", "Dark Blue". */
  team?: string;
  /** ATAK role, e.g. "Team Lead", "Medic". */
  role?: string;
  serverHost?: string;
  serverPort?: string;
  serverProto?: "ssl" | "tcp";
  serverName?: string;
}

/** MEDEVAC 9-line — card text and (optionally) a CASEVAC CoT marker. */
export interface Medevac9Line {
  location?: string; // line 1
  freq?: string; // line 2
  callsign?: string; // line 2
  precedence?: string; // line 3
  equipment?: string; // line 4
  patientType?: string; // line 5
  security?: string; // line 6
  marking?: string; // line 7
  nationality?: string; // line 8
  terrain?: string; // line 9
  /** Marker position for the CASEVAC CoT (defaults to AOI center if absent). */
  lat?: number;
  lon?: number;
}

export interface CommsPlan {
  nets?: CommsNet[];
  pace?: PacePlan;
  identity?: CommsIdentity;
  medevac?: Medevac9Line;
  notes?: string;
}

export interface ExportRequest {
  packageName: string;
  aoi: Aoi;
  features: MapFeature[];
  imagery?: ImageryExportSpec;
  /** Source ids to emit as streaming customMapSource XML files in the package. */
  mapSourceXmlIds: string[];
  /** Embed user API keys in emitted map-source XML (explicit opt-in). */
  includeKeyInXml?: boolean;
  /** Also write a styled KML overlay of all features (default true). */
  includeKmlOverlay?: boolean;
  /** User-selected supporting docs/images included in the data package. */
  attachments?: PackageAttachment[];
  /** Generate an HTML package summary as an attachment. */
  includeMissionBrief?: boolean;
  /** Structured comms/PACE/identity/MEDEVAC data for generated cards + .pref. */
  commsPlan?: CommsPlan;
  /** Which reference cards to generate from commsPlan. */
  supportDocIds?: SupportDocId[];
  /** Emit an ATAK config.pref from commsPlan.identity (callsign/team/role/server). */
  includePref?: boolean;
  /** Emit a CASEVAC 9-line CoT marker from commsPlan.medevac. */
  includeCasevacMarker?: boolean;
  /** Bundle DTED elevation for the AOI (USGS 3DEP, US-only; needs GDAL). */
  includeElevation?: boolean;
  /** DTED level: 1 (~90m, ~2.9MB/cell) or 2 (~30m, ~26MB/cell). Default 1. */
  elevationLevel?: 1 | 2;
}

// ───────────────────────────── Jobs ─────────────────────────────

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface JobProgress {
  phase: string;
  /** 0..100 */
  percent: number;
  message?: string;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  progress: JobProgress;
  warnings: string[];
  error?: string;
  /** Absolute path of the built zip — stripped from API responses. */
  artifactPath?: string;
  /** Download filename, e.g. "op-anvil.zip". */
  artifactName?: string;
  sizeBytes?: number;
  createdAt: string;
  updatedAt: string;
}

// ───────────────────────────── Adapters ─────────────────────────────

export interface FetchPyramidOptions {
  apiKey?: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface PyramidTile {
  z: number;
  x: number;
  y: number;
  data: Buffer;
}

export interface PyramidResult {
  tiles: PyramidTile[];
  fetched: number;
  failed: number;
  total: number;
  warnings: string[];
}

export interface SingleImageResult {
  data: Buffer;
  width: number;
  height: number;
  /** Actual geographic bounds of the returned image (may exceed requested AOI). */
  bounds: Aoi;
  /** Non-fatal fetch problems (e.g. failed tiles left as black gaps). */
  warnings?: string[];
}

export interface ImageryAdapter {
  /**
   * Fetch a full XYZ (EPSG:3857, 256px, top-origin) tile pyramid covering `aoi`
   * for every zoom in [minZoom..maxZoom]. Failed tiles are counted and warned —
   * never silently replaced with black. Tiles are re-encoded to `format`
   * only when the source format differs.
   */
  fetchPyramid(
    source: ImagerySourceDef,
    aoi: Aoi,
    minZoom: number,
    maxZoom: number,
    format: "jpeg" | "png",
    opts: FetchPyramidOptions,
  ): Promise<PyramidResult>;

  /**
   * Fetch one rectified image covering the AOI (≤ maxPx on the long side) for
   * KMZ-GRG export and AOI previews. Optional — xyz strategy synthesizes it by
   * stitching one zoom level.
   */
  fetchSingleImage?(
    source: ImagerySourceDef,
    aoi: Aoi,
    maxPx: number,
    opts: FetchPyramidOptions,
  ): Promise<SingleImageResult | null>;
}

// ───────────────────────────── Export writers ─────────────────────────────

export interface GpkgWriteOptions {
  filePath: string;
  /** SQL-identifier-safe; also used as gpkg_contents.table_name/identifier. */
  tableName: string;
  aoi: Aoi;
  minZoom: number;
  maxZoom: number;
  tiles: Iterable<PyramidTile>;
  tileFormat: "jpeg" | "png";
}

export interface ManifestEntry {
  zipEntry: string;
  name: string;
  contentType?: string;
  visible?: boolean;
  uid?: string;
  isCot?: boolean;
}

export interface CotFile {
  uid: string;
  /** Complete XML document text. */
  xml: string;
}

/** Deterministic injection points so writers can be golden-file tested. */
export interface WriterDeterminism {
  now?: () => Date;
  uuid?: () => string;
}

// ───────────────────────────── Package builder ─────────────────────────────

export interface BuildPackageInput {
  request: ExportRequest;
  jobId: string;
  /** Directory for the output zip and any temp files (created if missing). */
  outDir: string;
  catalog: ImagerySourceDef[];
  adapters: Partial<Record<FetchStrategy, ImageryAdapter>>;
  limits: Limits;
  onProgress: (p: JobProgress) => void;
  determinism?: WriterDeterminism;
  signal?: AbortSignal;
}

export interface BuildPackageOutput {
  zipPath: string;
  sizeBytes: number;
  warnings: string[];
  /** Every entry path written into the zip (forward slashes). */
  entries: string[];
}
