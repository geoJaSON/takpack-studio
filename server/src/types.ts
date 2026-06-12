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

/**
 * marker    — Point, milsymbol SIDC, exports as CoT a-* event
 * line      — LineString graphic, exports to KML only
 * route     — LineString, exports as CoT b-m-r route
 * polygon   — Polygon, exports as CoT u-d-f + KML
 * rectangle — Polygon (4 corners), exports as CoT u-d-r + KML
 * circle    — Point center + radiusM, exports as CoT u-d-c + tessellated KML
 */
export type FeatureKind =
  | "marker"
  | "line"
  | "route"
  | "polygon"
  | "rectangle"
  | "circle";

export interface FeatureStyle {
  /** '#rrggbb' */
  stroke: string;
  /** 0..1 */
  strokeOpacity: number;
  /** pixels / CoT strokeWeight */
  strokeWidth: number;
  /** '#rrggbb' — polygons/rectangles/circles */
  fill?: string;
  /** 0..1 */
  fillOpacity?: number;
}

export interface MapFeature {
  /** UUID v4 — becomes the CoT event uid. */
  id: string;
  kind: FeatureKind;
  /** Display name / callsign. */
  name: string;
  /** MIL-STD-2525C 15-char SIDC (markers only). */
  sidc?: string;
  affiliation?: Affiliation;
  geometry: Geometry;
  /** Circle radius in meters (kind === 'circle' only). */
  radiusM?: number;
  style: FeatureStyle;
  remarks?: string;
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
